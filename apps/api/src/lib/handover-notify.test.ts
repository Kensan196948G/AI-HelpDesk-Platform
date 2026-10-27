import { describe, expect, it } from 'vitest';
import {
  buildHandoverBody,
  buildHandoverSubject,
  resolveConfiguredRecipients,
} from './handover-notify.js';
import { encodeHeaderValue, isValidEmail, sanitizeHeader } from './mailer.js';

const base = {
  handoverId: '11111111-1111-1111-1111-111111111111',
  caseId: 'CASE-0001',
  subject: '共有フォルダが開けません（連絡先 a@example.com）',
  requester: '山田 太郎',
  recipientName: '佐藤 奨太',
  receivedAt: new Date('2026-10-24T00:40:00Z'),
};

describe('引継ぎ通知メール', () => {
  it('件名に案件 ID と件名を入れ、メールアドレスは伏せる', () => {
    const subject = buildHandoverSubject(base);
    expect(subject).toContain('CASE-0001');
    expect(subject).toContain('共有フォルダが開けません');
    expect(subject).toContain('[AIヘルプデスク]');
    expect(subject).not.toContain('a@example.com');
  });

  it('件名・宛先に改行を混ぜられてもヘッダーが壊れない', () => {
    const subject = buildHandoverSubject({
      ...base,
      subject: '件名\r\nBcc: evil@example.com',
    });
    expect(subject).not.toMatch(/[\r\n]/);
    expect(sanitizeHeader('a\r\nb', 10)).toBe('a b');
  });

  it('件名が空のときだけ「(件名なし)」にする', () => {
    for (const subject of ['', '   ', '\r\n']) {
      const built = buildHandoverSubject({ ...base, subject });
      expect(built).toContain('(件名なし)');
      expect(built).toContain('CASE-0001');
      expect(buildHandoverBody({ ...base, subject })).toContain('件名    : (件名なし)');
    }
    // 件名があれば「(件名なし)」は出さない。
    expect(buildHandoverSubject(base)).not.toContain('(件名なし)');
  });

  it('本文に案件 ID・件名・依頼者・URL を載せ、相談本文や PC 情報は載せない', () => {
    const body = buildHandoverBody(base);
    expect(body).toContain('CASE-0001');
    expect(body).toContain('共有フォルダが開けません');
    expect(body).toContain('山田 太郎');
    expect(body).toContain('https://ai-helpdesk.mirai-dx-platform.com');
    expect(body).toContain('佐藤 奨太 さん');
    // メールアドレスは伏せ字になっている
    expect(body).not.toContain('a@example.com');
    expect(body).toContain('[メールアドレス]');
    expect(body).toContain('自動送信');
  });

  it('宛先が無いときはグループ向けの挨拶にする', () => {
    const body = buildHandoverBody({ ...base, recipientName: null });
    expect(body).toContain('DX 推進部のみなさま');
  });

  it('通知先の設定はカンマ区切りで、不正な値は無視する', () => {
    const recipients = resolveConfiguredRecipients();
    expect(Array.isArray(recipients)).toBe(true);
    for (const recipient of recipients) {
      expect(isValidEmail(recipient.email)).toBe(true);
    }
  });

  it('日本語のヘッダーは RFC 2047 で符号化する', () => {
    expect(encodeHeaderValue('Hello')).toBe('Hello');
    expect(encodeHeaderValue('こんにちは')).toMatch(/^=\?UTF-8\?B\?.+\?=$/);
  });
});
