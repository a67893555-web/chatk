import React, { useCallback, useEffect, useState } from 'react';
import { Check, Copy, RefreshCw } from 'lucide-react';
import { apiUrl } from '../client/runtimeConfig';

interface HealthCheckResponse {
  status: string;
  service: string;
  uptimeSec: number;
  activeWebSockets: number;
  redis: {
    configured: boolean;
    connected: boolean;
    mode: string;
  };
}

interface ConfigSnippet {
  id: 'vercel' | 'dockerfile' | 'render' | 'git';
  filename: string;
  title: string;
  description: string;
  code: string;
}

const DEPLOY_SNIPPETS: ConfigSnippet[] = [
  {
    id: 'vercel',
    filename: 'vercel.json',
    title: 'Frontend Static / SPA Deployment Configuration (Vercel)',
    description:
      'Builds the React 19 + Vite SPA into dist/, applies immutable caching to hashed assets, sets security headers, and rewrites client routes to /index.html.',
    code: `{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "version": 2,
  "framework": "vite",
  "installCommand": "npm install",
  "buildCommand": "npm run build",
  "outputDirectory": "dist",
  "headers": [
    {
      "source": "/assets/(.*)",
      "headers": [
        {
          "key": "Cache-Control",
          "value": "public, max-age=31536000, immutable"
        }
      ]
    },
    {
      "source": "/(.*)",
      "headers": [
        { "key": "X-Content-Type-Options", "value": "nosniff" },
        { "key": "X-Frame-Options", "value": "SAMEORIGIN" },
        { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" }
      ]
    }
  ],
  "rewrites": [
    {
      "source": "/((?!assets/).*)",
      "destination": "/index.html"
    }
  ]
}`,
  },
  {
    id: 'dockerfile',
    filename: 'Dockerfile',
    title: 'Multi-Stage Non-Root Production Dockerfile (Render WebSocket Service)',
    description:
      'Compiles server.ts and shared/server modules via esbuild into an ESM bundle, prunes devDependencies, runs as non-root USER node, and exposes /healthz on port 10000.',
    code: `# Stage 1: Bundle TypeScript Backend & WebSocket Gateway via esbuild
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install --no-audit --no-fund; fi

COPY tsconfig.json server.ts ./
COPY src/shared ./src/shared
COPY src/server ./src/server

RUN npm run build:server

# Stage 2: Minimal Non-Root Production Runtime for Render Web Service
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV SERVE_STATIC_SPA=false
ENV PORT=10000

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev --no-audit --no-fund; fi \\
  && npm cache clean --force

COPY --from=builder /app/dist-server ./dist-server

USER node

EXPOSE 10000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \\
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 10000) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist-server/server.mjs"]`,
  },
  {
    id: 'render',
    filename: 'render.yaml',
    title: 'Render Infrastructure-as-Code Blueprint (Web Service + Managed Redis)',
    description:
      'Provisions both the Dockerized Node.js WebSocket Gateway and an internal Render Key Value (Redis) instance, wiring REDIS_URL automatically over Render private networking.',
    code: `services:
  # 1. Node.js REST API & RFC 6455 WebSocket Gateway Service
  - type: web
    name: pulsewire-gateway
    runtime: docker
    dockerfilePath: ./Dockerfile
    region: frankfurt
    plan: starter
    healthCheckPath: /healthz
    envVars:
      - key: NODE_ENV
        value: production
      - key: SERVE_STATIC_SPA
        value: "false"
      - key: PULSEWIRE_JWT_SECRET
        generateValue: true
      - key: CORS_ALLOWED_ORIGINS
        sync: false # e.g. https://pulsewire-chat.vercel.app,https://*.vercel.app
      - key: REDIS_URL
        fromService:
          type: keyvalue
          name: pulsewire-redis
          property: connectionString

  # 2. Managed Render Key Value (Redis-Compatible) for Presence TTLs & Pub/Sub
  - type: keyvalue
    name: pulsewire-redis
    region: frankfurt
    plan: free
    maxmemoryPolicy: allkeys-lru
    ipAllowList: [] # Internal private network access only`,
  },
  {
    id: 'git',
    filename: 'deploy_commands.sh',
    title: 'Repository Structure & Git Push Workflow',
    description:
      'Clean monorepo-style single repository layout consumed directly by both Vercel (Vite root build) and Render (Dockerfile root build), plus exact Git commands.',
    code: `# Recommended Repository Layout
# pulsewire-chat/
# ├── Dockerfile                  # Render multi-stage backend & WebSocket container
# ├── .dockerignore               # Excludes frontend dist/ & node_modules from Docker context
# ├── render.yaml                 # Render Blueprint (Web Service + Managed Redis)
# ├── vercel.json                 # Vercel SPA build & rewrite rules
# ├── server.ts                   # Express REST + HTTP Upgrade WebSocket entry point
# ├── package.json                # Unified scripts: build (Vercel) & build:server (Render)
# ├── index.html                  # Vite SPA HTML entry
# └── src/
#     ├── shared/                 # Shared types, Snowflake, TokenBucket & CORS/URL resolvers
#     ├── server/                 # Gateway WS manager, Storage engine, JWT & ioredis bridge
#     ├── client/                 # IndexedDB sync store, runtimeConfig & useChatClient hook
#     └── components/             # Modular React 19 UI components

# Initialize Git & Push to GitHub
git init
git branch -M main
git add .
git status

git commit -m "feat: production real-time chat with Vercel + Render split deployment"

# Replace <YOUR_GITHUB_USERNAME> with your GitHub handle
git remote add origin https://github.com/<YOUR_GITHUB_USERNAME>/pulsewire-chat.git
git push -u origin main`,
  },
];

