import { describe, expect, it } from 'vitest';
import { renderFinalReportHtml } from '../domain/final-report.js';
import type { HandoverRow } from '../routes/case-handovers.js';
import { buildKnowledgeDraft, buildTerminalReport } from './report.js';
import type { TerminalSessionRow, TerminalStepRow } from './session.js';

const CASE_ID = 'CASE-RPT-1';

function handoverRow(): HandoverRow {
  return {
    id: '22222222-2222-2222-2222-222222222222',
    case_id: CASE_ID,
    owner_email: 'requester@example.com',
    assignee_hint: 'DX推進部',
    recipient_no: null,
    recipient_name: null,
    status: 'claimed',
    snapshot: {
      caseId: CASE_ID,
      case: {
        id: CASE_ID,
        subject: 'プリンタで印刷できない',
        body: '印刷キューが止まっています。',
        cat: 'device',
        urgency: 'urgent',
        createdAt: '2026-10-26T00:00:00.000Z',
        pc: {
          state: 'done',
          snap: {
            at: '2026-10-26T00:10:00.000Z',
            device: 'MRK-NB-1000',
            items: [
              { grp: '周辺機器', k: '印刷スプーラ', v: '停止', lv: 'ng' },
              { grp: '端末', k: '機種', v: '標準機', lv: 'ok' },
            ],
          },
        },
      },
      chat: {
        messages: [
          { id: 'm1', role: 'user', at: '2026-10-26T00:00:00.000Z', text: '印刷できません' },
          { id: 'm2', role: 'ai', at: '2026-10-26T00:01:00.000Z', text: 'スプーラを確認します' },
        ],
      },
      ticket: { id: 'TKT-2026-0001' },
      inc: { id: 'INC-0001', handover: { summary: '印刷スプーラ停止の引継ぎ' } },
      draft: null,
      kb: null,
      proposals: [],
      extractedAt: '2026-10-26T00:20:00.000Z',
    },
    claimed_by: 'helpdesk@example.com',
    approved_by: null,
    approved_at: null,
    self_approved: false,
    created_at: new Date('2026-10-26T00:20:00.000Z'),
  };
}

function sessionRow(overrides: Partial<TerminalSessionRow> = {}): TerminalSessionRow {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    case_id: CASE_ID,
    handover_id: '22222222-2222-2222-2222-222222222222',
    device: 'MRK-NB-1000',
    operator_email: 'helpdesk@example.com',
    requester_email: 'requester@example.com',
    status: 'closed',
    close_reason: 'resolved',
    close_note: 'スプーラ再起動で復旧',
    consent_screen_share: true,
    consent_remote_control: true,
    ai_model: 'deepseek-flash',
    knowledge_id: null,
    report_id: null,
    report_sha256: null,
    rsp_session_id: null,
    started_at: new Date('2026-10-26T01:00:00Z'),
    expires_at: new Date('2026-10-26T01:30:00Z'),
    closed_at: new Date('2026-10-26T01:12:00Z'),
    created_at: new Date('2026-10-26T01:00:00Z'),
    updated_at: new Date('2026-10-26T01:12:00Z'),
    ...overrides,
  };
}

function step(seq: number, overrides: Partial<TerminalStepRow> = {}): TerminalStepRow {
  return {
    id: `33333333-3333-3333-3333-33333333333${seq}`,
    session_id: '11111111-1111-1111-1111-111111111111',
    seq,
    operator_email: 'helpdesk@example.com',
    intent: 'スプーラの状態を確認する',
    ai_command: 'Get-Service Spooler',
    ai_purpose: '印刷サービスの状態を確認する',
    ai_risk: 'low',
    ai_verify: 'Status が Running',
    ai_rollback: '不要（読み取りのみ）',
    ai_warnings: ['読み取りのみ'],
    ai_model: 'deepseek-flash',
    executed_command: 'Get-Service Spooler',
    output: 'Status Name\nStopped Spooler',
    output_source: 'manual',
    exit_status: 'success',
    note: null,
    sha256: 'b'.repeat(64),
    rsp_command_log_id: null,
    proposed_at: new Date('2026-10-26T01:01:00Z'),
    recorded_at: new Date('2026-10-26T01:02:00Z'),
    ...overrides,
  };
}

