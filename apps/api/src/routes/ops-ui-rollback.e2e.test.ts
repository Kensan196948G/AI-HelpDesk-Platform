import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetAllowlistCache } from '../auth/allowlist.js';
import { config } from '../config.js';
import { buildServer } from '../server.js';

/**
 * P0 ロールバック（QA 2026-11-11 / 運用統合UI切替）。
 *
 * `OPS_UI_PRIMARY=false` でアプリを起動したとき、`/` と `/legacy` が旧 UI に戻り、
 * `/ops` は新 UI のままであることを確認する。systemd/本番は変更しないローカル検証。
 */
const ALLOWED = 'rollback-e2e@mirai-const.co.jp';
const NEW_UI_TITLE = '<title>AIヘルプデスク 運用統合</title>';
const OLD_UI_TITLE = '<title>みらいAI窓口 × ヘルプデスク ステップ受付 V3.1</title>';
const dir = mkdtempSync(path.join(tmpdir(), 'aihd-p0-rollback-'));
const allowlistFile = path.join(dir, 'allowlist.txt');
const original = {
  AUTH_MODE: config.AUTH_MODE,
  ACCESS_JWT_MODE: config.ACCESS_JWT_MODE,
  ACCESS_ALLOWLIST_FILE: config.ACCESS_ALLOWLIST_FILE,
  REQUIRE_PROXY_SECRET: config.REQUIRE_PROXY_SECRET,
  OPS_UI_PRIMARY: config.OPS_UI_PRIMARY,
};
let app: FastifyInstance | undefined;

function server(): FastifyInstance {
  if (!app) throw new Error('server is not ready');
  return app;
}

const allowedHeaders = { 'cf-access-authenticated-user-email': ALLOWED };

beforeAll(async () => {
  writeFileSync(allowlistFile, `${ALLOWED}\n`, { mode: 0o600 });
  Object.assign(config, {
    AUTH_MODE: 'cloudflare-access',
    ACCESS_JWT_MODE: 'off',
    ACCESS_ALLOWLIST_FILE: allowlistFile,
    REQUIRE_PROXY_SECRET: false,
    OPS_UI_PRIMARY: false,
  });
  resetAllowlistCache();
  app = await buildServer({ logger: false });
  await app.ready();
});

afterAll(async () => {
  try {
    if (app) await app.close();
    Object.assign(config, original);
    resetAllowlistCache();
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* close/restore の失敗はテスト結果を上書きしない。 */
  }
});

describe('P0 ロールバック（OPS_UI_PRIMARY=false）', () => {
  it('/ は旧 UI に戻る', async () => {
    const response = await server().inject({
      method: 'GET',
      url: '/',
      headers: allowedHeaders,
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(OLD_UI_TITLE);
    expect(response.body).toContain('window.__AIHD_BOOT__');
  });

  it('/legacy も旧 UI のまま', async () => {
    const response = await server().inject({
      method: 'GET',
      url: '/legacy',
      headers: allowedHeaders,
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(OLD_UI_TITLE);
  });

  it('/ops は新 UI のまま', async () => {
    const response = await server().inject({
      method: 'GET',
      url: '/ops',
      headers: allowedHeaders,
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(NEW_UI_TITLE);
  });

  it('/api/health は 200', async () => {
    const response = await server().inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, db: 'ok' });
  });
});
