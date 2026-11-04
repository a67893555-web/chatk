import { randomUUID } from 'node:crypto';
import {
  Channel,
  ChannelMember,
  ChannelType,
  ChatMessage,
  CircuitState,
  DeviceSessionRecord,
  MediaAttachmentMeta,
  MemberRole,
  MessageLifecycleState,
  PushNotificationAlert,
  UserProfile,
  WsServerFrame,
} from '../shared/types';
import {
  CircuitBreaker,
  IdempotencyStore,
  PresenceRegistry as PresenceRegistryImpl,
  SnowflakeGenerator,
  chunkFanoutRecipients,
  compareSnowflakeIds,
} from '../shared/distributedCore';
import { redisBridge } from './redisAdapter';

export interface StoredMediaObject {
  objectKey: string;
  mimeType: string;
  fileName: string;
  data: Buffer;
  thumbnailSvg: string;
  uploadedBy: string;
  createdAt: string;
}

type GatewayPubSubHandler = (targetUserIds: string[], frame: WsServerFrame) => void;

export class DistributedStorageCluster {
  // Primary Relational Store (PostgreSQL model)
  public readonly users = new Map<string, UserProfile>();
  public readonly channels = new Map<string, Channel>();
  public readonly channelMembers = new Map<string, ChannelMember[]>(); // channelId -> members
  public readonly deviceSessions = new Map<string, DeviceSessionRecord>(); // `${userId}:${deviceId}`

  // Wide-Column Message Persistence Store (ScyllaDB / Cassandra model)
  // Partitioned by channel_id, clustered by message_id DESC
  private readonly scyllaPartitions = new Map<string, ChatMessage[]>();
  private readonly channelSeqCounters = new Map<string, number>();

  // Redis Cluster Services
  public readonly idempotencyStore = new IdempotencyStore<ChatMessage>(24 * 60 * 60 * 1000);
  public readonly presenceRegistry = new PresenceRegistryImpl(60_000);
  private readonly gatewaySubscribers = new Map<string, GatewayPubSubHandler>();
  // Redis Stream transient un-acknowledged message buffer: userId -> Map<messageId, ChatMessage>
  private readonly unackedStreams = new Map<string, Map<string, ChatMessage>>();

  // Object Storage (S3 / MinIO presigned HTTP PUT bucket)
  private readonly mediaBucket = new Map<string, StoredMediaObject>();

  // Push Notification Worker Outbox (FCM / APNs)
  private readonly pushAlerts: PushNotificationAlert[] = [];

  // Distributed Snowflake & Circuit Breaker
  public readonly snowflake = new SnowflakeGenerator(1, 1);
  public readonly storageBreaker = new CircuitBreaker(5, 10_000);

  constructor() {
    this.seedInitialClusterData();
  }

  public subscribeGatewayChannel(gatewayServerId: string, handler: GatewayPubSubHandler): () => void {
    this.gatewaySubscribers.set(gatewayServerId, handler);
    void redisBridge.registerGatewayHandler(gatewayServerId, handler);
    return () => {
      this.gatewaySubscribers.delete(gatewayServerId);
    };
  }

  public publishToGateway(gatewayServerId: string, targetUserIds: string[], frame: WsServerFrame): void {
    // Route via Render Redis Pub/Sub when REDIS_URL is connected; otherwise deliver via local subscriber map
    const publishedViaRedis = redisBridge.publishGatewayEnvelope(
      gatewayServerId,
      targetUserIds,
      frame
    );
    if (!publishedViaRedis) {
      const handler = this.gatewaySubscribers.get(gatewayServerId);
      if (handler) {
        handler(targetUserIds, frame);
      }
    }
  }

  public broadcastToUsers(userIds: readonly string[], frame: WsServerFrame): void {
    const byGateway = new Map<string, string[]>();
    for (const uid of userIds) {
      const gateways = this.presenceRegistry.getGatewaysForUser(uid);
      for (const gw of gateways) {
        let list = byGateway.get(gw);
        if (!list) {
          list = [];
          byGateway.set(gw, list);
        }
        list.push(uid);
      }
    }
    for (const [gwId, targets] of byGateway.entries()) {
      this.publishToGateway(gwId, targets, frame);
    }
  }

