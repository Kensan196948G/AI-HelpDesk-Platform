/**
 * 配備物の残骸を作らないための回帰試験。
 *
 * `tsc -p tsconfig.json` は出力先を掃除しないため、削除したモジュールの .js が
 * dist に残り続ける（実測: 本番 dist に削除済みの prototype-knowledge.js が残存）。
 * build script が dist を消してから tsc することを固定する。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('apps/api の build script', () => {
  const pkg = JSON.parse(readFileSync('apps/api/package.json', 'utf8'));

  it('dist を掃除してから tsc する', () => {
    const build = pkg.scripts.build;
    expect(build).toContain('rmSync');
    expect(build).toContain("'dist'");
    expect(build.indexOf('rmSync')).toBeLessThan(build.indexOf('tsc'));
  });

  it('掃除の対象は dist のみ（リポジトリ全体を消さない）', () => {
    const build = pkg.scripts.build;
    expect(build).not.toMatch(/rmSync\(['"]\.?\/?['"]/);
    expect(build).not.toContain("rmSync('src'");
  });
});
