import { describe, expect, it } from 'vitest';
import { assertCaptureAllowed } from './capture.js';
import {
  CloseSchema,
  CreateSessionSchema,
  computeStepHash,
  MAX_OUTPUT_CHARS,
  maskText,
  ProposeSchema,
  RecordSchema,
  sessionDto,
  stepDto,
  type TerminalSessionRow,
  type TerminalStepRow,
} from './session.js';

function sessionRow(overrides: Partial<TerminalSessionRow> = {}): TerminalSessionRow {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    case_id: 'CASE-T1',
    handover_id: '22222222-2222-2222-2222-222222222222',
    device: 'MRK-NB-1000',
    operator_email: 'helpdesk@example.com',
    requester_email: 'requester@example.com',
    status: 'active',
    close_reason: null,
    close_note: null,
    consent_screen_share: true,
    consent_remote_control: true,
    ai_model: 'deepseek-flash',
    knowledge_id: null,
    report_id: null,
    report_sha256: null,
    rsp_session_id: null,
    started_at: new Date('2026-10-26T01:00:00Z'),
    expires_at: new Date('2026-10-26T01:30:00Z'),
    closed_at: null,
    created_at: new Date('2026-10-26T01:00:00Z'),
    updated_at: new Date('2026-10-26T01:00:00Z'),
    ...overrides,
  };
}

function stepRow(overrides: Partial<TerminalStepRow> = {}): TerminalStepRow {
  return {
    id: '33333333-3333-3333-3333-333333333333',
    session_id: '11111111-1111-1111-1111-111111111111',
    seq: 1,
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
    output: 'Status Name\nRunning Spooler',
    output_source: 'manual',
    exit_status: 'success',
    note: null,
    sha256: 'a'.repeat(64),
    rsp_command_log_id: null,
    proposed_at: new Date('2026-10-26T01:01:00Z'),
    recorded_at: new Date('2026-10-26T01:02:00Z'),
    ...overrides,
  };
}

