/*
 * AI HelpDesk employee bridge.
 * - Mirai-Info の社員名簿（/api/employees）を読み込み、画面の「担当（指名）」と
 *   代行受付の「依頼者」プルダウンに反映する。
 * - 名簿はサーバ側のメモリキャッシュのみ（DB へは保存しない）。
 * - 値は社員番号（MK...）、表示は「本部 / 部署 / 氏名」。
 */
(() => {
  const STAFF_SECTION = 'DX推進部';
  const esc = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
    );

  function labelOf(employee) {
    const parts = [employee.division, employee.section, employee.name].filter(Boolean);
    return parts.join(' / ');
  }

  function optionsHtml(all) {
    return (
      '<option value="">（選択してください）</option>' +
      all
        .map(
          (employee) =>
            `<option value="${esc(employee.employeeNo)}">${esc(labelOf(employee))}</option>`,
        )
        .join('')
    );
  }

  function applyToSelects() {
    const options = window.__AIHD_EMPLOYEE_OPTIONS__;
    if (!options) return;
    document.querySelectorAll('select[data-employees="all"]').forEach((select) => {
      const current = select.value;
      select.innerHTML = options;
      if (current) select.value = current;
    });
  }

  async function load() {
    try {
      const response = await fetch('/api/employees?scope=all', {
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) return;
      const data = await response.json();
      const all = Array.isArray(data.employees) ? data.employees : [];
      if (all.length === 0) return;
      window.__AIHD_EMPLOYEES__ = {
        all,
        staff: all.filter((employee) => employee.section === STAFF_SECTION),
      };
      window.__AIHD_EMPLOYEE_OPTIONS__ = optionsHtml(all);
      window.__AIHD_DIR_VERSION__ = (window.__AIHD_DIR_VERSION__ || 0) + 1;
      // 画面側は「操作する人」のグループ（一般社員＝全社員、各ロール＝DX推進部）を
      // このイベントで作り直す。名簿が取れないときは従来のデモ名簿のまま。
      window.dispatchEvent(
        new CustomEvent('aihd-employees', {
          detail: { total: all.length, staff: window.__AIHD_EMPLOYEES__.staff.length },
        }),
      );
      applyToSelects();
      try {
        if (typeof refresh === 'function') refresh();
      } catch (error) {
        // 画面がまだ初期化されていない場合は無視する。
      }
    } catch (error) {
      // 名簿が取得できない場合も、画面は従来のデモ名簿で動かす。
    }
  }

  window.__AIHD_REFRESH_EMPLOYEES__ = load;
  load();
})();
