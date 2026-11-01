import { describe, expect, it } from 'vitest';
import { maskSensitivePcValue, redactPII } from './pii.js';

describe('redactPII', () => {
  it('メール・電話・IP・カード・パスワードを伏せ字にする', () => {
    const result = redactPII(
      '連絡先は taro.yamada@example.com、電話 090-1234-5678、IP 10.20.30.41、カード 4111-1111-1111-1111、パスワード: Secret123 です。',
    );
    expect(result.text).toContain('[メールアドレス]');
    expect(result.text).toContain('[電話番号]');
    expect(result.text).toContain('[IPアドレス]');
    expect(result.text).toContain('[カード番号]');
    expect(result.text).toContain('[パスワード]');
    expect(result.text).not.toContain('taro.yamada@example.com');
    expect(result.text).not.toContain('Secret123');
    expect(result.findings.length).toBeGreaterThanOrEqual(5);
  });

  it('資産番号を伏せ字にする', () => {
    const result = redactPII('端末 PC-0241 の調子が悪いです。');
    expect(result.text).toContain('[資産番号]');
    expect(result.text).not.toContain('PC-0241');
  });

  it('ケース番号や日付を誤って伏せ字にしない', () => {
    const text = 'TKT-2026-0101 は 2026-10-23 10:12 に受付しました。';
    expect(redactPII(text).text).toBe(text);
  });

  it('該当なしのときは変更しない', () => {
    const text = '共有フォルダが開けません。';
    expect(redactPII(text).text).toBe(text);
    expect(redactPII(text).findings).toHaveLength(0);
  });
});

describe('maskSensitivePcValue', () => {
  it('外部向けに IP・シリアル・資産番号を隠す', () => {
    expect(maskSensitivePcValue('ip_address', '10.0.0.1')).toBe('[IPアドレス]');
    expect(maskSensitivePcValue('serial', 'SN-1')).toBe('[シリアル番号]');
    expect(maskSensitivePcValue('asset_no', 'PC-1')).toBe('[資産番号]');
    expect(maskSensitivePcValue('os', 'Windows 11')).toBe('Windows 11');
  });
});

describe('redactPII（表記ゆれ）', () => {
  it.each([
    ['PW: Abc12345', 'Abc12345'],
    ['pass=hunter22', 'hunter22'],
    ['パスワード abc123 です', 'abc123'],
    ['電話は +81 90 1234 5678 です', '1234 5678'],
    ['電話は 090 1234 5678 です', '1234 5678'],
    ['電話は ０９０－１２３４－５６７８ です', '５６７８'],
    ['連絡は taro＠example.com まで', 'taro'],
    ['IPv6 は 2001:db8::1 です', '2001:db8::1'],
    ['IPv6 は fe80:0:0:0:200:f8ff:fe21:67cf です', 'fe21:67cf'],
  ])('%s を伏せ字にする', (input, secret) => {
    expect(redactPII(input).text).not.toContain(secret);
  });

  it.each([
    'パスワード 変更方法を教えてください',
    '会議は 10:30:00 に開始します',
    'TKT-2026-0101 は 2026-10-23 10:12 に受付しました。',
  ])('%s は変更しない', (text) => {
    expect(redactPII(text).text).toBe(text);
  });
});

describe('UUID の中の数字を電話番号と誤認しない', () => {
  it('実行 ID をそのまま残し、横の電話番号は伏せる', () => {
    const id = '23b8f117-7833-441e-83b7-7ad081537ae9';
    const result = redactPII(`実行ID ${id} 連絡先 090-1234-5678`);
    expect(result.text).toContain(id);
    expect(result.text).toContain('[電話番号]');
    expect(result.text).not.toContain('090-1234-5678');
  });

  it('UUID に見えない 16 進の並びの電話番号は従来どおり伏せる', () => {
    expect(redactPII('tel09012345678').text).toContain('[電話番号]');
  });
});
