import { describe, expect, it } from 'vitest';
import { scoreKnowledge } from './knowledge-search.js';
import { extractPrototypeKnowledge } from './prototype-knowledge.js';

const activeKb = {
  id: 'KB-111',
  cat: 'file',
  title: 'CAD図面ファイルを開くと強制終了するときの対処',
  symptom: '協力会社から受け取った図面ファイルを開くとCADアプリが強制終了する。',
  cause: '図面の作成バージョンが新しく、社内CADが未対応。',
  steps: ['図面の作成バージョンを確認する', 'ビューアーで開けるか確認する'],
  keywords: ['CAD', '図面', '強制終了'],
  status: 'active',
};

describe('extractPrototypeKnowledge', () => {
  it('承認済み（active）のナレッジだけを AI の根拠形式へ変換する', () => {
    const result = extractPrototypeKnowledge({
      kb: [
        activeKb,
        { ...activeKb, id: 'KB-112', status: 'suspended' },
        { id: 'not-kb', title: 'x', status: 'active' },
        'broken',
        null,
      ],
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'prototype:KB-111',
      kbNo: 'KB-111',
      title: activeKb.title,
      keywords: ['CAD', '図面', '強制終了'],
    });
    expect(result[0]?.steps).toBe(
      '1. 図面の作成バージョンを確認する\n2. ビューアーで開けるか確認する',
    );
  });

  it('状態が不正・kb が無い場合は空配列', () => {
    expect(extractPrototypeKnowledge(null)).toEqual([]);
    expect(extractPrototypeKnowledge([])).toEqual([]);
    expect(extractPrototypeKnowledge({ kb: 'x' })).toEqual([]);
    expect(extractPrototypeKnowledge({})).toEqual([]);
  });

  it('過大な配列は先頭 200 件までしか見ない', () => {
    const kb = Array.from({ length: 250 }, (_, index) => ({ ...activeKb, id: `KB-${index}` }));
    expect(extractPrototypeKnowledge({ kb })).toHaveLength(200);
  });

  it('画面で承認したナレッジが相談文のキーワードでスコアリングされる', () => {
    const knowledge = extractPrototypeKnowledge({ kb: [activeKb] });
    const result = scoreKnowledge(knowledge, '図面を開くとCADが強制終了します', []);
    expect(result[0]?.kbNo).toBe('KB-111');
  });
});
