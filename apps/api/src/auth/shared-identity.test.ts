import { describe, expect, it } from 'vitest';
import { parseSharedIdentityGroups, sameHuman } from './shared-identity.js';

describe('SHARED_IDENTITY_GROUPS', () => {
  const raw = 'kensan1969@gmail.com|k-aritoh@mirai-const.co.jp;a@example.com|b@example.com';

  it('同じ組の別アカウントは同一人物と判定する', () => {
    expect(sameHuman('k-aritoh@mirai-const.co.jp', 'kensan1969@gmail.com', raw)).toBe(true);
    expect(sameHuman('Kensan1969@Gmail.com', 'a@example.com', raw)).toBe(false);
  });

  it('同じ文字列は「別アカウント」ではないので false', () => {
    expect(sameHuman('kensan1969@gmail.com', 'kensan1969@gmail.com', raw)).toBe(false);
  });

  it('組に無い/未設定なら false（既定の挙動を変えない）', () => {
    expect(sameHuman('x@example.com', 'y@example.com', raw)).toBe(false);
    expect(sameHuman('a@example.com', 'b@example.com', '')).toBe(false);
    expect(sameHuman(null, 'a@example.com', raw)).toBe(false);
  });

  it('空要素・1件だけの組は無視する', () => {
    expect(parseSharedIdentityGroups('a@x|;|b@y;;c@z|d@w')).toEqual([['c@z', 'd@w']]);
    expect(sameHuman('a@x', 'b@y', 'a@x|;|b@y')).toBe(false);
  });

  it('複数グループを順に照合する', () => {
    expect(sameHuman('a@example.com', 'b@example.com', raw)).toBe(true);
    expect(sameHuman('a@example.com', 'kensan1969@gmail.com', raw)).toBe(false);
  });
});
