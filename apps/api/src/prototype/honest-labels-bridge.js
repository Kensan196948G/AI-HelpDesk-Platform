/*
 * AI HelpDesk honest labels bridge（AGENTS.md §5「未実装機能を実装済みに見せない」）。
 *
 * 相談者ウィザードの診断・修復は HTML 内の決定ルールと固定データ（S.devices）で動き、
 * サーバも実端末も見ていない。実 AI（DeepSeek）が答えるのは H.kb 経由の自由記述だけ。
 * この事実が画面と引継ぎで分かるように、表示の文言と引継ぎの値だけを差し替える。
 *
 * - DOM / CSS / 画面遷移は変えない。元の関数が返した文字列の文言を置き換える。
 * - 保存済みの会話にも効くよう、メッセージは書き換えず描画時に判定する。
 * - 実 AI 経路（H.kb → /api/ai/answer）と PC 基本情報の実取得（device-bridge）には触れない。
 * - 理由と対象の一覧: docs/14-prototype-ui-integration.md §2-11。
 */
(() => {
  const REAL_MODEL = 'DeepSeek-V4.1-Flash';
  const FALLBACK_LABEL = '承認済みナレッジ検索（DeepSeek 未使用）';
  const RULE_LABEL = 'ルールベース（デモデータ）';
  const RULE_DIAG_LABEL = 'ルールベース（デモデータ・実端末の結果ではありません）';
  const AGENT_LABEL = '端末エージェント（実端末）';
  const DEMO_NOTICE = 'デモデータ（実端末の結果ではありません）';
  const DEMO_INLINE = 'デモデータ：実端末の結果ではありません';
  const DEMO_PREFIX = '【デモデータ】';
  const NO_REAL_DEVICE = '未取得（実端末の情報はありません）';
  // 画面の固定値ではなく、由来が別に分かっているメッセージのモデル欄はそのまま出す。
  const PASS_THROUGH_MODELS = new Set([
    'PCエージェント（事前取得）',
    'AIヘルプデスク連携',
    'システム',
  ]);
  // ACT.realExec が /api/device/command の結果を ai() で出す文言（実端末の結果）。
  const REAL_EXEC_HTML =
    /実端末へコマンドを送信|実端末で実行しました|実端末での実行に失敗|端末エージェントからの応答がありません|状態の確認に失敗しました/;

  function honestMeta(message) {
    if (!message) return message;
    if (message.provider === 'deepseek') {
      return Object.assign({}, message, { model: REAL_MODEL });
    }
    if (message.provider === 'fallback') {
      return Object.assign({}, message, { model: FALLBACK_LABEL, conf: '—' });
    }
    if (!message.model || PASS_THROUGH_MODELS.has(message.model)) return message;
    if (REAL_EXEC_HTML.test(String(message.html || ''))) {
      return Object.assign({}, message, { model: AGENT_LABEL, conf: '—' });
    }
    return Object.assign({}, message, {
      model: message.after ? RULE_DIAG_LABEL : RULE_LABEL,
      conf: '—',
    });
  }

  /** 担当者画面・報告書で、発言者を「AI」と一括りにしない。 */
  function whoFor(message) {
    if (!message) return RULE_LABEL;
    if (message.provider === 'deepseek') return 'AI（DeepSeek）';
    if (message.provider === 'fallback') return FALLBACK_LABEL;
    if (message.model && PASS_THROUGH_MODELS.has(message.model)) return message.model;
    if (REAL_EXEC_HTML.test(String(message.html || ''))) return AGENT_LABEL;
    return RULE_LABEL;
  }

  function usedRealAi(chat) {
    return Boolean(
      chat &&
        Array.isArray(chat.messages) &&
        chat.messages.some((message) => message && message.provider === 'deepseek'),
    );
  }

  /** 画面の pcSnapshot() が固定データから作った記録か（PCエージェント欄の「v0.3（模擬）」で判定）。 */
  function isDemoSnapshot(snap) {
    return Boolean(
      snap &&
        Array.isArray(snap.items) &&
        snap.items.some((item) => item && item.k === 'PCエージェント' && /模擬/.test(item.v || '')),
    );
  }

  function replaceAll(text, from, to) {
    return text.split(from).join(to);
  }

  /** 文言だけを置き換える。タグと class は変えない。 */
  function applyDemoNotices(kind, html) {
    let out = html;
    if (kind === 'diag') {
      out = replaceAll(out, '🔍 ', `🔍 ${DEMO_PREFIX}`);
      out = replaceAll(out, '<span class="r">端末 ', '<span class="r">デモ端末 ');
      out = replaceAll(
        out,
        '取得するのは設定・サービス状態・件数のみ。ファイルの中身・閲覧履歴・画面は取得しません。',
        `${DEMO_NOTICE}。固定データによる表示で、この端末を調べた結果ではありません。`,
      );
    } else if (kind === 'confirm') {
      out = replaceAll(out, '<dt>対象端末</dt>', '<dt>対象端末（デモ）</dt>');
      out = replaceAll(out, '<dt>端末の現状</dt>', '<dt>端末の現状（デモ）</dt>');
      out = replaceAll(
        out,
        'この内容で合っていますか？',
        `この内容で合っていますか？ 端末の欄は${DEMO_NOTICE}です。`,
      );
    } else if (kind === 'proposal') {
      out = replaceAll(out, '🛠️ 修復・作業の提案', `🛠️ 修復・作業の提案${DEMO_PREFIX}`);
      out = replaceAll(out, '<dt>対象</dt>', '<dt>対象（デモ）</dt>');
    } else if (kind === 'exec') {
      out = replaceAll(out, '🏁 完了・結果の確認', `🏁 完了・結果の確認：${DEMO_NOTICE}`);
      out = replaceAll(out, '⚙️ 実行', '⚙️ 実行（デモ：実端末は変更していません）');
      out = replaceAll(
        out,
        'サーバ側の実行前検証',
        '実行前検証（デモ：サーバでは検証していません）',
      );
      out = replaceAll(
        out,
        'PCエージェントの作業',
        'PCエージェントの作業（デモ：実端末は変更していません）',
      );
    }
    return out;
  }

  function findCaseOfChat(chatId) {
    try {
      const list = Array.isArray(S.cases) ? S.cases : [];
      return list.find((item) => item && item.chatId === chatId) || null;
    } catch (error) {
      return null;
    }
  }

  function deviceLabelFromSnapshot(snap) {
    if (!snap || !snap.device || isDemoSnapshot(snap)) return '';
    const items = Array.isArray(snap.items) ? snap.items : [];
    const os = items.find((item) => item && item.k === 'OS');
    return String(snap.device) + (os && os.v ? '／' + String(os.v) : '');
  }

  /** 引継ぎへ渡す端末。実取得した端末だけを使い、デモ端末（MRK-…）は渡さない。 */
  function realDeviceLabel(targetCase, userId) {
    const stored = targetCase && targetCase.pc ? deviceLabelFromSnapshot(targetCase.pc.snap) : '';
    if (stored) return stored;
    try {
      const current = deviceLabelFromSnapshot(window.pcSnapshot(S, userId));
      if (current) return current;
    } catch (error) {
      // 取得できないときは未取得と明記する。
    }
    return NO_REAL_DEVICE;
  }

  function markDiag(lines) {
    if (!Array.isArray(lines)) return lines;
    return lines.map((line) => {
      // 診断の行はすべて固定データ。担当者が端末を探さないよう、デモ端末 ID も伏せる。
      const text = String(line).replace(/MRK-[A-Za-z0-9_-]+/g, 'デモ端末');
      return text.startsWith(DEMO_PREFIX) ? text : DEMO_PREFIX + text;
    });
  }

  /** N 選択・失敗の理由にはデモ端末 ID と固定のジョブ名が入るため、対象を除いて明記する。 */
  function markReason(reason) {
    const text = String(reason || '');
    if (!text || text.startsWith(DEMO_PREFIX)) return text;
    const cleaned = text.replace(/／対象: [^／]*/g, '');
    return `${DEMO_PREFIX}デモの修復提案に対する記録です（${DEMO_INLINE}）。${cleaned}`;
  }

  function sanitizeShared(shared, targetCase, userId) {
    if (!shared || typeof shared !== 'object') return shared;
    const out = Object.assign({}, shared);
    if ('AIの診断結果' in out) out['AIの診断結果'] = markDiag(out['AIの診断結果']);
    if ('端末' in out) out['端末'] = realDeviceLabel(targetCase, userId);
    if ('対応案（未実行・失敗）' in out) {
      out['対応案（未実行・失敗）'] = markReason(out['対応案（未実行・失敗）']);
    }
    return out;
  }

  function wrap(name, build) {
    if (typeof window[name] !== 'function') return;
    window[name] = build(window[name]);
  }

  wrap('msgMeta', (original) => (message) => original(honestMeta(message)));

  wrap('renderMsg', (original) => (message, chat) => {
    const html = original(message, chat);
    return typeof html === 'string' && message ? applyDemoNotices(message.kind, html) : html;
  });

  // paneHtml は全体描画（wizHtml）と部分更新の両方から呼ばれるので、ここで文言を揃える。
  wrap('paneHtml', (original) => (target, ...rest) => {
    const html = original(target, ...rest);
    if (typeof html !== 'string') return html;
    let out = replaceAll(
      html,
      'AIが社内資料と端末の状態（読み取りのみ）から答えます。',
      `定型の相談は${RULE_LABEL}で案内し、それ以外の自由記述だけ DeepSeek が社内資料から答えます。`,
    );
    out = replaceAll(out, '<b>AIの診断結果</b>', `<b>AIの診断結果（${DEMO_INLINE}）</b>`);
    if (out.includes('<b>端末の番号・OS</b>')) {
      let device = NO_REAL_DEVICE;
      try {
        const label = realDeviceLabel(target, target ? target.userId : S.ui.user);
        device = typeof esc === 'function' ? esc(label) : label;
      } catch (error) {
        // 取得できないときは未取得と明記する。
      }
      out = out.replace(
        /(<b>端末の番号・OS<\/b><br><span class="u-small u-muted">)[^<]*(<\/span>)/,
        (_, head, tail) => head + device + tail,
      );
    }
    return out;
  });

  wrap('asideHtml', (original) => (...args) => {
    const html = original(...args);
    if (typeof html !== 'string') return html;
    return replaceAll(
      html,
      'AIが社内資料と端末の状態から対応しています',
      `定型の相談は${RULE_LABEL}で対応しています`,
    );
  });

  wrap('consentCard', (original) => (chat, ...rest) => {
    const message = original(chat, ...rest);
    if (message && message.ctx) {
      message.ctx.diag = markDiag(message.ctx.diag);
      message.ctx.device = realDeviceLabel(findCaseOfChat(chat && chat.id), chat && chat.userId);
    }
    if (message && message.reason) message.reason = markReason(message.reason);
    return message;
  });

  // 保存済みの同意カード（この修正の前に作られたもの）も、ここで同じ値に揃える。
  wrap('createTicket', (original) => (state, options) => {
    if (!options || !options.shared) return original(state, options);
    let targetCase = null;
    try {
      const list = Array.isArray(state.chats) ? state.chats : [];
      const chats = list.filter((chat) => chat && chat.userId === options.userId);
      const active = chats.find((chat) => chat.id === state.ui.chat) || null;
      targetCase = active ? findCaseOfChat(active.id) : null;
    } catch (error) {
      targetCase = null;
    }
    const shared = sanitizeShared(options.shared, targetCase, options.userId);
    return original(state, Object.assign({}, options, { shared }));
  });

  // 固定データの PC スナップショットは、実情報として担当者・AI へ渡さない。
  wrap(
    'pcLines',
    (original) => (target) =>
      target && target.pc && isDemoSnapshot(target.pc.snap) ? [] : original(target),
  );

  wrap('pcCardHtml', (original) => (target, ...rest) => {
    const html = original(target, ...rest);
    if (typeof html !== 'string' || !target || !target.pc || !isDemoSnapshot(target.pc.snap)) {
      return html;
    }
    return replaceAll(html, '項目を読み取りました', `項目（${DEMO_INLINE}）`);
  });

  wrap('pcAnnounce', (original) => (target, chat) => {
    const before = chat && Array.isArray(chat.messages) ? chat.messages.length : 0;
    const result = original(target, chat);
    if (target && target.pc && isDemoSnapshot(target.pc.snap) && chat) {
      for (const message of chat.messages.slice(before)) {
        message.model = RULE_LABEL;
        message.html = `<p>${DEMO_NOTICE}</p>${message.html || ''}`;
      }
    }
    return result;
  });

  // 名簿に無い利用者は画面既定のデモ利用者のまま固定される。実名に見せて担当者へ渡さない。
  try {
    if (window.HD && typeof window.HD.intake === 'function') {
      const originalIntake = window.HD.intake;
      window.HD.intake = (options) => {
        const locked = typeof PERSONA_LOCKED !== 'undefined' && PERSONA_LOCKED;
        return originalIntake(
          locked
            ? Object.assign({}, options, { requester: '名簿未登録の利用者（氏名は未確認）' })
            : options,
        );
      };
    }
  } catch (error) {
    // 引継ぎ本体は止めない。
  }

  window.__AIHD_HONEST__ = {
    REAL_MODEL,
    RULE_LABEL,
    DEMO_PREFIX,
    honestMeta,
    whoFor,
    usedRealAi,
    isDemoSnapshot,
    applyDemoNotices,
    markDiag,
    markReason,
    realDeviceLabel,
    sanitizeShared,
  };
})();
