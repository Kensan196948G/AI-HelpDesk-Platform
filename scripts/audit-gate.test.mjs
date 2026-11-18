import { describe, expect, it } from 'vitest';
import {
  advisoryIdFromUrl,
  collectDirectAdvisories,
  evaluateAudit,
  normalizeExceptions,
  reachableAdvisories,
} from './audit-gate.mjs';

const advisory = (id, overrides = {}) => ({
  source: 1,
  name: 'picomatch',
  dependency: 'picomatch',
  title: 'test advisory',
  url: `https://github.com/advisories/${id}`,
  severity: 'high',
  range: '<=4.0.7',
  ...overrides,
});

const validException = (overrides = {}) => ({
  id: 'GHSA-fc5q-39xc-vjpf',
  package: 'picomatch',
  scope: 'dev',
  reason: '上流に修正版が無く、devDependencies 経由のみ。',
  approvedBy: 'CTO',
  expiresAt: '2099-12-31',
  upstream: 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf',
  ...overrides,
});

function reportWith(vulnerabilities) {
  return { auditReportVersion: 2, vulnerabilities, metadata: {} };
}

describe('advisoryIdFromUrl', () => {
  it('GHSA ID を大文字で抽出する', () => {
    expect(advisoryIdFromUrl('https://github.com/advisories/GHSA-fc5q-39xc-vjpf')).toBe(
      'GHSA-FC5Q-39XC-VJPF',
    );
    expect(advisoryIdFromUrl('https://example.com/x')).toBeNull();
  });
});

describe('normalizeExceptions', () => {
  it('不正な ID を捨て、scope の既定を dev にする', () => {
    const list = normalizeExceptions({
      exceptions: [{ id: 'nope' }, { id: 'GHSA-aaaa-bbbb-cccc' }],
    });
    expect(list).toHaveLength(1);
    expect(list[0].scope).toBe('dev');
  });
});

describe('evaluateAudit', () => {
  it('例外の無い High はブロックする', () => {
    const result = evaluateAudit(
      reportWith({ picomatch: { severity: 'high', via: [advisory('GHSA-fc5q-39xc-vjpf')] } }),
      [],
    );
    expect(result.ok).toBe(false);
    expect(result.blocking.map((item) => item.name)).toEqual(['picomatch']);
  });

  it('有効な期限付き例外がある High は許可する', () => {
    const result = evaluateAudit(
      reportWith({ picomatch: { severity: 'high', via: [advisory('GHSA-fc5q-39xc-vjpf')] } }),
      [validException()],
    );
    expect(result.ok).toBe(true);
    expect(result.excepted.map((item) => item.name)).toEqual(['picomatch']);
  });

  it('期限切れの例外は許可しない', () => {
    const result = evaluateAudit(
      reportWith({ picomatch: { severity: 'high', via: [advisory('GHSA-fc5q-39xc-vjpf')] } }),
      [validException({ expiresAt: '2000-01-01' })],
      { now: new Date('2026-11-18T00:00:00Z') },
    );
    expect(result.ok).toBe(false);
  });

  it('runtime 監査に dev 例外を適用しない', () => {
    const result = evaluateAudit(
      reportWith({ picomatch: { severity: 'high', via: [advisory('GHSA-fc5q-39xc-vjpf')] } }),
      [validException()],
      { scope: 'runtime' },
    );
    expect(result.ok).toBe(false);
  });

  it('異なる勧告 ID には適用しない', () => {
    const result = evaluateAudit(
      reportWith({ picomatch: { severity: 'high', via: [advisory('GHSA-zzzz-zzzz-zzzz')] } }),
      [validException()],
    );
    expect(result.ok).toBe(false);
  });

  it('推移依存（via 文字列）でも根の勧告を解決する', () => {
    const report = reportWith({
      picomatch: { severity: 'high', via: [advisory('GHSA-fc5q-39xc-vjpf')] },
      fdir: { severity: 'high', via: ['picomatch'] },
      tinyglobby: { severity: 'high', via: ['fdir', 'picomatch'] },
    });
    const result = evaluateAudit(report, [validException()]);
    expect(result.ok).toBe(true);
    expect(result.excepted.map((item) => item.name).sort()).toEqual([
      'fdir',
      'picomatch',
      'tinyglobby',
    ]);
  });

  it('multiple 勧告のうち 1 つでも未承認ならブロックする', () => {
    const report = reportWith({
      vite: {
        severity: 'high',
        via: [advisory('GHSA-fc5q-39xc-vjpf'), advisory('GHSA-zzzz-zzzz-zzzz')],
      },
    });
    const result = evaluateAudit(report, [validException()]);
    expect(result.ok).toBe(false);
  });

  it('理由・承認者が空の例外は使わない', () => {
    const result = evaluateAudit(
      reportWith({ picomatch: { severity: 'high', via: [advisory('GHSA-fc5q-39xc-vjpf')] } }),
      [validException({ reason: ' ' })],
    );
    expect(result.ok).toBe(false);
  });

  it('moderate / low はブロックしない', () => {
    const result = evaluateAudit(
      reportWith({ x: { severity: 'moderate', via: [advisory('GHSA-aaaa-bbbb-cccc')] } }),
      [],
    );
    expect(result.ok).toBe(true);
    expect(result.ignored.map((item) => item.name)).toEqual(['x']);
  });
});

describe('collectDirectAdvisories / reachableAdvisories', () => {
  it('推移参照を循環しても停止する', () => {
    const vulnerabilities = {
      a: { severity: 'high', via: ['b'] },
      b: { severity: 'high', via: ['a', advisory('GHSA-fc5q-39xc-vjpf')] },
    };
    const direct = collectDirectAdvisories(vulnerabilities);
    const ids = [...reachableAdvisories('a', vulnerabilities, direct).keys()];
    expect(ids).toEqual(['GHSA-FC5Q-39XC-VJPF']);
  });
});
