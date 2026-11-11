/*
 * ナレッジの検査と承認の進捗（⑤ ナレッジ下書き / ⑥ 承認者の確認）— 新画面ブリッジ
 *
 * 画面仕様書 V1.0 の「AI検査・指摘」（参考表示）と「承認ボタンの制御・チェックの進捗」を
 * 既存の画面へ取り込む（docs/94）。原本 HTML の DOM / CSS / 画面遷移は変更しない。
 *
 * - 検査はサーバーの POST /api/knowledge/inspect を呼ぶ。規則は保存時の伏せ字と
 *   承認時の端末情報検査と同じ正本で、点数は参考。自動修正は行わない。
 * - 承認ボタンは、4項目をすべて確認するまで押せないようにする（表示の制御）。
 *   承認の正当性の検証は従来どおりサーバー側で行う。
 */
(() => {
  if (window.__AIHD_KB_REVIEW_BRIDGE__) return;
  window.__AIHD_KB_REVIEW_BRIDGE__ = { version: 1, at: new Date().toISOString() };

  const INSPECT_PANEL_ID = 'ahdKbInspect';
  const INSPECT_RESULT_ID = 'ahdKbInspectResult';
  const PROGRESS_ID = 'ahdApproveProgress';
  const CHECK_COUNT = 4;
  const STATE = { inspect: { key: '', result: null, error: null, busy: false } };

  const esc = (value) =>
    String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });

  function labelOfType(type) {
    return (
      {
        password: 'パスワード',
        email: 'メールアドレス',
        phone: '電話番号',
        ip: 'IPアドレス',
        card: 'カード番号',
        asset: '資産番号',
        device: '端末情報',
      }[type] || String(type)
    );
  }

  function readForm() {
    const title = document.getElementById('d_title');
    const symptom = document.getElementById('d_sym');
    const cause = document.getElementById('d_cause');
    const steps = document.getElementById('d_steps');
    const keywords = document.getElementById('d_kw');
    if (!title || !symptom || !cause || !steps || !keywords) return null;
    return {
      title: String(title.value || ''),
      symptom: String(symptom.value || ''),
      cause: String(cause.value || ''),
      steps: String(steps.value || ''),
      keywords: String(keywords.value || '')
        .split(/[,、，]/)
        .map((word) => word.trim())
        .filter(Boolean),
    };
  }

  function formSignature(form) {
    if (!form) return '';
    return [form.title, form.symptom, form.cause, form.steps, form.keywords.join(',')].join(
      '\u0000',
    );
  }

  /** 検査結果の HTML（純粋関数・試験対象）。点は参考であることを必ず書く。 */
  function inspectResultHTML(result) {
    if (!result || !Array.isArray(result.items)) {
      return '<div class="hint" style="margin-top:6px">まだ検査していません。</div>';
    }
    const score = Number(result.score) || 0;
    const failed = result.items.filter((item) => !item.ok);
    const items = result.items
      .map(
        (item) =>
          '<li style="margin:2px 0">' +
          (item.ok ? '✓' : '✗') +
          ' ' +
          esc(item.label) +
          (item.detail ? '<span class="hint">（' + esc(item.detail) + '）</span>' : '') +
          '</li>',
      )
      .join('');
    const redactions = Array.isArray(result.redactions) ? result.redactions : [];
    const redacted =
      result.redacted && (result.redacted.title || result.redacted.symptom || result.redacted.steps)
        ? '<details style="margin-top:6px"><summary class="hint">伏せ字にした後の本文を確認</summary>' +
          '<pre class="hint" style="white-space:pre-wrap;margin:6px 0 0">' +
          esc(
            [
              'タイトル: ' + (result.redacted.title || ''),
              '症状: ' + (result.redacted.symptom || ''),
              '原因: ' + (result.redacted.cause || ''),
              '手順: ' + (result.redacted.steps || ''),
            ].join('\n'),
          ) +
          '</pre></details>'
        : '';
    return (
      '<div class="note ' +
      (failed.length ? 'n-warn' : 'n-ok') +
      '" style="margin-top:6px"><b>参考スコア ' +
      score +
      ' / ' +
      (Number(result.maxScore) || 100) +
      '</b>（点数は参考です。承認の可否はサーバーの検査で決まります）' +
      (redactions.length
        ? '<div class="hint">保存時に伏せ字になる項目: ' +
          redactions.map((item) => labelOfType(item.type) + ' ' + item.count + '件').join('、') +
          '</div>'
        : '') +
      '<ul style="margin:6px 0 0;padding-left:18px;list-style:none">' +
      items +
      '</ul>' +
      '<div class="hint" style="margin-top:4px">自動修正は行いません。指摘を確認して、必要な箇所を手で直してください。</div>' +
      redacted +
      '</div>'
    );
  }

  function inspectPanelHTML() {
    return (
      '<div id="' +
      INSPECT_PANEL_ID +
      '" style="margin-top:10px;padding-top:10px;border-top:1px dashed var(--u-line,#d9e2ec)">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px">' +
      '<b>AI検査・指摘 <span class="badge">参考</span></b>' +
      '<button class="btn sm" data-ahd-inspect>AI検査を実行</button></div>' +
      '<div class="hint">保存・承認と同じ規則で、個人情報・端末情報と長さを検査します。点数は参考で、承認の可否はサーバーで判定します。</div>' +
      '<div id="' +
      INSPECT_RESULT_ID +
      '"></div></div>'
    );
  }

  function renderInspect() {
    const result = document.getElementById(INSPECT_RESULT_ID);
    if (!result) return;
    const form = readForm();
    const stale = Boolean(STATE.inspect.key && form && formSignature(form) !== STATE.inspect.key);
    const error = STATE.inspect.error
      ? '<div class="note n-bad" style="margin-top:6px">検査できませんでした（' +
        esc(STATE.inspect.error) +
        '）。時間をおいて再実行してください。</div>'
      : '';
    const busy = STATE.inspect.busy
      ? '<div class="hint" style="margin-top:6px">検査しています…</div>'
      : '';
    const warning = stale
      ? '<div class="hint" style="margin-top:6px">本文が変わっています。再実行してください。</div>'
      : '';
    result.innerHTML = busy + error + warning + inspectResultHTML(STATE.inspect.result);
  }

  function inspect() {
    const form = readForm();
    if (!form || STATE.inspect.busy) return;
    const key = formSignature(form);
    STATE.inspect.busy = true;
    STATE.inspect.error = null;
    renderInspect();
    fetch('/api/knowledge/inspect', {
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
        STATE.inspect = { key, result: data, error: null, busy: false };
        renderInspect();
      })
      .catch((error) => {
        STATE.inspect = {
          key,
          result: null,
          error: String((error && error.message) || error).slice(0, 120),
          busy: false,
        };
        renderInspect();
      });
  }

  function progressHTML(checked) {
    const total = CHECK_COUNT;
    const done = Math.max(0, Math.min(total, Number(checked) || 0));
    const ratio = Math.round((done / total) * 100);
    return (
      '<div class="note ' +
      (done === total ? 'n-ok' : 'n-warn') +
      '"><div style="display:flex;justify-content:space-between;gap:8px">' +
      '<b>確認の進捗 ' +
      done +
      '/' +
      total +
      '</b><span class="hint">' +
      (done === total ? 'すべて確認しました' : '4項目すべて確認すると承認できます') +
      '</span></div>' +
      '<div style="height:6px;background:var(--u-line,#e5e7eb);border-radius:4px;overflow:hidden;margin-top:5px">' +
      '<div style="height:100%;width:' +
      ratio +
      '%;background:var(--ok,#2f9e44)"></div></div></div>'
    );
  }

  /** ⑤ ナレッジ下書き: 検査パネルを差し込む（編集できる下書きのときだけ）。 */
  function syncInspect() {
    // ⑤ の編集フォームがあるときだけ（画面の内部状態は公開されていないため DOM で判定する）。
    const title = document.getElementById('d_title');
    const card = title && title.closest ? title.closest('.card') : null;
    if (!card) {
      document.getElementById(INSPECT_PANEL_ID)?.remove();
      return;
    }
    let panel = document.getElementById(INSPECT_PANEL_ID);
    if (!panel) {
      card.insertAdjacentHTML('beforeend', inspectPanelHTML());
      STATE.inspect = { key: '', result: null, error: null, busy: false };
      return;
    }
    renderInspect();
  }

  /** ⑥ 承認者の確認: 進捗を出し、4項目そろうまで承認ボタンを押せなくする。 */
  function syncApproval() {
    // ⑥ のチェックリストがあるときだけ（DOM で判定する）。
    const boxes = [];
    for (let index = 0; index < CHECK_COUNT; index += 1) {
      boxes.push(document.getElementById('ck' + index));
    }
    const first = boxes[0];
    const card = first && first.closest ? first.closest('.card') : null;
    if (!card || boxes.some((box) => !box)) {
      document.getElementById(PROGRESS_ID)?.remove();
      return;
    }
    const checked = boxes.filter((box) => box.checked).length;
    let panel = document.getElementById(PROGRESS_ID);
    if (!panel) {
      const label = first.closest('label');
      panel = document.createElement('div');
      panel.id = PROGRESS_ID;
      if (label && label.parentNode) label.parentNode.insertBefore(panel, label);
      else card.insertBefore(panel, card.firstChild);
    }
    panel.innerHTML = progressHTML(checked);

    const button = Array.from(card.querySelectorAll('button')).find((candidate) =>
      /App\.approve\(/.test(candidate.getAttribute('onclick') || ''),
    );
    if (!button) return;
    if (checked < CHECK_COUNT) {
      if (!button.disabled) {
        button.disabled = true;
        button.setAttribute('data-ahd-gate', '1');
        button.setAttribute('aria-disabled', 'true');
        button.style.opacity = '0.55';
        button.title = '4項目すべて確認すると押せます';
      }
    } else if (button.getAttribute('data-ahd-gate') === '1') {
      button.disabled = false;
      button.removeAttribute('data-ahd-gate');
      button.removeAttribute('aria-disabled');
      button.style.opacity = '';
      button.removeAttribute('title');
    }
  }

  function sync() {
    syncInspect();
    syncApproval();
  }

  document.addEventListener('click', (event) => {
    const button =
      event.target && event.target.closest ? event.target.closest('[data-ahd-inspect]') : null;
    if (!button) return;
    event.preventDefault();
    inspect();
  });

  document.addEventListener('change', (event) => {
    const target = event.target;
    if (!target || !target.getAttribute) return;
    const id = target.getAttribute('id') || '';
    if (/^ck[0-3]$/.test(id)) syncApproval();
  });

  let scheduled = false;
  const scheduleSync = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      try {
        sync();
      } catch (error) {
        console.warn('[kb-review] sync failed', error);
      }
    }, 80);
  };

  const root = document.getElementById('hdMain') || document.body;
  if (root) {
    new MutationObserver(scheduleSync).observe(root, { childList: true, subtree: true });
  }
  window.addEventListener('load', scheduleSync);
  setInterval(scheduleSync, 1000);
  scheduleSync();
})();
