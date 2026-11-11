import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearUiRoleCache } from '../auth/ui.js';
import { config } from '../config.js';
import { sql } from '../db.js';
import { buildServer } from '../server.js';

/**
 * 運用統合 UI の SecOps・DevOps（docs/100 P5）。
 * 緊急停止はサーバ保存、解除・設定は承認者／監査担当のみ。監査鎖の検証は実データで行う。
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
  app = await buildServer({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await sql`UPDATE ops_estop SET active = false, reason = NULL, actor_email = NULL WHERE id = 1`;
  await sql`DELETE FROM audit_log WHERE target_type = 'ops_estop'`;
  await revokeApprover();
  await app.close();
});

describe('緊急停止（サーバ保存）', () => {
  it('権限が無いと操作できない（403）', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/ops/estop',
      payload: { active: true, reason: 'テスト' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('承認者は有効化・解除でき、監査に残る', async () => {
    await grantApprover();
    const on = await app.inject({
      method: 'POST',
      url: '/api/ops/estop',
      payload: { active: true, reason: '受入テスト' },
    });
    expect(on.statusCode).toBe(200);
    expect((on.json() as { estop: { active: boolean; actor: string } }).estop.active).toBe(true);

    const status = await app.inject({ method: 'GET', url: '/api/ops/status' });
    expect(status.statusCode).toBe(200);
    const body = status.json() as {
      estop: { active: boolean };
      devops: { commit: string | null; db: { ok: boolean } } | null;
      audit: { ok: boolean; rows: number } | null;
    };
    expect(body.estop.active).toBe(true);
    expect(body.devops?.db.ok).toBe(true);
    expect(typeof body.audit?.ok).toBe('boolean');

    const off = await app.inject({
      method: 'POST',
      url: '/api/ops/estop',
      payload: { active: false },
    });
    expect(off.statusCode).toBe(200);
    expect((off.json() as { estop: { active: boolean } }).estop.active).toBe(false);

    const rows = await sql<{ action: string }[]>`
      SELECT action FROM audit_log WHERE target_type = 'ops_estop' ORDER BY created_at DESC LIMIT 2
    `;
    expect(rows.map((r) => r.action).sort()).toEqual(['ops.estop.off', 'ops.estop.on']);
  });
});

describe('端末台帳（Mirai-Info）', () => {
  it('検索 API は担当者に応答し、台帳が無い環境でも 500 にしない', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/ops/assets?q=PC-1234' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { ok: boolean; items: unknown[]; error: string | null };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.items)).toBe(true);
    // テスト環境は実名簿・実台帳に接続しない（mirai-info は無効）。
    expect(body.items).toHaveLength(0);
  });

  it('2文字未満の検索語では照会しない', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/ops/assets?q=P' });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { items: unknown[] }).items).toHaveLength(0);
  });

  it('DevOps 状態に台帳のサマリ（件数・鮮度・到達性）が入る', async () => {
    await grantApprover();
    const response = await app.inject({ method: 'GET', url: '/api/ops/status' });
    const body = response.json() as {
      devops: { assets?: { total: number; seenWithin7d: number; online: number; offline: number } };
    };
    expect(body.devops.assets).toBeTruthy();
    expect(typeof body.devops.assets?.total).toBe('number');
    expect(typeof body.devops.assets?.seenWithin7d).toBe('number');
    expect(typeof body.devops.assets?.online).toBe('number');
    expect(typeof body.devops.assets?.offline).toBe('number');
  });
});

describe('リモート支援セッション（P11）', () => {
  it('有効なセッションを配列で返す（推測値を足さない）', async () => {
    await grantApprover();
    const response = await app.inject({ method: 'GET', url: '/api/ops/status' });
    const body = response.json() as {
      remote: { id: string; caseId: string; status: string; userLabel: string }[];
    };
    expect(Array.isArray(body.remote)).toBe(true);
    for (const item of body.remote) {
      expect(typeof item.caseId).toBe('string');
      expect(item.status).toBe('escalated');
      // メールはマスクして返す（生のメールを出さない）。
      expect(item.userLabel).not.toContain('@example.com');
    }
  });
});

describe('DevOps の実測値', () => {
  it('DB 件数と稼働時間を返す（推測値を出さない）', async () => {
    await grantApprover();
    const response = await app.inject({ method: 'GET', url: '/api/ops/status' });
    const body = response.json() as {
      devops: {
        commit: string | null;
        release: string | null;
        uptimeSec: number;
        db: { ok: boolean; counts: { knowledge: number; tickets: number; audit: number } };
      };
    };
    expect(body.devops.db.ok).toBe(true);
    expect(body.devops.db.counts.knowledge).toBeGreaterThanOrEqual(0);
    expect(body.devops.db.counts.audit).toBeGreaterThanOrEqual(0);
    expect(body.devops.uptimeSec).toBeGreaterThanOrEqual(0);
  });
});
