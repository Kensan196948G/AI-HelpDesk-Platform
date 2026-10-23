import { describe, expect, it } from 'vitest';
import { hashPassword, hashSessionToken, verifyPassword } from './password.js';

describe('password hashing', () => {
  it('正しいパスワードだけ検証を通す', () => {
    const stored = hashPassword('Demo-Mirai-2026!');
    expect(stored.startsWith('scrypt$')).toBe(true);
    expect(verifyPassword('Demo-Mirai-2026!', stored)).toBe(true);
    expect(verifyPassword('wrong', stored)).toBe(false);
  });

  it('毎回異なる salt を使う', () => {
    expect(hashPassword('same')).not.toBe(hashPassword('same'));
  });

  it('セッショントークンのハッシュは secret に依存する', () => {
    const token = 'token-abc';
    expect(hashSessionToken(token, 'a')).toBe(hashSessionToken(token, 'a'));
    expect(hashSessionToken(token, 'a')).not.toBe(hashSessionToken(token, 'b'));
  });
});
