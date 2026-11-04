# ==============================================================================
# Stage 1: Bundle TypeScript Backend & WebSocket Gateway via esbuild
# ==============================================================================
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install --no-audit --no-fund; fi

COPY tsconfig.json server.ts ./
COPY src/shared ./src/shared
COPY src/server ./src/server

RUN npm run build:server

# ==============================================================================
# Stage 2: Minimal Non-Root Production Runtime for Render Web Service
# ==============================================================================
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV SERVE_STATIC_SPA=false
ENV PORT=10000

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev --no-audit --no-fund; fi \
  && npm cache clean --force

COPY --from=builder /app/dist-server ./dist-server

USER node

EXPOSE 10000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 10000) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist-server/server.mjs"]
