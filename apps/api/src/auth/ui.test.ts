import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyRequest } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../config.js';
import { resetAllowlistCache } from './allowlist.js';
import { authenticateUi } from './ui.js';

const dir = mkdtempSync(path.join(tmpdir(), 'aihd-allowlist-'));
const allowlistFile = path.join(dir, 'MailAddress.txt');

const original = {
  AUTH_MODE: config.AUTH_MODE,
  DEV_AUTH_EMAIL: config.DEV_AUTH_EMAIL,
  ACCESS_ALLOWLIST_FILE: config.ACCESS_ALLOWLIST_FILE,
  ACCESS_ALLOWED_EMAIL: config.ACCESS_ALLOWED_EMAIL,
};

function request(headers: Record<string, string | string[] | undefined>): FastifyRequest {
  return { headers } as unknown as FastifyRequest;
}

function writeAllowlist(content: string): void {
  writeFileSync(allowlistFile, content, 'utf8');
  resetAllowlistCache();
}

beforeEach(() => {
  config.AUTH_MODE = 'cloudflare-access';
  config.ACCESS_ALLOWLIST_FILE = allowlistFile;
  writeAllowlist(`登録メール
「kensan1969@gmail.com」
「@mirai-const.co.jp」　例：k-aritoh@mirai-ocnst.co.jp」
のみでお願いします。`);
});

afterEach(() => {
  config.AUTH_MODE = original.AUTH_MODE;
  config.DEV_AUTH_EMAIL = original.DEV_AUTH_EMAIL;
  config.ACCESS_ALLOWLIST_FILE = original.ACCESS_ALLOWLIST_FILE;
  config.ACCESS_ALLOWED_EMAIL = original.ACCESS_ALLOWED_EMAIL;
  resetAllowlistCache();
  vi.restoreAllMocks();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('authenticateUi', () => {
  it('local モードでは DEV_AUTH_EMAIL を使う', async () => {
    config.AUTH_MODE = 'local';
    config.DEV_AUTH_EMAIL = 'dev@example.com';
    const req = request({});
    await authenticateUi(req);
    expect(req.uiEmail).toBe('dev@example.com');
  });

  it('cloudflare-access では完全一致メールを許可する', async () => {
    const req = request({
      'cf-access-authenticated-user-email': 'kensan1969@gmail.com',
    });
    await authenticateUi(req);
    expect(req.uiEmail).toBe('kensan1969@gmail.com');
  });

  it('cloudflare-access では許可ドメインのメールを許可する', async () => {
    const req = request({
      'cf-access-authenticated-user-email': 'Taro@Mirai-Const.co.jp',
    });
    await authenticateUi(req);
    expect(req.uiEmail).toBe('taro@mirai-const.co.jp');
  });

  it('許可外メールは 403（例示の typo ドメインを含む）', async () => {
    for (const email of [
      'other@example.com',
      'other@gmail.com',
      'k-aritoh@mirai-ocnst.co.jp',
      'taro@sub.mirai-const.co.jp',
    ]) {
      await expect(
        authenticateUi(request({ 'cf-access-authenticated-user-email': email })),
      ).rejects.toMatchObject({ statusCode: 403 });
    }
  });

  it('旧 ACCESS_ALLOWED_EMAIL だけでは許可しない（ファイルが正本）', async () => {
    config.ACCESS_ALLOWED_EMAIL = 'legacy@example.com';
    await expect(
      authenticateUi(request({ 'cf-access-authenticated-user-email': 'legacy@example.com' })),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('Access ヘッダーがない場合は 401', async () => {
    await expect(authenticateUi(request({}))).rejects.toMatchObject({ statusCode: 401 });
  });

  it('許可リストが無い場合は全拒否する（fail-closed）', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    rmSync(allowlistFile, { force: true });
    resetAllowlistCache();
    await expect(
      authenticateUi(request({ 'cf-access-authenticated-user-email': 'kensan1969@gmail.com' })),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('許可リストが空の場合も全拒否する（fail-closed）', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeAllowlist('登録メール\nのみでお願いします。\n');
    await expect(
      authenticateUi(request({ 'cf-access-authenticated-user-email': 'kensan1969@gmail.com' })),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});