export const DeployView: React.FC = () => {
  const [selectedId, setSelectedId] = useState<ConfigSnippet['id']>('vercel');
  const [copied, setCopied] = useState(false);
  const [health, setHealth] = useState<HealthCheckResponse | null>(null);

  const checkHealth = useCallback(async () => {
    try {
      const res = await fetch(apiUrl('/healthz'));
      if (res.ok) {
        const data = (await res.json()) as HealthCheckResponse;
        setHealth(data);
      }
    } catch {
      // Ignore transient network errors
    }
  }, []);

  useEffect(() => {
    void checkHealth();
  }, [checkHealth]);

  const activeSnippet =
    DEPLOY_SNIPPETS.find((s) => s.id === selectedId) ?? DEPLOY_SNIPPETS[0];

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(activeSnippet.code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Ignore clipboard permission restrictions
    }
  };

  return (
    <div className="flex-1 overflow-y-auto bg-slate-50">
      <div className="max-w-6xl mx-auto px-6 py-8 space-y-8">
        {/* Header & Live /healthz Probe */}
        <div className="flex flex-wrap items-end justify-between gap-4 border-b border-slate-200 pb-6">
          <div className="max-w-2xl">
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">
              Split Production Deployment (Vercel + Render)
            </h1>
            <p className="mt-1.5 text-sm text-slate-600 leading-relaxed">
              Deploy the React/Vite SPA globally on Vercel Edge CDN and host the stateful
              Node.js RFC 6455 WebSocket Gateway + Managed Redis on Render using the checked-in{' '}
              <code className="font-mono">vercel.json</code>,{' '}
              <code className="font-mono">Dockerfile</code>, and{' '}
              <code className="font-mono">render.yaml</code> blueprints.
            </p>
          </div>

          <div className="flex items-center gap-3">
            {health && (
              <span className="text-xs font-mono tabular-nums text-slate-600">
                /healthz: <strong className="text-emerald-700">{health.status.toUpperCase()}</strong>{' '}
                · {health.activeWebSockets} WS · {health.redis.mode}
              </span>
            )}
            <button
              type="button"
              onClick={() => void checkHealth()}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-100 transition-colors cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Test /healthz
            </button>
          </div>
        </div>

        {/* Environment Variables Reference Matrix */}
        <section aria-labelledby="env-matrix-heading" className="space-y-3">
          <h2 id="env-matrix-heading" className="text-lg font-semibold text-slate-900">
            01. Cross-Origin Environment Variable Matrix
          </h2>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-200 bg-slate-50/80 text-xs font-semibold text-slate-800">
                Vercel Project Settings (Frontend SPA)
              </div>
              <table className="w-full text-left border-collapse text-xs">
                <tbody className="divide-y divide-slate-200 font-mono">
                  <tr>
                    <td className="py-2.5 px-4 font-semibold text-slate-900">VITE_API_BASE_URL</td>
                    <td className="py-2.5 px-4 text-slate-600">
                      https://pulsewire-gateway.onrender.com
                    </td>
                  </tr>
                  <tr>
                    <td className="py-2.5 px-4 font-semibold text-slate-900">VITE_WS_URL</td>
                    <td className="py-2.5 px-4 text-slate-600">
                      wss://pulsewire-gateway.onrender.com/ws
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-200 bg-slate-50/80 text-xs font-semibold text-slate-800">
                Render Web Service Settings (Backend + WebSocket)
              </div>
              <table className="w-full text-left border-collapse text-xs">
                <tbody className="divide-y divide-slate-200 font-mono">
                  <tr>
                    <td className="py-2.5 px-4 font-semibold text-slate-900">
                      CORS_ALLOWED_ORIGINS
                    </td>
                    <td className="py-2.5 px-4 text-slate-600">
                      https://your-app.vercel.app,https://*.vercel.app
                    </td>
                  </tr>
                  <tr>
                    <td className="py-2.5 px-4 font-semibold text-slate-900">REDIS_URL</td>
                    <td className="py-2.5 px-4 text-slate-600">
                      Auto-injected via render.yaml (pulsewire-redis)
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {/* Checked-in Config File Explorer */}
        <section aria-labelledby="config-files-heading" className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="config-files-heading" className="text-lg font-semibold text-slate-900">
              02. Production Infrastructure Blueprints
            </h2>
            <div className="inline-flex flex-wrap items-center gap-1 p-1 bg-slate-200/70 rounded-lg">
              {DEPLOY_SNIPPETS.map((s) => {
                const active = s.id === activeSnippet.id;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setSelectedId(s.id)}
                    className={`px-3 py-1.5 text-xs font-mono font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      active
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {s.filename}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <div className="text-sm font-semibold text-slate-900">{activeSnippet.title}</div>
            <p className="text-xs text-slate-600 mt-1">{activeSnippet.description}</p>
          </div>

          <div className="bg-slate-950 border border-slate-800 rounded-xl overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2.5 bg-slate-900 border-b border-slate-800">
              <span className="text-xs font-mono text-slate-300">{activeSnippet.filename}</span>
              <button
                type="button"
                onClick={() => void handleCopy()}
                className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 rounded-md transition-colors cursor-pointer"
              >
                {copied ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    Copy File
                  </>
                )}
              </button>
            </div>
            <div className="overflow-x-auto p-4">
              <pre className="text-xs leading-relaxed font-mono text-slate-100 tabular-nums">
                <code>{activeSnippet.code}</code>
              </pre>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
};
