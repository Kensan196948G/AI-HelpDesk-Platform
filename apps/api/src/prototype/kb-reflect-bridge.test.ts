import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

/**
 * 承認後の「今回反映」（docs/95）。モーダルの文面からナレッジ番号を読み、
 * 30 分だけ強調する部分を実物から評価する。DOM は起動しない。
 */
const code = readFileSync(new URL('./kb-reflect-bridge.js', import.meta.url), 'utf8');

function pick(name: string) {
  const match = new RegExp(`function ${name}\\([\\s\\S]*?\\n {2}}\\n`).exec(code);
  if (!match) throw new Error(name + ' が見つかりません');
  return vm.runInNewContext(`(${match[0]})`, { TTL: 30 * 60 * 1000 });
}

describe('承認完了モーダルから保存先を読む', () => {
  const parse = pick('reflectKbId') as (text: string) => string | null;

  it('「ナレッジDBへ保存：KB-…」から番号を読む', () => {
    expect(parse('ナレッジDBへ保存：KB-105 v1.3（新規）')).toBe('KB-105');
    expect(
      parse('承認完了 — DB保存・本棚に反映\nナレッジDBへ保存：KB-999 v2.0（改訂：v1.0から）'),
    ).toBe('KB-999');
  });

  it('承認完了以外の文面からは読まない', () => {
    expect(parse('ナレッジDBへ保存：')).toBeNull();
    expect(parse('承認待ちの下書き')).toBeNull();
    expect(parse('')).toBeNull();
  });
});

describe('「今回反映」の有効期間', () => {
  const active = pick('reflectActive') as (
    record: { id: string; at: number } | null,
    now: number,
  ) => { id: string } | null;

  const now = 1_800_000_000_000;

  it('30 分以内なら強調する', () => {
    expect(active({ id: 'KB-105', at: now - 29 * 60 * 1000 }, now)).toEqual({
      id: 'KB-105',
      at: now - 29 * 60 * 1000,
    });
  });

  it('30 分を超えたら強調しない（古い承認を「今回」と呼ばない）', () => {
    expect(active({ id: 'KB-105', at: now - 31 * 60 * 1000 }, now)).toBeNull();
    expect(active({ id: 'KB-105', at: now - 30 * 60 * 1000 - 1 }, now)).toBeNull();
  });

  it('記録が無い・欠けている場合は何もしない', () => {
    expect(active(null, now)).toBeNull();
    expect(active({ id: '', at: now }, now)).toBeNull();
    expect(active({ id: 'KB-105', at: 0 }, now)).toBeNull();
  });
});

describe('画面への差し込み', () => {
  it('承認完了モーダルに一覧への導線を足し、一覧で「今回反映」を出す', () => {
    expect(code).toContain('data-ahd-reflect-go');
    expect(code).toContain('⑦ ナレッジDBの一覧で確認');
    expect(code).toContain("app.go('kb')");
    expect(code).toContain('今回反映');
    expect(code).toContain('scrollIntoView');
    expect(code).toContain('sessionStorage.getItem(KEY)');
  });

  it('一覧の判定は ⑦ の検索欄があるときだけ（他の表を誤って強調しない）', () => {
    expect(code).toContain("document.getElementById('kb_q')");
  });
});
