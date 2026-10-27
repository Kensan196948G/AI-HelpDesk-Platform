import { describe, expect, it } from 'vitest';
import { sanitizeForJson, sanitizeText } from './unicode.js';

describe('sanitizeText', () => {
  it('U+0000 を除去する', () => {
    expect(sanitizeText('a\u0000b')).toBe('ab');
    expect(sanitizeText('\u0000\u0000')).toBe('');
  });

  it('単独サロゲートを置換文字 U+FFFD にする', () => {
    expect(sanitizeText('x\uD800')).toBe('x\uFFFD');
    expect(sanitizeText('\uDC00y')).toBe('\uFFFDy');
  });

  it('正常なサロゲートペア（絵文字）は変更しない', () => {
    expect(sanitizeText('🖥️ PC')).toBe('🖥️ PC');
  });
});

describe('sanitizeForJson', () => {
  it('ネストした文字列とキーを再帰的に処理する', () => {
    const input = {
      name: 'a\u0000b',
      list: [{ v: 'c\u0000' }],
      '\u0000key': 1,
      n: 3,
    };
    expect(sanitizeForJson(input)).toEqual({
      name: 'ab',
      list: [{ v: 'c' }],
      key: 1,
      n: 3,
    });
  });

  it('配列とプリミティブを保つ', () => {
    expect(sanitizeForJson([1, 'a\u0000', true, null])).toEqual([1, 'a', true, null]);
  });
});
