/*
 * AI HelpDesk resolve bridge（解決ループ / Phase B）
 *
 * 既存プロトタイプ HTML は変更しない。このブリッジだけを追加する。
 * - 案件ウィザードの下に「解決ループ（読み取り診断）」カードを出す。
 * - サーバの /api/resolve/* と連携し、実行前 Y/N → 結果 → 継続 Y/N を繰り返す。
 * - 診断のみ（読み取り専用）。コマンド文字列の編集はできない。
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
    // 確認待ちカードの説明文に使う「最後に実行した Skill」の表示名（取得できたときだけ入る）。
    awaitingTitle: '',
    // 修復ステップ done 後の script 形態 verify 追撃待ち（session だけ executing の中間状態）。
    verifyWait: false,
    verifyTimedOut: false,
    verifyWaitTicks: 0,
    verifyWaitStartedAt: 0,
    verifySkillTitle: '',
  };

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

  function deviceId() {
    return (
      window.__AIHD_DEVICE_ID__ ||
      (typeof USERS !== 'undefined' && USERS[S?.ui?.user]?.device) ||
      'WEB-UNKNOWN'
    );
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

  async function start() {
    const c = currentCase();
    if (!c?.id || STATE.busy) return;
    STATE.busy = true;
    STATE.error = null;
    try {
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
      render(true);
      poll();
    } catch (error) {
      STATE.busy = false;
      STATE.error = String(error.message || error);
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
          STATE.mode = 'escalated';
          clearVerifyWait();
          stopPolling();
        } else if (status === 'rejected' || status === 'cancelled') {
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
    } catch (error) {
      STATE.error = String(error.message || error);
      toast?.(`操作できませんでした: ${STATE.error}`, 'bad');
    } finally {
      STATE.busy = false;
      render(true);
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
    // 確認待ちカードのボタンは押下中に無効化する（二重送信防止）。他モードの markup は変えない。
    const awaitingDisabled = STATE.busy ? ' disabled' : '';
    if (STATE.mode === 'idle') {
      body =
        '<div class="u-small u-muted" style="margin-top:6px">PCの状態を読み取るだけで、変更は行いません。実行のたびに Y/N を確認します。</div>' +
        '<div style="margin-top:8px"><button class="u-btn pri" data-aihd-resolve="start">読み取り診断を開始</button></div>';
    } else if (STATE.mode === 'proposed' && STATE.step) {
      const skill = STATE.step.skill || {};
      body =
        '<div style="margin-top:8px"><b>' +
        esc(skill.title || STATE.step.skillId) +
        '</b> <span class="u-sig g"><i></i>読み取りのみ</span></div>' +
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
        '<div style="margin-top:8px">端末で読み取りを実行しています…</div>' +
        '<div class="u-small u-muted" style="margin-top:4px">端末エージェントが応答すると結果が表示されます。2 分応答が無い場合は自動で失敗します。</div>' +
        '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">' +
        '<button class="u-btn" data-aihd-resolve="stop">中止</button>' +
        '<button class="u-btn" data-aihd-resolve="escalate">担当者へ</button></div>';
    } else if (STATE.mode === 'result' && STATE.step) {
      // script 形態 verify の追撃実行中（親 done・session executing）は待機表示にし、
      // 継続 Y/N と中止を無効化する（409 STEP_NOT_CONTINUABLE を押させる前に防ぐ）。
      const waitingVerify = STATE.verifyWait === true;
      const verifyHold = waitingVerify ? ' disabled' : '';
      body =
        '<div style="margin-top:8px"><b>結果</b></div>' +
        '<pre class="u-small" style="white-space:pre-wrap;background:#f5f7fa;border:1px solid #d9e2ec;border-radius:6px;padding:8px;max-height:320px;overflow:auto">' +
        esc(resultText(STATE.step)) +
        '</pre>' +
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
        '<div><b>原因の対処まで完了しました</b></div>' +
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
        '<div style="margin-top:8px"><button class="u-btn" data-aihd-resolve="start">もう一度開始</button></div>';
    } else if (STATE.mode === 'error') {
      body =
        '<div style="margin-top:8px;color:#b42318">' +
        esc(STATE.error || 'エラーが発生しました。') +
        '</div>' +
        '<div style="margin-top:8px"><button class="u-btn" data-aihd-resolve="start">もう一度開始</button></div>';
    }

    panel.innerHTML =
      header +
      (body || '') +
      adminPanelHtml() +
      (STATE.busy ? '<div class="u-small u-muted" style="margin-top:6px">処理中…</div>' : '');

    // 説明文は innerHTML に混ぜず textContent で入れる（端末結果由来の文字列を HTML として
    // 解釈させない）。確認待ち以外のモードでは該当要素が無いので何もしない。
    const awaitingDescNode = panel.querySelector?.('[data-aihd-awaiting-desc]');
    if (awaitingDescNode) awaitingDescNode.textContent = awaitingDescription();
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

  function ensurePanel() {
    const c = currentCase();
    if (!c?.id) return;
    if (!document.querySelector('#wzPane')) return;
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
      return;
    }
    render(false);
  }

  document.addEventListener('click', (event) => {
    const button = event.target?.closest?.('[data-aihd-resolve]');
    if (!button) return;
    const action = button.getAttribute('data-aihd-resolve');
    const decision = button.getAttribute('data-decision') || 'Y';
    if (action === 'start') void start();
    else if (action === 'approve') void approve(decision);
    else if (action === 'continue') void continueLoop(decision);
    else if (action === 'stop') void stop();
    else if (action === 'resolve') void manualClose('resolve');
    else if (action === 'escalate') void manualClose('escalate');
    else if (action === 'decide') void decideAwaiting(decision);
    else if (action === 'admin-approve')
      void adminApprove(Number(button.getAttribute('data-index') || '0'));
  });

  // 承認待ちは画面を開いた後に増えるため、60 秒ごとに取り直す。
  setInterval(() => {
    STATE.adminLoaded = false;
    void loadAdminPending();
  }, 60_000);

  setInterval(ensurePanel, 800);
  window.addEventListener('load', ensurePanel, { once: true });
})();
