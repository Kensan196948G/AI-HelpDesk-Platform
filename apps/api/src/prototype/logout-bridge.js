/*
 * ログアウト（Cloudflare Access のセッションを終える）— 新画面ブリッジ（docs/99）
 *
 * 画面右上の「プロフィール」の隣に「ログアウト」を足すだけ。
 * 原本 HTML の DOM / CSS / 画面遷移は変更しない（実行時に要素を足す）。
 *
 * - cloudflare-access: アプリのドメイン配下の `/cdn-cgi/access/logout` へ遷移する。
 *   Access のセッションが切れるため、次の人（別アカウント）でログインし直せる。
 * - local（開発・テスト）: サーバのセッション削除（POST /api/auth/logout）を試し、
 *   成否に関わらず画面を再読み込みする（ローカルに Access のセッションは無い）。
 *
 * 画面の状態（localStorage）はここでは消さない。ログインしたメールが変わったとき、
 * 配信時の boot スクリプト（prototype.ts）が既存の状態を破棄する。
 */
(() => {
  if (window.__AIHD_LOGOUT_BRIDGE__) return;
  window.__AIHD_LOGOUT_BRIDGE__ = { version: 1, at: new Date().toISOString() };

  const BUTTON_ID = 'ahLogout';
  const ACCESS_LOGOUT_URL = '/cdn-cgi/access/logout';
  const LOCAL_LOGOUT_URL = '/api/auth/logout';

  /**
   * ログアウトの行き先。boot の authMode だけで決める（画面から認証方式を推測しない）。
   * 想定外の値はローカル扱いにする（本番の Access を消さない安全側）。
   */
  function logoutTarget(boot) {
    const mode = boot && boot.authMode === 'cloudflare-access' ? 'cloudflare-access' : 'local';
    if (mode === 'cloudflare-access') {
      return { mode, method: 'navigate', url: ACCESS_LOGOUT_URL };
    }
    return { mode, method: 'post', url: LOCAL_LOGOUT_URL };
  }

  /** 実行前の確認文。何が起きるかを押す前に分かるようにする。 */
  function logoutConfirmText(target) {
    if (target && target.mode === 'cloudflare-access') {
      return 'ログアウトします。Cloudflare Access のセッションが終わり、別のアカウントでログインし直せます。よろしいですか？';
    }
    return 'ログアウトします（ローカル開発）。よろしいですか？';
  }

  function doLogout(target) {
    if (target.method === 'navigate') {
      window.location.assign(target.url);
      return;
    }
    let pending;
    try {
      pending = fetch(target.url, { method: 'POST', credentials: 'include' });
    } catch (error) {
      pending = Promise.resolve(null);
    }
    Promise.resolve(pending).then(
      () => window.location.reload(),
      () => window.location.reload(),
    );
  }

  /** 右上のヘッダーへ「ログアウト」を 1 つだけ足す。 */
  function mountLogout() {
    if (document.getElementById(BUTTON_ID)) return true;
    const profile = document.querySelector('button[data-act="profile"]');
    if (!profile || !profile.parentNode) return false;
    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    // 「プロフィール」と同じ見た目にする（独自 CSS を足さない）。
    button.className = profile.className || 'u-pill';
    button.textContent = 'ログアウト';
    button.title = 'Cloudflare Access のセッションを終えます';
    button.setAttribute('aria-label', 'ログアウト');
    button.addEventListener('click', () => {
      const target = logoutTarget(window.__AIHD_BOOT__ || {});
      if (!window.confirm(logoutConfirmText(target))) return;
      doLogout(target);
    });
    profile.parentNode.insertBefore(button, profile.nextSibling);
    return true;
  }

  function start() {
    if (mountLogout()) return;
    // 画面の描画が遅い場合だけ数回やり直す（常駐の監視はしない）。
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      if (mountLogout() || tries >= 20) clearInterval(timer);
    }, 150);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }

  // 試験から純粋関数を参照できるようにする（画面の動作には影響しない）。
  window.__AIHD_LOGOUT_API__ = { logoutTarget, logoutConfirmText };
})();
