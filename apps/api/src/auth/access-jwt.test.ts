import { generateKeyPairSync, type JsonWebKey, type KeyObject, sign } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../config.js';
import { clearAccessKeyCache, verifyAccessJwt } from './access-jwt.js';

const TEAM = 'example-team.cloudflareaccess.com';
const AUD = 'aud-tag-for-test';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: 'jwk' }) as JsonWebKey), kid: 'kid-1', alg: 'RS256' };
const fetchKeys = async () => [jwk];
const nowSeconds = Math.floor(Date.now() / 1000);

function token(
  claims: Record<string, unknown>,
  options: { key?: KeyObject; kid?: string; alg?: string } = {},
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: options.alg ?? 'RS256', kid: options.kid ?? 'kid-1', typ: 'JWT' }),
  ).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      iss: `https://${TEAM}`,
      aud: [AUD],
      email: 'kensan1969@gmail.com',
      exp: nowSeconds + 600,
      iat: nowSeconds,
      ...claims,
    }),
  ).toString('base64url');
  const signature = sign(
    'RSA-SHA256',
    Buffer.from(`${header}.${payload}`),
    options.key ?? privateKey,
  );
  return `${header}.${payload}.${signature.toString('base64url')}`;
}

const verifyOptions = { teamDomain: TEAM, audience: AUD, fetchKeys };

beforeEach(() => clearAccessKeyCache());

describe('verifyAccessJwt', () => {
  it('正しい署名・aud・iss・期限の JWT を受け入れる', async () => {
    const claims = await verifyAccessJwt(token({}), verifyOptions);
    expect(claims.email).toBe('kensan1969@gmail.com');
  });

  it.each([
    ['別の鍵で署名', () => token({}, { key: other.privateKey })],
    ['aud が違う', () => token({ aud: ['other-aud'] })],
    ['iss が違う', () => token({ iss: 'https://evil.cloudflareaccess.com' })],
    ['期限切れ', () => token({ exp: nowSeconds - 3600 })],
    ['未来の nbf', () => token({ nbf: nowSeconds + 3600 })],
    ['alg が none', () => token({}, { alg: 'none' })],
    ['未知の kid', () => token({}, { kid: 'unknown' })],
    ['形式不正', () => 'not-a-jwt'],
  ])('%s は拒否する', async (_label, make) => {
    await expect(verifyAccessJwt(make(), verifyOptions)).rejects.toThrow();
  });
});

describe('requireCloudflareAccess + ACCESS_JWT_MODE', () => {
  const original = {
    AUTH_MODE: config.AUTH_MODE,
    ACCESS_JWT_MODE: config.ACCESS_JWT_MODE,
    ACCESS_TEAM_DOMAIN: config.ACCESS_TEAM_DOMAIN,
    ACCESS_AUD: config.ACCESS_AUD,
  };
  const log = { info: vi.fn(), warn: vi.fn() };

  function request(headers: Record<string, string>): FastifyRequest {
    return { headers, log } as unknown as FastifyRequest;
  }

  beforeEach(() => {
    config.AUTH_MODE = 'cloudflare-access';
    config.ACCESS_TEAM_DOMAIN = TEAM;
    config.ACCESS_AUD = AUD;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 })),
    );
  });

  afterEach(() => {
    Object.assign(config, original);
    vi.unstubAllGlobals();
    log.info.mockReset();
    log.warn.mockReset();
  });

  it('enforce: 正しい JWT で通過し、偽ヘッダーだけの要求は 401', async () => {
    const { requireCloudflareAccess } = await import('./ui.js');
    config.ACCESS_JWT_MODE = 'enforce';
    const ok = request({
      'cf-access-authenticated-user-email': 'kensan1969@gmail.com',
      'cf-access-jwt-assertion': token({}),
    });
    await requireCloudflareAccess(ok);
    expect(ok.uiEmail).toBe('kensan1969@gmail.com');

    await expect(
      requireCloudflareAccess(
        request({ 'cf-access-authenticated-user-email': 'kensan1969@gmail.com' }),
      ),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('enforce: JWT の email とヘッダーの email が違えば 401', async () => {
    const { requireCloudflareAccess } = await import('./ui.js');
    config.ACCESS_JWT_MODE = 'enforce';
    await expect(
      requireCloudflareAccess(
        request({
          'cf-access-authenticated-user-email': 'kensan1969@gmail.com',
          'cf-access-jwt-assertion': token({ email: 'taro@mirai-const.co.jp' }),
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('report: 失敗してもログに出すだけで通す', async () => {
    const { requireCloudflareAccess } = await import('./ui.js');
    config.ACCESS_JWT_MODE = 'report';
    const req = request({ 'cf-access-authenticated-user-email': 'kensan1969@gmail.com' });
    await requireCloudflareAccess(req);
    expect(req.uiEmail).toBe('kensan1969@gmail.com');
    expect(log.warn).toHaveBeenCalled();
  });
});
