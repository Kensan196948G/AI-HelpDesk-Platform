import type { FastifyRequest } from 'fastify';

const buckets = new Map<string, { count: number; resetAt: number }>();
const MAX_BUCKETS = 10_000;

function sweep(now: number): void {
  for (const [key, bucket] of buckets) {
    if (now >= bucket.resetAt) buckets.delete(key);
  }
}

/** 単一プロセス内の簡易レート制限。MVP のため固定ウィンドウで十分とする。 */
export function checkRateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  // 期限切れのバケットを掃除し、キーの種類が増え続けてもメモリが際限なく増えないようにする。
  if (buckets.size >= MAX_BUCKETS) sweep(now);
  const bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    if (buckets.size >= MAX_BUCKETS) return false;
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count += 1;
  return true;
}

/** テスト用: すべてのバケットを消す。 */
export function resetRateLimits(): void {
  buckets.clear();
}

/**
 * レート制限のキーにする接続元。
 * Cloudflare Tunnel 経由（ループバック接続）のときは、Cloudflare が付与する
 * CF-Connecting-IP を使う（利用者が送る X-Forwarded-For の左端は信用しない）。
 */
export function clientAddress(request: FastifyRequest): string {
  const socketAddress = request.socket.remoteAddress ?? '';
  const viaLoopback =
    socketAddress === '127.0.0.1' ||
    socketAddress === '::1' ||
    socketAddress === '::ffff:127.0.0.1';
  const header = request.headers['cf-connecting-ip'];
  const connectingIp = Array.isArray(header) ? header[0] : header;
  if (viaLoopback && typeof connectingIp === 'string' && connectingIp.trim()) {
    return connectingIp.trim().slice(0, 64);
  }
  return request.ip;
}
