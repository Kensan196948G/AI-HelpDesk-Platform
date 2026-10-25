/*
 * AI HelpDesk prototype device bridge.
 * - ログイン中のブラウザから、実端末のハードウェア・ソフトウェア情報を読み取り取得する。
 * - 取得結果を /api/device/browser へ送り、サーバーが正規化したスナップショットを
 *   既存プロトタイプの pcSnapshot() に差し込む（DOM / CSS は変更しない）。
 * - 端末エージェントが導入済みの場合は、サーバー側でブラウザ情報とマージされる。
 *
 * 取得しないもの: ファイル内容 / 閲覧履歴 / 画面 / キー入力 / メール本文。
 */
(() => {
  const FIVE_MIN = 5 * 60 * 1000;
  const state = {
    snapshot: null,
    local: null,
    inventory: null,
    fetchedAt: 0,
    pending: null,
  };

  function safeStorageGet(key) {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  function safeStorageSet(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (error) {
      // ignore
    }
  }

  function deviceId() {
    let id = safeStorageGet('aihd.device.id');
    if (!id) {
      id =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      safeStorageSet('aihd.device.id', id);
    }
    return id;
  }

  async function highEntropy() {
    const uaData = navigator.userAgentData;
    if (!uaData || typeof uaData.getHighEntropyValues !== 'function') return {};
    try {
      return await uaData.getHighEntropyValues([
        'platformVersion',
        'architecture',
        'bitness',
        'model',
        'uaFullVersion',
        'fullVersionList',
      ]);
    } catch (error) {
      return {};
    }
  }

  function osLabel(platform, high) {
    const name = String(platform || navigator.platform || '');
    const version = String(high.platformVersion || '');
    if (/win/i.test(name)) {
      if (/^1[3-9]\./.test(version)) return `Windows 11${version ? ` (${version})` : ''}`;
      if (/^(0|10)\./.test(version)) return `Windows 10${version ? ` (${version})` : ''}`;
      return `Windows${version ? ` (${version})` : ''}`;
    }
    if (/mac/i.test(name)) return `macOS${version ? ` ${version}` : ''}`;
    if (/android/i.test(name)) return `Android${version ? ` ${version}` : ''}`;
    if (/cros/i.test(name)) return `ChromeOS${version ? ` ${version}` : ''}`;
    if (/linux/i.test(name)) return 'Linux';
    if (name) return name;
    const ua = navigator.userAgent;
    if (/Windows NT 10\.0/.test(ua)) return 'Windows 10/11';
    if (/Mac OS X/.test(ua)) return 'macOS';
    return '未検出（ブラウザ）';
  }

  function browserInfo(uaData, high) {
    const brands = high.fullVersionList || uaData?.brands || [];
    const order = ['Microsoft Edge', 'Google Chrome', 'Chromium', 'Brave', 'Opera'];
    for (const name of order) {
      const found = brands.find((brand) => {
        try {
          return new RegExp(name.replace(/\s+/g, '.?'), 'i').test(brand.brand || '');
        } catch (error) {
          return false;
        }
      });
      if (found) {
        return {
          name: found.brand,
          version: found.version || high.uaFullVersion || '',
          userAgent: navigator.userAgent,
          languages: navigator.languages ? Array.from(navigator.languages).slice(0, 10) : [],
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          maxTouchPoints: navigator.maxTouchPoints || 0,
        };
      }
    }
    const ua = navigator.userAgent;
    const match = ua.match(/(Edg|Chrome|Firefox|Version)\/([\d.]+)/);
    const names = {
      Edg: 'Microsoft Edge',
      Chrome: 'Google Chrome',
      Firefox: 'Firefox',
      Version: 'Safari',
    };
    return {
      name: match ? names[match[1]] || match[1] : 'ブラウザ',
      version: match ? match[2] : '',
      userAgent: ua,
      languages: navigator.languages ? Array.from(navigator.languages).slice(0, 10) : [],
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      maxTouchPoints: navigator.maxTouchPoints || 0,
    };
  }

  function gpuInfo() {
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (!gl) return undefined;
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const vendor = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : undefined;
      const renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : undefined;
      return {
        vendor: typeof vendor === 'string' ? vendor.slice(0, 200) : undefined,
        name: typeof renderer === 'string' ? renderer.slice(0, 300) : undefined,
      };
    } catch (error) {
      return undefined;
    }
  }

  async function mediaDevices() {
    try {
      if (!navigator.mediaDevices?.enumerateDevices) return undefined;
      const devices = await navigator.mediaDevices.enumerateDevices();
      return {
        audioOutput: devices.filter((device) => device.kind === 'audiooutput').length,
        audioInput: devices.filter((device) => device.kind === 'audioinput').length,
        videoInput: devices.filter((device) => device.kind === 'videoinput').length,
      };
    } catch (error) {
      return undefined;
    }
  }

  async function collectBrowser() {
    const uaData = navigator.userAgentData;
    const high = await highEntropy();
    const connection =
      navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    const [storage, battery, devices] = await Promise.all([
      navigator.storage?.estimate?.().catch(() => undefined) ?? Promise.resolve(undefined),
      navigator.getBattery?.().catch(() => undefined) ?? Promise.resolve(undefined),
      mediaDevices(),
    ]);
    const screenInfo = {
      width: screen.width,
      height: screen.height,
      pixelRatio: window.devicePixelRatio || 1,
      colorDepth: screen.colorDepth,
    };
    const arch = [high.architecture, high.bitness ? `${high.bitness}-bit` : '']
      .filter(Boolean)
      .join(' ');
    const info = browserInfo(uaData, high);
    return {
      deviceId: deviceId(),
      platform: uaData?.platform || navigator.platform || undefined,
      os: osLabel(uaData?.platform || navigator.platform, high),
      arch: arch || undefined,
      browser: info,
      hardware: {
        cpuCores: navigator.hardwareConcurrency || undefined,
        deviceMemoryGB: navigator.deviceMemory || undefined,
        screen: screenInfo,
        gpu: gpuInfo(),
        storage: storage ? { quotaBytes: storage.quota, usageBytes: storage.usage } : undefined,
        battery: battery ? { level: battery.level, charging: battery.charging } : undefined,
        network: {
          online: navigator.onLine,
          effectiveType: connection?.effectiveType,
          downlinkMbps: connection?.downlink,
          rttMs: connection?.rtt,
        },
        mediaDevices: devices,
      },
      software: {
        pdfViewer: navigator.pdfViewerEnabled,
        cookiesEnabled: navigator.cookieEnabled,
      },
      collectedAt: new Date().toISOString(),
    };
  }

  function localSnapshot(payload) {
    const cores = payload.hardware?.cpuCores;
    const memory = payload.hardware?.deviceMemoryGB;
    const screenInfo = payload.hardware?.screen;
    const gpu = payload.hardware?.gpu;
    const items = [
      {
        grp: '端末',
        k: 'コンピュータ名',
        v: '未検出（ブラウザ）',
        lv: 'ok',
        note: '端末エージェントを導入するとコンピュータ名を取得できます',
        tag: '',
      },
      {
        grp: '端末',
        k: 'OS',
        v: payload.os || '未検出（ブラウザ）',
        lv: 'ok',
        note: 'ブラウザから取得',
        tag: '',
      },
      {
        grp: '端末',
        k: 'PCエージェント',
        v: 'ブラウザ取得（ローカル）',
        lv: 'ok',
        note: 'サーバー未接続のためブラウザ情報のみ',
        tag: '',
      },
      {
        grp: '端末',
        k: 'シリアル番号',
        v: '端末エージェント未導入',
        lv: 'ok',
        note: '端末エージェントを導入すると取得できます',
        tag: '',
      },
      {
        grp: 'リソース',
        k: 'CPU使用率（5分平均）',
        v: cores ? `未検出（ブラウザ・${cores} 論理コア）` : '未検出（ブラウザ）',
        lv: 'ok',
        note: '',
        tag: '遅い|重い|固ま',
      },
      {
        grp: 'リソース',
        k: 'メモリ使用率',
        v: memory ? `約 ${memory} GB（ブラウザ推定）` : '未検出（ブラウザ）',
        lv: 'ok',
        note: '',
        tag: '遅い|重い|固ま',
      },
      {
        grp: 'リソース',
        k: 'ディスクの空き',
        v: '端末エージェント未導入',
        lv: 'ok',
        note: '端末エージェントを導入すると取得できます',
        tag: '容量|空き',
      },
      {
        grp: 'ネットワーク',
        k: '接続の種類',
        v:
          payload.hardware?.network?.online === false
            ? 'オフライン'
            : `ブラウザ回線: ${String(payload.hardware?.network?.effectiveType || 'online').toUpperCase()}`,
        lv: 'ok',
        note: '',
        tag: 'ネット|接続',
      },
      {
        grp: 'ネットワーク',
        k: 'IPアドレス',
        v: '未検出（ブラウザ）',
        lv: 'ok',
        note: 'ブラウザからは取得しません',
        tag: '',
      },
      {
        grp: 'ソフトウェア',
        k: 'ブラウザ',
        v:
          [payload.browser?.name, payload.browser?.version].filter(Boolean).join(' ') ||
          '未検出（ブラウザ）',
        lv: 'ok',
        note: '',
        tag: '',
      },
      {
        grp: 'ソフトウェア',
        k: '画面',
        v: screenInfo
          ? `${screenInfo.width} × ${screenInfo.height}（${screenInfo.pixelRatio}x / ${screenInfo.colorDepth}bit）`
          : '未検出（ブラウザ）',
        lv: 'ok',
        note: '',
        tag: '',
      },
      {
        grp: 'ソフトウェア',
        k: 'GPU',
        v: gpu ? [gpu.vendor, gpu.name].filter(Boolean).join(' ') : '未検出（ブラウザ）',
        lv: 'ok',
        note: '',
        tag: '',
      },
      {
        grp: '周辺機器',
        k: '音声の出力先',
        v: payload.hardware?.mediaDevices?.audioOutput
          ? `ブラウザ検出 ${payload.hardware.mediaDevices.audioOutput} 台`
          : '未検出（ブラウザ）',
        lv: 'ok',
        note: '',
        tag: '音|会議',
      },
      {
        grp: 'セキュリティ',
        k: 'ウイルス対策',
        v: '端末エージェント未導入',
        lv: 'ok',
        note: '端末エージェントを導入すると確認できます',
        tag: 'ウイルス|セキュリティ',
      },
      {
        grp: 'セキュリティ',
        k: 'ディスク暗号化',
        v: '端末エージェント未導入',
        lv: 'ok',
        note: '端末エージェントを導入すると確認できます',
        tag: '紛失|盗難',
      },
      {
        grp: 'セキュリティ',
        k: 'Windows Update',
        v: '端末エージェント未導入',
        lv: 'ok',
        note: '端末エージェントを導入すると確認できます',
        tag: '更新|再起動',
      },
    ];
    return {
      at: payload.collectedAt,
      device: `WEB-${String(payload.deviceId || 'unknown')
        .slice(0, 8)
        .toUpperCase()}`,
      items,
      ver: 1,
    };
  }

  async function fetchInventory() {
    const response = await fetch('/api/device/inventory', {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`inventory HTTP ${response.status}`);
    const data = await response.json();
    if (data.snapshot) {
      state.snapshot = data.snapshot;
      state.inventory = data.inventory || null;
      state.fetchedAt = Date.now();
    }
    return state.snapshot;
  }

  async function ensureSnapshot(force) {
    if (!force && state.snapshot && Date.now() - state.fetchedAt < FIVE_MIN) {
      return state.snapshot;
    }
    if (state.pending) return state.pending;
    state.pending = (async () => {
      try {
        const payload = await collectBrowser();
        state.local = localSnapshot(payload);
        const response = await fetch('/api/device/browser', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!response.ok) throw new Error(`device HTTP ${response.status}`);
        const data = await response.json();
        if (data.snapshot) {
          state.snapshot = data.snapshot;
          state.inventory = data.inventory || null;
          state.fetchedAt = Date.now();
        }
        return state.snapshot;
      } catch (error) {
        // POST が失敗しても、エージェントが取得済みなら GET で拾う。
        try {
          await fetchInventory();
        } catch (innerError) {
          // オフライン時はローカルのブラウザ情報だけを使う。
        }
        return state.snapshot;
      } finally {
        state.pending = null;
      }
    })();
    return state.pending;
  }

  const originalPcSnapshot = typeof window.pcSnapshot === 'function' ? window.pcSnapshot : null;
  window.pcSnapshot = (st, userId) => {
    const source = state.snapshot || state.local;
    if (source) return Object.assign({}, source, { userId });
    return originalPcSnapshot ? originalPcSnapshot(st, userId) : null;
  };

  const originalPcStart = typeof window.pcStart === 'function' ? window.pcStart : null;
  if (originalPcStart) {
    window.pcStart = (c) => {
      if (state.snapshot || state.local) return originalPcStart(c);
      ensureSnapshot(false).finally(() => originalPcStart(c));
    };
  }

  /*
   * 旧スナップショットの移行。
   * 以前に保存された相談は「資産番号」行と「未取得」を含むため、
   * いまの端末情報で置き換えて、空欄・「未取得」を画面に残さない。
   * 取得時点との差分は pcPrev に残す（「前回から変わった点」で確認できる）。
   */
  function refreshLegacySnapshots() {
    try {
      if (!state.snapshot) return;
      if (typeof S === 'undefined' || !S || !Array.isArray(S.cases)) return;
      const user = typeof me === 'function' ? me() : null;
      if (!user) return;
      let changed = false;
      for (const c of S.cases) {
        if (!c || c.userId !== user.id) continue;
        const snap = c.pc && c.pc.snap;
        if (!snap || !Array.isArray(snap.items)) continue;
        const legacy =
          snap.items.some((row) => row.k === '資産番号') ||
          snap.items.some((row) => String(row.v || '').includes('未取得'));
        if (!legacy) continue;
        const storedDevice = String(snap.device || '');
        const fresh = window.pcSnapshot(S, user.id);
        if (!fresh) continue;
        // 別の端末で取得した記録は上書きしない（ブラウザ取得の記録だけ移行する）。
        if (!(storedDevice.startsWith('WEB-') || storedDevice === String(fresh.device || '')))
          continue;
        c.pcPrev = snap;
        c.pc = Object.assign({}, c.pc, {
          snap: fresh,
          state: 'done',
          shown: typeof PCG !== 'undefined' ? PCG.length : 8,
        });
        changed = true;
      }
      if (!changed) return;
      if (typeof save === 'function') save();
      if (typeof uxRender === 'function') uxRender();
    } catch {
      // 移行に失敗しても、画面はそのまま使えるようにする。
    }
  }

  // AI モデルの表示名を事実に合わせる（レイアウトは変更しない）。
  try {
    if (typeof MODELS === 'object' && MODELS) {
      MODELS.local = 'DeepSeek-V4.1-Flash';
      MODELS.external = 'DeepSeek-V4.1-Flash（承認済み外部）';
      const select = document.querySelector('#model');
      if (select) {
        for (const option of select.options) {
          if (option.value === 'local') option.textContent = MODELS.local;
          if (option.value === 'external') option.textContent = MODELS.external;
        }
      }
    }
  } catch (error) {
    // ignore
  }

  window.__AIHD_DEVICE_ID__ = deviceId();
  window.__AIHD_DEVICE_DEBUG__ = {
    state,
    ensureSnapshot,
    collectBrowser,
    refreshLegacySnapshots,
  };
  ensureSnapshot(false).then(refreshLegacySnapshots);
  setInterval(() => ensureSnapshot(true), 10 * 60 * 1000);
})();
