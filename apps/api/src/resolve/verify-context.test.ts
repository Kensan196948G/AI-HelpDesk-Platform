import { describe, expect, it } from 'vitest';
import { effectiveVerifyForAi } from './routes.js';

/**
 * script 形態 verify の追撃ステップは自身の verify を持たない（no_verify_definition）。
 * 親ステップの verify_result が実際の評価結果なので、AI にはそれを渡す。
 * 2026-10-26: 追撃を実装した際、追撃ステップの値（評価不能）をそのまま AI に渡しており、
 * 不一致時に AI が親の評価を見られなかった。
 */
describe('effectiveVerifyForAi', () => {
  it('通常ステップは自身の verify を返す', () => {
    expect(
      effectiveVerifyForAi(
        { verify_result: { ok: true, evaluated: true }, verify_for_step_id: null },
        undefined,
      ),
    ).toEqual({ ok: true, evaluated: true });
  });

  it('追撃ステップは親の verify を返す', () => {
    expect(
      effectiveVerifyForAi(
        { verify_result: { ok: null, evaluated: false }, verify_for_step_id: 'parent-1' },
        { verify_result: { ok: false, evaluated: true, reason: 'attempt_expect_mismatch' } },
      ),
    ).toEqual({ ok: false, evaluated: true, reason: 'attempt_expect_mismatch' });
  });

  it('追撃でも親に評価が無ければ自身の値へフォールバックする', () => {
    expect(
      effectiveVerifyForAi(
        { verify_result: { ok: null, evaluated: false }, verify_for_step_id: 'parent-1' },
        { verify_result: null },
      ),
    ).toEqual({ ok: null, evaluated: false });
  });

  it('親行が無い追撃ステップは自身の値を返す（安全側）', () => {
    expect(
      effectiveVerifyForAi(
        { verify_result: { ok: null }, verify_for_step_id: 'missing' },
        undefined,
      ),
    ).toEqual({ ok: null });
  });

  it('done ステップが無ければ null', () => {
    expect(effectiveVerifyForAi(undefined, undefined)).toBeNull();
  });
});
