import { describe, expect, it } from 'vitest';
import { previewIntake } from './intake-preview.js';

describe('代行受付の入力チェック（ルールベース）', () => {
  it('問題が無ければ青で、案内を 1 件返す', () => {
    const result = previewIntake({
      subject: '複合機で印刷できない',
      body: '今朝から、印刷待ちのまま止まります。再起動しても同じです。',
      category: 'other',
      urgency: 'normal',
    });
    expect(result.signal).toBe('blue');
    expect(result.security).toBe(false);
    expect(result.pii).toEqual([]);
    expect(result.notes).toEqual([{ level: 'info', text: '大きな問題は見つかりませんでした。' }]);
  });

  it('セキュリティの語は signal の規則（domain/signal）で赤にする', () => {
    const result = previewIntake({
      subject: '不審なメールのリンクを開いた',
      body: '本文は開いていません。',
    });
    expect(result.security).toBe(true);
    expect(result.signal).toBe('red');
    expect(result.notes.some((note) => note.level === 'red')).toBe(true);
  });

  it('緊急はセキュリティでなくても赤にする', () => {
    const result = previewIntake({
      subject: 'VPNが切れる',
      body: '業務が止まっています。',
      urgency: 'urgent',
    });
    expect(result.signal).toBe('red');
  });

  it('個人情報は pii.ts の規則で種類と件数を返す', () => {
    const result = previewIntake({
      subject: 'Outlookが開かない',
      body: '連絡先は taro@example.com、パスワード: Passw0rd123 です。',
    });
    const types = result.pii.map((item) => item.type);
    expect(types).toContain('email');
    expect(types).toContain('password');
    const warn = result.notes.find((note) => note.level === 'warn');
    expect(warn?.text).toContain('メールアドレス');
    expect(warn?.text).toContain('パスワード');
  });

  it('件名・内容の不足と短さを指摘する', () => {
    const empty = previewIntake({ subject: '', body: '' });
    expect(empty.missing).toEqual({ subject: true, body: true, bodyShort: false });
    expect(empty.notes.map((note) => note.text)).toEqual(
      expect.arrayContaining(['件名が空です。', '内容が空です。']),
    );
    const short = previewIntake({ subject: '印刷', body: '印刷できない' });
    expect(short.missing.bodyShort).toBe(true);
    expect(short.notes.some((note) => note.text.includes('内容が短い'))).toBe(true);
  });

  it('分野がセキュリティなら語が無くても赤にする（signal の初期色）', () => {
    const result = previewIntake({
      subject: '相談',
      body: '確認をお願いします。',
      category: 'security',
    });
    expect(result.signal).toBe('red');
  });
});
