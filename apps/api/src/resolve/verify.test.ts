import { describe, expect, it } from 'vitest';
import { evaluateFollowupVerify, evaluateVerify } from './verify.js';

describe('evaluateVerify（resultField 形態）', () => {
  it('equals: プリミティブが一致すれば ok=true', () => {
    const outcome = evaluateVerify(
      { description: 'Spooler が Running', resultField: 'status', equals: 'Running' },
      { status: 'Running' },
    );
    expect(outcome).toMatchObject({
      ok: true,
      evaluated: true,
      description: 'Spooler が Running',
      field: 'status',
      actual: 'Running',
      expected: 'Running',
    });
    expect(outcome.reason).toBeUndefined();
  });

  it('equals: 一致しなければ ok=false（評価は成立している）', () => {
    const outcome = evaluateVerify({ resultField: 'flushed', equals: true }, { flushed: false });
    expect(outcome.ok).toBe(false);
    expect(outcome.evaluated).toBe(true);
    expect(outcome.actual).toBe(false);
    expect(outcome.expected).toBe(true);
    expect(outcome.reason).toBeUndefined();
  });

  it('equals: 0 / false / 空文字も型を跨がず厳密比較する', () => {
    expect(evaluateVerify({ resultField: 'n', equals: 0 }, { n: 0 }).ok).toBe(true);
    expect(evaluateVerify({ resultField: 'n', equals: 0 }, { n: false }).ok).toBe(false);
    expect(evaluateVerify({ resultField: 'n', equals: 0 }, { n: '0' }).ok).toBe(false);
    expect(evaluateVerify({ resultField: 's', equals: '' }, { s: '' }).ok).toBe(true);
  });

  it('minimum: 実測値が期待値以上なら ok=true（同値も可）', () => {
    const above = evaluateVerify({ resultField: 'volumeCount', minimum: 1 }, { volumeCount: 2 });
    expect(above).toMatchObject({ ok: true, evaluated: true, actual: 2, expected: 1 });
    const equal = evaluateVerify({ resultField: 'volumeCount', minimum: 1 }, { volumeCount: 1 });
    expect(equal.ok).toBe(true);
  });

  it('minimum: 下回れば ok=false', () => {
    const outcome = evaluateVerify({ resultField: 'volumeCount', minimum: 1 }, { volumeCount: 0 });
    expect(outcome.ok).toBe(false);
    expect(outcome.evaluated).toBe(true);
  });

  it('結果にフィールドが無ければ field_missing（評価不能）', () => {
    const outcome = evaluateVerify({ resultField: 'flushed', equals: true }, { exitCode: 0 });
    expect(outcome).toMatchObject({ ok: null, evaluated: false, field: 'flushed' });
    expect(outcome.reason).toBe('field_missing');
  });

  it('結果がオブジェクトでなくても field_missing で例外を投げない', () => {
    for (const summary of [null, undefined, 'text', 42, [1, 2]]) {
      const outcome = evaluateVerify({ resultField: 'flushed', equals: true }, summary);
      expect(outcome.ok).toBeNull();
      expect(outcome.evaluated).toBe(false);
      expect(outcome.reason).toBe('field_missing');
    }
  });

  it('型が合わなければ type_mismatch（ok=null で成功扱いにしない）', () => {
    const objectActual = evaluateVerify(
      { resultField: 'status', equals: 'Running' },
      {
        status: { value: 'Running' },
      },
    );
    expect(objectActual).toMatchObject({ ok: null, evaluated: false, reason: 'type_mismatch' });

    const objectExpected = evaluateVerify(
      { resultField: 'status', equals: { value: 'Running' } },
      {
        status: 'Running',
      },
    );
    expect(objectExpected.reason).toBe('type_mismatch');

    const stringNumber = evaluateVerify({ resultField: 'n', minimum: 1 }, { n: '2' });
    expect(stringNumber.reason).toBe('type_mismatch');

    const stringMinimum = evaluateVerify({ resultField: 'n', minimum: '1' }, { n: 2 });
    expect(stringMinimum.reason).toBe('type_mismatch');
  });

  it('ドットパスは解釈しない（result_summary のトップレベルキーだけ）', () => {
    const outcome = evaluateVerify({ resultField: 'a.b', equals: 1 }, { a: { b: 1 } });
    expect(outcome.reason).toBe('field_missing');
  });
});

