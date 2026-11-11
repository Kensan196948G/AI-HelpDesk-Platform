import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

/**
 * 右ペインのタブ（docs/93）。画面仕様書 V1.0 の「右詳細パネルの 1 ページ化」を
 * 既存の引継ぎワークスペースへ取り込む。ここでは DOM を起動せず、
 * タブ定義・件数・組み立ての契約だけを実物のブリッジから評価する。
 */
const code = readFileSync(new URL('./handover-workspace-bridge.js', import.meta.url), 'utf8');

function evTabs(): Array<{ id: string; label: string }> {
  const match = /const EV_TABS = \[([\s\S]*?)\n {2}\];/.exec(code);
  if (!match) throw new Error('EV_TABS が見つかりません');
  return vm.runInNewContext(`const EV_TABS = [${match[1]}];\nEV_TABS;`);
}

function counterFor(t: Record<string, unknown>, audit: unknown[] = []) {
  const match = /function evTabCount\([\s\S]*?\n {2}}\n/.exec(code);
  if (!match) throw new Error('evTabCount が見つかりません');
  const sandbox = {
    EV_AUDIT_SHOWN: 6,
    relatedKbs: (ticket: { kbs?: unknown[] }) => ticket.kbs || [],
    auditList: () => audit,
  };
  const fn = vm.runInNewContext(`(${match[0]})`, sandbox);
  return (id: string): number => fn(t, id);
}

describe('右ペインのタブの構成', () => {
  it('案件→実行→端末→ナレッジ→記録の順で、5 つだけを持つ', () => {
    expect(evTabs()).toEqual([
      { id: 'case', label: '案件' },
      { id: 'exec', label: '実行' },
      { id: 'device', label: '端末' },
      { id: 'knowledge', label: 'ナレッジ' },
      { id: 'record', label: '記録' },
    ]);
  });

  it('既定は「案件」で、再描画しても選択を失わない', () => {
    expect(code).toContain("evTab: 'case',");
    expect(code).toContain('HW.evScroll[HW.evTab]');
  });

  it('5 つのパネルをすべて組み立てる（カードの置き場所を 1 か所に決める）', () => {
    for (const id of ['case', 'exec', 'device', 'knowledge', 'record']) {
      expect(code).toContain(`evPanelHTML('${id}',`);
    }
  });

  it('WAI-ARIA の tabs パターン（tablist / tab / tabpanel / aria-selected）', () => {
    expect(code).toContain('role="tablist"');
    expect(code).toContain('role="tab"');
    expect(code).toContain('role="tabpanel"');
    expect(code).toContain('aria-selected=');
    expect(code).toContain('aria-controls=');
    expect(code).toContain('aria-labelledby=');
  });

  it('キーボードで移動でき、パネルは hidden の切り替えだけで入力値を消さない', () => {
    expect(code).toContain("event.key === 'ArrowRight'");
    expect(code).toContain("event.key === 'End'");
    expect(code).toContain('panel.hidden =');
    expect(code).toContain("button.setAttribute('aria-selected'");
  });
});

describe('タブの件数と中身を食い違わせない', () => {
  it('端末タブは本人が共有した項目の数', () => {
    const count = counterFor({ id: 'INC-1', coworkShared: { pc: 'PC-1', os: 'Windows 11' } });
    expect(count('device')).toBe(2);
    expect(counterFor({ id: 'INC-1' })('device')).toBe(0);
  });

  it('ナレッジタブは関連ナレッジ＋下書きの有無', () => {
    expect(counterFor({ id: 'INC-1', kbs: [{}, {}] })('knowledge')).toBe(2);
    expect(counterFor({ id: 'INC-1', kbs: [{}, {}], draftId: 'DR-1' })('knowledge')).toBe(3);
  });

  it('記録タブはパネルに出す 6 件までを数える', () => {
    const rows = (target: string, n: number) =>
      Array.from({ length: n }, () => ({ target, t: 1, action: 'a' }));
    expect(counterFor({ id: 'INC-1' }, rows('INC-1', 3))('record')).toBe(3);
    expect(counterFor({ id: 'INC-1' }, rows('INC-1', 9))('record')).toBe(6);
    expect(counterFor({ id: 'INC-1' }, rows('INC-2', 4))('record')).toBe(0);
  });

  it('下書きの監査ログも同じ案件の記録として数える', () => {
    expect(
      counterFor({ id: 'INC-1', draftId: 'DR-1' }, [
        { target: 'INC-1', t: 1, action: 'a' },
        { target: 'DR-1', t: 2, action: 'b' },
      ])('record'),
    ).toBe(2);
  });

  it('案件・実行タブは件数を出さない（状態はカード側に出す）', () => {
    const count = counterFor({ id: 'INC-1', draftId: 'DR-1' });
    expect(count('case')).toBe(0);
    expect(count('exec')).toBe(0);
  });
});
