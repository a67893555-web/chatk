export enum ChannelType {
  DIRECT = 'direct',
  GROUP = 'group',
}

export enum MemberRole {
  OWNER = 'owner',
  ADMIN = 'admin',
  MEMBER = 'member',
}

export enum MessageLifecycleState {
  PENDING = 'pending',
  SENT = 'sent',
  DELIVERED = 'delivered',
  READ = 'read',
}

export enum PresenceState {
  ONLINE = 'online',
  OFFLINE = 'offline',
}

export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

export interface UserProfile {
  id: string;
  username: string;
  displayName: string;
  title: string;
  avatarInitials: string;
  avatarBg: string;
  createdAt: string;
}

export interface ChannelMember {
  channelId: string;
  userId: string;
  role: MemberRole;
  permissionsMask: number;
  joinedAt: string;
}

export interface Channel {
  id: string;
  type: ChannelType;
  name: string;
  description: string;
  memberCount: number;
  fanoutTier: 'standard' | 'large-group-worker-pool';
  createdBy: string;
  createdAt: string;
  memberIds: string[];
}

export interface MediaAttachmentMeta {
  objectKey: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  thumbnailStatus: 'ready' | 'processing';
}

export interface ChatMessage {
  channelId: string;
  messageId: string; // Monotonic 64-bit Snowflake ID (clustering key DESC in ScyllaDB)
  channelSeq: number; // Monotonic per-channel sequence number
  senderId: string;
  clientMsgId: string; // UUIDv4 idempotency & client deduplication key
  content: string;
  mediaUrl: string | null;
  thumbnailUrl: string | null;
  mediaMeta: MediaAttachmentMeta | null;
  createdAt: string;
  updatedAt: string | null;
  isEdited: boolean;
  isDeleted: boolean;
  lifecycleState: MessageLifecycleState;
  deliveredTo: string[];
  readBy: string[];
}

export interface PresenceSnapshot {
  userId: string;
  status: PresenceState;
  lastSeenAt: string;
  activeGateways: string[];
  ttlRemainingMs: number;
}

export interface DeviceSessionRecord {
  deviceId: string;
  userId: string;
  curMaxMessageId: string;
  lastSyncedAt: string;
  gatewayServerId: string | null;
}

export interface PushNotificationAlert {
  id: string;
  recipientUserId: string;
  channelId: string;
  messageId: string;
  provider: 'FCM' | 'APNs';
  reason: string;
  dispatchedAt: string;
  preview: string;
}

export type WsClientFrame =
  | { type: 'ping'; clientTime: number }
  | {
      type: 'message:send';
      channelId: string;
      clientMsgId: string;
      content: string;
      mediaUrl?: string | null;
      thumbnailUrl?: string | null;
      mediaMeta?: MediaAttachmentMeta | null;
    }
  | {
      type: 'message:edit';
      channelId: string;
      messageId: string;
      content: string;
    }
  | {
      type: 'message:delete';
      channelId: string;
      messageId: string;
    }
  | {
      type: 'message:ack_delivered';
      channelId: string;
      messageId: string;
    }
  | {
      type: 'message:mark_read';
      channelId: string;
      upToMessageId: string;
    }
  | {
      type: 'typing:start';
      channelId: string;
    }
  | {
      type: 'typing:stop';
      channelId: string;
    };

export type WsServerFrame =
  | {
      type: 'hello';
      gatewayServerId: string;
      userId: string;
      deviceId: string;
      heartbeatIntervalMs: number;
      presenceTtlMs: number;
      curMaxMessageId: string;
    }
  | { type: 'pong'; serverTime: number; clientTime: number }
  | {
      type: 'message:server_ack';
      clientMsgId: string;
      channelId: string;
      messageId: string;
      channelSeq: number;
      createdAt: string;
      deduplicated: boolean;
      message: ChatMessage;
    }
  | {
      type: 'message:new';
      message: ChatMessage;
      routedViaGateway: string;
    }
  | {
      type: 'message:updated';
      message: ChatMessage;
    }
  | {
      type: 'message:receipt';
      channelId: string;
      messageId: string;
      lifecycleState: MessageLifecycleState;
      deliveredTo: string[];
      readBy: string[];
    }
  | {
      type: 'typing:update';
      channelId: string;
      userId: string;
      isTyping: boolean;
      expiresAt: number;
    }
  | {
      type: 'presence:update';
      presence: PresenceSnapshot;
    }
  | {
      type: 'error';
      code: 'RATE_LIMITED' | 'CIRCUIT_OPEN' | 'VALIDATION_ERROR' | 'UNAUTHORIZED' | 'FORBIDDEN';
      message: string;
      retryAfterMs?: number;
      clientMsgId?: string;
    };

export interface SyncResponsePayload {
  cursor: string;
  newMaxMessageId: string;
  messages: ChatMessage[];
  flushedStreamCount: number;
  syncedAt: string;
}

export interface PresignedUploadResponse {
  objectKey: string;
  uploadUrl: string;
  publicMediaUrl: string;
  thumbnailUrl: string;
  expiresAt: number;
  requiredHeaders: Record<string, string>;
}

export interface ClusterDiagnosticsSnapshot {
  gatewayNodes: Array<{
    serverId: string;
    activeSockets: number;
    connectedUsers: string[];
  }>;
  idempotencyCacheSize: number;
  unackedStreamDepth: number;
  circuitBreakerState: CircuitState;
  pushDispatches: PushNotificationAlert[];
}
