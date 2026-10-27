import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { sql } from '../db.js';
import { resetRateLimits } from '../lib/rate-limit.js';
import { buildServer } from '../server.js';

let app: FastifyInstance;
let seq = 0;

const AUTHOR = 'f06-author@example.com';
const APPROVER = 'f06-approver@example.com';
const PREFIX = 'CASE-F06-';
const originalDevEmail = config.DEV_AUTH_EMAIL;
const originalAllowSelfApproval = config.ALLOW_SELF_APPROVAL;

function as(email: string): void {
  config.DEV_AUTH_EMAIL = email;
}

function draftBody(caseId: string, overrides: Record<string, unknown> = {}) {
  return {
    caseId,
    title: '共有フォルダを開けないときの確認手順',
    symptom: '共有フォルダを開くとアクセスが拒否されます。',
    cause: 'セキュリティグループに所属していないため。',
    steps: '1. ACL を確認する\n2. グループを追加する\n3. 再接続を確認する',
    keywords: ['共有フォルダ', 'アクセス拒否'],
    ...overrides,
  };
}

async function createDraft(caseId: string, overrides: Record<string, unknown> = {}) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/knowledge/drafts',
    payload: draftBody(caseId, overrides),
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json() as { id: string; kbNo: string; status: string };
}

async function submit(id: string) {
  return app.inject({ method: 'POST', url: `/api/knowledge/drafts/${id}/submit`, payload: {} });
}

async function approve(id: string, checklist = [true, true, true, true]) {
  return app.inject({
    method: 'POST',
    url: `/api/knowledge/drafts/${id}/approve`,
    payload: { checklist },
  });
}

