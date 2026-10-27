import { describe, expect, it } from 'vitest';
import { config } from '../config.js';
import {
  computeAuditHash,
  currentKnownAuditBreaks,
  GENESIS_HASH,
  parseKnownAuditBreaks,
  stableStringify,
  verifyAuditChain,
} from './audit.js';

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

  describe('Date を含む detail（G-01-F1）', () => {
    const iso = '2026-10-26T09:20:18.931Z';
    const payloadWithDate = {
      ...base,
      action: 'terminal.session.expire',
      targetType: 'terminal_session',
      targetId: 's1',
      detail: { actorEmail: 'a@example.com', caseId: 'c1', expiresAt: new Date(iso) },
    };
    const payloadWithIso = {
      ...payloadWithDate,
      detail: { actorEmail: 'a@example.com', caseId: 'c1', expiresAt: iso },
    };

    it('Date は ISO 文字列と同じに直列化する（保存値と再計算が一致する）', () => {
      expect(stableStringify({ at: new Date(iso) })).toBe(`{"at":${JSON.stringify(iso)}}`);
      expect(computeAuditHash(GENESIS_HASH, payloadWithDate)).toBe(
        computeAuditHash(GENESIS_HASH, payloadWithIso),
      );
    });

    it('既知の移行点だけを読み飛ばし、前後の鎖は検証できる', () => {
      // 旧実装（Date を {} としてハッシュ）で保存された壊れた行を再現する。
      const legacyHash = computeAuditHash(GENESIS_HASH, {
        ...payloadWithDate,
        detail: { actorEmail: 'a@example.com', caseId: 'c1', expiresAt: {} },
      });
      const brokenRow = {
        id: 10010,
        ...payloadWithIso,
        prevHash: GENESIS_HASH,
        hash: legacyHash,
      };
      const nextPayload = { ...base, action: 'terminal.session.start', targetId: 's2' };
      const nextHash = computeAuditHash(legacyHash, nextPayload);
      const rows = [brokenRow, { id: 10011, ...nextPayload, prevHash: legacyHash, hash: nextHash }];

      // 既知の移行点なしでは破断として検知する。
      const withoutKnown = verifyAuditChain(rows, GENESIS_HASH, { knownBreaks: [] });
      expect(withoutKnown.ok).toBe(false);
      expect(withoutKnown.brokenAtId).toBe(10010);

      // hash を固定した既知の移行点としてのみ読み飛ばす。
      const knownBreaks = [
        {
          id: 10010,
          action: 'terminal.session.expire',
          targetType: 'terminal_session',
          hash: legacyHash,
          recomputedHash: computeAuditHash(GENESIS_HASH, payloadWithIso),
          reason: 'テスト用の既知移行点',
        },
      ];
      const withKnown = verifyAuditChain(rows, GENESIS_HASH, { knownBreaks });
      expect(withKnown.ok).toBe(true);
      expect(withKnown.checked).toBe(2);
      expect(withKnown.knownBreaks).toEqual([{ id: 10010, reason: 'テスト用の既知移行点' }]);

      // 移行点の行が書き換えられた（hash が変わった）場合は既知扱いにしない。
      const tampered = [{ ...brokenRow, hash: nextHash }, rows[1]!];
      const tamperedResult = verifyAuditChain(tampered, GENESIS_HASH, { knownBreaks });
      expect(tamperedResult.ok).toBe(false);
      expect(tamperedResult.brokenAtId).toBe(10010);

      // detail だけ書き換えられた場合も、recomputedHash の固定で検知する。
      const detailTampered = [
        { ...brokenRow, detail: { ...brokenRow.detail, caseId: 'c-other' } },
        rows[1]!,
      ];
      const detailResult = verifyAuditChain(detailTampered, GENESIS_HASH, { knownBreaks });
      expect(detailResult.ok).toBe(false);
      expect(detailResult.brokenAtId).toBe(10010);
    });
  });

  describe('既知破断の設定（AUDIT_KNOWN_BREAKS）', () => {
    const hashA = 'a'.repeat(64);
    const hashB = 'b'.repeat(64);

    it('id:保存hash:再計算hash をカンマ/改行区切りで解析する', () => {
      const parsed = parseKnownAuditBreaks(`10010:${hashA}:${hashB}\n10013:${hashB}:${hashA}`);
      expect(parsed).toHaveLength(2);
      expect(parsed[0]).toMatchObject({ id: 10010, hash: hashA, recomputedHash: hashB });
      expect(parsed[1]).toMatchObject({ id: 10013, hash: hashB, recomputedHash: hashA });
    });

    it('空文字は「既知破断なし」、不正な形式は fail-fast', () => {
      expect(parseKnownAuditBreaks('')).toEqual([]);
      expect(parseKnownAuditBreaks('   ')).toEqual([]);
      expect(() => parseKnownAuditBreaks('10010')).toThrow(/形式が不正/);
      expect(() => parseKnownAuditBreaks('abc:aaaa:bbbb')).toThrow(/id が不正/);
      expect(() => parseKnownAuditBreaks(`10010:${hashA}:not-a-hash`)).toThrow(/hash が不正/);
    });

    it('設定を差し替えると verify が通り、未知の破断は FAIL のまま', () => {
      const iso = '2026-10-26T09:20:18.931Z';
      const payload = {
        ...base,
        action: 'terminal.session.expire',
        targetType: 'terminal_session',
        targetId: 's1',
        detail: { actorEmail: 'a@example.com', caseId: 'c1', expiresAt: iso },
      };
      // 旧実装（Date→{}）で保存された行を再現する。
      const storedHash = computeAuditHash(GENESIS_HASH, {
        ...payload,
        detail: { actorEmail: 'a@example.com', caseId: 'c1', expiresAt: {} },
      });
      const recomputedHash = computeAuditHash(GENESIS_HASH, payload);
      const rows = [{ id: 20001, ...payload, prevHash: GENESIS_HASH, hash: storedHash }];

      const original = config.AUDIT_KNOWN_BREAKS;
      try {
        // env 相当の設定を差し替えると、その行だけ既知破断として検証が通る。
        config.AUDIT_KNOWN_BREAKS = `20001:${storedHash}:${recomputedHash}`;
        expect(currentKnownAuditBreaks()).toHaveLength(1);
        const ok = verifyAuditChain(rows);
        expect(ok.ok, JSON.stringify(ok)).toBe(true);
        expect(ok.knownBreaks).toEqual([
          { id: 20001, reason: '環境設定（AUDIT_KNOWN_BREAKS）で指定された既知の移行点' },
        ]);

        // 別の破断（未知）は設定にないため FAIL のまま。
        config.AUDIT_KNOWN_BREAKS = `19999:${storedHash}:${recomputedHash}`;
        const unknown = verifyAuditChain(rows);
        expect(unknown.ok).toBe(false);
        expect(unknown.brokenAtId).toBe(20001);

        // 設定を空にすると既知破断なし＝FAIL。
        config.AUDIT_KNOWN_BREAKS = '';
        expect(verifyAuditChain(rows).ok).toBe(false);
      } finally {
        config.AUDIT_KNOWN_BREAKS = original;
      }
    });
  });
});
