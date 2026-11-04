import express, { Request, Response, NextFunction } from 'express';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { storageCluster } from './src/server/storageEngine';
import { GatewayConnectionManager } from './src/server/gatewayService';
import {
  JwtClaims,
  signJwt,
  signPresignedUploadUrl,
  verifyJwt,
  verifyPresignedUploadUrl,
} from './src/server/jwtAuth';
import {
  ChannelType,
  ClusterDiagnosticsSnapshot,
  PresignedUploadResponse,
  SyncResponsePayload,
} from './src/shared/types';
import { TokenBucketRateLimiter } from './src/shared/distributedCore';
import { isOriginAllowed } from './src/shared/deploymentUtils';
import { redisBridge } from './src/server/redisAdapter';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface AuthenticatedRequest extends Request {
  claims?: JwtClaims;
}

function requireJwt(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing Authorization Bearer JWT' });
    return;
  }
  const token = authHeader.slice('Bearer '.length).trim();
  const claims = verifyJwt(token);
  if (!claims || !storageCluster.users.has(claims.sub)) {
    res.status(401).json({ error: 'Invalid or expired JWT' });
    return;
  }
  req.claims = claims;
  next();
}

async function bootstrapServer() {
  const app = express();
  app.set('trust proxy', 1); // Required behind Render's TLS-terminating load balancer
  const httpServer = createServer(app);
  const gatewayManager = new GatewayConnectionManager(httpServer, storageCluster);
  const diagnosticBucketLimiter = new TokenBucketRateLimiter(5, 5);

  // Split-Deployment CORS Middleware (Vercel Frontend -> Render Backend REST & Presigned PUT)
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    const allowedCsv = process.env.CORS_ALLOWED_ORIGINS;

    if (origin && isOriginAllowed(origin, allowedCsv)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept');
      res.setHeader('Access-Control-Max-Age', '86400');
    } else if (!allowedCsv || allowedCsv.trim() === '*') {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }

    if (req.method === 'OPTIONS') {
      if (origin && !isOriginAllowed(origin, allowedCsv)) {
        res.status(403).json({ error: 'CORS origin denied' });
        return;
      }
      res.status(204).end();
      return;
    }

    next();
  });

  // Render Zero-Downtime Load Balancer Health Check
  app.get('/healthz', (_req: Request, res: Response) => {
    const gwStats = gatewayManager.getGatewayStats();
    const totalSockets = gwStats.reduce((sum, g) => sum + g.activeSockets, 0);
    res.status(200).json({
      status: 'ok',
      service: 'pulsewire-gateway',
      uptimeSec: Math.round(process.uptime()),
      activeWebSockets: totalSockets,
      redis: redisBridge.getHealth(),
    });
  });

  // Parse JSON for standard API endpoints (keep media PUT raw binary separate)
  app.use('/api/v1/media/upload', express.raw({ type: '*/*', limit: '10mb' }));
  app.use(express.json({ limit: '256kb' }));

  // 1. Auth & Initial Device Handshake
  app.post('/api/v1/auth/session', (req: Request, res: Response) => {
    try {
      const requestedUserId =
        typeof req.body?.userId === 'string' ? req.body.userId : 'u-elena';
      const deviceId =
        typeof req.body?.deviceId === 'string' && req.body.deviceId.trim()
          ? req.body.deviceId.trim().slice(0, 64)
          : `dev-${randomUUID().slice(0, 8)}`;

      const user = storageCluster.users.get(requestedUserId);
      if (!user) {
        res.status(404).json({ error: 'Requested persona profile does not exist' });
        return;
      }

      const session = storageCluster.upsertDeviceSession(user.id, deviceId);
      const token = signJwt({
        sub: user.id,
        deviceId,
        username: user.username,
      });

      res.json({
        token,
        user,
        deviceSession: session,
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to issue session handshake',
      });
    }
  });

  // 2. Workspace Bootstrap (Users, Subscribed Channels, Presence, Initial Messages)
  app.get('/api/v1/bootstrap', requireJwt, (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.claims!.sub;
      const users = Array.from(storageCluster.users.values());
      const channels = Array.from(storageCluster.channels.values()).filter((ch) =>
        ch.memberIds.includes(userId)
      );

      const presences = users.map((u) =>
        storageCluster.presenceRegistry.getPresence(u.id, u.createdAt)
      );

      const messagesByChannel: Record<string, ReturnType<typeof storageCluster.getChannelMessages>> = {};
      for (const ch of channels) {
        messagesByChannel[ch.id] = storageCluster.getChannelMessages(ch.id, undefined, 50);
      }

      const curMaxMessageId = storageCluster.getGlobalMaxMessageIdForUser(userId);

      res.json({
        currentUser: storageCluster.users.get(userId),
        users,
        channels,
        presences,
        messagesByChannel,
        curMaxMessageId,
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Bootstrap failed',
      });
    }
  });

  // 3. Create Direct or Scalable Group Channel
  app.post('/api/v1/channels', requireJwt, (req: AuthenticatedRequest, res: Response) => {
    try {
      const creatorId = req.claims!.sub;
      const { name, description, type, memberIds, simulatedLargeGroupCount } = req.body ?? {};

      const channelType =
        type === ChannelType.DIRECT ? ChannelType.DIRECT : ChannelType.GROUP;
      const safeMemberIds = Array.isArray(memberIds)
        ? memberIds.filter((id): id is string => typeof id === 'string' && storageCluster.users.has(id))
        : [];

      const created = storageCluster.createChannel({
        creatorId,
        name: typeof name === 'string' ? name : '',
        description: typeof description === 'string' ? description : '',
        type: channelType,
        memberIds: safeMemberIds,
        simulatedLargeGroupCount:
          typeof simulatedLargeGroupCount === 'number' ? simulatedLargeGroupCount : undefined,
      });

      res.status(201).json({ channel: created });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to create channel';
      res.status(400).json({ error: message.replace(/^[A-Z_]+:\s*/, '') });
    }
  });

  // 4. Paginated Wide-Column Slice Fetch
  app.get(
    '/api/v1/channels/:channelId/messages',
    requireJwt,
    (req: AuthenticatedRequest, res: Response) => {
      const { channelId } = req.params;
      const channel = storageCluster.channels.get(channelId);
      if (!channel || !channel.memberIds.includes(req.claims!.sub)) {
        res.status(403).json({ error: 'Channel access denied' });
        return;
      }
      const before = typeof req.query.before === 'string' ? req.query.before : undefined;
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
      const messages = storageCluster.getChannelMessages(channelId, before, limit);
      res.json({ channelId, messages });
    }
  );

  // 5. Multi-Device Cursor Catch-Up Sync: GET /api/v1/sync?cursor=<last_id>
  app.get('/api/v1/sync', requireJwt, (req: AuthenticatedRequest, res: Response) => {
    try {
      const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : '0';
      const deviceId =
        typeof req.query.deviceId === 'string' ? req.query.deviceId : req.claims!.deviceId;

      const result = storageCluster.syncMessagesAfterCursor({
        userId: req.claims!.sub,
        deviceId,
        cursor,
      });

      const payload: SyncResponsePayload = {
        cursor,
        newMaxMessageId: result.newMaxMessageId,
        messages: result.messages,
        flushedStreamCount: result.flushedStreamCount,
        syncedAt: new Date().toISOString(),
      };
      res.json(payload);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Sync reconciliation failed',
      });
    }
  });

  // 6. Media Processing Engine: Issue Presigned S3/MinIO HTTP PUT URL
  app.post('/api/v1/media/presign', requireJwt, (req: AuthenticatedRequest, res: Response) => {
    const fileName =
      typeof req.body?.fileName === 'string' && req.body.fileName.trim()
        ? req.body.fileName.trim().slice(0, 120)
        : 'attachment.bin';
    const mimeType =
      typeof req.body?.mimeType === 'string' && req.body.mimeType.trim()
        ? req.body.mimeType.trim().slice(0, 80)
        : 'application/octet-stream';
    const sizeBytes = Number(req.body?.sizeBytes) || 0;

    if (sizeBytes <= 0 || sizeBytes > 10 * 1024 * 1024) {
      res.status(400).json({ error: 'Media size must be between 1B and 10MB' });
      return;
    }

    const ext = path.extname(fileName).replace(/[^a-zA-Z0-9.]/g, '').slice(0, 10) || '.bin';
    const objectKey = `${Date.now()}-${randomUUID().slice(0, 12)}${ext}`;
    const expiresAt = Date.now() + 5 * 60_000; // 5-minute presigned TTL
    const signature = signPresignedUploadUrl(objectKey, mimeType, expiresAt);

    const uploadUrl = `/api/v1/media/upload/${encodeURIComponent(
      objectKey
    )}?expires=${expiresAt}&signature=${signature}&fileName=${encodeURIComponent(
      fileName
    )}&mimeType=${encodeURIComponent(mimeType)}`;

    const response: PresignedUploadResponse = {
      objectKey,
      uploadUrl,
      publicMediaUrl: `/api/v1/media/files/${encodeURIComponent(objectKey)}`,
      thumbnailUrl: `/api/v1/media/thumbnails/${encodeURIComponent(objectKey)}`,
      expiresAt,
      requiredHeaders: {
        'Content-Type': mimeType,
      },
    };
    res.json(response);
  });

  // 7. Direct Object Storage HTTP PUT Receiver (Strictly separated from WebSockets)
  app.put(
    '/api/v1/media/upload/:objectKey',
    requireJwt,
    (req: AuthenticatedRequest, res: Response) => {
      const { objectKey } = req.params;
      const expiresAt = Number(req.query.expires) || 0;
      const signature = typeof req.query.signature === 'string' ? req.query.signature : '';
      const mimeType =
        typeof req.query.mimeType === 'string'
          ? req.query.mimeType
          : req.headers['content-type'] || 'application/octet-stream';
      const fileName =
        typeof req.query.fileName === 'string' ? req.query.fileName : objectKey;

      if (!verifyPresignedUploadUrl(objectKey, mimeType, expiresAt, signature)) {
        res.status(403).json({ error: 'Invalid or expired presigned upload URL signature' });
        return;
      }

      const bodyBuffer = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(typeof req.body === 'string' ? req.body : '');

      if (bodyBuffer.byteLength === 0) {
        res.status(400).json({ error: 'Empty media PUT payload' });
        return;
      }

      const stored = storageCluster.putMediaObject({
        objectKey,
        mimeType,
        fileName,
        data: bodyBuffer,
        uploadedBy: req.claims!.sub,
      });

      res.status(200).json({
        objectKey: stored.objectKey,
        sizeBytes: stored.data.byteLength,
        mediaUrl: `/api/v1/media/files/${encodeURIComponent(objectKey)}`,
        thumbnailUrl: `/api/v1/media/thumbnails/${encodeURIComponent(objectKey)}`,
      });
    }
  );

  // 8. Object Storage Public Media & Async Thumbnail Delivery
  app.get('/api/v1/media/files/:objectKey', (req: Request, res: Response) => {
    const obj = storageCluster.getMediaObject(req.params.objectKey);
    if (!obj) {
      res.status(404).json({ error: 'Media object not found' });
      return;
    }
    res.setHeader('Content-Type', obj.mimeType);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(obj.data);
  });

  app.get('/api/v1/media/thumbnails/:objectKey', (req: Request, res: Response) => {
    const obj = storageCluster.getMediaObject(req.params.objectKey);
    if (!obj) {
      res.status(404).json({ error: 'Thumbnail not found' });
      return;
    }
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(obj.thumbnailSvg);
  });

  // 9. Architecture Fault-Tolerance & Cluster Verification Endpoints
  app.get('/api/v1/diagnostics/cluster', requireJwt, (_req: AuthenticatedRequest, res: Response) => {
    const snapshot: ClusterDiagnosticsSnapshot = {
      gatewayNodes: gatewayManager.getGatewayStats(),
      idempotencyCacheSize: storageCluster.idempotencyStore.size(),
      unackedStreamDepth: storageCluster.getUnackedStreamDepth(),
      circuitBreakerState: storageCluster.getCircuitState(),
      pushDispatches: storageCluster.getPushAlerts(10),
    };
    res.json(snapshot);
  });

  app.post(
    '/api/v1/diagnostics/verify-idempotency',
    requireJwt,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const channelId =
          typeof req.body?.channelId === 'string' ? req.body.channelId : 'ch-core-arch';
        const clientMsgId =
          typeof req.body?.clientMsgId === 'string' && req.body.clientMsgId
            ? req.body.clientMsgId
            : `idem-probe-${randomUUID().slice(0, 8)}`;

        const firstAttempt = await storageCluster.processIncomingMessage({
          senderId: req.claims!.sub,
          channelId,
          clientMsgId,
          content: `[Idempotency Verification] Probe client_msg_id=${clientMsgId}`,
        });

        // Immediately replay exact same client_msg_id to prove zero duplicate persistence
        const secondAttempt = await storageCluster.processIncomingMessage({
          senderId: req.claims!.sub,
          channelId,
          clientMsgId,
          content: `[Idempotency Verification] Probe client_msg_id=${clientMsgId}`,
        });

        res.json({
          clientMsgId,
          firstAttempt: {
            messageId: firstAttempt.message.messageId,
            channelSeq: firstAttempt.message.channelSeq,
            deduplicated: firstAttempt.deduplicated,
          },
          secondAttempt: {
            messageId: secondAttempt.message.messageId,
            channelSeq: secondAttempt.message.channelSeq,
            deduplicated: secondAttempt.deduplicated,
          },
          identicalSnowflakeGuaranteed:
            firstAttempt.message.messageId === secondAttempt.message.messageId,
        });
      } catch (err) {
        res.status(400).json({
          error: err instanceof Error ? err.message : 'Idempotency probe failed',
        });
      }
    }
  );

  app.post(
    '/api/v1/diagnostics/verify-rate-limit',
    requireJwt,
    (req: AuthenticatedRequest, res: Response) => {
      const probeKey = `probe-${req.claims!.sub}-${Date.now()}`;
      const results = Array.from({ length: 7 }, (_, i) => {
        const outcome = diagnosticBucketLimiter.consume(probeKey, 1);
        return {
          frameNumber: i + 1,
          allowed: outcome.allowed,
          remainingTokens: outcome.remainingTokens,
          retryAfterMs: outcome.retryAfterMs,
        };
      });
      diagnosticBucketLimiter.delete(probeKey);
      res.json({ capacityPerSec: 5, burstSent: 7, results });
    }
  );

  // Vite middleware in dev; static SPA serving in full-stack mode; pure API/WS mode on Render when SERVE_STATIC_SPA=false
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const hmrDisabled = process.env.DISABLE_HMR === 'true';
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        allowedHosts: true,
        hmr: !hmrDisabled,
        watch: hmrDisabled ? null : {},
        ws: {
          server: httpServer,
        },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else if (process.env.SERVE_STATIC_SPA !== 'false') {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    app.get('/', (_req, res) => {
      res.json({
        service: 'pulsewire-gateway',
        mode: 'api-and-websocket-gateway',
        healthEndpoint: '/healthz',
        wsEndpoint: '/ws',
      });
    });
  }

  const PORT = Number(process.env.PORT) || 3000;
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`PulseWire Gateway & REST Server listening on http://0.0.0.0:${PORT}`);
  });

  const gracefulShutdown = () => {
    gatewayManager.shutdown();
    void redisBridge.shutdown();
    httpServer.close();
  };
  process.on('SIGTERM', gracefulShutdown);
  process.on('SIGINT', gracefulShutdown);
}

bootstrapServer().catch((err) => {
  console.error('Fatal startup failure in PulseWire server:', err);
  process.exit(1);
});
