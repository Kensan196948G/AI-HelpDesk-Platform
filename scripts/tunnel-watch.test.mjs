import { describe, expect, it } from 'vitest';
import { buildMessage, countFailures, DEFAULTS, shouldNotify } from './tunnel-watch.mjs';

describe('tunnel-watch', () => {
  it('cloudflared の要求失敗とプロキシの転送失敗だけを数える', () => {
    const lines = [
      '2026-11-04T00:38:32Z ERR Request failed error="Incoming request ended abruptly: context canceled"',
      '2026-11-04T00:38:32Z ERR  error="Incoming request ended abruptly: context canceled" event=1',
      '[proxy] upstream error: upstream timeout',
      '[proxy] upstream error: socket hang up',
      '2026-11-04T00:51:47Z INF Registered tunnel connection connIndex=0',
      '2026-11-04T00:51:35Z ERR Connection terminated connIndex=1',
    ];
    expect(countFailures(lines)).toBe(3);
  });

  it('しきい値未満、または前回の送信から 60 分以内なら送らない', () => {
    const now = Date.parse('2026-11-04T01:00:00Z');
    const base = { threshold: 3, now, cooldownMin: DEFAULTS.cooldownMin };
    expect(shouldNotify({ ...base, count: 2, lastSentAt: null })).toBe(false);
    expect(shouldNotify({ ...base, count: 3, lastSentAt: null })).toBe(true);
    expect(shouldNotify({ ...base, count: 9, lastSentAt: now - 59 * 60_000 })).toBe(false);
    expect(shouldNotify({ ...base, count: 9, lastSentAt: now - 60 * 60_000 })).toBe(true);
  });

  it('本文に件数と手順だけを入れ、URL やメールアドレスを入れない', () => {
    const { subject, text } = buildMessage({ count: 7, windowMin: 10 });
    expect(subject).toContain('トンネル');
    expect(text).toContain('7 件');
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toMatch(/@[a-z0-9.-]+\.[a-z]+/i);
  });
});
