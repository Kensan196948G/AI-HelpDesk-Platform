import { describe, expect, it } from 'vitest';
import { composeAssessment, detectIntent, type KnowledgeLike } from './ai.js';
import { buildDemoPcSnapshot } from './pc.js';

const knowledge: KnowledgeLike = {
  id: 'k1',
  kbNo: 'KB-2026-0001',
  title: '共有フォルダにアクセスできないときの確認手順',
  symptom: 'アクセスが拒否される',
  cause: 'セキュリティグループ未所属',
  steps: '1. ACLを確認する\n2. グループを追加する\n3. 再接続する',
  keywords: ['共有フォルダ', 'アクセス拒否'],
};

describe('detectIntent', () => {
  it('キーワードから用件を判定する', () => {
    expect(detectIntent('印刷できません', '').id).toBe('printing');
    expect(detectIntent('VPNにつながらない', '').id).toBe('vpn');
    expect(detectIntent('Teamsの音が出ない', '').id).toBe('audio');
    expect(detectIntent('不審なメールを開いた', '').id).toBe('security');
  });
});

describe('composeAssessment', () => {
  it('セキュリティは赤・引継ぎ推奨・根拠なし', () => {
    const result = composeAssessment({
      category: 'security',
      subject: '不審なメールを開いた',
      body: '添付を開いてしまいました。',
      urgency: 'normal',
      pc: null,
      knowledge: [],
    });
    expect(result.signal).toBe('red');
    expect(result.security).toBe(true);
    expect(result.recommendHandoff).toBe(true);
    expect(result.sources).toHaveLength(0);
    expect(result.steps.length).toBeGreaterThan(0);
  });

  it('承認済みナレッジがあれば青・根拠あり', () => {
    const pc = buildDemoPcSnapshot({
      category: 'file_share',
      subject: '共有フォルダが開けません',
      body: 'アクセスが拒否されます。',
    });
    const result = composeAssessment({
      category: 'file_share',
      subject: '共有フォルダが開けません',
      body: 'アクセスが拒否されます。',
      urgency: 'normal',
      pc,
      knowledge: [knowledge],
    });
    expect(result.signal).toBe('blue');
    expect(result.recommendHandoff).toBe(false);
    expect(result.sources[0]?.kbNo).toBe('KB-2026-0001');
    expect(result.steps.length).toBe(3);
  });

  it('根拠がなければ黄・引継ぎ推奨', () => {
    const result = composeAssessment({
      category: 'procedure',
      subject: '経費精算の手順を確認したい',
      body: '',
      urgency: 'normal',
      pc: null,
      knowledge: [],
    });
    expect(result.signal).toBe('amber');
    expect(result.recommendHandoff).toBe(true);
  });
});