  /**
   * Core Idempotent Message Pipeline:
   * 1. Validate channel membership
   * 2. Check Redis 24h idempotency:<client_msg_id>
   * 3. Assign monotonic 64-bit Snowflake ID & per-channel sequence
   * 4. Persist to ScyllaDB partition (guarded by Circuit Breaker)
   * 5. Execute chunked worker-pool fan-out to recipient gateways OR Redis Stream + Push Worker
   */
  public async processIncomingMessage(params: {
    senderId: string;
    channelId: string;
    clientMsgId: string;
    content: string;
    mediaUrl?: string | null;
    thumbnailUrl?: string | null;
    mediaMeta?: MediaAttachmentMeta | null;
  }): Promise<{ message: ChatMessage; deduplicated: boolean }> {
    const channel = this.channels.get(params.channelId);
    if (!channel) {
      throw new Error('VALIDATION_ERROR: Target channel does not exist');
    }
    if (!channel.memberIds.includes(params.senderId)) {
      throw new Error('FORBIDDEN: Sender is not a member of this channel');
    }

    const trimmedContent = params.content.trim();
    if (!trimmedContent && !params.mediaUrl) {
      throw new Error('VALIDATION_ERROR: Message must contain text or a presigned media URL');
    }
    if (trimmedContent.length > 4000) {
      throw new Error('VALIDATION_ERROR: Message exceeds 4000 character frame limit');
    }
    if (!params.clientMsgId || params.clientMsgId.length > 128) {
      throw new Error('VALIDATION_ERROR: Valid client_msg_id is required for idempotency');
    }

    // Step 1: Check 24h Redis idempotency cache
    const cached = this.idempotencyStore.get(params.clientMsgId);
    if (cached) {
      return { message: cached, deduplicated: true };
    }

    // Step 2: Assign monotonic Snowflake ID + per-channel sequence
    const messageId = this.snowflake.nextId();
    const nextSeq = (this.channelSeqCounters.get(params.channelId) ?? 0) + 1;
    this.channelSeqCounters.set(params.channelId, nextSeq);

    const nowIso = new Date().toISOString();
    const message: ChatMessage = {
      channelId: params.channelId,
      messageId,
      channelSeq: nextSeq,
      senderId: params.senderId,
      clientMsgId: params.clientMsgId,
      content: trimmedContent,
      mediaUrl: params.mediaUrl ?? null,
      thumbnailUrl: params.thumbnailUrl ?? null,
      mediaMeta: params.mediaMeta ?? null,
      createdAt: nowIso,
      updatedAt: null,
      isEdited: false,
      isDeleted: false,
      lifecycleState: MessageLifecycleState.SENT,
      deliveredTo: [],
      readBy: [params.senderId],
    };

    // Step 3: Persist to ScyllaDB wide-column partition (clustered DESC by message_id)
    await this.storageBreaker.execute(() => {
      let partition = this.scyllaPartitions.get(params.channelId);
      if (!partition) {
        partition = [];
        this.scyllaPartitions.set(params.channelId, partition);
      }
      // Prepend to maintain CLUSTERING ORDER BY (message_id DESC)
      partition.unshift(message);
    });

    // Step 4: Store in 24h Redis idempotency cache
    this.idempotencyStore.setNx(params.clientMsgId, message);

    // Step 5: Scalable worker-pool fan-out (chunks of 500 for up to 100,000 members)
    const recipients = channel.memberIds.filter((uid) => uid !== params.senderId);
    const batches = chunkFanoutRecipients(recipients, 500);

    for (const batch of batches) {
      const gatewayRouting = new Map<string, string[]>();

      for (const recipientId of batch) {
        const activeGateways = this.presenceRegistry.getGatewaysForUser(recipientId);
        if (activeGateways.length > 0) {
          for (const gwId of activeGateways) {
            let targets = gatewayRouting.get(gwId);
            if (!targets) {
              targets = [];
              gatewayRouting.set(gwId, targets);
            }
            targets.push(recipientId);
          }
          // Hold in transient Redis Stream until recipient socket sends `message:ack_delivered`
          this.appendUnackedStream(recipientId, message);
        } else {
          // Offline recipient: buffer in Redis Stream + dispatch FCM/APNs Push Notification
          this.appendUnackedStream(recipientId, message);
          this.enqueuePushNotification(recipientId, channel, message);
        }
      }

      for (const [gwId, targets] of gatewayRouting.entries()) {
        this.publishToGateway(gwId, targets, {
          type: 'message:new',
          message,
          routedViaGateway: gwId,
        });
      }
    }

    // Also fan out to other multi-device sockets belonging to the sender!
    const senderGateways = this.presenceRegistry.getGatewaysForUser(params.senderId);
    for (const gwId of senderGateways) {
      this.publishToGateway(gwId, [params.senderId], {
        type: 'message:new',
        message,
        routedViaGateway: gwId,
      });
    }

    return { message, deduplicated: false };
  }

