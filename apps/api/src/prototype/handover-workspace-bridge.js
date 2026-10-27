/*
 * 引継ぎワークスペース（3ペイン）— 新画面ブリッジ
 *
 * 既存プロトタイプ HTML の DOM / CSS / 画面遷移は変更しない。
 * ヘルプデスク画面のときだけ右下に「引継ぎワークスペース」ボタンを出し、
 * 全画面オーバーレイで 左=引継ぎボード / 中=経過と次の一手 / 右=案件情報 を表示する。
 *
 * データは localStorage の既存状態（mirai-wizard-v31-helpdesk / -cowork）を読む。
 * デモデータは使わない。担当開始・解決記録は既存の App.startWork / App.resolve を
 * そのまま呼び、業務ロジックを二重実装しない（画面の入力値だけ一時的に渡す）。
 */
(() => {
  if (window.__AIHD_HW_BRIDGE__) return;
  window.__AIHD_HW_BRIDGE__ = { version: 1, at: new Date().toISOString() };

  const HD_KEY = 'mirai-wizard-v31-helpdesk';
  const CW_KEY = 'mirai-wizard-v31-cowork';
  const SLA = { P1: 60, P2: 240, P3: 480, P4: 4320 };
  const STATUS = {
    escalated: '引継ぎ待ち',
    in_progress: '対応中',
    resolved: '解決済み',
    ai_resolved: 'AI解決',
  };
  const CATEGORY = {
    account: 'アカウント・認証',
    mail: 'メール・Teams',
    network: 'ネットワーク・VPN',
    device: 'PC・周辺機器',
    file: 'ファイル共有・業務アプリ',
    security: 'セキュリティ',
    other: 'その他',
  };
  const PROPOSAL_STATUS = {
    proposed: '提案中（本人Y/N待ち）',
    pending_admin: '管理者承認待ち',
    ready: '実行可能',
    executing: '実行中',
    done: '実行済み',
    failed: '失敗',
    rejected: '本人が拒否',
    aborted: '中断',
    invalidated: '無効（内容変更）',
    admin_rejected: '管理者が却下',
  };
  /** RSP 実行セッション（docs/35-terminal-session.md §4 / §6） */
  const TC_RISK = { low: '低', medium: '中', high: '高' };
  const TC_CLOSE_REASON = {
    resolved: '解決',
    stopped: '中止',
    escalated: 'エスカレーション',
    expired: '期限切れ（TTL）',
  };
  const TC_EXIT = { success: '成功', failure: '失敗', unknown: '不明' };
  const TC_CAPTURE_OFF =
    '自動取込は利用できません（RSPのターミナルログAPI未提供）。出力は手動で貼り付けてください。';
  const TC_TTL_MINUTES = 30;

  let railObserver = null;

  const HW = {
    open: false,
    embedded: false,
    baseView: null,
    baseScreen: null,
    selected: null,
    filter: 'all',
    query: '',
    inbox: [],
    inboxState: 'idle',
    inboxLoading: false,
    ai: {},
    aiBusy: {},
    aiDraft: {},
    /* RSP 実行セッション（選択案件の最新セッションだけを保持する） */
    tc: {
      key: null,
      loading: false,
      loaded: false,
      error: null,
      session: null,
      steps: [],
      capture: null,
      limits: null,
      busy: {},
      consent: { screenShare: false, remoteControl: false },
      intent: '',
      closeNote: '',
      openStep: null,
      drafts: {},
      report: null,
      knowledge: null,
    },
    scrollTop: 0,
    timer: null,
  };

  const $ = (selector, root) => (root || document).querySelector(selector);
  const $$ = (selector, root) => Array.from((root || document).querySelectorAll(selector));
  const esc = (value) =>
    String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  const pad2 = (value) => String(value).padStart(2, '0');
  const fmtTs = (value) => {
    if (!value) return '-';
    const date = new Date(typeof value === 'number' ? value : Date.parse(value));
    if (Number.isNaN(date.getTime())) return '-';
    return `${pad2(date.getMonth() + 1)}/${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  };
  const fmtFull = (value) => {
    if (!value) return '-';
    const date = new Date(typeof value === 'number' ? value : Date.parse(value));
    if (Number.isNaN(date.getTime())) return '-';
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  };
  const readJson = (key) => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  };
  const hd = () => readJson(HD_KEY) || {};
  const tickets = () => (Array.isArray(hd().tickets) ? hd().tickets.filter((t) => t && t.id) : []);
  const ticket = (id) => tickets().find((t) => t.id === id) || null;
  const links = () => (Array.isArray(hd().links) ? hd().links : []);
  const kbList = () => (Array.isArray(hd().kb) ? hd().kb : []);
  const draftList = () => (Array.isArray(hd().drafts) ? hd().drafts : []);
  const auditList = () => (Array.isArray(hd().audit) ? hd().audit : []);
  const isOpen = (t) => t.status === 'escalated' || t.status === 'in_progress';
  const isRecentResolved = (t) =>
    t.status === 'resolved' && Number(t.resolvedAt || 0) > Date.now() - 7 * 864e5;
  const dueAt = (t) => Number(t.createdAt || Date.now()) + (SLA[t.priority] || 480) * 60e3;

  function canWork() {
    try {
      const role = me().role;
      return role === 'staff' || role === 'itadmin';
    } catch {
      return true;
    }
  }

  function staffNames() {
    const names = [];
    const actor = document.getElementById('actor');
    if (actor && actor.options.length) {
      Array.from(actor.options).forEach((option) => {
        if (option.value && !/承認|監査/.test(option.textContent || '')) names.push(option.value);
      });
    }
    if (!names.length) {
      tickets().forEach((t) => {
        if (t.suggest) names.push(t.suggest);
        if (t.assignee) names.push(t.assignee);
      });
      try {
        names.push(window.HD && window.HD.actor ? window.HD.actor() : '');
      } catch {
        // ignore
      }
    }
    return Array.from(new Set(names.filter(Boolean)));
  }

  function signal(t) {
    if (t.sec) return 'red';
    if (t.status === 'escalated' && dueAt(t) < Date.now()) return 'red';
    if (t.priority === 'P1' || t.priority === 'P2') return 'amber';
    return 'blue';
  }

  function slaText(t) {
    if (t.status === 'resolved') return '解決済み';
    const diff = dueAt(t) - Date.now();
    const abs = Math.abs(diff);
    const hours = Math.floor(abs / 3600e3);
    const minutes = Math.floor((abs % 3600e3) / 60e3);
    const text = hours > 0 ? hours + 'h' + pad2(minutes) + 'm' : minutes + 'm';
    return diff >= 0 ? '残り ' + text : '超過 ' + text;
  }

  function slaClass(t) {
    if (t.status === 'resolved') return 'ok';
    return dueAt(t) < Date.now() ? 'bad' : '';
  }

  function statusChip(t) {
    const cls = t.status === 'resolved' ? 'ok' : t.status === 'in_progress' ? 'warn' : 'bad';
    return '<span class="hw-chip ' + cls + '">' + esc(STATUS[t.status] || t.status) + '</span>';
  }

  function prioChip(t) {
    const p = String(t.priority || 'P4');
    return '<span class="hw-prio p' + esc(p.slice(1)) + '">' + esc(p) + '</span>';
  }

  function childrenOf(t) {
    return links()
      .filter((l) => l.rel === 'parent' && l.a === t.id && String(l.b).startsWith('INC-'))
      .map((l) => l.b);
  }

  function cowork(t) {
    if (!t || !t.coworkTicket) return null;
    const cw = readJson(CW_KEY);
    if (!cw) return null;
    const cwTicket = (Array.isArray(cw.tickets) ? cw.tickets : []).find(
      (x) => x.id === t.coworkTicket,
    );
    const chat = cwTicket
      ? (Array.isArray(cw.chats) ? cw.chats : []).find((x) => x.id === cwTicket.chatId)
      : null;
    const proposals = chat
      ? Object.values(cw.proposals || {}).filter((p) => p && p.chatId === chat.id)
      : [];
    const cwCase = chat
      ? (Array.isArray(cw.cases) ? cw.cases : []).find((c) => c.chatId === chat.id)
      : null;
    return { ticket: cwTicket, chat, proposals, caseId: cwCase ? cwCase.id : null };
  }

  function htmlToText(html) {
    // 不活性な DOMParser でテキスト化する（img/onerror 等を実行させない）。
    const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function messageText(message, proposals) {
    if (message.text) return String(message.text);
    if (message.html) return htmlToText(message.html);
    if (message.kind === 'proposal') {
      const proposal = (proposals || []).find((p) => p.id === message.propId);
      return proposal
        ? 'AIの提案：' +
            proposal.opId +
            '（' +
            (PROPOSAL_STATUS[proposal.status] || proposal.status) +
            '）'
        : 'AIの提案';
    }
    return '';
  }

  /* ============================ 画面（3ペイン） ============================ */

  function sortTickets(list) {
    const rank = { escalated: 0, in_progress: 1, resolved: 2 };
    const prank = { P1: 0, P2: 1, P3: 2, P4: 3 };
    return list
      .slice()
      .sort(
        (a, b) =>
          (rank[a.status] == null ? 9 : rank[a.status]) -
            (rank[b.status] == null ? 9 : rank[b.status]) ||
          (prank[a.priority] == null ? 9 : prank[a.priority]) -
            (prank[b.priority] == null ? 9 : prank[b.priority]) ||
          dueAt(a) - dueAt(b),
      );
  }

  function available() {
    const base = tickets().filter((t) => isOpen(t) || isRecentResolved(t));
    const q = HW.query.trim().toLowerCase();
    const searched = q
      ? base.filter((t) =>
          [t.id, t.subject, t.requester, t.assignee, t.suggest, t.body]
            .join(' ')
            .toLowerCase()
            .includes(q),
        )
      : base;
    let filtered = searched;
    if (HW.filter === 'open') filtered = searched.filter((t) => t.status === 'escalated');
    else if (HW.filter === 'progress')
      filtered = searched.filter((t) => t.status === 'in_progress');
    else if (HW.filter === 'done') filtered = searched.filter((t) => t.status === 'resolved');
    return sortTickets(filtered);
  }

  function ensureSelected() {
    if (HW.selected && tickets().some((t) => t.id === HW.selected)) return;
    const list = available();
    const first =
      list[0] || sortTickets(tickets().filter((t) => isOpen(t) || isRecentResolved(t)))[0] || null;
    HW.selected = first ? first.id : null;
  }

  function current() {
    return HW.selected ? ticket(HW.selected) : null;
  }

  function cardHTML(t) {
    const meta = [t.requester, t.suggest ? 'おすすめ ' + t.suggest : '']
      .filter(Boolean)
      .join(' ・ ');
    return (
      '<button type="button" class="hw-card' +
      (HW.selected === t.id ? ' on' : '') +
      '" data-hw="select" data-id="' +
      esc(t.id) +
      '" aria-current="' +
      (HW.selected === t.id ? 'true' : 'false') +
      '">' +
      '<span class="hw-sig hw-sig-' +
      signal(t) +
      '"></span>' +
      '<span class="hw-card-top"><span class="hw-mono">' +
      esc(t.id) +
      '</span><span class="hw-sla ' +
      slaClass(t) +
      '">' +
      esc(slaText(t)) +
      '</span></span>' +
      '<span class="hw-card-subject">' +
      esc(t.subject) +
      '</span>' +
      '<span class="hw-card-meta">' +
      esc(meta || '依頼者不明') +
      '</span>' +
      '<span class="hw-card-chips">' +
      prioChip(t) +
      statusChip(t) +
      (t.assignee ? '<span class="hw-chip">' + esc(t.assignee) + '</span>' : '') +
      (t.coworkTicket ? '<span class="hw-chip info">AI窓口</span>' : '') +
      (t.sec ? '<span class="hw-chip bad">セキュリティ</span>' : '') +
      '</span></button>'
    );
  }

  function inboxHTML() {
    if (!HW.inbox.length && HW.inboxState !== 'loading' && HW.inboxState !== 'error') return '';
    const claimable = canWork();
    let html =
      '<div class="hw-inbox"><div class="hw-inbox-h">未受領の引継ぎ <span>' +
      HW.inbox.length +
      '</span></div>';
    if (HW.inboxState === 'loading') {
      html += '<div class="hw-empty sm">受信箱を読み込み中…</div>';
    } else if (HW.inboxState === 'error') {
      html += '<div class="hw-empty sm">受信箱を取得できませんでした</div>';
    } else {
      html += HW.inbox
        .map(
          (item) =>
            '<div class="hw-inbox-item"><div class="hw-inbox-main"><b>' +
            esc(item.subject || '(件名なし)') +
            '</b><small>' +
            esc(item.requester || '') +
            ' ・ ' +
            esc(item.caseId || '') +
            (item.assigneeHint ? ' ・ 宛先 ' + esc(item.assigneeHint) : '') +
            '</small></div>' +
            (claimable
              ? '<button type="button" class="hw-btn sm pri" data-hw="claim" data-id="' +
                esc(item.id) +
                '">引き受ける</button>'
              : '<span class="hw-chip">担当者のみ</span>') +
            '</div>',
        )
        .join('');
    }
    return html + '</div>';
  }

  function renderList() {
    const all = tickets().filter((t) => isOpen(t) || isRecentResolved(t));
    const counts = {
      all: all.length,
      open: all.filter((t) => t.status === 'escalated').length,
      progress: all.filter((t) => t.status === 'in_progress').length,
      done: all.filter((t) => t.status === 'resolved').length,
    };
    $('#hw-counts').textContent =
      '引継ぎ待ち ' +
      counts.open +
      ' ・ 対応中 ' +
      counts.progress +
      ' ・ 解決（7日）' +
      counts.done;
    $$('#hw-filters [data-filter]').forEach((button) => {
      button.classList.toggle('on', button.dataset.filter === HW.filter);
      const count = button.querySelector('b');
      if (count) count.textContent = String(counts[button.dataset.filter] || 0);
    });
    const list = available();
    $('#hw-list').innerHTML =
      inboxHTML() +
      (list.length
        ? list.map(cardHTML).join('')
        : '<div class="hw-empty">該当する案件はありません。<br>絞り込みや検索条件を変えてください。</div>');
  }

  function sharedHTML(t) {
    const shared = t.coworkShared && typeof t.coworkShared === 'object' ? t.coworkShared : {};
    const keys = Object.keys(shared);
    if (!keys.length) {
      return (
        '<p class="hw-empty sm">' +
        (t.coworkTicket
          ? '共有された情報はありません。'
          : 'AI窓口以外からの受付のため、共有情報はありません。') +
        '</p>'
      );
    }
    return (
      '<dl class="hw-kv">' +
      keys
        .map((key) => {
          const raw = shared[key];
          const value = Array.isArray(raw)
            ? raw.join(' / ')
            : raw && typeof raw === 'object'
              ? JSON.stringify(raw)
              : String(raw == null ? '' : raw);
          return '<dt>' + esc(key) + '</dt><dd>' + esc(value) + '</dd>';
        })
        .join('') +
      '</dl><p class="hw-note">本人が同意した範囲のみ。IP・シリアル・メール等は共有前に伏せ字化されています。</p>'
    );
  }

  function relatedKbs(t) {
    const ids = new Set();
    [t.kbId, t.activeKb, t.aiResolvedKb].forEach((id) => {
      if (id) ids.add(id);
    });
    (Array.isArray(t.failedKb) ? t.failedKb : []).forEach((id) => {
      if (id) ids.add(id);
    });
    (Array.isArray(t.aiLog) ? t.aiLog : []).forEach((m) => {
      if (m && m.kbId) ids.add(m.kbId);
    });
    links().forEach((l) => {
      if (String(l.rel || '').startsWith('kb_')) {
        if (l.a === t.id && String(l.b).startsWith('KB-')) ids.add(l.b);
        if (l.b === t.id && String(l.a).startsWith('KB-')) ids.add(l.a);
      }
    });
    return Array.from(ids).map((id) => {
      const kb = kbList().find((k) => k.id === id);
      return {
        id,
        title: kb ? kb.title : '（ナレッジが見つかりません）',
        failed: (Array.isArray(t.failedKb) ? t.failedKb : []).includes(id),
        status: kb ? kb.status : '',
      };
    });
  }

  function auditHTML(t) {
    const draft = t.draftId;
    const rows = auditList()
      .filter((a) => a && (a.target === t.id || (draft && a.target === draft)))
      .sort((a, b) => Number(b.t || 0) - Number(a.t || 0))
      .slice(0, 6);
    if (!rows.length) return '<p class="hw-empty sm">記録はありません。</p>';
    return (
      '<div class="hw-audit">' +
      rows
        .map(
          (a) =>
            '<div class="hw-audit-row"><span>' +
            esc(fmtTs(a.t)) +
            '</span><b>' +
            esc(a.actor || '') +
            '</b><span>' +
            esc(a.action || '') +
            '</span><small>' +
            esc(a.detail || '') +
            '</small></div>',
        )
        .join('') +
      '</div><p class="hw-note">ヘルプデスクの操作履歴です（監査ログ）。</p>'
    );
  }

  function draftHTML(t) {
    const draft = t.draftId ? draftList().find((d) => d.id === t.draftId) : null;
    if (!draft) {
      return '<p class="hw-empty sm">未作成です。解決記録から作成できます。</p>';
    }
    const labels = {
      draft: '下書き',
      review: '承認待ち',
      returned: '差戻し',
      approved: '承認・反映済み',
    };
    return (
      '<dl class="hw-kv"><dt>ID</dt><dd class="hw-mono">' +
      esc(draft.id) +
      '</dd><dt>状態</dt><dd><span class="hw-chip ' +
      (draft.status === 'approved' ? 'ok' : draft.status === 'review' ? 'warn' : '') +
      '">' +
      esc(labels[draft.status] || draft.status) +
      '</span></dd><dt>申請者</dt><dd>' +
      esc(draft.applicant || '-') +
      '</dd></dl><div class="hw-actions"><button type="button" class="hw-btn sm" data-hw="draft">下書きを開く</button></div>'
    );
  }

  function proposalsHTML(cw) {
    if (!cw || !cw.proposals.length) return '<p class="hw-empty sm">操作の提案はありません。</p>';
    return (
      '<div class="hw-props">' +
      cw.proposals
        .map((p) => {
          const hash = p.hash ? String(p.hash) : '';
          return (
            '<div class="hw-prop"><div class="hw-prop-h"><b class="hw-mono">' +
            esc(p.opId || p.id) +
            '</b><span class="hw-chip ' +
            (p.status === 'done'
              ? 'ok'
              : p.status === 'failed' || p.status === 'rejected'
                ? 'bad'
                : 'warn') +
            '">' +
            esc(PROPOSAL_STATUS[p.status] || p.status) +
            '</span></div>' +
            (hash
              ? '<div class="hw-prop-k">承認ハッシュ <code>' +
                esc(hash.slice(0, 16)) +
                '…</code></div>'
              : '') +
            (p.userDecision
              ? '<div class="hw-prop-k">本人 ' +
                esc(p.userDecision.dec || 'Y') +
                ' ・ ' +
                esc(fmtTs(p.userDecision.at)) +
                '</div>'
              : '') +
            (p.adminDecision
              ? '<div class="hw-prop-k">管理者 ' +
                esc(p.adminDecision.dec || 'approve') +
                ' ・ ' +
                esc(fmtTs(p.adminDecision.at)) +
                '</div>'
              : '') +
            '</div>'
          );
        })
        .join('') +
      '</div><p class="hw-note">既存の修復フロー（承認ハッシュ）の記録です。解決ループ（Skill / verify）とは別系統です。</p>'
    );
  }

  function chatHTML(cw) {
    const messages = (cw.chat && Array.isArray(cw.chat.messages) ? cw.chat.messages : []).filter(
      (m) => m && m.kind !== 'welcome',
    );
    if (!messages.length) return '<p class="hw-empty sm">共有された会話はありません。</p>';
    const tail = messages.slice(-12);
    const html = tail
      .map((m) => {
        const text = messageText(m, cw.proposals);
        if (!text) return '';
        const role = m.kind === 'user' ? 'user' : 'ai';
        const who = m.kind === 'user' ? '依頼者' : m.who || 'AI';
        const proposal = m.kind === 'proposal' ? cw.proposals.find((p) => p.id === m.propId) : null;
        return (
          '<div class="hw-msg ' +
          role +
          '"><div class="hw-msg-h"><b>' +
          esc(who) +
          '</b><span>' +
          esc(fmtTs(m.at)) +
          '</span></div><div class="hw-msg-b">' +
          esc(text) +
          '</div>' +
          (m.kbId
            ? '<div class="hw-msg-chips"><span class="hw-chip info">' +
              esc(m.kbId) +
              '</span>' +
              (m.score != null
                ? '<span class="hw-chip">近さ ' + Math.round(Number(m.score) * 100) + '%</span>'
                : '') +
              '</div>'
            : '') +
          (proposal
            ? '<div class="hw-msg-chips"><span class="hw-chip ' +
              (proposal.status === 'done' ? 'ok' : 'warn') +
              '">' +
              esc(PROPOSAL_STATUS[proposal.status] || proposal.status) +
              '</span></div>'
            : '') +
          '</div>'
        );
      })
      .join('');
    return (
      '<div class="hw-chat">' +
      html +
      '</div>' +
      (messages.length > tail.length
        ? '<p class="hw-note">全 ' +
          messages.length +
          ' 件のうち新しい ' +
          tail.length +
          ' 件を表示しています。</p>'
        : '')
    );
  }

  function aiLogHTML(t) {
    const log = Array.isArray(t.aiLog) ? t.aiLog : [];
    if (!log.length) return '<p class="hw-empty sm">記録はありません。</p>';
    return (
      '<div class="hw-chat">' +
      log
        .slice(-12)
        .map((m) => {
          const role = m.role === 'user' ? 'user' : m.role === 'sys' ? 'sys' : 'ai';
          const who =
            m.role === 'user'
              ? t.requester || '依頼者'
              : m.role === 'sys'
                ? 'システム'
                : m.who || 'AI';
          return (
            '<div class="hw-msg ' +
            role +
            '"><div class="hw-msg-h"><b>' +
            esc(who) +
            '</b><span>' +
            esc(fmtTs(m.t)) +
            '</span></div><div class="hw-msg-b">' +
            esc(m.text || messageText(m, [])) +
            '</div>' +
            (m.kbId
              ? '<div class="hw-msg-chips"><span class="hw-chip info">' +
                esc(m.kbId) +
                '</span>' +
                (m.score != null
                  ? '<span class="hw-chip">近さ ' + Math.round(Number(m.score) * 100) + '%</span>'
                  : '') +
                '</div>'
              : '') +
            '</div>'
          );
        })
        .join('') +
      '</div>'
    );
  }

  function historyHTML(t) {
    const history = (Array.isArray(t.history) ? t.history : [])
      .slice()
      .sort((a, b) => Number(a.t || 0) - Number(b.t || 0));
    if (!history.length) return '<p class="hw-empty sm">履歴はありません。</p>';
    return (
      '<ol class="hw-timeline">' +
      history
        .map(
          (h) =>
            '<li><span class="hw-tl-dot"></span><span class="hw-tl-t">' +
            esc(fmtTs(h.t)) +
            '</span><b>' +
            esc(h.actor || '') +
            '</b><span class="hw-tl-x">' +
            esc(h.a || '') +
            '</span></li>',
        )
        .join('') +
      '</ol>'
    );
  }

  function actionHTML(t, kids) {
    if (!canWork()) {
      return '<section class="hw-action readonly"><div class="hw-action-h"><b>閲覧のみ</b><span class="hw-tag display">表示</span><span class="hw-chip">権限分離</span></div><p class="hw-note">承認者・監査担当は、担当開始・解決記録を登録できません。内容の確認と監査の参照のみ行えます。</p></section>';
    }
    if (t.status === 'escalated') {
      const names = staffNames();
      const selected = names.includes(t.suggest) ? t.suggest : names[0] || '';
      return (
        '<section class="hw-action"><div class="hw-action-h"><b>次の一手：担当を決めて対応を開始</b><span class="hw-tag input">入力</span>' +
        (t.suggest ? '<span class="hw-chip">AIのおすすめ ' + esc(t.suggest) + '</span>' : '') +
        '</div><div class="hw-form-row"><label>担当者<select id="hw-assignee">' +
        (names.length
          ? names
              .map(
                (name) =>
                  '<option value="' +
                  esc(name) +
                  '"' +
                  (name === selected ? ' selected' : '') +
                  '>' +
                  esc(name) +
                  '</option>',
              )
              .join('')
          : '<option value="">（担当者を取得できません）</option>') +
        '</select></label><button type="button" class="hw-btn pri" data-hw="start">担当して対応開始</button></div></section>'
      );
    }
    if (t.status === 'in_progress') {
      return (
        '<section class="hw-action"><div class="hw-action-h"><b>次の一手：解決を記録</b><span class="hw-tag input">入力</span><span class="hw-chip">担当 ' +
        esc(t.assignee || '-') +
        '</span></div><div class="hw-form-row"><label>原因<textarea id="hw-cause" rows="2" placeholder="事実のみ（推測を書かない）"></textarea></label></div><div class="hw-form-row"><label>対応手順（1行に1手順）<textarea id="hw-steps" rows="4" placeholder="第三者が再現できる粒度で"></textarea></label></div><div class="hw-form-row two"><label>所要時間（分）<input id="hw-min" type="number" min="0" value="30"></label><label>備考<input id="hw-note" placeholder="任意"></label></div>' +
        (kids.length
          ? '<label class="hw-check"><input type="checkbox" id="hw-child"> 子の問い合わせ ' +
            kids.length +
            '件（' +
            kids.map(esc).join('、') +
            '）も一括解決する</label>'
          : '') +
        '<label class="hw-check"><input type="checkbox" id="hw-kb" checked> 解決内容からナレッジ下書きを作成する（承認は別の承認者）</label><div class="hw-form-row end"><button type="button" class="hw-btn ok" data-hw="resolve">解決を記録</button><button type="button" class="hw-btn ghost" data-hw="example">記入例を入れる</button></div></section>'
      );
    }
    if (t.status === 'resolved') {
      const r = t.resolution || {};
      return (
        '<section class="hw-action ok"><div class="hw-action-h"><b>解決済み</b><span class="hw-tag display">表示</span><span class="hw-chip ok">' +
        esc(fmtTs(t.resolvedAt)) +
        ' / ' +
        esc(r.by || t.assignee || '') +
        '</span></div><dl class="hw-dl"><dt>原因</dt><dd>' +
        esc(r.cause || '-') +
        '</dd><dt>手順</dt><dd><ol>' +
        (Array.isArray(r.steps) ? r.steps : [])
          .map((step) => '<li>' + esc(step) + '</li>')
          .join('') +
        '</ol></dd><dt>所要</dt><dd>' +
        esc(r.minutes == null ? '-' : r.minutes + '分') +
        '</dd></dl>' +
        (t.draftId
          ? '<div class="hw-form-row end"><button type="button" class="hw-btn" data-hw="draft">ナレッジ下書き ' +
            esc(t.draftId) +
            ' を開く</button></div>'
          : '') +
        '</section>'
      );
    }
    return '<section class="hw-action"><b>AIで解決済みの案件です。</b></section>';
  }

  function aiItemHTML(item) {
    const sources = (Array.isArray(item.sources) ? item.sources : [])
      .map((source) => source && (source.kbNo || source.id || ''))
      .filter(Boolean);
    return (
      '<div class="hw-ai-qa"><div class="hw-ai-q">Q. ' +
      esc(item.q) +
      '</div><div class="hw-ai-answer' +
      (item.error ? ' bad' : '') +
      '">' +
      esc(item.a) +
      '</div><div class="hw-ai-meta">' +
      sources.map((source) => '<span class="hw-chip">' + esc(source) + '</span>').join('') +
      (item.model ? '<span class="hw-chip">' + esc(item.model) + '</span>' : '') +
      (item.confidence ? '<span class="hw-chip">確信度 ' + esc(item.confidence) + '</span>' : '') +
      '<span class="hw-chip">' +
      (item.mode === 'case' ? '案件コンテキスト' : 'ナレッジ') +
      '</span></div>' +
      (item.prompt
        ? '<details class="hw-ai-prompt"><summary>プロンプトを見る / コピー <span class="hw-tag display">表示</span></summary><div class="hw-ai-prompt-actions"><button type="button" class="hw-btn sm" data-hw="copy-prompt">コピー</button></div><label>システム指示<textarea readonly rows="5">' +
          esc(item.prompt.system) +
          '</textarea></label><label>ユーザープロンプト<textarea readonly rows="7">' +
          esc(item.prompt.user) +
          '</textarea></label></details>'
        : '') +
      '</div>'
    );
  }

  function aiHTML(t) {
    if (!canWork()) return '';
    const cw = cowork(t);
    const caseId = cw ? cw.caseId : null;
    const busy = Boolean(HW.aiBusy[t.id]);
    const items = (HW.ai[t.id] || []).slice(-5);
    const note = caseId
      ? 'Aさんが共有したPC情報と、ここまでのAI一次対応の履歴を根拠に回答します。引継ぎ記録がある場合は、質問と回答をその記録に保存します。'
      : 'AI窓口から引き継がれた案件ではないため、承認済みナレッジを根拠に回答します。質問は案件記録に保存されません。';
    return (
      '<section class="hw-action hw-ai"><div class="hw-action-h"><b>AI に聞く</b><span class="hw-tag input">入力</span><span class="hw-chip info">' +
      (caseId ? '案件コンテキスト' : 'ナレッジ検索') +
      '</span></div><p class="hw-ai-note">' +
      esc(note) +
      '</p><p class="hw-ai-note">プロンプトには承認済みナレッジ本文と共有PC情報が含まれます。取扱いに注意してください。</p><div class="hw-form-row"><label>質問<textarea id="hw-ai-input" rows="2" placeholder="例：この状態で次に確認すべきことは？">' +
      esc(HW.aiDraft[t.id] || '') +
      '</textarea></label></div><div class="hw-form-row end"><button type="button" class="hw-btn pri" data-hw="ai"' +
      (busy ? ' disabled' : '') +
      '>' +
      (busy ? '回答中…' : 'AI に聞く') +
      '</button></div>' +
      items.map(aiItemHTML).join('') +
      '</section>'
    );
  }

  async function askAi(t) {
    if (!canWork() || HW.aiBusy[t.id]) return;
    const input = $('#hw-ai-input');
    const text = input ? input.value.trim() : '';
    if (!text) {
      hwToast('聞きたいことを入力してください');
      return;
    }
    const cw = cowork(t);
    const caseId = cw ? cw.caseId : null;
    HW.aiDraft[t.id] = text;
    HW.aiBusy[t.id] = true;
    const button = root.querySelector('[data-hw="ai"]');
    if (button) {
      button.disabled = true;
      button.textContent = '回答中…';
    }
    let mode = caseId ? 'case' : 'kb';
    let data = null;
    let error = null;
    const ask = async (url, payload) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => null);
      return { response, body };
    };
    const fallbackText =
      '【案件】' +
      String(t.subject || '').slice(0, 200) +
      '\n' +
      String(t.body || '').slice(0, 800) +
      '\n\n【担当者の質問】' +
      text;
    try {
      let result;
      if (caseId) {
        result = await ask('/api/ai/answer-case', { caseId, text });
        if (result.response.status === 404 || result.response.status >= 500) {
          mode = 'kb';
          result = await ask('/api/ai/answer', { text: fallbackText });
        }
      } else {
        result = await ask('/api/ai/answer', { text: fallbackText });
      }
      if (!result.response.ok) {
        throw new Error(
          result.body && result.body.error
            ? result.body.error.message
            : 'HTTP ' + result.response.status,
        );
      }
      data = result.body || {};
    } catch (err) {
      error = String(err && err.message ? err.message : err).slice(0, 180);
    }
    HW.ai[t.id] = HW.ai[t.id] || [];
    HW.ai[t.id].push({
      q: text,
      a: error
        ? '回答できませんでした：' + error
        : data && data.answer
          ? data.answer
          : '回答が空でした。',
      sources: (data && data.sources) || [],
      model: (data && data.model) || '',
      confidence: (data && data.confidence) || '',
      mode,
      error: Boolean(error),
      prompt: (data && data.prompt) || null,
      at: Date.now(),
    });
    if (HW.ai[t.id].length > 8) HW.ai[t.id] = HW.ai[t.id].slice(-8);
    HW.aiBusy[t.id] = false;
    HW.aiDraft[t.id] = '';
    if (current() && current().id === t.id) renderAll();
    if (error) hwToast('AI の回答に失敗しました：' + error, 'bad');
    else hwToast('AI が回答しました。', 'ok');
  }

  /* ============================ RSP 実行セッション（§4 / §6） ============================ */

  function tcReset() {
    const tc = HW.tc;
    tc.key = null;
    tc.loading = false;
    tc.loaded = false;
    tc.error = null;
    tc.session = null;
    tc.steps = [];
    tc.capture = null;
    tc.limits = null;
    tc.busy = {};
    tc.consent = { screenShare: false, remoteControl: false };
    tc.intent = '';
    tc.closeNote = '';
    tc.openStep = null;
    tc.drafts = {};
    tc.report = null;
    tc.knowledge = null;
  }

  function tcLimits() {
    const raw = HW.tc.limits || (HW.tc.session && HW.tc.session.limits) || {};
    const pick = (value, fallback) => (Number(value) > 0 ? Number(value) : fallback);
    return {
      maxSteps: pick(raw.maxSteps, 20),
      maxOutputChars: pick(raw.maxOutputChars, 20000),
      maxCommandChars: pick(raw.maxCommandChars, 8000),
      maxNoteChars: pick(raw.maxNoteChars, 1000),
    };
  }

  /** 残り時間（ミリ秒）。active 以外は null。 */
  function tcRemain(session) {
    if (!session || session.status !== 'active') return null;
    const end = Date.parse(session.expiresAt || '');
    if (Number.isNaN(end)) return null;
    return end - Date.now();
  }

  function tcRemainText(ms) {
    if (ms == null) return '';
    if (ms <= 0) return '期限切れ';
    const total = Math.floor(ms / 1000);
    return Math.floor(total / 60) + ':' + pad2(total % 60);
  }

  function tcExpired() {
    const remain = tcRemain(HW.tc.session);
    return remain != null && remain <= 0;
  }

  function tcStatusChip() {
    const session = HW.tc.session;
    if (!session) return '';
    if (session.status === 'active') return '<span class="hw-chip ok">実行中</span>';
    const reason = TC_CLOSE_REASON[session.closeReason] || session.closeReason || '終了';
    return '<span class="hw-chip">' + esc(reason) + '</span>';
  }

  /** 記録フォームの入力値を保持する（右ペイン再描画で入力が消えないように）。 */
  function tcDraftOf(step) {
    if (!HW.tc.drafts[step.id]) {
      HW.tc.drafts[step.id] = {
        command: step.proposal && step.proposal.command ? step.proposal.command : '',
        output: '',
        exitStatus: 'success',
        note: '',
      };
    }
    return HW.tc.drafts[step.id];
  }

  function tcLastOutput() {
    for (let index = HW.tc.steps.length - 1; index >= 0; index -= 1) {
      const step = HW.tc.steps[index];
      if (step.executed && step.executed.output) return String(step.executed.output).slice(0, 4000);
    }
    return '';
  }

  function tcErrorText(status, data) {
    const code = data && data.error ? String(data.error.code || '') : '';
    const serverMessage = data && data.error ? String(data.error.message || '') : '';
    const map = {
      NOT_CLAIMED_OPERATOR: 'この案件を引き受け（claim）した担当者のみ操作できます。',
      SESSION_ACTIVE: 'この案件には実行中のセッションがあります。',
      SESSION_CLOSED: 'このセッションは終了済みです。',
      STEP_LIMIT: 'ステップの上限に達しました。セッションを終了してください。',
      STEP_RECORDED: 'このステップは記録済みです。再送はできません。',
      CAPTURE_UNAVAILABLE: '自動取込は利用できません。出力は手動で貼り付けてください。',
      AI_UNAVAILABLE: 'AIの提案を取得できませんでした（API未設定または障害）。',
      RATE_LIMITED: '操作が多すぎます。少し待ってから再試行してください。',
      NOT_FOUND: '対象の引継ぎが見つかりません。',
    };
    if (status === 0) return '通信に失敗しました。ネットワークを確認してください。';
    if (status === 401)
      return 'ログインの有効期限が切れました。再読み込みしてログインし直してください。';
    if (status === 403)
      return map[code] || serverMessage || 'この操作を行う権限がありません（担当者本人のみ）。';
    if (status === 404)
      return (
        serverMessage || '実行セッションのAPIが見つかりません（APIの反映待ちの可能性があります）。'
      );
    if (status === 409)
      return map[code] || serverMessage || '状態が変わりました。⟳ 更新で再読み込みしてください。';
    if (status === 429)
      return map[code] || serverMessage || '操作が多すぎます。少し待ってから再試行してください。';
    if (status === 502 || status === 503)
      return map[code] || serverMessage || 'AIが利用できません（API未設定または障害）。';
    if (status === 400) return serverMessage || map[code] || '入力内容を確認してください。';
    return serverMessage || '操作に失敗しました（' + status + '）。';
  }

  /** JSON API 呼び出し。例外を投げず、表示用のメッセージに正規化して返す。 */
  async function tcSend(url, options) {
    try {
      const response = await fetch(url, {
        method: options && options.method ? options.method : 'GET',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: options && options.body ? options.body : undefined,
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        return {
          data: null,
          status: response.status,
          code: data && data.error ? String(data.error.code || '') : '',
          message: tcErrorText(response.status, data),
        };
      }
      return { data: data || {}, status: response.status, code: '', message: null };
    } catch {
      return { data: null, status: 0, code: '', message: tcErrorText(0, null) };
    }
  }

  /**
   * 送信中フラグを立てて実行する（二重送信防止）。
   * 成功時は data を返し、失敗時は hwToast とカード内メッセージの両方で通知する。
   */
  async function tcApply(action, run) {
    if (HW.tc.busy[action]) return null;
    HW.tc.busy[action] = true;
    HW.tc.error = null;
    renderEv();
    try {
      const result = await run();
      if (!result || !result.data) {
        const message = result && result.message ? result.message : '操作に失敗しました。';
        HW.tc.error = message;
        hwToast(message, 'bad');
        return null;
      }
      return result.data;
    } catch {
      const message = '操作に失敗しました（通信または応答の解析）。';
      HW.tc.error = message;
      hwToast(message, 'bad');
      return null;
    } finally {
      HW.tc.busy[action] = false;
      renderEv();
    }
  }

  function tcSetSession(session) {
    if (!session) return;
    HW.tc.session = session;
    if (session.capture) HW.tc.capture = session.capture;
    if (session.limits) HW.tc.limits = session.limits;
  }

  function tcSetStep(step) {
    if (!step || !step.id) return;
    const list = HW.tc.steps;
    const index = list.findIndex((item) => item.id === step.id);
    if (index >= 0) list[index] = step;
    else list.push(step);
    list.sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0));
    if (HW.tc.session) HW.tc.session.stepCount = list.length;
    delete HW.tc.drafts[step.id];
    if (HW.tc.openStep === step.id) HW.tc.openStep = null;
  }

  function tcApplyPayload(data) {
    if (!data) return;
    if (data.session) tcSetSession(data.session);
    if (Array.isArray(data.steps)) {
      HW.tc.steps = data.steps.slice().sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0));
      if (HW.tc.session) HW.tc.session.stepCount = HW.tc.steps.length;
    }
    if (data.step) tcSetStep(data.step);
  }

  async function tcLoad(key) {
    const result = await tcSend('/api/terminal/sessions?caseId=' + encodeURIComponent(key), null);
    if (HW.tc.key !== key) return;
    if (!result.data) {
      HW.tc.session = null;
      HW.tc.steps = [];
      HW.tc.error = result.message;
      HW.tc.loading = false;
      HW.tc.loaded = true;
      renderEv();
      return;
    }
    HW.tc.session = result.data.session || null;
    HW.tc.steps = Array.isArray(result.data.steps)
      ? result.data.steps.slice().sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0))
      : [];
    HW.tc.capture = HW.tc.session && HW.tc.session.capture ? HW.tc.session.capture : null;
    HW.tc.limits = HW.tc.session && HW.tc.session.limits ? HW.tc.session.limits : null;
    HW.tc.error = null;
    HW.tc.loading = false;
    HW.tc.loaded = true;
    if (HW.tc.session && !HW.tc.capture) void tcLoadCapture(HW.tc.session.id, key);
    renderEv();
  }

  /** セッション DTO に capture が無い場合のフォールバック（§4-4）。 */
  async function tcLoadCapture(sessionId, key) {
    const result = await tcSend(
      '/api/terminal/sessions/' + encodeURIComponent(sessionId) + '/capture',
      null,
    );
    if (HW.tc.key !== key || !result.data) return;
    HW.tc.capture = {
      supported: Boolean(result.data.supported),
      reason: result.data.reason ? String(result.data.reason) : '',
    };
    renderEv();
  }

  /**
   * 端末セッションAPIの案件ID（caseId）。
   * ヘルプデスクのチケットID（INC-…）ではなく、引継ぎ元の cowork 案件ID（CASE-…）を使う。
   * cowork 案件が無い場合だけチケットIDにフォールバックする。
   */
  function caseIdOf(t) {
    if (!t) return null;
    const cw = cowork(t);
    if (cw && cw.caseId) return String(cw.caseId);
    return String(t.id);
  }

  function ensureTerminal(t) {
    if (!HW.open) return;
    const key = t ? caseIdOf(t) : null;
    if (!key) {
      if (HW.tc.key !== null) tcReset();
      return;
    }
    if (HW.tc.key === key) {
      if (!HW.tc.loading && !HW.tc.loaded) {
        HW.tc.loading = true;
        void tcLoad(key);
      }
      return;
    }
    tcReset();
    HW.tc.key = key;
    HW.tc.loading = true;
    void tcLoad(key);
  }

  /** 右ペインだけを再描画する（中央ペインの入力やスクロールを壊さない）。 */
  function renderEv() {
    if (!HW.open) return;
    const t = current();
    const ev = $('#hw-ev');
    if (!ev || !t) return;
    const top = ev.scrollTop;
    ev.innerHTML = evHTML(t);
    ev.scrollTop = top;
  }

  function tcCaptureHTML() {
    const capture = HW.tc.capture;
    if (capture && capture.supported) {
      return '<div class="hw-alert info"><b>自動取込が有効です。</b> 実行結果はRSPのログから取り込みます。手動での貼り付けもできます。</div>';
    }
    const reason = capture && capture.reason ? String(capture.reason) : '';
    return (
      '<div class="hw-alert bad"><b>自動取込は利用できません</b>（RSPのターミナルログAPI未提供）。出力は手動で貼り付けてください。' +
      (reason && reason !== TC_CAPTURE_OFF
        ? '<div class="hw-tc-meta">' + esc(reason) + '</div>'
        : '') +
      '</div>'
    );
  }

  function tcStartHTML() {
    const consent = HW.tc.consent;
    const busy = Boolean(HW.tc.busy.start);
    return (
      '<div class="hw-tc-form"><label class="hw-check"><input type="checkbox" data-hw-field="consent" data-consent="screenShare"' +
      (consent.screenShare ? ' checked' : '') +
      '>画面共有に同意する（必要な場合）</label><label class="hw-check"><input type="checkbox" data-hw-field="consent" data-consent="remoteControl"' +
      (consent.remoteControl ? ' checked' : '') +
      '>操作支援（RSPのターミナル操作）に同意する</label><div class="hw-form-row end"><button type="button" class="hw-btn pri" data-hw="tc-start"' +
      (consent.remoteControl && !busy ? '' : ' disabled') +
      '>' +
      (busy ? '開始しています…' : 'セッションを開始') +
      '</button></div><p class="hw-note">操作支援に同意しないと開始できません。サーバはコマンドを実行しません。実行するのは担当者です。</p></div>'
    );
  }

  function tcMetaRows(session) {
    const remain = tcRemain(session);
    const consent =
      [
        session.consent && session.consent.screenShare ? '画面共有' : '',
        session.consent && session.consent.remoteControl ? '操作支援' : '',
      ]
        .filter(Boolean)
        .join('・') || '-';
    let html = '<dt>対象端末</dt><dd>' + esc(session.device || 'unknown') + '</dd>';
    html += '<dt>実行者</dt><dd>' + esc(session.operatorEmail || '-') + '</dd>';
    html += '<dt>開始</dt><dd>' + esc(fmtTs(session.startedAt)) + '</dd>';
    if (session.status === 'active') {
      html +=
        '<dt>残り</dt><dd><span id="hw-tc-remain" class="hw-tc-timer' +
        (remain != null && remain <= 0 ? ' bad' : '') +
        '">' +
        esc(tcRemainText(remain)) +
        '</span></dd>';
    } else {
      html += '<dt>終了</dt><dd>' + esc(fmtTs(session.closedAt)) + '</dd>';
      html +=
        '<dt>理由</dt><dd>' +
        esc(TC_CLOSE_REASON[session.closeReason] || session.closeReason || '-') +
        '</dd>';
    }
    html += '<dt>同意</dt><dd>' + esc(consent) + '</dd>';
    return html;
  }

  function tcProposeHTML() {
    const limits = tcLimits();
    const busy = Boolean(HW.tc.busy.propose);
    const full = HW.tc.steps.length >= limits.maxSteps;
    const expired = tcExpired();
    const disabled = busy || full || expired;
    const hint = full
      ? 'ステップ上限（' + limits.maxSteps + '件）に達しました。セッションを終了してください。'
      : expired
        ? '有効期限が切れています。セッションを終了してください。'
        : 'AIの提案は記録であり、実行するのは担当者です。内容を確認してからRSPで実行してください。';
    return (
      '<div class="hw-tc-form"><div class="hw-form-row"><label>目的（次に何を確認・実行するか）<textarea data-hw-field="intent" rows="2" maxlength="500" placeholder="例: 印刷スプーラが止まっている原因を確認したい">' +
      esc(HW.tc.intent) +
      '</textarea></label></div><div class="hw-form-row end"><button type="button" class="hw-btn pri" data-hw="tc-propose"' +
      (disabled ? ' disabled' : '') +
      '>' +
      (busy ? '提案を取得中…' : 'AIに次の一手を提案') +
      '</button></div><p class="hw-note">' +
      esc(hint) +
      '</p></div>'
    );
  }

  function tcCopyButton(step, kind) {
    const text =
      kind === 'executed'
        ? step.executed && step.executed.command
        : step.proposal && step.proposal.command;
    return (
      '<button type="button" class="hw-btn sm" data-hw="tc-copy" data-id="' +
      esc(step.id) +
      '" data-kind="' +
      kind +
      '"' +
      (text ? '' : ' disabled') +
      '>コピー</button>'
    );
  }

  function tcProposalHTML(step) {
    const proposal = step.proposal || {};
    const warnings = Array.isArray(proposal.warnings) ? proposal.warnings : [];
    return (
      '<div class="hw-tc-meta">' +
      (proposal.purpose ? '<div><b>目的:</b> ' + esc(proposal.purpose) + '</div>' : '') +
      (proposal.verify ? '<div><b>確認:</b> ' + esc(proposal.verify) + '</div>' : '') +
      (proposal.rollback ? '<div><b>戻し:</b> ' + esc(proposal.rollback) + '</div>' : '') +
      '</div>' +
      (warnings.length
        ? '<ul class="hw-tc-warn">' +
          warnings.map((warning) => '<li>' + esc(warning) + '</li>').join('') +
          '</ul>'
        : '')
    );
  }

  function tcExecutedHTML(step) {
    const executed = step.executed;
    const sha = executed.sha256 ? String(executed.sha256).slice(0, 12) : '';
    const exitClass =
      executed.exitStatus === 'success' ? 'ok' : executed.exitStatus === 'failure' ? 'bad' : 'warn';
    return (
      '<div class="hw-tc-divider"></div><div class="hw-tc-step-h"><span class="hw-tag display">実行記録</span><span class="hw-chip ' +
      exitClass +
      '">' +
      esc(TC_EXIT[executed.exitStatus] || '不明') +
      '</span><span class="hw-mono">' +
      esc(fmtTs(executed.recordedAt)) +
      '</span>' +
      (executed.outputSource === 'auto'
        ? '<span class="hw-chip info">自動取込</span>'
        : '<span class="hw-chip">手動貼付</span>') +
      (sha ? '<span class="hw-mono" title="sha256">' + esc(sha) + '…</span>' : '') +
      '</div><div class="hw-tc-cmd"><code>' +
      esc(executed.command || '') +
      '</code>' +
      tcCopyButton(step, 'executed') +
      '</div>' +
      (executed.output
        ? '<pre class="hw-tc-out">' + esc(executed.output) + '</pre>'
        : '<p class="hw-note">出力は記録されていません。</p>') +
      (executed.note
        ? '<div class="hw-tc-meta"><div><b>補足:</b> ' + esc(executed.note) + '</div></div>'
        : '')
    );
  }

  function tcRecordFormHTML(step, draft, limits, busy) {
    const id = esc(step.id);
    const attrs = (field) =>
      ' data-hw-field="step" data-step-id="' + id + '" data-field="' + field + '"';
    return (
      '<div class="hw-tc-divider"></div><div class="hw-form-row"><label>実行したコマンド（提案から編集できます）<textarea' +
      attrs('command') +
      ' rows="2" maxlength="' +
      limits.maxCommandChars +
      '">' +
      esc(draft.command) +
      '</textarea></label></div><div class="hw-form-row"><label>出力（手動で貼り付け）<textarea' +
      attrs('output') +
      ' rows="3" maxlength="' +
      limits.maxOutputChars +
      '" placeholder="RSPのターミナルからコピーして貼り付けてください">' +
      esc(draft.output) +
      '</textarea></label></div><div class="hw-form-row two"><label>判定<select' +
      attrs('exitStatus') +
      '><option value="success"' +
      (draft.exitStatus === 'success' ? ' selected' : '') +
      '>成功</option><option value="failure"' +
      (draft.exitStatus === 'failure' ? ' selected' : '') +
      '>失敗</option><option value="unknown"' +
      (draft.exitStatus === 'unknown' ? ' selected' : '') +
      '>不明</option></select></label><label>補足<input type="text"' +
      attrs('note') +
      ' maxlength="' +
      limits.maxNoteChars +
      '" value="' +
      esc(draft.note) +
      '"></label></div><div class="hw-form-row end"><button type="button" class="hw-btn" data-hw="tc-cancel-record"' +
      (busy ? ' disabled' : '') +
      '>閉じる</button><button type="button" class="hw-btn pri" data-hw="tc-record" data-id="' +
      id +
      '"' +
      (busy ? ' disabled' : '') +
      '>' +
      (busy ? '保存中…' : '記録を保存') +
      '</button></div><p class="hw-note">記録は1ステップ1回だけです。保存後に再送はできません。</p>'
    );
  }

  function tcStepHTML(step) {
    const executed = step.executed;
    const open = HW.tc.openStep === step.id;
    const draft = tcDraftOf(step);
    const limits = tcLimits();
    const busy = Boolean(HW.tc.busy['record:' + step.id]);
    const exitClass = executed
      ? executed.exitStatus === 'success'
        ? 'ok'
        : executed.exitStatus === 'failure'
          ? 'bad'
          : 'warn'
      : '';
    return (
      '<div class="hw-tc-step ' +
      (executed ? 'recorded' : 'pending') +
      '"><div class="hw-tc-step-h"><b>#' +
      esc(String(step.seq)) +
      '</b>' +
      (executed
        ? '<span class="hw-chip ok">記録済み</span><span class="hw-chip ' +
          exitClass +
          '">' +
          esc(TC_EXIT[executed.exitStatus] || '不明') +
          '</span>'
        : '<span class="hw-chip warn">提案のみ</span>') +
      '<span class="hw-mono">' +
      esc(fmtTs(step.proposedAt)) +
      '</span></div>' +
      (step.intent
        ? '<div class="hw-tc-meta"><div><b>目的:</b> ' + esc(step.intent) + '</div></div>'
        : '') +
      '<div class="hw-tc-cmd"><code>' +
      esc(step.proposal && step.proposal.command ? step.proposal.command : '（提案なし）') +
      '</code>' +
      tcCopyButton(step, 'proposal') +
      '</div>' +
      '<div class="hw-tc-meta"><span class="hw-chip ' +
      (step.proposal && step.proposal.risk === 'high'
        ? 'bad'
        : step.proposal && step.proposal.risk === 'medium'
          ? 'warn'
          : 'ok') +
      '">リスク ' +
      esc(TC_RISK[step.proposal && step.proposal.risk] || '不明') +
      '</span></div>' +
      tcProposalHTML(step) +
      (executed
        ? tcExecutedHTML(step)
        : open
          ? tcRecordFormHTML(step, draft, limits, busy)
          : '<div class="hw-form-row end"><button type="button" class="hw-btn sm" data-hw="tc-open-record" data-id="' +
            esc(step.id) +
            '">実行を記録</button></div>') +
      '</div>'
    );
  }

  function tcCloseHTML() {
    const busy = Boolean(HW.tc.busy.close);
    return (
      '<div class="hw-tc-form"><div class="hw-form-row"><label>終了理由の補足（任意）<input type="text" data-hw-field="close-note" maxlength="1000" value="' +
      esc(HW.tc.closeNote) +
      '"></label></div><div class="hw-form-row end"><button type="button" class="hw-btn" data-hw="tc-close" data-reason="stopped"' +
      (busy ? ' disabled' : '') +
      '>中止</button><button type="button" class="hw-btn pri" data-hw="tc-close" data-reason="resolved"' +
      (busy ? ' disabled' : '') +
      '>' +
      (busy ? '終了しています…' : '解決として終了') +
      '</button></div></div>'
    );
  }

  function tcDoneHTML() {
    const session = HW.tc.session;
    const resolved = session.closeReason === 'resolved';
    const reportBusy = Boolean(HW.tc.busy.report);
    const kbBusy = Boolean(HW.tc.busy.knowledge);
    // 再読み込み後も kbNo を出せるよう、セッション DTO の knowledge（§4）も見る。
    const knowledge =
      HW.tc.knowledge ||
      (session.knowledge
        ? {
            id: session.knowledge.id,
            kbNo: session.knowledge.kbNo,
            status: session.knowledge.status,
          }
        : null);
    const kbId = (knowledge && knowledge.id) || session.knowledgeId || '';
    const kbNo = knowledge && knowledge.kbNo ? String(knowledge.kbNo) : '';
    const reportId =
      (HW.tc.report && HW.tc.report.id) || (session.report ? session.report.id : null) || null;
    const reportSha =
      (HW.tc.report && HW.tc.report.sha256) ||
      (session.report ? session.report.sha256 : null) ||
      null;
    const reportWarnings =
      HW.tc.report && Array.isArray(HW.tc.report.warnings) ? HW.tc.report.warnings : [];
    return (
      '<div class="hw-tc-form">' +
      (reportId || reportSha
        ? '<div class="hw-alert info"><b>報告書を作成済みです。</b>' +
          (reportSha
            ? '<div class="hw-tc-meta">sha256: <span class="hw-mono">' +
              esc(String(reportSha).slice(0, 16)) +
              '…</span></div>'
            : '') +
          (reportWarnings.length
            ? '<ul class="hw-tc-warn">' +
              reportWarnings.map((warning) => '<li>' + esc(warning) + '</li>').join('') +
              '</ul>'
            : '') +
          '</div>'
        : '') +
      (kbId
        ? '<div class="hw-alert info"><b>ナレッジ下書き</b> <span class="hw-chip warn">承認待ち（下書き）</span><div class="hw-tc-meta">' +
          (kbNo ? 'kbNo: <span class="hw-mono">' + esc(kbNo) + '</span>' : 'ID: ' + esc(kbId)) +
          '</div><div class="hw-tc-meta">公開は承認者のレビュー後です（自動公開しません）。</div></div>'
        : '') +
      (resolved
        ? ''
        : '<p class="hw-note">報告書は「解決として終了」したセッションからのみ作成できます。</p>') +
      '<div class="hw-tc-actions"><button type="button" class="hw-btn pri" data-hw="tc-report"' +
      (resolved && !reportId && !reportBusy ? '' : ' disabled') +
      '>' +
      (reportBusy ? '作成中…' : reportId ? '報告書作成済み' : '報告書を作成') +
      '</button>' +
      (reportId
        ? '<button type="button" class="hw-btn" data-hw="tc-open-report">報告書を開く</button>'
        : '') +
      '<button type="button" class="hw-btn" data-hw="tc-knowledge"' +
      (kbId || kbBusy ? ' disabled' : '') +
      '>' +
      (kbBusy ? '作成中…' : kbId ? '下書き作成済み' : 'ナレッジ下書きを作成') +
      '</button></div></div>'
    );
  }

  function tcHTML(t) {
    if (!t) return '<div class="hw-empty sm">案件を選択してください。</div>';
    const tc = HW.tc;
    if (tc.loading && !tc.loaded) {
      return '<div class="hw-tc-body"><p class="hw-empty sm">実行セッションを確認しています…</p></div>';
    }
    if (tc.loaded && tc.error && !tc.session) {
      return (
        '<div class="hw-tc-body"><div class="hw-alert bad">' +
        esc(tc.error) +
        '</div><div class="hw-tc-actions"><button type="button" class="hw-btn sm" data-hw="tc-reload">再読み込み</button></div></div>'
      );
    }
    const session = tc.session;
    if (!session) {
      return (
        '<div class="hw-tc-body">' +
        (tc.error ? '<div class="hw-alert bad">' + esc(tc.error) + '</div>' : '') +
        '<p class="hw-note">この案件の実行セッションはまだありません。同意のうえ開始してください。</p>' +
        '<p class="hw-note">出力は手動で貼り付けます（自動取込の対応状況はセッション開始後に確認できます）。</p>' +
        tcStartHTML() +
        '</div>'
      );
    }
    return (
      '<div class="hw-tc-body">' +
      (tc.error ? '<div class="hw-alert bad">' + esc(tc.error) + '</div>' : '') +
      '<dl class="hw-kv">' +
      tcMetaRows(session) +
      '</dl>' +
      tcCaptureHTML() +
      (session.status === 'active' ? tcProposeHTML() : '') +
      '<div class="hw-tc-divider"></div><div class="hw-tc-steps-h"><b>ステップ</b><span class="hw-mono">' +
      HW.tc.steps.length +
      ' / ' +
      tcLimits().maxSteps +
      '</span></div>' +
      (HW.tc.steps.length
        ? '<div class="hw-tc-steps">' + HW.tc.steps.map(tcStepHTML).join('') + '</div>'
        : '<p class="hw-empty sm">まだステップはありません。目的を入力してAIに提案させてください。</p>') +
      '<div class="hw-tc-divider"></div>' +
      (session.status === 'active' ? tcCloseHTML() : tcDoneHTML()) +
      '</div>'
    );
  }

  async function tcStart(t) {
    if (!HW.tc.consent.remoteControl) {
      hwToast('操作支援（ターミナル操作）への同意が必要です。', 'bad');
      return;
    }
    const payload = {
      caseId: caseIdOf(t),
      consent: { screenShare: Boolean(HW.tc.consent.screenShare), remoteControl: true },
      ttlMinutes: TC_TTL_MINUTES,
    };
    const data = await tcApply('start', async () => {
      const res = await tcSend('/api/terminal/sessions', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      if (res.data) tcApplyPayload(res.data);
      return res;
    });
    if (data) hwToast('RSP実行セッションを開始しました。', 'ok');
  }

  async function tcPropose() {
    const session = HW.tc.session;
    if (!session || session.status !== 'active') return;
    const intent = String(HW.tc.intent || '').trim();
    if (!intent) {
      hwToast('目的を入力してください。', 'bad');
      return;
    }
    if (tcExpired()) {
      hwToast('有効期限が切れています。セッションを終了してください。', 'bad');
      return;
    }
    if (HW.tc.steps.length >= tcLimits().maxSteps) {
      hwToast('ステップの上限に達しました。', 'bad');
      return;
    }
    const payload = { intent };
    const lastOutput = tcLastOutput();
    if (lastOutput) payload.lastOutput = lastOutput;
    const data = await tcApply('propose', async () => {
      const res = await tcSend(
        '/api/terminal/sessions/' + encodeURIComponent(session.id) + '/steps',
        { method: 'POST', body: JSON.stringify(payload) },
      );
      if (res.data && res.data.step) {
        tcSetStep(res.data.step);
        HW.tc.intent = '';
        HW.tc.openStep = res.data.step.id;
      }
      return res;
    });
    if (data) {
      // SM-06: AI の辞退（提案なし＋理由）と、提案成功を区別して表示する。
      if (data.declined) {
        hwToast('AIは提案を見送りました：' + String(data.reason || ''), 'bad');
      } else {
        hwToast('AIが次の一手を提案しました。内容を確認してから実行してください。', 'ok');
      }
    }
  }

  async function tcRecord(step) {
    const draft = tcDraftOf(step);
    const command = String(draft.command || '').trim();
    if (!command) {
      hwToast('実行したコマンドを入力してください。', 'bad');
      return;
    }
    const payload = {
      command,
      output: String(draft.output || ''),
      outputSource: 'manual',
      exitStatus: draft.exitStatus || 'unknown',
    };
    const note = String(draft.note || '').trim();
    if (note) payload.note = note;
    const data = await tcApply('record:' + step.id, async () => {
      const res = await tcSend('/api/terminal/steps/' + encodeURIComponent(step.id) + '/record', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      if (res.data) tcApplyPayload(res.data);
      return res;
    });
    if (data) hwToast('実行記録を保存しました。', 'ok');
  }

  async function tcClose(reason) {
    const session = HW.tc.session;
    if (!session || session.status !== 'active') return;
    if (reason !== 'resolved' && reason !== 'stopped') return;
    const payload = { reason };
    const note = String(HW.tc.closeNote || '').trim();
    if (note) payload.note = note;
    const data = await tcApply('close', async () => {
      const res = await tcSend(
        '/api/terminal/sessions/' + encodeURIComponent(session.id) + '/close',
        { method: 'POST', body: JSON.stringify(payload) },
      );
      if (res.data && res.data.session) tcSetSession(res.data.session);
      return res;
    });
    if (data) {
      hwToast(
        reason === 'resolved'
          ? '解決として終了しました。報告書とナレッジ下書きを作成できます。'
          : 'セッションを中止しました。',
        'ok',
      );
      // SM-07: 実行記録が無いまま終了した場合は、報告書が作れないことを警告する。
      const warnings = Array.isArray(data.warnings)
        ? data.warnings.map((item) => String(item))
        : [];
      if (warnings.length > 0) hwToast(warnings[0], 'bad');
    }
  }

  async function tcReport() {
    const session = HW.tc.session;
    if (!session || session.status !== 'closed') return;
    if (session.closeReason !== 'resolved') {
      hwToast('報告書は「解決として終了」したセッションからのみ作成できます。', 'bad');
      return;
    }
    // ポップアップブロックを避けるため、クリックと同じ同期処理でタブを開いておく。
    let win = null;
    try {
      win = window.open('', '_blank');
    } catch {
      win = null;
    }
    const data = await tcApply('report', async () => {
      const built = await tcSend(
        '/api/terminal/sessions/' + encodeURIComponent(session.id) + '/report',
        { method: 'POST', body: '{}' },
      );
      if (!built.data) return built;
      const warnings = Array.isArray(built.data.warnings)
        ? built.data.warnings.map((item) => String(item))
        : [];
      // §4-6: サーバが保存まで行い、files.html.url を返す。UI はその URL を開くだけ
      // （/api/reports/final へ再送しない。二重作成させない）。
      const saved = built.data.report;
      const htmlFile = saved && saved.files ? saved.files.html : null;
      // inline 表示（previewUrl）を優先する。url はダウンロード用（Content-Disposition: attachment）。
      const baseUrl = htmlFile ? String(htmlFile.url || '') : '';
      const previewUrl = htmlFile ? String(htmlFile.previewUrl || '') : '';
      const url = previewUrl
        ? previewUrl
        : baseUrl
          ? baseUrl + (baseUrl.indexOf('?') >= 0 ? '&' : '?') + 'inline=1'
          : '';
      if (!saved || !url) {
        return {
          data: null,
          status: built.status,
          code: '',
          message: '報告書のHTML URLを取得できませんでした。',
        };
      }
      HW.tc.report = {
        id: saved.id || null,
        sha256: saved.sha256 || null,
        url,
        warnings,
      };
      if (HW.tc.session) {
        HW.tc.session.report = {
          id: HW.tc.report.id,
          sha256: HW.tc.report.sha256,
        };
      }
      if (win) {
        try {
          win.location.replace(url);
        } catch {
          win = null;
        }
      }
      return { data: { report: HW.tc.report }, status: 200, code: '', message: null };
    });
    if (data) {
      hwToast('報告書を作成しました。', 'ok');
      if (!win)
        hwToast('ポップアップがブロックされた場合は「報告書を開く」から開いてください。', 'bad');
    } else if (win) {
      win.close();
    }
  }

  async function tcKnowledge() {
    const session = HW.tc.session;
    if (!session || session.status !== 'closed') return;
    const data = await tcApply('knowledge', async () => {
      const res = await tcSend(
        '/api/terminal/sessions/' + encodeURIComponent(session.id) + '/knowledge-draft',
        { method: 'POST', body: '{}' },
      );
      if (res.data && res.data.knowledge) {
        HW.tc.knowledge = res.data.knowledge;
        if (HW.tc.session) HW.tc.session.knowledgeId = res.data.knowledge.id || null;
      }
      return res;
    });
    if (data) hwToast('ナレッジ下書きを作成しました（承認待ち）。', 'ok');
  }

  function tcOpenReport() {
    const id =
      (HW.tc.report && HW.tc.report.id) ||
      (HW.tc.session && HW.tc.session.report ? HW.tc.session.report.id : null);
    const stored = HW.tc.report && HW.tc.report.url ? String(HW.tc.report.url) : '';
    if (!id && !stored) {
      hwToast('報告書がまだありません。', 'bad');
      return;
    }
    const url = stored || '/api/reports/final/' + encodeURIComponent(id) + '/html?inline=1';
    window.open(url, '_blank', 'noopener');
  }

  function tcCopy(stepId, kind) {
    const step = HW.tc.steps.find((item) => item.id === stepId);
    if (!step) return;
    const text =
      kind === 'executed'
        ? (step.executed && step.executed.command) || ''
        : (step.proposal && step.proposal.command) || '';
    if (!text) {
      hwToast('コピーするコマンドがありません。', 'bad');
      return;
    }
    void copyText(text, 'コマンド');
  }

  function tcReload() {
    const t = current();
    if (!t) return;
    const key = caseIdOf(t);
    HW.tc.key = key;
    HW.tc.session = null;
    HW.tc.steps = [];
    HW.tc.error = null;
    HW.tc.loaded = false;
    HW.tc.loading = true;
    renderEv();
    if (key) void tcLoad(key);
  }

  function caseHTML(t) {
    if (!t) {
      return '<div class="hw-empty lg"><b>案件が選択されていません</b><br>左の引継ぎボードから案件を選んでください。</div>';
    }
    const cw = cowork(t);
    const kids = childrenOf(t);
    return (
      '<div class="hw-chead"><div class="hw-chead-top"><span class="hw-dot hw-dot-' +
      signal(t) +
      '"></span>' +
      prioChip(t) +
      '<h1>' +
      esc(t.subject) +
      '</h1>' +
      statusChip(t) +
      '</div><div class="hw-cmeta"><span><i>案件</i>' +
      esc(t.id) +
      '</span><span><i>依頼者</i>' +
      esc(t.requester || '-') +
      '</span><span><i>受付</i>' +
      esc(t.channel || '-') +
      '</span><span><i>期限</i>' +
      esc(fmtFull(dueAt(t))) +
      '</span><span><i>担当</i>' +
      esc(t.assignee || '未割当') +
      '</span></div></div><div class="hw-cbody">' +
      (t.sec
        ? '<div class="hw-alert bad"><b>セキュリティ事象</b> — 証拠の保全と影響範囲の確認を優先してください。</div>'
        : '') +
      (t.coworkTicket
        ? '<div class="hw-alert info"><b>みらいAI窓口（' +
          esc(t.coworkTicket) +
          '）から引き継がれた案件です。</b> 本人が共有に同意した情報だけを表示しています。</div>'
        : '') +
      actionHTML(t, kids) +
      aiHTML(t) +
      '<section class="hw-sec"><h3>AIによる引継ぎメモ <span class="hw-tag display">表示</span></h3><pre class="hw-memo">' +
      esc((t.handover && t.handover.summary) || '（引継ぎメモはありません）') +
      '</pre></section><section class="hw-sec"><h3>問い合わせ内容 <span class="hw-tag display">表示</span></h3><div class="hw-body">' +
      esc(t.body || '') +
      '</div></section><section class="hw-sec"><h3>' +
      (cw ? 'AI相談の会話（共有範囲）' : 'AI一次対応の記録') +
      ' <span class="hw-tag display">表示</span></h3>' +
      (cw ? chatHTML(cw) : aiLogHTML(t)) +
      '</section><section class="hw-sec"><h3>対応タイムライン <span class="hw-tag display">表示</span></h3>' +
      historyHTML(t) +
      '</section><div class="hw-endnote">担当開始・解決記録は既存の「③ 引継ぎ・④ 解決記録」と同じ処理を呼び出します。画面を閉じても既存の操作は変わりません。</div></div>'
    );
  }

  function evHTML(t) {
    if (!t)
      return '<div class="hw-empty">案件を選択すると、案件情報・共有情報・記録を表示します。</div>';
    const cw = cowork(t);
    return (
      '<div class="hw-ev-card"><h3>案件情報</h3><dl class="hw-kv"><dt>案件</dt><dd class="hw-mono">' +
      esc(t.id) +
      '</dd><dt>状態</dt><dd>' +
      esc(STATUS[t.status] || t.status) +
      '</dd><dt>優先度</dt><dd>' +
      esc(t.priority || '-') +
      '</dd><dt>受付</dt><dd>' +
      esc(fmtFull(t.createdAt)) +
      '</dd><dt>期限</dt><dd>' +
      esc(fmtFull(dueAt(t))) +
      '</dd><dt>担当</dt><dd>' +
      esc(t.assignee || '未割当') +
      '</dd><dt>分野</dt><dd>' +
      esc(CATEGORY[t.cat] || t.cat || '-') +
      '</dd></dl></div>' +
      '<div class="hw-ev-card hw-tc" id="hw-tc-card"><h3>RSP実行セッション ' +
      tcStatusChip() +
      '</h3>' +
      tcHTML(t) +
      '</div>' +
      '<div class="hw-ev-card"><h3>端末・共有情報 <span class="hw-chip info">本人同意</span></h3>' +
      sharedHTML(t) +
      '</div>' +
      (cw && cw.proposals.length
        ? '<div class="hw-ev-card"><h3>AI操作の承認記録</h3>' + proposalsHTML(cw) + '</div>'
        : '') +
      '<div class="hw-ev-card"><h3>関連ナレッジ</h3>' +
      (relatedKbs(t).length
        ? '<div class="hw-kb-list">' +
          relatedKbs(t)
            .map(
              (kb) =>
                '<div class="hw-kb"><div><b class="hw-mono">' +
                esc(kb.id) +
                '</b> ' +
                esc(kb.title) +
                '</div><div class="hw-kb-meta">' +
                (kb.failed ? '<span class="hw-chip bad">利用者が試して解決せず</span>' : '') +
                (kb.status === 'archived' ? '<span class="hw-chip">使用停止</span>' : '') +
                '<button type="button" class="hw-btn sm ghost" data-hw="kb" data-id="' +
                esc(kb.id) +
                '">開く</button></div></div>',
            )
            .join('') +
          '</div>'
        : '<p class="hw-empty sm">関連ナレッジはありません。</p>') +
      '</div><div class="hw-ev-card"><h3>ナレッジ下書き</h3>' +
      draftHTML(t) +
      '</div><div class="hw-ev-card"><h3>操作の記録</h3>' +
      auditHTML(t) +
      '</div><div class="hw-ev-card"><h3>開く</h3><div class="hw-actions"><button type="button" class="hw-btn sm" data-hw="legacy">既存の画面で開く</button>' +
      (t.coworkTicket
        ? '<button type="button" class="hw-btn sm" data-hw="cowork">利用者の受付番号</button>'
        : '') +
      '</div></div>'
    );
  }

  function updateHead(t) {
    const sub = $('#hw-sub');
    if (sub) sub.textContent = t ? t.id + ' ／ ' + t.subject : '案件を選択してください';
  }

  function renderAll() {
    ensureSelected();
    const t = current();
    renderList();
    ensureTerminal(t);
    const caseEl = $('#hw-case');
    if (caseEl) {
      caseEl.innerHTML = caseHTML(t);
      const caseBody = caseEl.querySelector('.hw-cbody');
      if (caseBody) caseBody.scrollTop = HW.scrollTop || 0;
    }
    const ev = $('#hw-ev');
    if (ev) ev.innerHTML = evHTML(t);
    updateHead(t);
  }

  /* ============================ 操作（既存処理の呼び出し） ============================ */

  function hwToast(message, kind) {
    const wrap = $('#hw-toasts');
    if (!wrap) return;
    const toast = document.createElement('div');
    toast.className = 'hw-toast' + (kind ? ' ' + kind : '');
    toast.textContent = message;
    wrap.appendChild(toast);
    setTimeout(() => {
      toast.remove();
    }, 3800);
  }

  /** 既存処理が読む入力を、画面の先頭に一時的に置いてから呼ぶ（二重実装しない）。 */
  async function copyText(text, label) {
    const name = label || 'プロンプト';
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(text);
        hwToast(name + 'をコピーしました。', 'ok');
        return;
      }
    } catch {
      // fall through
    }
    const area = document.createElement('textarea');
    area.value = text;
    area.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand('copy');
      hwToast(name + 'をコピーしました。', 'ok');
    } catch {
      hwToast('コピーできませんでした。表示欄を選択してコピーしてください。', 'bad');
    } finally {
      area.remove();
    }
  }

  function copyPrompt(button) {
    const qa = button.closest('.hw-ai-qa');
    if (!qa) return;
    const areas = Array.from(qa.querySelectorAll('.hw-ai-prompt textarea'));
    if (!areas.length) return;
    const text = areas
      .map((area, index) => (index === 0 ? 'SYSTEM' : 'USER') + ':\n' + area.value)
      .join('\n\n---\n\n');
    void copyText(text);
  }

  function withTempInputs(html, values, fn) {
    const host = document.createElement('div');
    host.className = 'hw-temp-inputs';
    host.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;';
    host.innerHTML = html;
    document.body.insertBefore(host, document.body.firstChild);
    Object.keys(values || {}).forEach((id) => {
      const input = host.querySelector('#' + id);
      if (!input) return;
      const value = values[id];
      if (input.type === 'checkbox') input.checked = Boolean(value);
      else input.value = String(value == null ? '' : value);
    });
    try {
      return fn();
    } finally {
      host.remove();
    }
  }

  function startWork(t) {
    if (!canWork()) {
      hwToast('承認者・監査担当は担当開始を登録できません');
      return;
    }
    const name = $('#hw-assignee') ? $('#hw-assignee').value : '';
    if (!name) {
      hwToast('担当者を選んでください');
      return;
    }
    if (!window.App || typeof window.App.startWork !== 'function') {
      hwToast('既存の担当開始処理が見つかりません');
      return;
    }
    try {
      withTempInputs(
        '<select id="q_as"><option value="' + esc(name) + '">' + esc(name) + '</option></select>',
        {},
        () => window.App.startWork(t.id),
      );
      hwToast('担当を開始しました。');
      setTimeout(() => {
        HW.scrollTop = 0;
        renderAll();
      }, 160);
    } catch (error) {
      hwToast(
        '担当開始に失敗しました：' +
          String(error && error.message ? error.message : error).slice(0, 100),
      );
    }
  }

  function resolveCase(t) {
    if (!canWork()) {
      hwToast('承認者・監査担当は解決記録を登録できません');
      return;
    }
    const cause = $('#hw-cause') ? $('#hw-cause').value.trim() : '';
    const steps = $('#hw-steps')
      ? $('#hw-steps')
          .value.split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
      : [];
    if (!cause || !steps.length) {
      hwToast('原因と対応手順を入力してください');
      return;
    }
    if (!window.App || typeof window.App.resolve !== 'function') {
      hwToast('既存の解決記録処理が見つかりません');
      return;
    }
    const withKb = $('#hw-kb') ? $('#hw-kb').checked : false;
    const withChild = $('#hw-child') ? $('#hw-child').checked : false;
    const html =
      '<textarea id="r_cause"></textarea><textarea id="r_steps"></textarea><input id="r_min"><input id="r_note"><input type="checkbox" id="r_kb"><input type="checkbox" id="r_child">';
    try {
      withTempInputs(
        html,
        {
          r_cause: cause,
          r_steps: steps.join('\n'),
          r_min: $('#hw-min') ? $('#hw-min').value : '0',
          r_note: $('#hw-note') ? $('#hw-note').value : '',
          r_kb: withKb,
          r_child: withChild,
        },
        () => window.App.resolve(t.id),
      );
      if (withKb) {
        hwToast('解決を記録し、ナレッジ下書きを作成しました。');
        setTimeout(close, 350);
      } else {
        hwToast('解決を記録しました。');
        setTimeout(() => {
          HW.scrollTop = 0;
          renderAll();
        }, 180);
      }
    } catch (error) {
      hwToast(
        '解決記録に失敗しました：' +
          String(error && error.message ? error.message : error).slice(0, 100),
      );
    }
  }

  function fillExample(t) {
    if (!canWork()) return;
    if (!window.App || typeof window.App.fillResolution !== 'function') return;
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;';
    host.innerHTML = '<textarea id="r_cause"></textarea><textarea id="r_steps"></textarea>';
    document.body.insertBefore(host, document.body.firstChild);
    try {
      window.App.fillResolution(t.id);
      const cause = host.querySelector('#r_cause').value;
      const steps = host.querySelector('#r_steps').value;
      if ($('#hw-cause')) $('#hw-cause').value = cause;
      if ($('#hw-steps')) $('#hw-steps').value = steps;
      hwToast('記入例を入れました。内容を確認してから記録してください。');
    } finally {
      host.remove();
    }
  }

  async function claimHandover(id, button) {
    if (!canWork()) {
      hwToast('承認者・監査担当は引継ぎを引き受けられません');
      return;
    }
    if (button) button.disabled = true;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const response = await fetch('/api/case-handovers/' + encodeURIComponent(id) + '/claim', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        const data = await response.json().catch(() => null);
        if (response.ok) {
          hwToast('引き受けました。画面を読み直します。', 'ok');
          setTimeout(() => location.reload(), 600);
          return;
        }
        const code = data && data.error ? data.error.code : '';
        if (code === 'STATE_NOT_READY' && attempt < 3) {
          hwToast('保存を待って、もう一度試します。');
          await new Promise((resolve) => setTimeout(resolve, 1500));
          continue;
        }
        throw new Error(data && data.error ? data.error.message : 'HTTP ' + response.status);
      } catch (error) {
        hwToast(
          '引き受けに失敗しました：' +
            String(error && error.message ? error.message : error).slice(0, 110),
        );
        if (button) button.disabled = false;
        return;
      }
    }
  }

  async function loadInbox(force) {
    if (HW.inboxLoading) return;
    if (!force && HW.inboxState === 'done') return;
    HW.inboxLoading = true;
    HW.inboxState = 'loading';
    renderList();
    try {
      const response = await fetch('/api/case-handovers/inbox');
      if (response.status === 403) {
        HW.inbox = [];
        HW.inboxState = 'done';
        return;
      }
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const data = await response.json();
      HW.inbox = Array.isArray(data.items) ? data.items : [];
      HW.inboxState = 'done';
    } catch {
      HW.inbox = [];
      HW.inboxState = 'error';
    } finally {
      HW.inboxLoading = false;
      if (HW.open) renderList();
    }
  }

  function openDraft(t) {
    if (!t || !t.draftId || !window.App || typeof window.App.go !== 'function') return;
    close();
    setTimeout(() => {
      window.App.go('draft', t.draftId);
    }, 60);
  }

  function openLegacy(t) {
    if (!t || !window.App || typeof window.App.go !== 'function') return;
    close();
    setTimeout(() => {
      window.App.go('queue', t.id);
    }, 60);
  }

  function openCowork(t) {
    if (!t || !t.coworkTicket) return;
    close();
    setTimeout(() => {
      try {
        if (typeof UX !== 'undefined' && UX && typeof UX.openTicket === 'function')
          UX.openTicket(t.coworkTicket);
        else hwToast('利用者の受付番号を開く処理が見つかりません');
      } catch {
        // ignore
      }
    }, 60);
  }

  function openKb(id) {
    if (!window.App || typeof window.App.openKb !== 'function') return;
    close();
    setTimeout(() => {
      window.App.openKb(id);
    }, 60);
  }

  /* ============================ 起動 / DOM ============================ */

  const style = document.createElement('style');
  style.id = 'ahd-hw-style';
  style.textContent = `
#ahd-hw{display:flex;flex-direction:column;background:var(--u-bg,#f4f3ee);color:var(--u-ink,#1b222b);font-family:var(--u-font,system-ui),sans-serif;font-size:13px;line-height:1.6;overflow:hidden}
#ahd-hw.hw-floating{position:fixed;inset:0;z-index:9000}
#ahd-hw.hw-embedded{position:relative;flex:1;min-width:0;min-height:0;z-index:auto}
.ux-content.ahd-hw-embedded>#uxPage,.ux-content.ahd-hw-embedded>#cw,.ux-content.ahd-hw-embedded>#hd{display:none!important}
#ahd-hw.hw-embedded .hw-top{height:42px;padding:0 10px;border-bottom-width:2px}
#ahd-hw.hw-embedded .hw-mark{display:none}
#ahd-hw.hw-embedded .hw-title{font-size:12.5px}
#ahd-hw.hw-embedded .hw-sub{max-width:50%}
#ahd-hw.hw-embedded .hw-close{display:none}
#ahd-hw.hw-embedded .hw-top-note{display:none}
#ahd-hw:focus{outline:none}
#ahd-hw.hw-embedded .hw-grid{padding:8px;gap:8px}
#ahd-hw.hw-embedded .hw-ev{padding:7px}
#ahd-hw[hidden]{display:none!important}
#ahd-hw *{box-sizing:border-box}
#ahd-hw .hw-top{flex:none;height:54px;display:flex;align-items:center;gap:9px;padding:0 14px;background:linear-gradient(180deg,#173352,#122a45);color:#fff;border-bottom:3px solid var(--u-safety,#f5b800)}
#ahd-hw .hw-mark{width:26px;height:26px;border-radius:7px;background:var(--u-safety,#f5b800);color:var(--u-navy,#16314f);display:grid;place-items:center;font-weight:800;font-size:12px}
#ahd-hw .hw-title{font-weight:700;font-size:13.5px;white-space:nowrap}
#ahd-hw .hw-sub{font-size:11px;color:#c7d4e2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:46vw}
#ahd-hw .hw-sp{flex:1}
#ahd-hw .hw-close{border:0;background:rgba(255,255,255,.12);color:#fff;width:30px;height:30px;border-radius:8px;font-size:19px;line-height:1;cursor:pointer}
#ahd-hw .hw-close:hover{background:rgba(255,255,255,.22)}
#ahd-hw .hw-top-note{flex:none;padding:5px 14px;background:var(--u-safety-soft,#fff5d3);color:var(--u-ink,#1b222b);font-size:10.5px;border-bottom:1px solid var(--u-line,#e1ddd2)}
#ahd-hw .hw-grid{flex:1;min-height:0;display:grid;grid-template-columns:296px minmax(0,1fr) 362px;gap:9px;padding:9px;overflow:hidden}
#ahd-hw .hw-pane{min-height:0;background:var(--u-surface,#fff);border:1px solid var(--u-line,#e1ddd2);border-radius:14px;display:flex;flex-direction:column;overflow:hidden}
#ahd-hw .hw-queue{background:var(--u-surface,#fff)}
#ahd-hw .hw-ph{flex:none;padding:11px 13px 7px}
#ahd-hw .hw-ph h2{margin:0;font-size:13px;font-weight:700}
#ahd-hw .hw-ph p{margin:2px 0 0;font-size:10.5px;color:var(--u-muted,#5f6874)}
#ahd-hw .hw-tools{flex:none;padding:0 11px 8px;display:flex;flex-direction:column;gap:6px}
#ahd-hw .hw-seg{display:flex;gap:2px;background:var(--u-surface2,#efede6);padding:3px;border-radius:8px}
#ahd-hw .hw-seg button{flex:1;border:0;background:transparent;color:var(--u-muted,#5f6874);font:600 10.2px var(--u-font,sans-serif);padding:4px 1px;border-radius:6px;cursor:pointer;white-space:nowrap}
#ahd-hw .hw-seg button b{font-size:9.6px;opacity:.8;margin-left:1px}
#ahd-hw .hw-seg button.on{background:var(--u-surface,#fff);color:var(--u-ink,#1b222b);box-shadow:0 1px 2px rgba(20,30,40,.08)}
#ahd-hw .hw-search{width:100%;height:29px;border:1px solid var(--u-line,#e1ddd2);background:var(--u-surface,#fff);border-radius:8px;padding:0 8px;font:11px var(--u-font,sans-serif);color:var(--u-ink,#1b222b)}
#ahd-hw .hw-search::placeholder{color:var(--u-muted,#5f6874)}
#ahd-hw .hw-list{flex:1;min-height:0;overflow:auto;padding:0 9px 9px;display:flex;flex-direction:column;gap:6px}
#ahd-hw .hw-foot{flex:none;padding:7px 11px;border-top:1px solid var(--u-line,#e1ddd2);font-size:9.5px;color:var(--u-muted,#5f6874);line-height:1.5;background:var(--u-surface2,#efede6)}
#ahd-hw .hw-card{position:relative;text-align:left;border:1px solid var(--u-line,#e1ddd2);background:var(--u-surface,#fff);border-radius:10px;padding:8px 9px 8px 13px;cursor:pointer;display:flex;flex-direction:column;gap:2px;overflow:hidden}
#ahd-hw .hw-card:hover{background:var(--u-surface2,#efede6)}
#ahd-hw .hw-card.on{border-color:var(--u-navy,#16314f);box-shadow:0 0 0 1px var(--u-navy,#16314f) inset}
#ahd-hw .hw-sig{position:absolute;left:0;top:0;bottom:0;width:4px}
#ahd-hw .hw-sig-red{background:var(--u-r,#c9302c)}
#ahd-hw .hw-sig-amber{background:var(--u-y,#e0a800)}
#ahd-hw .hw-sig-blue{background:var(--u-teal,#0f9d9a)}
#ahd-hw .hw-card-top{display:flex;align-items:center;justify-content:space-between;gap:6px;font-size:9.6px;color:var(--u-muted,#5f6874)}
#ahd-hw .hw-mono{font-family:"SFMono-Regular",Consolas,monospace;font-size:10px}
#ahd-hw .hw-sla{font-size:9.6px;color:var(--u-muted,#5f6874);white-space:nowrap}
#ahd-hw .hw-sla.bad{color:var(--u-r,#c9302c);font-weight:700}
#ahd-hw .hw-sla.ok{color:var(--u-g,#1f9d55)}
#ahd-hw .hw-card-subject{font-size:11.8px;font-weight:650;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
#ahd-hw .hw-card-meta{font-size:10px;color:var(--u-muted,#5f6874);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#ahd-hw .hw-card-chips{display:flex;gap:3px;flex-wrap:wrap;margin-top:2px}
#ahd-hw .hw-prio{display:inline-block;font-size:9.5px;font-weight:800;padding:0 5px;border-radius:4px;background:var(--u-surface2,#efede6);color:var(--u-ink,#1b222b);line-height:1.7;flex:none}
#ahd-hw .hw-prio.p1{background:var(--u-r-soft,#fbe2e1)}
#ahd-hw .hw-prio.p2{background:var(--u-y-soft,#fdf2d2)}
#ahd-hw .hw-prio.p3{background:#e4ebf4}
#ahd-hw .hw-chip{display:inline-flex;align-items:center;font-size:9.4px;font-weight:650;padding:0 5px;border-radius:999px;background:var(--u-surface2,#efede6);color:var(--u-ink,#1b222b);white-space:nowrap}
#ahd-hw .hw-chip.ok{background:var(--u-g-soft,#e1f4e8)}
#ahd-hw .hw-chip.warn{background:var(--u-y-soft,#fdf2d2)}
#ahd-hw .hw-chip.bad{background:var(--u-r-soft,#fbe2e1)}
#ahd-hw .hw-chip.info{background:var(--u-teal-soft,#dcf3f1)}
#ahd-hw .hw-tag{display:inline-flex;align-items:center;font-size:8.6px;font-weight:800;line-height:1.7;padding:0 4px;border-radius:3px;border:1px solid transparent;letter-spacing:.03em;white-space:nowrap}
#ahd-hw .hw-tag.display{background:var(--u-surface2,#efede6);color:var(--u-muted,#5f6874);border-color:var(--u-line,#e1ddd2)}
#ahd-hw .hw-tag.input{background:var(--u-safety-soft,#fff5d3);color:var(--u-ink,#1b222b);border-color:var(--u-y,#e0a800)}
#ahd-hw .hw-ai-note{margin:0 0 7px;font-size:9.8px;color:var(--u-muted,#5f6874);line-height:1.55}
#ahd-hw .hw-ai-qa{margin-top:7px;border-top:1px dashed var(--u-line,#e1ddd2);padding-top:6px}
#ahd-hw .hw-ai-q{font-size:10.2px;font-weight:700;color:var(--u-ink,#1b222b);margin-bottom:3px}
#ahd-hw .hw-ai-answer{background:var(--u-surface,#fff);border:1px solid var(--u-line,#e1ddd2);border-left:3px solid var(--u-teal,#0f9d9a);border-radius:6px;padding:6px 8px;font-size:10.8px;line-height:1.65;white-space:pre-wrap;word-break:break-word}
#ahd-hw .hw-ai-answer.bad{border-left-color:var(--u-r,#c9302c);background:var(--u-r-soft,#fbe2e1)}
#ahd-hw .hw-ai-meta{display:flex;gap:3px;flex-wrap:wrap;margin-top:4px}
#ahd-hw .hw-ai-prompt{margin-top:7px;border-top:1px dashed var(--u-line,#e1ddd2);padding-top:5px}
#ahd-hw .hw-ai-prompt summary{cursor:pointer;font-size:9.6px;font-weight:700;color:var(--u-muted,#5f6874);display:flex;gap:4px;align-items:center}
#ahd-hw .hw-ai-prompt-actions{display:flex;justify-content:flex-end;margin:4px 0}
#ahd-hw .hw-ai-prompt label{display:block;font-size:9.4px;font-weight:700;color:var(--u-muted,#5f6874);margin-top:5px}
#ahd-hw .hw-ai-prompt textarea{width:100%;border:1px solid var(--u-line,#e1ddd2);border-radius:6px;background:var(--u-surface,#fff);color:var(--u-ink,#1b222b);font:9.8px/1.5 var(--mono,monospace);padding:5px 6px;resize:vertical;margin-top:2px}
#ahd-hw .hw-inbox{border:1px solid var(--u-y,#e0a800);background:var(--u-safety-soft,#fff5d3);border-radius:9px;padding:7px;margin-bottom:2px}
#ahd-hw .hw-inbox-h{display:flex;justify-content:space-between;font-size:10.2px;font-weight:700}
#ahd-hw .hw-inbox-h span{background:var(--u-surface,#fff);border-radius:999px;padding:0 6px}
#ahd-hw .hw-inbox-item{display:flex;gap:6px;justify-content:space-between;align-items:flex-start;padding:5px 0;border-top:1px dashed var(--u-line,#e1ddd2)}
#ahd-hw .hw-inbox-main{min-width:0}
#ahd-hw .hw-inbox-main b{display:block;font-size:10.6px;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#ahd-hw .hw-inbox-main small{display:block;font-size:9.4px;color:var(--u-muted,#5f6874);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#ahd-hw .hw-empty{padding:18px 10px;text-align:center;color:var(--u-muted,#5f6874);font-size:10.5px;line-height:1.7}
#ahd-hw .hw-empty.sm{padding:8px 4px;font-size:10px}
#ahd-hw .hw-empty.lg{padding:60px 20px;font-size:12px}
#ahd-hw .hw-case{background:var(--u-bg,#f4f3ee)}
#ahd-hw .hw-chead{flex:none;padding:11px 15px 9px;background:var(--u-surface,#fff);border-bottom:1px solid var(--u-line,#e1ddd2)}
#ahd-hw .hw-chead-top{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
#ahd-hw .hw-dot{width:9px;height:9px;border-radius:50%;flex:none}
#ahd-hw .hw-dot-red{background:var(--u-r,#c9302c)}
#ahd-hw .hw-dot-amber{background:var(--u-y,#e0a800)}
#ahd-hw .hw-dot-blue{background:var(--u-teal,#0f9d9a)}
#ahd-hw .hw-chead h1{margin:0;font-size:16px;line-height:1.35;flex:1;min-width:180px}
#ahd-hw .hw-cmeta{display:flex;flex-wrap:wrap;gap:3px 14px;margin-top:5px;font-size:10.8px;color:var(--u-muted,#5f6874)}
#ahd-hw .hw-cmeta i{font-style:normal;font-size:9.5px;margin-right:4px;opacity:.85}
#ahd-hw .hw-cbody{flex:1;min-height:0;overflow:auto;padding:12px 15px 18px;scrollbar-gutter:stable}
#ahd-hw .hw-alert{border-left:3px solid var(--u-teal,#0f9d9a);background:var(--u-teal-soft,#dcf3f1);padding:7px 9px;border-radius:7px;font-size:10.8px;line-height:1.6;margin-bottom:8px}
#ahd-hw .hw-alert.bad{border-color:var(--u-r,#c9302c);background:var(--u-r-soft,#fbe2e1)}
#ahd-hw .hw-alert.info{border-color:var(--u-navy,#16314f);background:#e4ebf4}
#ahd-hw .hw-action{border:1px solid var(--u-line,#e1ddd2);background:var(--u-surface2,#efede6);border-radius:10px;padding:9px 11px;margin-bottom:10px}
#ahd-hw .hw-action.ok{border-color:#a9d9bd;background:var(--u-g-soft,#e1f4e8)}
#ahd-hw .hw-action.readonly{background:var(--u-surface2,#efede6)}
#ahd-hw .hw-action-h{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11.6px;margin-bottom:6px}
#ahd-hw .hw-form-row{display:flex;gap:7px;align-items:flex-end;margin-bottom:7px;flex-wrap:wrap}
#ahd-hw .hw-form-row.two label{flex:1 1 120px}
#ahd-hw .hw-form-row.end{justify-content:flex-end;margin-bottom:0}
#ahd-hw .hw-form-row label{display:flex;flex-direction:column;gap:2px;font-size:9.8px;font-weight:700;color:var(--u-muted,#5f6874);flex:1 1 100%}
#ahd-hw .hw-form-row.two label{flex:1 1 110px}
#ahd-hw .hw-form-row input,#ahd-hw .hw-form-row select,#ahd-hw .hw-form-row textarea{border:1.5px solid #b9b2a3;border-radius:7px;padding:5px 7px;font:11.2px var(--u-font,sans-serif);background:var(--u-surface,#fff);color:var(--u-ink,#1b222b);width:100%;box-shadow:inset 0 1px 2px rgba(20,30,40,.07)}
#ahd-hw .hw-form-row input:focus,#ahd-hw .hw-form-row select:focus,#ahd-hw .hw-form-row textarea:focus{border-color:var(--u-teal,#0f9d9a);box-shadow:0 0 0 2px rgba(15,157,154,.18);outline:none}
#ahd-hw .hw-form-row textarea{resize:vertical;line-height:1.5}
#ahd-hw .hw-form-row select{min-width:120px}
#ahd-hw .hw-check{display:flex;gap:6px;align-items:flex-start;font-size:10.2px;margin:4px 0;cursor:pointer}
#ahd-hw .hw-check input{margin-top:2px}
#ahd-hw .hw-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;border:1px solid var(--u-line,#e1ddd2);background:var(--u-surface,#fff);color:var(--u-ink,#1b222b);font:650 10.8px var(--u-font,sans-serif);padding:5px 9px;border-radius:7px;cursor:pointer;white-space:nowrap}
#ahd-hw .hw-btn:hover{background:var(--u-surface2,#efede6)}
#ahd-hw .hw-btn.pri{background:var(--u-navy,#16314f);border-color:var(--u-navy,#16314f);color:#fff}
#ahd-hw .hw-btn.pri:hover{background:#0f2440}
#ahd-hw .hw-btn.ok{background:var(--u-g,#1f9d55);border-color:var(--u-g,#1f9d55);color:#fff}
#ahd-hw .hw-btn.ghost{background:transparent;border-color:transparent;color:var(--u-muted,#5f6874)}
#ahd-hw .hw-btn.sm{font-size:9.8px;padding:3px 7px}
#ahd-hw .hw-btn[disabled]{opacity:.45;cursor:not-allowed}
#ahd-hw .hw-sec{margin-bottom:12px}
#ahd-hw .hw-sec h3{margin:0 0 4px;font-size:11px;letter-spacing:.02em;color:var(--u-muted,#5f6874)}
#ahd-hw .hw-memo{margin:0;padding:8px 10px;background:var(--u-surface,#fff);border-left:3px solid var(--u-y,#e0a800);border-radius:0 7px 7px 0;font:10.8px/1.65 var(--u-font,sans-serif);white-space:pre-wrap;word-break:break-word;color:var(--u-ink,#1b222b)}
#ahd-hw .hw-body{background:var(--u-surface,#fff);border:1px solid var(--u-line,#e1ddd2);border-radius:7px;padding:8px 10px;font-size:11.4px;white-space:pre-wrap;line-height:1.65}
#ahd-hw .hw-chat{display:flex;flex-direction:column;gap:5px}
#ahd-hw .hw-msg{border:1px solid var(--u-line,#e1ddd2);border-radius:8px;padding:6px 8px;background:var(--u-surface,#fff)}
#ahd-hw .hw-msg.user{background:var(--u-surface2,#efede6)}
#ahd-hw .hw-msg.sys{background:transparent;border-style:dashed;color:var(--u-muted,#5f6874)}
#ahd-hw .hw-msg-h{display:flex;justify-content:space-between;gap:6px;font-size:9.6px;color:var(--u-muted,#5f6874);margin-bottom:2px}
#ahd-hw .hw-msg-b{font-size:10.9px;line-height:1.6;word-break:break-word}
#ahd-hw .hw-msg-chips{display:flex;gap:3px;flex-wrap:wrap;margin-top:3px}
#ahd-hw .hw-timeline{list-style:none;margin:0;padding:0 0 0 18px;position:relative}
#ahd-hw .hw-timeline::before{content:"";position:absolute;left:5px;top:4px;bottom:4px;width:2px;background:var(--u-line,#e1ddd2)}
#ahd-hw .hw-timeline li{position:relative;display:flex;gap:6px;flex-wrap:wrap;font-size:10.5px;padding:2px 0;color:var(--u-muted,#5f6874)}
#ahd-hw .hw-timeline b{color:var(--u-ink,#1b222b);font-size:10.5px}
#ahd-hw .hw-tl-dot{position:absolute;left:-18px;top:6px;width:9px;height:9px;border-radius:50%;background:var(--u-teal,#0f9d9a);box-shadow:0 0 0 2px var(--u-bg,#f4f3ee)}
#ahd-hw .hw-tl-t{font-family:"SFMono-Regular",Consolas,monospace;font-size:9.5px}
#ahd-hw .hw-tl-x{color:var(--u-ink,#1b222b)}
#ahd-hw .hw-endnote{font-size:9.5px;color:var(--u-muted,#5f6874);border-top:1px dashed var(--u-line,#e1ddd2);padding-top:8px;line-height:1.6}
#ahd-hw .hw-ev{background:var(--u-surface2,#efede6);padding:8px;gap:7px;overflow:auto}
#ahd-hw .hw-ev-card{flex:none;background:var(--u-surface,#fff);border:1px solid var(--u-line,#e1ddd2);border-radius:10px;overflow:hidden}
#ahd-hw .hw-ev-card h3{margin:0;padding:6px 9px;background:var(--u-surface2,#efede6);border-bottom:1px solid var(--u-line,#e1ddd2);font-size:10.2px;display:flex;align-items:center;gap:5px;justify-content:space-between}
#ahd-hw .hw-kv{display:grid;grid-template-columns:62px minmax(0,1fr);gap:2px 7px;margin:0;padding:7px 9px;font-size:10.4px}
#ahd-hw .hw-kv dt{color:var(--u-muted,#5f6874);font-size:9.7px}
#ahd-hw .hw-kv dd{margin:0;word-break:break-word;text-align:right;font-weight:600}
#ahd-hw .hw-note{margin:5px 9px 7px;font-size:9.4px;color:var(--u-muted,#5f6874);line-height:1.55}
#ahd-hw .hw-kb-list{padding:5px 9px 7px;display:flex;flex-direction:column;gap:5px}
#ahd-hw .hw-kb{font-size:10.2px;border-bottom:1px dashed var(--u-line,#e1ddd2);padding-bottom:4px}
#ahd-hw .hw-kb:last-child{border-bottom:0;padding-bottom:0}
#ahd-hw .hw-kb-meta{display:flex;gap:4px;align-items:center;flex-wrap:wrap;margin-top:2px}
#ahd-hw .hw-props{padding:5px 9px 7px;display:flex;flex-direction:column;gap:5px}
#ahd-hw .hw-prop{border:1px solid var(--u-line,#e1ddd2);border-radius:7px;padding:5px 6px}
#ahd-hw .hw-prop-h{display:flex;justify-content:space-between;gap:5px;align-items:center}
#ahd-hw .hw-prop-k{font-size:9.5px;color:var(--u-muted,#5f6874);margin-top:2px;word-break:break-all}
#ahd-hw .hw-audit{padding:4px 9px 6px}
#ahd-hw .hw-audit-row{display:grid;grid-template-columns:34px 44px minmax(0,1fr);gap:4px;font-size:9.5px;padding:3px 0;border-bottom:1px dashed var(--u-line,#e1ddd2)}
#ahd-hw .hw-audit-row span:first-child{font-family:"SFMono-Regular",Consolas,monospace;font-size:9px;color:var(--u-muted,#5f6874)}
#ahd-hw .hw-audit-row b{font-size:9.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#ahd-hw .hw-audit-row small{grid-column:1/-1;color:var(--u-muted,#5f6874);font-size:9.2px;line-height:1.45;word-break:break-word}
#ahd-hw .hw-actions{display:flex;gap:5px;flex-wrap:wrap;padding:6px 9px 8px}
#ahd-hw .hw-dl{margin:0;padding:7px 9px;font-size:10.4px;display:grid;grid-template-columns:34px minmax(0,1fr);gap:3px 6px}
#ahd-hw .hw-dl dt{font-size:9.6px;color:var(--u-muted,#5f6874)}
#ahd-hw .hw-dl dd{margin:0;word-break:break-word}
#ahd-hw .hw-dl ol{margin:0;padding-left:15px}
#ahd-hw .hw-toasts{position:absolute;left:50%;bottom:16px;transform:translateX(-50%);display:flex;flex-direction:column;gap:5px;z-index:2;align-items:center;pointer-events:none}
#ahd-hw .hw-toast{background:var(--u-navy,#16314f);color:#fff;font-size:10.8px;padding:6px 11px;border-radius:7px;box-shadow:0 6px 20px rgba(10,20,30,.28);max-width:min(520px,80vw);text-align:center}
#ahd-hw .hw-toast.ok{background:#176d42}
#ahd-hw .hw-toast.bad{background:#8f2320}
#ahd-hw .hw-tc-body{padding:7px 9px 8px;display:flex;flex-direction:column;gap:6px}
#ahd-hw .hw-tc-body .hw-note{margin:0}
#ahd-hw .hw-tc-body .hw-alert{margin-bottom:0}
#ahd-hw .hw-tc-timer{font-family:"SFMono-Regular",Consolas,monospace;font-size:11px;font-weight:700}
#ahd-hw .hw-tc-timer.bad{color:var(--u-r,#c9302c)}
#ahd-hw .hw-tc-form{padding:0;display:flex;flex-direction:column;gap:5px}
#ahd-hw .hw-tc-form .hw-form-row{margin-bottom:0}
#ahd-hw .hw-tc-form .hw-note{margin:0}
#ahd-hw .hw-tc-cmd{display:flex;gap:4px;align-items:flex-start;background:var(--u-surface2,#efede6);border:1px solid var(--u-line,#e1ddd2);border-radius:6px;padding:4px 5px;margin-top:4px}
#ahd-hw .hw-tc-cmd code{flex:1;min-width:0;font:9.8px/1.45 "SFMono-Regular",Consolas,monospace;white-space:pre-wrap;word-break:break-all;color:var(--u-ink,#1b222b)}
#ahd-hw .hw-tc-meta{font-size:9.4px;color:var(--u-muted,#5f6874);line-height:1.5;margin-top:3px;display:flex;flex-direction:column;gap:1px}
#ahd-hw .hw-tc-meta b{color:var(--u-ink,#1b222b);font-weight:650}
#ahd-hw .hw-tc-warn{margin:3px 0 0;padding-left:14px;font-size:9.4px;color:var(--u-r,#c9302c);line-height:1.5}
#ahd-hw .hw-tc-divider{border-top:1px dashed var(--u-line,#e1ddd2);margin:5px 0}
#ahd-hw .hw-tc-steps-h{display:flex;justify-content:space-between;align-items:center;font-size:10px;color:var(--u-muted,#5f6874)}
#ahd-hw .hw-tc-steps{display:flex;flex-direction:column;gap:5px}
#ahd-hw .hw-tc-step{border:1px solid var(--u-line,#e1ddd2);border-radius:8px;padding:5px 6px;background:var(--u-surface,#fff)}
#ahd-hw .hw-tc-step.recorded{border-left:3px solid var(--u-g,#1f9d55)}
#ahd-hw .hw-tc-step.pending{border-left:3px solid var(--u-y,#e0a800)}
#ahd-hw .hw-tc-step-h{display:flex;align-items:center;gap:4px;flex-wrap:wrap;font-size:9.8px;margin-bottom:2px}
#ahd-hw .hw-tc-out{margin:3px 0 0;padding:4px 5px;background:var(--u-surface2,#efede6);border-radius:5px;font:9.6px/1.45 "SFMono-Regular",Consolas,monospace;white-space:pre-wrap;word-break:break-word;max-height:150px;overflow:auto}
#ahd-hw .hw-tc-actions{display:flex;gap:5px;flex-wrap:wrap}
#ahd-hw-launcher{position:fixed;right:16px;bottom:16px;z-index:45;display:inline-flex;align-items:center;gap:6px;border:0;border-radius:999px;background:var(--u-navy,#16314f);color:#fff;font:650 11.5px var(--u-font,sans-serif);padding:9px 13px;box-shadow:0 8px 26px rgba(10,20,30,.28);cursor:pointer}
#ahd-hw-launcher:hover{background:#0f2440}
#ahd-hw-launcher[hidden]{display:none!important}
body.ahd-hw-open{overflow:hidden}
 :root[data-theme="dark"] #ahd-hw .hw-card.on{border-color:var(--u-teal,#0f9d9a);box-shadow:0 0 0 1px var(--u-teal,#0f9d9a) inset}
:root[data-theme="dark"] #ahd-hw .hw-prio.p3{background:#1d2b3d}
:root[data-theme="dark"] #ahd-hw .hw-alert.info{background:#1d2b3d}
:root[data-theme="dark"] #ahd-hw .hw-btn.pri{background:var(--u-teal,#0f9d9a);border-color:var(--u-teal,#0f9d9a)}
:root[data-theme="dark"] #ahd-hw .hw-form-row input,:root[data-theme="dark"] #ahd-hw .hw-form-row select,:root[data-theme="dark"] #ahd-hw .hw-form-row textarea{border-color:#4a5a6c;background:#141c26}
@media (prefers-color-scheme:dark){
 :root:not([data-theme="light"]) #ahd-hw .hw-card.on{border-color:var(--u-teal,#0f9d9a);box-shadow:0 0 0 1px var(--u-teal,#0f9d9a) inset}
 :root:not([data-theme="light"]) #ahd-hw .hw-prio.p3{background:#1d2b3d}
 :root:not([data-theme="light"]) #ahd-hw .hw-alert.info{background:#1d2b3d}
 :root:not([data-theme="light"]) #ahd-hw .hw-btn.pri{background:var(--u-teal,#0f9d9a);border-color:var(--u-teal,#0f9d9a)}
 :root:not([data-theme="light"]) #ahd-hw .hw-form-row input,:root:not([data-theme="light"]) #ahd-hw .hw-form-row select,:root:not([data-theme="light"]) #ahd-hw .hw-form-row textarea{border-color:#4a5a6c;background:#141c26}
}
@media(max-width:1320px){#ahd-hw .hw-grid{grid-template-columns:270px minmax(0,1fr) 320px}}
@media(max-width:1120px){#ahd-hw .hw-grid{grid-template-columns:250px minmax(0,1fr)}#ahd-hw .hw-ev{display:none}}
@media(max-width:880px){#ahd-hw .hw-grid{grid-template-columns:minmax(0,1fr)}#ahd-hw .hw-queue{display:none}#ahd-hw .hw-sub{display:none}}
`;
  document.head.appendChild(style);

  const launcher = document.createElement('button');
  launcher.id = 'ahd-hw-launcher';
  launcher.type = 'button';
  launcher.hidden = true;
  launcher.textContent = '🧭 引継ぎワークスペース';
  launcher.title = '引継ぎ案件を3ペインで開く';
  document.body.appendChild(launcher);

  const root = document.createElement('div');
  root.id = 'ahd-hw';
  root.hidden = true;
  root.tabIndex = -1;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', '引継ぎワークスペース');
  root.innerHTML =
    '<header class="hw-top"><span class="hw-mark">み</span><span class="hw-title">引継ぎワークスペース</span><span class="hw-sub" id="hw-sub">案件を選択してください</span><span class="hw-sp"></span><button type="button" class="hw-btn sm" data-hw="refresh">⟳ 更新</button><button type="button" class="hw-close" data-hw="close" aria-label="閉じる">×</button></header>' +
    '<div class="hw-top-note">既存の引継ぎ案件を表示します（デモデータではありません）。担当開始・解決記録は既存の「③ 引継ぎ・④ 解決記録」と同じ処理を呼び出します。</div>' +
    '<main class="hw-grid"><aside class="hw-pane hw-queue"><div class="hw-ph"><h2>引継ぎボード</h2><p id="hw-counts"></p></div><div class="hw-tools"><div class="hw-seg" id="hw-filters"><button type="button" data-hw="filter" data-filter="all">すべて <b>0</b></button><button type="button" data-hw="filter" data-filter="open">引継ぎ待ち <b>0</b></button><button type="button" data-hw="filter" data-filter="progress">対応中 <b>0</b></button><button type="button" data-hw="filter" data-filter="done">解決 <b>0</b></button></div><input id="hw-search" class="hw-search" type="search" placeholder="案件番号・件名・依頼者で検索" autocomplete="off"></div><div class="hw-list" id="hw-list"></div><div class="hw-foot">赤→黄→青の順。担当開始・解決記録は既存の画面と同じ処理を呼びます。</div></aside><section class="hw-pane hw-case" id="hw-case" aria-label="案件の経過と次の一手"></section><aside class="hw-pane hw-ev" id="hw-ev" aria-label="案件情報・共有情報・記録"></aside></main><div class="hw-toasts" id="hw-toasts" aria-live="polite"></div>';
  document.body.appendChild(root);

  function helpdeskActive() {
    try {
      if (!window.HD) return false;
      if (typeof S === 'undefined' || !S || !S.ui) return false;
      return S.ui.screen === 'tool' && String(S.ui.view || '').startsWith('h.');
    } catch {
      return false;
    }
  }

  function railAllowed() {
    try {
      return me().role !== 'employee';
    } catch {
      return false;
    }
  }

  /** 左ナビ（#uxRail）に「引継ぎ」を追加する。uxShell の再描画で消えるため監視して戻す。 */
  function syncRailItem() {
    const rail = document.getElementById('uxRail');
    if (!rail) return;
    const existing = document.getElementById('ahd-hw-rail');
    if (!railAllowed()) {
      if (existing) existing.remove();
      return;
    }
    let button = existing;
    if (!button) {
      button = document.createElement('button');
      button.id = 'ahd-hw-rail';
      button.type = 'button';
      button.title = '引継ぎワークスペース（3ペイン）';
      button.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#i-headset"/></svg>引継ぎ';
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        openWorkspace();
      });
      const spacer = rail.querySelector('.sp');
      rail.insertBefore(button, spacer || null);
    }
    button.classList.toggle('on', HW.open);
  }

  function installRailObserver() {
    const rail = document.getElementById('uxRail');
    if (!rail || railObserver) return;
    railObserver = new MutationObserver(() => {
      syncRailItem();
    });
    railObserver.observe(rail, { childList: true });
  }

  function updateLauncher() {
    if (HW.open && HW.embedded) {
      const changed =
        typeof S !== 'undefined' &&
        S &&
        S.ui &&
        (S.ui.view !== HW.baseView || S.ui.screen !== HW.baseScreen);
      if (changed || !railAllowed()) {
        close();
        return;
      }
    }
    launcher.hidden = HW.open || !helpdeskActive();
    syncRailItem();
  }

  function openWorkspace() {
    if (HW.open) {
      close();
      return;
    }
    const content = document.querySelector('.ux-content');
    HW.embedded = Boolean(content);
    HW.baseView = typeof S !== 'undefined' && S && S.ui ? S.ui.view : null;
    HW.baseScreen = typeof S !== 'undefined' && S && S.ui ? S.ui.screen : null;
    if (content) {
      content.classList.add('ahd-hw-embedded');
      if (root.parentElement !== content) content.appendChild(root);
      root.classList.remove('hw-floating');
      root.classList.add('hw-embedded');
      document.body.classList.remove('ahd-hw-open');
    } else {
      if (root.parentElement !== document.body) document.body.appendChild(root);
      root.classList.remove('hw-embedded');
      root.classList.add('hw-floating');
      document.body.classList.add('ahd-hw-open');
    }
    HW.open = true;
    root.hidden = false;
    updateLauncher();
    ensureSelected();
    renderAll();
    loadInbox();
    const closeButton = root.querySelector('.hw-close');
    if (HW.embedded) root.focus();
    else if (closeButton) closeButton.focus();
  }

  function close() {
    HW.open = false;
    HW.embedded = false;
    root.hidden = true;
    document.body.classList.remove('ahd-hw-open');
    const content = document.querySelector('.ux-content');
    if (content) content.classList.remove('ahd-hw-embedded');
    root.classList.remove('hw-embedded', 'hw-floating');
    updateLauncher();
    launcher.focus();
  }

  function scheduleRender() {
    if (!HW.open) return;
    if (HW.timer) clearTimeout(HW.timer);
    HW.timer = setTimeout(() => {
      HW.timer = null;
      if (HW.open) renderAll();
    }, 140);
  }

  launcher.addEventListener('click', openWorkspace);

  root.addEventListener('click', (event) => {
    const target = event.target.closest('[data-hw]');
    if (!target) return;
    const action = target.dataset.hw;
    const t = current();
    if (action === 'close') return close();
    if (action === 'refresh') {
      HW.inboxState = 'idle';
      // 実行セッションも取り直す（保存直後の古い表示を残さない）。
      HW.tc.key = null;
      HW.tc.loaded = false;
      renderAll();
      loadInbox(true);
      hwToast('最新の状態に更新しました。');
      return;
    }
    if (action === 'select') {
      HW.selected = target.dataset.id;
      HW.scrollTop = 0;
      renderAll();
      return;
    }
    if (action === 'filter') {
      HW.filter = target.dataset.filter;
      renderList();
      return;
    }
    if (action === 'claim') {
      claimHandover(target.dataset.id, target);
      return;
    }
    if (!t) return;
    if (action === 'start') return startWork(t);
    if (action === 'resolve') return resolveCase(t);
    if (action === 'example') return fillExample(t);
    if (action === 'draft') return openDraft(t);
    if (action === 'legacy') return openLegacy(t);
    if (action === 'cowork') return openCowork(t);
    if (action === 'ai') return askAi(t);
    if (action === 'copy-prompt') return copyPrompt(target);
    if (action === 'kb') return openKb(target.dataset.id);
    /* RSP 実行セッション */
    if (action === 'tc-start') return void tcStart(t);
    if (action === 'tc-propose') return void tcPropose();
    if (action === 'tc-open-record') {
      HW.tc.openStep = target.dataset.id || null;
      renderEv();
      return;
    }
    if (action === 'tc-cancel-record') {
      HW.tc.openStep = null;
      renderEv();
      return;
    }
    if (action === 'tc-record') {
      const step = HW.tc.steps.find((item) => item.id === target.dataset.id);
      if (step) void tcRecord(step);
      return;
    }
    if (action === 'tc-copy') return tcCopy(target.dataset.id, target.dataset.kind);
    if (action === 'tc-close') return void tcClose(target.dataset.reason);
    if (action === 'tc-report') return void tcReport();
    if (action === 'tc-knowledge') return void tcKnowledge();
    if (action === 'tc-open-report') return tcOpenReport();
    if (action === 'tc-reload') return tcReload();
  });

  root.querySelector('#hw-search').addEventListener('input', (event) => {
    HW.query = event.target.value;
    renderList();
  });

  root.addEventListener('input', (event) => {
    if (event.target && event.target.id === 'hw-ai-input') {
      const t = current();
      if (t) HW.aiDraft[t.id] = event.target.value;
    }
    const el = event.target;
    if (!el || typeof el.getAttribute !== 'function') return;
    const field = el.getAttribute('data-hw-field');
    if (field === 'intent') {
      HW.tc.intent = el.value;
      return;
    }
    if (field === 'close-note') {
      HW.tc.closeNote = el.value;
      return;
    }
    if (field === 'step') {
      const draft = HW.tc.drafts[el.getAttribute('data-step-id')];
      if (draft) draft[el.getAttribute('data-field')] = el.value;
    }
  });

  root.addEventListener('change', (event) => {
    const el = event.target;
    if (!el || typeof el.getAttribute !== 'function') return;
    const field = el.getAttribute('data-hw-field');
    if (!field) return;
    if (field === 'consent') {
      const key = el.getAttribute('data-consent');
      if (key === 'screenShare' || key === 'remoteControl') {
        HW.tc.consent[key] = Boolean(el.checked);
        renderEv();
      }
      return;
    }
    if (field === 'step') {
      const draft = HW.tc.drafts[el.getAttribute('data-step-id')];
      if (draft) draft[el.getAttribute('data-field')] = el.value;
    }
  });

  root.addEventListener(
    'scroll',
    (event) => {
      if (event.target && event.target.classList && event.target.classList.contains('hw-cbody')) {
        HW.scrollTop = event.target.scrollTop;
      }
    },
    true,
  );

  document.addEventListener(
    'keydown',
    (event) => {
      if (HW.open && event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    },
    true,
  );

  document.addEventListener(
    'click',
    (event) => {
      if (!HW.open || root.contains(event.target)) return;
      const action = event.target.closest(
        '[data-act="nav"], [data-act="wRail"], [data-act="wTool"], [data-act="profile"], [data-act="estop"]',
      );
      if (action) close();
    },
    true,
  );

  window.addEventListener('aihd-state', (event) => {
    if (HW.open && /helpdesk|cowork/.test(String(event.detail || ''))) scheduleRender();
  });
  window.addEventListener('storage', (event) => {
    if (HW.open && (event.key === HD_KEY || event.key === CW_KEY)) scheduleRender();
  });
  window.addEventListener('focus', () => {
    if (HW.open) scheduleRender();
  });

  installRailObserver();
  syncRailItem();
  setInterval(updateLauncher, 800);
  // 残り時間だけを毎秒更新する（右ペイン全体は再描画しない）。
  setInterval(() => {
    if (!HW.open || !HW.tc.session || HW.tc.session.status !== 'active') return;
    const el = document.getElementById('hw-tc-remain');
    if (!el) return;
    const remain = tcRemain(HW.tc.session);
    el.textContent = tcRemainText(remain);
    el.classList.toggle('bad', remain != null && remain <= 0);
  }, 1000);
  updateLauncher();
})();
