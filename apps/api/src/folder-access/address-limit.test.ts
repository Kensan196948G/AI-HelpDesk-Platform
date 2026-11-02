import { afterEach, describe, expect, it } from 'vitest';
import { checkRateLimit, resetRateLimits } from '../lib/rate-limit.js';
import { checkAddressLimit, resetAddressLimits } from './address-limit.js';

describe('未認証の接続元の制限（共通のバケットと別枠）', () => {
  afterEach(() => {
    resetAddressLimits();
    resetRateLimits();
  });

  it('上限まで通し、窓が切れるまで拒否する', () => {
    expect(checkAddressLimit('a', 2, 60_000)).toBe(true);
    expect(checkAddressLimit('a', 2, 60_000)).toBe(true);
    expect(checkAddressLimit('a', 2, 60_000)).toBe(false);
    expect(checkAddressLimit('b', 2, 60_000)).toBe(true);
  });

  it('満杯なら新しい接続元を拒否するが、共通のバケットは埋めない', () => {
    let denied = false;
    for (let index = 0; index < 20_000; index += 1) {
      if (!checkAddressLimit(`addr-${index}`, 5, 60_000)) denied = true;
    }
    expect(denied).toBe(true);
    expect(checkRateLimit('authenticated', 1, 60_000)).toBe(true);
  });
});