  public editMessage(params: {
    userId: string;
    channelId: string;
    messageId: string;
    content: string;
  }): ChatMessage {
    const partition = this.scyllaPartitions.get(params.channelId) ?? [];
    const target = partition.find((m) => m.messageId === params.messageId);
    if (!target) {
      throw new Error('VALIDATION_ERROR: Message not found');
    }
    if (target.senderId !== params.userId) {
      throw new Error('FORBIDDEN: Only the original author can edit this message');
    }
    if (target.isDeleted) {
      throw new Error('VALIDATION_ERROR: Deleted messages cannot be edited');
    }
    const trimmed = params.content.trim();
    if (!trimmed) {
      throw new Error('VALIDATION_ERROR: Edited content cannot be empty');
    }

    target.content = trimmed;
    target.isEdited = true;
    target.updatedAt = new Date().toISOString();

    const channel = this.channels.get(params.channelId);
    if (channel) {
      this.broadcastToUsers(channel.memberIds, {
        type: 'message:updated',
        message: { ...target },
      });
    }
    return { ...target };
  }

  public deleteMessage(params: {
    userId: string;
    channelId: string;
    messageId: string;
  }): ChatMessage {
    const partition = this.scyllaPartitions.get(params.channelId) ?? [];
    const target = partition.find((m) => m.messageId === params.messageId);
    if (!target) {
      throw new Error('VALIDATION_ERROR: Message not found');
    }
    if (target.senderId !== params.userId) {
      throw new Error('FORBIDDEN: Only the original author can delete this message');
    }

    target.content = '';
    target.mediaUrl = null;
    target.thumbnailUrl = null;
    target.mediaMeta = null;
    target.isDeleted = true;
    target.updatedAt = new Date().toISOString();

    const channel = this.channels.get(params.channelId);
    if (channel) {
      this.broadcastToUsers(channel.memberIds, {
        type: 'message:updated',
        message: { ...target },
      });
    }
    return { ...target };
  }

  public acknowledgeDelivery(params: {
    recipientId: string;
    channelId: string;
    messageId: string;
  }): ChatMessage | null {
    // XACK from transient Redis Stream buffer
    const userStream = this.unackedStreams.get(params.recipientId);
    if (userStream) {
      userStream.delete(params.messageId);
    }

    const partition = this.scyllaPartitions.get(params.channelId) ?? [];
    const target = partition.find((m) => m.messageId === params.messageId);
    if (!target || target.senderId === params.recipientId) return null;

    if (!target.deliveredTo.includes(params.recipientId)) {
      target.deliveredTo.push(params.recipientId);
    }
    if (target.lifecycleState === MessageLifecycleState.SENT) {
      target.lifecycleState = MessageLifecycleState.DELIVERED;
    }

    const channel = this.channels.get(params.channelId);
    if (channel) {
      this.broadcastToUsers(channel.memberIds, {
        type: 'message:receipt',
        channelId: target.channelId,
        messageId: target.messageId,
        lifecycleState: target.lifecycleState,
        deliveredTo: [...target.deliveredTo],
        readBy: [...target.readBy],
      });
    }
    return { ...target };
  }

