interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  API_ORIGIN: string;
  PROXY_SECRET: string;
}

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

function harden(response: Response): Response {
  const out = new Response(response.body, response);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) out.headers.set(key, value);
  out.headers.set('Content-Security-Policy', CSP);
  return out;
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: { code: 'UPSTREAM_UNAVAILABLE', message } }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      try {
        const target = new URL(`${url.pathname}${url.search}`, env.API_ORIGIN);
        const headers = new Headers(request.headers);
        headers.delete('host');
        headers.set('x-proxy-secret', env.PROXY_SECRET);
        headers.set('x-forwarded-host', url.host);
        headers.set('x-forwarded-proto', url.protocol.replace(':', ''));

        const init: RequestInit = {
          method: request.method,
          headers,
          redirect: 'manual',
        };
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          init.body = request.body;
        }

        const upstream = await fetch(target, init);
        const out = new Response(upstream.body, upstream);
        out.headers.set('Cache-Control', 'no-store');
        return harden(out);
      } catch {
        return harden(
          jsonError('API に接続できませんでした。時間をおいて再試行してください。', 502),
        );
      }
    }

    const asset = await env.ASSETS.fetch(request);
    if (
      asset.status === 404 &&
      request.method === 'GET' &&
      (request.headers.get('accept') ?? '').includes('text/html')
    ) {
      const fallbackUrl = new URL('/index.html', url);
      const fallback = await env.ASSETS.fetch(
        new Request(fallbackUrl.toString(), { method: 'GET', headers: request.headers }),
      );
      return harden(fallback);
    }
    return harden(asset);
  },
};
