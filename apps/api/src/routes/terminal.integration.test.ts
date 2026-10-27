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
const originalIntegrationKey = config.RSP_INTEGRATION_KEY;

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
            items: [
              { grp: '周辺機器', k: '印刷スプーラ', v: '停止', lv: 'ng' },
              { grp: 'ネットワーク', k: 'IPアドレス', v: '10.1.2.3', lv: 'ok' },
              { grp: '端末', k: 'シリアル番号', v: 'SN123456', lv: 'ok' },
            ],
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
  config.RSP_INTEGRATION_KEY = undefined;
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
  config.RSP_INTEGRATION_KEY = originalIntegrationKey;
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
    // 実行記録があるセッションの終了には警告を出さない（SM-07）。
    expect(closed.json().warnings).toEqual([]);

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

    // RSP 連携（サービスキー + 操作者メール）でも、作成者本人なら同じ報告書を取得できる。
    const integrationKey = 'k'.repeat(48);
    config.RSP_INTEGRATION_KEY = integrationKey;
    const viaRsp = await app.inject({
      method: 'GET',
      url: reportBody.files.html.previewUrl,
      headers: {
        'x-helpdesk-service-key': integrationKey,
        'x-operator-email': OPERATOR,
      },
    });
    expect(viaRsp.statusCode, viaRsp.body).toBe(200);
    expect(viaRsp.headers['content-disposition']).toContain('inline');
    const notOwner = await app.inject({
      method: 'GET',
      url: reportBody.files.html.previewUrl,
      headers: {
        'x-helpdesk-service-key': integrationKey,
        'x-operator-email': 'other-operator@example.com',
      },
    });
    expect(notOwner.statusCode).toBe(404);
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

  it('RSPコマンドキュー: rsp_command の実出力と相関IDを保存し、報告書に載せる', async () => {
    await setupClaimedHandover(CASE_A);
    const created = await app.inject({
      method: 'POST',
      url: '/api/terminal/sessions',
      payload: { caseId: CASE_A, consent: { screenShare: true, remoteControl: true } },
    });
    expect(created.statusCode, created.body).toBe(200);
    const sessionId = created.json().session.id as string;
    expect(created.json().session.rspSessionId).toBeNull();

    const proposed = await app.inject({
      method: 'POST',
      url: `/api/terminal/sessions/${sessionId}/steps`,
      payload: { intent: 'スプーラの状態をRSPのコマンドキューで確認する' },
    });
    expect(proposed.statusCode, proposed.body).toBe(200);
    const stepId = proposed.json().step.id as string;

    // rsp_command なのに rspCommandLogId が無い記録は 400（どの実行結果か追えないため）。
    const missingLogId = await app.inject({
      method: 'POST',
      url: `/api/terminal/steps/${stepId}/record`,
      payload: {
        command: 'Get-Service Spooler',
        output: 'Running',
        outputSource: 'rsp_command',
        exitStatus: 'success',
      },
    });
    expect(missingLogId.statusCode).toBe(400);
    expect(missingLogId.json().error.code).toBe('VALIDATION_ERROR');

    const recorded = await app.inject({
      method: 'POST',
      url: `/api/terminal/steps/${stepId}/record`,
      payload: {
        command: 'Get-Service Spooler | Select-Object Status,Name',
        output: 'Status Name\nRunning Spooler\n連絡先: user@example.com',
        outputSource: 'rsp_command',
        exitStatus: 'success',
        rspCommandLogId: 'cmdlog-20261026-0001',
        rspSessionId: 'rsess-42',
      },
    });
    expect(recorded.statusCode, recorded.body).toBe(200);
    const body = recorded.json();
    expect(body.step.executed.outputSource).toBe('rsp_command');
    expect(body.step.executed.rspCommandLogId).toBe('cmdlog-20261026-0001');
    expect(body.session.rspSessionId).toBe('rsess-42');
    // 保存前に伏せ字化し、ハッシュはマスク後の値で計算される（既存方針のまま）。
    expect(body.step.executed.output).not.toContain('user@example.com');
    expect(body.step.executed.sha256).toMatch(/^[0-9a-f]{64}$/);

    const savedStep = await sql<
      { rsp_command_log_id: string | null; output: string | null; output_source: string | null }[]
    >`
      SELECT rsp_command_log_id, output, output_source FROM terminal_steps WHERE id = ${stepId}
    `;
    expect(savedStep[0]?.rsp_command_log_id).toBe('cmdlog-20261026-0001');
    expect(savedStep[0]?.output_source).toBe('rsp_command');
    expect(savedStep[0]?.output).not.toContain('user@example.com');
    const savedSession = await sql<{ rsp_session_id: string | null }[]>`
      SELECT rsp_session_id FROM terminal_sessions WHERE id = ${sessionId}
    `;
    expect(savedSession[0]?.rsp_session_id).toBe('rsess-42');

    // 監査には相関IDだけを残す（コマンド・出力本文は入れない）。
    const audit = await sql<
      { detail: { rspCommandLogId?: string | null; rspSessionId?: string | null } | null }[]
    >`
      SELECT detail FROM audit_log
      WHERE action = 'terminal.step.record' AND target_id = ${sessionId}
      ORDER BY id DESC LIMIT 1
    `;
    expect(audit[0]?.detail?.rspCommandLogId).toBe('cmdlog-20261026-0001');
    expect(audit[0]?.detail?.rspSessionId).toBe('rsess-42');

    // 2 回目の record は既存挙動どおり 409。
    const twice = await app.inject({
      method: 'POST',
      url: `/api/terminal/steps/${stepId}/record`,
      payload: {
        command: 'Get-Service Spooler',
        output: 'again',
        outputSource: 'rsp_command',
        exitStatus: 'success',
        rspCommandLogId: 'cmdlog-20261026-0001',
      },
    });
    expect(twice.statusCode).toBe(409);
    expect(twice.json().error.code).toBe('STEP_RECORDED');

    // 相関済みのセッションは、別の rspSessionId で上書きしない（COALESCE）。
    const secondProposal = await app.inject({
      method: 'POST',
      url: `/api/terminal/sessions/${sessionId}/steps`,
      payload: { intent: '追加確認' },
    });
    expect(secondProposal.statusCode, secondProposal.body).toBe(200);
    const secondRecorded = await app.inject({
      method: 'POST',
      url: `/api/terminal/steps/${secondProposal.json().step.id as string}/record`,
      payload: {
        command: 'Get-Service Spooler',
        output: 'Running',
        outputSource: 'rsp_command',
        exitStatus: 'success',
        rspCommandLogId: 'cmdlog-20261026-0002',
        rspSessionId: 'rsess-99',
      },
    });
    expect(secondRecorded.statusCode, secondRecorded.body).toBe(200);
    expect(secondRecorded.json().session.rspSessionId).toBe('rsess-42');

    const fetched = await app.inject({ method: 'GET', url: `/api/terminal/sessions/${sessionId}` });
    expect(fetched.statusCode, fetched.body).toBe(200);
    expect(fetched.json().session.rspSessionId).toBe('rsess-42');
    expect(fetched.json().steps[0].executed.rspCommandLogId).toBe('cmdlog-20261026-0001');

    const closed = await app.inject({
      method: 'POST',
      url: `/api/terminal/sessions/${sessionId}/close`,
      payload: { reason: 'resolved', note: 'RSPのコマンドキューで復旧を確認' },
    });
    expect(closed.statusCode, closed.body).toBe(200);

    const report = await app.inject({
      method: 'POST',
      url: `/api/terminal/sessions/${sessionId}/report`,
      payload: {},
    });
    expect(report.statusCode, report.body).toBe(200);
    const reportBody = report.json().report;
    reportIds.push(reportBody.id);

    const reportRows = await sql<
      {
        payload: {
          terminal?: {
            rspSessionId?: string;
            steps: Array<{ executed?: { rspCommandLogId?: string; outputSource?: string } }>;
          };
        };
      }[]
    >`
      SELECT payload FROM final_reports WHERE id = ${reportBody.id}
    `;
    const payload = reportRows[0]?.payload;
    expect(payload?.terminal?.rspSessionId).toBe('rsess-42');
    expect(payload?.terminal?.steps[0]?.executed?.outputSource).toBe('rsp_command');
    expect(payload?.terminal?.steps[0]?.executed?.rspCommandLogId).toBe('cmdlog-20261026-0001');

    const html = await app.inject({ method: 'GET', url: reportBody.files.html.previewUrl });
    expect(html.statusCode, html.body).toBe(200);
    expect(html.body).toContain('RSPコマンドキューから自動取込');
    expect(html.body).not.toContain('user@example.com');
  });

  it('RSP連携: 共有キーと操作者メールで案件文脈・PC情報・案件一覧を取得できる', async () => {
    await setupClaimedHandover(CASE_A);

    // 画面（Access）経由でも同じ context を取得できる。
    const uiContext = await app.inject({
      method: 'GET',
      url: `/api/terminal/context?caseId=${CASE_A}`,
    });
    expect(uiContext.statusCode, uiContext.body).toBe(200);
    const context = uiContext.json();
    expect(context.case.id).toBe(CASE_A);
    expect(context.requester.email).toBe(OPERATOR);
    expect(context.handover.device).toBe('MRK-NB-1000');
    expect(context.session).toBeNull();
    // PC情報は表示してよいが、IP・シリアルは伏せる。
    const values = context.pc.items.map((item: { k: string; v: string }) => `${item.k}=${item.v}`);
    expect(values).toContain('IPアドレス=[IPアドレス]');
    expect(values).toContain('シリアル番号=[シリアル番号]');
    expect(JSON.stringify(context)).not.toContain('10.1.2.3');
    expect(JSON.stringify(context)).not.toContain('SN123456');

    // 画面に出る INC 番号（ヘルプデスクのチケット）でも同じ案件を引ける。
    const byInc = await app.inject({
      method: 'GET',
      url: `/api/terminal/context?caseId=INC-${CASE_A}`,
    });
    expect(byInc.statusCode, byInc.body).toBe(200);
    expect(byInc.json().case.id).toBe(CASE_A);

    // 統合キー未設定なら 401（fail-closed）。
    const key = 'k'.repeat(48);
    const unset = await app.inject({
      method: 'GET',
      url: `/api/terminal/context?caseId=${CASE_A}`,
      headers: { 'x-helpdesk-service-key': key, 'x-operator-email': OPERATOR },
    });
    expect(unset.statusCode).toBe(401);

    config.RSP_INTEGRATION_KEY = key;
    const wrongKey = await app.inject({
      method: 'GET',
      url: `/api/terminal/context?caseId=${CASE_A}`,
      headers: { 'x-helpdesk-service-key': 'x'.repeat(48), 'x-operator-email': OPERATOR },
    });
    expect(wrongKey.statusCode).toBe(401);

    const missingOperator = await app.inject({
      method: 'GET',
      url: `/api/terminal/context?caseId=${CASE_A}`,
      headers: { 'x-helpdesk-service-key': key },
    });
    expect(missingOperator.statusCode).toBe(401);

    const integration = await app.inject({
      method: 'GET',
      url: `/api/terminal/context?caseId=${CASE_A}`,
      headers: { 'x-helpdesk-service-key': key, 'x-operator-email': OPERATOR },
    });
    expect(integration.statusCode, integration.body).toBe(200);
    expect(integration.json().case.subject).toContain('プリンタ');

    const cases = await app.inject({
      method: 'GET',
      url: '/api/terminal/cases?hostname=mrk-nb-1000',
      headers: { 'x-helpdesk-service-key': key, 'x-operator-email': OPERATOR },
    });
    expect(cases.statusCode, cases.body).toBe(200);
    const item = cases.json().items.find((entry: { caseId: string }) => entry.caseId === CASE_A);
    expect(item).toBeDefined();
    expect(item.session).toBeNull();

    const noMatch = await app.inject({
      method: 'GET',
      url: '/api/terminal/cases?hostname=NO-SUCH-DEVICE',
      headers: { 'x-helpdesk-service-key': key, 'x-operator-email': OPERATOR },
    });
    expect(noMatch.statusCode).toBe(200);
    expect(noMatch.json().items.some((entry: { caseId: string }) => entry.caseId === CASE_A)).toBe(
      false,
    );

    // 統合経路の操作は監査に via=rsp を残す（セッション作成で確認）。
    const created = await app.inject({
      method: 'POST',
      url: '/api/terminal/sessions',
      headers: { 'x-helpdesk-service-key': key, 'x-operator-email': OPERATOR },
      payload: { caseId: CASE_A, consent: { screenShare: false, remoteControl: true } },
    });
    expect(created.statusCode, created.body).toBe(200);
    const audit = await sql<{ detail: unknown }[]>`
      SELECT detail FROM audit_log
      WHERE target_type = 'terminal_session' AND target_id = ${created.json().session.id}
        AND action = 'terminal.session.start'
      LIMIT 1
    `;
    expect((audit[0]?.detail as { via?: string })?.via).toBe('rsp');
  });

  it('本番相当: 統合リクエストはプロキシ秘密なしで通り、公開経路のなりすましは拒否される', async () => {
    await setupClaimedHandover(CASE_B);
    const key = 'k'.repeat(48);
    config.RSP_INTEGRATION_KEY = key;
    const originalRequireProxy = config.REQUIRE_PROXY_SECRET;
    const originalProxySecret = config.PROXY_SECRET;
    config.REQUIRE_PROXY_SECRET = true;
    config.PROXY_SECRET = 'p'.repeat(32);
    try {
      const integration = await app.inject({
        method: 'GET',
        url: `/api/terminal/context?caseId=${CASE_B}`,
        headers: { 'x-helpdesk-service-key': key, 'x-operator-email': OPERATOR },
      });
      expect(integration.statusCode, integration.body).toBe(200);

      const spoof = await app.inject({
        method: 'GET',
        url: `/api/terminal/context?caseId=${CASE_B}`,
        headers: {
          'x-helpdesk-service-key': key,
          'x-operator-email': OPERATOR,
          'x-proxy-secret': config.PROXY_SECRET,
        },
      });
      expect(spoof.statusCode).toBe(403);

      const noProxy = await app.inject({
        method: 'GET',
        url: `/api/terminal/context?caseId=${CASE_B}`,
      });
      expect(noProxy.statusCode).toBe(401);

      const viaProxy = await app.inject({
        method: 'GET',
        url: `/api/terminal/context?caseId=${CASE_B}`,
        headers: { 'x-proxy-secret': config.PROXY_SECRET },
      });
      expect(viaProxy.statusCode, viaProxy.body).toBe(200);
    } finally {
      config.REQUIRE_PROXY_SECRET = originalRequireProxy;
      config.PROXY_SECRET = originalProxySecret;
    }
  });

  it('SM-06: AIが情報不足で辞退した場合は502ではなく200＋理由を返す', async () => {
    await setupClaimedHandover(CASE_A);
    const created = await app.inject({
      method: 'POST',
      url: '/api/terminal/sessions',
      payload: { caseId: CASE_A, consent: { screenShare: true, remoteControl: true } },
    });
    expect(created.statusCode, created.body).toBe(200);
    const sessionId = created.json().session.id as string;

    fetchMock.mockImplementationOnce(async () => {
      const content = JSON.stringify({
        command: '',
        purpose: '対象の端末とエラー内容が不足しているため、安全なコマンドを特定できません。',
        risk: 'medium',
        verify: '',
        rollback: '',
        warnings: [],
      });
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const declined = await app.inject({
      method: 'POST',
      url: `/api/terminal/sessions/${sessionId}/steps`,
      payload: { intent: '状況を確認したい' },
    });
    expect(declined.statusCode, declined.body).toBe(200);
    const body = declined.json();
    expect(body.error).toBeUndefined();
    expect(body.declined).toBe(true);
    expect(body.step).toBeNull();
    expect(body.proposal).toBeNull();
    expect(String(body.reason)).toContain('安全なコマンドを特定できません');

    // 辞退はステップとして保存しない（ステップ上限・報告書の記録を汚さない）。
    const after = await app.inject({ method: 'GET', url: `/api/terminal/sessions/${sessionId}` });
    expect(after.statusCode, after.body).toBe(200);
    expect(after.json().steps).toEqual([]);
  });

  it('SM-06: AI呼び出しの失敗・パース不能は従来どおり502 AI_UNAVAILABLE', async () => {
    await setupClaimedHandover(CASE_A);
    const created = await app.inject({
      method: 'POST',
      url: '/api/terminal/sessions',
      payload: { caseId: CASE_A, consent: { screenShare: true, remoteControl: true } },
    });
    expect(created.statusCode, created.body).toBe(200);
    const sessionId = created.json().session.id as string;

    // API エラー
    fetchMock.mockImplementationOnce(
      async () =>
        new Response(JSON.stringify({ error: { message: 'upstream unavailable' } }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const failed = await app.inject({
      method: 'POST',
      url: `/api/terminal/sessions/${sessionId}/steps`,
      payload: { intent: '状況を確認したい' },
    });
    expect(failed.statusCode, failed.body).toBe(502);
    expect(failed.json().error.code).toBe('AI_UNAVAILABLE');

    // JSON として解釈できない応答
    fetchMock.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: 'これはJSONではありません' } }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const unparsable = await app.inject({
      method: 'POST',
      url: `/api/terminal/sessions/${sessionId}/steps`,
      payload: { intent: '状況を確認したい' },
    });
    expect(unparsable.statusCode, unparsable.body).toBe(502);
    expect(unparsable.json().error.code).toBe('AI_UNAVAILABLE');
  });

  it('SM-07: 実行記録なしで終了すると warnings を返し、report の409は維持する', async () => {
    await setupClaimedHandover(CASE_B);
    const created = await app.inject({
      method: 'POST',
      url: '/api/terminal/sessions',
      payload: { caseId: CASE_B, consent: { screenShare: true, remoteControl: true } },
    });
    expect(created.statusCode, created.body).toBe(200);
    const sessionId = created.json().session.id as string;

    const closed = await app.inject({
      method: 'POST',
      url: `/api/terminal/sessions/${sessionId}/close`,
      payload: { reason: 'stopped' },
    });
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json().session.status).toBe('closed');
    expect(closed.json().warnings).toHaveLength(1);
    expect(closed.json().warnings[0]).toContain('実行記録がありません');

    // 記録なしで close できる挙動は維持しつつ、report は従来どおり 409。
    const report = await app.inject({
      method: 'POST',
      url: `/api/terminal/sessions/${sessionId}/report`,
      payload: {},
    });
    expect(report.statusCode, report.body).toBe(409);
    expect(report.json().error.code).toBe('NO_RECORDED_STEPS');

    // 終了済みセッションへの close 再送でも同じ警告を返す（UI の再送に耐える）。
    const again = await app.inject({
      method: 'POST',
      url: `/api/terminal/sessions/${sessionId}/close`,
      payload: { reason: 'stopped' },
    });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().warnings).toHaveLength(1);
  });
});
