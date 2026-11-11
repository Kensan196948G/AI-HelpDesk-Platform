/*
 * 候補の手順（② 運び役・AI一次対応）— 新画面ブリッジ
 *
 * 画面仕様書 V1.0 の「手順の繰り返し試行の一覧・試行済み表示」を、
 * 既存の AI 一次対応の画面へ取り込む（docs/94）。
 * 原本 HTML の DOM / CSS / 画面遷移は変更せず、実行時にチャットの下へ
 * 一覧を差し込む。
 *
 * データは既存の保存領域（localStorage の mirai-wizard-v31-helpdesk）を読む。
 * 引継ぎワークスペースと同じ方式で、画面用のデモデータは持たない。
 * 切り替えは既存の App.pickCand を呼び、提示・保存の処理を二重実装しない。
 */
(() => {
  if (window.__AIHD_KB_TRIAL_BRIDGE__) return;
  window.__AIHD_KB_TRIAL_BRIDGE__ = { version: 1, at: new Date().toISOString() };

  const HD_KEY = 'mirai-wizard-v31-helpdesk';
  const PANEL_ID = 'ahdKbTrial';
  const MAX_ENTRIES = 8;

  const esc = (value) =>
    String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  const pct = (score) => Math.round(Math.max(0, Math.min(1, Number(score) || 0)) * 100);

  function readState() {
    try {
      const raw = localStorage.getItem(HD_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  /** AI 画面に出ている案件は、見出しの案件番号から特定する（内部状態は公開されていない）。 */
  function selectedTicketId() {
    const chat = document.getElementById('chat');
    const card = chat && chat.closest ? chat.closest('.card') : null;
    if (!card) return null;
    const node = card.querySelector('.btns .mono') || card.querySelector('.mono');
    const match = node ? /(INC-\d{3,})/.exec(String(node.textContent || '')) : null;
    return match ? match[1] : null;
  }

  function selectedTicket() {
    const id = selectedTicketId();
    const current = readState();
    if (!id || !current || !Array.isArray(current.tickets)) return null;
    return current.tickets.find((item) => item && item.id === id) || null;
  }

  /** 会話に出た候補・提示済み・試行済みを 1 つの一覧にまとめる（重複なし）。 */
  function trialEntries(ticket, knowledge) {
    if (!ticket) return [];
    const kbs = Array.isArray(knowledge) ? knowledge : [];
    const scores = new Map();
    for (const message of Array.isArray(ticket.aiLog) ? ticket.aiLog : []) {
      if (!message || message.kind !== 'cands' || !Array.isArray(message.cands)) continue;
      for (const candidate of message.cands) {
        if (candidate && candidate.id && !scores.has(candidate.id)) {
          scores.set(candidate.id, Number(candidate.score) || 0);
        }
      }
    }
    const ids = [];
    const add = (id) => {
      if (id && !ids.includes(id)) ids.push(id);
    };
    add(ticket.activeKb);
    for (const id of Array.isArray(ticket.candidates) ? ticket.candidates : []) add(id);
    for (const id of Array.isArray(ticket.shown) ? ticket.shown : []) add(id);
    for (const id of Array.isArray(ticket.failedKb) ? ticket.failedKb : []) add(id);

    const tried = new Set(Array.isArray(ticket.failedKb) ? ticket.failedKb : []);
    return ids
      .map((id) => {
        const kb = kbs.find((item) => item && item.id === id) || null;
        return {
          id,
          title: kb ? kb.title : '（ナレッジが見つかりません）',
          archived: Boolean(kb && kb.status !== 'active'),
          score: scores.has(id) ? scores.get(id) : null,
          current: ticket.activeKb === id,
          tried: tried.has(id),
        };
      })
      .sort(
        (a, b) =>
          Number(b.current) - Number(a.current) ||
          Number(a.tried) - Number(b.tried) ||
          (b.score ?? -1) - (a.score ?? -1),
      )
      .slice(0, MAX_ENTRIES);
  }

  /** 既存の App.pickCand は「候補の提示」メッセージがあるときだけ動く（無いと例外）。 */
  function canPick(ticket) {
    return (Array.isArray(ticket.aiLog) ? ticket.aiLog : []).some(
      (message) => message && message.kind === 'cands',
    );
  }

  function entryHTML(entry, pickable) {
    const chips = [];
    if (entry.current) chips.push('<span class="badge b-ok">表示中</span>');
    if (entry.tried) {
      chips.push(
        '<span class="badge b-warn">' + (entry.current ? '前回は解決せず' : '試行済み') + '</span>',
      );
    }
    if (entry.archived) chips.push('<span class="badge">使用停止</span>');
    const meta = [];
    if (entry.score != null) meta.push('近さ ' + pct(entry.score) + '%');
    const action =
      pickable && !entry.current && !entry.archived
        ? '<button class="btn sm" data-ahd-trial="' + esc(entry.id) + '">この手順を試す</button>'
        : '';
    return (
      '<div style="display:flex;align-items:center;gap:8px;justify-content:space-between;' +
      'padding:6px 0;border-top:1px dotted var(--u-line,#d9e2ec)">' +
      '<div style="min-width:0"><div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
      '<b class="mono">' +
      esc(entry.id) +
      '</b> ' +
      esc(entry.title) +
      '</div><div class="hint">' +
      (meta.length ? esc(meta.join('・')) + ' ' : '') +
      chips.join(' ') +
      '</div></div>' +
      (action ? '<div style="flex:none">' + action + '</div>' : '') +
      '</div>'
    );
  }

  function panelHTML(ticket, entries) {
    const pickable = ticket.status === 'ai' && canPick(ticket);
    const canAct = ticket.status === 'ai';
    let note;
    if (canAct && pickable) {
      note =
        '「この手順を試す」で表示中の手順を切り替えます。解決しないときは、下の「解決しない → 担当者へ引継ぎ」を使ってください。';
    } else if (canAct) {
      note =
        'AIが候補を提示したときに切り替えできます（AIに「別の方法を教えてください」と送ると候補が出ます）。';
    } else {
      note = 'この問い合わせは対応中または完了のため、表示のみです。';
    }
    return (
      '<div id="' +
      PANEL_ID +
      '" style="margin-top:8px;padding:10px;border-top:1px dashed var(--u-line,#d9e2ec)">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px">' +
      '<b>候補の手順（' +
      entries.length +
      '件）</b><span class="hint">回数の制限はありません</span></div>' +
      (entries.length
        ? entries.map((entry) => entryHTML(entry, pickable)).join('')
        : '<div class="hint" style="margin-top:6px">候補はまだありません。AIの回答で手順が提示されると、ここに並びます。</div>') +
      '<div class="hint" style="margin-top:6px">' +
      note +
      '</div></div>'
    );
  }

  function signature(ticket, entries) {
    return [
      ticket.id,
      ticket.status,
      ticket.activeKb || '',
      Array.isArray(ticket.failedKb) ? ticket.failedKb.join(',') : '',
      canPick(ticket) ? 'pick' : 'nopick',
      entries.map((entry) => entry.id + ':' + String(entry.score)).join(','),
    ].join('|');
  }

  function pick(kbId) {
    const ticket = selectedTicket();
    if (!ticket || ticket.status !== 'ai' || !canPick(ticket)) return;
    const app = window.App;
    if (!app || typeof app.pickCand !== 'function') return;
    try {
      app.pickCand(ticket.id, kbId);
    } catch (error) {
      if (typeof toast === 'function') toast('この画面からは切り替えできません', 'bad');
    }
  }

  let lastSignature = '';

  function sync() {
    const chat = document.getElementById('chat');
    if (!chat) {
      document.getElementById(PANEL_ID)?.remove();
      lastSignature = '';
      return;
    }
    const ticket = selectedTicket();
    const current = readState();
    if (!ticket || !current) {
      document.getElementById(PANEL_ID)?.remove();
      lastSignature = '';
      return;
    }
    const entries = trialEntries(ticket, current.kb);
    if (!entries.length) {
      document.getElementById(PANEL_ID)?.remove();
      lastSignature = '';
      return;
    }
    const next = signature(ticket, entries);
    const panel = document.getElementById(PANEL_ID);
    if (!panel) {
      chat.insertAdjacentHTML('afterend', panelHTML(ticket, entries));
      lastSignature = next;
      return;
    }
    if (next !== lastSignature) {
      panel.outerHTML = panelHTML(ticket, entries);
      lastSignature = next;
    }
  }

  document.addEventListener('click', (event) => {
    const button =
      event.target && event.target.closest ? event.target.closest('[data-ahd-trial]') : null;
    if (!button) return;
    event.preventDefault();
    pick(button.getAttribute('data-ahd-trial') || '');
  });

  let scheduled = false;
  const scheduleSync = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      try {
        sync();
      } catch (error) {
        console.warn('[kb-trial] sync failed', error);
      }
    }, 80);
  };

  const root = document.getElementById('hdMain') || document.body;
  if (root) {
    new MutationObserver(scheduleSync).observe(root, { childList: true, subtree: true });
  }
  window.addEventListener('load', scheduleSync);
  setInterval(scheduleSync, 1000);
  scheduleSync();
})();
