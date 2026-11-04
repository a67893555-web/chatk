import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { ClusterDiagnosticsSnapshot } from '../shared/types';
import { apiUrl } from '../client/runtimeConfig';

interface ArchitectureViewProps {
  jwtToken: string | null;
}

interface IdempotencyProbeResult {
  clientMsgId: string;
  firstAttempt: { messageId: string; channelSeq: number; deduplicated: boolean };
  secondAttempt: { messageId: string; channelSeq: number; deduplicated: boolean };
  identicalSnowflakeGuaranteed: boolean;
}

interface RateLimitProbeResult {
  capacityPerSec: number;
  burstSent: number;
  results: Array<{
    frameNumber: number;
    allowed: boolean;
    remainingTokens: number;
    retryAfterMs: number;
  }>;
}

const MICROSERVICES = [
  {
    index: '01',
    name: 'Gateway Service (RFC 6455)',
    protocol: 'WebSocket + JWT Upgrade',
    responsibility:
      'Terminates persistent TLS WebSocket connections, enforces 5 msgs/sec token-bucket rate limits per socket, runs 30s ping/pong heartbeat sweeps, and subscribes to gateway:<server_id> Redis Pub/Sub channels.',
    storage: 'Redis Cluster {user:<id>}:gateways',
  },
  {
    index: '02',
    name: 'Message Service & Fan-Out Pool',
    protocol: 'gRPC / Internal Event Bus',
    responsibility:
      'Checks 24h Redis idempotency:<client_msg_id>, assigns monotonic 64-bit Snowflake IDs, writes to ScyllaDB with LOCAL_QUORUM, and dispatches bounded 500-member batches for groups up to 100,000 members.',
    storage: 'ScyllaDB + Redis Streams',
  },
  {
    index: '03',
    name: 'Presence Service',
    protocol: 'Redis Pipeline + Pub/Sub',
    responsibility:
      'Maintains lightweight online/offline/last_seen hashes backed by 60-second heartbeat TTLs. Multi-device aware: user transitions offline only when their gateway set cardinality reaches zero.',
    storage: 'Redis {user:<id>}:presence (60s TTL)',
  },
  {
    index: '04',
    name: 'Media Processing Engine',
    protocol: 'HTTP/2 REST + Presigned PUT',
    responsibility:
      'Issues short-lived HMAC-SHA256 presigned S3/MinIO HTTP PUT URLs so raw binaries never traverse WebSocket frames. Generates asynchronous thumbnails upon object commit.',
    storage: 'S3 / MinIO Object Storage',
  },
  {
    index: '05',
    name: 'Push Notification Worker',
    protocol: 'Redis Stream Consumer -> HTTP/2',
    responsibility:
      'Consumes un-acknowledged message streams when a recipient has zero active Gateway sockets and dispatches collapsed priority alerts via FCM (Android/Web) and APNs (iOS).',
    storage: 'PostgreSQL device_sessions + Redis XREADGROUP',
  },
];

