export interface DeliverableDocument {
  id: string;
  category: 'schemas' | 'pipeline' | 'client-sync';
  filename: string;
  language: 'sql' | 'cql' | 'lua' | 'typescript';
  title: string;
  summary: string;
  highlights: string[];
  code: string;
}

export const DELIVERABLE_DOCUMENTS: DeliverableDocument[] = [
  {
    id: 'postgres-ddl',
    category: 'schemas',
    filename: '01_postgresql_relational_schema.sql',
    language: 'sql',
    title: 'PostgreSQL 16 Relational Schema (Control Plane & Metadata)',
    summary:
      'ACID-compliant schema for user profiles, group metadata, channel memberships, RBAC bitmask permissions, and per-device cur_max_message_id synchronization cursors.',
    highlights: [
      'UUID primary keys with CITEXT case-insensitive unique usernames',
      'Bitmask permission resolution for O(1) authorization checks on channel writes',
      'Composite covering index on channel_members (channel_id, user_id) for fan-out membership reads',
      'Per-device session table tracking cur_max_message_id BIGINT for /sync?cursor= catch-up',
    ],
    code: `-- PostgreSQL 16+ Control Plane Schema for High-Concurrency Messaging
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. User Profiles & Account Settings
CREATE TABLE users (
    user_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username        CITEXT NOT NULL UNIQUE CHECK (char_length(username) BETWEEN 3 AND 32),
    display_name    VARCHAR(80) NOT NULL,
    email_hash      BYTEA NOT NULL UNIQUE,
    avatar_key      VARCHAR(255),
    settings_json   JSONB NOT NULL DEFAULT '{"read_receipts": true, "typing_indicators": true, "push_mute_until": null}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    is_suspended    BOOLEAN NOT NULL DEFAULT FALSE
);

-- 2. Scalable Groups / Guild Workspaces (Up to 100,000 members)
CREATE TABLE groups (
    group_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id        UUID NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
    name            VARCHAR(100) NOT NULL,
    description     VARCHAR(500) NOT NULL DEFAULT '',
    icon_object_key VARCHAR(255),
    member_count    INTEGER NOT NULL DEFAULT 1 CHECK (member_count >= 0 AND member_count <= 100000),
    fanout_strategy VARCHAR(32) NOT NULL DEFAULT 'STANDARD'
                    CHECK (fanout_strategy IN ('STANDARD', 'WORKER_POOL_SHARDED')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Channels (Direct 1-to-1 & Group Channels)
CREATE TABLE channels (
    channel_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id        UUID REFERENCES groups(group_id) ON DELETE CASCADE,
    channel_type    SMALLINT NOT NULL CHECK (channel_type IN (1, 2)), -- 1 = DIRECT, 2 = GROUP
    dm_pair_key     VARCHAR(80) UNIQUE, -- Deterministic sorted "<min_uuid>:<max_uuid>" for 1-to-1 uniqueness
    name            VARCHAR(80),
    topic           VARCHAR(512) NOT NULL DEFAULT '',
    last_message_id BIGINT NOT NULL DEFAULT 0, -- Monotonic 64-bit Snowflake watermark
    created_by      UUID NOT NULL REFERENCES users(user_id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_channels_group_id ON channels(group_id) WHERE group_id IS NOT NULL;

-- 4. Role Definitions & Bitmask Permissions
-- Bit 0 (1): VIEW_CHANNEL | Bit 1 (2): SEND_MESSAGES | Bit 2 (4): ATTACH_MEDIA
-- Bit 3 (8): MANAGE_MESSAGES | Bit 4 (16): INVITE_MEMBERS | Bit 5 (32): ADMINISTRATOR
CREATE TABLE group_roles (
    role_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id        UUID NOT NULL REFERENCES groups(group_id) ON DELETE CASCADE,
    name            VARCHAR(48) NOT NULL,
    position        SMALLINT NOT NULL DEFAULT 0,
    allow_bits      BIGINT NOT NULL DEFAULT 7,  -- VIEW + SEND + ATTACH
    deny_bits       BIGINT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. Channel Membership & Per-Channel Read Watermarks
CREATE TABLE channel_members (
    channel_id          UUID NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
    user_id             UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    role                VARCHAR(16) NOT NULL DEFAULT 'MEMBER'
                        CHECK (role IN ('OWNER', 'ADMIN', 'MEMBER')),
    allow_override_bits BIGINT NOT NULL DEFAULT 0,
    deny_override_bits  BIGINT NOT NULL DEFAULT 0,
    last_read_msg_id    BIGINT NOT NULL DEFAULT 0,
    mute_notifications  BOOLEAN NOT NULL DEFAULT FALSE,
    joined_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (channel_id, user_id)
);

-- Covering index for user bootstrap (/api/v1/bootstrap & /api/v1/sync)
CREATE INDEX idx_channel_members_user_channels
    ON channel_members(user_id, channel_id)
    INCLUDE (last_read_msg_id, mute_notifications);

-- 6. Multi-Device Synchronization Cursors & Push Tokens
CREATE TABLE device_sessions (
    device_id           VARCHAR(64) NOT NULL,
    user_id             UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    platform            VARCHAR(16) NOT NULL CHECK (platform IN ('WEB', 'IOS', 'ANDROID', 'DESKTOP')),
    push_provider       VARCHAR(8) CHECK (push_provider IN ('FCM', 'APNS')),
    push_token          VARCHAR(512),
    cur_max_message_id  BIGINT NOT NULL DEFAULT 0, -- Reconnection /sync?cursor=<last_id> watermark
    last_active_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at          TIMESTAMPTZ,
    PRIMARY KEY (user_id, device_id)
);

CREATE INDEX idx_device_sessions_push_lookup
    ON device_sessions(user_id)
    WHERE revoked_at IS NULL AND push_token IS NOT NULL;`,
  },
  {
    id: 'scylla-cql',
    category: 'schemas',
    filename: '02_scylladb_messages_keyspace.cql',
    language: 'cql',
    title: 'ScyllaDB / Apache Cassandra Wide-Column Schema (Data Plane)',
    summary:
      'High-throughput wide-column persistence partitioned by channel_id (time-bucketed for mega-groups) and clustered descending by 64-bit Snowflake message_id for single-SSTable tail reads.',
    highlights: [
      'NetworkTopologyStrategy with RF=3 across multi-AZ racks and LOCAL_QUORUM consistency',
      'CLUSTERING ORDER BY (message_id DESC) ensures latest messages sit at partition head',
      'TimeWindowCompactionStrategy (TWCS) minimizes read/write amplification on append-heavy timelines',
      'Includes sender_id, client_msg_id, content, media_url, created_at, is_edited, and is_deleted',
    ],
    code: `-- ScyllaDB / Cassandra 5.0 Keyspace & Message Persistence Tables
CREATE KEYSPACE IF NOT EXISTS pulsewire_chat
WITH replication = {
    'class': 'NetworkTopologyStrategy',
    'eu-west-2': 3,
    'us-east-1': 3
} AND durable_writes = true;

USE pulsewire_chat;

-- Primary Timeline Table: Partitioned by channel_id, Clustered by message_id DESC
-- Note: For ultra-active 100k+ channels exceeding 100MB/partition, bucket_id (YYYYMM) can be added to partition key.
CREATE TABLE IF NOT EXISTS messages_by_channel (
    channel_id      uuid,
    message_id      bigint,          -- 64-bit Monotonic Snowflake ID (Clustering Key DESC)
    channel_seq     bigint,          -- Per-channel contiguous sequence counter
    sender_id       uuid,
    client_msg_id   text,            -- Client UUIDv4 for end-to-end deduplication
    content         text,
    media_url       text,            -- Object Storage URL (NEVER inline binary)
    thumbnail_url   text,
    media_mime      text,
    media_bytes     int,
    created_at      timestamp,
    updated_at      timestamp,
    is_edited       boolean,
    is_deleted      boolean,         -- Soft-delete tombstone marker for /sync propagation
    PRIMARY KEY ((channel_id), message_id)
) WITH CLUSTERING ORDER BY (message_id DESC)
  AND compaction = {
      'class': 'TimeWindowCompactionStrategy',
      'compaction_window_unit': 'DAYS',
      'compaction_window_size': 1
  }
  AND gc_grace_seconds = 864000
  AND caching = {'keys': 'ALL', 'rows_per_partition': '120'}
  AND comment = 'Core chat message timeline ordered newest-first per channel';

-- Recipient Delivery & Read Watermarks for Direct & Small Group Receipts
CREATE TABLE IF NOT EXISTS message_delivery_receipts (
    channel_id      uuid,
    message_id      bigint,
    recipient_id    uuid,
    state           text,            -- 'DELIVERED' | 'READ'
    updated_at      timestamp,
    PRIMARY KEY ((channel_id, message_id), recipient_id)
);

-- Multi-Device User Inbox Change-Log for O(1) Cross-Channel /sync?cursor=<last_id>
CREATE TABLE IF NOT EXISTS user_sync_changelog (
    user_id         uuid,
    message_id      bigint,          -- Snowflake ID of new message, edit, or delete event
    channel_id      uuid,
    event_type      text,            -- 'CREATED' | 'EDITED' | 'DELETED'
    event_ts        timestamp,
    PRIMARY KEY ((user_id), message_id)
) WITH CLUSTERING ORDER BY (message_id ASC)
  AND default_time_to_live = 2592000; -- Retain 30 days of delta sync log; older devices fall back to full channel bootstrap`,
  },
  {
    id: 'redis-cluster-lua',
    category: 'schemas',
    filename: '03_redis_cluster_keyspace_and_lua.lua',
    language: 'lua',
    title: 'Redis Cluster Keyspace & Atomic Lua Scripts',
    summary:
      'In-memory connection routing sets, per-gateway Pub/Sub channels, 60s heartbeat presence keys, 24h idempotency locks, and atomic Token-Bucket rate limiting.',
    highlights: [
      'Hash-tagged keys {user:<id>} co-locate presence and gateway sets on the same Redis Cluster slot',
      'Atomic Lua Token-Bucket script enforces 5 msgs/sec per socket in a single round-trip',
      '24-hour idempotency:<client_msg_id> prevents duplicate writes across network retries',
    ],
    code: `-- ============================================================================
-- REDIS CLUSTER KEYSPACE CONVENTIONS
-- ============================================================================
-- 1. Gateway Connection Set:  SADD {user:<user_id>}:gateways "gw-eu-west2-01"
--                             EXPIRE {user:<user_id>}:gateways 60
-- 2. Presence Status Hash:    HSET {user:<user_id>}:presence status "online" last_seen "<ms>"
--                             EXPIRE {user:<user_id>}:presence 60
-- 3. Gateway Pub/Sub Channel: PUBLISH gateway:<server_id> "<json_envelope>"
-- 4. 24h Idempotency Key:     SET idempotency:<client_msg_id> "<ack_json>" NX EX 86400
-- 5. Un-Acked Stream Buffer:  XADD {user:<user_id>}:unacked MAXLEN ~ 1000 * msg_id "<id>" payload "<json>"

-- ============================================================================
-- ATOMIC TOKEN-BUCKET RATE LIMITER LUA SCRIPT (5 msgs/sec per WebSocket)
-- KEYS[1] = rate:ws:<socket_id>
-- ARGV[1] = capacity (5)
-- ARGV[2] = refill_rate_per_ms (0.005)
-- ARGV[3] = now_ms
-- ARGV[4] = cost (1)
-- ============================================================================
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])
local now_ms = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])

local bucket = redis.call('HMGET', key, 'tokens', 'last_refill')
local tokens = tonumber(bucket[1])
local last_refill = tonumber(bucket[2])

if tokens == nil or last_refill == nil then
    tokens = capacity
    last_refill = now_ms
else
    local elapsed = math.max(0, now_ms - last_refill)
    tokens = math.min(capacity, tokens + (elapsed * refill_rate))
    last_refill = now_ms
end

if tokens >= cost then
    tokens = tokens - cost
    redis.call('HMSET', key, 'tokens', tokens, 'last_refill', last_refill)
    redis.call('PEXPIRE', key, 60000)
    return {1, tostring(tokens), 0}
else
    local retry_after_ms = math.ceil((cost - tokens) / refill_rate)
    redis.call('HMSET', key, 'tokens', tokens, 'last_refill', last_refill)
    redis.call('PEXPIRE', key, 60000)
    return {0, tostring(tokens), retry_after_ms}
end`,
  },
  {
    id: 'ws-gateway-manager',
    category: 'pipeline',
    filename: 'gateway_connection_manager.ts',
    language: 'typescript',
    title: 'WebSocket Gateway Connection Manager (Node.js / TypeScript)',
    summary:
      'Production RFC 6455 WebSocket Gateway handling JWT handshake authentication, local socket pooling, 30s ping/pong heartbeats, 60s Redis presence TTLs, 5 msg/s token-bucket limiting, and Redis Pub/Sub fan-in.',
    highlights: [
      'Authenticates Bearer/Query JWT during HTTP Upgrade before allocating WebSocket buffers',
      'Maintains user:<user_id>:gateways mapping in Redis Cluster and subscribes to gateway:<server_id>',
      'Sweeps dead TCP connections every 30s via RFC 6455 Ping/Pong frames and refreshes 60s Presence TTL',
      'Graceful SIGTERM connection draining sends close code 1001 so clients reconnect jittered',
    ],
    code: `import { Server as HttpServer, IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import Redis from 'ioredis';
import jwt from 'jsonwebtoken';

export interface GatewayConfig {
  serverId: string;          // e.g. "gw-eu-west2-04"
  jwtPublicKey: string;
  heartbeatIntervalMs: number; // 30_000 (30s)
  presenceTtlSeconds: number;  // 60 (60s)
  rateLimitPerSec: number;     // 5 msgs/sec per socket
}

interface SocketContext {
  socketId: string;
  userId: string;
  deviceId: string;
  ws: WebSocket;
  isAlive: boolean;
  tokens: number;
  lastRefillMs: number;
}

export class ProductionGatewayServer {
  private readonly wss: WebSocketServer;
  private readonly localUserSockets = new Map<string, Set<SocketContext>>();
  private readonly socketsById = new Map<string, SocketContext>();
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(
    httpServer: HttpServer,
    private readonly redisCmd: Redis,
    private readonly redisSub: Redis,
    private readonly messagePipeline: {
      handleInboundFrame: (ctx: { userId: string; deviceId: string }, payload: unknown) => Promise<unknown>;
    },
    private readonly config: GatewayConfig
  ) {
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: 64 * 1024, // Strict 64KB frame ceiling; media never traverses WS
      perMessageDeflate: false, // Disable compression CPU overhead at 100k+ concurrency
    });

    this.bindHttpUpgrade(httpServer);
    void this.subscribeGatewayPubSub();
    this.startHeartbeatLoop();
  }

  private bindHttpUpgrade(httpServer: HttpServer): void {
    httpServer.on('upgrade', (req: IncomingMessage, socket, head) => {
      try {
        const url = new URL(req.url ?? '/', \`http://\${req.headers.host ?? 'localhost'}\`);
        if (url.pathname !== '/ws') {
          socket.destroy();
          return;
        }

        const rawToken =
          req.headers.authorization?.replace(/^Bearer\\s+/i, '') ??
          url.searchParams.get('token');

        if (!rawToken) {
          socket.write('HTTP/1.1 401 Unauthorized\\r\\n\\r\\n');
          socket.destroy();
          return;
        }

        const decoded = jwt.verify(rawToken, this.config.jwtPublicKey, {
          algorithms: ['RS256', 'HS256'],
        }) as { sub: string; deviceId: string };

        this.wss.handleUpgrade(req, socket, head, (ws) => {
          void this.registerSocket(ws, decoded.sub, decoded.deviceId);
        });
      } catch {
        socket.write('HTTP/1.1 401 Unauthorized\\r\\n\\r\\n');
        socket.destroy();
      }
    });
  }

  private async registerSocket(ws: WebSocket, userId: string, deviceId: string): Promise<void> {
    const ctx: SocketContext = {
      socketId: randomUUID(),
      userId,
      deviceId,
      ws,
      isAlive: true,
      tokens: this.config.rateLimitPerSec,
      lastRefillMs: Date.now(),
    };

    this.socketsById.set(ctx.socketId, ctx);
    let userPool = this.localUserSockets.get(userId);
    if (!userPool) {
      userPool = new Set();
      this.localUserSockets.set(userId, userPool);
    }
    userPool.add(ctx);

    // Register gateway mapping + presence in Redis Cluster pipeline
    await this.refreshRedisPresence(userId);

    ws.on('pong', () => {
      ctx.isAlive = true;
      void this.refreshRedisPresence(ctx.userId);
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        this.sendJson(ws, {
          type: 'error',
          code: 'BINARY_FORBIDDEN',
          message: 'Binary media frames are rejected. Use presigned HTTP PUT upload URLs.',
        });
        return;
      }

      if (!this.consumeTokenBucket(ctx)) {
        this.sendJson(ws, {
          type: 'error',
          code: 'RATE_LIMITED',
          message: 'Socket rate limit exceeded (5 msgs/sec).',
        });
        return;
      }

      void this.dispatchFrame(ctx, data.toString('utf8'));
    });

    ws.on('close', () => void this.cleanupSocket(ctx));
    ws.on('error', () => void this.cleanupSocket(ctx));
  }

  private consumeTokenBucket(ctx: SocketContext): boolean {
    const now = Date.now();
    const refillRatePerMs = this.config.rateLimitPerSec / 1000;
    const elapsed = Math.max(0, now - ctx.lastRefillMs);
    ctx.tokens = Math.min(this.config.rateLimitPerSec, ctx.tokens + elapsed * refillRatePerMs);
    ctx.lastRefillMs = now;

    if (ctx.tokens < 1) return false;
    ctx.tokens -= 1;
    return true;
  }

  private async dispatchFrame(ctx: SocketContext, raw: string): Promise<void> {
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.type === 'typing:start' || parsed?.type === 'typing:stop') {
        // Ephemeral typing event published straight to Redis Pub/Sub (never touches DB)
        await this.redisCmd.publish(
          \`channel:ephemeral:\${parsed.channelId}\`,
          JSON.stringify({ userId: ctx.userId, type: parsed.type, ts: Date.now() })
        );
        return;
      }
      const ack = await this.messagePipeline.handleInboundFrame(
        { userId: ctx.userId, deviceId: ctx.deviceId },
        parsed
      );
      if (ack) this.sendJson(ctx.ws, ack);
    } catch (err) {
      this.sendJson(ctx.ws, {
        type: 'error',
        code: 'PIPELINE_FAILURE',
        message: err instanceof Error ? err.message : 'Unhandled frame error',
      });
    }
  }

  private async subscribeGatewayPubSub(): Promise<void> {
    const channelName = \`gateway:\${this.config.serverId}\`;
    await this.redisSub.subscribe(channelName);

    this.redisSub.on('message', (channel, rawEnvelope) => {
      if (channel !== channelName) return;
      try {
        const envelope = JSON.parse(rawEnvelope) as {
          targetUserIds: string[];
          frame: unknown;
        };
        const serialized = JSON.stringify(envelope.frame);
        for (const uid of envelope.targetUserIds) {
          const sockets = this.localUserSockets.get(uid);
          if (!sockets) continue;
          for (const sock of sockets) {
            if (sock.ws.readyState === WebSocket.OPEN) {
              sock.ws.send(serialized);
            }
          }
        }
      } catch (err) {
        console.error('[Gateway] Malformed Pub/Sub envelope:', err);
      }
    });
  }

  private startHeartbeatLoop(): void {
    this.heartbeatTimer = setInterval(() => {
      for (const ctx of this.socketsById.values()) {
        if (!ctx.isAlive) {
          ctx.ws.terminate();
          void this.cleanupSocket(ctx);
          continue;
        }
        ctx.isAlive = false;
        ctx.ws.ping();
      }
    }, this.config.heartbeatIntervalMs);
  }

  private async refreshRedisPresence(userId: string): Promise<void> {
    const ttl = this.config.presenceTtlSeconds;
    const gwKey = \`{user:\${userId}}:gateways\`;
    const presKey = \`{user:\${userId}}:presence\`;
    await this.redisCmd
      .pipeline()
      .sadd(gwKey, this.config.serverId)
      .expire(gwKey, ttl)
      .hset(presKey, 'status', 'online', 'last_seen', Date.now().toString())
      .expire(presKey, ttl)
      .exec();
  }

  private async cleanupSocket(ctx: SocketContext): Promise<void> {
    if (!this.socketsById.delete(ctx.socketId)) return;

    const pool = this.localUserSockets.get(ctx.userId);
    if (pool) {
      pool.delete(ctx);
      if (pool.size === 0) {
        this.localUserSockets.delete(ctx.userId);
        // Remove this gateway server ID from user's active Redis gateway set
        const gwKey = \`{user:\${ctx.userId}}:gateways\`;
        const presKey = \`{user:\${ctx.userId}}:presence\`;
        await this.redisCmd.srem(gwKey, this.config.serverId);
        const remainingGateways = await this.redisCmd.scard(gwKey);
        if (remainingGateways === 0) {
          await this.redisCmd.hset(
            presKey,
            'status',
            'offline',
            'last_seen',
            Date.now().toString()
          );
        }
      }
    }
  }

  private sendJson(ws: WebSocket, payload: unknown): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  public async drainAndClose(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    await this.redisSub.unsubscribe(\`gateway:\${this.config.serverId}\`);
    for (const ctx of this.socketsById.values()) {
      ctx.ws.close(1001, 'Server restarting — reconnect with jitter');
      await this.cleanupSocket(ctx);
    }
  }
}`,
  },
  {
    id: 'idempotent-message-pipeline',
    category: 'pipeline',
    filename: 'idempotent_message_pipeline.ts',
    language: 'typescript',
    title: 'Idempotent Message Pipeline & 100k-Member Fan-Out Engine',
    summary:
      'Core Message Service checking 24h Redis idempotency, assigning monotonic 64-bit Snowflake IDs, writing to ScyllaDB with LOCAL_QUORUM, fanning out across Gateway Pub/Sub shards, and buffering un-ACKed messages in Redis Streams before Push fallback.',
    highlights: [
      'Zero-Message-Loss guarantee via Redis 24h SET NX EX 86400 + ScyllaDB LOCAL_QUORUM write',
      'Bounded concurrency worker pool fans out 100,000-member channels in 500-user chunks',
      'Transient Redis Stream (XADD) holds un-acknowledged messages before FCM/APNs push dispatch',
    ],
    code: `import { Client as CassandraClient, types as CassandraTypes } from 'cassandra-driver';
import Redis from 'ioredis';

export interface InboundMessageCmd {
  senderId: string;
  deviceId: string;
  channelId: string;
  clientMsgId: string;
  content: string;
  mediaUrl: string | null;
  thumbnailUrl: string | null;
}

export interface PersistedMessageAck {
  type: 'message:server_ack';
  clientMsgId: string;
  channelId: string;
  messageId: string;
  createdAt: string;
  deduplicated: boolean;
}

export class IdempotentMessagePipeline {
  private static readonly IDEMPOTENCY_TTL_SEC = 86_400; // 24 hours
  private static readonly FANOUT_CHUNK_SIZE = 500;

  constructor(
    private readonly scylla: CassandraClient,
    private readonly redis: Redis,
    private readonly snowflake: { nextId: () => bigint },
    private readonly membershipRepo: { getChannelMemberIds: (channelId: string) => Promise<string[]> },
    private readonly pushQueue: { enqueueOfflinePush: (userIds: string[], msg: unknown) => Promise<void> }
  ) {}

  public async handleSendMessage(cmd: InboundMessageCmd): Promise<PersistedMessageAck> {
    if (!cmd.clientMsgId || cmd.clientMsgId.length > 128) {
      throw new Error('Invalid client_msg_id');
    }
    if (!cmd.content.trim() && !cmd.mediaUrl) {
      throw new Error('Message requires text content or presigned media URL');
    }

    const idemKey = \`idempotency:\${cmd.clientMsgId}\`;

    // 1. Fast-path check for duplicate retry within 24-hour window
    const existingRaw = await this.redis.get(idemKey);
    if (existingRaw) {
      const cached = JSON.parse(existingRaw) as PersistedMessageAck;
      return { ...cached, deduplicated: true };
    }

    // 2. Acquire short-lived processing lock to prevent concurrent race on identical client_msg_id
    const lockKey = \`idempotency:lock:\${cmd.clientMsgId}\`;
    const acquired = await this.redis.set(lockKey, '1', 'NX', 'PX', 5000);
    if (!acquired) {
      throw new Error('Concurrent duplicate message_send in flight; retry with backoff');
    }

    try {
      // 3. Assign monotonic 64-bit Snowflake ID
      const messageSnowflake = this.snowflake.nextId();
      const messageIdStr = messageSnowflake.toString();
      const createdAt = new Date();

      // 4. Write to ScyllaDB with LOCAL_QUORUM consistency (prepared statement)
      const insertCql = \`
        INSERT INTO pulsewire_chat.messages_by_channel (
          channel_id, message_id, sender_id, client_msg_id,
          content, media_url, thumbnail_url, created_at, is_edited, is_deleted
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, false, false)
      \`;

      await this.scylla.execute(
        insertCql,
        [
          CassandraTypes.Uuid.fromString(cmd.channelId),
          CassandraTypes.Long.fromString(messageIdStr),
          CassandraTypes.Uuid.fromString(cmd.senderId),
          cmd.clientMsgId,
          cmd.content.trim(),
          cmd.mediaUrl,
          cmd.thumbnailUrl,
          createdAt,
        ],
        { prepare: true, consistency: CassandraTypes.consistencies.localQuorum }
      );

      const serverAck: PersistedMessageAck = {
        type: 'message:server_ack',
        clientMsgId: cmd.clientMsgId,
        channelId: cmd.channelId,
        messageId: messageIdStr,
        createdAt: createdAt.toISOString(),
        deduplicated: false,
      };

      // 5. Commit authoritative Ack to Redis idempotency key for 24 hours
      await this.redis.set(
        idemKey,
        JSON.stringify(serverAck),
        'EX',
        IdempotentMessagePipeline.IDEMPOTENCY_TTL_SEC
      );

      // 6. Dispatch asynchronous scalable fan-out across Gateway Pub/Sub & Offline Push
      const outboundFrame = {
        type: 'message:new',
        message: {
          channelId: cmd.channelId,
          messageId: messageIdStr,
          senderId: cmd.senderId,
          clientMsgId: cmd.clientMsgId,
          content: cmd.content.trim(),
          mediaUrl: cmd.mediaUrl,
          thumbnailUrl: cmd.thumbnailUrl,
          createdAt: createdAt.toISOString(),
          isEdited: false,
          isDeleted: false,
        },
      };

      await this.fanoutToChannelMembers(cmd.channelId, outboundFrame);
      return serverAck;
    } finally {
      await this.redis.del(lockKey).catch(() => undefined);
    }
  }

  private async fanoutToChannelMembers(channelId: string, frame: { message: { messageId: string } }): Promise<void> {
    const memberIds = await this.membershipRepo.getChannelMemberIds(channelId);

    // Process up to 100,000 members in non-blocking chunks of 500
    for (let offset = 0; offset < memberIds.length; offset += IdempotentMessagePipeline.FANOUT_CHUNK_SIZE) {
      const chunk = memberIds.slice(offset, offset + IdempotentMessagePipeline.FANOUT_CHUNK_SIZE);

      const pipeline = this.redis.pipeline();
      for (const uid of chunk) {
        pipeline.smembers(\`{user:\${uid}}:gateways\`);
      }
      const lookupResults = await pipeline.exec();

      const gatewayBatches = new Map<string, string[]>();
      const offlineRecipients: string[] = [];
      const streamPipeline = this.redis.pipeline();

      chunk.forEach((uid, index) => {
        const [, gateways] = (lookupResults?.[index] ?? [null, []]) as [Error | null, string[]];

        // Buffer every outbound message in transient Redis Stream until recipient WS ACKs
        streamPipeline.xadd(
          \`{user:\${uid}}:unacked\`,
          'MAXLEN',
          '~',
          '1000',
          '*',
          'message_id',
          frame.message.messageId,
          'payload',
          JSON.stringify(frame)
        );

        if (Array.isArray(gateways) && gateways.length > 0) {
          for (const gwId of gateways) {
            const list = gatewayBatches.get(gwId) ?? [];
            list.push(uid);
            gatewayBatches.set(gwId, list);
          }
        } else {
          offlineRecipients.push(uid);
        }
      });

      await streamPipeline.exec();

      // Publish consolidated envelope per Gateway Server ID (1 PUBLISH per gateway, NOT per user!)
      const pubPipeline = this.redis.pipeline();
      for (const [gwId, targetUserIds] of gatewayBatches.entries()) {
        pubPipeline.publish(
          \`gateway:\${gwId}\`,
          JSON.stringify({ targetUserIds, frame })
        );
      }
      await pubPipeline.exec();

      // Dispatch FCM/APNs notifications for offline recipients
      if (offlineRecipients.length > 0) {
        await this.pushQueue.enqueueOfflinePush(offlineRecipients, frame.message);
      }
    }
  }
}`,
  },
  {
    id: 'client-sync-indexeddb',
    category: 'client-sync',
    filename: 'client_sync_indexeddb.ts',
    language: 'typescript',
    title: 'Client Offline Store (IndexedDB), Cursor Sync & Deduplication SDK',
    summary:
      'Production TypeScript browser SDK persisting messages, pending outbox frames, and cur_max_message_id cursors in IndexedDB with Full-Jitter exponential backoff and /sync?cursor= catch-up.',
    highlights: [
      'Atomic IndexedDB transactions across messages, pending_outbox, and sync_cursors stores',
      'Reconciles optimistic Pending messages against authoritative Snowflake IDs via client_msg_id',
      'Executes GET /api/v1/sync?cursor=<cur_max_message_id> immediately upon WebSocket reconnect before flushing outbox',
      'Presigned HTTP PUT media uploader streams files directly to Object Storage without blocking WebSockets',
    ],
    code: `export interface ClientStoredMessage {
  channelId: string;
  messageId: string;
  clientMsgId: string;
  senderId: string;
  content: string;
  mediaUrl: string | null;
  createdAt: string;
  isEdited: boolean;
  isDeleted: boolean;
  lifecycleState: 'pending' | 'sent' | 'delivered' | 'read';
}

export class OfflineSyncDatabase {
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(private readonly dbName = 'pulsewire_sync_v1') {}

  public open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;

    this.dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 1);

      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('messages')) {
          const msgStore = db.createObjectStore('messages', { keyPath: 'clientMsgId' });
          msgStore.createIndex('by_channel', 'channelId', { unique: false });
          msgStore.createIndex('by_server_id', 'messageId', { unique: false });
        }
        if (!db.objectStoreNames.contains('pending_outbox')) {
          db.createObjectStore('pending_outbox', { keyPath: 'clientMsgId' });
        }
        if (!db.objectStoreNames.contains('sync_cursors')) {
          db.createObjectStore('sync_cursors', { keyPath: 'deviceId' });
        }
      };

      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    });

    return this.dbPromise;
  }

  public async getSyncCursor(deviceId: string): Promise<string> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('sync_cursors', 'readonly');
      const req = tx.objectStore('sync_cursors').get(deviceId);
      req.onsuccess = () => resolve(req.result?.curMaxMessageId ?? '0');
      req.onerror = () => reject(req.error);
    });
  }

  public async saveReconciledBatch(
    deviceId: string,
    newMaxCursor: string,
    messages: ClientStoredMessage[],
    ackedClientMsgIds: string[]
  ): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['messages', 'pending_outbox', 'sync_cursors'], 'readwrite');
      const msgStore = tx.objectStore('messages');
      const outboxStore = tx.objectStore('pending_outbox');
      const cursorStore = tx.objectStore('sync_cursors');

      for (const msg of messages) {
        // Keyed by clientMsgId -> naturally deduplicates optimistic Pending & Server Ack!
        msgStore.put(msg);
      }
      for (const clientId of ackedClientMsgIds) {
        outboxStore.delete(clientId);
      }
      cursorStore.put({ deviceId, curMaxMessageId: newMaxCursor, updatedAt: Date.now() });

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  public async enqueueOutbox(msg: ClientStoredMessage): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['messages', 'pending_outbox'], 'readwrite');
      tx.objectStore('messages').put(msg);
      tx.objectStore('pending_outbox').put(msg);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  public async getPendingOutbox(): Promise<ClientStoredMessage[]> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('pending_outbox', 'readonly');
      const req = tx.objectStore('pending_outbox').getAll();
      req.onsuccess = () => resolve(req.result ?? []);
      req.onerror = () => reject(req.error);
    });
  }
}

export class ResilientSyncCoordinator {
  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;

  constructor(
    private readonly apiBaseUrl: string,
    private readonly wsUrl: string,
    private readonly jwtToken: string,
    private readonly deviceId: string,
    private readonly store: OfflineSyncDatabase,
    private readonly onStateUpdate: (messages: ClientStoredMessage[]) => void
  ) {}

  public connect(): void {
    const url = \`\${this.wsUrl}?token=\${encodeURIComponent(this.jwtToken)}\`;
    this.ws = new WebSocket(url);

    this.ws.onopen = async () => {
      this.reconnectAttempt = 0;
      // 1. Catch up missed events since cur_max_message_id via HTTP/2 REST /sync
      await this.performCursorCatchUp();
      // 2. Replay any offline queued messages with their original client_msg_id
      await this.flushOfflineOutbox();
    };

    this.ws.onmessage = async (event) => {
      const frame = JSON.parse(event.data);
      if (frame.type === 'message:server_ack') {
        const cur = await this.store.getSyncCursor(this.deviceId);
        const nextCursor = BigInt(frame.messageId) > BigInt(cur) ? frame.messageId : cur;
        await this.store.saveReconciledBatch(
          this.deviceId,
          nextCursor,
          [{ ...frame.message, lifecycleState: 'sent' }],
          [frame.clientMsgId]
        );
      } else if (frame.type === 'message:new') {
        const cur = await this.store.getSyncCursor(this.deviceId);
        const nextCursor = BigInt(frame.message.messageId) > BigInt(cur) ? frame.message.messageId : cur;
        await this.store.saveReconciledBatch(this.deviceId, nextCursor, [frame.message], []);
        this.onStateUpdate([frame.message]);
        // Emit recipient Delivery Ack back to Gateway
        this.ws?.send(
          JSON.stringify({
            type: 'message:ack_delivered',
            channelId: frame.message.channelId,
            messageId: frame.message.messageId,
          })
        );
      }
    };

    this.ws.onclose = () => this.scheduleReconnectWithJitter();
  }

  private async performCursorCatchUp(): Promise<void> {
    const lastCursor = await this.store.getSyncCursor(this.deviceId);
    const res = await fetch(
      \`\${this.apiBaseUrl}/api/v1/sync?cursor=\${encodeURIComponent(lastCursor)}&deviceId=\${encodeURIComponent(this.deviceId)}\`,
      { headers: { Authorization: \`Bearer \${this.jwtToken}\` } }
    );
    if (!res.ok) throw new Error(\`Sync failed with HTTP \${res.status}\`);

    const delta = (await res.json()) as {
      newMaxMessageId: string;
      messages: ClientStoredMessage[];
    };
    if (delta.messages.length > 0) {
      await this.store.saveReconciledBatch(
        this.deviceId,
        delta.newMaxMessageId,
        delta.messages,
        delta.messages.map((m) => m.clientMsgId)
      );
      this.onStateUpdate(delta.messages);
    }
  }

  private async flushOfflineOutbox(): Promise<void> {
    const pending = await this.store.getPendingOutbox();
    for (const item of pending) {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({
            type: 'message:send',
            channelId: item.channelId,
            clientMsgId: item.clientMsgId,
            content: item.content,
            mediaUrl: item.mediaUrl,
          })
        );
      }
    }
  }

  private scheduleReconnectWithJitter(): void {
    const capMs = 30_000;
    const baseMs = 500;
    const ceiling = Math.min(capMs, baseMs * Math.pow(2, this.reconnectAttempt++));
    const delayMs = Math.round(ceiling * (0.2 + Math.random() * 0.8));
    this.reconnectTimer = window.setTimeout(() => this.connect(), delayMs);
  }
}`,
  },
];