  public markChannelRead(params: {
    readerId: string;
    channelId: string;
    upToMessageId: string;
  }): ChatMessage[] {
    const partition = this.scyllaPartitions.get(params.channelId) ?? [];
    const updated: ChatMessage[] = [];
    const channel = this.channels.get(params.channelId);

    for (const msg of partition) {
      if (compareSnowflakeIds(msg.messageId, params.upToMessageId) <= 0) {
        if (msg.senderId !== params.readerId && !msg.readBy.includes(params.readerId)) {
          msg.readBy.push(params.readerId);
          if (!msg.deliveredTo.includes(params.readerId)) {
            msg.deliveredTo.push(params.readerId);
          }
          msg.lifecycleState = MessageLifecycleState.READ;
          updated.push({ ...msg });

          if (channel) {
            this.broadcastToUsers(channel.memberIds, {
              type: 'message:receipt',
              channelId: msg.channelId,
              messageId: msg.messageId,
              lifecycleState: msg.lifecycleState,
              deliveredTo: [...msg.deliveredTo],
              readBy: [...msg.readBy],
            });
          }
        }
      }
    }

    const userStream = this.unackedStreams.get(params.readerId);
    if (userStream) {
      for (const msg of updated) {
        userStream.delete(msg.messageId);
      }
    }

    return updated;
  }

  /**
   * Multi-Device Reconnection Synchronization:
   * GET /api/v1/sync?cursor=<cur_max_message_id>&deviceId=<id>
   * Scans user's subscribed channels + transient Redis stream for any mutations or messages > cursor.
   */
  public syncMessagesAfterCursor(params: {
    userId: string;
    deviceId: string;
    cursor: string;
  }): { messages: ChatMessage[]; newMaxMessageId: string; flushedStreamCount: number } {
    const cleanCursor = params.cursor || '0';
    const userChannels = Array.from(this.channels.values()).filter((ch) =>
      ch.memberIds.includes(params.userId)
    );

    const deltaMap = new Map<string, ChatMessage>();
    let maxId = cleanCursor;

    for (const ch of userChannels) {
      const partition = this.scyllaPartitions.get(ch.id) ?? [];
      for (const msg of partition) {
        const isNewer = compareSnowflakeIds(msg.messageId, cleanCursor) > 0;
        // Include messages newer than cursor OR edited/deleted recently
        if (isNewer || msg.isEdited || msg.isDeleted) {
          deltaMap.set(msg.messageId, { ...msg });
          if (compareSnowflakeIds(msg.messageId, maxId) > 0) {
            maxId = msg.messageId;
          }
        }
      }
    }

    // Drain transient Redis Stream buffer for this user
    let flushedStreamCount = 0;
    const stream = this.unackedStreams.get(params.userId);
    if (stream) {
      flushedStreamCount = stream.size;
      for (const [mid, msg] of stream.entries()) {
        if (!deltaMap.has(mid)) {
          deltaMap.set(mid, { ...msg });
        }
        if (compareSnowflakeIds(mid, maxId) > 0) {
          maxId = mid;
        }
      }
      stream.clear();
    }

    this.upsertDeviceSession(params.userId, params.deviceId, maxId, null);

    const messages = Array.from(deltaMap.values()).sort((a, b) =>
      compareSnowflakeIds(a.messageId, b.messageId)
    );

    return {
      messages,
      newMaxMessageId: maxId,
      flushedStreamCount,
    };
  }

  public getChannelMessages(channelId: string, beforeCursor?: string, limit = 50): ChatMessage[] {
    const partition = this.scyllaPartitions.get(channelId) ?? [];
    const filtered = beforeCursor
      ? partition.filter((m) => compareSnowflakeIds(m.messageId, beforeCursor) < 0)
      : partition;

    // Partition is clustered DESC in ScyllaDB; reverse slice for chronological UI display
    return filtered
      .slice(0, limit)
      .map((m) => ({ ...m }))
      .reverse();
  }

  public getGlobalMaxMessageIdForUser(userId: string): string {
    let maxId = '0';
    for (const ch of this.channels.values()) {
      if (!ch.memberIds.includes(userId)) continue;
      const partition = this.scyllaPartitions.get(ch.id);
      if (partition && partition.length > 0) {
        // First item is highest messageId due to DESC clustering
        if (compareSnowflakeIds(partition[0].messageId, maxId) > 0) {
          maxId = partition[0].messageId;
        }
      }
    }
    return maxId;
  }

