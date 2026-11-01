/*
 * 担当者向け API を呼んでよいかの判定（相談者の画面で 403 を出し続けないため）。
 *
 * 判定の正本はサーバで、/api/me の helpdeskActor / remoteSupport は各 API の権限判定と
 * 同じ関数で計算される。ここは無駄な呼び出しを止めるだけで、権限の根拠にはしない。
 * - /api/me は 60 回/分の制限があるので、取得結果を共有する。
 * - 権限なしの結果は 60 秒だけ使う。名簿の一時障害でも 200 で false が返るので、
 *   ページ内に保持し続けると、復旧後も担当者の機能が隠れたままになる。
 * - /api/me が取れないときは「呼ぶ」側に倒す（一時的な失敗で担当者の機能を隠さない）。
 *   サーバが 403 を返したら、呼び出し側が deny() で以後の呼び出しを止める。
 */
(() => {
  if (window.__AIHD_STAFF_ACCESS__) return;

  const denied = new Set();
  const DENIED_RECHECK_MS = 60_000;
  let mePromise = null;
  let recheckAt = Number.POSITIVE_INFINITY;

  function loadMe() {
    if (!mePromise || Date.now() >= recheckAt) {
      recheckAt = Number.POSITIVE_INFINITY;
      mePromise = fetch('/api/me', { headers: { Accept: 'application/json' } })
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null)
        .then((me) => {
          if (me?.helpdeskActor === false || me?.remoteSupport === false) {
            recheckAt = Date.now() + DENIED_RECHECK_MS;
          }
          return me;
        });
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
