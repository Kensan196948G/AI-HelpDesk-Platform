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
  const KEEPALIVE_LIMIT = 60 * 1024;

  function current(name) {
    try {
      return localStorage.getItem(KEYS[name]);
    } catch (error) {
      return null;
    }
  }

  async function putState(name, raw) {
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
        // keepalive の本文は仕様上 64KiB まで。超えると送信自体が失敗するため、小さいときだけ使う。
        keepalive: body.length < KEEPALIVE_LIMIT,
      });
      if (!response.ok) throw new Error('state save HTTP ' + response.status);
    } catch (error) {
      // 次の interval / 変更イベントで再試行する
      delete last[name];
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
              '<p class="small muted">承認済みナレッジから回答しています（DeepSeek API 未設定）。</p>';
          }
          const sources = (data.sources || []).map((source) => source.kbNo);
          try {
            ai(chat, html, { conf: data.confidence || '—', src: sources });
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
          originalKb(chat, text, atts, user);
        });
    };
  }

  // 表示上の AI モデル名だけを DeepSeek に合わせる（レイアウトは変更しない）。
  try {
    if (typeof MODELS === 'object' && MODELS) {
      MODELS.local = 'DeepSeek-V4.1-Flash';
      MODELS.external = 'DeepSeek-V4.1-Flash（承認済み外部）';
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
