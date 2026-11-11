/*
 * PC情報からの補足（相談者の AI 一次対応）— 新画面ブリッジ
 *
 * 画面仕様書 V1.0 の「PC診断の『PC情報からの補足』」を、相談者の画面へ取り込む
 * （docs/97）。条件どおり、**★表示と同じ判定**を使い、ルールを二重に持たない。
 *
 * 具体的には、画面がすでに出している PC基本情報の「気になる点」のうち
 * ★が付いた項目（相談内容に関係しそうな項目）を読み、直近の手順カードの下に添える。
 * 新しい診断はせず、IPアドレス・シリアル番号も表示しない。
 */
(() => {
  if (window.__AIHD_PC_SUPPLEMENT_BRIDGE__) return;
  window.__AIHD_PC_SUPPLEMENT_BRIDGE__ = { version: 1, at: new Date().toISOString() };

  const ATTR = 'data-ahd-pc-supplement';

  const esc = (value) =>
    String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });

  /** PC情報メッセージの項目から、★の付いたものだけを取り出す（純粋関数・試験対象）。 */
  function starItems(items) {
    return (Array.isArray(items) ? items : [])
      .map((item) => String(item == null ? '' : item).trim())
      .filter((item) => item.startsWith('★'))
      .map((item) => item.replace(/^★\s*/, ''))
      .filter(Boolean);
  }

  function supplementHTML(items) {
    if (!items.length) return '';
    return (
      '<div class="note n-warn" ' +
      ATTR +
      ' style="margin-top:6px">' +
      '<b>PC情報からの補足</b>' +
      '<ul style="margin:4px 0 0;padding-left:18px">' +
      items.map((item) => '<li>' + esc(item) + '</li>').join('') +
      '</ul>' +
      '<div class="hint" style="margin-top:4px">★は相談内容に関係しそうな項目です（画面のPC基本情報と同じ判定）。IPアドレス・シリアル番号は表示していません。</div></div>'
    );
  }

  /** 直近の PC情報メッセージ（「気になる点」を含む）の li を読む。 */
  function latestFlaggedItems(root) {
    const messages = Array.from(root.querySelectorAll('.msg'));
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (!String(message.textContent || '').includes('気になる点')) continue;
      const items = Array.from(message.querySelectorAll('li')).map((li) =>
        String(li.textContent || '').trim(),
      );
      return starItems(items);
    }
    return [];
  }

  let lastKey = '';

  function sync() {
    const chat = document.getElementById('msgs');
    if (!chat) return;
    // 相談者の画面では、承認済みナレッジの案内が [data-aihd-kb-guide] として出る。
    const guides = chat.querySelectorAll('[data-aihd-kb-guide]');
    const last = guides.length ? guides[guides.length - 1] : null;
    if (!last) {
      for (const old of Array.from(chat.querySelectorAll('[' + ATTR + ']'))) old.remove();
      lastKey = '';
      return;
    }
    const items = latestFlaggedItems(chat);
    const key = String(last.textContent || '').slice(0, 80) + '|' + items.join('|');
    if (key === lastKey && chat.querySelector('[' + ATTR + ']')) return;
    for (const old of Array.from(chat.querySelectorAll('[' + ATTR + ']'))) old.remove();
    lastKey = key;
    if (!items.length) return;
    last.insertAdjacentHTML('afterend', supplementHTML(items));
  }

  let scheduled = false;
  const scheduleSync = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      try {
        sync();
      } catch (error) {
        console.warn('[pc-supplement] sync failed', error);
      }
    }, 100);
  };

  const root = document.getElementById('uxPage') || document.body;
  if (root) new MutationObserver(scheduleSync).observe(root, { childList: true, subtree: true });
  window.addEventListener('load', scheduleSync);
  setInterval(scheduleSync, 1200);
  scheduleSync();
})();
