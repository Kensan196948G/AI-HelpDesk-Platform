/*
 * 担当者向け API を呼んでよいかの判定（相談者の画面で 403 を出し続けないため）。
 *
 * 判定の正本はサーバで、/api/me の helpdeskActor / remoteSupport は各 API の権限判定と
 * 同じ関数で計算される。ここは無駄な呼び出しを止めるだけで、権限の根拠にはしない。
 * - /api/me は 60 回/分の制限があるので、1 ページで 1 回だけ取得して共有する。
 * - /api/me が取れないときは「呼ぶ」側に倒す（一時的な失敗で担当者の機能を隠さない）。
 *   サーバが 403 を返したら、呼び出し側が deny() で以後の呼び出しを止める。
 */
(() => {
  if (window.__AIHD_STAFF_ACCESS__) return;

  const denied = new Set();
  let mePromise = null;

  function loadMe() {
    if (!mePromise) {
      mePromise = fetch('/api/me', { headers: { Accept: 'application/json' } })
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null);
    }
    return mePromise;
  }

  window.__AIHD_STAFF_ACCESS__ = {
    async allowed(capability) {
      if (denied.has(capability)) return false;
      const me = await loadMe();
      return me?.[capability] !== false && !denied.has(capability);
    },
    deny(capability) {
      denied.add(capability);
    },
  };
})();
