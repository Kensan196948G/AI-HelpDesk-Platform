import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { sql } from '../db.js';
import { resetRateLimits } from '../lib/rate-limit.js';
import { buildServer } from '../server.js';

let app: FastifyInstance;

const CASE_ID = 'CASE-H1';

function coworkState() {
  return {
    v: 31,
    ui: { user: 'u1', screen: 'home' },
    counters: { case: 1, ticket: 1, prop: 1 },
    cases: [
      {
        id: CASE_ID,
        userId: 'u1',
        chatId: 'chat-h1',
        subject: '共有フォルダが開けません',
        body: '異動後に開けなくなりました。',
        step: 4,
        pc: {
          state: 'done',
          snap: {
            items: [{ grp: 'ネットワーク', k: '共有フォルダ', v: 'アクセス不可', lv: 'ng' }],
          },
        },
      },
    ],
    chats: [
      {
        id: 'chat-h1',
        userId: 'u1',
        title: '共有フォルダ',
        messages: [{ id: 'm1', kind: 'user', text: '共有フォルダが開けません' }],
      },
    ],
    tickets: [
      {
        id: 'TKT-2026-9001',
        chatId: 'chat-h1',
        incId: 'INC-9001',
        userId: 'u1',
        status: '受付',
        assigneeLabel: 'DX推進部 / 佐藤 奨太',
      },
    ],
    proposals: {},
    audit: [],
  };
}

function helpdeskState() {
  return {
    actor: '佐藤 奨太',
    seq: { inc: 9001, draft: 1, kb: 1 },
    tickets: [
      {
        id: 'INC-9001',
        coworkTicket: 'TKT-2026-9001',
        status: 'escalated',
      },
    ],
    drafts: [],
    kb: [],
    audit: [],
  };
}

