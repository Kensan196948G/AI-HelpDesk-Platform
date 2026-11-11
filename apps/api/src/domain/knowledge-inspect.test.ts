import { describe, expect, it } from 'vitest';
import { inspectKnowledgeContent } from './knowledge-inspect.js';

const base = {
  title: 'VPNが切れたときの再接続手順',
  symptom: 'VPNが数分で切れる',
  cause: 'ネットワークの切り替わり',
  steps: '1. 再接続する\n2. 接続先を確認する',
  keywords: ['VPN', '再接続'],
};

describe('ナレッジ下書きの検査（参考表示）', () => {
  it('問題が無ければ満点で、すべての項目が通る', () => {
    const result = inspectKnowledgeContent(base);
    expect(result.score).toBe(100);
    expect(result.reference).toBe(true);
    expect(result.redactions).toEqual([]);
    expect(result.blocking).toEqual({ deviceInfo: false });
    expect(result.items.every((item) => item.ok)).toBe(true);
  });

  it('個人情報は保存時の伏せ字として指摘し、伏せ字後の本文を返す', () => {
    const result = inspectKnowledgeContent({
      ...base,
      symptom: '連絡先は taro@example.com、パスワード: Passw0rd123 です',
    });
    const types = result.redactions.map((item) => item.type);
    expect(types).toContain('email');
    expect(types).toContain('password');
    expect(result.items.find((item) => item.key === 'pii')?.ok).toBe(false);
    expect(result.redacted.symptom).toContain('[メールアドレス]');
    expect(result.redacted.symptom).not.toContain('taro@example.com');
    expect(result.redacted.symptom).not.toContain('Passw0rd123');
    expect(result.score).toBeLessThan(100);
  });

  it('IPアドレスは保存時に伏せられ、伏せ字後は承認時の検査に通る', () => {
    const result = inspectKnowledgeContent({ ...base, cause: '接続先は 192.168.0.10 です' });
    expect(result.redactions).toEqual([{ type: 'ip', count: 1 }]);
    expect(result.blocking.deviceInfo).toBe(false);
    expect(result.items.find((item) => item.key === 'device')?.ok).toBe(true);
    expect(result.redacted.cause).toContain('[IPアドレス]');
  });

  it('タイトルと手順が空なら点を下げ、項目を落とす', () => {
    const result = inspectKnowledgeContent({ ...base, title: '  ', steps: ' \n ' });
    expect(result.items.find((item) => item.key === 'title')?.ok).toBe(false);
    expect(result.items.find((item) => item.key === 'steps')?.ok).toBe(false);
    expect(result.score).toBe(60);
  });

  it('上限を超える手順は落とす（保存できない長さ）', () => {
    const result = inspectKnowledgeContent({ ...base, steps: 'あ'.repeat(8001) });
    expect(result.items.find((item) => item.key === 'steps')?.ok).toBe(false);
  });

  it('端末情報を含むキーワードは保存時に除かれることを示す', () => {
    const result = inspectKnowledgeContent({
      ...base,
      keywords: ['VPN', '192.168.0.10'],
    });
    const keywords = result.items.find((item) => item.key === 'keywords');
    expect(keywords?.ok).toBe(false);
    expect(keywords?.detail).toContain('192.168.0.10');
  });

  it('点数は 0〜100 の範囲に収まる', () => {
    const result = inspectKnowledgeContent({
      title: '',
      symptom: 'あ'.repeat(4001),
      cause: 'い'.repeat(4001),
      steps: '',
      keywords: Array.from({ length: 30 }, () => 'x'.repeat(50)),
    });
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });
});
