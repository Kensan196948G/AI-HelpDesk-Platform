import { describe, expect, it } from 'vitest';
import { isDatabaseStarting, retryWhileStarting } from './startup-retry.js';

describe('起動直後の DB 待ち再試行', () => {
  it('DB 起動待ちのエラーだけを既知コードで判定する', () => {
    expect(isDatabaseStarting(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))).toBe(
      true,
    );
    expect(isDatabaseStarting(Object.assign(new Error('starting'), { code: '57P03' }))).toBe(true);
    expect(isDatabaseStarting(Object.assign(new Error('auth'), { code: '28P01' }))).toBe(false);
    expect(isDatabaseStarting(new Error('plain'))).toBe(false);
    expect(isDatabaseStarting(null)).toBe(false);
  });

  it('一過性の失敗のあと成功すれば、待機して結果を返す', async () => {
    const waits: number[] = [];
    let calls = 0;
    const result = await retryWhileStarting(
      async () => {
        calls += 1;
        if (calls < 3) throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
        return 'synced';
      },
      { attempts: 5, delaysMs: [10, 20, 30], sleep: async (ms) => void waits.push(ms) },
    );
    expect(result).toBe('synced');
    expect(calls).toBe(3);
    expect(waits).toEqual([10, 20]);
  });

  it('再試行対象外のエラーは待機せずにそのまま投げる', async () => {
    const waits: number[] = [];
    let calls = 0;
    await expect(
      retryWhileStarting(
        async () => {
          calls += 1;
          throw Object.assign(new Error('bad password'), { code: '28P01' });
        },
        { attempts: 5, sleep: async (ms) => void waits.push(ms) },
      ),
    ).rejects.toThrow('bad password');
    expect(calls).toBe(1);
    expect(waits).toEqual([]);
  });

  it('上限まで失敗したら最後のエラーを投げる', async () => {
    let calls = 0;
    await expect(
      retryWhileStarting(
        async () => {
          calls += 1;
          throw Object.assign(new Error(`refused-${calls}`), { code: 'ECONNREFUSED' });
        },
        { attempts: 3, delaysMs: [1], sleep: async () => {} },
      ),
    ).rejects.toThrow('refused-3');
    expect(calls).toBe(3);
  });
});
