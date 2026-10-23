import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from './index.js';

function makeEnv(assetsFetch: (request: Request) => Promise<Response>) {
  return {
    ASSETS: { fetch: assetsFetch },
    API_ORIGIN: 'https://api.example.com',
    PROXY_SECRET: 'test-proxy-secret',
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('worker', () => {
  it('静的アセットにセキュリティヘッダと CSP を付与する', async () => {
    const env = makeEnv(async () => new Response('<html>ok</html>', { status: 200 }));
    const response = await worker.fetch(new Request('https://app.example.com/'), env);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('ok');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('/api/* を共有秘密付きで API へプロキシする', async () => {
    let capturedUrl = '';
    const captured: { headers?: Headers } = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(url);
        captured.headers = new Headers(init?.headers);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
    const env = makeEnv(async () => new Response('unused', { status: 500 }));
    const response = await worker.fetch(new Request('https://app.example.com/api/health?x=1'), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(capturedUrl).toBe('https://api.example.com/api/health?x=1');
    expect(captured.headers?.get('x-proxy-secret')).toBe('test-proxy-secret');
    expect(captured.headers?.get('x-forwarded-host')).toBe('app.example.com');
  });

  it('API が落ちている場合は 502 を返す', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connect refused');
      }),
    );
    const env = makeEnv(async () => new Response('unused', { status: 200 }));
    const response = await worker.fetch(new Request('https://app.example.com/api/health'), env);
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error.code).toBe('UPSTREAM_UNAVAILABLE');
  });

  it('SPA のルートは index.html へフォールバックする', async () => {
    const env = makeEnv(async (request) => {
      const url = new URL(request.url);
      if (url.pathname === '/index.html') {
        return new Response('<html>spa</html>', { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });
    const response = await worker.fetch(
      new Request('https://app.example.com/cases/abc', { headers: { Accept: 'text/html' } }),
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('spa');
  });
});
