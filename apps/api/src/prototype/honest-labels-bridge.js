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
  const NOTICE_LABEL = '定型の案内';
  const RESOLVE_LOOP_LABEL = '解決ループ（端末の読み取り結果。出所は各結果を参照）';
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

  /** メッセージの由来。実 AI と判定できるものだけ deepseek を返す。 */
  function sourceOf(message) {
    // 解決ループの結果は、出所（実端末 / 模擬 / 不明）を model に持たせて表示する。
    if (message.resolveResult) return 'pass';
    if (message.provider === 'deepseek' || message.provider === 'fallback') {
      return message.provider;
    }
    const model = String(message.model || '');
    // 担当者の追加質問（/api/ai/answer-case）の保存済み分は provider が無く、model が API の値。
    if (/^deepseek-/.test(model)) return 'deepseek';
    if (model === 'fallback') return 'fallback';
    // サーバが案件へ追記した回答（provider を保存する前の分）は判定できないのでそのまま出す。
    // （フォールバックだった回答も DeepSeek 表示のまま残る。docs/14 §2-11 の残課題）
    if (String(message.id || '').startsWith('case-ai-')) return 'pass';
    if (PASS_THROUGH_MODELS.has(model)) return 'pass';
    if (REAL_EXEC_HTML.test(String(message.html || ''))) return 'agent';
    return 'rule';
  }

  function honestMeta(message) {
    if (!message) return message;
    // モデル欄が無く由来の情報も無いカード（診断など）には何も足さない。
    if (!message.model && !message.provider) return message;
    switch (sourceOf(message)) {
      case 'deepseek':
        return Object.assign({}, message, { model: REAL_MODEL });
      case 'fallback':
        return Object.assign({}, message, { model: FALLBACK_LABEL, conf: '—' });
      case 'agent':
        return Object.assign({}, message, { model: AGENT_LABEL, conf: '—' });
      case 'pass':
        return message;
      default:
        return Object.assign({}, message, {
          model: message.after ? RULE_DIAG_LABEL : RULE_LABEL,
          conf: '—',
        });
    }
  }

  /** 担当者画面・報告書で、発言者を「AI」と一括りにしない。 */
  function whoFor(message) {
    if (!message) return RULE_LABEL;
    // 事故の初動・禁止操作・専用窓口の案内は実際の手順。固定データの診断と区別する。
    if (message.kind === 'block') return NOTICE_LABEL;
    switch (sourceOf(message)) {
      case 'deepseek':
        return 'AI（DeepSeek）';
      case 'fallback':
        return FALLBACK_LABEL;
      case 'agent':
        return AGENT_LABEL;
      case 'pass':
        return message.model || 'AI';
      default:
        return RULE_LABEL;
    }
  }

  function usedRealAi(chat) {
    return Boolean(
      chat &&
        Array.isArray(chat.messages) &&
        chat.messages.some((message) => message && sourceOf(message) === 'deepseek'),
    );
  }

  /** 報告書のモデル欄。実 AI > ナレッジ検索 > ルールの順に、実際に使ったものを書く。 */
  function reportModel(chat) {
    const messages = chat && Array.isArray(chat.messages) ? chat.messages : [];
    const sources = messages.filter(Boolean).map(sourceOf);
    if (sources.includes('deepseek')) return REAL_MODEL;
    if (sources.includes('fallback')) return FALLBACK_LABEL;
    // 解決ループだけの相談（固定データも実 AI の回答も使っていない）。
    if (messages.some((message) => message?.resolveResult)) return RESOLVE_LOOP_LABEL;
    return RULE_LABEL;
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
  function applyDemoNotices(kind, html, options) {
    let out = html;
    // 端末エージェントへ実行を送った相談では「実端末は変更していません」と言い切らない。
    const execNote =
      options && options.realExec
        ? 'デモ：このカードは模擬です。実端末での実行は下のメッセージを確認してください'
        : 'デモ：実端末は変更していません';
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
      out = replaceAll(out, '⚙️ 実行', `⚙️ 実行（${execNote}）`);
      out = replaceAll(
        out,
        'サーバ側の実行前検証',
        '実行前検証（デモ：サーバでは検証していません）',
      );
      out = replaceAll(out, 'PCエージェントの作業', `PCエージェントの作業（${execNote}）`);
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

  /**
   * 引継ぎへ渡す端末。案件に記録された実取得だけを使う。
   * pcSnapshot() は閲覧中のブラウザの端末を返すため使わない。使うと事前取得を断った案件や、
   * 別の PC・担当者が開いた案件で、本人が確認していない端末を依頼者の端末として渡してしまう。
   */
  function realDeviceLabel(targetCase) {
    const pc = targetCase && targetCase.pc;
    const stored = pc && pc.state === 'done' ? deviceLabelFromSnapshot(pc.snap) : '';
    return stored || NO_REAL_DEVICE;
  }

  /** 修正前の同意カードが持つ「デモ端末 ID／OS」か。実取得の端末名と混同しないよう利用者の割当で照合する。 */
  function isDemoDeviceValue(value, userId) {
    try {
      const device = USERS[userId] && USERS[userId].device;
      return Boolean(device) && String(value).startsWith(`${device}／`);
    } catch (error) {
      return false;
    }
  }

  /** 本人が同意カードで見た値をそのまま共有する。デモ端末の値だけ未取得に直す。 */
  function cleanDeviceValue(value, userId) {
    return isDemoDeviceValue(value, userId) ? NO_REAL_DEVICE : value;
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

  function sanitizeShared(shared, userId) {
    if (!shared || typeof shared !== 'object') return shared;
    const out = Object.assign({}, shared);
    if ('AIの診断結果' in out) out['AIの診断結果'] = markDiag(out['AIの診断結果']);
    if ('端末' in out) out['端末'] = cleanDeviceValue(out['端末'], userId);
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

  /** 実行カードより後に、端末エージェントへ送った記録があるか。 */
  function realExecAfter(message, chat) {
    if (!message || message.kind !== 'exec' || !chat || !Array.isArray(chat.messages)) return false;
    const index = chat.messages.indexOf(message);
    return (
      index >= 0 &&
      chat.messages
        .slice(index + 1)
        .some((item) => item && REAL_EXEC_HTML.test(String(item.html || '')))
    );
  }

  /** 修正前に作られ、まだ送っていない同意カードも、表示と共有する値を同じ形に揃える。 */
  function normalizeConsent(message, chat) {
    if (!message || message.kind !== 'consent' || message.state !== 'pending' || !message.ctx) {
      return;
    }
    message.ctx.device = cleanDeviceValue(message.ctx.device, chat && chat.userId);
    message.ctx.diag = markDiag(message.ctx.diag);
    if (message.reason) message.reason = markReason(message.reason);
  }

  wrap('renderMsg', (original) => (message, chat) => {
    normalizeConsent(message, chat);
    const html = original(message, chat);
    if (typeof html !== 'string' || !message) return html;
    return applyDemoNotices(message.kind, html, { realExec: realExecAfter(message, chat) });
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
        const label = realDeviceLabel(target);
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
      // 案件は同意カードの相談から特定する（S.ui.chat の開いている相談には頼らない）。
      message.ctx.device = realDeviceLabel(findCaseOfChat(chat && chat.id));
    }
    if (message && message.reason) message.reason = markReason(message.reason);
    return message;
  });

  // 端末は再計算せず、同意カードの値を渡す。描画を経ずに送られた古いカードの値だけここで直す。
  wrap('createTicket', (original) => (state, options) => {
    if (!options || !options.shared) return original(state, options);
    const shared = sanitizeShared(options.shared, options.userId);
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
    reportModel,
    isDemoSnapshot,
    applyDemoNotices,
    markDiag,
    markReason,
    realDeviceLabel,
    sanitizeShared,
  };
})();
