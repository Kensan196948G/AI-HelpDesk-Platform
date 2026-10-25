import { describe, expect, it } from 'vitest';
import { findApprovedKnowledge } from './knowledge-search.js';

const rows = [
  {
    id: '1',
    kb_no: 'KB-2026-0006',
    title: 'Windows Update・再起動待ちの確認手順',
    symptom: '更新の通知が消えない。',
    cause: '再起動待ち。',
    steps: '再起動する。',
    keywords: ['Windows Update', '更新', '再起動'],
  },
  {
    id: '2',
    kb_no: 'KB-2026-0007',
    title: 'BitLocker・ディスク暗号化の状態確認',
    symptom: '暗号化の状態を確認したい。',
    cause: '保護状態が不明。',
    steps: '設定を確認する。',
    keywords: ['BitLocker', '暗号化', '回復キー'],
  },
  {
    id: '3',
    kb_no: 'KB-2026-0005',
    title: 'PCが重い・動作が遅いときの一次切り分け',
    symptom: '操作が遅い。',
    cause: '負荷が高い。',
    steps: 'タスクマネージャーを確認する。',
    keywords: ['重い', '遅い', 'CPU', 'メモリ'],
  },
];

const tx = (async () => rows) as unknown as Parameters<typeof findApprovedKnowledge>[0];

describe('findApprovedKnowledge', () => {
  it('一般語「手順」より専門キーワード「BitLocker」の一致を優先する', async () => {
    const result = await findApprovedKnowledge(
      tx,
      'BitLockerの状態を確認したい。手順を教えてください。',
      ['経費', '手順', '申請', '規程', '人事'],
    );
    expect(result[0]?.kbNo).toBe('KB-2026-0007');
  });

  it('PC性能の相談では性能KBを先頭にする', async () => {
    const result = await findApprovedKnowledge(tx, 'PCが重い。CPUとメモリを確認したい。', [
      '容量',
      '空き',
      '遅い',
      '重い',
      '保存',
    ]);
    expect(result[0]?.kbNo).toBe('KB-2026-0005');
  });

  // 2026-10-25 の実測で、活用形の不一致により候補ゼロになった回帰。
  it('活用形が違っても（遅い／遅く）専門キーワードとして一致する', async () => {
    const result = await findApprovedKnowledge(tx, 'アプリの起動が遅く、操作が固まります。', [
      '容量',
      '空き',
      '遅い',
      '重い',
      '保存',
    ]);
    expect(result.some((knowledge) => knowledge.kbNo === 'KB-2026-0005')).toBe(true);
  });
});
