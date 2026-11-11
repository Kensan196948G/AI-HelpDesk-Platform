/*
 * 代行受付の入力チェック（① 受付）— 新画面ブリッジ
 *
 * 画面仕様書 V1.0 の「入力中のリアルタイム判定」を、代行受付の画面へ取り込む
 * （docs/97）。条件どおり、**ルールベースのみ**で実 AI は呼ばない。
 *
 * 判定はサーバーの `POST /api/intake/preview`（読み取り専用）。規則は
 * domain/signal.ts（セキュリティの初期色）と domain/pii.ts（個人情報）の
 * 既存の正本を使う。入力は 500ms 止まったときだけ送る。
 */
(() => {
  if (window.__AIHD_INTAKE_PREVIEW_BRIDGE__) return;
  window.__AIHD_INTAKE_PREVIEW_BRIDGE__ = { version: 1, at: new Date().toISOString() };

  const PANEL_ID = 'ahdIntakePreview';
  const BODY_ID = 'ahdIntakePreviewBody';
  const DEBOUNCE_MS = 500;
  const STATE = { key: '', busy: false, timer: null, error: null, result: null };

  const esc = (value) =>
    String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });

  function categoryOf(value) {
    return value === 'security' ? 'security' : 'other';
  }

  function urgencyOf(value) {
    return value === '高' ? 'urgent' : 'normal';
  }

  function readForm() {
    const subject = document.getElementById('i_sub');
    const body = document.getElementById('i_body');
    if (!subject || !body) return null;
    const cat = document.getElementById('i_cat');
    const urgency = document.getElementById('i_u');
    return {
      subject: String(subject.value || ''),
      body: String(body.value || ''),
      category: categoryOf(cat ? cat.value : ''),
      urgency: urgencyOf(urgency ? urgency.value : ''),
    };
  }

  function signature(form) {
    return [form.subject, form.body, form.category, form.urgency].join('\u0000');
  }

  /** 判定結果の HTML（純粋関数・試験対象）。AI を呼んでいないことを必ず書く。 */
  function previewHTML(result) {
    if (!result || !Array.isArray(result.notes)) {
      return '<div class="hint">まだ判定していません。</div>';
    }
    const signal = result.signal === 'red' ? '赤（AIに任せない）' : '青（AIで進められる）';
    const notes = result.notes
      .map((note) => {
        const cls = note.level === 'red' ? 'n-bad' : note.level === 'warn' ? 'n-warn' : 'hint';
        return '<div class="' + cls + '" style="margin-top:4px">' + esc(note.text) + '</div>';
      })
      .join('');
    return (
      '<div style="display:flex;justify-content:space-between;gap:8px;margin-top:4px">' +
      '<b>信号の見立て：' +
      esc(signal) +
      '</b><span class="hint">参考（保存時の判定と同じ規則）</span></div>' +
      notes
    );
  }

  function panelHTML() {
    return (
      '<div id="' +
      PANEL_ID +
      '" class="note" style="margin-top:10px">' +
      '<div style="display:flex;justify-content:space-between;gap:8px">' +
      '<b>入力チェック <span class="badge">ルールベース</span></b>' +
      '<span class="hint">AIは呼びません</span></div>' +
      '<div id="' +
      BODY_ID +
      '"></div>' +
      '<div class="hint" style="margin-top:4px">入力が止まったときだけ確認します。担当者の判断を置き換えるものではありません。</div></div>'
    );
  }

  function render() {
    const body = document.getElementById(BODY_ID);
    if (!body) return;
    const error = STATE.error
      ? '<div class="n-warn" style="margin-top:4px">入力チェックを取得できませんでした（' +
        esc(STATE.error) +
        '）。受付の操作はそのまま続けられます。</div>'
      : '';
    body.innerHTML = error || previewHTML(STATE.result);
  }

  function requestPreview() {
    const form = readForm();
    if (!form) return;
    const key = signature(form);
    if (key === STATE.key || STATE.busy) return;
    STATE.busy = true;
    STATE.error = null;
    fetch('/api/intake/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(form),
    })
      .then(async (response) => {
        const data = await response.json().catch(() => null);
        if (!response.ok) {
          const code =
            (data && data.error && (data.error.code || data.error.message)) ||
            'HTTP ' + response.status;
          throw new Error(String(code));
        }
        return data;
      })
      .then((data) => {
        STATE.key = key;
        STATE.result = data;
        STATE.busy = false;
        render();
      })
      .catch((error) => {
        STATE.key = key;
        STATE.result = null;
        STATE.error = String((error && error.message) || error).slice(0, 120);
        STATE.busy = false;
        render();
      });
  }

  function schedule() {
    if (STATE.timer) clearTimeout(STATE.timer);
    STATE.timer = setTimeout(() => {
      STATE.timer = null;
      requestPreview();
    }, DEBOUNCE_MS);
  }

  function ensurePanel() {
    const subject = document.getElementById('i_sub');
    if (!subject) {
      document.getElementById(PANEL_ID)?.remove();
      return;
    }
    if (document.getElementById(PANEL_ID)) return;
    const submit = Array.from(document.querySelectorAll('#hdMain button')).find(
      (button) => button.textContent.trim() === '受付して運び役に渡す',
    );
    const anchor = submit ? submit.closest('.btns') : null;
    if (anchor) anchor.insertAdjacentHTML('beforebegin', panelHTML());
    else subject.closest('.card')?.insertAdjacentHTML('beforeend', panelHTML());
    render();
  }

  document.addEventListener('input', (event) => {
    const target = event.target;
    if (!target || !target.getAttribute) return;
    const id = target.getAttribute('id');
    if (id === 'i_sub' || id === 'i_body') schedule();
  });

  document.addEventListener('change', (event) => {
    const target = event.target;
    if (!target || !target.getAttribute) return;
    const id = target.getAttribute('id');
    if (id === 'i_cat' || id === 'i_u') schedule();
  });

  let scheduled = false;
  const sync = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      try {
        ensurePanel();
      } catch (error) {
        console.warn('[intake-preview] sync failed', error);
      }
    }, 80);
  };

  const root = document.getElementById('hdMain') || document.body;
  if (root) new MutationObserver(sync).observe(root, { childList: true, subtree: true });
  window.addEventListener('load', sync);
  setInterval(sync, 1000);
  sync();
})();
