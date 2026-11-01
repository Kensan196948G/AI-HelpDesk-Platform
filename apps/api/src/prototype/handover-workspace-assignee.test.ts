import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

/**
 * 担当者欄の既定値（docs/14 §2-15）。原本のデモ担当者を既定にしない。
 * 関数の本文だけを実物のブリッジから取り出して評価する（画面全体は vm で動かさない）。
 */
const code = readFileSync(new URL('./handover-workspace-bridge.js', import.meta.url), 'utf8');

function pick(): (names: string[], suggest: string, me: unknown) => string {
  const match = /function defaultAssignee\([\s\S]*?\n {2}}\n/.exec(code);
  if (!match) throw new Error('defaultAssignee が見つかりません');
  return vm.runInNewContext(`(${match[0]})`);
}

describe('担当者欄の既定値', () => {
  const names = ['佐藤', '田中', '合成 担当者'];

  it('名簿の本人でログインしていれば本人を選ぶ（おすすめのデモ名より優先）', () => {
    expect(pick()(names, '佐藤', { real: true, name: '合成 担当者' })).toBe('合成 担当者');
  });

  it('本人が選択肢に無ければ未選択にする（先頭のデモ名を選ばない）', () => {
    expect(pick()(names, '佐藤', { real: true, name: '名簿の別人' })).toBe('');
  });

  it('デモの利用者（切替モード）は従来どおりおすすめを選ぶ', () => {
    expect(pick()(names, '田中', { real: false, name: '山田' })).toBe('田中');
    expect(pick()(names, '', { real: false, name: '山田' })).toBe('佐藤');
  });
});

describe('解決ループのカードの出典の見出し', () => {
  const bridge = readFileSync(new URL('./resolve-bridge.js', import.meta.url), 'utf8');

  it('全件を「別の担当者が承認した」と決めつけず、項目ごとの出所を出す', () => {
    expect(bridge).not.toContain('別の担当者が承認したナレッジ');
    expect(bridge).toContain('approvalOriginLabel');
    expect(bridge).toContain('出所を確認できません');
  });
});
