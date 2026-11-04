/**
 * Pure URL & CORS origin utilities for split Frontend (Vercel) + Backend/WS (Render) deployments.
 */

export function normalizeBaseUrl(raw?: string | null): string {
  if (!raw) return '';
  return raw.trim().replace(/\/+$/, '');
}

/**
 * Resolves an API or media path against VITE_API_BASE_URL when deployed on a separate origin (Vercel -> Render).
 * Falls back to same-origin relative path when VITE_API_BASE_URL is empty (local dev / AI Studio).
 */
export function resolveApiUrl(path: string, envApiBase?: string | null): string {
  if (!path) return '';
  if (/^https?:\/\//i.test(path)) return path;

  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  const base = normalizeBaseUrl(envApiBase);
  return base ? `${base}${cleanPath}` : cleanPath;
}

/**
 * Resolves the RFC 6455 WebSocket endpoint with ?token=<jwt> query parameter:
 * 1. Explicit VITE_WS_URL (e.g. wss://pulsewire-gateway.onrender.com/ws)
 * 2. Derived from VITE_API_BASE_URL (https://... -> wss://.../ws)
 * 3. Same-origin window.location fallback (ws://localhost:3000/ws)
 */
export function resolveWsEndpoint(
  token: string,
  opts: {
    envWsUrl?: string | null;
    envApiBase?: string | null;
    locationProtocol: string;
    locationHost: string;
  }
): string {
  const encodedToken = encodeURIComponent(token);
  const explicitWs = normalizeBaseUrl(opts.envWsUrl);

  let wsBase: string;
  if (explicitWs) {
    wsBase = explicitWs.endsWith('/ws') ? explicitWs : `${explicitWs}/ws`;
  } else {
    const apiBase = normalizeBaseUrl(opts.envApiBase);
    if (apiBase && /^https?:\/\//i.test(apiBase)) {
      const wsOrigin = apiBase.replace(/^http/i, 'ws');
      wsBase = `${wsOrigin}/ws`;
    } else {
      const proto = opts.locationProtocol === 'https:' ? 'wss:' : 'ws:';
      wsBase = `${proto}//${opts.locationHost}/ws`;
    }
  }

  const separator = wsBase.includes('?') ? '&' : '?';
  return `${wsBase}${separator}token=${encodedToken}`;
}

/**
 * Validates HTTP Request / WebSocket Upgrade `Origin` header against CORS_ALLOWED_ORIGINS.
 * Supports exact origins ("https://pulsewire.vercel.app") and wildcard Vercel preview
 * subdomains ("https://*.vercel.app").
 * If allowedOriginsCsv is unset or "*", allows all origins (local / single-origin default).
 */
export function isOriginAllowed(
  requestOrigin: string | undefined,
  allowedOriginsCsv: string | undefined
): boolean {
  const rawList = (allowedOriginsCsv ?? '').trim();
  if (!rawList || rawList === '*') {
    return true;
  }

  // Non-browser healthchecks (e.g. Render /healthz probe) omit the Origin header
  if (!requestOrigin) {
    return true;
  }

  const normalizedOrigin = normalizeBaseUrl(requestOrigin).toLowerCase();
  const patterns = rawList
    .split(',')
    .map((item) => normalizeBaseUrl(item).toLowerCase())
    .filter(Boolean);

  for (const pattern of patterns) {
    if (pattern === '*') return true;
    if (pattern === normalizedOrigin) return true;

    // Support wildcard subdomain pattern e.g. "https://*.vercel.app"
    if (pattern.includes('*.')) {
      const [prefix, suffix] = pattern.split('*.');
      if (prefix !== undefined && suffix !== undefined) {
        const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(
          `^${escapeRegex(prefix)}([a-z0-9-]+\\.)+${escapeRegex(suffix)}$`,
          'i'
        );
        if (regex.test(normalizedOrigin)) {
          return true;
        }
      }
    }
  }

  return false;
}
