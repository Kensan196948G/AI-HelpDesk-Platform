/*
 * 承認後の「今回反映」（⑦ ナレッジDB）— 新画面ブリッジ
 *
 * 画面仕様書 V1.0 の「承認後に一覧で『今回反映』を強調」を、
 * 既存の承認完了モーダルとナレッジDBの一覧へ取り込む（docs/95）。
 * 原本 HTML の DOM / CSS / 画面遷移は変更せず、実行時に要素を足すだけ。
 *
 * 強調するナレッジは、承認完了モーダルの文面（ナレッジDBへ保存：KB-…）から読む。
 * 画面用のデモデータは持たず、30 分だけ強調する（古い承認を「今回」と誤解させない）。
 */
(() => {
  if (window.__AIHD_REFLECT_BRIDGE__) return;
  window.__AIHD_REFLECT_BRIDGE__ = { version: 1, at: new Date().toISOString() };

  const KEY = 'ahd-reflect-kb';
  const TTL = 30 * 60 * 1000;
  const STYLE_ID = 'ahdReflectStyle';

  function readRecord() {
    try {
      const raw = sessionStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function writeRecord(value) {
    try {
      sessionStorage.setItem(KEY, JSON.stringify(value));
    } catch {
      // 保存できない環境では強調しないだけ（画面は止めない）。
    }
  }

  /** 承認完了モーダルの文面から、保存されたナレッジ番号を読む。 */
  function reflectKbId(text) {
    const match = /ナレッジDBへ保存：(KB-\d+)/.exec(String(text || ''));
    return match ? match[1] : null;
  }

  /** 直前に承認したナレッジだけを「今回反映」とする（30 分で失効）。 */
  function reflectActive(record, now) {
    if (!record || !record.id || !record.at) return null;
    if (Number(now) - Number(record.at) > TTL) return null;
    return record;
  }

  function installStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent =
      '#hdMain tr.ahd-reflect{background:#fff7dc;box-shadow:inset 3px 0 0 var(--u-safety,#f5b800)}' +
      '.ahd-reflect-note{margin:0 0 8px;padding:6px 8px;border:1px solid var(--u-safety,#f5b800);background:#fff7dc;border-radius:6px;font-size:12px}';
    document.head.appendChild(style);
  }

  /** 承認完了モーダルに「⑦ ナレッジDBの一覧で確認」を足し、保存された番号を覚える。 */
  function syncModal() {
    const modal = document.getElementById('hdModal');
    if (!modal || !modal.classList.contains('open')) return;
    const text = String(modal.textContent || '');
    if (!text.includes('承認完了')) return;
    const id = reflectKbId(text);
    if (!id) return;
    const record = readRecord();
    if (!record || record.id !== id) writeRecord({ id, at: Date.now() });
    if (modal.querySelector('[data-ahd-reflect-go]')) return;
    const box = modal.querySelector('#rsdone .btns');
    if (!box) return;
    const button = document.createElement('button');
    button.className = 'btn ghost';
    button.setAttribute('data-ahd-reflect-go', id);
    button.textContent = '⑦ ナレッジDBの一覧で確認';
    const close = Array.from(box.querySelectorAll('button')).find(
      (candidate) => candidate.textContent.trim() === '閉じる',
    );
    box.insertBefore(button, close || null);
  }

  /** ⑦ ナレッジDB の一覧で、直前に承認した行を強調する。 */
  function syncList() {
    if (!document.getElementById('kb_q')) return;
    const record = reflectActive(readRecord(), Date.now());
    if (!record) return;
    const table = document.querySelector('#hdMain table');
    if (!table) return;
    const row = Array.from(table.querySelectorAll('tbody tr')).find((candidate) => {
      const cell = candidate.querySelector('td.mono');
      return cell && cell.textContent.trim() === record.id;
    });
    if (!row || row.classList.contains('ahd-reflect')) return;
    row.classList.add('ahd-reflect');
    const title = row.querySelectorAll('td')[1];
    if (title && !title.querySelector('.ahd-reflect-badge')) {
      const badge = document.createElement('span');
      badge.className = 'badge b-ok ahd-reflect-badge';
      badge.textContent = '今回反映';
      title.appendChild(document.createTextNode(' '));
      title.appendChild(badge);
    }
    const card = table.closest('.card');
    if (card && !card.querySelector('.ahd-reflect-note')) {
      const note = document.createElement('div');
      note.className = 'ahd-reflect-note';
      note.textContent =
        '直前に承認した ' + record.id + ' を「今回反映」で示しています（30 分で消えます）。';
      card.insertBefore(note, card.firstChild);
    }
    row.scrollIntoView({ block: 'center' });
  }

  document.addEventListener('click', (event) => {
    const button =
      event.target && event.target.closest ? event.target.closest('[data-ahd-reflect-go]') : null;
    if (!button) return;
    event.preventDefault();
    const app = window.App;
    if (app && typeof app.closeModal === 'function') app.closeModal();
    if (app && typeof app.go === 'function') app.go('kb');
  });

  let scheduled = false;
  const scheduleSync = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      try {
        installStyle();
        syncModal();
        syncList();
      } catch (error) {
        console.warn('[kb-reflect] sync failed', error);
      }
    }, 80);
  };

  const root = document.getElementById('hdMain') || document.body;
  if (root) {
    new MutationObserver(scheduleSync).observe(root, { childList: true, subtree: true });
  }
  const modal = document.getElementById('hdModal');
  if (modal) {
    new MutationObserver(scheduleSync).observe(modal, { childList: true, subtree: true });
  }
  window.addEventListener('load', scheduleSync);
  setInterval(scheduleSync, 1000);
  scheduleSync();
})();
