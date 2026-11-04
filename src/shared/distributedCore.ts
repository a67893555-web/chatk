import {
  ChatMessage,
  CircuitState,
  MessageLifecycleState,
  PresenceSnapshot,
  PresenceState,
} from './types';

/**
 * Custom Epoch: 2025-01-01T00:00:00.000Z
 * 64-bit Snowflake Layout:
 * [1 bit unused][41 bits timestamp ms][5 bits datacenter][5 bits worker][12 bits sequence]
 */
const PULSEWIRE_EPOCH = 1735689600000n;
const WORKER_ID_BITS = 5n;
const DATACENTER_ID_BITS = 5n;
const SEQUENCE_BITS = 12n;

const MAX_WORKER_ID = (1n << WORKER_ID_BITS) - 1n;
const MAX_DATACENTER_ID = (1n << DATACENTER_ID_BITS) - 1n;
const SEQUENCE_MASK = (1n << SEQUENCE_BITS) - 1n;

const WORKER_ID_SHIFT = SEQUENCE_BITS;
const DATACENTER_ID_SHIFT = SEQUENCE_BITS + WORKER_ID_BITS;
const TIMESTAMP_SHIFT = SEQUENCE_BITS + WORKER_ID_BITS + DATACENTER_ID_BITS;

export class SnowflakeGenerator {
  private readonly datacenterId: bigint;
  private readonly workerId: bigint;
  private sequence = 0n;
  private lastTimestamp = -1n;
  private readonly clockFn: () => number;

  constructor(
    datacenterId = 1,
    workerId = 1,
    clockFn: () => number = () => Date.now()
  ) {
    const dc = BigInt(datacenterId);
    const wk = BigInt(workerId);
    if (dc < 0n || dc > MAX_DATACENTER_ID) {
      throw new RangeError(`datacenterId must be between 0 and ${MAX_DATACENTER_ID}`);
    }
    if (wk < 0n || wk > MAX_WORKER_ID) {
      throw new RangeError(`workerId must be between 0 and ${MAX_WORKER_ID}`);
    }
    this.datacenterId = dc;
    this.workerId = wk;
    this.clockFn = clockFn;
  }

  public nextId(): string {
    let timestamp = BigInt(this.clockFn());

    // Guard against NTP backward clock drift: clamp to lastTimestamp to preserve monotonicity
    if (timestamp < this.lastTimestamp) {
      timestamp = this.lastTimestamp;
    }

    if (timestamp === this.lastTimestamp) {
      this.sequence = (this.sequence + 1n) & SEQUENCE_MASK;
      if (this.sequence === 0n) {
        // Sequence exhausted within same millisecond: advance logical millisecond
        timestamp = this.lastTimestamp + 1n;
      }
    } else {
      this.sequence = 0n;
    }

    this.lastTimestamp = timestamp;

    const id =
      ((timestamp - PULSEWIRE_EPOCH) << TIMESTAMP_SHIFT) |
      (this.datacenterId << DATACENTER_ID_SHIFT) |
      (this.workerId << WORKER_ID_SHIFT) |
      this.sequence;

    return id.toString(10);
  }
}

export function compareSnowflakeIds(a: string, b: string): number {
  const cleanA = a.trim() || '0';
  const cleanB = b.trim() || '0';
  try {
    const bigA = BigInt(cleanA);
    const bigB = BigInt(cleanB);
    if (bigA === bigB) return 0;
    return bigA < bigB ? -1 : 1;
  } catch {
    return cleanA.localeCompare(cleanB);
  }
}

/**
 * Token-Bucket Rate Limiter per WebSocket connection (e.g., max 5 msgs/sec).
 */
export interface RateLimitResult {
  allowed: boolean;
  remainingTokens: number;
  retryAfterMs: number;
}

interface BucketEntry {
  tokens: number;
  lastRefillMs: number;
}

export class TokenBucketRateLimiter {
  private readonly buckets = new Map<string, BucketEntry>();
  private readonly capacity: number;
  private readonly refillRatePerMs: number;
  private readonly clockFn: () => number;

