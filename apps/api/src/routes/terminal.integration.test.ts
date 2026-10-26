import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../config.js';
import { sql } from '../db.js';
import { resetRateLimits } from '../lib/rate-limit.js';
import { buildServer } from '../server.js';

let app: FastifyInstance;
let fetchMock: ReturnType<typeof vi.fn>;
const originalDevEmail = config.DEV_AUTH_EMAIL;
const originalApiKey = config.DEEPSEEK_API_KEY;

const CASE_A = 'CASE-TERM-A';
const CASE_B = 'CASE-TERM-B';
const CASES = [CASE_A, CASE_B];
const OPERATOR = config.DEV_AUTH_EMAIL;
const STRANGER = 'stranger-terminal@example.com';

function coworkState(caseId: string) {
  return {
    v: 31,
    ui: { user: 'u1', screen: 'home' },
    counters: { case: 1, ticket: 1, prop: 1 },
    cases: [
      {
        id: caseId,
        userId: 'u1',
        chatId: `chat-${caseId}`,
        subject: 'プリンタで印刷できない',
        body: '印刷キューが止まっています。',
        cat: 'device',
        urgency: 'urgent',
        createdAt: '2026-10-26T00:00:00.000Z',
        step: 4,
        pc: {
          state: 'done',
          snap: {
            at: '2026-10-26T00:10:00.000Z',
            device: 'MRK-NB-1000',
            items: [{ grp: '周辺機器', k: '印刷スプーラ', v: '停止', lv: 'ng' }],
          },
        },
      },
    ],
    chats: [
      {
        id: `chat-${caseId}`,
        userId: 'u1',
        title: '印刷',
        messages: [{ id: 'm1', kind: 'user', text: '印刷できません' }],
      },
    ],
    tickets: [
      {
        id: `TKT-${caseId}`,
        chatId: `chat-${caseId}`,
        incId: `INC-${caseId}`,
        userId: 'u1',
        status: '受付',
      },
    ],
    proposals: {},
    audit: [],
  };
}

function helpdeskState(caseId: string) {
  return {
    actor: '佐藤 奨太',
    seq: { inc: 9001, draft: 1, kb: 1 },
    tickets: [{ id: `INC-${caseId}`, coworkTicket: `TKT-${caseId}`, status: 'escalated' }],
    drafts: [],
    kb: [],
    audit: [],
  };
}

async function setupClaimedHandover(caseId: string): Promise<string> {
  const putCowork = await app.inject({
    method: 'PUT',
    url: '/api/state/cowork',
    payload: { data: coworkState(caseId) },
  });
  expect(putCowork.statusCode, putCowork.body).toBe(200);
  const putHelpdesk = await app.inject({
    method: 'PUT',
    url: '/api/state/helpdesk',
    payload: { data: helpdeskState(caseId) },
  });
  expect(putHelpdesk.statusCode, putHelpdesk.body).toBe(200);
  const shared = await app.inject({
    method: 'POST',
    url: '/api/case-handovers',
    payload: { caseId },
  });
  expect(shared.statusCode, shared.body).toBe(200);
  const handoverId = shared.json().handover.id as string;
  const claimed = await app.inject({
    method: 'POST',
    url: `/api/case-handovers/${handoverId}/claim`,
    payload: {},
  });
  expect(claimed.statusCode, claimed.body).toBe(200);
  return handoverId;
}

let reportIds: string[] = [];
let knowledgeIds: string[] = [];

beforeAll(async () => {
  app = await buildServer({ logger: false });
  await app.ready();
});

