import { describe, expect, it } from 'vitest';
import {
  APPROVAL_TTL_MS,
  type ApprovalPayloadSource,
  approvalHashMatches,
  buildApprovalPayload,
  computeApprovalHash,
  newNonce,
} from './approval.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const STEP_ID = '22222222-2222-4222-8222-222222222222';
const CONTENT_HASH = `sha256:${'a'.repeat(64)}`;

function source(overrides: Partial<ApprovalPayloadSource> = {}): ApprovalPayloadSource {
  return {
    sessionId: SESSION_ID,
    stepId: STEP_ID,
    seq: 1,
    skillId: 'spooler.status',
    skillVersion: '1.0.0',
    skillContentHash: CONTENT_HASH,
    params: {},
    deviceId: 'WEB-AB12CD34',
    userEmail: 'dev@example.com',
    riskLevel: 1,
    nonce: 'nonce-abc',
    expiresAt: new Date('2026-10-25T05:00:00.000Z'),
    ...overrides,
  };
}

describe('approval hash', () => {
  it('payload は設計 §5-2 の 12 キーを返し、expiresAt は ISO 文字列になる', () => {
    const payload = buildApprovalPayload(source());
    expect(Object.keys(payload).sort()).toEqual(
      [
        'deviceId',
        'expiresAt',
        'nonce',
        'params',
        'riskLevel',
        'seq',
        'sessionId',
        'skillContentHash',
        'skillId',
        'skillVersion',
        'stepId',
        'userEmail',
      ].sort(),
    );
    expect(payload.expiresAt).toBe('2026-10-25T05:00:00.000Z');
  });

  it('キー順が違っても同じハッシュになる（stableStringify）', () => {
    const left = buildApprovalPayload(
      source({ params: { service: 'Spooler', extra: { b: 2, a: 1 } } }),
    );
    const right = buildApprovalPayload(
      source({ params: { extra: { a: 1, b: 2 }, service: 'Spooler' } }),
    );
    expect(computeApprovalHash(left)).toBe(computeApprovalHash(right));
  });

  it('params / seq / skillVersion の改ざんでハッシュが変わる', () => {
    const base = computeApprovalHash(buildApprovalPayload(source()));
    expect(
      computeApprovalHash(buildApprovalPayload(source({ params: { service: 'W32Time' } }))),
    ).not.toBe(base);
    expect(computeApprovalHash(buildApprovalPayload(source({ seq: 2 })))).not.toBe(base);
    expect(computeApprovalHash(buildApprovalPayload(source({ skillVersion: '1.0.1' })))).not.toBe(
      base,
    );
  });

  it('一致するハッシュだけを定数時間比較で受け付ける', () => {
    const payload = buildApprovalPayload(source());
    const hash = computeApprovalHash(payload);
    expect(approvalHashMatches(hash, hash)).toBe(true);
    expect(approvalHashMatches(hash.toUpperCase(), hash)).toBe(true);
    expect(approvalHashMatches('b'.repeat(64), hash)).toBe(false);
    expect(approvalHashMatches('not-a-hash', hash)).toBe(false);
    expect(approvalHashMatches('', hash)).toBe(false);
    expect(approvalHashMatches(hash.slice(0, 63), hash)).toBe(false);
  });

  it('nonce は 1 回ごとに異なる base64url 22 文字', () => {
    const first = newNonce();
    const second = newNonce();
    expect(first).not.toBe(second);
    expect(first).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('承認ハッシュの有効期限は 5 分', () => {
    expect(APPROVAL_TTL_MS).toBe(5 * 60 * 1000);
  });
});
