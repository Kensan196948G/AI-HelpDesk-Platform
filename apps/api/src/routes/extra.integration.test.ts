import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

async function call(
  session: CookieJar,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  payload?: Record<string, unknown>,
  headers?: Record<string, string>,
) {
  return app.inject({
    method,
    url,
    headers: { cookie: session.cookie, ...(headers ?? {}) },
    ...(method === 'GET' ? {} : { payload: payload ?? {} }),
  });
}

async function createHandoffCase(requester: CookieJar, helpdesk: CookieJar) {
  const createdRes = await call(requester, 'POST', '/api/cases', {
    category: 'file_share',
    subject: `共有フォルダが開けません（extra ${suffix}）`,
    body: 'アクセスが拒否されます。保存に失敗します。',
    urgency: 'normal',
    pcEnabled: true,
  });
  expect(createdRes.statusCode, createdRes.body).toBe(200);
  const created = createdRes.json();
  const handoffRes = await call(requester, 'POST', `/api/cases/${created.case.id}/handoff`, {
    sharedFields: ['consultation', 'ai', 'device', 'pc'],
  });
  expect(handoffRes.statusCode, handoffRes.body).toBe(200);
  const ticketId = handoffRes.json().case.ticket.id as string;
  const assignRes = await call(helpdesk, 'PATCH', `/api/tickets/${ticketId}`, {
    status: 'in_progress',
  });
  expect(assignRes.statusCode, assignRes.body).toBe(200);
  return { caseId: created.case.id as string, ticketId };
}

beforeAll(async () => {
  app = await buildServer({ logger: false });
  await app.ready();
  password = process.env.SEED_PASSWORD ?? '';
  expect(password).not.toBe('');
  suffix = Date.now().toString(36);
});

afterAll(async () => {
  await app.close();
});

describe('追加の API integration', () => {
  it('AIで解決した場合は step 7・青信号・チケットなしになる', async () => {
    const requester = await login('yamada@example.com');
    const createdRes = await call(requester, 'POST', '/api/cases', {
      category: 'file_share',
      subject: `共有フォルダが開けません（resolve ${suffix}）`,
      body: 'アクセスが拒否されます。',
      urgency: 'normal',
      pcEnabled: true,
    });
    expect(createdRes.statusCode, createdRes.body).toBe(200);
    const created = createdRes.json();
    expect(created.assessment.sources.length).toBeGreaterThan(0);
    expect(created.case.signal).toBe('blue');

    const resolveRes = await call(requester, 'POST', `/api/cases/${created.case.id}/resolve`, {});
    expect(resolveRes.statusCode, resolveRes.body).toBe(200);
    const resolved = resolveRes.json().case;
    expect(resolved.status).toBe('ai_resolved');
    expect(resolved.currentStep).toBe(7);
    expect(resolved.signal).toBe('blue');
    expect(resolved.aiResolved).toBe(true);
    expect(resolved.ticket).toBeNull();
  });

  it('ナレッジを差戻し→修正→再申請→承認できる', async () => {
    const requester = await login('yamada@example.com');
    const helpdesk = await login('sato@example.com');
    const approver = await login('watanabe@example.com');
    const { caseId, ticketId } = await createHandoffCase(requester, helpdesk);

    const resolutionRes = await call(helpdesk, 'POST', `/api/tickets/${ticketId}/resolution`, {
      cause: 'セキュリティグループ未所属。',
      steps: '1. ACL確認\n2. グループ追加',
      durationMin: 15,
    });
    expect(resolutionRes.statusCode, resolutionRes.body).toBe(200);

    const draftRes = await call(helpdesk, 'POST', `/api/cases/${caseId}/knowledge-draft`);
    expect(draftRes.statusCode, draftRes.body).toBe(200);
    const knowledgeId = draftRes.json().knowledge.id as string;

    const submitRes = await call(helpdesk, 'POST', `/api/knowledge/${knowledgeId}/submit`);
    expect(submitRes.statusCode, submitRes.body).toBe(200);

    const rejectRes = await call(approver, 'POST', `/api/knowledge/${knowledgeId}/review`, {
      decision: 'rejected',
      comment: '手順3を具体化してください。',
      checklist: {
        reproducible: false,
        noSecrets: true,
        noBlame: true,
        scopeClear: false,
      },
    });
    expect(rejectRes.statusCode, rejectRes.body).toBe(200);
    expect(rejectRes.json().knowledge.status).toBe('rejected');
    expect(rejectRes.json().case.status).toBe('knowledge_pending');

    const patchRes = await call(helpdesk, 'PATCH', `/api/knowledge/${knowledgeId}`, {
      title: `共有フォルダの確認手順（改訂 ${suffix}）`,
      steps: '1. ACL確認\n2. グループ追加\n3. 再接続と保存確認',
    });
    expect(patchRes.statusCode, patchRes.body).toBe(200);
    expect(patchRes.json().knowledge.title).toContain('改訂');

    const resubmit = await call(helpdesk, 'POST', `/api/knowledge/${knowledgeId}/submit`);
    expect(resubmit.statusCode, resubmit.body).toBe(200);
    expect(resubmit.json().knowledge.status).toBe('pending');

    const approveRes = await call(approver, 'POST', `/api/knowledge/${knowledgeId}/review`, {
      decision: 'approved',
      comment: '修正を確認しました。',
      checklist: {
        reproducible: true,
        noSecrets: true,
        noBlame: true,
        scopeClear: true,
      },
    });
    expect(approveRes.statusCode, approveRes.body).toBe(200);
    expect(approveRes.json().knowledge.status).toBe('approved');
    expect(approveRes.json().case.status).toBe('completed');
  });

  it('ログアウト後はセッションが無効になる', async () => {
    const session = await login('yamada@example.com');
    const meBefore = await call(session, 'GET', '/api/auth/me');
    expect(meBefore.statusCode).toBe(200);

    const logoutRes = await call(session, 'POST', '/api/auth/logout');
    expect(logoutRes.statusCode).toBe(200);

    const meAfter = await call(session, 'GET', '/api/auth/me');
    expect(meAfter.statusCode).toBe(401);
  });

  it('health と dashboard が応答し、承認者は担当者操作をできない', async () => {
    const approver = await login('watanabe@example.com');
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json().ok).toBe(true);
    expect(health.json().db).toBe('ok');

    const dashboard = await call(approver, 'GET', '/api/dashboard');
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json().role).toBe('approver');
    expect(dashboard.json().counts.total).toBeGreaterThan(0);

    const queue = await call(approver, 'GET', '/api/desk/queue');
    expect(queue.statusCode).toBe(200);
    expect(queue.json().tickets.length).toBeGreaterThan(0);
    const ticketId = queue.json().tickets[0].ticketId as string;
    const denied = await call(approver, 'PATCH', `/api/tickets/${ticketId}`, {
      status: 'in_progress',
    });
    expect(denied.statusCode).toBe(403);
  });

  it('入力バリデーション: 件名なし・不正カテゴリは 400', async () => {
    const requester = await login('yamada@example.com');
    const empty = await call(requester, 'POST', '/api/cases', {
      category: 'file_share',
      subject: '',
      body: '内容',
      urgency: 'normal',
      pcEnabled: false,
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error.code).toBe('VALIDATION_ERROR');

    const invalid = await call(requester, 'POST', '/api/cases', {
      category: 'not-a-category',
      subject: '件名',
      body: '内容',
      urgency: 'normal',
      pcEnabled: false,
    });
    expect(invalid.statusCode).toBe(400);
  });
});
