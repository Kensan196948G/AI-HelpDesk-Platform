#!/usr/bin/env node
/**
 * 読取診断 1 シナリオを、同じ実端末の結果から次の相談まで連続して確かめる（docs/65 §0）。
 *
 * 実機診断と mock の通しを継ぎ合わせない。同じ DB、同じ案件、同じ実行の結果から続ける。
 * 操作は loopback の制御ポートで 1 段ずつ進める。本人の Y や承認の段は、担当の番号選択を得てから呼ぶ。
 *
 * 実条件と違うところ（結果に残す。実受入に数えない）:
 * - 認証は AUTH_MODE=local。Cloudflare Access ではない。
 * - ブラウザはサーバ上のヘッドレス。端末のブラウザではない。
 * - 名簿は合成。担当者と承認者は別アカウントでも同じ人物が判定する（SHARED_IDENTITY_GROUPS で記録）。
 *
 * 使い方:
 *   RDC_DB_URL=.../ai_helpdesk_rdc_e2e PLAYWRIGHT_CORE_PATH=... RDC_OUT=<dir> RDC_CONF=<api.conf> \
 *     node scripts/e2e/real-device-chain.mjs
 *   curl -s 127.0.0.1:19513/<段の名前>
 *
 * 秘密の扱い: デバイストークンは端末への 1 回限りのダウンロードで渡す。RSP のコマンド本文へ入れない。
 * 取得に使うキーは 1 回で失効する。結果とログにトークン、キー、トンネルの URL を書かない。
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import postgres from 'postgres';

if (process.env.NODE_ENV === 'production') process.exit(2);
const dbUrl = process.env.RDC_DB_URL ?? '';
if (!/_e2e$/.test(new URL(dbUrl).pathname)) {
  console.error('RDC_DB_URL の DB 名は _e2e で終わる必要があります。');
  process.exit(2);
}
const root = path.resolve(import.meta.dirname, '..', '..');
const outDir = path.resolve(process.env.RDC_OUT ?? path.join(root, '.e2e-out-rdc'));
mkdirSync(outDir, { recursive: true });
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE_PATH ?? 'playwright-core');

// DEEPSEEK_* の行だけを読み、値を表示しない。
const aiEnv = {};
for (const line of readFileSync(process.env.RDC_CONF ?? '', 'utf8').split('\n')) {
  const match = line.match(/^(DEEPSEEK_[A-Z_]+)=(.*)$/);
  if (match) aiEnv[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
}
if (!aiEnv.DEEPSEEK_API_KEY) {
  console.error('DEEPSEEK_API_KEY がありません。');
  process.exit(2);
}

const PORTS = { requesterA: 19501, staff: 19502, approver: 19503, requesterB: 19504 };
const PROXY = 19512;
const CONTROL = 19513;
const EMAIL = {
  requesterA: 'synth.requester-a@example.test',
  requesterB: 'synth.requester-b@example.test',
  staff: 'synth.staff@example.test',
  approver: 'synth.approver@example.test',
};
const EMP = { requesterA: 'MK9101', requesterB: 'MK9102', staff: 'MK9103', approver: 'MK9104' };
const SUBJECT = '印刷ができません';
const BODY = '印刷ボタンを押してもプリンターから紙が出ません';
// 担当者の対応記録と、利用者向けの手順（合成。実端末の結果の Running を踏まえ、スプーラの再起動を勧めない）。
const CAUSE =
  '読み取りではスプーラは動作中だった。スプーラ以外（既定のプリンター、印刷キュー、本体）を確認する段階。';
const STEPS = [
  '設定 > Bluetooth とデバイス > プリンターとスキャナーで、使いたいプリンターが既定になっているか確認する',
  '同じ画面で「印刷キューを開く」を選び、一時停止やエラーの表示があれば解除する',
  'プリンター本体の電源、用紙、紙詰まりの表示を確認する',
  'テストページを印刷する',
  '直らないときは、試した内容を添えて担当者へ引き継ぐ',
].join('\n');
const TITLE = '印刷しても紙が出ないとき（スプーラが動作中）の確認手順';
const NEXT_CONSULT =
  '印刷しても紙が出ません。スプーラは動いていると言われました。次に何を確認すればいいですか';
const PANEL = '#aihdResolvePanel';

const sql = postgres(dbUrl, { max: 2, onnotice: () => {} });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const children = [];
const dlKey = randomBytes(24).toString('hex');
const configKey = randomBytes(24).toString('hex');
// 導入済みの端末へ触らずに起動し直すときは、DB の端末とトークンをそのまま使う。
const reuseDevice = process.env.RDC_REUSE_DEVICE === '1';
let deviceId = randomUUID();
const deviceToken = randomBytes(32).toString('hex');
let configServed = false;
// 結果へ書かない（docs/65 §0）。
let publicUrl = '';
let deviceRouteOpen = true;
// 実行の結果の報告だけを止める（報告の失敗と実行の失敗を分ける確認）。
let blockResult = false;
let resultBlocked = 0;

const FILES = [
  'scripts/windows/command-agent.ps1',
  'scripts/windows/tests/script-identity-windows.ps1',
  'scripts/skills/approved.json',
  ...['os-info', 'disk-space', 'spooler-status', 'service-status', 'network-adapters'].map(
    (name) => `scripts/skills/windows/${name}.ps1`,
  ),
];

const results = {
  scope: {
    auth: 'AUTH_MODE=local。Cloudflare Access ではない',
    browser: 'サーバ上のヘッドレス。端末のブラウザではない',
    ai: '実 DeepSeek（合成の相談文と合成の KB）',
    executor: 'scripts/windows/command-agent.ps1 + 実端末',
    roster: '合成',
    humans:
      '担当者と承認者は別アカウントだが同じ人物が番号で判定し、操作はエージェントが画面へ送る',
  },
  steps: {},
  ids: {},
  apiLog: {},
};

function record(name, value) {
  results.steps[name] = value;
  writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(results, null, 2));
  return value;
}

function runScript(script, env) {
  const out = spawnSync(process.execPath, ['--import', 'tsx', script], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  if (out.status !== 0) throw new Error(`${script}: exit ${out.status}`);
}

async function prepareDb() {
  const env = {
    NODE_ENV: 'development',
    DATABASE_URL: dbUrl,
    SEED_PASSWORD: randomBytes(12).toString('hex'),
    SESSION_SECRET: randomBytes(32).toString('hex'),
  };
  runScript('scripts/migrate.ts', env);
  runScript('scripts/seed.ts', env);
  await sql`CREATE SCHEMA IF NOT EXISTS mirai_info`;
  await sql`
    CREATE TABLE IF NOT EXISTS mirai_info.employee_directory (
      employee_no text PRIMARY KEY, name text NOT NULL, organization text, division text,
      section text, status text NOT NULL, email text, updated_at timestamptz DEFAULT now()
    )
  `;
  await sql`TRUNCATE mirai_info.employee_directory`;
  for (const [no, name, email, section] of [
    [EMP.requesterA, '合成 相談者A', EMAIL.requesterA, '総務部'],
    [EMP.requesterB, '合成 相談者B', EMAIL.requesterB, '総務部'],
    [EMP.staff, '合成 担当者', EMAIL.staff, 'DX推進部'],
    [EMP.approver, '合成 承認者', EMAIL.approver, 'DX推進部'],
  ]) {
    await sql`
      INSERT INTO mirai_info.employee_directory
        (employee_no, name, organization, division, section, status, email)
      VALUES (${no}, ${name}, '合成組織', '管理本部', ${section}, '有効', ${email})
    `;
  }
  const [user] = await sql`
    INSERT INTO users (email, name, role, password_hash)
    VALUES (${EMAIL.approver}, '合成 承認者', 'approver', 'access-only$no-login')
    ON CONFLICT (lower(email)) DO UPDATE SET role = 'approver', updated_at = now()
    RETURNING id
  `;
  await sql`INSERT INTO user_roles (user_id, role) VALUES (${user.id}, 'approver') ON CONFLICT DO NOTHING`;
  if (reuseDevice) {
    const [existing] = await sql`
      SELECT device_id FROM device_tokens WHERE label = 'real-device-chain'
      ORDER BY created_at DESC LIMIT 1
    `;
    if (!existing) throw new Error('再利用する端末がありません。');
    deviceId = existing.device_id;
    return;
  }
  await sql`
    INSERT INTO device_tokens (token_hash, user_email, label, device_id)
    VALUES (${createHash('sha256').update(deviceToken).digest('hex')}, ${EMAIL.requesterA},
      'real-device-chain', ${deviceId})
  `;
}

async function startApi(role) {
  const port = PORTS[role];
  const log = openSync(path.join(outDir, `api-${role}.log`), 'a');
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/api/src/index.ts'], {
    cwd: root,
    detached: true,
    stdio: ['ignore', log, log],
    env: {
      ...process.env,
      ...aiEnv,
      NODE_ENV: 'development',
      PORT: String(port),
      HOST: '127.0.0.1',
      DATABASE_URL: dbUrl,
      MIRAI_INFO_DATABASE_URL: dbUrl,
      SESSION_SECRET: randomBytes(32).toString('hex'),
      AUTH_MODE: 'local',
      RESOLVE_REQUESTER_DIAGNOSIS_ENABLED: 'true',
      DEV_AUTH_EMAIL: EMAIL[role],
      ALLOW_SELF_APPROVAL: 'false',
      // 担当者と承認者は同じ人物が判定する。別人物の承認に見せない。
      SHARED_IDENTITY_GROUPS: `${EMAIL.staff}|${EMAIL.approver}`,
      MAIL_TRANSPORT: 'disabled',
      LOG_LEVEL: 'warn',
    },
  });
  children.push(child);
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const body = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
      if (body.service === 'ai-helpdesk-api') return;
    } catch {
      // 起動待ち
    }
    await sleep(500);
  }
  throw new Error(`api ${role} が起動しません`);
}

/** 端末へ公開するのはファイルの取得と端末の API だけ。人の画面の API は通さない。 */
function startDeviceProxy() {
  createServer((request, response) => {
    const url = new URL(request.url, 'http://x');
    if (url.pathname === `/cfg/${configKey}`) {
      if (configServed) {
        response.statusCode = 410;
        response.end();
        return;
      }
      configServed = true;
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          url: `${process.env.RDC_PUBLIC_URL ?? publicUrl}/api/device/agent`,
          deviceToken,
          browserDeviceId: deviceId,
          commandIntervalSeconds: 3,
        }),
      );
      return;
    }
    const dlPrefix = `/dl/${dlKey}/`;
    if (url.pathname.startsWith(dlPrefix)) {
      const file = url.pathname.slice(dlPrefix.length);
      if (!FILES.includes(file) || !existsSync(path.join(root, file))) {
        response.statusCode = 404;
        response.end();
        return;
      }
      createReadStream(path.join(root, file)).pipe(response);
      return;
    }
    if (!deviceRouteOpen || !/^\/api\/device\/(agent(\/|$)|command(\/|$))/.test(url.pathname)) {
      response.statusCode = deviceRouteOpen ? 403 : 503;
      response.end();
      return;
    }
    if (blockResult && request.method === 'POST' && /\/result$/.test(url.pathname)) {
      resultBlocked += 1;
      request.resume();
      response.statusCode = 503;
      response.end();
      return;
    }
    const upstream = httpRequest(
      {
        host: '127.0.0.1',
        port: PORTS.requesterA,
        method: request.method,
        path: request.url,
        headers: { ...request.headers, host: '127.0.0.1' },
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    upstream.on('error', () => {
      response.statusCode = 502;
      response.end();
    });
    request.pipe(upstream);
  }).listen(PROXY, '127.0.0.1');
}

