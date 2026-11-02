import { describe, expect, it } from 'vitest';
import {
  canonicalOpJson,
  generateHelperToken,
  generatePairingCode,
  hashPairingCode,
  hashToken,
  signOp,
} from './sign.js';

// docs/62 §5 に載せた固定ベクトル。ヘルパー側（PowerShell）も同じ値で検証する。
const VECTOR = {
  token: 'test-helper-token-0123456789abcdefghijklmnop',
  op: {
    opId: '11111111-1111-4111-8111-111111111111',
    requestId: '22222222-2222-4222-8222-222222222222',
    sid: 'S-1-5-21-1000000001-1000000002-1000000003-1104',
    sessionId: 2,
    root: 'Documents',
    segments: ['業務資料', "R&D's"],
    operation: 'list_metadata',
    expiresAt: '2026-01-02T03:04:05.000Z',
  },
  canonical:
    '{"opId":"11111111-1111-4111-8111-111111111111","requestId":"22222222-2222-4222-8222-222222222222","sid":"S-1-5-21-1000000001-1000000002-1000000003-1104","sessionId":2,"root":"Documents","segments":["業務資料","R&D\'s"],"operation":"list_metadata","expiresAt":"2026-01-02T03:04:05.000Z"}',
  sig: '32bb903bb816eb361d56378e98cb41d7d491cf58a18c22ecd207cca2aa69b2f7',
};

describe('操作の署名', () => {
  it('固定ベクトルと一致する', () => {
    expect(canonicalOpJson(VECTOR.op)).toBe(VECTOR.canonical);
    expect(signOp(VECTOR.token, VECTOR.op)).toBe(VECTOR.sig);
  });

  it('内容やトークンが変われば署名も変わる', () => {
    const base = signOp(VECTOR.token, VECTOR.op);
    expect(signOp(`${VECTOR.token}x`, VECTOR.op)).not.toBe(base);
    expect(signOp(VECTOR.token, { ...VECTOR.op, root: 'Desktop' })).not.toBe(base);
    expect(signOp(VECTOR.token, { ...VECTOR.op, sessionId: 3 })).not.toBe(base);
    expect(signOp(VECTOR.token, { ...VECTOR.op, segments: ['業務資料'] })).not.toBe(base);
  });
});

describe('トークンとコード', () => {
  it('コードは 8 桁、トークンは十分に長い', () => {
    expect(generatePairingCode()).toMatch(/^\d{8}$/);
    expect(generateHelperToken().length).toBeGreaterThanOrEqual(40);
  });

  it('保存形は平文を含まない', () => {
    const token = generateHelperToken();
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).not.toContain(token);
    const code = '01234567';
    expect(hashPairingCode(code)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashPairingCode(code)).toBe(hashPairingCode(code));
    expect(hashPairingCode(code)).not.toBe(hashPairingCode('01234568'));
  });
});
