/*
 * AI HelpDesk prototype bridge.
 * - 画面の DOM / CSS は元の HTML のまま変更しない。
 * - localStorage の状態を PostgreSQL に同期する。
 * - 自由記述の AI 回答だけを /api/ai/answer（DeepSeek）へ委譲する。
 */
(() => {
  const boot = window.__AIHD_BOOT__ || {};
  const KEYS = {
    cowork: 'mirai-wizard-v31-cowork',
    helpdesk: 'mirai-wizard-v31-helpdesk',
  };
  const last = Object.create(null);
  const lastFailAt = Object.create(null);

  /** 保存失敗・AI 失敗を利用者に知らせる（同じ失敗を 30 秒おきに 1 回だけ）。 */
  function notifyFailure(name, message) {
    const now = Date.now();
    if (lastFailAt[name] && now - lastFailAt[name] < 30_000) return;
    lastFailAt[name] = now;
    try {
      if (typeof toast === 'function') toast(message, 'bad');
    } catch (error) {
      // 画面がまだ初期化されていない場合は無視する。
    }
  }

  function current(name) {
    try {
      return localStorage.getItem(KEYS[name]);
    } catch (error) {
      return null;
    }
  }

  async function sendState(name, raw) {
    if (!raw) return;
    let data;
    try {
      data = JSON.parse(raw);
    } catch (error) {
      return;
    }
    try {
      const body = JSON.stringify({ data });
      const response = await fetch('/api/state/' + encodeURIComponent(name), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body,
        // keepalive は使わない。ページ全体で合計 64KiB の枠を 2 つの状態
        // （AI相談・ヘルプデスク）で奪い合い、超えると fetch 自体が
        // "Failed to fetch" で失敗して保存が止まる（2026-10-23 に実測:
        // 16.7KB の AI相談 + 52.5KB のヘルプデスクで再現）。
        // 取りこぼしは 500ms ごとの同期と変更イベントで回収する。
        keepalive: false,
      });
      if (!response.ok) throw new Error('state save HTTP ' + response.status);
    } catch (error) {
      // 次の interval / 変更イベントで再試行する。失敗は黙って続けず、利用者に知らせる。
      delete last[name];
      notifyFailure('state', '状態を保存できませんでした。接続が戻るまで再試行します。');
    }
  }

  /**
   * 保存は「利用者ごとに 1 本」に直列化し、途中の変更は最新だけを送る。
   * 連続で切り替えたときに古い PUT が後から届いて新しい状態を上書きする（順序の逆転）のを防ぐ。
   */
  const pending = Object.create(null);
  const sending = Object.create(null);
  async function putState(name, raw) {
    if (!raw) return;
    pending[name] = raw;
    if (sending[name]) return;
    sending[name] = true;
    try {
      while (pending[name]) {
        const nextRaw = pending[name];
        pending[name] = null;
        await sendState(name, nextRaw);
      }
    } finally {
      sending[name] = false;
    }
  }

  function sync(force) {
    for (const name of Object.keys(KEYS)) {
      const raw = current(name);
      if (raw && (force || raw !== last[name])) {
        last[name] = raw;
        putState(name, raw);
      }
    }
  }

  window.__AIHD_SYNC_DEBUG__ = { sync, KEYS, current, last };
  let timer = null;
  window.addEventListener('aihd-state', () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => sync(false), 120);
  });
  setTimeout(() => sync(true), 400);
  setTimeout(() => sync(true), 1200);
  setTimeout(() => sync(true), 5000);
  window.addEventListener('load', () => sync(true));
  document.addEventListener('click', () => setTimeout(() => sync(false), 120), true);
  document.addEventListener('input', () => setTimeout(() => sync(false), 300), true);
  document.addEventListener('visibilitychange', () => sync(false));
  setInterval(() => sync(false), 500);
  window.addEventListener('beforeunload', () => sync(false));

  // DeepSeek: 自由記述の回答のみ。診断・修復・セキュリティ初動は元の決定ルールを維持する。
  if (typeof H === 'object' && H && typeof H.kb === 'function') {
    const originalKb = H.kb.bind(H);
    H.kb = (chat, text, atts, user) => {
      try {
        UI.typing = true;
        refresh();
      } catch (error) {
        // UI がまだ初期化されていない場合はそのまま続行する
      }

      fetch('/api/ai/answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, deviceId: window.__AIHD_DEVICE_ID__ || undefined }),
      })
        .then((response) => {
          if (!response.ok) throw new Error('AI API HTTP ' + response.status);
          return response.json();
        })
        .then((data) => {
          try {
            UI.typing = false;
          } catch (error) {
            // ignore
          }
          const answer = String(data.answer || '');
          const escaped = answer.replace(/[&<>"']/g, (char) => {
            return {
              '&': '&amp;',
              '<': '&lt;',
              '>': '&gt;',
              '"': '&quot;',
              "'": '&#39;',
            }[char];
          });
          let html = '<p>' + escaped.replace(/\n/g, '<br>') + '</p>';
          if (data.device) {
            const deviceLabel = data.device.source === 'agent' ? '端末エージェント' : 'ブラウザ';
            html +=
              '<p class="small muted">PC基本情報（' + deviceLabel + '取得）を参照しました。</p>';
          }
          if (data.provider === 'fallback') {
            html +=
              '<p class="small muted">承認済みナレッジから回答しています（DeepSeek は使っていません）。</p>';
          }
          const sources = (data.sources || []).map((source) => source.kbNo);
          try {
            // provider は最終報告書の「生成元」表示に使う（UI のモデル表示は変えない）。
            ai(chat, html, {
              conf: data.confidence || '—',
              src: sources,
              provider: data.provider,
            });
            save();
            refresh();
          } catch (error) {
            // UI 更新に失敗した場合はフォールバックへ
            originalKb(chat, text, atts, user);
          }
        })
        .catch(() => {
          try {
            UI.typing = false;
          } catch (error) {
            // ignore
          }
          notifyFailure(
            'ai',
            'AIに接続できませんでした。画面内の資料（DB で未承認のものを含む）で回答します。',
          );
          originalKb(chat, text, atts, user);
        });
    };
  }

  // モデル選択欄の表示名（レイアウトは変更しない）。DeepSeek が答えるのは自由記述だけ。
  // 個々の回答の表示は honest-labels-bridge.js が provider から判定する。
  try {
    if (typeof MODELS === 'object' && MODELS) {
      MODELS.local = 'DeepSeek-V4.1-Flash（自由記述のみ）';
      MODELS.external = 'DeepSeek-V4.1-Flash（承認済み外部・自由記述のみ）';
      const select = document.querySelector('#model');
      if (select) {
        for (const option of select.options) {
          if (option.value === 'local') option.textContent = MODELS.local;
          if (option.value === 'external') option.textContent = MODELS.external;
        }
      }
    }
  } catch (error) {
    // ignore
  }

  if (boot.email) {
    document.documentElement.setAttribute('data-aihd-email', boot.email);
  }
})();