  constructor(
    capacity = 5,
    refillPerSecond = 5,
    clockFn: () => number = () => Date.now()
  ) {
    if (capacity <= 0 || refillPerSecond <= 0) {
      throw new RangeError('TokenBucket capacity and refillPerSecond must be > 0');
    }
    this.capacity = capacity;
    this.refillRatePerMs = refillPerSecond / 1000;
    this.clockFn = clockFn;
  }

  public consume(socketKey: string, cost = 1): RateLimitResult {
    const now = this.clockFn();
    let bucket = this.buckets.get(socketKey);

    if (!bucket) {
      bucket = { tokens: this.capacity, lastRefillMs: now };
      this.buckets.set(socketKey, bucket);
    } else {
      const elapsedMs = Math.max(0, now - bucket.lastRefillMs);
      const refilled = elapsedMs * this.refillRatePerMs;
      bucket.tokens = Math.min(this.capacity, bucket.tokens + refilled);
      bucket.lastRefillMs = now;
    }

    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      return {
        allowed: true,
        remainingTokens: Math.floor(bucket.tokens * 100) / 100,
        retryAfterMs: 0,
      };
    }

    const deficit = cost - bucket.tokens;
    const retryAfterMs = Math.ceil(deficit / this.refillRatePerMs);
    return {
      allowed: false,
      remainingTokens: Math.floor(bucket.tokens * 100) / 100,
      retryAfterMs,
    };
  }

  public delete(socketKey: string): void {
    this.buckets.delete(socketKey);
  }
}

/**
 * 3-state Circuit Breaker guarding persistence / downstream cluster operations.
 */
export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private consecutiveFailures = 0;
  private openedAtMs = 0;
  private halfOpenInFlight = false;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly clockFn: () => number;

  constructor(
    failureThreshold = 5,
    resetTimeoutMs = 10_000,
    clockFn: () => number = () => Date.now()
  ) {
    this.failureThreshold = failureThreshold;
    this.resetTimeoutMs = resetTimeoutMs;
    this.clockFn = clockFn;
  }

  public getState(): CircuitState {
    if (
      this.state === CircuitState.OPEN &&
      this.clockFn() - this.openedAtMs >= this.resetTimeoutMs
    ) {
      this.state = CircuitState.HALF_OPEN;
      this.halfOpenInFlight = false;
    }
    return this.state;
  }

  public async execute<T>(operation: () => Promise<T> | T): Promise<T> {
    const current = this.getState();
    if (current === CircuitState.OPEN) {
      throw new Error('CIRCUIT_OPEN: Downstream storage cluster circuit is open');
    }
    if (current === CircuitState.HALF_OPEN && this.halfOpenInFlight) {
      throw new Error('CIRCUIT_OPEN: Half-open probe already in flight');
    }

    if (current === CircuitState.HALF_OPEN) {
      this.halfOpenInFlight = true;
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = CircuitState.CLOSED;
    this.halfOpenInFlight = false;
  }

  private onFailure(): void {
    this.consecutiveFailures += 1;
    this.halfOpenInFlight = false;
    if (
      this.state === CircuitState.HALF_OPEN ||
      this.consecutiveFailures >= this.failureThreshold
    ) {
      this.state = CircuitState.OPEN;
      this.openedAtMs = this.clockFn();
    }
  }
}

/**
 * Redis-modeled Idempotency Store:
 * Key: idempotency:<client_msg_id> with 24-hour TTL (86,400,000 ms).
 */
export class IdempotencyStore<T> {
  private readonly records = new Map<string, { value: T; expiresAtMs: number }>();
  private readonly ttlMs: number;
  private readonly clockFn: () => number;

  constructor(
    ttlMs = 24 * 60 * 60 * 1000,
    clockFn: () => number = () => Date.now()
  ) {
    this.ttlMs = ttlMs;
    this.clockFn = clockFn;
  }

  public get(clientMsgId: string): T | null {
    const key = `idempotency:${clientMsgId}`;
    const entry = this.records.get(key);
    if (!entry) return null;
    if (this.clockFn() >= entry.expiresAtMs) {
      this.records.delete(key);
      return null;
    }
    return entry.value;
  }

  public setNx(clientMsgId: string, value: T): { inserted: boolean; record: T } {
    const existing = this.get(clientMsgId);
    if (existing !== null) {
      return { inserted: false, record: existing };
    }
    const key = `idempotency:${clientMsgId}`;
    this.records.set(key, {
      value,
      expiresAtMs: this.clockFn() + this.ttlMs,
    });
    return { inserted: true, record: value };
  }

