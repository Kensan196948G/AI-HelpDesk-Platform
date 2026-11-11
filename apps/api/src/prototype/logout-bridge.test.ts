import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

/**
 * ログアウト（docs/99）。認証方式の判定と確認文だけを実物から評価する。DOM は起動しない。
 *
 * 安全側の要件: 画面から認証方式を推測せず、**想定外の値では Access をログアウトしない**。
 */
const code = readFileSync(new URL('./logout-bridge.js', import.meta.url), 'utf8');

const CONSTANTS = {
  ACCESS_LOGOUT_URL: '/cdn-cgi/access/logout',
  LOCAL_LOGOUT_URL: '/api/auth/logout',
};

function pick(name: string) {
  const match = new RegExp(`function ${name}\\([\\s\\S]*?\\n {2}}\\n`).exec(code);
  if (!match) throw new Error(name + ' が見つかりません');
  return vm.runInNewContext(`(${match[0]})`, CONSTANTS);
}

type Target = { mode: 'cloudflare-access' | 'local'; method: 'navigate' | 'post'; url: string };

describe('ログアウトの行き先', () => {
  const target = pick('logoutTarget') as (boot: unknown) => Target;

  it('Cloudflare Access では Access のログアウトへ遷移する', () => {
    expect(target({ authMode: 'cloudflare-access' })).toEqual({
      mode: 'cloudflare-access',
      method: 'navigate',
      url: '/cdn-cgi/access/logout',
    });
  });

  it('ローカル開発ではサーバのセッション削除を呼ぶ', () => {
    expect(target({ authMode: 'local' })).toEqual({
      mode: 'local',
      method: 'post',
      url: '/api/auth/logout',
    });
  });

  it('想定外・欠落した指定では Access をログアウトしない（安全側）', () => {
    for (const boot of [undefined, null, {}, { authMode: 'cloudflare_access' }, { authMode: '' }]) {
      expect(target(boot).mode).toBe('local');
    }
  });
});

describe('実行前の確認文', () => {
  const text = pick('logoutConfirmText') as (target: Target) => string;
  const access: Target = {
    mode: 'cloudflare-access',
    method: 'navigate',
    url: '/cdn-cgi/access/logout',
  };

  it('Access では「セッションが終わる」ことと「別アカウントで入り直せる」ことを伝える', () => {
    const message = text(access);
    expect(message).toContain('Cloudflare Access');
    expect(message).toContain('セッション');
    expect(message).toContain('別のアカウント');
  });

  it('ローカルではローカル開発であることを伝える', () => {
    expect(text({ mode: 'local', method: 'post', url: '/api/auth/logout' })).toContain(
      'ローカル開発',
    );
  });
});

describe('画面の状態を消さない', () => {
  it('ブリッジは localStorage を消さない（切替時の破棄は配信側の boot が行う）', () => {
    expect(code).not.toContain('localStorage.removeItem');
    expect(code).not.toContain('localStorage.clear');
  });

  it('ボタンは 1 つだけ足す（二重マウントしない）', () => {
    expect(code).toContain('document.getElementById(BUTTON_ID)');
    expect(code).toContain('button.id = BUTTON_ID');
  });

  it('画面用のデモデータを持たない', () => {
    expect(code).not.toContain('demo');
    expect(code).not.toContain('サンプル');
  });
});
