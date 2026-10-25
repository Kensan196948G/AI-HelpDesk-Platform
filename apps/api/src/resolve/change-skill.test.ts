import { describe, expect, it } from 'vitest';
import { isChangeSkillRow } from './routes.js';

/**
 * 「変更系（修復）Skill か」の判定。
 *
 * 2026-10-25 の経路2実測で、読み取り専用の `bitlocker.status` が rollback に
 * 説明文（script: null）を持つため変更系と誤認され、「状態を読んだだけ」で
 * 解決候補に数えられていた。リスク 1 は変更系にしない、を回帰として固定する。
 */
describe('isChangeSkillRow', () => {
  it('リスク 2 以上かつ rollback 定義ありは変更系', () => {
    expect(
      isChangeSkillRow({ rollback: { script: null, description: '戻せる' }, risk_level: 2 }),
    ).toBe(true);
    expect(
      isChangeSkillRow({ rollback: { script: null, description: '取消不可' }, risk_level: 3 }),
    ).toBe(true);
  });

  it('リスク 1 は rollback に説明文があっても変更系ではない（bitlocker.status の回帰）', () => {
    expect(
      isChangeSkillRow({
        rollback: { script: null, description: '変更しないため取消不要' },
        risk_level: 1,
      }),
    ).toBe(false);
  });

  it('rollback 未定義は変更系ではない（読み取り 5 件）', () => {
    expect(isChangeSkillRow({ rollback: null, risk_level: 1 })).toBe(false);
    expect(isChangeSkillRow({ rollback: undefined, risk_level: 2 })).toBe(false);
    expect(isChangeSkillRow(undefined)).toBe(false);
  });

  it('risk_level が文字列でも数値として解釈する（pg の型ゆれ）', () => {
    expect(isChangeSkillRow({ rollback: { description: 'x' }, risk_level: '2' })).toBe(true);
    expect(isChangeSkillRow({ rollback: { description: 'x' }, risk_level: '1' })).toBe(false);
  });

  it('risk_level が壊れている場合は安全側（変更系にしない）', () => {
    expect(isChangeSkillRow({ rollback: { description: 'x' }, risk_level: 'abc' })).toBe(false);
    expect(isChangeSkillRow({ rollback: { description: 'x' } })).toBe(false);
  });
});
