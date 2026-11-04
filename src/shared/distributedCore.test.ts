import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SnowflakeGenerator,
  TokenBucketRateLimiter,
  CircuitBreaker,
  IdempotencyStore,
  PresenceRegistry,
  chunkFanoutRecipients,
  computeBackoffWithFullJitter,
  mergeAndDeduplicateMessages,
  advanceSyncCursor,
  compareSnowflakeIds,
} from './distributedCore';
import {
  ChatMessage,
  CircuitState,
  MessageLifecycleState,
  PresenceState,
} from './types';
import {
  isOriginAllowed,
  resolveApiUrl,
  resolveWsEndpoint,
} from './deploymentUtils';

test('SnowflakeGenerator assigns strictly monotonic 64-bit IDs even under clock drift or sub-ms bursts', () => {
  let now = 1762248000000;
  const gen = new SnowflakeGenerator(2, 7, () => now);

  const id1 = gen.nextId();
  const id2 = gen.nextId(); // Same millisecond burst
  now -= 15; // Simulate NTP backward clock jump
  const id3 = gen.nextId();

  assert.equal(compareSnowflakeIds(id1, id2), -1);
  assert.equal(compareSnowflakeIds(id2, id3), -1);
});

test('TokenBucketRateLimiter enforces 5 msgs/sec burst limit and refills accurately', () => {
  let now = 1_000_000;
  const limiter = new TokenBucketRateLimiter(5, 5, () => now);

  for (let i = 0; i < 5; i++) {
    const res = limiter.consume('sock-1');
    assert.equal(res.allowed, true);
  }

  // 6th message within same millisecond must be rate-limited
  const blocked = limiter.consume('sock-1');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterMs, 200);

  // Advance 200ms -> 1 token refilled
  now += 200;
  const afterRefill = limiter.consume('sock-1');
  assert.equal(afterRefill.allowed, true);
});

test('CircuitBreaker opens after threshold failures and recovers via HALF_OPEN probe', async () => {
  let now = 5_000;
  const breaker = new CircuitBreaker(3, 10_000, () => now);
  assert.equal(breaker.getState(), CircuitState.CLOSED);

  for (let i = 0; i < 3; i++) {
    await assert.rejects(() =>
      breaker.execute(() => {
        throw new Error('Scylla write timeout');
      })
    );
  }

  assert.equal(breaker.getState(), CircuitState.OPEN);
  await assert.rejects(
    () => breaker.execute(() => 'ok'),
    /CIRCUIT_OPEN/
  );

  // Advance past reset timeout -> HALF_OPEN -> successful probe closes circuit
  now += 10_001;
  assert.equal(breaker.getState(), CircuitState.HALF_OPEN);
  const probeResult = await breaker.execute(() => 'recovered');
  assert.equal(probeResult, 'recovered');
  assert.equal(breaker.getState(), CircuitState.CLOSED);
});

test('IdempotencyStore deduplicates client_msg_id for 24 hours and expires cleanly', () => {
  let now = 100_000;
  const ttl24h = 24 * 60 * 60 * 1000;
  const store = new IdempotencyStore<{ messageId: string }>(ttl24h, () => now);

  const first = store.setNx('cmsg-abc', { messageId: '9001' });
  assert.equal(first.inserted, true);
  assert.equal(first.record.messageId, '9001');

  // Duplicate retry 10 seconds later returns original server record without re-inserting
  now += 10_000;
  const duplicate = store.setNx('cmsg-abc', { messageId: '9999' });
  assert.equal(duplicate.inserted, false);
  assert.equal(duplicate.record.messageId, '9001');

  // After 24h expiration, key is evicted
  now += ttl24h;
  assert.equal(store.get('cmsg-abc'), null);
});

test('PresenceRegistry tracks multi-gateway sockets and transitions offline after 60s heartbeat TTL', () => {
  let now = 200_000;
  const registry = new PresenceRegistry(60_000, () => now);

  registry.registerConnection('u-elena', 'gw-01', 's1');
  registry.registerConnection('u-elena', 'gw-02', 's2');
  assert.deepEqual(registry.getGatewaysForUser('u-elena'), ['gw-01', 'gw-02']);
  assert.equal(registry.getPresence('u-elena').status, PresenceState.ONLINE);

  // Disconnect gw-01; user remains online via gw-02
  registry.unregisterConnection('u-elena', 'gw-01', 's1');
  assert.deepEqual(registry.getGatewaysForUser('u-elena'), ['gw-02']);

  // Advance 61s without heartbeat -> TTL expires -> OFFLINE
  now += 61_000;
  assert.equal(registry.getPresence('u-elena').status, PresenceState.OFFLINE);
  assert.deepEqual(registry.getGatewaysForUser('u-elena'), []);
});

