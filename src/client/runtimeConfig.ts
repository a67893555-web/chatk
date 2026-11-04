import { resolveApiUrl, resolveWsEndpoint } from '../shared/deploymentUtils';

const ENV_API_BASE_URL: string =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '';
const ENV_WS_URL: string =
  (import.meta.env.VITE_WS_URL as string | undefined) ?? '';

export function apiUrl(path: string): string {
  return resolveApiUrl(path, ENV_API_BASE_URL);
}

export function buildWsUrl(jwtToken: string): string {
  return resolveWsEndpoint(jwtToken, {
    envWsUrl: ENV_WS_URL,
    envApiBase: ENV_API_BASE_URL,
    locationProtocol: typeof window !== 'undefined' ? window.location.protocol : 'http:',
    locationHost: typeof window !== 'undefined' ? window.location.host : 'localhost:3000',
  });
}
