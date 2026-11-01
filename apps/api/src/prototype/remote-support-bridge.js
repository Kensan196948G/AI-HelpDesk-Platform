/*
 * AI HelpDesk remote support bridge（Phase 1）
 *
 * 担当者（helpdesk / approver）がケース画面から MeshAgent の状態確認・導入依頼・
 * RSP への遷移を行う。API は担当者以外に 403 を返すため、その場合はパネルを出さない。
 * 担当者以外は API を呼ばない（staff-access-bridge.js）。403 を受けたら以後も呼ばない。
 */
(() => {
  if (window.__AIHD_REMOTE_SUPPORT_BRIDGE__) return;
  window.__AIHD_REMOTE_SUPPORT_BRIDGE__ = { version: 1, at: new Date().toISOString() };

  const STATE = {
    caseId: null,
    data: null,
    busy: false,
    error: null,
    hostname: '',
    matches: null,
    selected: null,
    lastKey: '',
    loading: false,
  };

  const CAPABILITY = 'remoteSupport';

  function esc(value) {
    return String(value ?? '').replace(
      /[&<>"']/g,
      (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
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
    } catch (error) {
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

  function currentCaseId() {
    try {
      const c = typeof curCase === 'function' ? curCase() : null;
      return c?.id ?? null;
    } catch (error) {
      return null;
    }
  }

  async function load(force) {
    const caseId = currentCaseId();
    if (!caseId) return;
    if (!force && STATE.caseId === caseId && STATE.data) return;
    // パネルは画面の再描画で消えて作り直されるため、応答待ちの間は重ねて呼ばない。
    if (!force && STATE.loading) return;
    STATE.caseId = caseId;
    STATE.error = null;
    STATE.loading = true;
    const access = window.__AIHD_STAFF_ACCESS__;
    try {
      if (access && !(await access.allowed(CAPABILITY))) {
        STATE.data = null;
      } else {
        const data = await api(`/api/remote-support/session?caseId=${encodeURIComponent(caseId)}`);
        STATE.data = data;
        if (!STATE.hostname) STATE.hostname = data.link?.hostname ?? '';
      }
    } catch (error) {
      // 担当者以外・引き継ぎ前は表示しない。
      STATE.data = null;
      // 404（引き継ぎ前）は止めない。引き継ぎ後にパネルを出す必要がある。
      if (error.status === 403) access?.deny(CAPABILITY);
      if (error.status !== 403 && error.status !== 404) {
        STATE.error = String(error.message || error);
      }
    } finally {
      STATE.loading = false;
    }
    render(true);
  }

  async function lookup() {
    if (!STATE.caseId || STATE.busy || !STATE.hostname.trim()) return;
    STATE.busy = true;
    STATE.error = null;
    try {
      const data = await api('/api/remote-support/lookup', {
        caseId: STATE.caseId,
        hostname: STATE.hostname.trim(),
      });
      STATE.matches = data.matches ?? [];
      STATE.selected = STATE.matches.length === 1 ? STATE.matches[0].device_id : null;
    } catch (error) {
      STATE.error = String(error.message || error);
      STATE.matches = [];
    } finally {
      STATE.busy = false;
      render(true);
    }
  }

  async function saveLink() {
    if (!STATE.caseId || STATE.busy || !STATE.selected) return;
    STATE.busy = true;
    STATE.error = null;
    try {
      const data = await api('/api/remote-support/link', {
        caseId: STATE.caseId,
        hostname: STATE.hostname.trim(),
        rspDeviceId: STATE.selected,
      });
      STATE.data = { ...(STATE.data ?? {}), link: data.link };
      STATE.matches = null;
      STATE.selected = null;
    } catch (error) {
      STATE.error = String(error.message || error);
    } finally {
      STATE.busy = false;
      render(true);
    }
  }

  async function ensureAgent() {
    if (!STATE.caseId || STATE.busy) return;
    STATE.busy = true;
    STATE.error = null;
    try {
      const data = await api('/api/remote-support/ensure', { caseId: STATE.caseId });
      STATE.data = { ...(STATE.data ?? {}), ...data };
      setTimeout(() => void load(true), 5000);
    } catch (error) {
      STATE.error = String(error.message || error);
    } finally {
      STATE.busy = false;
      render(true);
    }
  }

  function installLabel(install) {
    if (!install) return '未確認';
    if (install.agentInstalled)
      return install.agentOnline ? '導入済み・online' : '導入済み・offline';
    if (install.status === 'triggered') return '導入待ち（展開キュー）';
    if (install.status === 'failed') return '導入できませんでした';
    return install.status;
  }

  function render(force) {
    const caseId = currentCaseId();
    if (!caseId) return;
    const panel = document.getElementById('aihdRemoteSupportPanel');
    if (!panel) return;
    const key = JSON.stringify({
      caseId,
      data: STATE.data,
      error: STATE.error,
      busy: STATE.busy,
      matches: STATE.matches,
      selected: STATE.selected,
    });
    if (!force && key === STATE.lastKey) return;
    STATE.lastKey = key;

    if (!STATE.data) {
      panel.style.display = 'none';
      panel.innerHTML = '';
      return;
    }
    panel.style.display = '';

    const { session, link, install } = STATE.data;
    let body =
      '<div class="u-small" style="margin-top:6px">' +
      '対象: ' +
      esc(session.userEmail) +
      ' / 端末ID ' +
      esc(session.deviceId) +
      '</div>';

    if (!link) {
      body +=
        '<div class="u-small" style="margin-top:8px">RSP の端末を特定します（hostname 完全一致）。</div>' +
        '<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">' +
        '<input id="aihdRspHostname" class="u-input" style="min-width:200px" ' +
        'placeholder="例: 202010001M" value="' +
        esc(STATE.hostname) +
        '" />' +
        '<button class="u-btn" data-aihd-remote="lookup">検索</button>' +
        '</div>';
      if (STATE.matches) {
        if (!STATE.matches.length) {
          body += '<div class="u-small" style="margin-top:6px">該当する端末がありません。</div>';
        } else {
          body +=
            '<div class="u-small" style="margin-top:6px">候補（' +
            STATE.matches.length +
            '件）</div>' +
            STATE.matches
              .map(
                (m) =>
                  '<label class="u-small" style="display:block;margin-top:2px">' +
                  '<input type="radio" name="aihdRspDevice" value="' +
                  esc(m.device_id) +
                  '"' +
                  (STATE.selected === m.device_id ? ' checked' : '') +
                  ' /> ' +
                  esc(m.hostname) +
                  (m.agent_installed ? '（導入済み）' : '（未導入）') +
                  '</label>',
              )
              .join('') +
            '<div style="margin-top:6px"><button class="u-btn pri" data-aihd-remote="link">この端末で確定</button></div>';
        }
      }
    } else {
      body +=
        '<div class="u-small" style="margin-top:6px">端末: <b>' +
        esc(link.hostname) +
        '</b> / MeshAgent: <b>' +
        esc(installLabel(install)) +
        '</b></div>' +
        '<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">' +
        '<button class="u-btn" data-aihd-remote="ensure"' +
        (install?.agentInstalled ? ' disabled' : '') +
        '>導入を依頼</button>' +
        '<button class="u-btn" data-aihd-remote="refresh">状態を更新</button>' +
        '<a class="u-btn" href="' +
        esc(STATE.data.rspPublicUrl || '#') +
        '" target="_blank" rel="noopener">RSPで開く</a>' +
        '</div>' +
        '<div class="u-small u-muted" style="margin-top:6px">展開は平日 15 分間隔です。完了まで時間がかかります。</div>';
    }

    panel.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px">' +
      '<b>🛟 遠隔対応</b>' +
      '<span class="u-small u-muted">' +
      esc(installLabel(install)) +
      '</span></div>' +
      body +
      (STATE.error
        ? '<div class="u-small" style="margin-top:6px;color:#b42318">' + esc(STATE.error) + '</div>'
        : '') +
      (STATE.busy ? '<div class="u-small u-muted" style="margin-top:6px">処理中…</div>' : '');
  }

  function ensurePanel() {
    if (!currentCaseId()) return;
    if (!document.querySelector('#wzPane')) return;
    let panel = document.getElementById('aihdRemoteSupportPanel');
    if (!panel) {
      const wiz = document.querySelector('.w-wiz');
      if (!wiz || !wiz.parentNode) return;
      panel = document.createElement('div');
      panel.id = 'aihdRemoteSupportPanel';
      panel.className = 'u-card';
      panel.style.cssText = 'margin-top:12px;padding:12px;display:none';
      const resolvePanel = document.getElementById('aihdResolvePanel');
      if (resolvePanel) wiz.parentNode.insertBefore(panel, resolvePanel);
      else wiz.parentNode.insertBefore(panel, wiz.nextSibling);
      STATE.lastKey = '';
      render(true);
      void load(false);
      return;
    }
    render(false);
    if (STATE.caseId !== currentCaseId()) void load(false);
  }

  document.addEventListener('click', (event) => {
    const button = event.target?.closest?.('[data-aihd-remote]');
    if (!button) return;
    const action = button.getAttribute('data-aihd-remote');
    if (action === 'lookup') {
      STATE.hostname = document.getElementById('aihdRspHostname')?.value ?? STATE.hostname;
      void lookup();
    } else if (action === 'link') void saveLink();
    else if (action === 'ensure') void ensureAgent();
    else if (action === 'refresh') void load(true);
  });

  document.addEventListener('change', (event) => {
    const input = event.target;
    if (input?.name === 'aihdRspDevice') STATE.selected = input.value;
  });

  document.addEventListener('input', (event) => {
    if (event.target?.id === 'aihdRspHostname') STATE.hostname = event.target.value;
  });

  setInterval(ensurePanel, 800);
  window.addEventListener('load', ensurePanel, { once: true });
})();