test('Client reconciler deduplicates optimistic Pending message against Server Ack and advances cursor', () => {
  const optimistic: ChatMessage = {
    channelId: 'ch-1',
    messageId: 'temp-1',
    channelSeq: 0,
    senderId: 'u-elena',
    clientMsgId: 'client-uuid-1',
    content: 'Deploying gateway shard 4',
    mediaUrl: null,
    thumbnailUrl: null,
    mediaMeta: null,
    createdAt: '2026-11-04T12:00:00.000Z',
    updatedAt: null,
    isEdited: false,
    isDeleted: false,
    lifecycleState: MessageLifecycleState.PENDING,
    deliveredTo: [],
    readBy: [],
  };

  const serverAcked: ChatMessage = {
    ...optimistic,
    messageId: '245109283719200768',
    channelSeq: 42,
    lifecycleState: MessageLifecycleState.DELIVERED,
    deliveredTo: ['u-marcus'],
  };

  const merged = mergeAndDeduplicateMessages([optimistic], [serverAcked]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].messageId, '245109283719200768');
  assert.equal(merged[0].lifecycleState, MessageLifecycleState.DELIVERED);
  assert.equal(advanceSyncCursor('0', merged), '245109283719200768');
});

test('Fanout worker chunking and exponential backoff with jitter stay within bounds', () => {
  const members = Array.from({ length: 1250 }, (_, idx) => `u-${idx}`);
  const batches = chunkFanoutRecipients(members, 500);
  assert.equal(batches.length, 3);
  assert.equal(batches[0].length, 500);
  assert.equal(batches[2].length, 250);

  const delay = computeBackoffWithFullJitter(3, 500, 30_000, () => 0.5);
  assert.equal(delay, 2000); // 500 * 2^3 * 0.5 = 2000ms
});

test('Split-deployment URL resolvers handle Vercel -> Render HTTPS/WSS and local same-origin fallback', () => {
  assert.equal(
    resolveApiUrl('/api/v1/bootstrap', 'https://pulsewire-gateway.onrender.com/'),
    'https://pulsewire-gateway.onrender.com/api/v1/bootstrap'
  );
  assert.equal(resolveApiUrl('/api/v1/bootstrap', ''), '/api/v1/bootstrap');

  assert.equal(
    resolveWsEndpoint('jwt-123', {
      envWsUrl: 'wss://pulsewire-gateway.onrender.com/ws',
      envApiBase: '',
      locationProtocol: 'https:',
      locationHost: 'pulsewire.vercel.app',
    }),
    'wss://pulsewire-gateway.onrender.com/ws?token=jwt-123'
  );

  // Derives wss:// automatically from VITE_API_BASE_URL when VITE_WS_URL is omitted
  assert.equal(
    resolveWsEndpoint('jwt-123', {
      envWsUrl: '',
      envApiBase: 'https://pulsewire-gateway.onrender.com/',
      locationProtocol: 'https:',
      locationHost: 'pulsewire.vercel.app',
    }),
    'wss://pulsewire-gateway.onrender.com/ws?token=jwt-123'
  );
});

test('CORS and WebSocket Upgrade origin allowlist validates exact and wildcard Vercel preview domains', () => {
  const allowed = 'https://pulsewire.vercel.app, https://*.vercel.app, http://localhost:5173';
  assert.equal(isOriginAllowed('https://pulsewire.vercel.app', allowed), true);
  assert.equal(isOriginAllowed('https://pulsewire-git-main-team.vercel.app', allowed), true);
  assert.equal(isOriginAllowed('https://malicious-site.example.com', allowed), false);
  assert.equal(isOriginAllowed('https://pulsewire.vercel.app.attacker.com', allowed), false);
  assert.equal(isOriginAllowed(undefined, allowed), true); // Render /healthz non-browser probe
});