describe('evaluateVerify（評価不能の明示）', () => {
  it('script 形態は requires_followup（成功と見なさない）', () => {
    const outcome = evaluateVerify(
      {
        description: '再起動後に Spooler が Running であること',
        script: 'scripts/skills/windows/service-status.ps1',
        args: ['-Service', 'Spooler'],
        expect: { status: 'Running' },
      },
      { status: 'Running' },
    );
    expect(outcome).toMatchObject({
      ok: null,
      evaluated: false,
      description: '再起動後に Spooler が Running であること',
      reason: 'requires_followup',
    });
  });

  it('verify 未定義（null）は no_verify_definition', () => {
    for (const verify of [null, undefined, {}, [], 'script']) {
      const outcome = evaluateVerify(verify, { status: 'Running' });
      expect(outcome.ok).toBeNull();
      expect(outcome.evaluated).toBe(false);
      expect(outcome.reason).toBe('no_verify_definition');
    }
  });

  it('比較子が無い / 両方ある場合は no_comparator', () => {
    expect(evaluateVerify({ resultField: 'x' }, { x: 1 }).reason).toBe('no_comparator');
    const both = evaluateVerify({ resultField: 'x', equals: 1, minimum: 1 }, { x: 1 });
    expect(both.ok).toBeNull();
    expect(both.reason).toBe('no_comparator');
  });

  it('壊れた verify / 結果でも例外を投げない', () => {
    const weird: unknown[] = [
      undefined,
      null,
      42,
      'x',
      [],
      { resultField: 42 },
      { resultField: 'x', equals: Symbol('x') },
      { resultField: 'x', minimum: Number.NaN },
    ];
    for (const verify of weird) {
      expect(() => evaluateVerify(verify, { x: Number.NaN })).not.toThrow();
    }
  });
});

describe('evaluateFollowupVerify（script 形態 verify の追撃評価）', () => {
  const verify = {
    description: '再起動後に Spooler が Running であること',
    script: 'scripts/skills/windows/service-status.ps1',
    args: ['-Service', 'Spooler'],
    expect: { status: 'Running' },
  };

  it('expect をサブセット一致で評価し、actual は expect のキーだけ残す', () => {
    const outcome = evaluateFollowupVerify(verify, {
      status: 'Running',
      name: 'Spooler',
      summary: 'Spooler: Running',
    });
    expect(outcome).toMatchObject({
      ok: true,
      evaluated: true,
      field: null,
      description: '再起動後に Spooler が Running であること',
      expected: { status: 'Running' },
      actual: { status: 'Running' },
    });
    expect(outcome?.reason).toBeUndefined();
  });

  it('不一致は ok=false / attempt_expect_mismatch（停止しない）', () => {
    const outcome = evaluateFollowupVerify(verify, { status: 'Stopped' });
    expect(outcome).toMatchObject({
      ok: false,
      evaluated: true,
      field: null,
      actual: { status: 'Stopped' },
      expected: { status: 'Running' },
      reason: 'attempt_expect_mismatch',
    });
  });

  it('期待キーが結果に無ければ不一致（actual は null で残す）', () => {
    const outcome = evaluateFollowupVerify(verify, { name: 'Spooler' });
    expect(outcome).toMatchObject({ ok: false, actual: { status: null } });
    expect(outcome?.reason).toBe('attempt_expect_mismatch');
  });

  it('ネストした expect は再帰的にサブセット一致する', () => {
    const nested = { expect: { service: { name: 'Spooler', state: 'Running' } } };
    expect(
      evaluateFollowupVerify(nested, {
        service: { name: 'Spooler', state: 'Running', pid: 4 },
      })?.ok,
    ).toBe(true);
    expect(
      evaluateFollowupVerify(nested, { service: { name: 'Spooler', state: 'Stopped' } })?.ok,
    ).toBe(false);
    expect(evaluateFollowupVerify(nested, { service: 'Spooler' })?.ok).toBe(false);
  });

  it('配列・プリミティブは厳密比較（subset にしない）', () => {
    const arrayVerify = { expect: { ports: [80, 443] } };
    expect(evaluateFollowupVerify(arrayVerify, { ports: [80, 443] })?.ok).toBe(true);
    expect(evaluateFollowupVerify(arrayVerify, { ports: [80, 443, 8080] })?.ok).toBe(false);
    expect(evaluateFollowupVerify({ expect: { count: 0 } }, { count: 0 })?.ok).toBe(true);
    expect(evaluateFollowupVerify({ expect: { count: 0 } }, { count: '0' })?.ok).toBe(false);
  });

  it('expect が無い・空・壊れている場合は null（評価不能）', () => {
    for (const broken of [
      null,
      undefined,
      {},
      { expect: null },
      { expect: [] },
      { expect: {} },
      'script',
      42,
    ]) {
      expect(evaluateFollowupVerify(broken, { status: 'Running' })).toBeNull();
    }
  });

  it('結果がオブジェクトでなくても例外を投げない', () => {
    for (const summary of [null, undefined, 'text', 42, [1, 2]]) {
      const outcome = evaluateFollowupVerify(verify, summary);
      expect(outcome?.ok).toBe(false);
      expect(outcome?.reason).toBe('attempt_expect_mismatch');
    }
  });
});
