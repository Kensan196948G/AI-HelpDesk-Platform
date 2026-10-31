import { describe, expect, it } from 'vitest';
import {
  type BindingFacts,
  bindingViolation,
  ConsentBodySchema,
  canTransition,
  endAuditAction,
  evaluateProbe,
  heartbeatDecision,
  isSafeSegment,
  isTerminal,
  isUserSid,
  normalizeEntries,
  parseProbeOutput,
  parseQuserLines,
  sanitizeEntryName,
  terminalStatusFor,
} from './state.js';

const GUID = '11111111-2222-4333-8444-555555555555';
const SID = 'S-1-5-21-1000000001-1000000002-1000000003-1104';

describe('状態遷移', () => {
  it('順方向だけ進み、飛び越しや終端からの復帰はできない', () => {
    expect(canTransition('device_pending', 'helper_pending')).toBe(true);
    expect(canTransition('helper_pending', 'consent_pending')).toBe(true);
    expect(canTransition('consent_pending', 'active')).toBe(true);
    expect(canTransition('device_pending', 'active')).toBe(false);
    expect(canTransition('helper_pending', 'active')).toBe(false);
    expect(canTransition('active', 'consent_pending')).toBe(false);
    expect(canTransition('ended', 'active')).toBe(false);
    expect(canTransition('revoked', 'active')).toBe(false);
  });

  it('終了理由から終端状態と監査アクションを決める', () => {
    expect(terminalStatusFor('operator_end')).toBe('ended');
    expect(terminalStatusFor('requester_revoked')).toBe('revoked');
    expect(terminalStatusFor('helper_revoked')).toBe('revoked');
    expect(terminalStatusFor('expired')).toBe('expired');
    expect(terminalStatusFor('device_mismatch')).toBe('denied');
    expect(terminalStatusFor('lease_conflict')).toBe('denied');
    expect(terminalStatusFor('sid_mismatch')).toBe('ended');
    expect(endAuditAction('revoked')).toBe('folder_access.revoke');
    expect(endAuditAction('expired')).toBe('folder_access.expire');
    expect(endAuditAction('denied')).toBe('folder_access.deny');
    expect(endAuditAction('ended')).toBe('folder_access.end');
    expect(isTerminal('active')).toBe(false);
    expect(isTerminal('ended')).toBe(true);
  });
});

describe('SID と heartbeat', () => {
  it('サービスアカウントと組み込み SID を拒否する', () => {
    expect(isUserSid(SID)).toBe(true);
    expect(isUserSid('S-1-12-1-1000000001-1000000002-1000000003-1000000004')).toBe(true);
    expect(isUserSid('S-1-5-18')).toBe(false);
    expect(isUserSid('S-1-5-19')).toBe(false);
    expect(isUserSid('S-1-5-20')).toBe(false);
    expect(isUserSid('S-1-5-32-544')).toBe(false);
    expect(isUserSid('not-a-sid')).toBe(false);
  });

  const bound = { sid: SID, sessionId: 2 };
  it('一致なら継続し、disconnected は操作を配らない', () => {
    expect(heartbeatDecision(bound, { ...bound, sessionState: 'Active' })).toEqual({
      kind: 'ok',
      sessionActive: true,
    });
    expect(heartbeatDecision(bound, { ...bound, sessionState: 'disconnected' })).toEqual({
      kind: 'ok',
      sessionActive: false,
    });
  });

  it('ユーザー切替・セッション変更・ログオフで終了する', () => {
    expect(
      heartbeatDecision(bound, { sid: `${SID}0`, sessionId: 2, sessionState: 'active' }),
    ).toEqual({ kind: 'end', reason: 'sid_mismatch' });
    expect(heartbeatDecision(bound, { sid: SID, sessionId: 3, sessionState: 'active' })).toEqual({
      kind: 'end',
      reason: 'session_changed',
    });
    expect(heartbeatDecision(bound, { ...bound, sessionState: 'logoff' })).toEqual({
      kind: 'end',
      reason: 'user_logged_off',
    });
  });
});

