import { describe, expect, it } from 'vitest';
import { computeAuditHash, GENESIS_HASH, stableStringify, verifyAuditChain } from './audit.js';

const base = {
  actorId: 'u1',
  action: 'case.create',
  targetType: 'case',
  targetId: 'c1',
  detail: { category: 'file_share', signal: 'blue' },
};

describe('audit hash chain', () => {
  it('キー順に依存せず同じハッシュになる', () => {
    const a = computeAuditHash(GENESIS_HASH, base);
    const b = computeAuditHash(GENESIS_HASH, {
      ...base,
      detail: { signal: 'blue', category: 'file_share' },
    });
    expect(a).toBe(b);
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('正しいチェーンを検証できる', () => {
    const h1 = computeAuditHash(GENESIS_HASH, base);
    const h2 = computeAuditHash(h1, { ...base, action: 'case.handoff', targetId: 'c1' });
    const result = verifyAuditChain([
      { id: 1, ...base, prevHash: GENESIS_HASH, hash: h1 },
      { id: 2, ...base, action: 'case.handoff', prevHash: h1, hash: h2 },
    ]);
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(2);
  });

  it('改ざんを検知する', () => {
    const h1 = computeAuditHash(GENESIS_HASH, base);
    const h2 = computeAuditHash(h1, { ...base, action: 'case.handoff' });
    const result = verifyAuditChain([
      { id: 1, ...base, prevHash: GENESIS_HASH, hash: h1 },
      { id: 2, ...base, action: 'case.handoff', prevHash: h1, hash: h2 },
      {
        id: 3,
        ...base,
        action: 'case.resolve',
        prevHash: h1,
        hash: h2,
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.brokenAtId).toBe(3);
  });
});
