import Redis from 'ioredis';
import { WsServerFrame } from '../shared/types';

export interface RedisHealthStatus {
  configured: boolean;
  connected: boolean;
  mode: 'render-redis' | 'in-memory-local';
}

/**
 * Optional Redis Pub/Sub & Key-Value bridge activated automatically when REDIS_URL is set (e.g. Render Key Value).
 * Gracefully falls back to in-process memory routing when REDIS_URL is unset in local dev.
 */
export class RedisClusterBridge {
  private pubClient: Redis | null = null;
  private subClient: Redis | null = null;
  private isConnected = false;
  private readonly localHandlers = new Map<
    string,
    (targetUserIds: string[], frame: WsServerFrame) => void
  >();

  constructor(redisUrl = process.env.REDIS_URL) {
    const cleanUrl = redisUrl?.trim();
    if (!cleanUrl) {
      return;
    }

    try {
      this.pubClient = new Redis(cleanUrl, {
        maxRetriesPerRequest: 2,
        enableReadyCheck: true,
        lazyConnect: false,
      });

      this.subClient = new Redis(cleanUrl, {
        maxRetriesPerRequest: 2,
        enableReadyCheck: true,
        lazyConnect: false,
      });

      this.pubClient.on('ready', () => {
        this.isConnected = true;
      });
      this.pubClient.on('error', (err) => {
        this.isConnected = false;
        console.error('[RedisBridge] Publisher client warning:', err.message);
      });
      this.subClient.on('error', (err) => {
        console.error('[RedisBridge] Subscriber client warning:', err.message);
      });

      this.subClient.on('message', (channel: string, rawMessage: string) => {
        if (!channel.startsWith('gateway:')) return;
        const gwId = channel.slice('gateway:'.length);
        const handler = this.localHandlers.get(gwId);
        if (!handler) return;
        try {
          const parsed = JSON.parse(rawMessage) as {
            targetUserIds: string[];
            frame: WsServerFrame;
          };
          handler(parsed.targetUserIds, parsed.frame);
        } catch {
          // Ignore malformed envelopes
        }
      });
    } catch (err) {
      console.error('[RedisBridge] Initialization fallback to local memory:', err);
      this.pubClient = null;
      this.subClient = null;
    }
  }

  public async registerGatewayHandler(
    gatewayServerId: string,
    handler: (targetUserIds: string[], frame: WsServerFrame) => void
  ): Promise<void> {
    this.localHandlers.set(gatewayServerId, handler);
    if (this.subClient) {
      try {
        await this.subClient.subscribe(`gateway:${gatewayServerId}`);
      } catch {
        // Handled by local fallback if Redis is unreachable
      }
    }
  }

  public publishGatewayEnvelope(
    gatewayServerId: string,
    targetUserIds: string[],
    frame: WsServerFrame
  ): boolean {
    if (this.pubClient && this.isConnected) {
      this.pubClient
        .publish(
          `gateway:${gatewayServerId}`,
          JSON.stringify({ targetUserIds, frame })
        )
        .catch(() => undefined);
      return true;
    }
    return false;
  }

  public mirrorPresenceHeartbeat(
    userId: string,
    gatewayServerId: string,
    ttlSeconds = 60
  ): void {
    if (!this.pubClient || !this.isConnected) return;
    const gwKey = `{user:${userId}}:gateways`;
    const presKey = `{user:${userId}}:presence`;
    this.pubClient
      .pipeline()
      .sadd(gwKey, gatewayServerId)
      .expire(gwKey, ttlSeconds)
      .hset(presKey, 'status', 'online', 'last_seen', Date.now().toString())
      .expire(presKey, ttlSeconds)
      .exec()
      .catch(() => undefined);
  }

  public getHealth(): RedisHealthStatus {
    return {
      configured: Boolean(this.pubClient),
      connected: this.isConnected,
      mode: this.pubClient ? 'render-redis' : 'in-memory-local',
    };
  }

  public async shutdown(): Promise<void> {
    if (this.subClient) {
      await this.subClient.quit().catch(() => undefined);
    }
    if (this.pubClient) {
      await this.pubClient.quit().catch(() => undefined);
    }
  }
}

export const redisBridge = new RedisClusterBridge();