const pages = {};
// 二重 Y の確認に使う。画面が受け取った承認の内容を保持する。
const lastChallenge = { value: null };
let browser;

async function openPersona(role) {
  if (pages[role]) return pages[role];
  const context = await browser.newContext({
    viewport: { width: 1360, height: 1000 },
    locale: 'ja-JP',
  });
  if (role === 'requesterA') {
    // 相談者のブラウザを実端末の deviceId に結びつける（端末のブラウザではない）。
    await context.addInitScript((id) => {
      try {
        localStorage.setItem('aihd.device.id', id);
      } catch {
        // 保存できなくても下の待機で失敗する
      }
    }, deviceId);
  }
  const page = await context.newPage();
  const log = [];
  page.on('response', async (response) => {
    const url = new URL(response.url());
    if (url.pathname === '/api/resolve/sessions' && response.request().method() === 'POST') {
      const body = await response.json().catch(() => null);
      lastChallenge.value = body?.step?.approvalChallenge?.payload ?? null;
    }
    if (url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/state')) {
      log.push(
        `${response.request().method()} ${url.pathname.replace(/[0-9a-f-]{36}/g, ':id')} ${response.status()}`,
      );
    }
  });
  await page.goto(`http://127.0.0.1:${PORTS[role]}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof S !== 'undefined' && Boolean(window.__AIHD_DEVICE_ID__));
  await sleep(1500);
  pages[role] = { page, log };
  results.apiLog[role] = log;
  return pages[role];
}

async function newCase(page, subject = SUBJECT, body = BODY) {
  await page.evaluate(() => ACT.wStart());
  await page.waitForSelector('[data-act="wKind"][data-k="pc"]');
  await page.click('[data-act="wKind"][data-k="pc"]');
  await page.click('[data-act="wStep"][data-s="2"]');
  await page.waitForSelector('[data-w="subject"]');
  await page.fill('[data-w="subject"]', subject);
  await page.fill('[data-w="body"]', body);
  await sleep(2500);
  await page.click('[data-act="wSend"]');
  await page.waitForSelector('#wzMsgs');
  await sleep(1800);
  return page.evaluate(() => curCase().id);
}

async function panelText(page) {
  try {
    return await page.innerText(PANEL);
  } catch {
    return '';
  }
}

async function startSession(page) {
  await page.click(`${PANEL} [data-aihd-resolve="start"]`);
  await page.waitForSelector(`${PANEL} [data-aihd-resolve="approve"][data-decision="Y"]`, {
    timeout: 90_000,
  });
  return panelText(page);
}

/** 条件付きの事前承認の機械照合。読み取りの spooler.status、引数なしの提案だけ Y を押す。 */
function assertPreapproved(panel) {
  if (
    !/spooler|スプーラ/.test(panel) ||
    !/読み取りのみ/.test(panel) ||
    !/パラメータ: \{\}/.test(panel)
  ) {
    throw new Error('事前承認の条件に合いません。Y を押しません。');
  }
}

async function commandCount() {
  const [row] = await sql`SELECT count(*)::int AS n FROM device_commands`;
  return row.n;
}

async function latestStep(caseId) {
  const [row] = await sql`
    SELECT s.id AS session_id, s.status AS session_status, st.id AS step_id, st.skill_id,
           st.status AS step_status, st.command_id, st.result_summary, st.knowledge_refs
    FROM resolution_sessions s
    JOIN resolution_steps st ON st.session_id = s.id
    WHERE s.case_id = ${caseId}
    ORDER BY s.created_at DESC, st.seq DESC
    LIMIT 1
  `;
  return row;
}

async function selectStaffRole(page, role, no) {
  const value = `emp:${role}:${no}`;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const found = await page.evaluate(
      (target) =>
        [...(document.querySelector('#uxWho')?.options ?? [])].some((o) => o.value === target),
      value,
    );
    if (found) break;
    await sleep(250);
  }
  await page.selectOption('#uxWho', value);
  await sleep(600);
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(outDir, name), fullPage: true });
}

const STATE = { mainCase: null, handoverId: null, kbId: null };

const STEPS_API = {
  /** 導入に必要な値をファイルに書く。値は標準出力へ出さない。 */
  async bootstrap(url) {
    publicUrl = url.searchParams.get('public') ?? '';
    writeFileSync(
      process.env.RDC_BOOTSTRAP,
      JSON.stringify({ dlKey, configKey, deviceId, files: FILES }),
      { mode: 0o600 },
    );
    return { ok: Boolean(publicUrl) };
  },
  async status() {
    const [row] = await sql`
      SELECT max(last_used_at) AS last_seen FROM device_tokens WHERE device_id = ${deviceId}
    `;
    return {
      configServed,
      lastSeenSecondsAgo: row.last_seen
        ? Math.round((Date.now() - new Date(row.last_seen).getTime()) / 1000)
        : null,
      commands: await commandCount(),
    };
  },

  // ── 拒否の確認（実端末、実 AI。すべて別の案件） ──────────────────
  async negativeN() {
    const { page } = await openPersona('requesterA');
    const before = await commandCount();
    const caseId = await newCase(page);
    const proposal = await startSession(page);
    await page.click(`${PANEL} [data-aihd-resolve="approve"][data-decision="N"]`);
    await sleep(2000);
    const row = await latestStep(caseId);
    return record('negativeN', {
      caseId,
      proposal: proposal.slice(0, 200),
      commandsAdded: (await commandCount()) - before,
      session: row.session_status,
      step: row.step_status,
    });
  },
  /** 同じ提案へ 2 回同時に Y を送る。画面の連打ではなく、画面と同じ API を 2 回呼ぶ。 */
  async negativeDoubleY() {
    const { page } = await openPersona('requesterA');
    const before = await commandCount();
    const caseId = await newCase(page);
    await startSession(page);
    const row = await latestStep(caseId);
    const payload = lastChallenge.value;
    const statuses = await page.evaluate(
      async ([stepId, target]) => {
        const stable = (value) => {
          if (value === null || typeof value !== 'object') return JSON.stringify(value);
          if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
          return `{${Object.entries(value)
            .filter(([, v]) => v !== undefined)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
            .join(',')}}`;
        };
        const digest = await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(stable(target)),
        );
        const approvalHash = [...new Uint8Array(digest)]
          .map((value) => value.toString(16).padStart(2, '0'))
          .join('');
        const send = () =>
          fetch(`/api/resolve/steps/${stepId}/approve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ decision: 'Y', approvalHash }),
          }).then((response) => response.status);
        return Promise.all([send(), send()]);
      },
      [row.step_id, payload],
    );
    await sleep(15_000);
    return record('negativeDoubleY', {
      caseId,
      statuses,
      commandsAdded: (await commandCount()) - before,
      note: '画面の二重クリックではなく API を 2 回同時に呼んだ',
    });
  },
  /** 通信断: 端末の経路を止め、オフラインと判定されてから Y を押す。 */
  async cutDevice() {
    deviceRouteOpen = false;
    return { deviceRouteOpen };
  },
  async restoreDevice() {
    deviceRouteOpen = true;
    return { deviceRouteOpen };
  },
  async negativeOffline() {
    const { page } = await openPersona('requesterA');
    const before = await commandCount();
    const caseId = await newCase(page);
    const started = await panelText(page);
    return record('negativeOffline', {
      caseId,
      connectedGuide: /読み取り診断を開始/.test(started),
      commandsAdded: (await commandCount()) - before,
      chat: (await page.innerText('#wzMsgs')).slice(-400),
    });
  },
  /** 通信断: 提案の後に端末の経路を止め、オフラインと判定されてから Y を押す。 */
  async negativeOfflineY(url) {
    const { page } = await openPersona('requesterA');
    const before = await commandCount();
    const caseId = await newCase(page);
    await startSession(page);
    deviceRouteOpen = false;
    await sleep(Number(url.searchParams.get('wait') ?? 200) * 1000);
    await page.click(`${PANEL} [data-aihd-resolve="approve"][data-decision="Y"]`);
    await sleep(3000);
    const panel = await panelText(page);
    deviceRouteOpen = true;
    return record('negativeOfflineY', {
      caseId,
      commandsAdded: (await commandCount()) - before,
      panel: panel.slice(0, 300),
    });
  },
  /** 期限切れ: 提案だけを作る。Y は承認の期限（5 分）を過ぎてから negativeExpiredY で送る。 */
  async negativeExpiredPropose() {
    const { page } = await openPersona('requesterA');
    const caseId = await newCase(page);
    await startSession(page);
    STATE.expiredCase = caseId;
    STATE.expiredAt = Date.now();
    return { caseId };
  },
  async negativeExpiredY() {
    const { page } = await openPersona('requesterA');
    const before = await commandCount();
    const waitedSeconds = Math.round((Date.now() - STATE.expiredAt) / 1000);
    await page.click(`${PANEL} [data-aihd-resolve="approve"][data-decision="Y"]`);
    await sleep(3000);
    return record('negativeExpired', {
      caseId: STATE.expiredCase,
      waitedSeconds,
      commandsAdded: (await commandCount()) - before,
      panel: (await panelText(page)).slice(0, 300),
    });
  },
  /** 取消: 提案の後に中止する。 */
  async negativeAbort() {
    const { page } = await openPersona('requesterA');
    const before = await commandCount();
    const caseId = await newCase(page);
    await startSession(page);
    const stop = page.locator(`${PANEL} [data-aihd-resolve="stop"]`);
    const canStop = (await stop.count()) > 0;
    if (canStop) await stop.first().click();
    await sleep(2000);
    const row = await latestStep(caseId);
    return record('negativeAbort', {
      caseId,
      canStop,
      commandsAdded: (await commandCount()) - before,
      session: row.session_status,
    });
  },

  // ── 実機の後に入れた修正の確認（ae9bcce の後の分） ──
  /** 結果の取り込み: Y の直後に画面を離れ、画面が無くてもサーバが結果を取り込むか。 */
  async recheckResultCapture() {
    const { page } = await openPersona('requesterA');
    const caseId = await newCase(page);
    assertPreapproved(await startSession(page));
    const row0 = await latestStep(caseId);
    if (row0?.skill_id !== 'spooler.status') throw new Error('事前承認の条件に合いません。');
    const home = page.url();
    await page.click(`${PANEL} [data-aihd-resolve="approve"][data-decision="Y"]`);
    await sleep(800);
    await page.goto('about:blank');
    let row;
    let command;
    const started = Date.now();
    while (Date.now() - started < 170_000) {
      row = await latestStep(caseId);
      if (row?.command_id) {
        [command] = await sql`SELECT status FROM device_commands WHERE id = ${row.command_id}`;
      }
      if (command?.status === 'done' && row.result_summary) break;
      await sleep(3000);
    }
    const seconds = Math.round((Date.now() - started) / 1000);
    await page.goto(home);
    return record('recheckResultCapture', {
      caseId,
      seconds,
      commandStatus: command?.status ?? null,
      stepStatus: row?.step_status ?? null,
      sessionStatus: row?.session_status ?? null,
      capturedWithoutPage: Boolean(command?.status === 'done' && row?.result_summary),
      resultSummary: JSON.stringify(row?.result_summary ?? null).slice(0, 300),
    });
  },
  /** 報告の分離: 結果の報告だけを失敗させ、実行を繰り返さず、エージェントが動き続けるか。 */
  async recheckReportSplit() {
    const { page } = await openPersona('requesterA');
    const caseId = await newCase(page);
    assertPreapproved(await startSession(page));
    const row0 = await latestStep(caseId);
    if (row0?.skill_id !== 'spooler.status') throw new Error('事前承認の条件に合いません。');
    const before = await commandCount();
    blockResult = true;
    resultBlocked = 0;
    await page.click(`${PANEL} [data-aihd-resolve="approve"][data-decision="Y"]`);
    const started = Date.now();
    while (Date.now() - started < 120_000 && resultBlocked === 0) await sleep(1000);
    const blocked = resultBlocked;
    blockResult = false;
    // 繰り返して実行されるなら、次の取得と報告がここで届く。
    await sleep(30_000);
    const row = await latestStep(caseId);
    const [command] = row?.command_id
      ? await sql`SELECT status FROM device_commands WHERE id = ${row.command_id}`
      : [null];
    const [seen] = await sql`
      SELECT max(last_used_at) AS last_seen FROM device_tokens WHERE device_id = ${deviceId}
    `;
    return record('recheckReportSplit', {
      caseId,
      blockedReports: blocked,
      reportsAfterUnblock: resultBlocked - blocked,
      commandsAdded: (await commandCount()) - before,
      commandStatus: command?.status ?? null,
      stepStatus: row?.step_status ?? null,
      lastSeenSecondsAgo: seen?.last_seen
        ? Math.round((Date.now() - new Date(seen.last_seen).getTime()) / 1000)
        : null,
      panel: (await panelText(page)).slice(0, 300),
    });
  },

  // ── 一本通し ──────────────────────────────────
  async consult() {
    const { page } = await openPersona('requesterA');
    STATE.mainCase = await newCase(page);
    results.ids.caseId = STATE.mainCase;
    await shot(page, '01-a-consult.png');
    return record('consult', {
      caseId: STATE.mainCase,
      connected: /読み取り診断を開始/.test(await page.innerText('#wzMsgs')),
    });
  },
  async propose() {
    const { page, log } = await openPersona('requesterA');
    const proposal = await startSession(page);
    const row = await latestStep(STATE.mainCase);
    results.ids.sessionId = row.session_id;
    results.ids.proposalStepId = row.step_id;
    await shot(page, '02-a-proposal.png');
    return record('propose', {
      skill: row.skill_id,
      commandsBeforeY: (
        await sql`SELECT count(*)::int AS n FROM device_commands WHERE session_id = ${row.session_id}`
      )[0].n,
      proposal,
      api: log.slice(-3),
    });
  },
  async approveY() {
    const { page } = await openPersona('requesterA');
    await page.click(`${PANEL} [data-aihd-resolve="approve"][data-decision="Y"]`);
    await page.waitForSelector(`${PANEL} [data-aihd-result-source]`, { timeout: 170_000 });
    const source = await page.getAttribute(
      `${PANEL} [data-aihd-result-source]`,
      'data-aihd-result-source',
    );
    const row = await latestStep(STATE.mainCase);
    results.ids.commandId = row.command_id;
    const [command] = await sql`
      SELECT status, skill_id FROM device_commands WHERE id = ${row.command_id}
    `;
    await shot(page, '03-a-result.png');
    const panel = await panelText(page);
    return record('result', {
      source,
      command,
      resultSummary: JSON.stringify(row.result_summary ?? null).slice(0, 300),
      sessionStatus: row.session_status,
      saysNotResolved: /まだ解決とは判定していません/.test(panel),
      closed: await page.evaluate(() => curCase().closed),
      panel,
    });
  },
  async handover() {
    const { page } = await openPersona('requesterA');
    await page.click(`${PANEL} [data-aihd-resolve="escalate"]`);
    await page.waitForSelector('[data-act="wConsent"]');
    const consent = await page.innerText('#wzPane');
    await shot(page, '04-a-consent.png');
    await page.click('[data-act="wConsent"]');
    await page.waitForFunction(() => S.tickets.length > 0 && curCase().step === 4);
    await page.waitForSelector('[data-ahd="share-ok"]', { timeout: 10_000 });
    await page.click('[data-ahd="share-ok"]');
    await sleep(2500);
    const [row] = await sql`
      SELECT id, status, snapshot FROM case_handovers WHERE case_id = ${STATE.mainCase}
    `;
    STATE.handoverId = row.id;
    results.ids.handoverId = row.id;
    const snapshot = JSON.stringify(row.snapshot);
    return record('handover', {
      handoverId: row.id,
      status: row.status,
      hasCommandId: snapshot.includes(results.ids.commandId),
      hasEndpointAgent: /端末エージェント（実端末）|endpoint_agent/.test(snapshot),
      hasMock: /模擬/.test(snapshot),
      consentMentionsResult: /実診断の結果/.test(consent),
    });
  },
  async staffRecord() {
    const { page } = await openPersona('staff');
    await selectStaffRole(page, 'staff', EMP.staff);
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => typeof S !== 'undefined');
    await sleep(1500);
    await page.waitForSelector(`[data-act="wClaimHandover"][data-id="${STATE.handoverId}"]`, {
      timeout: 15_000,
    });
    await shot(page, '05-staff-inbox.png');
    await page.click(`[data-act="wClaimHandover"][data-id="${STATE.handoverId}"]`);
    await sleep(2500);
    await selectStaffRole(page, 'staff', EMP.staff);
    await page.click('[data-act="wRail"][data-r="tools"]');
    await page.waitForSelector('[data-act="wTool"][data-v="h.queue"]');
    await page.click('[data-act="wTool"][data-v="h.queue"]');
    await sleep(600);
    await page.waitForSelector('#ahd-hw-launcher:not([hidden])');
    await page.click('#ahd-hw-launcher');
    const incId = await page.evaluate((id) => {
      const target = S.cases.find((c) => c.id === id);
      return target ? link(target).inc?.id : null;
    }, STATE.mainCase);
    await page.click(`[data-hw="select"][data-id="${incId}"]`);
    await page.waitForSelector('[data-hw="start"]', { timeout: 10_000 });
    const workspace = await page.innerText('#ahd-hw');
    await page.click('[data-hw="start"]');
    await page.waitForSelector('#hw-cause', { timeout: 10_000 });
    await page.fill('#hw-cause', CAUSE);
    await page.fill('#hw-steps', STEPS);
    await shot(page, '06-staff-record.png');
    await page.click('[data-hw="resolve"]');
    await page.waitForFunction(
      () => /下書き/.test(document.querySelector('#hdMain h1')?.textContent ?? ''),
      null,
      { timeout: 10_000 },
    );
    // 題名は原本の既定（件名 +「ときの対処」）から直す。利用者が探せる言葉にする。
    if ((await page.locator('#d_title').count()) > 0) {
      await page.fill('#d_title', TITLE);
      await page.locator('#d_title').dispatchEvent('change');
    }
    await shot(page, '07-staff-draft.png');
    await page.locator('#hdMain button', { hasText: '承認申請' }).click();
    await sleep(2000);
    const [row] = await sql`
      SELECT id, kb_no, status, version, title, symptom, cause, steps, keywords,
             source_handover_id, source_case_ref
      FROM knowledge WHERE client_ref IS NOT NULL ORDER BY created_at DESC LIMIT 1
    `;
    STATE.kbId = row.id;
    results.ids.kbId = row.id;
    results.ids.kbNo = row.kb_no;
    return record('staffRecord', {
      workspaceShowsResult: workspace.includes(results.ids.commandId),
      kb: row,
      sourceMatchesCase: row.source_case_ref === STATE.mainCase,
      sourceMatchesHandover: row.source_handover_id === STATE.handoverId,
    });
  },
  /** 本文を出すだけで承認しない。担当の番号選択の材料。 */
  async kbBody() {
    const [row] = await sql`
      SELECT kb_no, status, title, symptom, cause, steps FROM knowledge WHERE id = ${STATE.kbId}
    `;
    return row;
  },
  async approveKb() {
    const { page } = await openPersona('approver');
    await page.waitForSelector('#ahApproverEntry', { timeout: 15_000 });
    await page.click('#ahApproverEntry');
    const item = page.locator(`[data-pd-item="${STATE.kbId}"]`);
    await item.waitFor({ timeout: 15_000 });
    await shot(page, '08-approver-panel.png');
    const boxes = item.locator('input[type="checkbox"]');
    for (let index = 0; index < (await boxes.count()); index += 1) await boxes.nth(index).check();
    await item.locator('[data-ahd="pd-approve"]').click();
    await sleep(2500);
    await shot(page, '09-approver-done.png');
    const [row] = await sql`
      SELECT k.status, k.version, a.email AS approver, u.email AS author
      FROM knowledge k JOIN users u ON u.id = k.author_id LEFT JOIN users a ON a.id = k.approver_id
      WHERE k.id = ${STATE.kbId}
    `;
    const [review] = await sql`
      SELECT id, content_hash, reviewed_version, published_version, decision
      FROM knowledge_reviews WHERE knowledge_id = ${STATE.kbId}
      ORDER BY created_at DESC LIMIT 1
    `;
    results.ids.reviewId = review?.id;
    results.ids.contentHash = review?.content_hash;
    results.ids.publishedVersion = review?.published_version;
    const [handover] = await sql`SELECT status FROM case_handovers WHERE id = ${STATE.handoverId}`;
    return record('approveKb', {
      status: row.status,
      version: row.version,
      separateAccounts: row.approver !== row.author,
      review,
      handoverStatusAfterKb: handover.status,
    });
  },
  async completeHandover() {
    const { page } = await openPersona('approver');
    const button = page.locator(`[data-ahd="ho-approve"][data-id="${STATE.handoverId}"]`);
    await button.waitFor({ timeout: 15_000 });
    await button.click();
    await sleep(2500);
    const [row] = await sql`
      SELECT status, self_approved FROM case_handovers WHERE id = ${STATE.handoverId}
    `;
    await shot(page, '10-approver-handover-done.png');
    return record('completeHandover', row);
  },
  /** 別の相談者の次の相談。実 AI の回答をそのまま残す（評価は別に行う）。 */
  async nextConsult() {
    const { page, log } = await openPersona('requesterB');
    const caseId = await newCase(page, 'プリンターから紙が出ない', NEXT_CONSULT);
    await sleep(25_000);
    const chat = await page.innerText('#wzMsgs');
    await shot(page, '11-b-next.png');
    const answer = await page.evaluate(async (text) => {
      const response = await fetch('/api/ai/answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      return response.json();
    }, NEXT_CONSULT);
    results.ids.nextCaseId = caseId;
    return record('nextConsult', {
      caseId,
      kbNo: results.ids.kbNo,
      chat,
      chatMentionsKb: chat.includes(results.ids.kbNo),
      directAnswer: answer.answer,
      directSources: answer.sources,
      provider: answer.provider,
      api: log.slice(-8),
      note: 'chat は画面の操作。directAnswer は同じ文を /api/ai/answer へ直接送った結果で、画面の操作ではない',
    });
  },
  /** ID の突合。KB から元の案件、実行までたどる。 */
  async trace() {
    const [row] = await sql`
      SELECT k.kb_no, k.version, k.source_case_ref, k.source_handover_id,
             h.case_id AS handover_case, s.id AS session_id, st.id AS step_id, st.command_id,
             c.status AS command_status, r.content_hash, r.published_version
      FROM knowledge k
      JOIN case_handovers h ON h.id = k.source_handover_id
      JOIN resolution_sessions s ON s.case_id = h.case_id
      JOIN resolution_steps st ON st.session_id = s.id AND st.command_id IS NOT NULL
      JOIN device_commands c ON c.id = st.command_id
      LEFT JOIN knowledge_reviews r ON r.knowledge_id = k.id AND r.decision = 'approved'
      WHERE k.id = ${STATE.kbId}
      LIMIT 1
    `;
    return record('trace', {
      row,
      matchesRun:
        row?.command_id === results.ids.commandId &&
        row?.session_id === results.ids.sessionId &&
        row?.handover_case === results.ids.caseId,
    });
  },
};

await prepareDb();
for (const role of Object.keys(PORTS)) await startApi(role);
startDeviceProxy();
browser = await chromium.launch({ headless: true });

createServer(async (request, response) => {
  const url = new URL(request.url, 'http://x');
  const name = url.pathname.slice(1);
  try {
    const step = STEPS_API[name];
    const out = step ? await step(url) : { error: 'unknown' };
    response.end(JSON.stringify(out, null, 1));
  } catch (error) {
    response.statusCode = 500;
    response.end(JSON.stringify({ error: String(error?.message ?? error).slice(0, 400) }));
  }
}).listen(CONTROL, '127.0.0.1', () => console.log('ready'));

process.on('SIGTERM', async () => {
  for (const child of children) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // 既に終了している
    }
  }
  await browser.close();
  await sql.end();
  process.exit(0);
});
