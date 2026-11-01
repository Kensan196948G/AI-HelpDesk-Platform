/*
 * AI HelpDesk 共通支援セッションの本人パネル（docs/63。MVP）
 *
 * 機能フラグが有効なときだけ配信される。原本 HTML / CSS は変更しない。
 * 本人が、操作範囲と AI 入力の同意、提案の確認、Y/N、結果の確認、解決確認、取消を行う。
 * 描画は textContent のみ（HTML 文字列を組み立てない）。画面状態やブラウザの保存領域へ書かない。
 * 権限と成否の判定はサーバで行う。この画面の表示は判定の根拠にならない。
 */
(() => {
  if (window.__AIHD_SUPPORT_SESSION_BRIDGE__) return;
  window.__AIHD_SUPPORT_SESSION_BRIDGE__ = { version: 1 };

  const STATUS_LABEL = {
    binding_pending: '端末の確認待ち',
    consent_pending: '同意待ち',
    ready: '提案の準備完了',
    proposing: '提案を作成中',
    awaiting_approval: '確認待ち（Y/N）',
    approved: '実行待ち',
    executing: '実行中',
    verifying: '確認中',
    awaiting_next: '次の操作を確認',
    resolve_confirm: '解決の確認待ち',
    resolved: '解決',
    stopped: '停止',
    escalated: '担当者へ引継ぎ',
    expired: '期限切れ',
    revoked: '取消',
  };
  const END_LABEL = {
    resolved: 'ご本人の確認で解決としました。',
    requester_revoked: 'ご本人が取り消しました。',
    requester_declined: 'ご本人が「いいえ」を選びました。何も実行していません。',
    operator_stop: '担当者が中止しました。',
    expired: '期限が切れました。',
    approval_expired: '確認の期限（5 分）が切れました。実行していません。',
    execution_expired: '実行の期限が切れました。',
    execution_timeout: '時間内に結果が届きませんでした。成功とは扱いません。',
    proposing_timeout: '提案を作成できないまま時間が過ぎたため停止しました。',
    ai_consent_changed: 'AI 入力の同意が変わったため停止しました。提案は使っていません。',
    assignee_changed: '担当者または案件の状態が変わりました。',
    session_changed: 'Windows のセッションが変わりました。',
    user_logged_off: 'ログオフ、または端末との接続が切れました。',
    helper_revoked: 'ヘルパーが無効になりました。',
    lease_conflict: '貸与情報が一致しなくなりました。',
    device_mismatch: '端末の照合が一致しませんでした。',
    sid_mismatch: 'Windows ユーザーが一致しませんでした。',
    binding_changed: '確認した内容から前提が変わったため停止しました。',
    session_not_active: 'Windows のセッションがアクティブではありません。',
    proposal_limit: '提案の上限（6 件）に達しました。',
    duplicate_proposal: '同じ操作の提案になったため停止しました。',
    no_progress: '結果が変わらないため停止しました。',
    no_candidate: '提案できる操作がありません。',
    execution_failed: '実行に失敗しました。',
    verify_failed: '成功条件を満たしませんでした。',
    unverifiable: '結果を確認できないため、成功とは扱いません。',
    result_mismatch: '結果の報告が実行内容と一致しないため、成功とは扱いません。',
    ai_stop: 'AI が提案を終了しました。解決とは扱いません。',
    escalated: '担当者へ引き継ぎます。',
  };
  const EFFECT_LABEL = { read: '読み取り', modify: '変更（元に戻せる範囲）' };
  const SOURCE_LABEL = { deepseek: 'AI の提案', rule: 'ルールベースの提案' };
  const MODE_LABEL = {
    real: '端末で実行',
    mock: 'デモ（証拠にしません）',
    manual: '手動記録（証拠にしません）',
  };
  const STOP_LABEL = {
    stopped: '停止しました',
    stop_failed: '停止できませんでした',
    not_running: '実行していません',
    stop_unconfirmed: '停止を確認できていません',
    completed_before_stop: '停止の前に完了しました',
  };
  const REASON_LABEL = {
    SYMPTOM_MATCH: '相談の症状に対応する操作です。',
    KNOWLEDGE_REF: '承認済みのナレッジに同じ症状の記録があります。',
    FOLLOWS_VERIFIED_STEP: '確認済みの結果の次の操作です。',
    VERIFICATION_SKILL: '操作の流れを検証するためのものです。',
    AI_SELECTED: 'AI が候補から選びました。',
    RULE_BASED: '固定のルールで選びました（AI を使っていません）。',
    AI_EXPLANATION_REJECTED: '確認結果と合わない AI の説明は表示していません。',
  };
  const ROOT_LABEL = {
    Desktop: 'デスクトップ',
    Documents: 'ドキュメント',
    Downloads: 'ダウンロード',
    Pictures: 'ピクチャ',
    Music: 'ミュージック',
    Videos: 'ビデオ',
  };
  const TTLS = [15, 30];
  const OPEN = Object.keys(STATUS_LABEL).filter(
    (status) => !['resolved', 'stopped', 'escalated', 'expired', 'revoked'].includes(status),
  );

  function h(tag, props, ...children) {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(props ?? {})) {
      if (key === 'style') element.style.cssText = value;
      else if (key === 'onclick') element.addEventListener('click', value);
      else if (key === 'onchange') element.addEventListener('change', value);
      else if (key === 'value') element.value = value;
      else if (key === 'disabled' || key === 'selected' || key === 'checked') {
        element[key] = Boolean(value);
      } else element.setAttribute(key, value);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      element.append(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return element;
  }

  function small(text, extra) {
    return h(
      'div',
      { class: 'u-small', style: `margin-top:6px;${extra ?? ''}` },
      String(text ?? ''),
    );
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
    } catch {
      json = null;
    }
    if (!response.ok) {
      const err = new Error(json?.error?.message || `HTTP ${response.status}`);
      err.status = response.status;
      err.code = json?.error?.code;
      throw err;
    }
    return json;
  }

  const MINE = {
    sessions: [],
    // 404 の後はしばらく問い合わせない（一度の 404 で止め続けない）。
    retryAt: 0,
    disabled: false,
    busy: false,
    // 状態確認の失敗（確認が成功すれば消える）と、操作の失敗（次の操作まで残す）を分ける。
    error: null,
    actionError: null,
    forms: new Map(),
    lastKey: '',
    // フォルダ同意の進行中の依頼（セッションが始まる前の案内に使う）。
    folderRequests: [],
    // Y を送った提案。二重クリックや古い画面から送り直さない。
    decided: new Set(),
  };

  function formFor(id) {
    if (!MINE.forms.has(id)) MINE.forms.set(id, { scope: 'read_only', ttl: 30, ai: false });
    return MINE.forms.get(id);
  }

  /** フォルダブリッジが持つ依頼を使う（案内のために問い合わせを増やさない）。 */
  function folderRequests() {
    try {
      return window.__AIHD_FOLDER_ACCESS_BRIDGE__?.requests?.() ?? [];
    } catch {
      return [];
    }
  }

  async function load() {
    if (Date.now() < MINE.retryAt) return;
    try {
      const data = await api('/api/support-sessions/mine');
      MINE.sessions = data.sessions ?? [];
      MINE.disabled = false;
      MINE.error = null;
      MINE.folderRequests = folderRequests();
      const ids = new Set(MINE.sessions.map((session) => session.id));
      for (const id of MINE.forms.keys()) {
        if (!ids.has(id)) MINE.forms.delete(id);
      }
    } catch (error) {
      if (error.status === 404) {
        // 機能が無効か、一時的な不整合。何も描画せず、時間を置いて確かめ直す。
        MINE.disabled = true;
        MINE.retryAt = Date.now() + 60_000;
        MINE.sessions = [];
        MINE.folderRequests = [];
        MINE.error = null;
      } else if (error.status !== 401 && error.status !== 403) {
        MINE.error = String(error.message || error);
      }
    }
    render();
  }

  async function action(run) {
    if (MINE.busy) return;
    MINE.busy = true;
    MINE.actionError = null;
    render();
    try {
      await run();
    } catch (error) {
      MINE.actionError = String(error.message || error);
    } finally {
      MINE.busy = false;
      await load();
    }
  }

  function path(session, suffix) {
    return `/api/support-sessions/${encodeURIComponent(session.id)}${suffix}`;
  }

  function submitConsent(session) {
    const form = formFor(session.id);
    return action(async () => {
      await api(path(session, '/consents/operation'), {
        scope: form.scope,
        version: session.consentVersions.operation,
        ttlMinutes: Number(form.ttl),
      });
      if (form.ai) {
        await api(path(session, '/consents/ai-input'), {
          version: session.consentVersions.aiInput,
          ttlMinutes: Number(form.ttl),
        });
      }
    });
  }

  function revokeAi(session) {
    return action(() => api(path(session, '/consents/ai-input/revoke'), {}));
  }

  function requestProposal(session) {
    return action(() => api(path(session, '/proposals'), {}));
  }

  /**
   * Y/N は画面に表示した 1 提案だけに送る。ハッシュは表示したときの値で固定し、
   * 表示の後に提案が変わっていれば送らない（古い画面、二重クリック）。実行の一意性はサーバが守る。
   */
  function decide(session, proposal, decision) {
    if (MINE.busy || MINE.decided.has(proposal.id)) return undefined;
    const latest = MINE.sessions.find((item) => item.id === session.id);
    const pending = latest?.proposals?.find((item) => item.status === 'proposed');
    if (pending?.id !== proposal.id || pending.approvalHash !== proposal.approvalHash) {
      MINE.actionError = '画面が古くなりました。表示を更新しました。もう一度確認してください。';
      render();
      return load();
    }
    MINE.decided.add(proposal.id);
    const body =
      decision === 'Y' ? { decision: 'Y', approvalHash: proposal.approvalHash } : { decision: 'N' };
    return action(async () => {
      try {
        await api(path(session, `/proposals/${encodeURIComponent(proposal.id)}/decision`), body);
      } catch (error) {
        // 届かなかった場合は押し直せる。届いていてもサーバが 2 回目を拒否する。
        MINE.decided.delete(proposal.id);
        throw error;
      }
    });
  }

  function resolve(session, resolved) {
    return action(() => api(path(session, '/resolution'), { resolved }));
  }

  function revoke(session) {
    return action(() => api(path(session, '/revoke'), {}));
  }

  function canModify(session) {
    const available = session.skillAvailability;
    return Boolean(available && available.userReversible > available.readOnly);
  }

  function noSkillsReason(session) {
    const available = session.skillAvailability;
    if (!available) return null;
    const count =
      session.operationConsent?.scope === 'user_reversible'
        ? available.userReversible
        : available.readOnly;
    return count === 0
      ? '承認済みの操作がないため、今は提案できません。担当者へ連絡してください。'
      : null;
  }

  function targetLine(proposal) {
    return proposal.target
      ? '対象: 同意したフォルダ（その直下だけ）'
      : '対象: この PC の本人の設定と状態（フォルダは対象外）';
  }

  function scopeLine(session) {
    const scope = session.folderScope;
    if (!scope) return null;
    const root = ROOT_LABEL[scope.root] ?? scope.root;
    const until = scope.expiresAt ? new Date(scope.expiresAt).toLocaleString('ja-JP') : '';
    return small(`許可範囲: ${[root, ...(scope.segments ?? [])].join(' › ')} / 期限: ${until}`);
  }

  /** 導入からの流れを一続きに示す。 */
  function stepGuide(request, session) {
    const paired = Boolean(request?.paired) || Boolean(session);
    const consented = request?.status === 'active' || Boolean(session);
    const steps = [
      ['導入コードを発行して PC へ導入する（右下のパネル）', paired],
      ['PC に表示されたコードを入力する（右下のパネル）', paired],
      ['フォルダと期限を選んで同意する（右下のパネル）', consented],
      ['操作の範囲に同意する', Boolean(session?.operationConsent)],
      ['提案を確認して、はい / いいえ を選ぶ', Boolean(session?.proposalCount)],
    ];
    const current = steps.findIndex(([, done]) => !done);
    return h(
      'div',
      { style: 'margin-top:6px' },
      steps.map(([label, done], index) =>
        small(`${done ? '✓' : index === current ? '▶' : '・'} ${index + 1}. ${label}`),
      ),
      small('どの段階でも、いつでも取り消せます。'),
    );
  }

  function consentForm(session) {
    const form = formFor(session.id);
    return [
      small('操作の範囲を選んでください。フォルダ一覧の同意とは別の同意です。'),
      h(
        'div',
        { style: 'margin-top:6px;display:flex;gap:6px;flex-wrap:wrap' },
        h(
          'select',
          {
            class: 'u-input',
            'aria-label': '操作の範囲',
            onchange: (event) => {
              form.scope = event.target.value;
            },
          },
          h('option', { value: 'read_only', selected: form.scope === 'read_only' }, '読み取りのみ'),
          // 承認された変更系の Skill が無いのに、変更を選べるように見せない。
          canModify(session)
            ? h(
                'option',
                { value: 'user_reversible', selected: form.scope === 'user_reversible' },
                '自分の設定の変更（元に戻せる範囲）まで',
              )
            : null,
        ),
        h(
          'select',
          {
            class: 'u-input',
            'aria-label': '同意の期限',
            onchange: (event) => {
              form.ttl = Number(event.target.value);
            },
          },
          TTLS.map((value) =>
            h('option', { value: String(value), selected: value === form.ttl }, `${value} 分`),
          ),
        ),
      ),
      !session.aiAvailable ? small('AI は利用できません。固定のルールで提案します。') : null,
      h(
        'label',
        {
          class: 'u-small',
          style: `display:${session.aiAvailable ? 'block' : 'none'};margin-top:6px`,
        },
        h('input', {
          type: 'checkbox',
          // 再描画でも保持している値を表示する（見た目と送信内容を一致させる）。
          checked: form.ai,
          onchange: (event) => {
            form.ai = Boolean(event.target.checked);
          },
        }),
        ' AI に要約（相談の分類、症状の区分、確認済み事項、ナレッジの参照、件数と結果コード）を渡して提案させる。相談の全文、名前、パス、ユーザー名は渡しません。',
      ),
      small('チェックしなければルールベースの提案だけを使います。管理者権限の操作は行いません。'),
      h(
        'div',
        { style: 'margin-top:8px;display:flex;gap:8px;flex-wrap:wrap' },
        h('button', { class: 'u-btn pri', onclick: () => submitConsent(session) }, '同意する'),
      ),
    ];
  }

  function proposalBlock(session, proposal) {
    const verifyOps = proposal.verifyOps ?? [];
    return [
      h(
        'div',
        { style: 'margin-top:8px' },
        h('b', null, proposal.title),
        ` （${EFFECT_LABEL[proposal.effect] ?? ''} / ${SOURCE_LABEL[proposal.proposalSource] ?? ''}）`,
      ),
      small(`目的: ${proposal.purpose}`),
      small(targetLine(proposal)),
      ...(proposal.reasonCodes ?? [])
        .filter((code) => REASON_LABEL[code])
        .map((code) => small(`提案の理由: ${REASON_LABEL[code]}`)),
      proposal.rationale ? small(`提案の説明: ${proposal.rationale}`) : null,
      // AI の文は推測として分けて表示する。判定には使っていない。
      proposal.aiGuess
        ? small(`AI の推測（確認された事実ではありません）: ${proposal.aiGuess}`)
        : null,
      small(`影響: ${proposal.impact}`),
      small(`成功の条件: ${proposal.successCriteria}`),
      verifyOps.length
        ? small(
            `この提案に含まれる確認（続けて自動で実行します。新しい提案には数えません）: ${verifyOps
              .map((op) => `${op.title}（${op.description}）`)
              .join(' / ')}`,
          )
        : null,
      small(`失敗したとき: ${proposal.failureAction}`),
      small(`元に戻せる範囲: ${proposal.rollbackScope}`),
      small(
        `実行するのはご本人の Windows の権限です。確認の期限: ${new Date(proposal.approvalExpiresAt).toLocaleString('ja-JP')}`,
      ),
      h(
        'div',
        { style: 'margin-top:8px;display:flex;gap:8px;flex-wrap:wrap' },
        h(
          'button',
          { class: 'u-btn pri', onclick: () => decide(session, proposal, 'Y') },
          'はい（実行する）',
        ),
        h(
          'button',
          { class: 'u-btn', onclick: () => decide(session, proposal, 'N') },
          'いいえ（実行しない）',
        ),
      ),
    ];
  }

  function outputText(output) {
    if (!output) return '';
    return Object.entries(output)
      .map(([key, value]) => `${key}: ${value}`)
      .join(' / ');
  }

  function executionLine(execution) {
    const parts = [
      execution.role === 'verify'
        ? '確認（提案に含まれる）'
        : `提案 ${execution.stepSeq ?? ''} の実行`,
      execution.skillId,
      MODE_LABEL[execution.executionMode] ?? '結果待ち',
      execution.resultCode ?? '',
      execution.verifyOk === true
        ? '条件を満たしました'
        : execution.verifyOk === false
          ? '条件を満たしませんでした'
          : '未確認',
    ];
    const lines = [small(parts.filter(Boolean).join(' / '))];
    if (execution.output) lines.push(small(outputText(execution.output)));
    if (execution.lateResult) lines.push(small('遅れて届いた結果です。次へ進めません。'));
    if (execution.stopOutcome === 'not_running' && !execution.partialEffect?.length) {
      // 実行していない。停止や変更の話を出さない。
      lines.push(small(STOP_LABEL.not_running));
      return lines;
    }
    if (execution.stopRequestedAt) {
      lines.push(
        small(`停止を要求しました。${STOP_LABEL[execution.stopOutcome] ?? '結果を待っています。'}`),
      );
    } else if (execution.stopOutcome) {
      lines.push(small(STOP_LABEL[execution.stopOutcome] ?? ''));
    }
    if (execution.partialEffect?.length) {
      lines.push(
        small(
          `変更が生じた可能性があります: ${execution.partialEffect.join(', ')}`,
          'color:#b42318',
        ),
      );
    }
    return lines;
  }

  function sessionBody(session) {
    const nodes = [];
    if (session.endReason) nodes.push(small(END_LABEL[session.endReason] ?? ''));
    if (session.device) {
      nodes.push(small(`端末名: ${session.device.hostname || '（未確定）'}`));
      nodes.push(small(`Windows ユーザー: ${session.device.windowsUser || '（未確定）'}`));
    }
    if (session.leaseStatus === 'unverified') {
      nodes.push(small('検証モード: 貸与情報を確認していません。'));
    }
    const line = scopeLine(session);
    if (line) nodes.push(line);
    if (session.status === 'consent_pending') nodes.push(stepGuide(null, session));
    if (session.status === 'consent_pending') nodes.push(...consentForm(session));
    if (session.operationConsent) {
      nodes.push(
        small(
          `操作の範囲: ${session.operationConsent.scope === 'user_reversible' ? '変更（元に戻せる範囲）まで' : '読み取りのみ'}` +
            ` / 提案 ${session.proposalCount} / ${session.maxProposals}`,
        ),
      );
    }
    if (session.aiInputConsent && OPEN.includes(session.status)) {
      nodes.push(
        h(
          'div',
          { style: 'margin-top:6px' },
          small('AI へ要約を渡すことに同意しています。'),
          h('button', { class: 'u-btn', onclick: () => revokeAi(session) }, 'AI への入力をやめる'),
        ),
      );
    }
    const pending = (session.proposals ?? []).find((proposal) => proposal.status === 'proposed');
    if (session.status === 'awaiting_approval' && pending)
      nodes.push(...proposalBlock(session, pending));
    if (session.verifiedFacts?.length) {
      nodes.push(small('確認された事実（サーバの固定の条件で判定）:'));
      for (const fact of session.verifiedFacts) {
        nodes.push(
          small(`・${fact.condition}: ${fact.ok ? '満たしました' : '満たしませんでした'}`),
        );
      }
    }
    for (const execution of session.executions ?? []) nodes.push(...executionLine(execution));
    if (['ready', 'awaiting_next'].includes(session.status)) {
      const reason = noSkillsReason(session);
      nodes.push(
        reason
          ? small(reason)
          : h(
              'div',
              { style: 'margin-top:8px' },
              h(
                'button',
                { class: 'u-btn pri', onclick: () => requestProposal(session) },
                '次の操作を提案してもらう',
              ),
            ),
      );
    }
    if (['awaiting_next', 'resolve_confirm'].includes(session.status)) {
      nodes.push(
        small('困りごとは解決しましたか。ご本人の確認で解決とします。'),
        h(
          'div',
          { style: 'margin-top:6px;display:flex;gap:8px;flex-wrap:wrap' },
          h('button', { class: 'u-btn pri', onclick: () => resolve(session, true) }, '解決した'),
          session.status === 'resolve_confirm'
            ? h(
                'button',
                { class: 'u-btn', onclick: () => resolve(session, false) },
                'まだ解決していない',
              )
            : null,
        ),
      );
    }
    if (OPEN.includes(session.status)) {
      nodes.push(
        h(
          'div',
          { style: 'margin-top:8px' },
          h('button', { class: 'u-btn', onclick: () => revoke(session) }, '今すぐ取り消す'),
        ),
      );
    }
    return nodes;
  }

  function section(session) {
    return h(
      'div',
      { style: 'margin-top:10px;padding-top:8px;border-top:1px solid #98a2b3' },
      h(
        'div',
        { class: 'u-small' },
        h('b', null, `案件 ${session.caseId ?? ''}`),
        ` / ${STATUS_LABEL[session.status] ?? ''}`,
      ),
      ...sessionBody(session).filter(Boolean),
    );
  }

  /** セッションが始まる前の依頼の案内。 */
  function guideSection(request) {
    return h(
      'div',
      { style: 'margin-top:10px;padding-top:8px;border-top:1px solid #98a2b3' },
      h('div', { class: 'u-small' }, h('b', null, `案件 ${request.caseId ?? ''}`), ' / 準備中'),
      stepGuide(request, null),
    );
  }

  function render() {
    const sessions = MINE.sessions;
    const started = new Set(
      sessions.filter((session) => OPEN.includes(session.status)).map((item) => item.handoverId),
    );
    const guides = MINE.folderRequests.filter((request) => !started.has(request.handoverId));
    const key = JSON.stringify([
      sessions,
      guides,
      MINE.error,
      MINE.actionError,
      MINE.busy,
      MINE.disabled,
    ]);
    if (key === MINE.lastKey) return;
    MINE.lastKey = key;
    let panel = document.getElementById('aihdSupportSessionMinePanel');
    if ((sessions.length === 0 && guides.length === 0) || MINE.disabled) {
      panel?.remove();
      return;
    }
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'aihdSupportSessionMinePanel';
      panel.setAttribute('role', 'region');
      panel.setAttribute('aria-label', '操作の確認');
      panel.style.cssText =
        'position:fixed;left:16px;bottom:16px;z-index:9000;width:min(400px,calc(100vw - 32px));' +
        'max-height:70vh;overflow:auto;padding:12px;border:1px solid #98a2b3;border-radius:8px;' +
        'background:Canvas;color:CanvasText;box-shadow:0 4px 16px rgba(0,0,0,.2)';
      document.body.append(panel);
    }
    panel.replaceChildren(
      h(
        'div',
        { style: 'display:flex;justify-content:space-between;align-items:center;gap:8px' },
        h('b', null, '🛠 操作の確認'),
        h('span', { class: 'u-small' }, `MVP / ${sessions.length + guides.length} 件`),
      ),
      small(
        '担当者があなたの PC の操作を提案しています。実行前に必ず確認します。いつでも取り消せます。',
      ),
      ...guides.map(guideSection),
      ...sessions.map(section),
      MINE.actionError ? small(MINE.actionError, 'color:#b42318') : document.createTextNode(''),
      MINE.error ? small(MINE.error, 'color:#b42318') : document.createTextNode(''),
      MINE.busy ? small('処理中…') : document.createTextNode(''),
    );
  }

  // ── 担当者パネル ───────────────────────────────────────────────

  const STAFF = {
    caseId: null,
    handoverId: null,
    session: null,
    available: false,
    busy: false,
    error: null,
    actionError: null,
    retryAt: 0,
    // 案件を切り替えるたびに増やす。古い応答で別の案件の状態を上書きしない。
    epoch: 0,
    lastKey: '',
  };

  function currentCase() {
    try {
      return typeof curCase === 'function' ? curCase() : null;
    } catch {
      return null;
    }
  }

  function resetStaff(caseId) {
    STAFF.epoch += 1;
    STAFF.caseId = caseId;
    STAFF.handoverId = null;
    STAFF.session = null;
    STAFF.available = false;
    STAFF.error = null;
    STAFF.actionError = null;
    STAFF.retryAt = 0;
    STAFF.lastKey = '';
    renderStaff();
  }

  async function loadStaff() {
    const target = currentCase();
    if (!target?.id) return;
    if (STAFF.caseId !== target.id) resetStaff(target.id);
    const { epoch } = STAFF;
    const isCurrent = () => STAFF.epoch === epoch;
    try {
      let handoverId = STAFF.handoverId ?? target.handoverId ?? null;
      if (!handoverId) {
        const owner = target.ownerEmail ? `&owner=${encodeURIComponent(target.ownerEmail)}` : '';
        const found = await api(
          `/api/folder-access/handovers/lookup?ref=${encodeURIComponent(target.id)}${owner}`,
        );
        handoverId = found.handoverId ?? null;
      }
      if (!isCurrent()) return;
      STAFF.handoverId = handoverId;
      if (!handoverId) {
        STAFF.available = false;
        STAFF.retryAt = Date.now() + 60_000;
        renderStaff();
        return;
      }
      const data = await api(`/api/support-sessions?handoverId=${encodeURIComponent(handoverId)}`);
      if (!isCurrent()) return;
      STAFF.available = true;
      STAFF.session = data.session;
      STAFF.error = null;
    } catch (error) {
      if (!isCurrent()) return;
      if ([403, 404].includes(error.status)) {
        // 引き受けた本人以外（承認者だけの場合を含む）には何も見せない。
        STAFF.available = false;
        STAFF.session = null;
        STAFF.error = null;
        STAFF.retryAt = Date.now() + 60_000;
      } else {
        STAFF.available = true;
        STAFF.error = String(error.message || error);
      }
    }
    renderStaff();
  }

  async function staffAction(run) {
    if (STAFF.busy) return;
    const { epoch } = STAFF;
    STAFF.busy = true;
    STAFF.actionError = null;
    renderStaff();
    try {
      await run();
    } catch (error) {
      if (STAFF.epoch === epoch) STAFF.actionError = String(error.message || error);
    } finally {
      STAFF.busy = false;
      await loadStaff();
    }
  }

  function startSession() {
    return staffAction(() => api('/api/support-sessions', { handoverId: STAFF.handoverId }));
  }

  function stopSession() {
    const session = STAFF.session;
    return staffAction(() => api(path(session, '/stop'), {}));
  }

  function staffBody() {
    const session = STAFF.session;
    const open = session && OPEN.includes(session.status);
    const nodes = [];
    if (session) {
      nodes.push(small(`状態: ${STATUS_LABEL[session.status] ?? ''}`));
      if (session.endReason) nodes.push(small(END_LABEL[session.endReason] ?? ''));
      nodes.push(small(`提案 ${session.proposalCount} / ${session.maxProposals}`));
    }
    if (open) {
      nodes.push(
        small('実行するかどうかは相談者本人が決めます。担当者は承認も解決の確定もできません。'),
        h(
          'div',
          { style: 'margin-top:8px' },
          h('button', { class: 'u-btn', onclick: stopSession }, '中止'),
        ),
      );
    } else if (STAFF.handoverId) {
      nodes.push(
        small('相談者のフォルダ同意が有効なときに開始できます。'),
        h(
          'div',
          { style: 'margin-top:8px' },
          h('button', { class: 'u-btn pri', onclick: startSession }, '支援セッションを開始'),
        ),
      );
    }
    return nodes;
  }

  function renderStaff() {
    const panel = document.getElementById('aihdSupportSessionStaffPanel');
    if (!panel) return;
    const key = JSON.stringify([
      STAFF.available,
      STAFF.session,
      STAFF.handoverId,
      STAFF.error,
      STAFF.actionError,
      STAFF.busy,
    ]);
    if (key === STAFF.lastKey) return;
    STAFF.lastKey = key;
    if (!STAFF.available) {
      panel.style.display = 'none';
      panel.replaceChildren();
      return;
    }
    panel.style.display = '';
    panel.replaceChildren(
      h(
        'div',
        { style: 'display:flex;justify-content:space-between;align-items:center;gap:8px' },
        h('b', null, '🛠 操作の支援'),
        h('span', { class: 'u-small' }, 'MVP'),
      ),
      small('引継ぎを引き受けた担当者本人だけが開始と中止をできます。'),
      ...staffBody(),
      STAFF.actionError ? small(STAFF.actionError, 'color:#b42318') : document.createTextNode(''),
      STAFF.error ? small(STAFF.error, 'color:#b42318') : document.createTextNode(''),
      STAFF.busy ? small('処理中…') : document.createTextNode(''),
    );
  }

  function ensureStaffPanel() {
    const target = currentCase();
    if (!target?.id || !document.querySelector('#wzPane')) return;
    if (!document.getElementById('aihdSupportSessionStaffPanel')) {
      const wiz = document.querySelector('.w-wiz');
      if (!wiz?.parentNode) return;
      const panel = document.createElement('div');
      panel.id = 'aihdSupportSessionStaffPanel';
      panel.className = 'u-card';
      panel.style.cssText = 'margin-top:12px;padding:12px;display:none';
      wiz.parentNode.insertBefore(panel, wiz.nextSibling);
      STAFF.lastKey = '';
      void loadStaff();
      return;
    }
    if (STAFF.caseId !== target.id) void loadStaff();
  }

  setInterval(ensureStaffPanel, 1500);
  setInterval(() => {
    if (document.hidden) return;
    if (!document.getElementById('aihdSupportSessionStaffPanel') || !STAFF.caseId) return;
    if (STAFF.available || Date.now() >= STAFF.retryAt) void loadStaff();
  }, 6000);
  setInterval(() => {
    if (!document.hidden) void load();
  }, 5000);
  window.addEventListener(
    'load',
    () => {
      ensureStaffPanel();
      void load();
    },
    { once: true },
  );
})();
