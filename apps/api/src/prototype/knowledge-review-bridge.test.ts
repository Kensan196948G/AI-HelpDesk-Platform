import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

/**
 * ナレッジの検査表示と承認の進捗（docs/94）。
 * DOM を起動せず、表示の組み立て（点数は参考・自動修正しない・n/4）だけを実物から評価する。
 */
const code = readFileSync(new URL('./knowledge-review-bridge.js', import.meta.url), 'utf8');

function sandbox() {
  return {
    CHECK_COUNT: 4,
    esc: (value: unknown) =>
      String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
      }),
    labelOfType: (type: string) =>
      ({ ip: 'IPアドレス', email: 'メールアドレス', password: 'パスワード' })[type] || type,
  };
}

function pick(name: string) {
  const match = new RegExp(`function ${name}\\([\\s\\S]*?\\n {2}}\\n`).exec(code);
  if (!match) throw new Error(name + ' が見つかりません');
  return vm.runInNewContext(`(${match[0]})`, sandbox());
}

const result = {
  score: 76,
  maxScore: 100,
  reference: true,
  redactions: [{ type: 'ip', count: 1 }],
  blocking: { deviceInfo: false },
  items: [
    { key: 'title', label: 'タイトルが入っている', ok: true },
    { key: 'pii', label: '個人情報が残っていない', ok: false, detail: 'IPアドレス 1件' },
  ],
  redacted: { title: 'タイトル', symptom: '接続先は [IPアドレス]', cause: '', steps: '1. 再起動' },
};

describe('AI検査・指摘の表示（参考）', () => {
  const html = pick('inspectResultHTML') as (value: unknown) => string;

  it('点数・項目・伏せ字の予定を出し、参考であることを明記する', () => {
    const out = html(result);
    expect(out).toContain('参考スコア 76');
    expect(out).toContain('点数は参考です');
    expect(out).toContain('承認の可否はサーバーの検査で決まります');
    expect(out).toContain('保存時に伏せ字になる項目');
    expect(out).toContain('IPアドレス 1件');
    expect(out).toContain('[IPアドレス]');
  });

  it('落ちた項目は ✗、通った項目は ✓ で示す', () => {
    const out = html(result);
    expect(out).toContain('✗ 個人情報が残っていない');
    expect(out).toContain('✓ タイトルが入っている');
  });

  it('自動修正をしないことを必ず書く', () => {
    expect(html(result)).toContain('自動修正は行いません');
  });

  it('未実行なら状態を明示し、危険な文字列は実体参照にする', () => {
    expect(html(null)).toContain('まだ検査していません');
    const out = html({
      ...result,
      items: [{ key: 'title', label: '<img src=x onerror=alert(1)>', ok: true }],
      redacted: {},
    });
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
  });
});

describe('承認の進捗と押下の制御', () => {
  const progress = pick('progressHTML') as (checked: number) => string;

  it('2/4 なら半分のバーと残りの案内を出す', () => {
    const out = progress(2);
    expect(out).toContain('確認の進捗 2/4');
    expect(out).toContain('width:50%');
    expect(out).toContain('4項目すべて確認すると承認できます');
  });

  it('4/4 なら完了の表示にする', () => {
    const out = progress(4);
    expect(out).toContain('確認の進捗 4/4');
    expect(out).toContain('すべて確認しました');
    expect(out).toContain('width:100%');
  });

  it('範囲外の値でも 0〜4 に丸める', () => {
    expect(progress(9)).toContain('4/4');
    expect(progress(-1)).toContain('0/4');
  });

  it('4項目そろうまで承認ボタンを無効にし、押せる状態は自分が付けた無効だけ戻す', () => {
    expect(code).toContain('button.disabled = true');
    expect(code).toContain("setAttribute('data-ahd-gate', '1')");
    expect(code).toContain("getAttribute('data-ahd-gate') === '1'");
    expect(code).toContain('/App\\.approve\\(/');
  });

  it('承認の判定はサーバー側のまま（検査は読み取り専用の API を呼ぶ）', () => {
    expect(code).toContain("fetch('/api/knowledge/inspect'");
    expect(code).toContain('自動修正は行いません');
  });
});
