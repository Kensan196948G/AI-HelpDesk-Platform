import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetAllowlistCache } from '../auth/allowlist.js';
import { config } from '../config.js';
import { sql } from '../db.js';
import { buildServer } from '../server.js';

/**
 * `/` 切替（OPS_UI_PRIMARY=true）と Cloudflare Access 境界の HTTP レベル E2E。
 *
 * - 実 DB（テスト DB）と実際の Fastify ルートを使い、inject で HTTP を叩く。
 * - Access JWT はこの試験では off（署名検証は staging-smoke が enforce で担当）。
 *   ここでは「Access が付与する email ヘッダー → アプリ許可リスト → UI/API」の境界を確認する。
 * - 許可リストは本番と同じ形（完全一致 + ドメイン一致 + 高松の完全一致）を合成データで再現する。
 */
const MARK = '【E2E】ops-ui-auth';
const ALLOWED_EXACT = 'kensan1969@gmail.com';
const ALLOWED_DOMAIN = 'taro@mirai-const.co.jp';
const ALLOWED_TAKAMATSU = 'hirokiabe@takamatsu-cg.co.jp';
const DENIED = 'other@example.com';
const DENIED_TAKAMATSU = 'other@takamatsu-cg.co.jp';
const NEW_UI_TITLE = '<title>AIヘルプデスク 運用統合</title>';
const OLD_UI_TITLE = '<title>みらいAI窓口 × ヘルプデスク ステップ受付 V3.1</title>';

const dir = mkdtempSync(path.join(tmpdir(), 'aihd-ops-ui-e2e-'));
const allowlistFile = path.join(dir, 'allowlist.txt');
const original = {
  AUTH_MODE: config.AUTH_MODE,
  ACCESS_JWT_MODE: config.ACCESS_JWT_MODE,
  ACCESS_ALLOWLIST_FILE: config.ACCESS_ALLOWLIST_FILE,
  REQUIRE_PROXY_SECRET: config.REQUIRE_PROXY_SECRET,
  OPS_UI_PRIMARY: config.OPS_UI_PRIMARY,
  PERSONA_SWITCH_ALLOWLIST: config.PERSONA_SWITCH_ALLOWLIST,
};
let app: FastifyInstance | undefined;

function server(): FastifyInstance {
  if (!app) throw new Error('server is not ready');
  return app;
}

function accessHeaders(email?: string): Record<string, string> {
  return email ? { 'cf-access-authenticated-user-email': email } : {};
}

beforeAll(async () => {
  writeFileSync(allowlistFile, `${ALLOWED_EXACT}\n@mirai-const.co.jp\n${ALLOWED_TAKAMATSU}\n`, {
    mode: 0o600,
  });
  Object.assign(config, {
    AUTH_MODE: 'cloudflare-access',
    ACCESS_JWT_MODE: 'off',
    ACCESS_ALLOWLIST_FILE: allowlistFile,
    REQUIRE_PROXY_SECRET: false,
    // `/` を新 UI にする（本番の 2026-11-11 切替と同じ状態）。
    OPS_UI_PRIMARY: true,
    // 管理者 Gmail は PC ヘルプデスクのデモ許可で解決する（本番と同じ）。
    PERSONA_SWITCH_ALLOWLIST: ALLOWED_EXACT,
  });
  resetAllowlistCache();
  app = await buildServer({ logger: false });
  await app.ready();
});