describe('terminal session domain', () => {
  it('セッション作成は TTL の範囲と操作支援の同意を検証する', () => {
    expect(CreateSessionSchema.safeParse({ consent: { remoteControl: true } }).success).toBe(true);
    expect(CreateSessionSchema.safeParse({ consent: { remoteControl: false } }).success).toBe(true); // 同意の有無はルートで判定する（スキーマは型だけ見る）
    expect(
      CreateSessionSchema.safeParse({ consent: { remoteControl: true }, ttlMinutes: 1 }).success,
    ).toBe(false);
    expect(
      CreateSessionSchema.safeParse({ consent: { remoteControl: true }, ttlMinutes: 120 }).success,
    ).toBe(true);
    expect(
      CreateSessionSchema.safeParse({ consent: { remoteControl: true }, ttlMinutes: 121 }).success,
    ).toBe(false);
  });

  it('提案・記録・終了の入力は列挙値と長さを検証する', () => {
    expect(ProposeSchema.safeParse({ intent: '' }).success).toBe(false);
    expect(ProposeSchema.safeParse({ intent: '状況を確認したい' }).success).toBe(true);
    expect(
      RecordSchema.safeParse({
        command: 'Get-Service Spooler',
        outputSource: 'manual',
        exitStatus: 'success',
      }).success,
    ).toBe(true);
    expect(
      RecordSchema.safeParse({
        command: 'x',
        outputSource: 'rpa',
        exitStatus: 'success',
      }).success,
    ).toBe(false);
    expect(CloseSchema.safeParse({ reason: 'resolved' }).success).toBe(true);
    expect(CloseSchema.safeParse({ reason: 'expired' }).success).toBe(false);
  });

  it('出力はPIIを伏せ字化し、上限を超えたら切り詰めを明示する', () => {
    const masked = maskText('password: hunter2 user a@example.com tel 090-1234-5678', 200);
    expect(masked.text).not.toContain('hunter2');
    expect(masked.text).not.toContain('a@example.com');
    expect(masked.text).not.toContain('090-1234-5678');
    expect(masked.truncated).toBe(false);
    expect(masked.findings.length).toBeGreaterThan(0);

    const long = maskText('a'.repeat(MAX_OUTPUT_CHARS + 10), MAX_OUTPUT_CHARS);
    expect(long.text.length).toBe(MAX_OUTPUT_CHARS);
    expect(long.truncated).toBe(true);
  });

  it('rsp_command は rspCommandLogId を必須にし、相関IDの長さを検証する', () => {
    const base = {
      command: 'Get-Service Spooler',
      output: 'Running',
      outputSource: 'rsp_command',
      exitStatus: 'success',
    };
    // RSP のコマンドキュー由来は「どの実行結果か」が必要（無ければ 400 相当）。
    expect(RecordSchema.safeParse(base).success).toBe(false);
    expect(RecordSchema.safeParse({ ...base, rspCommandLogId: '' }).success).toBe(false);
    expect(RecordSchema.safeParse({ ...base, rspCommandLogId: 'c'.repeat(65) }).success).toBe(
      false,
    );

    const ok = RecordSchema.safeParse({
      ...base,
      rspCommandLogId: 'cmdlog-20261026-0001',
      rspSessionId: 'rsess-42',
    });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.outputSource).toBe('rsp_command');
      expect(ok.data.rspCommandLogId).toBe('cmdlog-20261026-0001');
      expect(ok.data.rspSessionId).toBe('rsess-42');
    }

    // manual / auto は相関IDなしでも従来どおり（後方互換）。
    expect(RecordSchema.safeParse({ ...base, outputSource: 'manual' }).success).toBe(true);
    expect(RecordSchema.safeParse({ ...base, outputSource: 'auto' }).success).toBe(true);
  });

  it('rsp_command のハッシュは決定的で、outputSource が変わると変わる', () => {
    const base = {
      sessionId: 's',
      stepId: 'p',
      seq: 1,
      command: 'Get-Service Spooler',
      output: 'Running',
      outputSource: 'rsp_command' as const,
      exitStatus: 'success' as const,
    };
    expect(computeStepHash(base)).toBe(computeStepHash({ ...base }));
    expect(computeStepHash(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(computeStepHash(base)).not.toBe(
      computeStepHash({ ...base, outputSource: 'manual' as const }),
    );
  });

  it('取込可否: auto は 400 のまま、manual と rsp_command は許可する', () => {
    expect(() => assertCaptureAllowed('manual')).not.toThrow();
    // RSP のキューが実行主体で実出力を取得済みのため、ターミナルログの能力に関係なく通す。
    expect(() => assertCaptureAllowed('rsp_command')).not.toThrow();
    expect(() => assertCaptureAllowed('auto')).toThrowError(/手動貼り付け/);
    try {
      assertCaptureAllowed('auto');
    } catch (error) {
      expect((error as { statusCode?: number }).statusCode).toBe(400);
      expect((error as { code?: string }).code).toBe('CAPTURE_UNAVAILABLE');
    }
  });

  it('実行記録のハッシュは同じ入力で安定し、1 文字の変更で変わる', () => {
    const base = {
      sessionId: 's',
      stepId: 'p',
      seq: 1,
      command: 'Get-Service Spooler',
      output: 'Running',
      outputSource: 'manual' as const,
      exitStatus: 'success' as const,
    };
    expect(computeStepHash(base)).toBe(computeStepHash({ ...base }));
    expect(computeStepHash(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(computeStepHash({ ...base, output: 'Running ' })).not.toBe(computeStepHash(base));
    expect(computeStepHash({ ...base, seq: 2 })).not.toBe(computeStepHash(base));
  });

  it('DTO は提案と実行を分けて返し、未記録なら executed は null', () => {
    const dto = stepDto(stepRow());
    expect(dto.proposal.command).toBe('Get-Service Spooler');
    expect(dto.proposal.warnings).toEqual(['読み取りのみ']);
    expect(dto.executed?.command).toBe('Get-Service Spooler');
    expect(dto.executed?.sha256).toHaveLength(64);
    // 相関IDのキーは常に返す（未相関なら null）。
    expect(dto.executed?.rspCommandLogId).toBeNull();

    const rsp = stepDto(
      stepRow({ output_source: 'rsp_command', rsp_command_log_id: 'cmdlog-20261026-0001' }),
    );
    expect(rsp.executed?.outputSource).toBe('rsp_command');
    expect(rsp.executed?.rspCommandLogId).toBe('cmdlog-20261026-0001');

    const unrecorded = stepDto(
      stepRow({ recorded_at: null, executed_command: null, output: null }),
    );
    expect(unrecorded.executed).toBeNull();
  });

  it('セッション DTO は能力・上限・時間・相関IDを返す', () => {
    const dto = sessionDto(sessionRow(), {
      stepCount: 3,
      capture: { supported: false, reason: '未対応' },
    });
    expect(dto.status).toBe('active');
    expect(dto.stepCount).toBe(3);
    expect(dto.capture.supported).toBe(false);
    expect(dto.consent.remoteControl).toBe(true);
    expect(dto.startedAt).toBe('2026-10-26T01:00:00.000Z');
    expect(dto.closedAt).toBeNull();
    expect(dto.rspSessionId).toBeNull();

    const correlated = sessionDto(sessionRow({ rsp_session_id: 'rsess-42' }), {
      stepCount: 1,
      capture: { supported: false, reason: null },
    });
    expect(correlated.rspSessionId).toBe('rsess-42');
  });
});