  public size(): number {
    this.pruneExpired();
    return this.records.size;
  }

  public pruneExpired(): void {
    const now = this.clockFn();
    for (const [k, v] of this.records.entries()) {
      if (now >= v.expiresAtMs) {
        this.records.delete(k);
      }
    }
  }
}

/**
 * Redis-modeled Presence & Connection Mapping Registry:
 * - user:<user_id>:gateways -> Set of gateway server IDs
 * - user:<user_id>:presence -> Online/Offline + lastSeen + 60s heartbeat TTL
 */
interface PresenceInternal {
  gateways: Map<string, Set<string>>; // gatewayServerId -> Set<socketId>
  expiresAtMs: number;
  lastSeenMs: number;
}

export class PresenceRegistry {
  private readonly users = new Map<string, PresenceInternal>();
  private readonly ttlMs: number;
  private readonly clockFn: () => number;

  constructor(ttlMs = 60_000, clockFn: () => number = () => Date.now()) {
    this.ttlMs = ttlMs;
    this.clockFn = clockFn;
  }

  public registerConnection(
    userId: string,
    gatewayServerId: string,
    socketId: string
  ): PresenceSnapshot {
    const now = this.clockFn();
    let entry = this.users.get(userId);
    if (!entry) {
      entry = {
        gateways: new Map(),
        expiresAtMs: now + this.ttlMs,
        lastSeenMs: now,
      };
      this.users.set(userId, entry);
    }
    let gwSet = entry.gateways.get(gatewayServerId);
    if (!gwSet) {
      gwSet = new Set();
      entry.gateways.set(gatewayServerId, gwSet);
    }
    gwSet.add(socketId);
    entry.expiresAtMs = now + this.ttlMs;
    entry.lastSeenMs = now;
    return this.getPresence(userId);
  }

  public heartbeat(userId: string): PresenceSnapshot {
    const now = this.clockFn();
    const entry = this.users.get(userId);
    if (entry && entry.gateways.size > 0) {
      entry.expiresAtMs = now + this.ttlMs;
      entry.lastSeenMs = now;
    }
    return this.getPresence(userId);
  }

  public unregisterConnection(
    userId: string,
    gatewayServerId: string,
    socketId: string
  ): PresenceSnapshot {
    const now = this.clockFn();
    const entry = this.users.get(userId);
    if (entry) {
      const gwSet = entry.gateways.get(gatewayServerId);
      if (gwSet) {
        gwSet.delete(socketId);
        if (gwSet.size === 0) {
          entry.gateways.delete(gatewayServerId);
        }
      }
      entry.lastSeenMs = now;
      if (entry.gateways.size === 0) {
        entry.expiresAtMs = now; // Immediately transition to offline with exact lastSeen
      }
    }
    return this.getPresence(userId);
  }

  public getGatewaysForUser(userId: string): string[] {
    const now = this.clockFn();
    const entry = this.users.get(userId);
    if (!entry || now >= entry.expiresAtMs || entry.gateways.size === 0) {
      return [];
    }
    return Array.from(entry.gateways.keys());
  }

  public getPresence(userId: string, fallbackLastSeenIso?: string): PresenceSnapshot {
    const now = this.clockFn();
    const entry = this.users.get(userId);
    if (!entry) {
      return {
        userId,
        status: PresenceState.OFFLINE,
        lastSeenAt: fallbackLastSeenIso ?? new Date(now - 15 * 60_000).toISOString(),
        activeGateways: [],
        ttlRemainingMs: 0,
      };
    }

    const activeGateways =
      now < entry.expiresAtMs && entry.gateways.size > 0
        ? Array.from(entry.gateways.keys())
        : [];
    const isOnline = activeGateways.length > 0;

    return {
      userId,
      status: isOnline ? PresenceState.ONLINE : PresenceState.OFFLINE,
      lastSeenAt: new Date(entry.lastSeenMs).toISOString(),
      activeGateways,
      ttlRemainingMs: isOnline ? Math.max(0, entry.expiresAtMs - now) : 0,
    };
  }
}

/**
 * Partitions up to 100,000 channel member IDs into bounded worker batches for non-blocking fan-out.
 */