beforeEach(async () => {
  resetRateLimits();
  config.DEV_AUTH_EMAIL = OPERATOR;
  config.DEEPSEEK_API_KEY = 'test-key';
  fetchMock = vi.fn(async () => {
    const content = JSON.stringify({
      command: 'Get-Service Spooler | Select-Object Status,Name',
      purpose: '印刷スプーラの状態を確認する',
      risk: 'low',
      verify: 'Status が Running であること',
      rollback: '不要（読み取りのみ）',
      warnings: ['読み取りのみ。変更は行いません。'],
    });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  await sql`DELETE FROM terminal_sessions WHERE case_id IN ${sql(CASES)}`;
  await sql`DELETE FROM case_handovers WHERE case_id IN ${sql(CASES)}`;
  reportIds = [];
  knowledgeIds = [];
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await sql`DELETE FROM terminal_sessions WHERE case_id IN ${sql(CASES)}`;
  for (const id of reportIds) await sql`DELETE FROM final_reports WHERE id = ${id}`;
  for (const id of knowledgeIds) await sql`DELETE FROM knowledge WHERE id = ${id}`;
  await sql`DELETE FROM case_handovers WHERE case_id IN ${sql(CASES)}`;
  await sql`DELETE FROM prototype_states WHERE user_email = ${OPERATOR}`;
  config.DEV_AUTH_EMAIL = originalDevEmail;
  config.DEEPSEEK_API_KEY = originalApiKey;
  await app.close();
});

describe('RSP実行セッション API', () => {
  it('引き受けていない人・同意なしでは開始できない', async () => {
    await setupClaimedHandover(CASE_A);

    config.DEV_AUTH_EMAIL = STRANGER;
    const stranger = await app.inject({
      method: 'POST',
      url: '/api/terminal/sessions',
      payload: { caseId: CASE_A, consent: { screenShare: true, remoteControl: true } },
    });
    expect(stranger.statusCode).toBe(403);
    expect(stranger.json().error.code).toBe('NOT_CLAIMED_OPERATOR');

    config.DEV_AUTH_EMAIL = OPERATOR;
    const noConsent = await app.inject({
      method: 'POST',
      url: '/api/terminal/sessions',
      payload: { caseId: CASE_A, consent: { screenShare: true, remoteControl: false } },
    });
    expect(noConsent.statusCode).toBe(400);
    expect(noConsent.json().error.code).toBe('CONSENT_REQUIRED');

    const created = await app.inject({
      method: 'POST',
      url: '/api/terminal/sessions',
      payload: { caseId: CASE_A, consent: { screenShare: true, remoteControl: true } },
    });
    expect(created.statusCode, created.body).toBe(200);
    const session = created.json().session;
    expect(session.device).toBe('MRK-NB-1000');
    expect(session.status).toBe('active');
    expect(session.capture.supported).toBe(false);
    expect(session.capture.reason).toContain('手動');
    expect(session.limits.maxSteps).toBe(20);

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/terminal/sessions',
      payload: { caseId: CASE_A, consent: { screenShare: true, remoteControl: true } },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe('SESSION_ACTIVE');

    const listed = await app.inject({
      method: 'GET',
      url: `/api/terminal/sessions?caseId=${CASE_A}`,
    });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().session.id).toBe(session.id);
    expect(listed.json().steps).toEqual([]);
  });

  it('提案→記録→終了→報告書→ナレッジ下書きまで通り、未対応の自動取込は拒否される', async () => {
    const handoverId = await setupClaimedHandover(CASE_B);
    const created = await app.inject({
      method: 'POST',
      url: '/api/terminal/sessions',
      payload: { caseId: CASE_B, consent: { screenShare: true, remoteControl: true } },
    });
    expect(created.statusCode, created.body).toBe(200);
    const sessionId = created.json().session.id as string;

    const proposed = await app.inject({
      method: 'POST',
      url: `/api/terminal/sessions/${sessionId}/steps`,
      payload: { intent: 'スプーラの状態を確認したい' },
    });
    expect(proposed.statusCode, proposed.body).toBe(200);
    const step = proposed.json().step;
    expect(step.seq).toBe(1);
    expect(step.proposal.command).toContain('Get-Service Spooler');
    expect(step.proposal.risk).toBe('low');
    expect(step.proposal.warnings).toHaveLength(1);
    expect(step.executed).toBeNull();
    // AI には案件の文脈（件名・PC情報）が渡る。
    const sent = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? '{}'));
    expect(sent.messages[0].role).toBe('system');
    expect(sent.messages[1].content).toContain('プリンタで印刷できない');
    expect(sent.messages[1].content).toContain('印刷スプーラ');

    const auto = await app.inject({
      method: 'POST',
      url: `/api/terminal/steps/${step.id}/record`,
      payload: {
        command: 'Get-Service Spooler',
        output: 'Running',
        outputSource: 'auto',
        exitStatus: 'success',
      },
    });
    expect(auto.statusCode).toBe(400);
    expect(auto.json().error.code).toBe('CAPTURE_UNAVAILABLE');

    const recorded = await app.inject({
      method: 'POST',
      url: `/api/terminal/steps/${step.id}/record`,
      payload: {
        command: 'Get-Service Spooler',
        output: 'Status Name\nStopped Spooler\n連絡先: user@example.com',
        outputSource: 'manual',
        exitStatus: 'failure',
        note: 'スプーラが停止していた',
      },
    });
    expect(recorded.statusCode, recorded.body).toBe(200);
    const executed = recorded.json().step.executed;
    expect(executed.exitStatus).toBe('failure');
    expect(executed.sha256).toMatch(/^[0-9a-f]{64}$/);
    // 保存前に伏せ字化する。
    expect(executed.output).not.toContain('user@example.com');

    const twice = await app.inject({
      method: 'POST',
      url: `/api/terminal/steps/${step.id}/record`,
      payload: {
        command: 'Get-Service Spooler',
        output: 'again',
        outputSource: 'manual',
        exitStatus: 'success',
      },
    });
    expect(twice.statusCode).toBe(409);
    expect(twice.json().error.code).toBe('STEP_RECORDED');

    const earlyReport = await app.inject({
      method: 'POST',
      url: `/api/terminal/sessions/${sessionId}/report`,
      payload: {},
    });
    expect(earlyReport.statusCode).toBe(409);
    expect(earlyReport.json().error.code).toBe('SESSION_ACTIVE');

    const closed = await app.inject({
      method: 'POST',
      url: `/api/terminal/sessions/${sessionId}/close`,
      payload: { reason: 'resolved', note: 'スプーラ再起動で復旧' },
    });
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json().session.status).toBe('closed');
    expect(closed.json().session.closeReason).toBe('resolved');

    const afterClose = await app.inject({
      method: 'POST',
      url: `/api/terminal/sessions/${sessionId}/steps`,
      payload: { intent: '追加確認' },
    });
    expect(afterClose.statusCode).toBe(409);
    expect(afterClose.json().error.code).toBe('SESSION_CLOSED');

    const report = await app.inject({
      method: 'POST',
      url: `/api/terminal/sessions/${sessionId}/report`,
      payload: {},
    });
    expect(report.statusCode, report.body).toBe(200);
    const reportBody = report.json().report;
    reportIds.push(reportBody.id);
    expect(reportBody.kind).toBe('helpdesk_resolved');
    expect(reportBody.files.html.url).toContain(`/api/reports/final/${reportBody.id}/html`);
    expect(reportBody.files.html.previewUrl).toContain('inline=1');

    const html = await app.inject({ method: 'GET', url: reportBody.files.html.url });
    expect(html.statusCode, html.body).toBe(200);
    expect(html.headers['content-disposition']).toContain('attachment');
    // ブラウザ内表示用は inline（新規タブで開いて読める）。
    const preview = await app.inject({ method: 'GET', url: reportBody.files.html.previewUrl });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.headers['content-disposition']).toContain('inline');
    expect(html.body).toContain('RSP実行セッション');
    expect(html.body).toContain('Get-Service Spooler');
    expect(html.body).toContain('スプーラが停止していた');
    expect(html.body).not.toContain('user@example.com');

    const draft = await app.inject({
      method: 'POST',
      url: `/api/terminal/sessions/${sessionId}/knowledge-draft`,
      payload: {},
    });
    expect(draft.statusCode, draft.body).toBe(200);
    const knowledge = draft.json().knowledge;
    knowledgeIds.push(knowledge.id);
    expect(knowledge.kbNo).toMatch(/^KB-\d{4}-\d+$/);
    expect(knowledge.status).toBe('draft');

    const rows = await sql<{ status: string; kb_no: string; steps: string }[]>`
      SELECT status, kb_no, steps FROM knowledge WHERE id = ${knowledge.id}
    `;
    expect(rows[0]?.status).toBe('draft'); // 自動公開しない
    expect(rows[0]?.steps).toContain('Get-Service Spooler');

    const again = await app.inject({
      method: 'POST',
      url: `/api/terminal/sessions/${sessionId}/knowledge-draft`,
      payload: {},
    });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().knowledge.id).toBe(knowledge.id); // 重複作成しない

    // 再読み込み相当: セッション DTO に kbNo が載る。
    const restored = await app.inject({
      method: 'GET',
      url: `/api/terminal/sessions/${sessionId}`,
    });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(restored.json().session.knowledge.kbNo).toBe(knowledge.kbNo);
    expect(restored.json().session.knowledge.status).toBe('draft');

    // 監査に一連の操作が残る。
    const audit = await sql<{ action: string }[]>`
      SELECT action FROM audit_log
      WHERE target_type = 'terminal_session' AND target_id = ${sessionId}
      ORDER BY id
    `;
    const actions = audit.map((row) => row.action);
    expect(actions).toContain('terminal.session.start');
    expect(actions).toContain('terminal.step.propose');
    expect(actions).toContain('terminal.step.record');
    expect(actions).toContain('terminal.session.close');
    expect(actions).toContain('terminal.report.build');
    expect(actions).toContain('terminal.knowledge.draft');

    // セッションと報告書が紐づく。
    const linked = await sql<{ report_id: string | null; knowledge_id: string | null }[]>`
      SELECT report_id, knowledge_id FROM terminal_sessions WHERE id = ${sessionId}
    `;
    expect(linked[0]?.report_id).toBe(reportBody.id);
    expect(linked[0]?.knowledge_id).toBe(knowledge.id);
    expect(handoverId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
