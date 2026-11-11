import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

/**
 * 候補の手順の一覧（docs/94）。原本の DOM は動かさず、
 * 会話の候補・提示済み・試行済みを 1 つの一覧にまとめる部分だけを実物から評価する。
 */
const code = readFileSync(new URL('./kb-trial-bridge.js', import.meta.url), 'utf8');

const KB: Record<string, { id: string; title: string; status: string }> = {
  'KB-105': { id: 'KB-105', title: 'VPNの再接続', status: 'active' },
  'KB-210': { id: 'KB-210', title: '共有フォルダの確認', status: 'active' },
  'KB-300': { id: 'KB-300', title: '古い手順', status: 'archived' },
};

function entries(ticket: Record<string, unknown>) {
  const match = /function trialEntries\([\s\S]*?\n {2}}\n/.exec(code);
  if (!match) throw new Error('trialEntries が見つかりません');
  const sandbox = { MAX_ENTRIES: 8 };
  const fn = vm.runInNewContext(`(${match[0]})`, sandbox);
  return fn(ticket, Object.values(KB)) as Array<{
    id: string;
    title: string;
    archived: boolean;
    score: number | null;
    current: boolean;
    tried: boolean;
  }>;
}

describe('候補の手順の一覧', () => {
  it('表示中・候補・提示済み・試行済みを重複なくまとめる', () => {
    const list = entries({
      id: 'INC-1',
      activeKb: 'KB-105',
      candidates: ['KB-210', 'KB-105'],
      shown: ['KB-105'],
      failedKb: ['KB-300'],
    });
    expect(list.map((entry) => entry.id)).toEqual(['KB-105', 'KB-210', 'KB-300']);
  });

  it('表示中を先頭にし、試行済みは後ろへ回す', () => {
    const list = entries({
      id: 'INC-1',
      activeKb: 'KB-105',
      candidates: ['KB-210'],
      failedKb: ['KB-210'],
    });
    expect(list[0].id).toBe('KB-105');
    expect(list[0].current).toBe(true);
    expect(list[1].tried).toBe(true);
  });

  it('候補提示メッセージの近さを使い、高い順に並べる', () => {
    const list = entries({
      id: 'INC-1',
      activeKb: 'KB-105',
      candidates: ['KB-210', 'KB-300'],
      aiLog: [
        {
          kind: 'cands',
          cands: [
            { id: 'KB-210', score: 0.31 },
            { id: 'KB-300', score: 0.88 },
          ],
        },
      ],
    });
    expect(list.map((entry) => entry.id)).toEqual(['KB-105', 'KB-300', 'KB-210']);
    expect(list[1].score).toBeCloseTo(0.88);
    expect(list[2].score).toBeCloseTo(0.31);
  });

  it('使用停止のナレッジは印を付け、件数は上限で切る', () => {
    const many = Array.from({ length: 12 }, (_, index) => 'KB-' + (400 + index));
    const list = entries({ id: 'INC-1', activeKb: 'KB-105', candidates: many });
    expect(list).toHaveLength(8);
    expect(entries({ id: 'INC-1', activeKb: 'KB-300' })[0].archived).toBe(true);
  });

  it('ローカルに無い候補でも落とさず、見つからないと分かる題名にする', () => {
    const list = entries({ id: 'INC-1', activeKb: 'KB-105', candidates: ['KB-999'] });
    expect(list.map((entry) => entry.id)).toEqual(['KB-105', 'KB-999']);
    expect(list[1].title).toContain('見つかりません');
  });

  it('差し込みはチャットの直後で、切り替えは既存の App.pickCand を呼ぶ', () => {
    expect(code).toContain("document.getElementById('chat')");
    expect(code).toContain("insertAdjacentHTML('afterend'");
    expect(code).toContain('app.pickCand(ticket.id, kbId)');
    expect(code).toContain('data-ahd-trial');
    expect(code).toContain('回数の制限はありません');
  });
});
