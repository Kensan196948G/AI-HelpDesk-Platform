import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isEmailAllowed, parseAllowlist } from './allowlist.js';

const SAMPLE = `登録メール
「kensan1969@gmail.com」
「@mirai-const.co.jp」　例：k-aritoh@mirai-ocnst.co.jp」
のみでお願いします。`;

describe('parseAllowlist', () => {
  it('正本 docs/MailAddress.txt: 他社は完全一致 1 件だけ許可し、ドメインでは許可しない', () => {
    const text = readFileSync(new URL('../../../../docs/MailAddress.txt', import.meta.url), 'utf8');
    const allowlist = parseAllowlist(text);
    expect(allowlist.emails.size).toBe(2);
    expect([...allowlist.domains]).toEqual(['mirai-const.co.jp']);
    expect(isEmailAllowed(allowlist, 'other@takamatsu-cg.co.jp')).toBe(false);
  });

  it('MailAddress.txt の完全一致メールと @domain を抽出する', () => {
    const allowlist = parseAllowlist(SAMPLE);
    expect([...allowlist.emails]).toEqual(['kensan1969@gmail.com']);
    expect([...allowlist.domains]).toEqual(['mirai-const.co.jp']);
  });

  it('例示（例：以降）の typo メールを許可しない', () => {
    const allowlist = parseAllowlist(SAMPLE);
    expect(isEmailAllowed(allowlist, 'k-aritoh@mirai-ocnst.co.jp')).toBe(false);
    expect(isEmailAllowed(allowlist, 'k-aritoh@mirai-const.co.jp')).toBe(true);
  });

  it('コメントと空行を無視する', () => {
    const allowlist = parseAllowlist(`
      # 「nobody@example.com」はコメント
      「admin@example.com」 # 行末コメント
    `);
    expect([...allowlist.emails]).toEqual(['admin@example.com']);
    expect(isEmailAllowed(allowlist, 'nobody@example.com')).toBe(false);
  });

  it('*@domain と全角表記を受け付ける', () => {
    const allowlist = parseAllowlist(`
      *@example.co.jp
      ＠ｍｉｒａｉ－ｃｏｎｓｔ．ｃｏ．ｊｐ
    `);
    expect(allowlist.domains.has('example.co.jp')).toBe(true);
    expect(allowlist.domains.has('mirai-const.co.jp')).toBe(true);
  });

  it('重複をまとめ、大文字を小文字へ正規化する', () => {
    const allowlist = parseAllowlist(`
      User@Example.COM
      user@example.com
      「@Example.COM」
    `);
    expect(allowlist.emails.size).toBe(1);
    expect(allowlist.domains.size).toBe(1);
    expect([...allowlist.emails]).toEqual(['user@example.com']);
  });

  it('不正なエントリは無視する', () => {
    const allowlist = parseAllowlist(`
      not-an-email
      @nodot
      @-bad.example.com
      user@
    `);
    expect(allowlist.emails.size).toBe(0);
    expect(allowlist.domains.size).toBe(0);
  });

  it('空・見出しのみのファイルは 0 件（呼び出し側で全拒否）', () => {
    expect(parseAllowlist('').emails.size).toBe(0);
    expect(parseAllowlist('登録メール\nのみでお願いします。').domains.size).toBe(0);
  });
});

describe('isEmailAllowed', () => {
  const allowlist = parseAllowlist(SAMPLE);

  it('完全一致メールを許可する（大文字小文字を区別しない）', () => {
    expect(isEmailAllowed(allowlist, 'kensan1969@gmail.com')).toBe(true);
    expect(isEmailAllowed(allowlist, 'KENSAN1969@GMAIL.COM')).toBe(true);
    expect(isEmailAllowed(allowlist, ' kensan1969@gmail.com ')).toBe(true);
  });

  it('許可ドメインのメールを許可する', () => {
    expect(isEmailAllowed(allowlist, 'k-aritoh@mirai-const.co.jp')).toBe(true);
    expect(isEmailAllowed(allowlist, 'any.one+tag@mirai-const.co.jp')).toBe(true);
  });

  it('別ドメイン・サブドメイン・接尾辞一致を許可しない', () => {
    expect(isEmailAllowed(allowlist, 'other@example.com')).toBe(false);
    expect(isEmailAllowed(allowlist, 'other@gmail.com')).toBe(false);
    expect(isEmailAllowed(allowlist, 'taro@sub.mirai-const.co.jp')).toBe(false);
    expect(isEmailAllowed(allowlist, 'taro@mirai-const.co.jp.evil.example')).toBe(false);
    expect(isEmailAllowed(allowlist, 'taro@notmirai-const.co.jp')).toBe(false);
  });

  it('空の許可リストは全拒否する', () => {
    const empty = parseAllowlist('');
    expect(isEmailAllowed(empty, 'kensan1969@gmail.com')).toBe(false);
  });
});
