import type { FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { authenticateUi } from './ui.js';

const original = {
  AUTH_MODE: config.AUTH_MODE,
  ACCESS_ALLOWED_EMAIL: config.ACCESS_ALLOWED_EMAIL,
  DEV_AUTH_EMAIL: config.DEV_AUTH_EMAIL,
};

afterEach(() => {
  config.AUTH_MODE = original.AUTH_MODE;
  config.ACCESS_ALLOWED_EMAIL = original.ACCESS_ALLOWED_EMAIL;
  config.DEV_AUTH_EMAIL = original.DEV_AUTH_EMAIL;
});

function request(headers: Record<string, string | string[] | undefined>): FastifyRequest {
  return { headers } as unknown as FastifyRequest;
}

describe('authenticateUi', () => {
  it('local モードでは DEV_AUTH_EMAIL を使う', async () => {
    config.AUTH_MODE = 'local';
    config.DEV_AUTH_EMAIL = 'dev@example.com';
    const req = request({});
    await authenticateUi(req);
    expect(req.uiEmail).toBe('dev@example.com');
  });

  it('cloudflare-access では許可メールのヘッダだけを受け入れる', async () => {
    config.AUTH_MODE = 'cloudflare-access';
    config.ACCESS_ALLOWED_EMAIL = 'allowed@mirai-const.co.jp';

    const ok = request({
      'cf-access-authenticated-user-email': 'allowed@mirai-const.co.jp',
    });
    await authenticateUi(ok);
    expect(ok.uiEmail).toBe('allowed@mirai-const.co.jp');

    await expect(
      authenticateUi(request({ 'cf-access-authenticated-user-email': 'other@example.com' })),
    ).rejects.toMatchObject({ statusCode: 403 });

    await expect(authenticateUi(request({}))).rejects.toMatchObject({ statusCode: 401 });
  });
});
