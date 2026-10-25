#!/usr/bin/env node
/**
 * ローカル・リバースプロキシ（多層防御の 1 層）。
 *
 *   cloudflared → 127.0.0.1:18949（本スクリプト）→ 127.0.0.1:18950（API）
 *
 * cloudflared は任意のリクエストヘッダを付与できないため、Tunnel と API の間に
 * このプロキシを置き、X-Proxy-Secret を付与する。API は REQUIRE_PROXY_SECRET=true で
 * ヘッダのない直接アクセスを 401 にする。Access JWT の検証（enforce）と併用する。
 *
 * 秘密は環境変数 PROXY_SECRET（systemd の EnvironmentFile = api.conf、0600）から読む。
 * リクエスト本文・ヘッダの値はログに出さない。
 */
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * 上流へ渡すヘッダを作る。
 * - 利用者が送ってきた X-Proxy-Secret は必ず捨て、サーバ側の秘密で置き換える。
 * - hop-by-hop ヘッダは転送しない。Host / Origin / Cookie / JWT などは保持する。
 */
export function injectProxySecret(headers, secret) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === 'x-proxy-secret' || HOP_BY_HOP.has(lower)) continue;
    out[lower === 'host' ? 'Host' : name] = value;
  }
  out['X-Proxy-Secret'] = secret;
  return out;
}

function stripHopByHop(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    out[name] = value;
  }
  return out;
}

export function createProxyServer({
  targetHost = '127.0.0.1',
  targetPort,
  secret,
  timeoutMs = 60_000,
  logger = console,
}) {
  if (!Number.isInteger(targetPort) || targetPort <= 0) {
    throw new Error('targetPort が不正です。');
  }
  if (!secret || secret.length < 16) {
    throw new Error('PROXY_SECRET は 16 文字以上が必要です。');
  }
  return http.createServer((request, response) => {
    const upstream = http.request(
      {
        host: targetHost,
        port: targetPort,
        method: request.method,
        path: request.url,
        headers: injectProxySecret(request.headers, secret),
        timeout: timeoutMs,
      },
      (upstreamResponse) => {
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          stripHopByHop(upstreamResponse.headers),
        );
        upstreamResponse.pipe(response);
      },
    );
    upstream.on('timeout', () => {
      upstream.destroy(new Error('upstream timeout'));
    });
    upstream.on('error', (error) => {
      logger.error?.(`[proxy] upstream error: ${error.message}`);
      if (!response.headersSent) {
        response.writeHead(502, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        });
      }
      response.end(
        JSON.stringify({ error: { code: 'BAD_GATEWAY', message: 'API に接続できません。' } }),
      );
    });
    request.on('error', () => upstream.destroy());
    request.pipe(upstream);
  });
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const port = Number(process.env.SIDECAR_PORT || 18949);
  const targetPort = Number(process.env.API_PORT || process.env.PORT || 18950);
  const targetHost = process.env.API_HOST || '127.0.0.1';
  const secret = process.env.PROXY_SECRET;
  if (!secret || secret.length < 16) {
    console.error('[proxy] PROXY_SECRET が未設定または短すぎます（16 文字以上）。');
    process.exit(2);
  }
  const server = createProxyServer({ targetHost, targetPort, secret });
  server.listen(port, '127.0.0.1', () => {
    console.log(
      `[proxy] listening on http://127.0.0.1:${port} -> http://${targetHost}:${targetPort}`,
    );
  });
  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