/** claimed_by を指定した引継ぎ行を作る（自己承認判定用）。 */
async function insertHandover(claimedBy: string): Promise<string> {
  seq += 1;
  const caseId = `${PREFIX}H${seq}`;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO case_handovers (case_id, owner_email, status, claimed_by, snapshot)
    VALUES (${caseId}, ${claimedBy}, 'claimed', ${claimedBy}, '{}'::jsonb)
    RETURNING id
  `;
  const id = rows[0]?.id;
  expect(id, '引継ぎの作成').toBeDefined();
  return id as string;
}

beforeAll(async () => {
  resetRateLimits();
  await sql`DELETE FROM knowledge WHERE external_case_id LIKE ${`${PREFIX}%`}`;
  await sql`DELETE FROM case_handovers WHERE case_id LIKE ${`${PREFIX}%`}`;
  app = await buildServer({ logger: false });
  await app.ready();
});

beforeEach(() => {
  resetRateLimits();
  config.DEV_AUTH_EMAIL = originalDevEmail;
  config.ALLOW_SELF_APPROVAL = originalAllowSelfApproval;
});

afterAll(async () => {
  config.DEV_AUTH_EMAIL = originalDevEmail;
  config.ALLOW_SELF_APPROVAL = originalAllowSelfApproval;
  await sql`DELETE FROM knowledge WHERE external_case_id LIKE ${`${PREFIX}%`}`;
  await sql`DELETE FROM case_handovers WHERE case_id LIKE ${`${PREFIX}%`}`;
  await app.close();
});

describe('ナレッジ下書き・承認 API（F-06 サーバ側）', () => {
  it('作成→pending→別IDで承認でき、監査が1行残る', async () => {
    const caseId = `${PREFIX}A${Date.now().toString(36)}`;
    as(AUTHOR);
    const created = await createDraft(caseId);
    expect(created.status).toBe('draft');
    expect(created.kbNo).toMatch(/^KB-\d{4}-\d{4,}$/);
    // seed の KB-2026-0001..0009 と衝突しない。
    expect(Number(created.kbNo.split('-')[2])).toBeGreaterThan(9);

    as(APPROVER);
    const draftPending = await app.inject({ method: 'GET', url: '/api/knowledge/pending' });
    expect(draftPending.statusCode, draftPending.body).toBe(200);
    const draftItem = (
      draftPending.json().items as Array<{ id: string; status: string; authorEmail: string }>
    ).find((item) => item.id === created.id);
    expect(draftItem?.status).toBe('draft');
    expect(draftItem?.authorEmail).toBe(AUTHOR);

    as(AUTHOR);
    const submitted = await submit(created.id);
    expect(submitted.statusCode, submitted.body).toBe(200);
    expect(submitted.json().status).toBe('review');

    as(APPROVER);
    const reviewPending = await app.inject({ method: 'GET', url: '/api/knowledge/pending' });
    const reviewItem = (reviewPending.json().items as Array<{ id: string; status: string }>).find(
      (item) => item.id === created.id,
    );
    expect(reviewItem?.status).toBe('review');

    const approved = await approve(created.id);
    expect(approved.statusCode, approved.body).toBe(200);
    const approvedBody = approved.json();
    expect(approvedBody.status).toBe('approved');
    expect(approvedBody.selfApproved).toBe(false);
    expect(approvedBody.approverEmail).toBe(APPROVER);
    expect(approvedBody.version).toBe(2);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/knowledge/drafts/${created.id}`,
    });
    expect(detail.statusCode, detail.body).toBe(200);
    const draft = detail.json().draft;
    expect(draft.status).toBe('approved');
    expect(draft.approverEmail).toBe(APPROVER);
    expect(draft.checklist).toEqual([true, true, true, true]);
    expect(draft.selfApproved).toBe(false);

    const audits = await sql<
      { action: string; detail: Record<string, unknown>; created_at: Date }[]
    >`
      SELECT action, detail, created_at FROM audit_log
      WHERE target_type = 'knowledge'
        AND target_id = ${created.id}
        AND action = 'knowledge.approve'
      ORDER BY id ASC
    `;
    expect(audits, '承認1回につき監査1行').toHaveLength(1);
    expect(audits[0]?.detail.actorEmail).toBe(APPROVER);
    expect(audits[0]?.detail.caseId).toBe(caseId);
    expect(audits[0]?.detail.kbNo).toBe(created.kbNo);
    expect(audits[0]?.detail.selfApproved).toBe(false);
    expect(audits[0]?.created_at).toBeInstanceOf(Date);
  });

  it('チェックリストが4件すべて true でないと 400', async () => {
    const caseId = `${PREFIX}B${Date.now().toString(36)}`;
    as(AUTHOR);
    const created = await createDraft(caseId);
    expect((await submit(created.id)).statusCode).toBe(200);

    as(APPROVER);
    const denied = await approve(created.id, [true, true, true, false]);
    expect(denied.statusCode, denied.body).toBe(400);

    const missing = await app.inject({
      method: 'POST',
      url: `/api/knowledge/drafts/${created.id}/approve`,
      payload: { checklist: [true, true, true] },
    });
    expect(missing.statusCode).toBe(400);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/knowledge/drafts/${created.id}`,
    });
    expect(detail.json().draft.status).toBe('review');
    const audits = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM audit_log
      WHERE target_type = 'knowledge' AND target_id = ${created.id}
        AND action = 'knowledge.approve'
    `;
    expect(audits[0]?.n).toBe(0);
  });

  it('ALLOW_SELF_APPROVAL=false では自己承認が 403、true なら self_approved=true', async () => {
    const handoverId = await insertHandover(AUTHOR);
    const caseId = `${PREFIX}C${Date.now().toString(36)}`;

    as(AUTHOR);
    const created = await createDraft(caseId, { handoverId });
    expect((await submit(created.id)).statusCode).toBe(200);

    config.ALLOW_SELF_APPROVAL = false;
    const denied = await approve(created.id);
    expect(denied.statusCode, denied.body).toBe(403);
    expect(denied.json().error.code).toBe('SELF_APPROVAL_FORBIDDEN');

    const still = await app.inject({
      method: 'GET',
      url: `/api/knowledge/drafts/${created.id}`,
    });
    expect(still.json().draft.status).toBe('review');

    config.ALLOW_SELF_APPROVAL = true;
    const allowed = await approve(created.id);
    expect(allowed.statusCode, allowed.body).toBe(200);
    expect(allowed.json().selfApproved).toBe(true);
    const stored = await sql<{ self_approved: boolean; status: string }[]>`
      SELECT self_approved, status FROM knowledge WHERE id = ${created.id}
    `;
    expect(stored[0]?.status).toBe('approved');
    expect(stored[0]?.self_approved).toBe(true);
  });

  it('reject は理由必須で、成功すると rejected と監査1行になる', async () => {
    const caseId = `${PREFIX}D${Date.now().toString(36)}`;
    as(AUTHOR);
    const created = await createDraft(caseId);
    expect((await submit(created.id)).statusCode).toBe(200);

    as(APPROVER);
    const missing = await app.inject({
      method: 'POST',
      url: `/api/knowledge/drafts/${created.id}/reject`,
      payload: {},
    });
    expect(missing.statusCode).toBe(400);

    const rejected = await app.inject({
      method: 'POST',
      url: `/api/knowledge/drafts/${created.id}/reject`,
      payload: { reason: '再現手順が不足しています。' },
    });
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(rejected.json().status).toBe('rejected');

    const auditCount = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM audit_log
      WHERE target_type = 'knowledge' AND target_id = ${created.id}
        AND action = 'knowledge.reject'
    `;
    expect(auditCount[0]?.n).toBe(1);
    const auditRows = await sql<{ detail: Record<string, unknown> }[]>`
      SELECT detail FROM audit_log
      WHERE target_type = 'knowledge' AND target_id = ${created.id}
        AND action = 'knowledge.reject'
      ORDER BY id ASC LIMIT 1
    `;
    expect(auditRows[0]?.detail.reason).toBe('再現手順が不足しています。');
  });
});