describe('毎操作の束縛判定', () => {
  const ok: BindingFacts = {
    consentExpired: false,
    handoverStatus: 'claimed',
    claimedBy: 'a@example.com',
    assigneeEmail: 'a@example.com',
    ownerEmail: 'o@example.com',
    requesterEmail: 'o@example.com',
    helperPresent: true,
    helperRevoked: false,
    helperStale: false,
    helperBoundToRequest: true,
  };

  it('すべて一致なら違反なし', () => {
    expect(bindingViolation(ok)).toBeNull();
    expect(bindingViolation({ ...ok, handoverStatus: 'resolved' })).toBeNull();
  });

  it.each([
    [{ consentExpired: true }, 'expired'],
    [{ claimedBy: 'b@example.com' }, 'assignee_changed'],
    [{ handoverStatus: 'cancelled' }, 'assignee_changed'],
    [{ handoverStatus: 'completed' }, 'assignee_changed'],
    [{ ownerEmail: 'x@example.com' }, 'assignee_changed'],
    [{ helperPresent: false }, 'helper_revoked'],
    [{ helperRevoked: true }, 'helper_revoked'],
    [{ helperBoundToRequest: false }, 'helper_revoked'],
    [{ helperStale: true }, 'user_logged_off'],
  ] as const)('%j → %s', (patch, reason) => {
    expect(bindingViolation({ ...ok, ...patch })).toBe(reason);
  });
});

describe('サブフォルダの検証', () => {
  it.each([
    '..',
    '.',
    'a:b',
    'a\\b',
    'a/b',
    '*',
    'a?',
    'a"b',
    'trail.',
    'trail ',
    'CON',
    'con.txt',
    'LPT1',
    'Com9.log',
    'a\u0001b',
    '',
  ])('拒否する: %j', (segment) => {
    expect(isSafeSegment(segment)).toBe(false);
  });

  it.each(['Work', '業務資料', "R&D's", 'a.b', 'console'])('許可する: %j', (segment) => {
    expect(isSafeSegment(segment)).toBe(true);
  });

  it('ttlMinutes は最大 60、root は enum だけ', () => {
    const base = { root: 'Documents', segments: [], ttlMinutes: 60 };
    expect(ConsentBodySchema.safeParse(base).success).toBe(true);
    expect(ConsentBodySchema.safeParse({ ...base, ttlMinutes: 61 }).success).toBe(false);
    expect(ConsentBodySchema.safeParse({ ...base, ttlMinutes: 0 }).success).toBe(false);
    expect(ConsentBodySchema.safeParse({ ...base, root: 'C:\\Users' }).success).toBe(false);
    expect(ConsentBodySchema.safeParse({ ...base, segments: ['..'] }).success).toBe(false);
  });
});

describe('結果の正規化', () => {
  const entry = (name: string) => ({ name, type: 'file' as const });

  it('制御文字と双方向制御文字を取り除く', () => {
    expect(sanitizeEntryName('a\u0000b\u001b[31m\u202Ec\u007f')).toBe('ab[31mc');
    expect(sanitizeEntryName('x'.repeat(1000))).toHaveLength(260);
  });

  it('500 件を超えたら切り詰めて truncated にする', () => {
    const input = Array.from({ length: 501 }, (_, index) => entry(`f${index}`));
    const out = normalizeEntries(input);
    expect(out.entries).toHaveLength(500);
    expect(out.truncated).toBe(true);
  });

  it('32KB を超えたら切り詰めて truncated にする', () => {
    const input = Array.from({ length: 300 }, (_, index) => entry(`${index}${'あ'.repeat(80)}`));
    const out = normalizeEntries(input);
    expect(out.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(out.entries), 'utf8')).toBeLessThanOrEqual(32 * 1024);
  });

  it('上限内ならそのまま。空になった名前は捨てる', () => {
    const out = normalizeEntries([entry('a'), entry('\u0001')]);
    expect(out.entries.map((item) => item.name)).toEqual(['a']);
    expect(out.truncated).toBe(false);
  });
});

