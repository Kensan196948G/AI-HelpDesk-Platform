import { createPublicKey, type JsonWebKey, type KeyObject, verify } from 'node:crypto';

/**
 * Cloudflare Access の JWT（Cf-Access-Jwt-Assertion）を検証する。
 * email ヘッダーだけを信頼すると、同じホスト上のプロセスや SSRF から
 * 127.0.0.1 へ偽ヘッダーを送ってなりすませるため、署名・aud・iss・期限を確認する。
 * 公開鍵は https://<team>/cdn-cgi/access/certs から取得し、1 時間キャッシュする。
 */

export interface AccessJwtOptions {
  teamDomain: string;
  audience: string;
  /** テスト用に鍵の取得を差し替える。 */
  fetchKeys?: (teamDomain: string) => Promise<JsonWebKey[]>;
  now?: () => number;
}

export interface AccessJwtClaims {
  email?: string;
  sub?: string;
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
}

export class AccessJwtError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccessJwtError';
  }
}

const KEY_TTL_MS = 60 * 60 * 1000;
const CLOCK_SKEW_SECONDS = 60;
const keyCache = new Map<string, { keys: Map<string, KeyObject>; fetchedAt: number }>();

export function normalizeTeamDomain(teamDomain: string): string {
  return teamDomain
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
}

async function defaultFetchKeys(teamDomain: string): Promise<JsonWebKey[]> {
  const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new AccessJwtError(`certs HTTP ${response.status}`);
  const body = (await response.json()) as { keys?: JsonWebKey[] };
  return Array.isArray(body.keys) ? body.keys : [];
}

async function loadKeys(
  options: AccessJwtOptions,
  forceRefresh: boolean,
): Promise<Map<string, KeyObject>> {
  const teamDomain = normalizeTeamDomain(options.teamDomain);
  const now = options.now?.() ?? Date.now();
  const cached = keyCache.get(teamDomain);
  if (!forceRefresh && cached && now - cached.fetchedAt < KEY_TTL_MS) return cached.keys;

  const jwks = await (options.fetchKeys ?? defaultFetchKeys)(teamDomain);
  const keys = new Map<string, KeyObject>();
  for (const jwk of jwks) {
    const kid = (jwk as { kid?: string }).kid;
    if (!kid || jwk.kty !== 'RSA') continue;
    keys.set(kid, createPublicKey({ key: jwk, format: 'jwk' }));
  }
  keyCache.set(teamDomain, { keys, fetchedAt: now });
  return keys;
}

export function clearAccessKeyCache(): void {
  keyCache.clear();
}

function decodePart<T>(part: string): T {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as T;
  } catch {
    throw new AccessJwtError('JWT の形式が不正です');
  }
}

export async function verifyAccessJwt(
  token: string,
  options: AccessJwtOptions,
): Promise<AccessJwtClaims> {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => !part)) {
    throw new AccessJwtError('JWT の形式が不正です');
  }
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const header = decodePart<{ alg?: string; kid?: string }>(headerPart);
  if (header.alg !== 'RS256' || !header.kid) {
    throw new AccessJwtError('JWT のアルゴリズムが不正です');
  }

  let keys = await loadKeys(options, false);
  let key = keys.get(header.kid);
  if (!key) {
    // 鍵のローテーション直後に備えて 1 回だけ再取得する。
    keys = await loadKeys(options, true);
    key = keys.get(header.kid);
  }
  if (!key) throw new AccessJwtError('JWT の署名鍵が見つかりません');

  const signature = Buffer.from(signaturePart, 'base64url');
  const valid = verify('RSA-SHA256', Buffer.from(`${headerPart}.${payloadPart}`), key, signature);
  if (!valid) throw new AccessJwtError('JWT の署名が不正です');

  const claims = decodePart<AccessJwtClaims>(payloadPart);
  const nowSeconds = Math.floor((options.now?.() ?? Date.now()) / 1000);
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SECONDS < nowSeconds) {
    throw new AccessJwtError('JWT の有効期限が切れています');
  }
  if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW_SECONDS > nowSeconds) {
    throw new AccessJwtError('JWT はまだ有効ではありません');
  }
  const expectedIssuer = `https://${normalizeTeamDomain(options.teamDomain)}`;
  if (claims.iss !== expectedIssuer) throw new AccessJwtError('JWT の発行者が不正です');
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(options.audience)) throw new AccessJwtError('JWT の aud が不正です');
  return claims;
}
