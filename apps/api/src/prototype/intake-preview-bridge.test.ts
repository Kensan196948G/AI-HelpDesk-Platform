import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

/**
 * 代行受付の入力チェック（docs/97）。ルールベースのみ・AI を呼ばないことを確認する。
 */
const code = readFileSync(new URL('./intake-preview-bridge.js', import.meta.url), 'utf8');

function pick(name: string) {
  const match = new RegExp(`function ${name}\\([\\s\\S]*?\\n {2}}\\n`).exec(code);
  if (!match) throw new Error(name + ' が見つかりません');
  return vm.runInNewContext(`(${match[0]})`, {
    PANEL_ID: 'ahdIntakePreview',
    BODY_ID: 'ahdIntakePreviewBody',
    esc: (value: unknown) =>
      String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
      }),
  });
}

describe('入力チェックの表示', () => {
  const html = pick('previewHTML') as (result: unknown) => string;

  it('赤は AI に任せない表示にし、指摘を並べる', () => {
    const out = html({
      signal: 'red',
      notes: [
        { level: 'red', text: 'セキュリティ事象・急ぎの可能性があります。' },
        { level: 'warn', text: '個人情報らしき文字があります（メールアドレス 1件）。' },
      ],
    });
    expect(out).toContain('赤（AIに任せない）');
    expect(out).toContain('セキュリティ事象・急ぎの可能性があります。');
    expect(out).toContain('n-warn');
    expect(out).toContain('参考');
  });

  it('青は AI で進められる表示にする', () => {
    expect(
      html({ signal: 'blue', notes: [{ level: 'info', text: '問題ありません。' }] }),
    ).toContain('青（AIで進められる）');
  });

  it('未判定と危険な文字列を安全に扱う', () => {
    expect(html(null)).toContain('まだ判定していません');
    const out = html({ signal: 'blue', notes: [{ level: 'info', text: '<script>x</script>' }] });
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('ルールベースで AI を呼ばないことを明記し、入力を 500ms で間引く', () => {
    const panel = pick('panelHTML') as () => string;
    expect(panel()).toContain('ルールベース');
    expect(panel()).toContain('AIは呼びません');
    expect(code).toContain("fetch('/api/intake/preview'");
    expect(code).toContain('DEBOUNCE_MS = 500');
    expect(code).toContain("id === 'i_sub' || id === 'i_body'");
  });

  it('分野と緊急度をサーバーの判定用に変換する', () => {
    const categoryOf = pick('categoryOf') as (value: string) => string;
    const urgencyOf = pick('urgencyOf') as (value: string) => string;
    expect(categoryOf('security')).toBe('security');
    expect(categoryOf('network')).toBe('other');
    expect(urgencyOf('高')).toBe('urgent');
    expect(urgencyOf('中')).toBe('normal');
  });
});
