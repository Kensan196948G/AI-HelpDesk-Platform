import { describe, expect, it } from 'vitest';
import { type AiSource, citedSourcesFromAnswer } from './deepseek.js';

const source = (kbNo: string): AiSource => ({ id: kbNo, kbNo, title: kbNo });

describe('citedSourcesFromAnswer', () => {
  it('根拠行に挙げた KB だけを返す', () => {
    const answer = '手順は次のとおりです。\n\n根拠: KB-2026-0001, KB-2026-0008';
    const sources = [source('KB-2026-0001'), source('KB-2026-0008'), source('KB-2026-0009')];
    expect(citedSourcesFromAnswer(answer, sources).map((s) => s.kbNo)).toEqual([
      'KB-2026-0001',
      'KB-2026-0008',
    ]);
  });

  it('該当なしと明示している場合は空にする', () => {
    const answer =
      '経費精算の締め日は承認済みナレッジにありません。\n\n根拠: 該当するKBなし（KB-2026-0001／0006／0009はいずれも本件と無関係）';
    const sources = [source('KB-2026-0001'), source('KB-2026-0006'), source('KB-2026-0009')];
    expect(citedSourcesFromAnswer(answer, sources)).toEqual([]);
  });

  it('「該当する承認済みナレッジなし」も空にする', () => {
    expect(
      citedSourcesFromAnswer('根拠: 該当する承認済みナレッジなし', [source('KB-2026-0001')]),
    ).toEqual([]);
  });

  it('根拠行がない場合は候補をそのまま返す（互換）', () => {
    const sources = [source('KB-2026-0001')];
    expect(citedSourcesFromAnswer('手順を案内します。', sources)).toBe(sources);
  });

  it('候補にない KB は返さない', () => {
    expect(citedSourcesFromAnswer('根拠: KB-2026-9999', [source('KB-2026-0001')])).toEqual([]);
  });

  it('根拠行に KB 番号がない場合は空にする', () => {
    expect(citedSourcesFromAnswer('根拠: 社内規程', [source('KB-2026-0001')])).toEqual([]);
  });
});