describe('RSP 固定テンプレートの結果', () => {
  it('英語と日本語の quser を解釈する', () => {
    expect(
      parseQuserLines([
        ' USERNAME              SESSIONNAME        ID  STATE   IDLE TIME  LOGON TIME',
        '>user-a                console             1  Active      none   10/31/2026 9:00 AM',
        ' user-b                                    2  Disc        none   10/31/2026 8:00 AM',
        ' ユーザー名            セッション名       ID  状態    アイドル時間  ログオン時刻',
        '>user-c                console             3  アクティブ  なし   2026/10/31 9:00',
        ' user-d                                    4  切断        なし   2026/10/31 8:00',
      ]),
    ).toEqual([
      { user: 'user-a', sessionId: 1, state: 'active' },
      { user: 'user-b', sessionId: 2, state: 'disconnected' },
      { user: 'user-c', sessionId: 3, state: 'active' },
      { user: 'user-d', sessionId: 4, state: 'disconnected' },
    ]);
  });

  it('不正な出力は null（fail-closed）', () => {
    expect(parseProbeOutput(null)).toBeNull();
    expect(parseProbeOutput('garbage')).toBeNull();
    expect(parseProbeOutput('{"machineGuid":"zzz"}')).toBeNull();
  });

  it('前後のノイズと文字列 1 行の quser を許容する', () => {
    const output = `noise\n${JSON.stringify({ machineGuid: GUID, quser: '>user-a console 1 Active none x' })}\n`;
    expect(parseProbeOutput(output)).toEqual({
      machineGuid: GUID,
      sessions: [{ user: 'user-a', sessionId: 1, state: 'active' }],
    });
  });

  const helper = { machineGuid: GUID, sessionId: 1, userName: 'DOMAIN\\User-A' };
  const session = (
    user: string,
    sessionId: number,
    state: 'active' | 'disconnected' = 'active',
  ) => ({
    user,
    sessionId,
    state,
  });

  it('MachineGuid が違えば device_mismatch', () => {
    expect(
      evaluateProbe(
        { machineGuid: '99999999-2222-4333-8444-555555555555', sessions: [session('user-a', 1)] },
        helper,
      ),
    ).toEqual({ kind: 'device_mismatch' });
  });

  it('ログオン無しは NOT_LOGGED_ON、同一ユーザーの複数セッションは未確定', () => {
    expect(evaluateProbe({ machineGuid: GUID, sessions: [] }, helper)).toEqual({
      kind: 'pending',
      code: 'NOT_LOGGED_ON',
    });
    expect(
      evaluateProbe(
        { machineGuid: GUID, sessions: [session('user-a', 1), session('user-a', 2)] },
        helper,
      ),
    ).toEqual({ kind: 'pending', code: 'SESSION_UNRESOLVED' });
  });

  it('セッション番号・ユーザー・状態の不一致は未確定', () => {
    for (const sessions of [
      [session('user-a', 2)],
      [session('user-b', 1)],
      [session('user-a', 1, 'disconnected')],
    ]) {
      expect(evaluateProbe({ machineGuid: GUID, sessions }, helper).kind).toBe('pending');
    }
  });

  it('別ユーザーが同居していても本人のセッションが一意なら確定する（大小文字・切り詰めを無視）', () => {
    expect(
      evaluateProbe(
        {
          machineGuid: GUID.toUpperCase(),
          sessions: [session('USER-A', 1), session('user-b', 2, 'disconnected')],
        },
        helper,
      ),
    ).toEqual({ kind: 'ok' });
    expect(
      evaluateProbe(
        { machineGuid: GUID, sessions: [session('a'.repeat(20), 1)] },
        { ...helper, userName: 'a'.repeat(25) },
      ),
    ).toEqual({ kind: 'ok' });
  });
});