export function chunkFanoutRecipients(
  memberIds: readonly string[],
  batchSize = 500
): string[][] {
  if (batchSize <= 0) {
    throw new RangeError('batchSize must be > 0');
  }
  const chunks: string[][] = [];
  for (let i = 0; i < memberIds.length; i += batchSize) {
    chunks.push(memberIds.slice(i, i + batchSize));
  }
  return chunks;
}

/**
 * Exponential backoff with Full Jitter (AWS Architecture standard):
 * sleep = random_between(0, min(capMs, baseMs * 2^attempt))
 */
export function computeBackoffWithFullJitter(
  attempt: number,
  baseMs = 500,
  capMs = 30_000,
  randomFn: () => number = Math.random
): number {
  const safeAttempt = Math.max(0, Math.min(attempt, 20));
  const ceiling = Math.min(capMs, baseMs * Math.pow(2, safeAttempt));
  const jitter = Math.max(0.15, Math.min(1, randomFn()));
  return Math.round(ceiling * jitter);
}

const LIFECYCLE_RANK: Record<MessageLifecycleState, number> = {
  [MessageLifecycleState.PENDING]: 0,
  [MessageLifecycleState.SENT]: 1,
  [MessageLifecycleState.DELIVERED]: 2,
  [MessageLifecycleState.READ]: 3,
};

/**
 * Client-side idempotent deduplication and ordering reconciler.
 * Deduplicates by `clientMsgId` (replaces optimistic Pending message with Server-assigned Snowflake message)
 * and sorts ascending by `messageId` for timeline rendering (placing un-acked Pending items at the tail).
 */
export function mergeAndDeduplicateMessages(
  existing: readonly ChatMessage[],
  incoming: readonly ChatMessage[]
): ChatMessage[] {
  const byClientMsgId = new Map<string, ChatMessage>();

  const upsert = (msg: ChatMessage) => {
    const key = msg.clientMsgId || `${msg.channelId}:${msg.messageId}`;
    const prev = byClientMsgId.get(key);
    if (!prev) {
      byClientMsgId.set(key, msg);
      return;
    }

    // Prefer non-pending authoritative server messageId over temporary client ID
    const prevIsPending = prev.lifecycleState === MessageLifecycleState.PENDING;
    const nextIsPending = msg.lifecycleState === MessageLifecycleState.PENDING;

    const authoritative = prevIsPending && !nextIsPending ? msg : !prevIsPending && nextIsPending ? prev : msg;
    const highestState =
      LIFECYCLE_RANK[msg.lifecycleState] >= LIFECYCLE_RANK[prev.lifecycleState]
        ? msg.lifecycleState
        : prev.lifecycleState;

    const mergedDelivered = Array.from(new Set([...prev.deliveredTo, ...msg.deliveredTo]));
    const mergedRead = Array.from(new Set([...prev.readBy, ...msg.readBy]));

    byClientMsgId.set(key, {
      ...prev,
      ...authoritative,
      isEdited: prev.isEdited || msg.isEdited,
      isDeleted: prev.isDeleted || msg.isDeleted,
      content: msg.isDeleted || prev.isDeleted ? '' : authoritative.content,
      lifecycleState: highestState,
      deliveredTo: mergedDelivered,
      readBy: mergedRead,
    });
  };

  for (const item of existing) upsert(item);
  for (const item of incoming) upsert(item);

  return Array.from(byClientMsgId.values()).sort((a, b) => {
    const aPending = a.lifecycleState === MessageLifecycleState.PENDING;
    const bPending = b.lifecycleState === MessageLifecycleState.PENDING;
    if (aPending && !bPending) return 1;
    if (!aPending && bPending) return -1;
    if (aPending && bPending) {
      return a.createdAt.localeCompare(b.createdAt);
    }
    return compareSnowflakeIds(a.messageId, b.messageId);
  });
}

export function advanceSyncCursor(currentCursor: string, messages: readonly ChatMessage[]): string {
  let maxCursor = currentCursor || '0';
  for (const msg of messages) {
    if (
      msg.lifecycleState !== MessageLifecycleState.PENDING &&
      compareSnowflakeIds(msg.messageId, maxCursor) > 0
    ) {
      maxCursor = msg.messageId;
    }
  }
  return maxCursor;
}