export const ArchitectureView: React.FC<ArchitectureViewProps> = ({ jwtToken }) => {
  const [cluster, setCluster] = useState<ClusterDiagnosticsSnapshot | null>(null);
  const [idemResult, setIdemResult] = useState<IdempotencyProbeResult | null>(null);
  const [rateResult, setRateResult] = useState<RateLimitProbeResult | null>(null);
  const [loadingProbe, setLoadingProbe] = useState<'idem' | 'rate' | null>(null);

  const fetchClusterSnapshot = useCallback(async () => {
    if (!jwtToken) return;
    const res = await fetch(apiUrl('/api/v1/diagnostics/cluster'), {
      headers: { Authorization: `Bearer ${jwtToken}` },
    });
    if (res.ok) {
      const data = (await res.json()) as ClusterDiagnosticsSnapshot;
      setCluster(data);
    }
  }, [jwtToken]);

  useEffect(() => {
    void fetchClusterSnapshot();
  }, [fetchClusterSnapshot]);

  const runIdempotencyVerification = async () => {
    if (!jwtToken) return;
    setLoadingProbe('idem');
    try {
      const res = await fetch(apiUrl('/api/v1/diagnostics/verify-idempotency'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${jwtToken}`,
        },
        body: JSON.stringify({ channelId: 'ch-core-arch' }),
      });
      if (res.ok) {
        const data = (await res.json()) as IdempotencyProbeResult;
        setIdemResult(data);
        await fetchClusterSnapshot();
      }
    } finally {
      setLoadingProbe(null);
    }
  };

  const runRateLimitVerification = async () => {
    if (!jwtToken) return;
    setLoadingProbe('rate');
    try {
      const res = await fetch(apiUrl('/api/v1/diagnostics/verify-rate-limit'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwtToken}` },
      });
      if (res.ok) {
        const data = (await res.json()) as RateLimitProbeResult;
        setRateResult(data);
      }
    } finally {
      setLoadingProbe(null);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto bg-slate-50">
      <div className="max-w-6xl mx-auto px-6 py-8 space-y-10">
        {/* Header */}
        <div className="flex flex-wrap items-end justify-between gap-4 border-b border-slate-200 pb-6">
          <div className="max-w-2xl">
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">
              Distributed Messaging Architecture & Fault-Tolerance Suite
            </h1>
            <p className="mt-2 text-sm text-slate-600 leading-relaxed">
              Dual-layer HTTP/2 REST control plane and RFC 6455 WebSocket data plane engineered
              for zero message loss, sub-millisecond Redis gateway routing, and single-SSTable
              ScyllaDB partition reads.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void fetchClusterSnapshot()}
            className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-100 transition-colors cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh Live Runtime State
          </button>
        </div>

        {/* Section 1: Microservices Boundary Table */}
        <section aria-labelledby="microservices-heading" className="space-y-4">
          <div>
            <h2 id="microservices-heading" className="text-lg font-semibold text-slate-900">
              01. Microservices Boundary & Protocol Matrix
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Strict separation of stateful socket termination, stateless idempotent persistence,
              and direct-to-bucket binary media ingestion.
            </p>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/80 text-xs font-semibold text-slate-600">
                    <th className="py-3 px-4">Service</th>
                    <th className="py-3 px-4">Transport</th>
                    <th className="py-3 px-4">Core Architectural Responsibility</th>
                    <th className="py-3 px-4">Primary Backing Store</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 text-xs">
                  {MICROSERVICES.map((svc) => (
                    <tr key={svc.index} className="hover:bg-slate-50/60">
                      <td className="py-3.5 px-4 font-semibold text-slate-900 whitespace-nowrap">
                        <span className="font-mono text-slate-400 mr-2">{svc.index}.</span>
                        {svc.name}
                      </td>
                      <td className="py-3.5 px-4 font-mono text-slate-600 whitespace-nowrap">
                        {svc.protocol}
                      </td>
                      <td className="py-3.5 px-4 text-slate-600 leading-relaxed max-w-md">
                        {svc.responsibility}
                      </td>
                      <td className="py-3.5 px-4 font-mono text-slate-700 whitespace-nowrap">
                        {svc.storage}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {/* Section 2: Interactive Live Fault-Tolerance Verification */}
        <section aria-labelledby="fault-tolerance-heading" className="space-y-4">
          <div>
            <h2 id="fault-tolerance-heading" className="text-lg font-semibold text-slate-900">
              02. Live Pipeline Invariant Verification
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Execute deterministic probes against the active server runtime to verify 24-hour
              Redis idempotency deduplication and 5 msgs/sec Token-Bucket rate limiting.
            </p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">
            {/* Idempotency Probe */}
            <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between gap-4">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  Zero-Duplicate Idempotency Probe
                </h3>
                <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                  Submits two consecutive pipeline writes carrying an identical{' '}
                  <code className="font-mono">client_msg_id</code>. Verifies that Redis{' '}
                  <code className="font-mono">idempotency:&lt;uuid&gt;</code> (24h TTL) returns the
                  original Snowflake <code className="font-mono">message_id</code> without writing a
                  second row to ScyllaDB.
                </p>

                {idemResult && (
                  <div className="mt-4 pt-4 border-t border-slate-200 space-y-1.5 text-xs font-mono tabular-nums">
                    <div className="text-slate-600">
                      client_msg_id: <span className="text-slate-900">{idemResult.clientMsgId}</span>
                    </div>
                    <div className="text-slate-600">
                      Attempt #1: Snowflake{' '}
                      <span className="text-slate-900">{idemResult.firstAttempt.messageId}</span> ·
                      seq #{idemResult.firstAttempt.channelSeq} · deduplicated=
                      {String(idemResult.firstAttempt.deduplicated)}
                    </div>
                    <div className="text-slate-600">
                      Attempt #2: Snowflake{' '}
                      <span className="text-slate-900">{idemResult.secondAttempt.messageId}</span> ·
                      seq #{idemResult.secondAttempt.channelSeq} · deduplicated=
                      <strong className="text-emerald-700">
                        {String(idemResult.secondAttempt.deduplicated)}
                      </strong>
                    </div>
                  </div>
                )}
              </div>

              <div>
                <button
                  type="button"
                  disabled={loadingProbe === 'idem'}
                  onClick={() => void runIdempotencyVerification()}
                  className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors cursor-pointer disabled:opacity-50"
                >
                  {loadingProbe === 'idem'
                    ? 'Running Probe...'
                    : 'Run Duplicate client_msg_id Probe'}
                </button>
              </div>
            </div>

            {/* Token Bucket Rate Limit Probe */}
            <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between gap-4">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  Gateway Token-Bucket Burst Probe (5 msgs/sec)
                </h3>
                <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                  Dispatches an instantaneous 7-frame burst against a fresh socket token bucket
                  (capacity = 5, refill = 5/sec) and records exact per-frame acceptance and{' '}
                  <code className="font-mono">Retry-After</code> backoff intervals.
                </p>

                {rateResult && (
                  <div className="mt-4 pt-3 border-t border-slate-200 grid grid-cols-7 divide-x divide-slate-200 text-center font-mono tabular-nums text-[11px]">
                    {rateResult.results.map((r) => (
                      <div key={r.frameNumber} className="py-1.5 px-1">
                        <div className="font-semibold text-slate-700">#{r.frameNumber}</div>
                        <div
                          className={`mt-0.5 font-semibold ${
                            r.allowed ? 'text-emerald-700' : 'text-red-600'
                          }`}
                        >
                          {r.allowed ? 'ALLOW' : '429'}
                        </div>
                        <div className="text-[10px] text-slate-500">
                          {r.allowed ? `${r.remainingTokens}t` : `${r.retryAfterMs}ms`}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <button
                  type="button"
                  disabled={loadingProbe === 'rate'}
                  onClick={() => void runRateLimitVerification()}
                  className="px-4 py-2 text-xs font-semibold text-slate-900 bg-slate-100 border border-slate-200 rounded-lg hover:bg-slate-200 transition-colors cursor-pointer disabled:opacity-50"
                >
                  {loadingProbe === 'rate' ? 'Testing Burst...' : 'Run 7-Frame Socket Burst Test'}
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* Section 3: Active Gateway Routing & Offline Push Notification Queue */}
        {cluster && (
          <section aria-labelledby="runtime-state-heading" className="space-y-4">
            <div>
              <h2 id="runtime-state-heading" className="text-lg font-semibold text-slate-900">
                03. Active Gateway Nodes & Offline Push Notification Outbox
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Circuit Breaker: <span className="font-mono">{cluster.circuitBreakerState}</span> ·
                24h Idempotency Keys:{' '}
                <span className="font-mono tabular-nums">{cluster.idempotencyCacheSize}</span> ·
                Transient Redis Un-Acked Stream:{' '}
                <span className="font-mono tabular-nums">{cluster.unackedStreamDepth}</span>
              </p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {cluster.gatewayNodes.map((gw) => (
                <div key={gw.serverId} className="bg-white border border-slate-200 rounded-xl p-4">
                  <div className="text-xs text-slate-500 font-mono">{gw.serverId}</div>
                  <div className="mt-1 text-xl font-bold text-slate-900 font-mono tabular-nums">
                    {gw.activeSockets} active socket{gw.activeSockets === 1 ? '' : 's'}
                  </div>
                  <div className="mt-2 text-xs text-slate-600">
                    Routed users:{' '}
                    {gw.connectedUsers.length > 0 ? gw.connectedUsers.join(', ') : 'None'}
                  </div>
                </div>
              ))}

              <div className="bg-white border border-slate-200 rounded-xl p-4">
                <div className="text-xs text-slate-500">FCM / APNs Offline Push Dispatches</div>
                <div className="mt-1 text-xl font-bold text-slate-900 font-mono tabular-nums">
                  {cluster.pushDispatches.length} recent alert
                  {cluster.pushDispatches.length === 1 ? '' : 's'}
                </div>
                <div className="mt-2 text-xs text-slate-600 truncate">
                  {cluster.pushDispatches[0]
                    ? `Latest: ${cluster.pushDispatches[0].provider} -> ${cluster.pushDispatches[0].recipientUserId}`
                    : 'Send a message to an offline member to trigger FCM/APNs fallback'}
                </div>
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  );
};
