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
      else if (key === 'disabled' || key === 'selected') element[key] = Boolean(value);
      else element.setAttribute(key, value);
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
    disabled: false,
    busy: false,
    error: null,
    forms: new Map(),
    lastKey: '',
  };

  function formFor(id) {
    if (!MINE.forms.has(id)) MINE.forms.set(id, { scope: 'read_only', ttl: 30, ai: false });
    return MINE.forms.get(id);
  }

  async function load() {
    if (MINE.disabled) return;
    try {
      const data = await api('/api/support-sessions/mine');
      MINE.sessions = data.sessions ?? [];
      const ids = new Set(MINE.sessions.map((session) => session.id));
      for (const id of MINE.forms.keys()) {
        if (!ids.has(id)) MINE.forms.delete(id);
      }
    } catch (error) {
      if (error.status === 404) {
        // 機能が無効。以後は問い合わせず、何も描画しない。
        MINE.disabled = true;
        MINE.sessions = [];
      } else if (error.status !== 401 && error.status !== 403) {
        MINE.error = String(error.message || error);
      }
    }
    render();
  }

  async function action(run) {
    if (MINE.busy) return;
    MINE.busy = true;
    MINE.error = null;
    render();
    try {
      await run();
    } catch (error) {
      MINE.error = String(error.message || error);
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

  function decide(session, proposal, decision) {
    const body =
      decision === 'Y' ? { decision: 'Y', approvalHash: proposal.approvalHash } : { decision: 'N' };
    return action(() =>
      api(path(session, `/proposals/${encodeURIComponent(proposal.id)}/decision`), body),
    );
  }

  function resolve(session, resolved) {
    return action(() => api(path(session, '/resolution'), { resolved }));
  }

  function revoke(session) {
    return action(() => api(path(session, '/revoke'), {}));
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
          h(
            'option',
            { value: 'user_reversible', selected: form.scope === 'user_reversible' },
            '自分の設定の変更（元に戻せる範囲）まで',
          ),
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
      h(
        'label',
        { class: 'u-small', style: 'display:block;margin-top:6px' },
        h('input', {
          type: 'checkbox',
          onchange: (event) => {
            form.ai = Boolean(event.target.checked);
          },
        }),
        ' AI に要約（件数・結果コードのみ）を渡して提案させる。名前・パス・ユーザー名は渡しません。',
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
      proposal.rationale ? small(`提案の説明（参考）: ${proposal.rationale}`) : null,
      small(`影響: ${proposal.impact}`),
      small(`成功の条件: ${proposal.successCriteria}`),
      verifyOps.length
        ? small(
            `確認の操作: ${verifyOps.map((op) => `${op.title}（${op.description}）`).join(' / ')}`,
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
      execution.role === 'verify' ? '確認' : '実行',
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
    if (execution.stopRequestedAt) {
      lines.push(
        small(`停止を要求しました。${STOP_LABEL[execution.stopOutcome] ?? '結果を待っています。'}`),
      );
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
    for (const execution of session.executions ?? []) nodes.push(...executionLine(execution));
    if (['ready', 'awaiting_next'].includes(session.status)) {
      nodes.push(
        h(
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

  function render() {
    const sessions = MINE.sessions;
    const key = JSON.stringify([sessions, MINE.error, MINE.busy, MINE.disabled]);
    if (key === MINE.lastKey) return;
    MINE.lastKey = key;
    let panel = document.getElementById('aihdSupportSessionMinePanel');
    if (sessions.length === 0 || MINE.disabled) {
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
        h('span', { class: 'u-small' }, `MVP / ${sessions.length} 件`),
      ),
      small(
        '担当者があなたの PC の操作を提案しています。実行前に必ず確認します。いつでも取り消せます。',
      ),
      ...sessions.map(section),
      MINE.error ? small(MINE.error, 'color:#b42318') : document.createTextNode(''),
      MINE.busy ? small('処理中…') : document.createTextNode(''),
    );
  }

  setInterval(() => {
    if (!document.hidden) void load();
  }, 5000);
  window.addEventListener('load', () => void load(), { once: true });
})();