describe('RSP実行セッションの報告書', () => {
  it('引継ぎメモ・PC情報・実行記録を終報告書に載せる', () => {
    const result = buildTerminalReport({
      handover: handoverRow(),
      session: sessionRow(),
      steps: [step(1), step(2, { recorded_at: null, executed_command: null, output: null })],
      operatorName: '佐藤 奨太',
      requesterName: '山田 太郎',
      knowledge: null,
    });
    const report = result.report;
    expect(report.kind).toBe('helpdesk_resolved');
    expect(report.case.id).toBe(CASE_ID);
    expect(report.case.subject).toContain('プリンタ');
    expect(report.handover?.memo).toBe('印刷スプーラ停止の引継ぎ');
    expect(report.pc?.itemCount).toBe(2);
    expect(report.pc?.flags[0]?.k).toBe('印刷スプーラ');
    expect(report.terminal?.steps).toHaveLength(2);
    expect(report.terminal?.steps[0]?.executed?.command).toBe('Get-Service Spooler');
    expect(report.terminal?.steps[1]?.executed).toBeNull();
    expect(report.terminal?.unrecorded[0]).toContain('ステップ2');
    expect(report.resolution?.minutes).toBe(12);
    expect(report.resolution?.steps[0]).toContain('Get-Service Spooler');
    // 未記録があることは警告としても返す（黙って落とさない）。
    expect(result.warnings).toEqual([]);
  });

  it('rsp_command の実行記録は相関IDつきで報告書に載る', () => {
    const result = buildTerminalReport({
      handover: handoverRow(),
      session: sessionRow({ rsp_session_id: 'rsess-42' }),
      steps: [
        step(1, {
          output_source: 'rsp_command',
          rsp_command_log_id: 'cmdlog-20261026-0001',
        }),
      ],
      operatorName: '佐藤 奨太',
      requesterName: '山田 太郎',
      knowledge: null,
    });
    const terminal = result.report.terminal;
    expect(terminal?.rspSessionId).toBe('rsess-42');
    expect(terminal?.steps[0]?.executed?.outputSource).toBe('rsp_command');
    expect(terminal?.steps[0]?.executed?.rspCommandLogId).toBe('cmdlog-20261026-0001');
    expect(terminal?.steps[0]?.executed?.sha256).toBe('b'.repeat(64));
  });

  it('引継ぎスナップショットが無い場合は最小限で組み立て、警告を返す', () => {
    const handover = { ...handoverRow(), snapshot: null };
    const result = buildTerminalReport({
      handover,
      session: sessionRow(),
      steps: [step(1)],
      operatorName: '佐藤 奨太',
      requesterName: '山田 太郎',
      knowledge: null,
    });
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.report.case.subject).toBe('（件名なし）');
    expect(result.report.pc).toBeNull();
  });

  it('ナレッジ下書きは実行記録から作り、原因の推測を書かない', () => {
    const content = buildKnowledgeDraft({
      handover: handoverRow(),
      session: sessionRow(),
      steps: [step(1), step(2, { note: 'スプーラ停止が原因', seq: 2 })],
    });
    expect(content.title).toBe('プリンタで印刷できないの確認手順');
    expect(content.symptom).toContain('印刷キュー');
    expect(content.cause).toBe('スプーラ停止が原因');
    expect(content.steps).toContain('Get-Service Spooler');
    expect(content.steps).toContain('結果: success');
    expect(content.keywords).toContain('PC・周辺機器');
    expect(content.steps.length).toBeLessThanOrEqual(8000);
  });

  it('原因が無いときは推測せず、補足を促す文を入れる', () => {
    const content = buildKnowledgeDraft({
      handover: handoverRow(),
      session: sessionRow(),
      steps: [step(1)],
    });
    expect(content.cause).toContain('原因は記録されていません');
  });

  it('中止（stopped）のセッションは「解決」ではなく未解決の報告書になる（SM-12）', () => {
    const result = buildTerminalReport({
      handover: handoverRow(),
      session: sessionRow({ close_reason: 'stopped' }),
      steps: [step(1)],
      operatorName: '佐藤 奨太',
      requesterName: '山田 太郎',
      knowledge: null,
    });
    expect(result.report.kind).toBe('helpdesk_stopped');
    expect(result.report.terminal?.closeReason).toBe('stopped');

    const rendered = renderFinalReportHtml(result.report, {
      id: '11111111-1111-4111-8111-111111111111',
      sha256: 'c'.repeat(64),
    });
    expect(rendered.html).toContain('担当者の対応を終了（未解決）');
    expect(rendered.html).toContain('終了日時');
    expect(rendered.html).not.toContain('担当者の対応で解決');
    expect(rendered.filename).toContain('-HD-STOP-');
  });
});
