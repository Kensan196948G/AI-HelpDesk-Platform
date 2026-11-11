import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

/**
 * PC情報からの補足（docs/97）。★表示と同じ判定を使い、新しい診断をしないことを確認する。
 * DOM は起動せず、純粋関数の契約だけを実物から評価する。
 */
const code = readFileSync(new URL('./pc-supplement-bridge.js', import.meta.url), 'utf8');

function pick(name: string) {
  const match = new RegExp(`function ${name}\\([\\s\\S]*?\\n {2}}\\n`).exec(code);
  if (!match) throw new Error(name + ' が見つかりません');
  return vm.runInNewContext(`(${match[0]})`, {
    ATTR: 'data-ahd-pc-supplement',
    esc: (value: unknown) =>
      String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
      }),
  });
}

describe('★の項目の抽出', () => {
  const starItems = pick('starItems') as (items: string[]) => string[];

  it('★が付いた項目だけを取り出し、★を外す', () => {
    expect(starItems(['★ 前回の再起動から23日', '・IPアドレス', '★ 印刷スプーラ：停止'])).toEqual([
      '前回の再起動から23日',
      '印刷スプーラ：停止',
    ]);
  });

  it('★が無ければ空（補足を出さない）', () => {
    expect(starItems(['・IPアドレス', '・OS'])).toEqual([]);
    expect(starItems([])).toEqual([]);
  });
});

describe('補足の表示', () => {
  const html = pick('supplementHTML') as (items: string[]) => string;

  it('見出しと項目を出し、IP・シリアルを出さないことを書く', () => {
    const out = html(['前回の再起動から23日']);
    expect(out).toContain('PC情報からの補足');
    expect(out).toContain('前回の再起動から23日');
    expect(out).toContain('IPアドレス・シリアル番号は表示していません');
    expect(out).toContain('同じ判定');
  });

  it('項目が無ければ何も出さない', () => {
    expect(html([])).toBe('');
  });

  it('値を実体参照にする', () => {
    const out = html(['<img src=x onerror=alert(1)>']);
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
  });

  it('既存の★表示を読むだけで、新しい診断をしない', () => {
    expect(code).toContain("includes('気になる点')");
    expect(code).toContain('★');
    expect(code).not.toContain('/api/');
    expect(code).toContain("querySelectorAll('[data-aihd-kb-guide]')");
  });
});
