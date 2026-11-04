import { IncomingMessage, Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { verifyJwt } from './jwtAuth';
import { DistributedStorageCluster } from './storageEngine';
import { redisBridge } from './redisAdapter';
import { TokenBucketRateLimiter } from '../shared/distributedCore';
import { isOriginAllowed } from '../shared/deploymentUtils';
import { WsClientFrame, WsServerFrame } from '../shared/types';

interface ManagedSocketSession {
  socketId: string;
  ws: WebSocket;
  userId: string;
  deviceId: string;
  gatewayServerId: string;
  isAlive: boolean;
  connectedAtMs: number;
}

const HEARTBEAT_INTERVAL_MS = 30_000;
const PRESENCE_TTL_MS = 60_000;
const GATEWAY_NODES = ['gw-eu-west2-01', 'gw-eu-west2-02'] as const;

export class GatewayConnectionManager {
  private readonly wss: WebSocketServer;
  private readonly cluster: DistributedStorageCluster;
  private readonly rateLimiter = new TokenBucketRateLimiter(5, 5); // 5 msgs/sec per socket
  // gatewayServerId -> userId -> Set<ManagedSocketSession>
  private readonly nodePools = new Map<string, Map<string, Set<ManagedSocketSession>>>();
  private readonly allSockets = new Map<string, ManagedSocketSession>();
  private readonly unsubscribes: Array<() => void> = [];
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private roundRobinCounter = 0;

  constructor(httpServer: HttpServer, cluster: DistributedStorageCluster) {
    this.cluster = cluster;

    for (const gwId of GATEWAY_NODES) {
      this.nodePools.set(gwId, new Map());
      const unsub = this.cluster.subscribeGatewayChannel(gwId, (targetUserIds, frame) => {
        this.deliverPubSubFrame(gwId, targetUserIds, frame);
      });
      this.unsubscribes.push(unsub);
    }

    this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

    httpServer.on('upgrade', (request, socket, head) => {
      // Allow Vite HMR WebSocket upgrades (subprotocol 'vite-hmr') to pass through untouched
      const wsProtocol = request.headers['sec-websocket-protocol'];
      if (typeof wsProtocol === 'string' && wsProtocol.includes('vite-hmr')) {
        return;
      }

      let parsedUrl: URL;
      try {
        const host = request.headers.host || 'localhost:3000';
        parsedUrl = new URL(request.url || '/', `http://${host}`);
      } catch {
        return;
      }

      // Only handle /ws RFC 6455 chat gateway path
      if (parsedUrl.pathname !== '/ws') {
        return;
      }

      try {
        // Validate cross-origin WebSocket Upgrade against CORS_ALLOWED_ORIGINS (e.g. Vercel frontend URL)
        const requestOrigin =
          typeof request.headers.origin === 'string' ? request.headers.origin : undefined;
        if (!isOriginAllowed(requestOrigin, process.env.CORS_ALLOWED_ORIGINS)) {
          socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }

        const token =
          request.headers.authorization?.replace(/^Bearer\s+/i, '').trim() ||
          parsedUrl.searchParams.get('token');
        const claims = verifyJwt(token);
        if (!claims || !this.cluster.users.has(claims.sub)) {
          socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }

        this.wss.handleUpgrade(request, socket, head, (ws) => {
          this.onAuthenticatedConnection(ws, request, claims.sub, claims.deviceId);
        });
      } catch {
        socket.destroy();
      }
    });

    this.startHeartbeatSweep();
  }

  public getGatewayStats(): Array<{
    serverId: string;
    activeSockets: number;
    connectedUsers: string[];
  }> {
    return GATEWAY_NODES.map((serverId) => {
      const userMap = this.nodePools.get(serverId) ?? new Map();
      let activeSockets = 0;
      const connectedUsers: string[] = [];
      for (const [uid, set] of userMap.entries()) {
        if (set.size > 0) {
          connectedUsers.push(uid);
          activeSockets += set.size;
        }
      }
      return { serverId, activeSockets, connectedUsers };
    });
  }

  public shutdown(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const unsub of this.unsubscribes) {
      unsub();
    }
    for (const session of this.allSockets.values()) {
      session.ws.close(1001, 'Gateway draining');
    }
    this.allSockets.clear();
  }

  private onAuthenticatedConnection(
    ws: WebSocket,
    _req: IncomingMessage,
    userId: string,
    deviceId: string
  ): void {
    const gatewayServerId =
      GATEWAY_NODES[this.roundRobinCounter++ % GATEWAY_NODES.length];
    const socketId = `sock-${randomUUID().slice(0, 10)}`;

    const session: ManagedSocketSession = {
      socketId,
      ws,
      userId,
      deviceId,
      gatewayServerId,
      isAlive: true,
      connectedAtMs: Date.now(),
    };

    this.allSockets.set(socketId, session);
    const pool = this.nodePools.get(gatewayServerId)!;
    let userSet = pool.get(userId);
    if (!userSet) {
      userSet = new Set();
      pool.set(userId, userSet);
    }
    userSet.add(session);

    // Register user:<user_id>:gateways + 60s Presence TTL in Redis cluster
    const presence = this.cluster.presenceRegistry.registerConnection(
      userId,
      gatewayServerId,
      socketId
    );
    redisBridge.mirrorPresenceHeartbeat(userId, gatewayServerId, 60);
    const deviceRecord = this.cluster.upsertDeviceSession(
      userId,
      deviceId,
      undefined,
      gatewayServerId
    );

    // Send initial Gateway Hello handshake frame
    this.safeSend(ws, {
      type: 'hello',
      gatewayServerId,
      userId,
      deviceId,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      presenceTtlMs: PRESENCE_TTL_MS,
      curMaxMessageId: deviceRecord.curMaxMessageId,
    });

    // Broadcast online presence transition to all peers
    this.broadcastPresenceUpdate(presence);

    ws.on('pong', () => {
      session.isAlive = true;
      const refreshed = this.cluster.presenceRegistry.heartbeat(session.userId);
      this.broadcastPresenceUpdate(refreshed);
    });

    ws.on('message', (rawData) => {
      session.isAlive = true;
      this.cluster.presenceRegistry.heartbeat(session.userId);
      void this.handleClientFrame(session, rawData.toString('utf8'));
    });

    ws.on('close', () => {
      this.cleanupSocket(session);
    });

    ws.on('error', () => {
      this.cleanupSocket(session);
    });
  }

  private async handleClientFrame(
    session: ManagedSocketSession,
    rawPayload: string
  ): Promise<void> {
    let frame: WsClientFrame;
    try {
      frame = JSON.parse(rawPayload) as WsClientFrame;
    } catch {
      this.safeSend(session.ws, {
        type: 'error',
        code: 'VALIDATION_ERROR',
        message: 'Malformed JSON WebSocket frame',
      });
      return;
    }

    if (!frame || typeof frame !== 'object' || !('type' in frame)) {
      this.safeSend(session.ws, {
        type: 'error',
        code: 'VALIDATION_ERROR',
        message: 'Missing frame discriminator type',
      });
      return;
    }

    // Application-level Ping/Pong + Redis 60s Presence refresh
    if (frame.type === 'ping') {
      this.cluster.presenceRegistry.heartbeat(session.userId);
      this.safeSend(session.ws, {
        type: 'pong',
        serverTime: Date.now(),
        clientTime: frame.clientTime,
      });
      return;
    }

    // Ephemeral Typing Indicators (routed strictly via Redis Pub/Sub, NEVER saved to DB)
    if (frame.type === 'typing:start' || frame.type === 'typing:stop') {
      const channel = this.cluster.channels.get(frame.channelId);
      if (!channel || !channel.memberIds.includes(session.userId)) return;
      const peers = channel.memberIds.filter((uid) => uid !== session.userId);
      this.cluster.broadcastToUsers(peers, {
        type: 'typing:update',
        channelId: frame.channelId,
        userId: session.userId,
        isTyping: frame.type === 'typing:start',
        expiresAt: Date.now() + 4_500,
      });
      return;
    }

    // Recipient Delivery & Read Receipt Acknowledgments
    if (frame.type === 'message:ack_delivered') {
      this.cluster.acknowledgeDelivery({
        recipientId: session.userId,
        channelId: frame.channelId,
        messageId: frame.messageId,
      });
      return;
    }

    if (frame.type === 'message:mark_read') {
      this.cluster.markChannelRead({
        readerId: session.userId,
        channelId: frame.channelId,
        upToMessageId: frame.upToMessageId,
      });
      return;
    }

    // Enforce Token-Bucket Rate Limit (max 5 msgs/sec per socket) on mutating message frames
    if (
      frame.type === 'message:send' ||
      frame.type === 'message:edit' ||
      frame.type === 'message:delete'
    ) {
      const rateCheck = this.rateLimiter.consume(session.socketId, 1);
      if (!rateCheck.allowed) {
        this.safeSend(session.ws, {
          type: 'error',
          code: 'RATE_LIMITED',
          message: `Rate limit exceeded (max 5 msgs/sec). Retry in ${rateCheck.retryAfterMs}ms.`,
          retryAfterMs: rateCheck.retryAfterMs,
          clientMsgId: frame.type === 'message:send' ? frame.clientMsgId : undefined,
        });
        return;
      }
    }

    try {
      if (frame.type === 'message:send') {
        // Guard against raw base64 media smuggling over WebSockets
        if (
          frame.mediaUrl &&
          frame.mediaUrl.startsWith('data:') &&
          frame.mediaUrl.length > 1024
        ) {
          this.safeSend(session.ws, {
            type: 'error',
            code: 'VALIDATION_ERROR',
            message:
              'Media binaries are prohibited on WebSocket frames. Upload via presigned HTTP PUT first.',
            clientMsgId: frame.clientMsgId,
          });
          return;
        }

        const { message, deduplicated } = await this.cluster.processIncomingMessage({
          senderId: session.userId,
          channelId: frame.channelId,
          clientMsgId: frame.clientMsgId,
          content: frame.content,
          mediaUrl: frame.mediaUrl,
          thumbnailUrl: frame.thumbnailUrl,
          mediaMeta: frame.mediaMeta,
        });

        this.cluster.upsertDeviceSession(
          session.userId,
          session.deviceId,
          message.messageId,
          session.gatewayServerId
        );

        // Respond immediately with authoritative Server Ack
        this.safeSend(session.ws, {
          type: 'message:server_ack',
          clientMsgId: frame.clientMsgId,
          channelId: message.channelId,
          messageId: message.messageId,
          channelSeq: message.channelSeq,
          createdAt: message.createdAt,
          deduplicated,
          message,
        });
        return;
      }

      if (frame.type === 'message:edit') {
        this.cluster.editMessage({
          userId: session.userId,
          channelId: frame.channelId,
          messageId: frame.messageId,
          content: frame.content,
        });
        return;
      }

      if (frame.type === 'message:delete') {
        this.cluster.deleteMessage({
          userId: session.userId,
          channelId: frame.channelId,
          messageId: frame.messageId,
        });
        return;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Internal pipeline error';
      const isCircuit = msg.startsWith('CIRCUIT_OPEN');
      const isForbidden = msg.startsWith('FORBIDDEN');
      this.safeSend(session.ws, {
        type: 'error',
        code: isCircuit
          ? 'CIRCUIT_OPEN'
          : isForbidden
          ? 'FORBIDDEN'
          : 'VALIDATION_ERROR',
        message: msg.replace(/^[A-Z_]+:\s*/, ''),
        clientMsgId: frame.type === 'message:send' ? frame.clientMsgId : undefined,
      });
    }
  }

  private deliverPubSubFrame(
    gatewayServerId: string,
    targetUserIds: string[],
    frame: WsServerFrame
  ): void {
    const pool = this.nodePools.get(gatewayServerId);
    if (!pool) return;

    for (const uid of targetUserIds) {
      const sessions = pool.get(uid);
      if (!sessions) continue;
      for (const s of sessions) {
        this.safeSend(s.ws, frame);
      }
    }
  }

  private broadcastPresenceUpdate(presence: ReturnType<DistributedStorageCluster['presenceRegistry']['getPresence']>): void {
    const allUserIds = Array.from(this.cluster.users.keys());
    this.cluster.broadcastToUsers(allUserIds, {
      type: 'presence:update',
      presence,
    });
  }

  private startHeartbeatSweep(): void {
    // RFC 6455 Ping/Pong every 30s
    this.heartbeatTimer = setInterval(() => {
      for (const session of this.allSockets.values()) {
        if (!session.isAlive) {
          session.ws.terminate();
          this.cleanupSocket(session);
          continue;
        }
        session.isAlive = false;
        try {
          session.ws.ping();
        } catch {
          this.cleanupSocket(session);
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private cleanupSocket(session: ManagedSocketSession): void {
    if (!this.allSockets.has(session.socketId)) return;
    this.allSockets.delete(session.socketId);
    this.rateLimiter.delete(session.socketId);

    const pool = this.nodePools.get(session.gatewayServerId);
    if (pool) {
      const userSet = pool.get(session.userId);
      if (userSet) {
        userSet.delete(session);
        if (userSet.size === 0) {
          pool.delete(session.userId);
        }
      }
    }

    const updatedPresence = this.cluster.presenceRegistry.unregisterConnection(
      session.userId,
      session.gatewayServerId,
      session.socketId
    );
    this.broadcastPresenceUpdate(updatedPresence);
  }

  private safeSend(ws: WebSocket, frame: WsServerFrame): void {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(frame));
      } catch {
        // Ignore transient write errors on closing sockets
      }
    }
  }
}
