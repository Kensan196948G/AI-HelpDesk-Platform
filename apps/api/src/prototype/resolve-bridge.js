/*
 * AI HelpDesk resolve bridge（解決ループ / Phase B）
 *
 * 既存プロトタイプ HTML は変更しない。このブリッジだけを追加する。
 * - 案件ウィザードの下に「解決ループ（読み取り診断）」カードを出す。
 * - サーバの /api/resolve/* と連携し、実行前 Y/N → 結果 → 継続 Y/N を繰り返す。
 * - 診断のみ（読み取り専用）。コマンド文字列の編集はできない。
 * - 印刷の相談は固定データの診断（H.print）へ進めず、このカードへ誘導する。
 *   端末エージェントが未接続なら、実診断できないことと引継ぎを案内する（docs/14 §2-12）。
 * - 結果は出所（実端末 / 模擬 / 不明）を区別して表示し、会話・引継ぎへ同じ区別で渡す。
 *
 * 依存: curCase / S / USERS / toast 等（同じ classic script のグローバル lexical 環境）。
 */
(() => {
  if (window.__AIHD_RESOLVE_BRIDGE__) return;
  window.__AIHD_RESOLVE_BRIDGE__ = { version: 1, at: new Date().toISOString() };

  const STATE = {
    caseId: null,
    session: null,
    step: null,
    // idle | proposed | executing | result | awaiting | stopped | resolved | escalated | error
    mode: 'idle',
    busy: false,
    error: null,
    pollTimer: null,
    lastKey: '',
    adminItems: null,
    adminLoaded: false,
    resolveAdmin: undefined,
    // 確認待ちカードの説明文に使う「最後に実行した Skill」の表示名（取得できたときだけ入る）。
    awaitingTitle: '',
    // 修復ステップ done 後の script 形態 verify 追撃待ち（session だけ executing の中間状態）。
    verifyWait: false,
    verifyTimedOut: false,
    verifyWaitTicks: 0,
    verifyWaitStartedAt: 0,
    verifySkillTitle: '',
    // 端末エージェントの接続状態（案内のための参考値。実行の可否は承認時にサーバが判定する）。
    // null は未確認。
    agentConnected: null,
    lastMode: 'idle',
    restoredFor: null,
  };

  // 結果の出所の表示。実端末と言えるのは endpoint_agent だけで、それ以外は言わない。
  const SOURCE_LABEL = {
    endpoint_agent: '端末エージェント（実端末）',
    mock: '模擬（実端末の結果ではありません）',
    unknown: '実行元を確認できません（実端末の結果と確認できていません）',
  };
  const NO_AGENT_NOTICE =
    '端末エージェントが未接続のため実診断はできません。担当者へ引き継げます。';
  const SHARE_KEY = '実診断の結果';

  // verify 追撃待ちのポーリング上限（1.5 秒間隔なので 30 回で約 45 秒。時間でも打ち切る）。
  const VERIFY_WAIT_MAX_TICKS = 30;
  const VERIFY_WAIT_MAX_MS = 60_000;

  function esc(value) {
    return String(value ?? '').replace(
      /[&<>"']/g,
      (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
    );
  }

  function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
      .join(',')}}`;
  }

  async function sha256Hex(text) {
    if (!window.crypto || !window.crypto.subtle) {
      throw new Error('このブラウザでは承認ハッシュを計算できません（HTTPS で開いてください）');
    }
    const digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function api(path, body) {
    const response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers:
        body === undefined
          ? { Accept: 'application/json' }
          : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try {
      json = await response.json();
    } catch (error) {
      json = null;
    }
    if (!response.ok) {
      const error = new Error(json?.error?.message || `HTTP ${response.status}`);
      error.code = json?.error?.code;
      error.status = response.status;
      throw error;
    }
    return json;
  }

  /** 実端末の ID だけを使う。デモ端末（USERS[..].device）へは落とさない。 */
  function deviceId() {
    return window.__AIHD_DEVICE_ID__ || '';
  }

  function sourceOfStep(step) {
    const source = step?.executionSource ?? step?.resultSummary?.executionSource;
    return source === 'endpoint_agent' || source === 'mock' ? source : 'unknown';
  }

  /** 接続状態を取り直す。取得できなければ未接続と同じ扱いにする（fail-closed）。 */
  async function refreshDeviceStatus() {
    const id = deviceId();
    let connected = false;
    if (id) {
      try {
        const data = await api(`/api/resolve/device-status?deviceId=${encodeURIComponent(id)}`);
        connected = data?.agentConnected === true;
      } catch (error) {
        connected = false;
      }
    }
    STATE.agentConnected = connected;
    return connected;
  }

  function isOwnerOf(c) {
    try {
      return Boolean(c) && c.userId === S.ui.user;
    } catch (error) {
      return false;
    }
  }

  function chatOfCase(c) {
    try {
      return c?.chatId ? S.chats.find((chat) => chat.id === c.chatId) || null : null;
    } catch (error) {
      return null;
    }
  }

  function caseById(caseId) {
    try {
      return (S.cases || []).find((item) => item && item.id === caseId) || null;
    } catch (error) {
      return null;
    }
  }

  /** 引継ぎ済み・完了済みの案件では、解決ループを新たに進めない。 */
  function caseFinished(c) {
    try {
      if (!c) return false;
      if (c.closed) return true;
      return typeof link === 'function' && Boolean(link(c)?.tkt);
    } catch (error) {
      return Boolean(c?.closed);
    }
  }

  // 再読み込み・案件の切替後に同じセッションへ戻るための控え（案件ごと・ステップ ID のみ）。
  function activeKey(caseId) {
    return `aihd.resolve.active.${caseId}`;
  }

  function rememberActive(caseId, stepId) {
    try {
      if (caseId && stepId) window.localStorage?.setItem(activeKey(caseId), String(stepId));
    } catch (error) {
      // 保存できなくてもカードは動く（復帰だけが効かない）。
    }
  }

  function forgetActive(caseId) {
    try {
      if (caseId) window.localStorage?.removeItem(activeKey(caseId));
    } catch (error) {
      // localStorage が使えない環境では何もしない。
    }
  }

  function caseOfChat(chat) {
    try {
      return (S.cases || []).find((item) => item && item.chatId === chat?.id) || null;
    } catch (error) {
      return null;
    }
  }

  function persist() {
    try {
      if (typeof save === 'function') save();
      if (typeof refresh === 'function') refresh();
    } catch (error) {
      // 表示の更新に失敗しても解決ループ自体は止めない。
    }
  }

  /** 読み取りの要点。AI へ渡してよい項目（fieldsToAi 適用後）だけを使う。 */
  function resultFacts(step) {
    const normalized = step?.resultAi?.normalized;
    if (!normalized || typeof normalized !== 'object') return [];
    return Object.entries(normalized).map(([key, value]) => [
      key,
      typeof value === 'string' ? value : JSON.stringify(value),
    ]);
  }

  /** 結果を会話へ残す（1 ステップ 1 回）。報告書・担当者の AI 文脈はここを読む。 */
  /**
   * 相談に一致した承認済み KB の案内。AI が使ったと答えたものだけ「AI が参照」と書く。
   * 照合はサーバ（DB）で、state の KB は含まれない。承認の出所は項目ごとにサーバの値を出す。
   */
  function knowledgeRefsHtml(step) {
    const refs = step?.knowledgeRefs;
    const matched = Array.isArray(refs?.matched) ? refs.matched : [];
    if (!matched.length) return '';
    const used = Array.isArray(refs.used) ? refs.used : [];
    const rows = matched
      .map((ref) => {
        const note = used.includes(ref.kbNo)
          ? 'AI が参照しました'
          : 'AI の参照はありません（相談内容との照合で表示）';
        return (
          `<div class="u-small" style="margin-top:6px" data-aihd-kb-ref="${esc(ref.kbNo)}" data-aihd-kb-origin="${esc(ref.approvalOrigin || 'unknown')}">` +
          `<b>${esc(ref.kbNo)} v${esc(ref.version)}</b> ${esc(ref.title)}` +
          `<div class="u-muted">出所：${esc(ref.approvalOriginLabel || '出所を確認できません')}</div>` +
          `<div class="u-muted">${esc(ref.stepsSummary)}</div>` +
          `<div class="u-muted">${esc(note)}</div></div>`
        );
      })
      .join('');
    return `<div style="margin-top:8px"><b class="u-small">出典：社内ナレッジ</b>${rows}</div>`;
  }

  function recordResult(step) {
    // 開いている案件ではなく、このセッションの案件の会話へ残す。
    const c = caseById(STATE.caseId);
    const chat = chatOfCase(c);
    if (!chat || !step?.id || step.status !== 'done') return;
    if (chat.messages.some((message) => message?.resolveResult?.stepId === step.id)) return;
    const source = sourceOfStep(step);
    const title = String(step.skill?.title || step.skillId || '読み取り診断');
    const facts = resultFacts(step);
    const factText = facts.map(([key, value]) => `${key}=${value}`).join(', ');
    const text = `【${SOURCE_LABEL[source]}】${title}：${factText || '結果の要点はありません'}（読み取りの結果です。解決の判定ではありません）`;
    const html =
      `<p><b>${esc(SOURCE_LABEL[source])}</b> ${esc(title)}</p>` +
      `<p class="small">${esc(factText || '結果の要点はありません')}</p>` +
      '<p class="small muted">読み取りの結果です。解決の判定ではありません。</p>';
    addMsg(chat, {
      kind: 'ai',
      model: SOURCE_LABEL[source],
      conf: '—',
      text,
      html,
      resolveResult: {
        source,
        caseId: c.id,
        sessionId: step.sessionId,
        stepId: step.id,
        commandId: step.commandId,
        skillId: step.skillId,
        title,
        facts,
      },
    });
    persist();
  }

  /** 引継ぎへ渡す行。会話に残した結果だけを、出所を付けて並べる。 */
  function realResultLines(chat) {
    const messages = Array.isArray(chat?.messages) ? chat.messages : [];
    return messages
      .filter((message) => message?.resolveResult)
      .map((message) => {
        const r = message.resolveResult;
        const facts = (r.facts || []).map(([key, value]) => `${key}=${value}`).join(', ');
        return `${SOURCE_LABEL[r.source] || SOURCE_LABEL.unknown}｜${r.title}：${facts || '要点なし'}｜実行ID ${r.commandId || '-'}`;
      });
  }

  function currentCase() {
    try {
      return typeof curCase === 'function' ? curCase() : null;
    } catch (error) {
      return null;
    }
  }

  function stopPolling() {
    if (STATE.pollTimer) {
      clearInterval(STATE.pollTimer);
      STATE.pollTimer = null;
    }
  }

  function setState(patch) {
    Object.assign(STATE, patch);
    render(true);
  }

  async function start(expectedCaseId) {
    const c = currentCase();
    if (!c?.id || STATE.busy) return;
    // 会話に残った開始ボタンは、その相談の案件を開いているときだけ効く。
    if (expectedCaseId && expectedCaseId !== c.id) {
      toast?.('この相談の案件を開いてから開始してください', 'bad');
      return;
    }
    if (!isOwnerOf(c) || !c.chatId || caseFinished(c)) return;
    STATE.busy = true;
    STATE.error = null;
    try {
      if (!deviceId())
        throw new Error('この端末の ID を取得できません。PC情報を取得してからやり直してください。');
      // 再読み込み後でも、最終判断待ちのまま残っているセッションへ復帰する。
      // 復帰できなければ（解決済み・期限切れ・他人のセッション等）通常の新規開始へ進む。
      const pendingId = pendingSessionId(c.id);
      if (pendingId) {
        try {
          const pending = await api(`/api/resolve/sessions/${pendingId}`);
          const session = pending?.session;
          if (
            session?.status === 'waiting_continue' &&
            session?.lastSummary?.outcome === 'verified' &&
            !awaitingBlockedByVerify(session)
          ) {
            STATE.caseId = c.id;
            STATE.busy = false;
            await showAwaitingDecision(session);
            return;
          }
        } catch (error) {
          // 404/403 は復帰対象が消えているだけなので控えを捨てる。それ以外は下の新規開始で表面化する。
          if (error.status !== 404 && error.status !== 403) throw error;
        }
        forgetPending(pendingId, c.id);
      }
      let data;
      try {
        data = await api('/api/resolve/sessions', { caseId: c.id, deviceId: deviceId() });
      } catch (error) {
        if (error.status !== 404) throw error;
        // 画面の状態保存が届く前は 404 になることがあるため、少し待って 1 回だけ再試行する。
        await new Promise((resolve) => setTimeout(resolve, 700));
        data = await api('/api/resolve/sessions', { caseId: c.id, deviceId: deviceId() });
      }
      STATE.caseId = c.id;
      STATE.session = data.session;
      STATE.step = data.step;
      STATE.mode = data.step ? 'proposed' : 'stopped';
      rememberActive(c.id, data.step?.id);
      clearVerifyWait();
      STATE.busy = false;
      render(true);
    } catch (error) {
      STATE.busy = false;
      STATE.mode = 'error';
      STATE.error = String(error.message || error);
      render(true);
      toast?.(`解決ループを開始できませんでした: ${STATE.error}`, 'bad');
    }
  }

  async function approve(decision) {
    if (!STATE.step || STATE.busy) return;
    STATE.busy = true;
    STATE.error = null;
    try {
      if (decision === 'N') {
        const data = await api(`/api/resolve/steps/${STATE.step.id}/approve`, { decision: 'N' });
        STATE.session = data.session;
        STATE.step = data.step;
        STATE.mode = 'stopped';
        forgetActive(STATE.caseId);
        STATE.busy = false;
        render(true);
        return;
      }
      const payload = STATE.step.approvalChallenge?.payload;
      if (!payload) throw new Error('承認チャレンジがありません。もう一度開始してください。');
      const approvalHash = await sha256Hex(stableStringify(payload));
      const data = await api(`/api/resolve/steps/${STATE.step.id}/approve`, {
        decision: 'Y',
        approvalHash,
      });
      STATE.session = data.session;
      STATE.step = data.step;
      STATE.mode = 'executing';
      STATE.busy = false;
      rememberActive(STATE.caseId, data.step?.id);
      render(true);
      poll();
    } catch (error) {
      STATE.busy = false;
      STATE.error = String(error.message || error);
      // 期限切れ・状態の変化はこの提案では進められない。古いカードの Y を残さず開始へ戻す。
      if (['APPROVAL_EXPIRED', 'SESSION_EXPIRED', 'STEP_NOT_APPROVABLE'].includes(error.code)) {
        STATE.mode = 'error';
        STATE.step = null;
        if (error.code === 'APPROVAL_EXPIRED' && STATE.session?.id) {
          try {
            await api(`/api/resolve/sessions/${STATE.session.id}/stop`, {});
          } catch (stopError) {
            // 停止できなくてもセッションは 30 分で期限切れになる。
          }
        }
      }
      render(true);
      toast?.(`実行できませんでした: ${STATE.error}`, 'bad');
    }
  }

  function clearVerifyWait() {
    STATE.verifyWait = false;
    STATE.verifyTimedOut = false;
    STATE.verifyWaitTicks = 0;
    STATE.verifyWaitStartedAt = 0;
    STATE.verifySkillTitle = '';
  }

  function poll() {
    stopPolling();
    clearVerifyWait();
    STATE.pollTimer = setInterval(async () => {
      // 通常は「親ステップ実行中」。修復ステップ done 後は session だけ executing になる
      // （script 形態 verify の追撃）ため、その間も親ステップを追い続ける。
      const waitingVerify = STATE.mode === 'result' && STATE.verifyWait === true;
      if (!STATE.step || (STATE.mode !== 'executing' && !waitingVerify)) {
        stopPolling();
        return;
      }
      // 追撃待ちの上限。超えたら待機をやめて操作を人に返す（409 は既存のエラー表示に任せる）。
      if (waitingVerify) {
        STATE.verifyWaitTicks += 1;
        if (
          STATE.verifyWaitTicks >= VERIFY_WAIT_MAX_TICKS ||
          Date.now() - STATE.verifyWaitStartedAt >= VERIFY_WAIT_MAX_MS
        ) {
          stopPolling();
          STATE.verifyWait = false;
          STATE.verifyTimedOut = true;
          render(true);
          return;
        }
      }
      try {
        const data = await api(`/api/resolve/steps/${STATE.step.id}`);
        // 手動クローズ後に古いポーリング応答が返った場合は状態を巻き戻さない。
        const stillWaiting = STATE.mode === 'result' && STATE.verifyWait === true;
        if (STATE.mode !== 'executing' && !stillWaiting) return;
        STATE.session = data.session;
        STATE.step = data.step;
        const status = data.step?.status;
        if (status === 'done') {
          recordResult(data.step);
          // 追撃中は親ステップが done のままセッションだけ executing。ここで止めると
          // 「継続」が 409 STEP_NOT_CONTINUABLE になるため、executing が終わるまで待つ。
          if (data.session?.status === 'executing') {
            STATE.mode = 'result';
            STATE.verifyWait = true;
            STATE.verifyTimedOut = false;
            if (!STATE.verifyWaitStartedAt) STATE.verifyWaitStartedAt = Date.now();
            STATE.verifySkillTitle = String(
              data.activeStep?.skill?.title || data.activeStep?.skillId || '',
            );
          } else {
            // 追撃が終わったら通常の結果表示＋継続 Y/N に戻す（自動 continue はしない）。
            STATE.mode = 'result';
            clearVerifyWait();
            stopPolling();
          }
        } else if (status === 'failed') {
          forgetActive(STATE.caseId);
          STATE.mode = 'escalated';
          clearVerifyWait();
          stopPolling();
        } else if (status === 'rejected' || status === 'cancelled') {
          forgetActive(STATE.caseId);
          STATE.mode = 'stopped';
          clearVerifyWait();
          stopPolling();
        }
        render(true);
      } catch (error) {
        stopPolling();
        clearVerifyWait();
        STATE.mode = 'error';
        STATE.error = String(error.message || error);
        render(true);
      }
    }, 1500);
  }

  async function continueLoop(decision) {
    // 追撃（verify）の完了待ち中は継続できない（押下自体も disabled にしている）。
    if (!STATE.step || STATE.busy || STATE.verifyWait) return;
    STATE.busy = true;
    STATE.error = null;
    try {
      const data = await api(`/api/resolve/steps/${STATE.step.id}/continue`, { decision });
      // verify.ok で止まったセッションは次提案を返さない（step:null + awaitingResolution）。
      // ただし verify が未達・評価不能なら確認待ちにせず、従来どおりの分岐に任せる。
      if (
        data.awaitingResolution === true &&
        !awaitingBlockedByVerify(data.session ?? STATE.session)
      ) {
        STATE.busy = false;
        await showAwaitingDecision(data.session ?? STATE.session);
        return;
      }
      STATE.session = data.session;
      STATE.step = data.step;
      // 追撃待ちを抜けたので、待機・打ち切り表示の内部状態は持ち越さない。
      clearVerifyWait();
      if (data.step) {
        STATE.mode = 'proposed';
        rememberActive(STATE.caseId, data.step.id);
      } else if (data.session?.status === 'stopped') {
        STATE.mode = 'stopped';
      } else {
        STATE.mode = 'escalated';
      }
      STATE.busy = false;
      render(true);
    } catch (error) {
      // 2 回目以降の continue は 409 AWAITING_DECISION。エラーにせず同じ確認待ちカードへ合流する。
      if (error?.code === 'AWAITING_DECISION' && !awaitingBlockedByVerify(STATE.session)) {
        STATE.busy = false;
        await showAwaitingDecision(STATE.session);
        return;
      }
      STATE.busy = false;
      STATE.error = String(error.message || error);
      render(true);
      toast?.(`続行できませんでした: ${STATE.error}`, 'bad');
    }
  }

  async function manualClose(action) {
    if (!STATE.session?.id || STATE.busy) return;
    const actionCaseId = STATE.caseId;
    STATE.busy = true;
    STATE.error = null;
    try {
      const data = await api(`/api/resolve/sessions/${STATE.session.id}/${action}`, {});
      STATE.session = data.session;
      STATE.mode = action === 'resolve' ? 'resolved' : 'escalated';
      clearVerifyWait();
      // 確定したので、再読み込み復帰用の控えは残さない。
      forgetPending(data.session?.id);
      stopPolling();
      forgetActive(actionCaseId);
      followToWizard(action, actionCaseId);
    } catch (error) {
      STATE.error = String(error.message || error);
      toast?.(`操作できませんでした: ${STATE.error}`, 'bad');
    } finally {
      STATE.busy = false;
      render(true);
    }
  }

  /** 本人の判断を案件へつなげる。担当者へは STEP 4 の同意画面、解決は完了画面へ進む。 */
  function followToWizard(action, caseId) {
    try {
      const c = currentCase();
      // 操作の途中で別の案件を開いたら、そちらへは適用しない。
      if (caseId && c?.id !== caseId) return;
      if (!isOwnerOf(c) || !c.chatId || typeof ACT !== 'object' || caseFinished(c)) return;
      if (action === 'escalate' && typeof ACT.wHand === 'function') ACT.wHand();
      if (action === 'resolve' && typeof ACT.wSolved === 'function') ACT.wSolved();
    } catch (error) {
      // 画面遷移に失敗しても、サーバ側の状態は確定している。
    }
  }

  /*
   * 確認待ち（awaitingResolution）
   *
   * verify.ok で停止したセッションは `waiting_continue` のまま「解決した / 担当者へ」の
   * 最終判断を待つ。サーバは continue に対して 1 回目 200 + awaitingResolution、
   * 2 回目以降 409 AWAITING_DECISION を返すため、どちらも同じカードへ合流させる。
   */

  /** verify が「未達（ok:false）」または「評価不能（evaluated:false）」なら確認待ちにしない。 */
  function awaitingBlockedByVerify(session) {
    const verify = session?.lastSummary?.verify;
    if (!verify || typeof verify !== 'object') return false;
    return verify.ok === false || verify.evaluated === false;
  }

  /**
   * 確認待ちセッションの説明文。verify.description を最優先し、
   * 無ければ最後に実行した Skill 名、結果サマリ、最後に固定文言へフォールバックする。
   */
  function awaitingDescription() {
    const summary = STATE.session?.lastSummary || {};
    const verify = summary.verify && typeof summary.verify === 'object' ? summary.verify : null;
    const verifyDescription =
      verify && typeof verify.description === 'string' ? verify.description.trim() : '';
    if (verifyDescription) return verifyDescription;
    if (STATE.awaitingTitle) return `実行した対処: ${STATE.awaitingTitle}`;
    if (typeof summary.summary === 'string' && summary.summary.trim()) {
      return summary.summary.trim();
    }
    return '対象の操作は正常に完了しています。';
  }

  // 再読み込み後に確認待ちセッションへ復帰するための控え（案件ごと・セッション ID のみ）。
  function pendingKey(caseId) {
    return `aihd.resolve.awaiting.${caseId}`;
  }

  function rememberPending(sessionId) {
    const caseId = STATE.caseId || currentCase()?.id;
    if (!caseId || !sessionId) return;
    try {
      window.localStorage?.setItem(pendingKey(caseId), String(sessionId));
    } catch {
      // 保存できなくてもカード表示自体は成立する（再読み込み復帰だけが効かなくなる）。
    }
  }

  /**
   * 控えを消す。sessionId を渡した場合は、控えがそのセッションと一致するときだけ消す
   * （別セッションの控えを誤って消さない）。caseId は開始直後など STATE より確実なときだけ渡す。
   */
  function forgetPending(sessionId, caseIdOverride) {
    const caseId = caseIdOverride || STATE.caseId || currentCase()?.id;
    if (!caseId) return;
    try {
      if (sessionId && pendingSessionId(caseId) !== String(sessionId)) return;
      window.localStorage?.removeItem(pendingKey(caseId));
    } catch {
      // localStorage が使えない環境では何もしない。
    }
  }

  function pendingSessionId(caseId) {
    try {
      return window.localStorage?.getItem(pendingKey(caseId)) || '';
    } catch {
      return '';
    }
  }

  /**
   * 確認待ちカードを表示する。呼び出し前に busy を解除しておくこと。
   * 最後に実行した Skill 名を取るためにセッション詳細を取り直すが、
   * 取得できなくてもカードは出したままにする（状態は壊さない）。
   */
  async function showAwaitingDecision(session) {
    stopPolling();
    STATE.step = null;
    if (session) STATE.session = session;
    STATE.mode = 'awaiting';
    STATE.error = null;
    STATE.awaitingTitle = '';
    clearVerifyWait();
    rememberPending(STATE.session?.id);
    render(true);
    const sessionId = STATE.session?.id;
    if (!sessionId) return;
    try {
      const data = await api(`/api/resolve/sessions/${sessionId}`);
      // 応答が遅れて届いた場合に、別のモードへ上書きしない。
      if (STATE.mode !== 'awaiting') return;
      if (data?.session) STATE.session = data.session;
      const steps = Array.isArray(data?.steps) ? data.steps : [];
      const lastDone = [...steps].reverse().find((step) => step?.status === 'done');
      STATE.awaitingTitle = String(lastDone?.skillTitle || lastDone?.skillId || '');
      const status = STATE.session?.status;
      if (status === 'resolved') STATE.mode = 'resolved';
      else if (status === 'escalated') STATE.mode = 'escalated';
      else if (status === 'stopped' || status === 'expired') STATE.mode = 'stopped';
      if (STATE.mode !== 'awaiting') forgetPending(sessionId);
      render(true);
    } catch {
      // 付加情報が取れなくても確認待ちカードは表示済み。ここでは状態を変えない。
    }
  }

  /** 確認待ちカードの「解決した / 担当者へ引き継ぐ」。 */
  async function decideAwaiting(action) {
    if (!STATE.session?.id || STATE.busy) return;
    if (action !== 'resolve' && action !== 'escalate') return;
    const actionCaseId = STATE.caseId;
    STATE.busy = true;
    STATE.error = null;
    render(true);
    try {
      const reason =
        action === 'resolve'
          ? '利用者が解決確認カードで「解決した」を選択'
          : '利用者が解決確認カードで「担当者へ引き継ぐ」を選択';
      const data = await api(`/api/resolve/sessions/${STATE.session.id}/${action}`, { reason });
      if (data?.session) STATE.session = data.session;
      forgetPending(STATE.session.id);
      // セッション状態を取り直してから既存の完了表示へ合流する（失敗しても表示は続行）。
      try {
        const latest = await api(`/api/resolve/sessions/${STATE.session.id}`);
        if (latest?.session) STATE.session = latest.session;
      } catch {
        // 取得できなくても POST の応答で表示は成立する。
      }
      stopPolling();
      STATE.mode = action === 'resolve' ? 'resolved' : 'escalated';
      forgetActive(actionCaseId);
      followToWizard(action, actionCaseId);
    } catch (error) {
      STATE.error = String(error.message || error);
      toast?.(`操作できませんでした: ${STATE.error}`, 'bad');
    } finally {
      STATE.busy = false;
      render(true);
    }
  }

  async function loadAdminPending() {
    if (STATE.adminLoaded) return;
    // 管理者でなければ呼ばない（403 のコンソールノイズを避ける）。
    // 判定はサーバが返す /api/me の resolveAdmin（UI の自己申告は信用しない）。
    if (STATE.resolveAdmin === undefined) {
      try {
        const me = await api('/api/me');
        STATE.resolveAdmin = me?.resolveAdmin === true;
      } catch (error) {
        STATE.resolveAdmin = false;
      }
    }
    if (!STATE.resolveAdmin) {
      STATE.adminLoaded = true;
      return;
    }
    STATE.adminLoaded = true;
    try {
      const data = await api('/api/resolve/admin/pending');
      STATE.adminItems = Array.isArray(data.items) ? data.items : [];
    } catch (error) {
      // 管理者でなければ 403。承認待ちは表示しない（存在も漏らさない）。
      STATE.adminItems = [];
      // 403 以外は一時障害の可能性があるため、次回の定期更新で再試行する。
      if (error.status !== 403 && error.status !== 401) STATE.adminLoaded = false;
    }
    render(true);
  }

  async function adminApprove(index) {
    const item = STATE.adminItems?.[index];
    if (!item || STATE.busy) return;
    STATE.busy = true;
    STATE.error = null;
    try {
      const payload = item.adminApprovalChallenge?.payload;
      if (!payload) throw new Error('承認チャレンジがありません。再読み込みしてください。');
      const approvalHash = await sha256Hex(stableStringify(payload));
      await api(`/api/resolve/steps/${item.stepId}/admin-approve`, {
        decision: 'Y',
        approvalHash,
      });
      STATE.adminItems = STATE.adminItems.filter((candidate) => candidate.stepId !== item.stepId);
      toast?.('IT管理者として承認しました。依頼者本人の実行確認待ちです。', 'ok');
    } catch (error) {
      STATE.error = String(error.message || error);
      toast?.(`承認できませんでした: ${STATE.error}`, 'bad');
    } finally {
      STATE.busy = false;
      render(true);
    }
  }

  async function stop() {
    if (!STATE.session?.id || STATE.busy) return;
    // 追撃（verify）の完了待ち中は中止できない（押下自体も disabled にしている）。
    if (STATE.verifyWait) return;
    STATE.busy = true;
    try {
      const data = await api(`/api/resolve/sessions/${STATE.session.id}/stop`, {});
      STATE.session = data.session;
      STATE.mode = 'stopped';
      clearVerifyWait();
      // 停止したセッションは最終判断待ちではないので、復帰用の控えを消す。
      forgetPending(data.session?.id);
      forgetActive(STATE.caseId);
      stopPolling();
    } catch (error) {
      STATE.error = String(error.message || error);
    } finally {
      STATE.busy = false;
      render(true);
    }
  }

  function reset() {
    stopPolling();
    STATE.caseId = null;
    STATE.session = null;
    STATE.step = null;
    STATE.mode = 'idle';
    STATE.busy = false;
    STATE.error = null;
    STATE.awaitingTitle = '';
    clearVerifyWait();
    render(true);
  }

  function resultText(step) {
    const summary = step?.resultSummary;
    if (!summary) return '';
    const lines = [];
    if (summary.summary) lines.push(String(summary.summary));
    if (summary.normalized && typeof summary.normalized === 'object') {
      lines.push(JSON.stringify(summary.normalized, null, 2));
    }
    return lines.join('\n\n');
  }

  function render(force) {
    const c = currentCase();
    const caseId = c?.id ?? null;
    if (STATE.caseId && caseId !== STATE.caseId && STATE.mode !== 'idle') reset();
    const key = JSON.stringify({
      id: caseId,
      mode: STATE.mode,
      step: STATE.step?.id,
      status: STATE.step?.status,
      busy: STATE.busy,
      error: STATE.error,
      session: STATE.session?.status,
      awaitingTitle: STATE.awaitingTitle,
      verifyWait: STATE.verifyWait,
      verifyTimedOut: STATE.verifyTimedOut,
      verifySkillTitle: STATE.verifySkillTitle,
      agent: STATE.agentConnected,
      owner: isOwnerOf(c),
      sent: Boolean(c?.chatId),
      finished: caseFinished(c),
    });
    const panel = document.getElementById('aihdResolvePanel');
    if (!panel) return;
    if (!force && key === STATE.lastKey) return;
    STATE.lastKey = key;

    if (!caseId) {
      panel.innerHTML = '<div class="u-small u-muted">案件を開くと解決ループを開始できます。</div>';
      return;
    }

    const header =
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">' +
      '<b>🧭 解決ループ（読み取り診断）</b>' +
      '<span class="u-small u-muted">' +
      (STATE.session
        ? `ステップ ${STATE.session.stepCount}/${STATE.session.maxSteps}・${esc(STATE.session.status)}`
        : '未開始') +
      '</span></div>';

    let body = '';
    const finished = caseFinished(c) && STATE.mode !== 'executing';
    // 確認待ちカードのボタンは押下中に無効化する（二重送信防止）。他モードの markup は変えない。
    const awaitingDisabled = STATE.busy ? ' disabled' : '';
    if (finished) {
      body =
        '<div class="u-small u-muted" style="margin-top:6px">この案件は引継ぎ済み、または完了しています。読み取り診断は新しい相談から行えます。</div>';
    } else if (STATE.mode === 'idle') {
      if (!isOwnerOf(c)) {
        body =
          '<div class="u-small u-muted" style="margin-top:6px">読み取り診断は相談した本人が行います。</div>';
      } else if (!c.chatId) {
        body =
          '<div class="u-small u-muted" style="margin-top:6px">相談を送ると、この端末の状態を読み取って確認できます。</div>';
      } else if (STATE.agentConnected !== true) {
        body =
          '<div class="u-small" style="margin-top:6px" data-aihd-no-agent>' +
          esc(
            STATE.agentConnected === null
              ? '端末エージェントの接続を確認しています…'
              : NO_AGENT_NOTICE,
          ) +
          '</div>' +
          (STATE.agentConnected === null
            ? ''
            : `<div class="u-small u-muted" style="margin-top:4px">導入時に使う端末 ID（browserDeviceId）: <span class="u-mono">${esc(deviceId() || '不明')}</span></div>` +
              '<div style="margin-top:8px"><button class="u-btn" data-aihd-resolve="handover">担当者へ引き継ぐ</button></div>');
      } else {
        body =
          '<div class="u-small u-muted" style="margin-top:6px">まず PC の状態を読み取ります。実行のたびに内容を示して Y/N を確認します。</div>' +
          '<div style="margin-top:8px"><button class="u-btn pri" data-aihd-resolve="start">読み取り診断を開始</button></div>';
      }
    } else if (STATE.mode === 'proposed' && STATE.step) {
      const skill = STATE.step.skill || {};
      // 「読み取りのみ」と言えるのはリスク 1 で戻し方の定義が無い Skill だけ。
      const readOnly = Number(STATE.step.riskLevel) === 1 && !skill.rollback;
      body =
        '<div style="margin-top:8px"><b>' +
        esc(skill.title || STATE.step.skillId) +
        '</b> ' +
        (readOnly
          ? '<span class="u-sig g"><i></i>読み取りのみ</span>'
          : `<span class="u-sig y"><i></i>端末を変更します（リスク${esc(STATE.step.riskLevel)}）</span>`) +
        '</div>' +
        '<div class="u-small" style="margin-top:4px">' +
        esc(skill.summary || '') +
        '</div>' +
        (STATE.step.rationale
          ? '<div class="u-small u-muted" style="margin-top:4px">理由: ' +
            esc(STATE.step.rationale) +
            '</div>'
          : '') +
        '<div class="u-small" style="margin-top:4px">パラメータ: <span class="u-mono">' +
        esc(JSON.stringify(STATE.step.params || {})) +
        '</span></div>' +
        (STATE.step.requiresAdminApproval
          ? STATE.step.adminApprovedBy
            ? '<div class="u-small" style="margin-top:4px;color:#1f7a3f">IT管理者の承認済み: ' +
              esc(STATE.step.adminApprovedBy) +
              '</div>'
            : '<div class="u-small" style="margin-top:4px;color:#b42318">リスク4以上のため、IT管理者の承認が必要です（自己承認はできません）。</div>'
          : '') +
        '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">' +
        '<button class="u-btn pri" data-aihd-resolve="approve" data-decision="Y">実行する（Y）</button>' +
        '<button class="u-btn" data-aihd-resolve="approve" data-decision="N">やめる（N）</button>' +
        '<button class="u-btn" data-aihd-resolve="resolve">解決した</button>' +
        '<button class="u-btn" data-aihd-resolve="escalate">担当者へ</button>' +
        '<button class="u-btn" data-aihd-resolve="stop">中止</button></div>';
    } else if (STATE.mode === 'executing') {
      body =
        '<div style="margin-top:8px">端末で実行しています…</div>' +
        '<div class="u-small u-muted" style="margin-top:4px">端末エージェントが応答すると結果が表示されます。2 分応答が無い場合は自動で失敗します。</div>' +
        '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">' +
        '<button class="u-btn" data-aihd-resolve="stop">中止</button>' +
        '<button class="u-btn" data-aihd-resolve="escalate">担当者へ</button></div>';
    } else if (STATE.mode === 'result' && STATE.step) {
      // script 形態 verify の追撃実行中（親 done・session executing）は待機表示にし、
      // 継続 Y/N と中止を無効化する（409 STEP_NOT_CONTINUABLE を押させる前に防ぐ）。
      const waitingVerify = STATE.verifyWait === true;
      const verifyHold = waitingVerify ? ' disabled' : '';
      const source = sourceOfStep(STATE.step);
      const shapeBad = STATE.step.resultSummary?.resultShapeOk === false;
      body =
        '<div style="margin-top:8px" data-aihd-result-source="' +
        esc(source) +
        '"><b>結果：' +
        esc(SOURCE_LABEL[source]) +
        '</b></div>' +
        '<div class="u-small" style="margin-top:4px">読み取りの結果です。まだ解決とは判定していません。解決したかどうかはご本人が確認してください。</div>' +
        (shapeBad
          ? '<div class="u-small" style="margin-top:4px;color:#b42318">結果の形式が想定と異なります。内容を担当者に確認してください。</div>'
          : '') +
        '<pre class="u-small" style="white-space:pre-wrap;background:#f5f7fa;border:1px solid #d9e2ec;border-radius:6px;padding:8px;max-height:320px;overflow:auto">' +
        esc(resultText(STATE.step)) +
        '</pre>' +
        knowledgeRefsHtml(STATE.step) +
        (waitingVerify
          ? '<div class="u-small" style="margin-top:6px;color:#8a5a00">原因の対処を確認しています…' +
            (STATE.verifySkillTitle ? `（${esc(STATE.verifySkillTitle)}）` : '') +
            '</div>'
          : '') +
        (STATE.verifyTimedOut === true
          ? '<div class="u-small" style="margin-top:6px;color:#b42318">確認が完了しませんでした。時間をおいて「続ける」を押すか、担当者へ引き継いでください。</div>'
          : '') +
        '<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">' +
        `<button class="u-btn pri" data-aihd-resolve="continue" data-decision="Y"${verifyHold}>続ける（Y）</button>` +
        `<button class="u-btn" data-aihd-resolve="continue" data-decision="N"${verifyHold}>やめる（N）</button>` +
        '<button class="u-btn pri" data-aihd-resolve="resolve">解決した</button>' +
        '<button class="u-btn" data-aihd-resolve="escalate">担当者へ</button>' +
        `<button class="u-btn" data-aihd-resolve="stop"${verifyHold}>中止</button></div>`;
    } else if (STATE.mode === 'awaiting') {
      // 説明文そのものは innerHTML に入れず、描画後に textContent で差し込む（XSS 対策）。
      body =
        '<div style="margin-top:8px;padding:10px;border:1px solid #bfe3c6;background:#f3fbf5;border-radius:8px">' +
        '<div><b>対処後の確認が通りました</b></div>' +
        '<div class="u-small" style="margin-top:6px;white-space:pre-wrap" data-aihd-awaiting-desc></div>' +
        '<div style="margin-top:6px">解決しましたか？</div>' +
        '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">' +
        '<button class="u-btn pri" data-aihd-resolve="decide" data-decision="resolve"' +
        awaitingDisabled +
        '>解決した</button>' +
        '<button class="u-btn" data-aihd-resolve="decide" data-decision="escalate"' +
        awaitingDisabled +
        '>担当者へ引き継ぐ</button>' +
        '</div></div>';
    } else if (STATE.mode === 'stopped') {
      body =
        '<div style="margin-top:8px">解決ループを停止しました。必要ならやり直せます。</div>' +
        '<div style="margin-top:8px"><button class="u-btn" data-aihd-resolve="start">もう一度開始</button></div>';
    } else if (STATE.mode === 'resolved') {
      body =
        '<div style="margin-top:8px">解決済みにしました。必要ならナレッジ化してください。</div>' +
        '<div style="margin-top:8px"><button class="u-btn" data-aihd-resolve="start">もう一度開始</button></div>';
    } else if (STATE.mode === 'escalated') {
      body =
        '<div style="margin-top:8px">自動の読み取り診断では解決できませんでした。担当者へ引き継いでください。</div>' +
        (STATE.step?.error
          ? '<div class="u-small u-muted" style="margin-top:4px">' +
            esc(STATE.step.error) +
            '</div>'
          : '') +
        '<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">' +
        '<button class="u-btn pri" data-aihd-resolve="handover">担当者へ引き継ぐ</button>' +
        '<button class="u-btn" data-aihd-resolve="start">もう一度開始</button></div>';
    } else if (STATE.mode === 'error') {
      body =
        '<div style="margin-top:8px;color:#b42318">' +
        esc(STATE.error || 'エラーが発生しました。') +
        '</div>' +
        '<div style="margin-top:8px"><button class="u-btn" data-aihd-resolve="start">もう一度開始</button></div>';
    }

    // カードは案件ウィザードの下にあるので、状態が変わったら見える位置へ動かす。
    const modeChanged = STATE.lastMode !== STATE.mode;
    STATE.lastMode = STATE.mode;
    panel.innerHTML =
      header +
      (body || '') +
      (STATE.error && STATE.mode !== 'error'
        ? `<div class="u-small" style="margin-top:6px;color:#b42318">${esc(STATE.error)}</div>`
        : '') +
      adminPanelHtml() +
      (STATE.busy ? '<div class="u-small u-muted" style="margin-top:6px">処理中…</div>' : '');

    // 説明文は innerHTML に混ぜず textContent で入れる（端末結果由来の文字列を HTML として
    // 解釈させない）。確認待ち以外のモードでは該当要素が無いので何もしない。
    const awaitingDescNode = panel.querySelector?.('[data-aihd-awaiting-desc]');
    if (awaitingDescNode) awaitingDescNode.textContent = awaitingDescription();
    if (modeChanged && STATE.mode !== 'idle') panel.scrollIntoView?.({ block: 'nearest' });
  }

  function adminPanelHtml() {
    const items = STATE.adminItems || [];
    if (!items.length) return '';
    return (
      '<div style="margin-top:12px;border-top:1px solid #d9e2ec;padding-top:8px">' +
      '<div class="u-small"><b>IT管理者の承認待ち（リスク4以上）</b></div>' +
      items
        .map(
          (item, index) =>
            '<div class="u-small" style="margin-top:6px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
            '<span>' +
            esc(item.skillTitle) +
            ' / ' +
            esc(item.requester) +
            ' / リスク' +
            esc(item.riskLevel) +
            '</span>' +
            '<button class="u-btn" data-aihd-resolve="admin-approve" data-index="' +
            index +
            '">承認</button></div>',
        )
        .join('') +
      '</div>'
    );
  }

  /** 再読み込み・案件の切替の後、同じセッションへ戻る（結果の取りこぼしと二重開始を防ぐ）。 */
  async function restoreActive(c) {
    let stepId = '';
    try {
      stepId = window.localStorage?.getItem(activeKey(c.id)) || '';
    } catch (error) {
      stepId = '';
    }
    if (!stepId || !isOwnerOf(c)) return;
    try {
      const data = await api(`/api/resolve/steps/${encodeURIComponent(stepId)}`);
      if (currentCase()?.id !== c.id || STATE.mode !== 'idle') return;
      const sessionStatus = data.session?.status;
      if (
        data.session?.caseId !== c.id ||
        !['waiting_execute', 'executing', 'waiting_continue'].includes(sessionStatus)
      ) {
        forgetActive(c.id);
        return;
      }
      STATE.caseId = c.id;
      STATE.session = data.session;
      STATE.step = data.step;
      if (sessionStatus === 'waiting_execute') {
        STATE.mode = 'proposed';
      } else if (data.step?.status === 'done') {
        recordResult(data.step);
        if (sessionStatus === 'executing') {
          STATE.mode = 'result';
          poll();
          STATE.verifyWait = true;
          STATE.verifyWaitStartedAt = Date.now();
        } else if (
          data.session?.lastSummary?.outcome === 'verified' &&
          !awaitingBlockedByVerify(data.session)
        ) {
          await showAwaitingDecision(data.session);
          return;
        } else {
          STATE.mode = 'result';
        }
      } else {
        STATE.mode = 'executing';
        poll();
      }
      render(true);
    } catch (error) {
      if (error.status === 404 || error.status === 403) forgetActive(c.id);
    }
  }

  function ensurePanel() {
    const c = currentCase();
    if (!c?.id) return;
    if (!document.querySelector('#wzPane')) return;
    if (STATE.restoredFor !== c.id) {
      STATE.restoredFor = c.id;
      if (STATE.mode === 'idle' && !caseFinished(c)) void restoreActive(c);
    }
    let panel = document.getElementById('aihdResolvePanel');
    if (!panel) {
      const wiz = document.querySelector('.w-wiz');
      if (!wiz || !wiz.parentNode) return;
      panel = document.createElement('div');
      panel.id = 'aihdResolvePanel';
      panel.className = 'u-card';
      panel.style.cssText = 'margin-top:12px;padding:12px';
      wiz.parentNode.insertBefore(panel, wiz.nextSibling);
      // アプリの再描画でパネルが作り直された直後は、前回の key が残っていて
      // 描画がスキップされることがある。新しい要素には必ず描画する。
      STATE.lastKey = '';
      render(true);
      void loadAdminPending();
      if (STATE.agentConnected === null) void refreshDeviceStatus().then(() => render(true));
      return;
    }
    render(false);
  }

  document.addEventListener('click', (event) => {
    const button = event.target?.closest?.('[data-aihd-resolve]');
    if (!button) return;
    const action = button.getAttribute('data-aihd-resolve');
    const decision = button.getAttribute('data-decision') || 'Y';
    if (action === 'start') void start(button.getAttribute('data-case') || '');
    else if (action === 'approve') void approve(decision);
    else if (action === 'continue') void continueLoop(decision);
    else if (action === 'stop') void stop();
    else if (action === 'resolve') void manualClose('resolve');
    else if (action === 'escalate') void manualClose('escalate');
    else if (action === 'decide') void decideAwaiting(decision);
    else if (action === 'handover') followToWizard('escalate');
    else if (action === 'admin-approve')
      void adminApprove(Number(button.getAttribute('data-index') || '0'));
  });

  // 承認待ちは画面を開いた後に増えるため、60 秒ごとに取り直す。
  setInterval(() => {
    STATE.adminLoaded = false;
    void loadAdminPending();
  }, 60_000);

  /*
   * 印刷の相談の導線（docs/14 §2-12）。
   * 固定データの確認カード（confirmHearing）と診断（H.print）へ進めない。
   * 他の相談の導線は変えない。
   */
  function printGuideHtml(connected, c) {
    if (connected) {
      return (
        '<p>この端末は端末エージェントに接続されています。下の「解決ループ（読み取り診断）」で実際の状態を読み取れます。実行の前に必ず確認します。</p>' +
        '<div class="btns"><button class="btn sm" data-aihd-resolve="start" data-case="' +
        esc(c?.id || '') +
        '">読み取り診断を開始</button></div>'
      );
    }
    return `<p>${esc(NO_AGENT_NOTICE)}</p><div class="btns">${
      typeof escBtn === 'function' ? escBtn('IT端末', '通常', '担当者へ引き継ぐ') : ''
    }</div>`;
  }

  async function routePrintToRealDiagnosis(chat) {
    const c = caseOfChat(chat);
    try {
      UI.typing = true;
      if (typeof refresh === 'function') refresh();
    } catch (error) {
      // 初期化前は表示なしで続行する。
    }
    const connected = c ? await refreshDeviceStatus() : false;
    try {
      UI.typing = false;
    } catch (error) {
      // 初期化前は何もしない。
    }
    if (c) c.realPath = connected ? 'agent' : 'no-agent';
    if (!c) {
      // 案件の無い会話には解決ループのカードが無く、接続も確かめていない。未接続とは言わない。
      const notice =
        '端末の読み取り診断は「新しい相談」の案件から行えます。担当者へ引き継ぐこともできます。';
      addMsg(chat, {
        kind: 'ai',
        model: 'システム',
        conf: '—',
        text: notice,
        html: `<p>${esc(notice)}</p><div class="btns">${
          typeof escBtn === 'function' ? escBtn('IT端末', '通常', '担当者へ引き継ぐ') : ''
        }</div>`,
      });
      persist();
      return;
    }
    addMsg(chat, {
      kind: 'ai',
      model: 'システム',
      conf: '—',
      resolveGuide: true,
      text: connected
        ? '端末エージェントが接続されています。読み取り診断へ案内しました。'
        : NO_AGENT_NOTICE,
      html: printGuideHtml(connected, c),
    });
    persist();
    // STEP 3 の説明は部分更新（wizSoft）では描き直されないので全体を描き直す。
    try {
      if (typeof uxRender === 'function' && S.ui.screen === 'wizard') uxRender();
    } catch (error) {
      // 表示の更新に失敗しても案内は会話に残っている。
    }
    render(true);
  }

  try {
    if (typeof CONFIRM_INTENTS === 'object' && CONFIRM_INTENTS) delete CONFIRM_INTENTS.print;
    if (typeof H === 'object' && H && typeof H.print === 'function') {
      H.print = (chat) => {
        void routePrintToRealDiagnosis(chat);
      };
    }
  } catch (error) {
    // 導線の差し替えに失敗しても画面は止めない。
  }

  /** STEP 3 の説明と信号の理由は、固定データの案内のままにしない。 */
  function wrapGlobal(name, build) {
    if (typeof window[name] === 'function') window[name] = build(window[name]);
  }

  wrapGlobal('paneHtml', (original) => (target, ...rest) => {
    const html = original(target, ...rest);
    if (typeof html !== 'string' || !target) return html;
    let out = html;
    if (target.realPath && target.step === 3) {
      out = out.replace(
        /(<h3>AIの一次対応<\/h3><p class="lead">)[^<]*(<\/p>)/,
        (_, head, tail) =>
          `${head}印刷の相談は、端末エージェントが接続された端末の状態を読み取って確認します。実行のたびに、あなたが Y／N で答えます。${tail}`,
      );
    }
    if (target.step === 4 && out.includes('class="w-share"')) {
      const lines = realResultLines(chatOfCase(target));
      if (lines.length) {
        const checked = target.share?.realDiag !== false ? 'checked' : '';
        const row =
          `<label><input type="checkbox" data-w="share" data-k="realDiag" ${checked}>` +
          `<span><b>${esc(SHARE_KEY)}</b><br><span class="u-small u-muted">${lines.map(esc).join('<br>')}</span></span></label>`;
        out = out.replace('<div class="w-share">', () => `<div class="w-share">${row}`);
      }
    }
    return out;
  });

  wrapGlobal('asideHtml', (original) => (target, ...rest) => {
    const html = original(target, ...rest);
    if (typeof html !== 'string' || !target?.realPath) return html;
    return html.replace(
      /定型の相談は[^<]*で対応しています/,
      '印刷の相談は端末の読み取り結果をもとに本人が確認しています',
    );
  });

  // 引継ぎ: 会話に残した結果だけを、固定データとは別の項目で本人の同意のもとに渡す。
  wrapGlobal('consentCard', (original) => (chat, ...rest) => {
    const message = original(chat, ...rest);
    if (message?.ctx) {
      const lines = realResultLines(chat);
      if (lines.length) message.ctx.realDiag = lines;
    }
    return message;
  });

  wrapGlobal('renderConsent', (original) => (message) => {
    const html = original(message);
    const lines = message?.ctx?.realDiag;
    if (typeof html !== 'string' || !Array.isArray(lines) || !lines.length) return html;
    const row =
      '<label style="display:block;margin:3px 0">' +
      `<input type="checkbox" data-ck="realDiag" data-mid="${esc(message.id)}" ${message.sel?.realDiag !== false ? 'checked' : ''}> ` +
      `${esc(SHARE_KEY)}（${lines.length}件）：${lines.map(esc).join(' / ')}</label>`;
    return html.replace(
      /<label style="display:block;margin:3px 0"><input type="checkbox" data-ck="device"/,
      (match) => row + match,
    );
  });

  function withholdResults(chat) {
    for (const item of chat?.messages || []) {
      if (!item?.resolveResult) continue;
      item.resolveResult.facts = [];
      item.resolveResult.withheld = true;
      item.text = '【本人が共有しないことを選択】読み取り診断の結果';
      item.html = `<p class="small muted">${esc(item.text)}</p>`;
    }
  }

  let pendingShare = null;
  wrapGlobal('createTicket', (original) => (state, options) => {
    if (!pendingShare || !options?.shared) return original(state, options);
    return original(
      state,
      Object.assign({}, options, {
        shared: Object.assign({}, options.shared, { [SHARE_KEY]: pendingShare }),
      }),
    );
  });
  try {
    if (typeof ACT === 'object' && ACT && typeof ACT.consentSend === 'function') {
      const originalConsentSend = ACT.consentSend;
      ACT.consentSend = (detail) => {
        const found = typeof findMsg === 'function' ? findMsg(detail?.mid) : [null, null];
        const message = found?.[1];
        const lines = message?.ctx?.realDiag;
        pendingShare =
          Array.isArray(lines) && lines.length && message.sel?.realDiag !== false ? lines : null;
        // 共有しないと選んだら、会話の写し（担当者・AI 文脈・報告書が読む）からも値を除く。
        // 結果の正本はサーバの resolution_steps に残る。
        if (Array.isArray(lines) && lines.length && !pendingShare) withholdResults(found?.[0]);
        try {
          return originalConsentSend(detail);
        } finally {
          pendingShare = null;
        }
      };
    }
  } catch (error) {
    // 引継ぎ本体は止めない。
  }

  window.__AIHD_RESOLVE__ = { realResultLines, sourceOfStep, SOURCE_LABEL, NO_AGENT_NOTICE };

  // 接続状態は開始待ちの間だけ取り直す（実行中は承認・ポーリングの結果で分かる）。
  setInterval(() => {
    const c = currentCase();
    if (!c?.chatId || STATE.mode !== 'idle' || !document.getElementById('aihdResolvePanel')) return;
    void refreshDeviceStatus().then(() => render(false));
  }, 20_000);

  setInterval(ensurePanel, 800);
  window.addEventListener('load', ensurePanel, { once: true });
})();
