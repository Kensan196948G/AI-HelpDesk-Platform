import { describe, expect, it } from 'vitest';
import { canonicalEmail, emailVariants, parseAliases } from './email-alias.js';

const ALIASES = 'me@gmail.com=me@mirai-const.co.jp, other@example.com=me@mirai-const.co.jp';

describe('parseAliases', () => {
  it('alias=primary を解釈する', () => {
    const map = parseAliases('A@x.jp=b@y.jp');
    expect(map.get('a@x.jp')).toBe('b@y.jp');
  });
  it('不正な組は無視する', () => {
    expect(parseAliases('broken, =x, y=').size).toBe(0);
  });
});

describe('canonicalEmail', () => {
  it('別名を primary に正規化する', () => {
    expect(canonicalEmail('ME@gmail.com', ALIASES)).toBe('me@mirai-const.co.jp');
  });
  it('primary はそのまま', () => {
    expect(canonicalEmail('me@mirai-const.co.jp', ALIASES)).toBe('me@mirai-const.co.jp');
  });
  it('未登録はそのまま（小文字化）', () => {
    expect(canonicalEmail('Someone@Example.com', ALIASES)).toBe('someone@example.com');
  });
  it('空は空', () => {
    expect(canonicalEmail('', ALIASES)).toBe('');
  });
});

describe('emailVariants', () => {
  it('正規化後と別名の両方を返す', () => {
    expect(emailVariants('me@gmail.com', ALIASES)).toEqual([
      'me@mirai-const.co.jp',
      'me@gmail.com',
      'other@example.com',
    ]);
  });
});
