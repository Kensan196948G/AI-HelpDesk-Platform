import { describe, expect, it } from 'vitest';
import { isEnvFileTestSwitch } from './test-database.js';

describe('isEnvFileTestSwitch: 環境ファイルでは test へ切り替えない', () => {
  it.each([
    ['未設定', undefined],
    ['production', 'production'],
    ['development', 'development'],
  ])('%s から test への切替を検出する', (_label, initial) => {
    expect(isEnvFileTestSwitch(initial, 'test')).toBe(true);
  });

  it('production から test への切替を検出する', () => {
    expect(isEnvFileTestSwitch('production', 'test')).toBe(true);
  });

  it.each([
    ['test', 'test'],
    ['test', undefined],
    ['test', 'production'],
    [undefined, undefined],
    [undefined, 'development'],
    ['production', 'production'],
  ])('切替ではない組合せは検出しない: %s -> %s', (initial, current) => {
    expect(isEnvFileTestSwitch(initial, current)).toBe(false);
  });
});
