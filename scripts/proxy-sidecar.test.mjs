import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createProxyServer, injectProxySecret } from './proxy-sidecar.mjs';

const SECRET = 'test-proxy-secret-0123456789abcdef';
const servers = [];

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function request(port, { headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/api/state', method: 'POST', headers },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => close(server).catch(() => {})));
});

describe('proxy sidecar（X-Proxy-Secret 付与）', () => {
  it('利用者の X-Proxy-Secret を捨て、サーバ側の秘密で置き換える', () => {
    const headers = injectProxySecret(
      {
        host: 'ai-helpdesk.mirai-dx-platform.com',
        'x-proxy-secret': 'attacker-tries-to-forge',
        'cf-access-authenticated-user-email': 'user@example.com',
        connection: 'keep-alive',
        'content-type': 'application/json',
      },
      SECRET,
    );
    expect(headers['X-Proxy-Secret']).toBe(SECRET);
    expect(headers['x-proxy-secret']).toBeUndefined();
    expect(headers.Host).toBe('ai-helpdesk.mirai-dx-platform.com');
    expect(headers['cf-access-authenticated-user-email']).toBe('user@example.com');
    expect(headers.connection).toBeUndefined();
  });

  it('プロキシ経由のリクエストにだけ秘密を付けて転送する', async () => {
    let received = null;
    const upstream = http.createServer((req, res) => {
      received = req.headers;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    servers.push(upstream);
    const upstreamPort = await listen(upstream);

    const proxy = createProxyServer({ targetPort: upstreamPort, secret: SECRET });
    servers.push(proxy);
    const proxyPort = await listen(proxy);

    const viaProxy = await request(proxyPort, {
      headers: {
        'x-proxy-secret': 'forged',
        'cf-access-authenticated-user-email': 'user@example.com',
        'content-type': 'application/json',
      },
      body: '{"data":{"v":31}}',
    });
    expect(viaProxy.status).toBe(200);
    expect(received['x-proxy-secret']).toBe(SECRET);
    expect(received['cf-access-authenticated-user-email']).toBe('user@example.com');

    // プロキシを通らない直接アクセスには秘密が付かない（API 側で 401 になる前提）
    received = null;
    const direct = await request(upstreamPort, {
      headers: { 'cf-access-authenticated-user-email': 'user@example.com' },
    });
    expect(direct.status).toBe(200);
    expect(received['x-proxy-secret']).toBeUndefined();
  });

  it('上流が停止しているときは 502 を返し、プロセスを落とさない', async () => {
    const closed = http.createServer(() => {});
    const closedPort = await listen(closed);
    await close(closed);
    const proxy = createProxyServer({
      targetPort: closedPort,
      secret: SECRET,
      logger: { error: () => {} },
    });
    servers.push(proxy);
    const proxyPort = await listen(proxy);
    const response = await request(proxyPort);
    expect(response.status).toBe(502);
    expect(response.body).toContain('BAD_GATEWAY');
  });
});
