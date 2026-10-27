import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '../db.js';
import { GENESIS_HASH, verifyAuditChain } from '../domain/audit.js';
import { appendAudit } from '../lib/audit-log.js';
import { resetRateLimits } from '../lib/rate-limit.js';
import { buildServer } from '../server.js';

let app: FastifyInstance;
let password: string;
let suffix: string;

interface CookieJar {
  cookie: string;
}

function extractCookie(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers['set-cookie'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') throw new Error('set-cookie missing');
  return value.split(';')[0] ?? '';
}

async function login(email: string): Promise<CookieJar> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password },
  });
  expect(response.statusCode, response.body).toBe(200);
  return { cookie: extractCookie(response) };
}

async function verify(): Promise<{ ok: boolean; checked: number; brokenAtId?: number }> {
  const approver = await login('watanabe@example.com');
  const response = await app.inject({
    method: 'POST',
    url: '/api/audit/verify',
    headers: { cookie: approver.cookie },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}

beforeAll(async () => {
  resetRateLimits();
  password = process.env.SEED_PASSWORD ?? '';
  expect(password).not.toBe('');
  suffix = Date.now().toString(36);
  app = await buildServer({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('監査ハッシュチェーン（G-01-F1/F2）', () => {
  it('Date を含む detail を保存しても再計算が一致し、/api/audit/verify は ok:true', async () => {
    const before = await verify();
    expect(before.ok, JSON.stringify(before)).toBe(true);

    // Date をそのまま detail に渡す（domain/audit.ts が ISO 文字列として直列化する）。
    const at = new Date('2026-10-26T09:20:18.931Z');
    const targetId = `audit-date-${suffix}`;
    await sql.begin(async (tx) => {
      await appendAudit(tx, {
        actorId: null,
        action: 'test.audit.date',
        targetType: 'test',
        targetId,
        detail: { at, label: 'date-roundtrip' },
      });
    });

    // jsonb には ISO 文字列で保存されている。
    const stored = await sql<{ detail: Record<string, unknown> }[]>`
      SELECT detail FROM audit_log
      WHERE target_type = 'test' AND target_id = ${targetId}
      ORDER BY id DESC LIMIT 1
    `;
    expect(stored[0]?.detail.at).toBe(at.toISOString());

    const after = await verify();
    expect(after.ok, JSON.stringify(after)).toBe(true);
    expect(after.checked).toBeGreaterThan(before.checked);

    // 直接検証しても同じ結果になる。
    const rows = await sql<any[]>`
      SELECT id, actor_id, action, target_type, target_id, detail, prev_hash, hash
      FROM audit_log ORDER BY id ASC
    `;
    const result = verifyAuditChain(
      rows.map((row) => ({
        id: Number(row.id),
        actorId: row.actor_id ?? null,
        action: row.action,
        targetType: row.target_type,
        targetId: row.target_id,
        detail: row.detail,
        prevHash: row.prev_hash,
        hash: row.hash,
      })),
      GENESIS_HASH,
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });

  it('ケース作成時の AI 一次対応の監査に実行者（authUser）が入る', async () => {
    const requester = await login('yamada@example.com');
    const created = await app.inject({
      method: 'POST',
      url: '/api/cases',
      headers: { cookie: requester.cookie },
      payload: {
        category: 'file_share',
        subject: `監査actorテスト（${suffix}）`,
        body: '共有フォルダに保存できません。',
        urgency: 'normal',
        pcEnabled: false,
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    const caseId = created.json().case.id as string;

    try {
      const users = await sql<{ id: string }[]>`
        SELECT id FROM users WHERE lower(email) = 'yamada@example.com' LIMIT 1
      `;
      const userId = users[0]?.id;
      expect(userId, 'seed の requester').toBeDefined();

      const audits = await sql<{ action: string; actor_id: string | null }[]>`
        SELECT action, actor_id FROM audit_log
        WHERE target_type = 'case' AND target_id = ${caseId}
        ORDER BY id ASC
      `;
      const createAudit = audits.find((row) => row.action === 'case.create');
      const assessAudit = audits.find((row) => row.action === 'case.ai_assess');
      expect(createAudit?.actor_id).toBe(userId);
      expect(assessAudit?.actor_id, 'G-01-F2: actorId:null をやめる').toBe(userId);
    } finally {
      // 案件は FK の ON DELETE CASCADE で子テーブルごと片付ける（監査行は残す）。
      await sql`DELETE FROM cases WHERE id = ${caseId}`;
    }
  });
});
