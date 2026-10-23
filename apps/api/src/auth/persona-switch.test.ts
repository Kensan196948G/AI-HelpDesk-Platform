import { describe, expect, it } from 'vitest';
import { personaSwitchMode } from './persona-switch.js';

describe('personaSwitchMode', () => {
  it('local（開発・テスト）は any', () => {
    expect(personaSwitchMode('someone@example.com', 'local')).toBe('any');
  });

  it('本番（cloudflare-access）は本人以外へ切り替え不可（self）', () => {
    expect(personaSwitchMode('taro@mirai-const.co.jp', 'cloudflare-access')).toBe('self');
  });

  it('メールが無い場合は self（安全側）', () => {
    expect(personaSwitchMode(null, 'cloudflare-access')).toBe('self');
  });
});
