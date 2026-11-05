import { describe, expect, it } from 'vitest';
import {
  expectedSmokeOwnerComment,
  isSmokeOwnerComment,
  isSmokeOwnerToken,
} from './smoke-guards.mjs';

const TOKEN = 'a1'.repeat(32);
const OTHER = 'b2'.repeat(32);

describe('isSmokeOwnerToken: 32 byte hex だけを受け入れる', () => {
  it('64 文字の小文字 hex を受け入れる', () => {
    expect(isSmokeOwnerToken(TOKEN)).toBe(true);
    expect(isSmokeOwnerToken('0'.repeat(64))).toBe(true);
    expect(isSmokeOwnerToken('f'.repeat(64))).toBe(true);
  });

  it.each([
    ['空文字', ''],
    ['63文字', 'a'.repeat(63)],
    ['65文字', 'a'.repeat(65)],
    ['大文字', TOKEN.toUpperCase()],
    ['非hex', 'g'.repeat(64)],
    ['接頭辞付き', `x${TOKEN.slice(1)}`],
    ['改行付き', `${TOKEN}\n`],
    ['空白付き', ` ${TOKEN}`],
    ['数値', 1],
    ['配列', [TOKEN]],
    ['null', null],
    ['undefined', undefined],
  ])('不正な token を拒否する: %s', (_label, value) => {
    expect(isSmokeOwnerToken(value)).toBe(false);
  });
});

describe('expectedSmokeOwnerComment: comment の期待値を組み立てる', () => {
  it('正しい token では smoke-owner:<token> を返す', () => {
    expect(expectedSmokeOwnerComment(TOKEN)).toBe(`smoke-owner:${TOKEN}`);
  });

  it.each([
    ['短い', 'abc'],
    ['大文字', TOKEN.toUpperCase()],
    ['null', null],
  ])('不正な token では comment を作らない: %s', (_label, value) => {
    expect(expectedSmokeOwnerComment(value)).toBeUndefined();
  });
});

describe('isSmokeOwnerComment: 完全一致だけを合格にする', () => {
  it('生成した期待値と一致する', () => {
    expect(isSmokeOwnerComment(expectedSmokeOwnerComment(TOKEN), TOKEN)).toBe(true);
    expect(isSmokeOwnerComment(`smoke-owner:${TOKEN}`, TOKEN)).toBe(true);
  });

  it.each([
    ['不一致 token', `smoke-owner:${OTHER}`, TOKEN],
    ['接頭辞なし', TOKEN, TOKEN],
    ['接頭辞違い', `owner:${TOKEN}`, TOKEN],
    ['末尾追加', `smoke-owner:${TOKEN}x`, TOKEN],
    ['先頭追加', `xsmoke-owner:${TOKEN}`, TOKEN],
    ['空文字', '', TOKEN],
    ['null', null, TOKEN],
    ['undefined', undefined, TOKEN],
    ['数値', 1, TOKEN],
    ['token 不正', `smoke-owner:${TOKEN}`, TOKEN.toUpperCase()],
    ['token 欠落', `smoke-owner:${TOKEN}`, undefined],
  ])('一致しない comment を拒否する: %s', (_label, actual, token) => {
    expect(isSmokeOwnerComment(actual, token)).toBe(false);
  });

  it('comment が別 token の刻印でも合格にしない', () => {
    expect(isSmokeOwnerComment(`smoke-owner:${OTHER}`, TOKEN)).toBe(false);
  });
});
