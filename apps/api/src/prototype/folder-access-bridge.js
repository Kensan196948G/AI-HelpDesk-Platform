/*
 * AI HelpDesk 本人同意付きフォルダ一覧ブリッジ（docs/62。MVP）
 *
 * 機能フラグが有効なときだけ配信される。原本 HTML / CSS は変更しない。
 * - 担当者パネル: 案件を引き受けた担当者本人が、依頼の開始・状態確認・一覧の取得・終了を行う。
 * - 相談者パネル: 相談者本人が、コード入力・対象の確認・同意・取消を行う。
 * 一覧の結果はこのクロージャの中だけに置く。画面状態やブラウザの保存領域へ書かない。
 * 描画は textContent のみ（HTML 文字列を組み立てない）。ファイル名による XSS を防ぐ。
 */
(() => {
  if (window.__AIHD_FOLDER_ACCESS_BRIDGE__) return;
  window.__AIHD_FOLDER_ACCESS_BRIDGE__ = { version: 1 };

  const ROOTS = [
    ['Desktop', 'デスクトップ'],
    ['Documents', 'ドキュメント'],
    ['Downloads', 'ダウンロード'],
    ['Pictures', 'ピクチャ'],
    ['Music', 'ミュージック'],
    ['Videos', 'ビデオ'],
  ];
  const TTLS = [15, 30, 60];

  const STATUS_LABEL = {
    device_pending: '対象PC確認待ち',
    helper_pending: 'Windowsユーザー確認待ち',
    consent_pending: '本人同意待ち',
    active: '読取接続中',
    ended: '終了',
    revoked: '取消',
    expired: '期限切れ',
    denied: '拒否',
  };
  const REASON_LABEL = {
    LEASE_UNAVAILABLE: '貸与情報を取得できません（連携が未設定か、接続できません）。',
    LEASE_STALE: '貸与情報が古いため確定できません。',
    LEASE_NONE: '貸与端末が見つかりません。',
    LEASE_MULTIPLE: '貸与端末が複数あるため確定できません。',
    LEASE_CONFLICT: '貸与情報と端末の照合が一致しません。',
    EMPLOYEE_UNRESOLVED: '社員名簿で相談者を確認できません。',
    DEVICE_NOT_LINKED: '指定された端末を確認できません。',
    RSP_DEVICE_NONE: 'RSP に該当する端末がありません。',
    RSP_DEVICE_MULTIPLE: 'RSP に該当する端末が複数あります。',
    RSP_AGENT_NOT_INSTALLED: '端末に MeshAgent が導入されていません。',
    RSP_NOT_CONFIGURED: 'RSP 連携が未設定です。',
    RSP_UNAVAILABLE: 'RSP に接続できません。',
    RSP_PROBE_UNAVAILABLE: 'RSP から端末の確認結果を取得できません。再確認します。',
    RSP_PROBE_INVALID: '端末の確認結果を解釈できません。',
    RSP_PROBE_STALE: '端末の最新の確認結果を取得できません。再確認してください。',
    RSP_PROBE_UNKNOWN_STATUS: '端末の確認が想定外の状態で止まりました。再確認してください。',
    RSP_PROBE_TIMEOUT: '端末の確認が時間内に終わりませんでした。再確認してください。',
    RSP_AGENT_BUSY: '端末が別の処理中です。再確認してください。',
    RSP_AGENT_NO_REPLY: '端末から応答がありません。',
    RSP_AGENT_NOT_CONNECTED: '端末がオフラインです。',
    RSP_EXECUTION_FAILED: '端末の確認に失敗しました。',
    NOT_LOGGED_ON: '端末にログオン中のユーザーを確認できません。',
    SESSION_UNRESOLVED: 'Windows のセッションを 1 つに特定できません。',
  };
  const END_LABEL = {
    operator_end: '担当者が終了しました。',
    requester_revoked: '相談者が取り消しました。',
    expired: '期限が切れました。',
    assignee_changed: '担当者または案件の状態が変わりました。',
    session_changed: 'Windows のセッションが変わりました。',
    user_logged_off: 'ログオフ、または端末との接続が切れました。',
    helper_revoked: 'ヘルパーが無効になりました。',
    lease_conflict: '貸与情報が一致しなくなりました。',
    device_mismatch: '端末の照合が一致しませんでした。',
    sid_mismatch: 'Windows ユーザーが一致しませんでした。',
  };
  const TYPE_LABEL = { file: 'ファイル', directory: 'フォルダ', link: 'リンク', other: 'その他' };

  /** 要素を作る。文字列の子は必ずテキストノードになる。 */
  function h(tag, props, ...children) {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(props ?? {})) {
      if (key === 'style') element.style.cssText = value;
      else if (key === 'onclick') element.addEventListener('click', value);
      else if (key === 'oninput') element.addEventListener('input', value);
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
    return h('div', { class: 'u-small', style: `margin-top:6px;${extra ?? ''}` }, text);
  }

  function errorLine(text) {
    return text ? small(text, 'color:#b42318') : null;
  }

  function heading(title, status) {
    return h(
      'div',
      { style: 'display:flex;justify-content:space-between;align-items:center;gap:8px' },
      h('b', null, title),
      h('span', { class: 'u-small' }, `MVP / ${status}`),
    );
  }

  function reasonText(request) {
    if (!request) return null;
    if (request.endReason) return END_LABEL[request.endReason] ?? '';
    if (request.reasonCode) return REASON_LABEL[request.reasonCode] ?? request.reasonCode;
    return null;
  }

  function targetLines(request) {
    const device = request.device ?? {};
    return [
      small(`端末名: ${device.helperHostname || device.hostname || '（未確定）'}`),
      small(`Windows ユーザー: ${request.windowsUser || '（未確定）'}`),
    ];
  }

  function scopeText(scope) {
    if (!scope) return '';
    const root = ROOTS.find((item) => item[0] === scope.root)?.[1] ?? scope.root;
    const path = [root, ...(scope.segments ?? [])].join(' › ');
    const until = scope.expiresAt ? new Date(scope.expiresAt).toLocaleString('ja-JP') : '';
    return `許可範囲: ${path}（直下の一覧とメタデータのみ） / 期限: ${until}`;
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

  // ── 担当者パネル ───────────────────────────────────────────────

  const STAFF = {
    caseId: null,
    handoverId: null,
    request: null,
    // 結果はここだけに置く。終了・案件切替で破棄する。
    result: null,
    available: false,
    // 担当者でない間は問い合わせを減らす（相談者の画面から 6 秒ごとに 403 を出さない）。
    retryAt: 0,
    // 案件を切り替えるたびに増やす。古い応答で別の案件の状態を上書きしないために使う。
    epoch: 0,
    busy: false,
    // 状態確認の失敗（確認が成功すれば消える）と、操作の失敗（次の操作まで残す）を分ける。
    error: null,
    actionError: null,
    rspDeviceId: '',
    hostname: '',
    lastKey: '',
  };

  function currentCase() {
    try {
      return typeof curCase === 'function' ? curCase() : null;
    } catch {
      return null;
    }
  }

  async function findHandoverId(target) {
    if (target.handoverId) return target.handoverId;
    // 受信箱（pending / claimed の最新 50 件）に頼らず、自分が引き受けた引継ぎを直接引く。
    const found = await api(
      `/api/folder-access/handovers/lookup?ref=${encodeURIComponent(target.id)}`,
    );
    return found.handoverId ?? null;
  }

  /** 呼び出し時点の案件がまだ表示中かを返す関数を作る。await の後で照合する。 */
  function staffScope() {
    const { epoch, caseId } = STAFF;
    return () => STAFF.epoch === epoch && currentCase()?.id === caseId;
  }

  function resetStaff(caseId) {
    STAFF.epoch += 1;
    STAFF.caseId = caseId;
    STAFF.handoverId = null;
    STAFF.request = null;
    STAFF.result = null;
    STAFF.available = false;
    STAFF.retryAt = 0;
    STAFF.error = null;
    STAFF.actionError = null;
    STAFF.lastKey = '';
    // 前の案件の入力を次の案件へ送らない。
    STAFF.rspDeviceId = '';
    STAFF.hostname = '';
  }

  async function loadStaff() {
    const target = currentCase();
    if (!target?.id) return;
    if (STAFF.caseId !== target.id) resetStaff(target.id);
    const isCurrent = staffScope();
    try {
      const handoverId = STAFF.handoverId ?? (await findHandoverId(target));
      if (!isCurrent()) return;
      STAFF.handoverId = handoverId;
      if (!handoverId) {
        STAFF.available = false;
        STAFF.retryAt = Date.now() + 60_000;
        renderStaff();
        return;
      }
      const data = await api(
        `/api/folder-access/requests?handoverId=${encodeURIComponent(handoverId)}`,
      );
      if (!isCurrent()) return;
      let result = null;
      if (data.request?.status === 'active') {
        const id = encodeURIComponent(data.request.id);
        result = (await api(`/api/folder-access/requests/${id}/result`)).result;
        if (!isCurrent()) return;
      }
      STAFF.available = true;
      STAFF.request = data.request;
      STAFF.result = result;
      STAFF.error = null;
    } catch (error) {
      // 切り替え前の案件の失敗は、表示中の案件へ反映しない。
      if (!isCurrent()) return;
      if ([403, 404].includes(error.status)) {
        // 担当者本人以外・機能無効は何も出さない。
        STAFF.available = false;
        STAFF.retryAt = Date.now() + 60_000;
        STAFF.request = null;
        STAFF.result = null;
        STAFF.error = null;
      } else {
        // 一時的な失敗ではパネルを隠さない。状態を保ち、エラーを見せて終了できるようにする。
        STAFF.available = true;
        STAFF.error = String(error.message || error);
      }
    }
    renderStaff();
  }

  async function staffAction(run) {
    if (STAFF.busy) return;
    const isCurrent = staffScope();
    STAFF.busy = true;
    STAFF.actionError = null;
    renderStaff();
    try {
      await run(isCurrent);
    } catch (error) {
      if (isCurrent()) STAFF.actionError = String(error.message || error);
    } finally {
      STAFF.busy = false;
      await loadStaff();
    }
  }

  function startRequest() {
    return staffAction(async (isCurrent) => {
      const body = { handoverId: STAFF.handoverId };
      if (STAFF.rspDeviceId.trim()) body.rspDeviceId = STAFF.rspDeviceId.trim();
      if (STAFF.hostname.trim()) body.hostname = STAFF.hostname.trim();
      const data = await api('/api/folder-access/requests', body);
      if (isCurrent()) STAFF.request = data.request;
    });
  }

  function requestList() {
    return staffAction(async () => {
      await api(`/api/folder-access/requests/${encodeURIComponent(STAFF.request.id)}/list`, {});
    });
  }

  function endRequest() {
    return staffAction(async (isCurrent) => {
      const id = encodeURIComponent(STAFF.request.id);
      const data = await api(`/api/folder-access/requests/${id}/end`, {});
      if (!isCurrent()) return;
      STAFF.request = data.request;
      STAFF.result = null;
    });
  }

  function formatSize(size) {
    if (size === null || size === undefined) return '';
    if (size < 1024) return `${size} B`;
    if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
    if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`;
    return `${(size / 1024 ** 3).toFixed(1)} GB`;
  }

  function resultTable(result) {
    const cell = (text) => h('td', { style: 'padding:2px 8px 2px 0' }, text);
    const rows = (result.entries ?? []).map((entry) =>
      h(
        'tr',
        null,
        cell(entry.name),
        cell(TYPE_LABEL[entry.type] ?? ''),
        cell(formatSize(entry.size)),
        cell(entry.modifiedAt ? new Date(entry.modifiedAt).toLocaleString('ja-JP') : ''),
        cell(entry.attrs?.cloudOnly ? 'クラウドのみ' : entry.attrs?.reparse ? 'リンク' : ''),
      ),
    );
    return h(
      'div',
      { style: 'margin-top:8px;max-height:260px;overflow:auto' },
      small(
        `${result.count} 件${result.truncated ? '（上限により一部のみ）' : ''}` +
          (result.status === 'error' ? ` / 取得できませんでした: ${result.reason ?? ''}` : ''),
      ),
      rows.length
        ? h(
            'table',
            { class: 'u-small', style: 'margin-top:4px;border-collapse:collapse' },
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                ['名前', '種別', 'サイズ', '更新日時', '属性'].map((t) => cell(t)),
              ),
            ),
            h('tbody', null, rows),
          )
        : null,
    );
  }

  function staffBody() {
    const request = STAFF.request;
    // まだ引継ぎを確認できていない（一時的な失敗）。開始の導線を出さない。
    if (!request && !STAFF.handoverId) return [];
    if (!request || !STATUS_LABEL[request.status] || isClosed(request)) {
      return [
        request ? small(reasonText(request) ?? '') : null,
        small('相談者本人の同意を得て、選んだフォルダ直下の名前と属性だけを確認します。'),
        h(
          'div',
          { style: 'margin-top:8px' },
          h('button', { class: 'u-btn pri', onclick: startRequest }, '同意の依頼を開始'),
        ),
      ];
    }
    const nodes = [...targetLines(request)];
    const reason = reasonText(request);
    if (reason) nodes.push(small(reason));
    if (request.leaseStatus === 'unverified') {
      nodes.push(small('検証モード: 貸与情報を確認していません。'));
    }
    if (request.status === 'device_pending') {
      nodes.push(
        h(
          'div',
          { style: 'margin-top:6px;display:flex;gap:6px;flex-wrap:wrap' },
          h('input', {
            class: 'u-input',
            placeholder: 'RSP 端末ID（任意）',
            value: STAFF.rspDeviceId,
            oninput: (event) => {
              STAFF.rspDeviceId = event.target.value;
            },
          }),
          h('input', {
            class: 'u-input',
            placeholder: 'ホスト名（検証用・任意）',
            value: STAFF.hostname,
            oninput: (event) => {
              STAFF.hostname = event.target.value;
            },
          }),
        ),
      );
    }
    if (request.status === 'helper_pending' && !request.paired) {
      nodes.push(small('相談者が PC に表示されたコードを入力するまで待っています。'));
    }
    if (request.status === 'consent_pending') {
      nodes.push(small('相談者がフォルダと期限を選んで同意するまで待っています。'));
    }
    if (request.status === 'active') nodes.push(small(scopeText(request.scope)));

    const retryable =
      request.status === 'device_pending' ||
      (request.status === 'helper_pending' && request.probeStatus !== 'pending');
    nodes.push(
      h(
        'div',
        { style: 'margin-top:8px;display:flex;gap:8px;flex-wrap:wrap' },
        retryable ? h('button', { class: 'u-btn', onclick: startRequest }, '再確認') : null,
        request.status === 'active'
          ? h('button', { class: 'u-btn pri', onclick: requestList }, '一覧を取得')
          : null,
        h('button', { class: 'u-btn', onclick: endRequest }, '終了'),
      ),
    );
    if (request.status === 'active' && STAFF.result) nodes.push(resultTable(STAFF.result));
    return nodes;
  }

  function isClosed(request) {
    return ['ended', 'revoked', 'expired', 'denied'].includes(request.status);
  }

  function renderStaff() {
    const panel = document.getElementById('aihdFolderAccessPanel');
    if (!panel) return;
    const key = JSON.stringify([
      STAFF.available,
      STAFF.request,
      STAFF.result?.opId,
      STAFF.result?.receivedAt,
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
      heading('📁 フォルダ一覧（本人同意）', STATUS_LABEL[STAFF.request?.status] ?? '未開始'),
      small('担当者本人のみ操作できます（本番承認者の権限では操作できません）。読み取り専用です。'),
      ...staffBody().filter(Boolean),
      errorLine(STAFF.actionError) ?? document.createTextNode(''),
      errorLine(STAFF.error) ?? document.createTextNode(''),
      STAFF.busy ? small('処理中…') : document.createTextNode(''),
    );
  }

  function ensureStaffPanel() {
    const target = currentCase();
    const existing = document.getElementById('aihdFolderAccessPanel');
    if (!target?.id || !document.querySelector('#wzPane')) return;
    if (!existing) {
      const wiz = document.querySelector('.w-wiz');
      if (!wiz?.parentNode) return;
      const panel = document.createElement('div');
      panel.id = 'aihdFolderAccessPanel';
      panel.className = 'u-card';
      panel.style.cssText = 'margin-top:12px;padding:12px;display:none';
      wiz.parentNode.insertBefore(panel, wiz.nextSibling);
      STAFF.lastKey = '';
      void loadStaff();
      return;
    }
    if (STAFF.caseId !== target.id) void loadStaff();
  }

  // ── 相談者パネル ───────────────────────────────────────────────

  const MINE = {
    requests: [],
    // 404 の後はしばらく問い合わせない（一度の 404 で止め続けない）。
    retryAt: 0,
    disabled: false,
    busy: false,
    error: null,
    actionError: null,
    // 依頼ごとの入力。別の依頼の入力と混ざらないように分ける。
    forms: new Map(),
    lastKey: '',
  };

  function formFor(id) {
    if (!MINE.forms.has(id)) {
      MINE.forms.set(id, {
        code: '',
        root: 'Documents',
        subfolder: '',
        ttl: 30,
        // 導入コードはこの変数の中だけに置く（画面の再読込で消える。再発行すればよい）。
        enrollCode: null,
        enrollExpiresAt: null,
      });
    }
    return MINE.forms.get(id);
  }

  async function loadMine() {
    if (Date.now() < MINE.retryAt) return;
    try {
      const data = await api('/api/folder-access/mine');
      MINE.requests = data.requests ?? [];
      MINE.disabled = false;
      MINE.error = null;
      const ids = new Set(MINE.requests.map((request) => request.id));
      for (const id of MINE.forms.keys()) {
        if (!ids.has(id)) MINE.forms.delete(id);
      }
    } catch (error) {
      if (error.status === 404) {
        // 機能が無効か、一時的な不整合。何も描画せず、時間を置いて確かめ直す。
        MINE.disabled = true;
        MINE.retryAt = Date.now() + 60_000;
        MINE.requests = [];
        MINE.error = null;
      } else if (error.status !== 401 && error.status !== 403) {
        MINE.error = String(error.message || error);
      }
    }
    renderMine();
  }

  async function mineAction(run) {
    if (MINE.busy) return;
    MINE.busy = true;
    MINE.actionError = null;
    renderMine();
    try {
      await run();
    } catch (error) {
      MINE.actionError = String(error.message || error);
    } finally {
      MINE.busy = false;
      await loadMine();
    }
  }

  function minePath(request, suffix) {
    return `/api/folder-access/requests/${encodeURIComponent(request.id)}/${suffix}`;
  }

  function issueEnrollCode(request) {
    const form = formFor(request.id);
    return mineAction(async () => {
      const issued = await api(minePath(request, 'enroll-code'), {});
      form.enrollCode = issued.enrollCode;
      form.enrollExpiresAt = issued.expiresAt;
    });
  }

  function liveEnrollCode(form) {
    if (!form.enrollCode) return null;
    if (Date.now() >= new Date(form.enrollExpiresAt).getTime()) {
      form.enrollCode = null;
      form.enrollExpiresAt = null;
      return null;
    }
    return form.enrollCode;
  }

  /** 導入コードの発行と install の実行例。 */
  function enrollSection(request) {
    const form = formFor(request.id);
    const code = liveEnrollCode(form);
    const origin = window.location?.origin ?? '';
    return [
      small(
        'はじめに PC へヘルパーを導入します。導入コードを発行し、ご本人の PC で実行してください。',
      ),
      h(
        'div',
        { style: 'margin-top:6px' },
        h(
          'button',
          { class: code ? 'u-btn' : 'u-btn pri', onclick: () => issueEnrollCode(request) },
          code ? '導入コードを再発行' : '導入コードを発行',
        ),
      ),
      code ? small(`導入コード: ${code}`) : null,
      code
        ? small(`有効期限: ${new Date(form.enrollExpiresAt).toLocaleString('ja-JP')}（一回限り）`)
        : null,
      code
        ? h(
            'div',
            { class: 'u-small', style: 'margin-top:6px;word-break:break-all' },
            `powershell -ExecutionPolicy Bypass -File .\\install-folder-helper.ps1 -ServerUrl ${origin} -EnrollCode ${code}`,
          )
        : null,
    ];
  }

  function submitCode(request) {
    const form = formFor(request.id);
    return mineAction(async () => {
      await api(minePath(request, 'pair'), { code: form.code.trim() });
      form.code = '';
    });
  }

  function submitConsent(request) {
    const form = formFor(request.id);
    return mineAction(async () => {
      const segments = form.subfolder
        .split(/[\\/]/)
        .map((part) => part.trim())
        .filter(Boolean);
      await api(minePath(request, 'consent'), {
        root: form.root,
        segments,
        ttlMinutes: Number(form.ttl),
      });
    });
  }

  function submitRevoke(request) {
    return mineAction(async () => {
      await api(minePath(request, 'revoke'), {});
    });
  }

  function mineBody(request) {
    if (isClosed(request)) return [small(reasonText(request) ?? '')];
    const form = formFor(request.id);
    const nodes = [];
    const reason = reasonText(request);
    if (reason) nodes.push(small(reason));
    if (request.status === 'device_pending') {
      nodes.push(small('担当者が対象の PC を確認しています。'));
    }
    if (request.status === 'helper_pending') {
      if (!request.paired) {
        nodes.push(...enrollSection(request));
        nodes.push(small('導入後、PC に表示された 8 桁のコードを入力してください。'));
        nodes.push(
          h(
            'div',
            { style: 'margin-top:6px;display:flex;gap:6px;flex-wrap:wrap' },
            h('input', {
              class: 'u-input',
              inputmode: 'numeric',
              autocomplete: 'off',
              maxlength: '8',
              placeholder: '8 桁のコード',
              value: form.code,
              oninput: (event) => {
                form.code = event.target.value;
              },
            }),
            h('button', { class: 'u-btn pri', onclick: () => submitCode(request) }, '確認'),
          ),
        );
        if (request.pairingLocked) {
          nodes.push(small('試行回数の上限に達しました。担当者に依頼のやり直しを伝えてください。'));
        }
      } else {
        nodes.push(...targetLines(request));
        nodes.push(small('端末の照合を待っています。'));
      }
    }
    if (request.status === 'consent_pending') {
      nodes.push(...targetLines(request));
      nodes.push(small('上の端末と Windows ユーザーが自分のものか確認してください。'));
      nodes.push(
        h(
          'div',
          { style: 'margin-top:6px;display:flex;gap:6px;flex-wrap:wrap' },
          h(
            'select',
            {
              class: 'u-input',
              onchange: (event) => {
                form.root = event.target.value;
              },
            },
            ROOTS.map(([value, label]) =>
              h('option', { value, selected: value === form.root }, label),
            ),
          ),
          h('input', {
            class: 'u-input',
            placeholder: 'サブフォルダ（任意）',
            value: form.subfolder,
            oninput: (event) => {
              form.subfolder = event.target.value;
            },
          }),
          h(
            'select',
            {
              class: 'u-input',
              onchange: (event) => {
                form.ttl = Number(event.target.value);
              },
            },
            TTLS.map((value) =>
              h('option', { value: String(value), selected: value === form.ttl }, `${value} 分`),
            ),
          ),
        ),
      );
      nodes.push(
        small(
          '担当者に見えるのは、選んだフォルダ直下の名前・種別・サイズ・更新日時だけです。' +
            'ファイルの内容は見えません。下の階層も見えません。',
        ),
      );
      nodes.push(
        h(
          'div',
          { style: 'margin-top:8px;display:flex;gap:8px;flex-wrap:wrap' },
          h('button', { class: 'u-btn pri', onclick: () => submitConsent(request) }, '同意する'),
          h('button', { class: 'u-btn', onclick: () => submitRevoke(request) }, '拒否する'),
        ),
      );
      return nodes;
    }
    if (request.status === 'active') {
      nodes.push(...targetLines(request));
      nodes.push(small(scopeText(request.scope)));
      nodes.push(
        h(
          'div',
          { style: 'margin-top:8px' },
          h(
            'button',
            { class: 'u-btn pri', onclick: () => submitRevoke(request) },
            '今すぐ取り消す',
          ),
        ),
      );
      return nodes;
    }
    nodes.push(
      h(
        'div',
        { style: 'margin-top:8px' },
        h('button', { class: 'u-btn', onclick: () => submitRevoke(request) }, '拒否する'),
      ),
    );
    return nodes;
  }

  function mineSection(request) {
    return h(
      'div',
      { style: 'margin-top:10px;padding-top:8px;border-top:1px solid #98a2b3' },
      h(
        'div',
        { class: 'u-small' },
        h('b', null, `案件 ${request.caseId ?? ''}`),
        ` / ${STATUS_LABEL[request.status] ?? ''}`,
      ),
      ...mineBody(request).filter(Boolean),
    );
  }

  function renderMine() {
    const requests = MINE.requests;
    // 入力中の再描画を避けるため、form 全体ではなく導入コードの表示だけをキーに含める。
    const enrollKey = requests.map((request) => {
      const form = MINE.forms.get(request.id);
      return form ? liveEnrollCode(form) : null;
    });
    const key = JSON.stringify([
      requests,
      MINE.error,
      MINE.actionError,
      MINE.busy,
      MINE.disabled,
      enrollKey,
    ]);
    if (key === MINE.lastKey) return;
    MINE.lastKey = key;
    let panel = document.getElementById('aihdFolderAccessMinePanel');
    if (requests.length === 0 || MINE.disabled) {
      panel?.remove();
      return;
    }
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'aihdFolderAccessMinePanel';
      panel.setAttribute('role', 'region');
      panel.setAttribute('aria-label', 'フォルダ一覧の同意');
      panel.style.cssText =
        'position:fixed;right:16px;bottom:16px;z-index:9000;width:min(380px,calc(100vw - 32px));' +
        'max-height:70vh;overflow:auto;padding:12px;border:1px solid #98a2b3;border-radius:8px;' +
        'background:Canvas;color:CanvasText;box-shadow:0 4px 16px rgba(0,0,0,.2)';
      document.body.append(panel);
    }
    panel.replaceChildren(
      heading('📁 フォルダ一覧の確認依頼', `${requests.length} 件`),
      small(
        '担当者があなたの PC のフォルダ一覧の確認を依頼しています。読み取り専用です。いつでも取り消せます。',
      ),
      ...requests.map(mineSection),
      errorLine(MINE.actionError) ?? document.createTextNode(''),
      errorLine(MINE.error) ?? document.createTextNode(''),
      MINE.busy ? small('処理中…') : document.createTextNode(''),
    );
  }

  setInterval(ensureStaffPanel, 1500);
  setInterval(() => {
    if (document.hidden) return;
    if (!document.getElementById('aihdFolderAccessPanel') || !STAFF.caseId) return;
    if (STAFF.available || Date.now() >= STAFF.retryAt) void loadStaff();
  }, 6000);
  setInterval(() => {
    if (!document.hidden) void loadMine();
  }, 8000);
  window.addEventListener(
    'load',
    () => {
      ensureStaffPanel();
      void loadMine();
    },
    { once: true },
  );
})();