beforeAll(async () => {
  resetRateLimits();
  app = await buildServer({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await sql`DELETE FROM case_handovers WHERE case_id = ${CASE_ID}`;
  await sql`DELETE FROM prototype_states WHERE user_email = ${config.DEV_AUTH_EMAIL}`;
  await app.close();
});

describe('案件引継ぎ API', () => {
  it('A の案件を DX グループへ共有し、B の状態へマージして AI 追加質問できる', async () => {
    resetRateLimits();
    const email = config.DEV_AUTH_EMAIL;

    const putCowork = await app.inject({
      method: 'PUT',
      url: '/api/state/cowork',
      payload: { data: coworkState() },
    });
    expect(putCowork.statusCode, putCowork.body).toBe(200);
    const putHelpdesk = await app.inject({
      method: 'PUT',
      url: '/api/state/helpdesk',
      payload: { data: helpdeskState() },
    });
    expect(putHelpdesk.statusCode, putHelpdesk.body).toBe(200);

    const shared = await app.inject({
      method: 'POST',
      url: '/api/case-handovers',
      payload: { caseId: CASE_ID, assigneeHint: 'DX推進部 / 佐藤 奨太' },
    });
    expect(shared.statusCode, shared.body).toBe(200);
    const handoverId = shared.json().handover.id as string;
    expect(handoverId).toMatch(/^[0-9a-f-]{36}$/);

    const inbox = await app.inject({ method: 'GET', url: '/api/case-handovers/inbox' });
    expect(inbox.statusCode, inbox.body).toBe(200);
    const item = inbox.json().items.find((entry: { caseId: string }) => entry.caseId === CASE_ID);
    expect(item).toBeDefined();
    expect(item.subject).toContain('共有フォルダ');

    const claimed = await app.inject({
      method: 'POST',
      url: `/api/case-handovers/${handoverId}/claim`,
      payload: {},
    });
    expect(claimed.statusCode, claimed.body).toBe(200);

    const state = await app.inject({ method: 'GET', url: '/api/state' });
    expect(state.statusCode, state.body).toBe(200);
    const body = state.json();
    expect(body.cowork.ui.case).toBe(CASE_ID);
    expect(body.cowork.cases[0].id).toBe(CASE_ID);
    expect(body.cowork.cases[0].shared).toBe(true);
    expect(body.cowork.cases[0].handoverId).toBe(handoverId);
    expect(body.cowork.chats[0].id).toBe('chat-h1');
    expect(body.cowork.tickets[0].id).toBe('TKT-2026-9001');
    expect(body.helpdesk.tickets[0].id).toBe('INC-9001');
    expect(body.helpdesk.seq.inc).toBeGreaterThanOrEqual(9002);

    const answer = await app.inject({
      method: 'POST',
      url: '/api/ai/answer-case',
      payload: { caseId: CASE_ID, text: '次に確認すべきことは？' },
    });
    expect(answer.statusCode, answer.body).toBe(200);
    const answerBody = answer.json();
    expect(answerBody.answer.length).toBeGreaterThan(0);
    expect(['fallback', 'deepseek']).toContain(answerBody.provider);

    // 同じ案件をもう一度共有すると、進行中の行は置き換わる（重複しない）。
    const reShared = await app.inject({
      method: 'POST',
      url: '/api/case-handovers',
      payload: { caseId: CASE_ID },
    });
    expect(reShared.statusCode, reShared.body).toBe(200);
    const rows = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM case_handovers
      WHERE case_id = ${CASE_ID} AND owner_email = ${email}
        AND status IN ('pending', 'claimed')
    `;
    expect(Number(rows[0]?.count ?? 0)).toBe(1);
  });

  it('宛先は DX 推進部の名簿から選択し、名簿にない宛先は受け付けない', async () => {
    resetRateLimits();
    const recipients = await app.inject({ method: 'GET', url: '/api/case-handovers/recipients' });
    expect(recipients.statusCode, recipients.body).toBe(200);
    const body = recipients.json();
    expect(body.group).toBe('DX推進部');
    expect(Array.isArray(body.members)).toBe(true);
    for (const member of body.members) {
      expect(member.section).toBe('DX推進部');
      expect(member.email).toBeUndefined();
    }

    // 名簿に無い宛先（自由入力の氏名など）は指名として受け付けない。
    const rejected = await app.inject({
      method: 'POST',
      url: '/api/case-handovers',
      payload: { caseId: CASE_ID, recipientNo: 'NOT-IN-DIRECTORY' },
    });
    expect(rejected.statusCode, rejected.body).not.toBe(200);
    expect(['INVALID_RECIPIENT', 'DIRECTORY_UNAVAILABLE']).toContain(rejected.json().error.code);
  });

  it('ナレッジ承認は DX 推進部の担当者が行い、引き受け前は承認できない', async () => {
    resetRateLimits();
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM case_handovers
      WHERE case_id = ${CASE_ID} AND status = 'pending'
      ORDER BY created_at DESC
      LIMIT 1
    `;
    const pendingId = rows[0]?.id;
    expect(pendingId, '前のテストが作った pending の引継ぎ').toBeDefined();

    // 引き受けていない案件は承認できない。
    const beforeClaim = await app.inject({
      method: 'POST',
      url: `/api/case-handovers/${pendingId}/approve`,
      payload: {},
    });
    expect(beforeClaim.statusCode, beforeClaim.body).toBe(409);
    expect(beforeClaim.json().error.code).toBe('NOT_CLAIMED');

    const claimed = await app.inject({
      method: 'POST',
      url: `/api/case-handovers/${pendingId}/claim`,
      payload: {},
    });
    expect(claimed.statusCode, claimed.body).toBe(200);

    const approved = await app.inject({
      method: 'POST',
      url: `/api/case-handovers/${pendingId}/approve`,
      payload: { note: 'チェックリスト確認済み' },
    });
    expect(approved.statusCode, approved.body).toBe(200);
    const handover = approved.json().handover;
    expect(handover.status).toBe('completed');
    expect(handover.approvedBy).toBe(config.DEV_AUTH_EMAIL);
    expect(typeof handover.approvedByName).toBe('string');
    // 同一ログインのデモなので対応者と承認者が同じ。黙って通さず自己承認として記録する。
    expect(handover.selfApproved).toBe(true);

    const stored = await sql<{ status: string; self_approved: boolean }[]>`
      SELECT status, self_approved FROM case_handovers WHERE id = ${pendingId}
    `;
    expect(stored[0]?.status).toBe('completed');
    expect(stored[0]?.self_approved).toBe(true);
  });
});
