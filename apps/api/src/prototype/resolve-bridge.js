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
    mode: 'idle', // idle | proposed | executing | result | stopped | escalated | error
    busy: false,
    error: null,
    pollTimer: null,
    lastKey: '',
  };

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

  function poll() {
    stopPolling();
    STATE.pollTimer = setInterval(async () => {
      if (!STATE.step || STATE.mode !== 'executing') {
        stopPolling();
        return;
      }
      try {
        const data = await api(`/api/resolve/steps/${STATE.step.id}`);
        STATE.session = data.session;
        STATE.step = data.step;
        const status = data.step?.status;
        if (status === 'done') {
          STATE.mode = 'result';
          stopPolling();
        } else if (status === 'failed') {
          STATE.mode = 'escalated';
          stopPolling();
        } else if (status === 'rejected' || status === 'cancelled') {
          STATE.mode = 'stopped';
          stopPolling();
        }
        render(true);
      } catch (error) {
        stopPolling();
        STATE.mode = 'error';
        STATE.error = String(error.message || error);
        render(true);
      }
    }, 1500);
  }

  async function continueLoop(decision) {
    if (!STATE.step || STATE.busy) return;
    STATE.busy = true;
    STATE.error = null;
    try {
      const data = await api(`/api/resolve/steps/${STATE.step.id}/continue`, { decision });
      STATE.session = data.session;
      STATE.step = data.step;
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
      STATE.busy = false;
      STATE.error = String(error.message || error);
      render(true);
      toast?.(`続行できませんでした: ${STATE.error}`, 'bad');
    }
  }

  async function stop() {
    if (!STATE.session?.id || STATE.busy) return;
    STATE.busy = true;
    try {
      const data = await api(`/api/resolve/sessions/${STATE.session.id}/stop`, {});
      STATE.session = data.session;
      STATE.mode = 'stopped';
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
        '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">' +
        '<button class="u-btn pri" data-aihd-resolve="approve" data-decision="Y">実行する（Y）</button>' +
        '<button class="u-btn" data-aihd-resolve="approve" data-decision="N">やめる（N）</button>' +
        '<button class="u-btn" data-aihd-resolve="stop">中止</button></div>';
    } else if (STATE.mode === 'executing') {
      body =
        '<div style="margin-top:8px">端末で読み取りを実行しています…</div>' +
        '<div class="u-small u-muted" style="margin-top:4px">端末エージェントが応答すると結果が表示されます。</div>' +
        '<div style="margin-top:10px"><button class="u-btn" data-aihd-resolve="stop">中止</button></div>';
    } else if (STATE.mode === 'result' && STATE.step) {
      body =
        '<div style="margin-top:8px"><b>結果</b></div>' +
        '<pre class="u-small" style="white-space:pre-wrap;background:#f5f7fa;border:1px solid #d9e2ec;border-radius:6px;padding:8px;max-height:320px;overflow:auto">' +
        esc(resultText(STATE.step)) +
        '</pre>' +
        '<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">' +
        '<button class="u-btn pri" data-aihd-resolve="continue" data-decision="Y">続ける（Y）</button>' +
        '<button class="u-btn" data-aihd-resolve="continue" data-decision="N">やめる（N）</button>' +
        '<button class="u-btn" data-aihd-resolve="stop">中止</button></div>';
    } else if (STATE.mode === 'stopped') {
      body =
        '<div style="margin-top:8px">解決ループを停止しました。必要ならやり直せます。</div>' +
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
      (STATE.busy ? '<div class="u-small u-muted" style="margin-top:6px">処理中…</div>' : '');
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
  });

  setInterval(ensurePanel, 800);
  window.addEventListener('load', ensurePanel, { once: true });
})();
