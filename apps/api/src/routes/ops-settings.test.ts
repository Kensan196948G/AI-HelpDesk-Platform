import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearUiRoleCache } from '../auth/ui.js';
import { config } from '../config.js';
import { sql } from '../db.js';
import { buildServer } from '../server.js';
import { DEFAULT_SETTINGS } from './ops-settings.js';

/**
 * 運用統合 UI のシステム設定（docs/100 P6）。
 * 承認者のみ変更でき、変更はサーバの 1 行と監査に残る。
 */
let app: FastifyInstance;
const DEV = config.DEV_AUTH_EMAIL.toLowerCase();

async function grantApprover(): Promise<void> {
  const users = await sql<
    { id: string }[]
  >`SELECT id FROM users WHERE lower(email) = ${DEV} LIMIT 1`;
  let id = users[0]?.id;
  if (!id) {
    const created = await sql<{ id: string }[]>`
      INSERT INTO users (email, name, role, password_hash)
      VALUES (${DEV}, 'テスト実行者', 'requester', '!')
      RETURNING id
    `;
    id = created[0]?.id;
  }
  if (!id) throw new Error('dev user を作成できませんでした');
  await sql`
    INSERT INTO user_roles (user_id, role, source)
    VALUES (${id}, 'approver', 'manual')
    ON CONFLICT (user_id, role) DO NOTHING
  `;
  clearUiRoleCache();
}

async function revokeApprover(): Promise<void> {
  await sql`
    DELETE FROM user_roles
    WHERE role = 'approver' AND user_id = (SELECT id FROM users WHERE lower(email) = ${DEV})
  `;
  clearUiRoleCache();
}

beforeAll(async () => {
  await revokeApprover();
  await sql`DELETE FROM ops_settings WHERE key = 'ui'`;
  app = await buildServer({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await sql`DELETE FROM ops_settings WHERE key = 'ui'`;
  await sql`DELETE FROM audit_log WHERE target_type = 'ops_settings'`;
  await revokeApprover();
  await app.close();
});

describe('システム設定', () => {
  it('未設定なら既定値を返す', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/ops/settings' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { settings: typeof DEFAULT_SETTINGS };
    expect(body.settings.thHigh).toBe(DEFAULT_SETTINGS.thHigh);
    expect(body.settings.sla.P4).toBe(DEFAULT_SETTINGS.sla.P4);
  });

  it('承認者以外は変更できない（403）', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/ops/settings',
      payload: DEFAULT_SETTINGS,
    });
    expect(response.statusCode).toBe(403);
  });

  it('承認者は変更でき、値と監査が残る', async () => {
    await grantApprover();
    const next = {
      ...DEFAULT_SETTINGS,
      thHigh: 0.5,
      thLow: 0.25,
      candMin: 0.1,
      sla: { P1: 30, P2: 120, P3: 480, P4: 4320 },
    };
    const put = await app.inject({ method: 'PUT', url: '/api/ops/settings', payload: next });
    expect(put.statusCode).toBe(200);
    const saved = (put.json() as { settings: typeof DEFAULT_SETTINGS }).settings;
    expect(saved.thHigh).toBe(0.5);
    expect(saved.sla.P1).toBe(30);

    const get = await app.inject({ method: 'GET', url: '/api/ops/settings' });
    expect((get.json() as { settings: typeof DEFAULT_SETTINGS }).settings.thHigh).toBe(0.5);

    const rows = await sql<{ action: string; detail: { changed: string[] } }[]>`
      SELECT action, detail FROM audit_log
      WHERE target_type = 'ops_settings' ORDER BY created_at DESC LIMIT 1
    `;
    expect(rows[0]?.action).toBe('ops.settings.update');
    expect(rows[0]?.detail.changed).toEqual(expect.arrayContaining(['thHigh', 'sla']));
  });

  it('しきい値と SLA の順序違反は 400', async () => {
    await grantApprover();
    const badThreshold = { ...DEFAULT_SETTINGS, thHigh: 0.2, thLow: 0.3 };
    const r1 = await app.inject({ method: 'PUT', url: '/api/ops/settings', payload: badThreshold });
    expect(r1.statusCode).toBe(400);
    const badSla = {
      ...DEFAULT_SETTINGS,
      sla: { P1: 100, P2: 90, P3: 480, P4: 4320 },
    };
    const r2 = await app.inject({ method: 'PUT', url: '/api/ops/settings', payload: badSla });
    expect(r2.statusCode).toBe(400);
  });
});
