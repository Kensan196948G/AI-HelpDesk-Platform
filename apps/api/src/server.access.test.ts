import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetAllowlistCache } from './auth/allowlist.js';
import { config } from './config.js';
import { buildServer } from './server.js';

const dir = mkdtempSync(path.join(tmpdir(), 'aihd-server-access-'));
const allowlistFile = path.join(dir, 'MailAddress.txt');

const original = {
  AUTH_MODE: config.AUTH_MODE,
  ACCESS_ALLOWLIST_FILE: config.ACCESS_ALLOWLIST_FILE,
};

beforeEach(() => {
  config.AUTH_MODE = 'cloudflare-access';
  config.ACCESS_ALLOWLIST_FILE = allowlistFile;
  writeFileSync(
    allowlistFile,
    '登録メール\n「kensan1969@gmail.com」\n「@mirai-const.co.jp」\n',
    'utf8',
  );
  resetAllowlistCache();
});

afterEach(() => {
  config.AUTH_MODE = original.AUTH_MODE;
  config.ACCESS_ALLOWLIST_FILE = original.ACCESS_ALLOWLIST_FILE;
  resetAllowlistCache();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('cloudflare-access のアプリ全体ガード', () => {
  it('/api/health 以外は許可リストを必須にし、許可外は 403 にする', async () => {
    const app = await buildServer({ logger: false });
    try {
      const health = await app.inject({ method: 'GET', url: '/api/health' });
      expect(health.statusCode).toBe(200);

      expect((await app.inject({ method: 'GET', url: '/' })).statusCode).toBe(401);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/',
            headers: { 'cf-access-authenticated-user-email': 'other@gmail.com' },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/',
            headers: { 'cf-access-authenticated-user-email': 'taro@mirai-const.co.jp' },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/api/state',
            headers: { 'cf-access-authenticated-user-email': 'other@gmail.com' },
          })
        ).statusCode,
      ).toBe(403);
    } finally {
      await app.close();
    }
  });
});