  public upsertDeviceSession(
    userId: string,
    deviceId: string,
    curMaxMessageId?: string,
    gatewayServerId?: string | null
  ): DeviceSessionRecord {
    const key = `${userId}:${deviceId}`;
    const existing = this.deviceSessions.get(key);
    const nextCursor =
      curMaxMessageId && compareSnowflakeIds(curMaxMessageId, existing?.curMaxMessageId ?? '0') >= 0
        ? curMaxMessageId
        : existing?.curMaxMessageId ?? this.getGlobalMaxMessageIdForUser(userId);

    const updated: DeviceSessionRecord = {
      deviceId,
      userId,
      curMaxMessageId: nextCursor,
      lastSyncedAt: new Date().toISOString(),
      gatewayServerId:
        gatewayServerId !== undefined ? gatewayServerId : existing?.gatewayServerId ?? null,
    };
    this.deviceSessions.set(key, updated);
    return updated;
  }

  public createChannel(params: {
    creatorId: string;
    name: string;
    description: string;
    type: ChannelType;
    memberIds: string[];
    simulatedLargeGroupCount?: number;
  }): Channel {
    const trimmedName = params.name.trim();
    if (!trimmedName || trimmedName.length < 2 || trimmedName.length > 64) {
      throw new Error('VALIDATION_ERROR: Channel name must be between 2 and 64 characters');
    }

    const uniqueMembers = Array.from(new Set([params.creatorId, ...params.memberIds]));
    const id = `ch-${randomUUID().slice(0, 8)}`;
    const nowIso = new Date().toISOString();
    const memberCount =
      params.type === ChannelType.GROUP && params.simulatedLargeGroupCount
        ? Math.max(uniqueMembers.length, Math.min(100_000, params.simulatedLargeGroupCount))
        : uniqueMembers.length;

    const channel: Channel = {
      id,
      type: params.type,
      name: trimmedName,
      description: params.description.trim() || 'Real-time synchronized channel',
      memberCount,
      fanoutTier: memberCount > 1000 ? 'large-group-worker-pool' : 'standard',
      createdBy: params.creatorId,
      createdAt: nowIso,
      memberIds: uniqueMembers,
    };

    this.channels.set(id, channel);
    this.scyllaPartitions.set(id, []);
    this.channelMembers.set(
      id,
      uniqueMembers.map((uid) => ({
        channelId: id,
        userId: uid,
        role: uid === params.creatorId ? MemberRole.OWNER : MemberRole.MEMBER,
        permissionsMask: uid === params.creatorId ? 0b111111 : 0b001111,
        joinedAt: nowIso,
      }))
    );

    return channel;
  }

