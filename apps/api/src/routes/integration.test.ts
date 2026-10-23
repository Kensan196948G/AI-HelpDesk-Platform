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
) {
  return app.inject({
    method,
    url,
    headers: { cookie: session.cookie },
    ...(method === 'GET' ? {} : { payload: payload ?? {} }),
  });
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

describe('主要3 Flow（API integration）', () => {
  it('相談作成→AI一次対応→引継ぎ→担当→解決→ナレッジ→承認まで完了する', async () => {
    const requester = await login('yamada@example.com');
    const helpdesk = await login('sato@example.com');
    const approver = await login('watanabe@example.com');

    const createdRes = await call(requester, 'POST', '/api/cases', {
      category: 'file_share',
      subject: `共有フォルダが開けません（integration ${suffix}）`,
      body: '連絡先は integration@example.com、電話 090-1234-5678 です。保存に失敗します。',
      urgency: 'normal',
      pcEnabled: true,
    });
    expect(createdRes.statusCode, createdRes.body).toBe(200);
    const created = createdRes.json();
    const caseId = created.case.id as string;
    expect(created.case.body).not.toContain('integration@example.com');
    expect(created.case.body).toContain('[メールアドレス]');
    expect(created.assessment.sources.length).toBeGreaterThan(0);
    expect(created.case.signal).toBe('blue');
    expect(created.case.pc.itemCount).toBe(31);

    const beforeShare = await call(helpdesk, 'GET', `/api/cases/${caseId}`);
    expect(beforeShare.statusCode).toBe(200);
    expect(beforeShare.json().case.pc.visible).toBe(false);

    const handoffRes = await call(requester, 'POST', `/api/cases/${caseId}/handoff`, {
      sharedFields: ['consultation', 'ai', 'device', 'pc'],
    });
    expect(handoffRes.statusCode, handoffRes.body).toBe(200);
    const handoff = handoffRes.json();
    expect(handoff.case.status).toBe('in_progress');
    expect(handoff.case.signal).toBe('amber');
    const ticketId = handoff.case.ticket.id as string;

    const afterShare = await call(helpdesk, 'GET', `/api/cases/${caseId}`);
    expect(afterShare.json().case.pc.visible).toBe(true);

    const queueRes = await call(helpdesk, 'GET', '/api/desk/queue');
    expect(queueRes.statusCode).toBe(200);
    expect(queueRes.json().tickets.some((ticket: any) => ticket.id === caseId)).toBe(true);

    const assignRes = await call(helpdesk, 'PATCH', `/api/tickets/${ticketId}`, {
      status: 'in_progress',
    });
    expect(assignRes.statusCode, assignRes.body).toBe(200);

    const resolutionRes = await call(helpdesk, 'POST', `/api/tickets/${ticketId}/resolution`, {
      cause: '共有フォルダのセキュリティグループに所属していなかったため。',
      steps: '1. ACL確認\n2. グループ追加\n3. 再接続確認',
      durationMin: 25,
    });
    expect(resolutionRes.statusCode, resolutionRes.body).toBe(200);
    expect(resolutionRes.json().case.status).toBe('knowledge_pending');
    expect(resolutionRes.json().case.currentStep).toBe(6);

    const draftRes = await call(helpdesk, 'POST', `/api/cases/${caseId}/knowledge-draft`);
    expect(draftRes.statusCode, draftRes.body).toBe(200);
    const knowledgeId = draftRes.json().knowledge.id as string;
    expect(draftRes.json().knowledge.status).toBe('draft');

    const submitRes = await call(helpdesk, 'POST', `/api/knowledge/${knowledgeId}/submit`);
    expect(submitRes.statusCode, submitRes.body).toBe(200);
    expect(submitRes.json().knowledge.status).toBe('pending');

    const helpdeskReview = await call(helpdesk, 'POST', `/api/knowledge/${knowledgeId}/review`, {
      decision: 'approved',
      comment: '',
      checklist: {
        reproducible: true,
        noSecrets: true,
        noBlame: true,
        scopeClear: true,
      },
    });
    expect(helpdeskReview.statusCode).toBe(403);

    const approveRes = await call(approver, 'POST', `/api/knowledge/${knowledgeId}/review`, {
      decision: 'approved',
      comment: '確認しました。',
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
    expect(approveRes.json().case.currentStep).toBe(7);

    const auditRes = await call(approver, 'POST', '/api/audit/verify');
    expect(auditRes.statusCode).toBe(200);
    expect(auditRes.json().ok).toBe(true);
  });

  it('セキュリティ案件は赤信号でAI解決できず、担当者へ渡す', async () => {
    const requester = await login('yamada@example.com');
    const createdRes = await call(requester, 'POST', '/api/cases', {
      category: 'security',
      subject: `不審なメールを開いた（integration ${suffix}）`,
      body: '添付ファイルを開いてしまいました。',
      urgency: 'normal',
      pcEnabled: false,
    });
    expect(createdRes.statusCode).toBe(200);
    const created = createdRes.json();
    expect(created.case.signal).toBe('red');
    expect(created.assessment.security).toBe(true);
    expect(created.assessment.recommendHandoff).toBe(true);

    const resolveRes = await call(requester, 'POST', `/api/cases/${created.case.id}/resolve`, {});
    expect(resolveRes.statusCode).toBe(409);
  });

  it('他人の案件は参照できず、相談者は担当者メニューを使えない', async () => {
    const requester = await login('yamada@example.com');
    const other = await login('kimura@example.com');
    const createdRes = await call(requester, 'POST', '/api/cases', {
      category: 'procedure',
      subject: `経費精算の手順（integration ${suffix}）`,
      body: '経費精算の手順を確認したいです。',
      urgency: 'normal',
      pcEnabled: false,
    });
    expect(createdRes.statusCode).toBe(200);
    const caseId = createdRes.json().case.id as string;

    const forbidden = await call(other, 'GET', `/api/cases/${caseId}`);
    expect(forbidden.statusCode).toBe(404);

    const queue = await call(requester, 'GET', '/api/desk/queue');
    expect(queue.statusCode).toBe(403);
  });
});
