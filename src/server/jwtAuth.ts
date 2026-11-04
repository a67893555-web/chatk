import { createHmac, timingSafeEqual } from 'node:crypto';

const JWT_SECRET =
  process.env.PULSEWIRE_JWT_SECRET || 'pulsewire-internal-gateway-hmac-secret-2026';

export interface JwtClaims {
  sub: string; // userId
  deviceId: string;
  username: string;
  iat: number;
  exp: number;
}

function base64UrlEncode(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecode(input: string): Buffer {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + pad, 'base64');
}

export function signJwt(
  payload: Omit<JwtClaims, 'iat' | 'exp'>,
  ttlSeconds = 24 * 3600
): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const claims: JwtClaims = {
    ...payload,
    iat: nowSec,
    exp: nowSec + ttlSeconds,
  };
  const headerSegment = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payloadSegment = base64UrlEncode(JSON.stringify(claims));
  const signingInput = `${headerSegment}.${payloadSegment}`;
  const signature = createHmac('sha256', JWT_SECRET).update(signingInput).digest();
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

export function verifyJwt(token: string | undefined | null): JwtClaims | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [headerSeg, payloadSeg, sigSeg] = parts;
  const signingInput = `${headerSeg}.${payloadSeg}`;
  const expectedSig = createHmac('sha256', JWT_SECRET).update(signingInput).digest();

  try {
    const providedSig = base64UrlDecode(sigSeg);
    if (
      providedSig.length !== expectedSig.length ||
      !timingSafeEqual(providedSig, expectedSig)
    ) {
      return null;
    }
    const claims = JSON.parse(base64UrlDecode(payloadSeg).toString('utf8')) as JwtClaims;
    const nowSec = Math.floor(Date.now() / 1000);
    if (!claims.sub || !claims.deviceId || claims.exp <= nowSec) {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
}

export function signPresignedUploadUrl(
  objectKey: string,
  mimeType: string,
  expiresAtMs: number
): string {
  const payload = `${objectKey}:${mimeType}:${expiresAtMs}`;
  return createHmac('sha256', JWT_SECRET).update(payload).digest('hex');
}

export function verifyPresignedUploadUrl(
  objectKey: string,
  mimeType: string,
  expiresAtMs: number,
  signature: string
): boolean {
  if (!signature || Date.now() > expiresAtMs) return false;
  const expected = signPresignedUploadUrl(objectKey, mimeType, expiresAtMs);
  try {
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(signature, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