  public putMediaObject(params: {
    objectKey: string;
    mimeType: string;
    fileName: string;
    data: Buffer;
    uploadedBy: string;
  }): StoredMediaObject {
    const safeLabel = params.fileName.replace(/[<>&"']/g, '').slice(0, 28);
    const kb = Math.max(1, Math.round(params.data.byteLength / 1024));
    const thumbnailSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">
      <rect width="320" height="180" rx="12" fill="#0f172a"/>
      <rect x="16" y="16" width="288" height="148" rx="8" fill="#1e293b" stroke="#334155"/>
      <text x="32" y="82" fill="#f8fafc" font-family="monospace" font-size="13" font-weight="600">${safeLabel}</text>
      <text x="32" y="108" fill="#94a3b8" font-family="monospace" font-size="11">${params.mimeType} · ${kb} KB · S3 PUT</text>
    </svg>`;

    const stored: StoredMediaObject = {
      objectKey: params.objectKey,
      mimeType: params.mimeType,
      fileName: params.fileName,
      data: params.data,
      thumbnailSvg,
      uploadedBy: params.uploadedBy,
      createdAt: new Date().toISOString(),
    };
    this.mediaBucket.set(params.objectKey, stored);
    return stored;
  }

  public getMediaObject(objectKey: string): StoredMediaObject | undefined {
    return this.mediaBucket.get(objectKey);
  }

  public getPushAlerts(limit = 15): PushNotificationAlert[] {
    return this.pushAlerts.slice(0, limit);
  }

  public getUnackedStreamDepth(): number {
    let total = 0;
    for (const m of this.unackedStreams.values()) {
      total += m.size;
    }
    return total;
  }

  public getCircuitState(): CircuitState {
    return this.storageBreaker.getState();
  }

  private appendUnackedStream(userId: string, message: ChatMessage): void {
    let stream = this.unackedStreams.get(userId);
    if (!stream) {
      stream = new Map();
      this.unackedStreams.set(userId, stream);
    }
    stream.set(message.messageId, { ...message });
  }

  private enqueuePushNotification(
    recipientUserId: string,
    channel: Channel,
    message: ChatMessage
  ): void {
    // Bound push outbox history for clean memory footprint
    if (this.pushAlerts.length >= 40) {
      this.pushAlerts.pop();
    }
    this.pushAlerts.unshift({
      id: `push-${randomUUID().slice(0, 8)}`,
      recipientUserId,
      channelId: channel.id,
      messageId: message.messageId,
      provider: recipientUserId.charCodeAt(recipientUserId.length - 1) % 2 === 0 ? 'APNs' : 'FCM',
      reason: 'No active Gateway socket in user:<id>:gateways',
      dispatchedAt: new Date().toISOString(),
      preview: message.content ? message.content.slice(0, 72) : '[Media Attachment]',
    });
  }

  private seedInitialClusterData(): void {
    const now = Date.now();
    const seededUsers: UserProfile[] = [
      {
        id: 'u-elena',
        username: 'evance',
        displayName: 'Elena Vance',
        title: 'Principal Distributed Systems Architect',
        avatarInitials: 'EV',
        avatarBg: '#1d4ed8',
        createdAt: new Date(now - 90 * 86400_000).toISOString(),
      },
      {
        id: 'u-marcus',
        username: 'mchen',
        displayName: 'Marcus Chen',
        title: 'Staff Storage Engineer (ScyllaDB)',
        avatarInitials: 'MC',
        avatarBg: '#0f766e',
        createdAt: new Date(now - 84 * 86400_000).toISOString(),
      },
      {
        id: 'u-priya',
        username: 'pnair',
        displayName: 'Priya Nair',
        title: 'Edge Gateway Lead',
        avatarInitials: 'PN',
        avatarBg: '#4338ca',
        createdAt: new Date(now - 60 * 86400_000).toISOString(),
      },
      {
        id: 'u-tomasz',
        username: 'tkowalski',
        displayName: 'Tomasz Kowalski',
        title: 'Mobile Sync & Offline SDK Lead',
        avatarInitials: 'TK',
        avatarBg: '#b45309',
        createdAt: new Date(now - 45 * 86400_000).toISOString(),
      },
    ];

    for (const u of seededUsers) {
      this.users.set(u.id, u);
    }

    const seededChannels: Channel[] = [
      {
        id: 'ch-core-arch',
        type: ChannelType.GROUP,
        name: 'core-distributed-systems',
        description: 'Gateway RFC 6455 framing, Snowflake sequencing, and multi-region fan-out',
        memberCount: 48_200,
        fanoutTier: 'large-group-worker-pool',
        createdBy: 'u-elena',
        createdAt: new Date(now - 30 * 86400_000).toISOString(),
        memberIds: ['u-elena', 'u-marcus', 'u-priya', 'u-tomasz'],
      },
      {
        id: 'ch-scylla-ops',
        type: ChannelType.GROUP,
        name: 'scylla-storage-ops',
        description: 'Wide-column compaction windows, LOCAL_QUORUM latencies, and partition sizing',
        memberCount: 1_420,
        fanoutTier: 'large-group-worker-pool',
        createdBy: 'u-marcus',
        createdAt: new Date(now - 25 * 86400_000).toISOString(),
        memberIds: ['u-elena', 'u-marcus', 'u-priya'],
      },
      {
        id: 'dm-elena-marcus',
        type: ChannelType.DIRECT,
        name: 'Marcus Chen',
        description: 'Direct 1-to-1 encrypted session with Marcus Chen',
        memberCount: 2,
        fanoutTier: 'standard',
        createdBy: 'u-elena',
        createdAt: new Date(now - 14 * 86400_000).toISOString(),
        memberIds: ['u-elena', 'u-marcus'],
      },
      {
        id: 'dm-elena-priya',
        type: ChannelType.DIRECT,
        name: 'Priya Nair',
        description: 'Direct 1-to-1 encrypted session with Priya Nair',
        memberCount: 2,
        fanoutTier: 'standard',
        createdBy: 'u-elena',
        createdAt: new Date(now - 10 * 86400_000).toISOString(),
        memberIds: ['u-elena', 'u-priya'],
      },
    ];

    for (const ch of seededChannels) {
      this.channels.set(ch.id, ch);
      this.scyllaPartitions.set(ch.id, []);
      this.channelMembers.set(
        ch.id,
        ch.memberIds.map((uid) => ({
          channelId: ch.id,
          userId: uid,
          role: uid === ch.createdBy ? MemberRole.OWNER : MemberRole.MEMBER,
          permissionsMask: uid === ch.createdBy ? 0b111111 : 0b001111,
          joinedAt: ch.createdAt,
        }))
      );
    }

    const seedMessages: Array<{
      channelId: string;
      senderId: string;
      content: string;
      offsetMinutes: number;
      state: MessageLifecycleState;
    }> = [
      {
        channelId: 'ch-core-arch',
        senderId: 'u-priya',
        content:
          'Gateway fleet EU-West2 rolled over cleanly. Heartbeat ping/pong interval is locked at 30s with 60s Redis presence TTL.',
        offsetMinutes: 42,
        state: MessageLifecycleState.READ,
      },
      {
        channelId: 'ch-core-arch',
        senderId: 'u-marcus',
        content:
          'Verified ScyllaDB p99 write latency at 1.8ms under LOCAL_QUORUM. Partitioning by channel_id with DESC message_id clustering keeps latest-50 slice reads single-SSTable.',
        offsetMinutes: 35,
        state: MessageLifecycleState.READ,
      },
      {
        channelId: 'ch-core-arch',
        senderId: 'u-tomasz',
        content:
          'Client IndexedDB outbox and /api/v1/sync?cursor= catch-up passed chaos disconnect testing with zero duplicate frames.',
        offsetMinutes: 24,
        state: MessageLifecycleState.READ,
      },
      {
        channelId: 'ch-core-arch',
        senderId: 'u-elena',
        content:
          'Keep media strictly out of WebSocket frames. Every attachment goes directly to S3/MinIO via presigned HTTP PUT before sending the message reference.',
        offsetMinutes: 12,
        state: MessageLifecycleState.DELIVERED,
      },
      {
        channelId: 'ch-scylla-ops',
        senderId: 'u-marcus',
        content:
          'TimeWindowCompactionStrategy window size set to 1 day on messages_by_channel. Tombstone GC grace is tuned for soft-delete propagation.',
        offsetMinutes: 55,
        state: MessageLifecycleState.READ,
      },
      {
        channelId: 'dm-elena-marcus',
        senderId: 'u-marcus',
        content:
          'Hey Elena — ready to run a live dual-socket delivery & read-receipt check whenever you open the split client.',
        offsetMinutes: 18,
        state: MessageLifecycleState.DELIVERED,
      },
      {
        channelId: 'dm-elena-priya',
        senderId: 'u-priya',
        content:
          'Token-bucket limiter on the WebSocket gateway is active at 5 msgs/sec per socket with Retry-After metadata.',
        offsetMinutes: 29,
        state: MessageLifecycleState.READ,
      },
    ];

    for (const item of seedMessages) {
      const seq = (this.channelSeqCounters.get(item.channelId) ?? 0) + 1;
      this.channelSeqCounters.set(item.channelId, seq);
      const msgId = this.snowflake.nextId();
      const clientMsgId = `seed-${item.channelId}-${seq}`;
      const ch = this.channels.get(item.channelId)!;
      const others = ch.memberIds.filter((id) => id !== item.senderId);

      const record: ChatMessage = {
        channelId: item.channelId,
        messageId: msgId,
        channelSeq: seq,
        senderId: item.senderId,
        clientMsgId,
        content: item.content,
        mediaUrl: null,
        thumbnailUrl: null,
        mediaMeta: null,
        createdAt: new Date(now - item.offsetMinutes * 60_000).toISOString(),
        updatedAt: null,
        isEdited: false,
        isDeleted: false,
        lifecycleState: item.state,
        deliveredTo: others,
        readBy:
          item.state === MessageLifecycleState.READ
            ? [...ch.memberIds]
            : [item.senderId],
      };

      const partition = this.scyllaPartitions.get(item.channelId)!;
      partition.unshift(record);
      this.idempotencyStore.setNx(clientMsgId, record);
    }
  }
}

export const storageCluster = new DistributedStorageCluster();