afterAll(async () => {
  try {
    await sql`DELETE FROM ops_tickets WHERE subject LIKE ${`${MARK}%`}`;
  } finally {
    if (app) await app.close();
    Object.assign(config, original);
    resetAllowlistCache();
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('OPS_UI_PRIMARY=true の / 切替', () => {
  it('許可ユーザーの / は新 UI（旧 UI のブートが混ざらない）', async () => {
    const response = await server().inject({
      method: 'GET',
      url: '/',
      headers: accessHeaders(ALLOWED_EXACT),
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(NEW_UI_TITLE);
    expect(response.body).not.toContain('window.__AIHD_BOOT__');
  });

  it('管理者 Gmail は「管理者」/ PCヘルプデスクとしてブートされる', async () => {
    const response = await server().inject({
      method: 'GET',
      url: '/',
      headers: accessHeaders(ALLOWED_EXACT),
    });
    expect(response.statusCode).toBe(200);
    const boot = /window\.__OPS_BOOT__=(\{.*?\});<\/script>/s.exec(response.body)?.[1];
    expect(boot).toBeTruthy();
    const parsed = JSON.parse(boot as string) as {
      actor: {
        name: string;
        role: string;
        helpdesk: boolean;
        staff: { name: string }[];
      };
    };
    expect(parsed.actor.name).toBe('管理者');
    expect(parsed.actor.role).toBe('PCヘルプデスク');
    expect(parsed.actor.helpdesk).toBe(true);
    // 名簿に居ないログイン本人も操作者候補の先頭に残る。
    expect(parsed.actor.staff.some((entry) => entry.name === '管理者')).toBe(true);
    expect(response.body).toContain('さん、こんにちは');
    expect(response.body).toContain('PCヘルプデスクとして対応中');
  });

  it('/legacy は旧 UI のまま', async () => {
    const response = await server().inject({
      method: 'GET',
      url: '/legacy',
      headers: accessHeaders(ALLOWED_EXACT),
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(OLD_UI_TITLE);
    expect(response.body).toContain('window.__AIHD_BOOT__');
  });

  it('/ops は新 UI', async () => {
    const response = await server().inject({
      method: 'GET',
      url: '/ops',
      headers: accessHeaders(ALLOWED_DOMAIN),
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(NEW_UI_TITLE);
  });
});

describe('Cloudflare Access のアプリ許可リスト境界', () => {
  it('Access ヘッダーがない場合は 401', async () => {
    const response = await server().inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(401);
  });

  it('許可外ドメインは 403', async () => {
    const response = await server().inject({
      method: 'GET',
      url: '/',
      headers: accessHeaders(DENIED),
    });
    expect(response.statusCode).toBe(403);
  });

  it('@mirai-const.co.jp はドメイン一致で許可', async () => {
    const response = await server().inject({
      method: 'GET',
      url: '/',
      headers: accessHeaders(ALLOWED_DOMAIN),
    });
    expect(response.statusCode).toBe(200);
  });

  it('高松の完全一致ユーザーは許可', async () => {
    const response = await server().inject({
      method: 'GET',
      url: '/',
      headers: accessHeaders(ALLOWED_TAKAMATSU),
    });
    expect(response.statusCode).toBe(200);
  });

  it('高松の別ユーザーは現行ポリシーでは 403（ドメイン全体は未許可）', async () => {
    const response = await server().inject({
      method: 'GET',
      url: '/',
      headers: accessHeaders(DENIED_TAKAMATSU),
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('ops API の認証と実 DB 書き込み', () => {
  it('/api/ops/status は許可ユーザーで 200、未認証は 401', async () => {
    const allowed = await server().inject({
      method: 'GET',
      url: '/api/ops/status',
      headers: accessHeaders(ALLOWED_DOMAIN),
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({ ok: true });

    const denied = await server().inject({ method: 'GET', url: '/api/ops/status' });
    expect(denied.statusCode).toBe(401);
  });

  it('受付を作成し、同じユーザーの一覧に反映する', async () => {
    const subject = `${MARK} 受付から一覧まで ${Date.now()}`;
    const created = await server().inject({
      method: 'POST',
      url: '/api/ops/tickets',
      headers: accessHeaders(ALLOWED_DOMAIN),
      payload: { subject, body: 'E2E 自動試験の受付です。', category: 'other' },
    });
    expect(created.statusCode).toBe(200);
    const ticket = (created.json() as { ticket: { id: string; serverId: string } }).ticket;
    expect(ticket.id).toMatch(/^OPS-\d{4,}$/);
    expect(ticket.serverId).toMatch(/^[0-9a-f-]{36}$/);

    const list = await server().inject({
      method: 'GET',
      url: '/api/ops/tickets',
      headers: accessHeaders(ALLOWED_DOMAIN),
    });
    expect(list.statusCode).toBe(200);
    const body = list.json() as { tickets: { subject: string }[] };
    expect(body.tickets.some((row) => row.subject === subject)).toBe(true);
  });
});
