import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearUiRoleCache } from '../auth/ui.js';
import { config } from '../config.js';
import { sql } from '../db.js';
import { buildServer } from '../server.js';

/**
 * 運用統合 UI の ⑤下書き・⑥承認・⑦KB・監査（docs/100 P3b）。
 * 権限（承認者のみ・申請者本人は不可）はサーバが正本であることを実 DB で確認する。
 */
let app: FastifyInstance;
const MARK = '【テスト】ops-knowledge';
const DEV = config.DEV_AUTH_EMAIL.toLowerCase();

async function ensureDevUser(roles: string[]): Promise<void> {
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
  for (const role of roles) {
    await sql`
      INSERT INTO user_roles (user_id, role, source)
      VALUES (${id}, ${role}, 'manual')
      ON CONFLICT (user_id, role) DO NOTHING
    `;
  }
  clearUiRoleCache();
}

async function removeDevRoles(): Promise<void> {
  await sql`
    DELETE FROM user_roles
    WHERE role IN ('approver', 'helpdesk')
      AND user_id = (SELECT id FROM users WHERE lower(email) = ${DEV})
  `;
  clearUiRoleCache();
}

beforeAll(async () => {
  // 他の試験が同じ実行者にロールを付けている場合があるため、まず素の状態に戻す。
  await removeDevRoles();
  app = await buildServer({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await sql`DELETE FROM knowledge WHERE title LIKE ${`${MARK}%`}`;
  await sql`DELETE FROM audit_log WHERE target_type = 'knowledge' AND target_id IN (
    SELECT kb_no FROM knowledge WHERE title LIKE ${`${MARK}%`}
  )`;
  await removeDevRoles();
  await app.close();
});

describe('⑤ 下書き', () => {
  it('下書きを作成すると承認待ち（pending）で保存される', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/ops/knowledge',
      payload: {
        title: `${MARK} VPNの再接続手順`,
        symptom: 'VPNが切れる',
        cause: 'チャネル干渉',
        steps: ['再接続する', 'チャネルを変更する'],
        keywords: ['VPN', '再接続'],
        category: 'network',
        ticketRef: 'OPS-1001',
      },
    });
    expect(response.statusCode).toBe(200);
    const draft = (response.json() as { draft: { id: string; status: string; steps: string[] } })
      .draft;
    expect(draft.id).toMatch(/^KB-\d+/);
    expect(draft.status).toBe('review');
    expect(draft.steps).toHaveLength(2);
  });

  it('一覧に自分の下書きと承認済みが出る', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/ops/knowledge' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      approver: boolean;
      drafts: { title: string }[];
      approved: unknown[];
    };
    expect(body.approver).toBe(false);
    expect(body.drafts.some((d) => d.title.startsWith(MARK))).toBe(true);
    expect(Array.isArray(body.approved)).toBe(true);
  });
});

describe('⑥ 承認の権限', () => {
  it('承認者でない人は承認できない（403）', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/ops/knowledge',
      payload: { title: `${MARK} 権限テスト`, steps: ['確認する'] },
    });
    const draft = (created.json() as { draft: { serverId: string } }).draft;
    const response = await app.inject({
      method: 'POST',
      url: `/api/ops/knowledge/${draft.serverId}/approve`,
    });
    expect(response.statusCode).toBe(403);
  });

  it('承認者でも自分の下書きは承認できない（職務分掌・403）', async () => {
    await ensureDevUser(['approver', 'helpdesk']);
    const created = await app.inject({
      method: 'POST',
      url: '/api/ops/knowledge',
      payload: { title: `${MARK} 自己承認テスト`, steps: ['確認する'] },
    });
    const draft = (created.json() as { draft: { serverId: string } }).draft;
    const response = await app.inject({
      method: 'POST',
      url: `/api/ops/knowledge/${draft.serverId}/approve`,
    });
    expect(response.statusCode).toBe(403);
  });

  it('別の人の下書きは承認でき、⑦KB に出る', async () => {
    const rows = await sql<{ id: string; kb_no: string }[]>`
      INSERT INTO knowledge (
        kb_no, title, symptom, cause, steps, keywords, status, version,
        author_id, author_email, category
      ) VALUES (
        ${'KB-' + String(Date.now()).slice(-6)}, ${`${MARK} 別の人の下書き`},
        '症状', '原因', '手順1', ARRAY['kw'], 'pending', 1,
        NULL, 'other@example.com', 'other'
      ) RETURNING id, kb_no
    `;
    const row = rows[0];
    if (!row) throw new Error('draft insert failed');
    const response = await app.inject({
      method: 'POST',
      url: `/api/ops/knowledge/${row.id}/approve`,
    });
    expect(response.statusCode).toBe(200);
    const kb = (response.json() as { kb: { status: string; approvedBy: string } }).kb;
    expect(kb.status).toBe('active');
    expect(kb.approvedBy).toBe(DEV);

    const list = await app.inject({ method: 'GET', url: '/api/ops/knowledge' });
    const body = list.json() as { approved: { title: string }[] };
    expect(body.approved.some((k) => k.title.startsWith(MARK))).toBe(true);
  });
});

describe('監査ログ', () => {
  it('下書き作成・承認が監査に出る', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/ops/audit' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { items: { action: string }[] };
    const actions = body.items.map((i) => i.action);
    expect(actions).toContain('ops.knowledge.draft');
    expect(actions).toContain('ops.knowledge.approve');
  });
});
