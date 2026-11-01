#!/usr/bin/env node
/**
 * 相談者ウィザードの実診断経路（印刷の相談 + spooler.status）を専用 DB で実操作して記録する。
 *
 * 検証専用。本番・Preview・実端末には触れない。
 * - DB 名が `_e2e` で終わらなければ起動しない。NODE_ENV=production では起動しない。
 * - 認証は AUTH_MODE=local（DEV_AUTH_EMAIL）。Cloudflare Access の検証ではない。
 * - 名簿は同じ DB に作る合成の mirai_info.employee_directory（example.test のみ）。
 * - AI はローカルのスタブ（DEEPSEEK_BASE_URL）。外部への通信は遮断して記録する。
 * - 実行器は endpoint-command-agent.mjs --mock。結果は「模擬」で、実機受入に数えない。
 *
 * 使い方:
 *   FLOW_E2E_DB_URL=... PLAYWRIGHT_CORE_PATH=.../playwright-core FLOW_E2E_OUT=<dir> \
 *     node scripts/e2e/wizard-real-path.mjs before|after
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import postgres from 'postgres';

const phase = process.argv[2];
if (phase !== 'before' && phase !== 'after') {
  console.error('before または after を指定してください。');
  process.exit(2);
}
if (process.env.NODE_ENV === 'production') {
  console.error('NODE_ENV=production では実行しません。');
  process.exit(2);
}
const dbUrl = process.env.FLOW_E2E_DB_URL ?? '';
const dbName = (() => {
  try {
    return new URL(dbUrl).pathname.slice(1);
  } catch {
    return '';
  }
})();
if (!/_e2e$/.test(dbName)) {
  console.error('FLOW_E2E_DB_URL の DB 名は _e2e で終わる必要があります。');
  process.exit(2);
}

const root = path.resolve(import.meta.dirname, '..', '..');
const outDir = path.resolve(process.env.FLOW_E2E_OUT ?? path.join(root, '.e2e-out'));
mkdirSync(outDir, { recursive: true });
const tmp = mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'flow-e2e-'));

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE_PATH ?? 'playwright-core');

const PORTS = { requester: 18985, other: 18986, staff: 18987, noRoster: 18988, ai: 18989 };
const EMAIL = {
  requester: 'synth.requester@example.test',
  other: 'synth.other@example.test',
  staff: 'synth.staff@example.test',
  noRoster: 'synth.unlisted@example.test',
};
const PRINT_SUBJECT = '印刷ができません';
const PRINT_BODY = '印刷ボタンを押してもプリンターから紙が出ません';

const sql = postgres(dbUrl, { max: 2, onnotice: () => {} });
const checks = [];
const children = [];

function check(id, title, ok, note = '') {
  checks.push({ id, title, ok: Boolean(ok), note: String(note) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${title}${note ? ` (${note})` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(fn, label, timeoutMs = 30_000) {
  const startedAt = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - startedAt > timeoutMs) throw new Error(`timeout: ${label}`);
    await sleep(250);
  }
}

// ── 合成の名簿と DB ───────────────────────────────────────────────
function runScript(script, env) {
  const result = spawnSync('npx', ['tsx', script], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`${script} failed: ${result.stderr.slice(-400)}`);
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
  // 専用 DB の前回分を消す（DB 名は起動時に確認済み）。
  await sql`DELETE FROM device_commands`;
  await sql`DELETE FROM resolution_sessions`;
  await sql`DELETE FROM device_tokens`;
  await sql`DELETE FROM device_inventories`;
  await sql`DELETE FROM prototype_states`;
  await sql`DELETE FROM case_handovers`;
  await sql`CREATE SCHEMA IF NOT EXISTS mirai_info`;
  await sql`
    CREATE TABLE IF NOT EXISTS mirai_info.employee_directory (
      employee_no text PRIMARY KEY, name text NOT NULL, organization text, division text,
      section text, status text NOT NULL, email text, updated_at timestamptz DEFAULT now()
    )
  `;
  await sql`TRUNCATE mirai_info.employee_directory`;
  const rows = [
    ['MK9001', '合成 相談者', EMAIL.requester, '総務部'],
    ['MK9002', '合成 別人', EMAIL.other, '総務部'],
    ['MK9003', '合成 担当者', EMAIL.staff, 'DX推進部'],
  ];
  for (const [no, name, email, section] of rows) {
    await sql`
      INSERT INTO mirai_info.employee_directory
        (employee_no, name, organization, division, section, status, email)
      VALUES (${no}, ${name}, '合成組織', '管理本部', ${section}, '有効', ${email})
    `;
  }
}

// ── AI スタブ ─────────────────────────────────────────────────────
const aiCalls = [];
function startAiStub() {
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        body = {};
      }
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const system = String(messages[0]?.content ?? '');
      const user = String(messages.at(-1)?.content ?? '');
      let content;
      if (system.includes('承認済み Skill カタログ')) {
        let parsed = {};
        try {
          parsed = JSON.parse(user);
        } catch {
          parsed = {};
        }
        const executed = (parsed.executed ?? []).map((entry) => entry.skillId);
        aiCalls.push({
          kind: 'propose',
          executed,
          lastResultSummary: parsed.lastResultSummary ?? '',
        });
        content = executed.includes('spooler.status')
          ? JSON.stringify({ skillId: 'os.info', params: {}, rationale: 'スタブ: OS を確認する' })
          : JSON.stringify({
              skillId: 'spooler.status',
              params: {},
              rationale: 'スタブ: スプーラの状態を読み取る',
            });
      } else {
        aiCalls.push({ kind: 'answer', user: user.slice(0, 4000), system: system.slice(0, 8000) });
        content = 'スタブの回答です。';
      }
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  return new Promise((resolve) => {
    server.listen(PORTS.ai, '127.0.0.1', () => resolve(server));
  });
}

// ── API サーバ ────────────────────────────────────────────────────
async function startApi(role) {
  const port = PORTS[role];
  const log = openSync(path.join(tmp, `api-${role}.log`), 'a');
  const child = spawn('npx', ['tsx', 'apps/api/src/index.ts'], {
    cwd: root,
    detached: true,
    stdio: ['ignore', log, log],
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(port),
      HOST: '127.0.0.1',
      DATABASE_URL: dbUrl,
      MIRAI_INFO_DATABASE_URL: dbUrl,
      SESSION_SECRET: randomBytes(32).toString('hex'),
      AUTH_MODE: 'local',
      RESOLVE_REQUESTER_DIAGNOSIS_ENABLED: 'true',
      DEV_AUTH_EMAIL: EMAIL[role],
      DEEPSEEK_API_KEY: 'stub-not-a-real-key',
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${PORTS.ai}`,
      MAIL_TRANSPORT: 'disabled',
      LOG_LEVEL: 'warn',
    },
  });
  children.push(child);
  await waitUntil(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      const body = await response.json();
      return body.service === 'ai-helpdesk-api' && body.env === 'development';
    } catch {
      return false;
    }
  }, `health ${role}`);
  return `http://127.0.0.1:${port}`;
}

// ── 端末エージェント（--mock） ────────────────────────────────────
const agents = [];
async function issueToken(email, deviceId) {
  const token = randomBytes(32).toString('hex');
  const hash = createHash('sha256').update(token).digest('hex');
  await sql`
    INSERT INTO device_tokens (token_hash, user_email, label, device_id)
    VALUES (${hash}, ${email}, 'flow-e2e-mock', ${deviceId})
  `;
  return token;
}

function startAgent(base, token, deviceId, name = 'agent') {
  const config = path.join(tmp, `${name}.json`);
  writeFileSync(
    config,
    JSON.stringify({
      url: `${base}/api/device/agent`,
      deviceToken: token,
      browserDeviceId: deviceId,
      commandIntervalSeconds: 1,
    }),
    { mode: 0o600 },
  );
  const logPath = path.join(tmp, `${name}.log`);
  const log = openSync(logPath, 'a');
  const child = spawn(
    process.execPath,
    ['scripts/endpoint-command-agent.mjs', '--mock', '--config', config],
    { cwd: root, detached: true, stdio: ['ignore', log, log] },
  );
  const agent = { child, logPath };
  agents.push(agent);
  children.push(child);
  return agent;
}

function stopChild(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  try {
    // SIGSTOP 中のプロセスは SIGTERM を処理しないので、先に再開させる。
    process.kill(-child.pid, 'SIGCONT');
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    // すでに終了している。
  }
}

// ── ブラウザ ──────────────────────────────────────────────────────
async function openPage(browser, base, label) {
  const context = await browser.newContext({
    viewport: { width: 1360, height: 1000 },
    locale: 'ja-JP',
  });
  const page = await context.newPage();
  const log = [];
  const external = [];
  const pageErrors = [];
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1') return route.continue();
    external.push(url.host);
    return route.abort();
  });
  page.on('pageerror', (error) => pageErrors.push(String(error.message).slice(0, 200)));
  const resolveBodies = [];
  page.on('response', async (response) => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith('/api/')) return;
    log.push({
      label,
      at: Date.now(),
      method: response.request().method(),
      path: url.pathname,
      status: response.status(),
    });
    if (url.pathname.startsWith('/api/resolve/') && response.request().method() === 'POST') {
      const body = await response.json().catch(() => null);
      resolveBodies.push({ path: url.pathname, status: response.status(), body });
    }
  });
  await page.goto(`${base}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof S !== 'undefined' && Boolean(window.__AIHD_DEVICE_ID__));
  await sleep(1200);
  return { context, page, log, external, pageErrors, resolveBodies };
}

async function openPrintCase(page) {
  await page.evaluate(() => {
    ACT.wStart();
  });
  await page.waitForSelector('[data-act="wKind"][data-k="pc"]');
  await page.click('[data-act="wKind"][data-k="pc"]');
  await page.click('[data-act="wStep"][data-s="2"]');
  await page.waitForSelector('[data-w="subject"]');
  await page.fill('[data-w="subject"]', PRINT_SUBJECT);
  await page.fill('[data-w="body"]', PRINT_BODY);
  // PC 基本情報の事前取得（ブラウザ）が終わるまで少し待つ。
  await sleep(2500);
  await page.click('[data-act="wSend"]');
  await page.waitForSelector('#wzMsgs');
  await sleep(1800);
  return page.evaluate(() => curCase().id);
}

async function paneText(page) {
  return page.evaluate(() => document.querySelector('#wzPane')?.innerText ?? '');
}

async function chatText(page) {
  return page.evaluate(() => document.querySelector('#wzMsgs')?.innerText ?? '');
}

function summarizeLog(log, since = 0) {
  const counts = new Map();
  for (const entry of log) {
    if (entry.at < since) continue;
    const normalized = entry.path.replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
      ':id',
    );
    const key = `${entry.method} ${normalized} ${entry.status}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].map(([key, count]) => {
    const [method, apiPath, status] = key.split(' ');
    return { method, path: apiPath, status: Number(status), count };
  });
}

// ── before: 変更前の実測 ───────────────────────────────────────────
async function runBefore(browser, base) {
  const session = await openPage(browser, base, 'before');
  const { page } = session;
  const deviceId = await page.evaluate(() => window.__AIHD_DEVICE_ID__);
  const token = await issueToken(EMAIL.requester, deviceId);
  startAgent(base, token, deviceId);
  await sleep(2500);
  const since = Date.now();
  const caseId = await openPrintCase(page);
  await page.screenshot({ path: path.join(outDir, 'before-print-case.png'), fullPage: true });
  const hearing = await chatText(page);
  await page.evaluate(() => {
    const card = [...S.chats.at(0).messages].find((m) => m.kind === 'confirm');
    const chat = S.chats.find((c) => c.id === curCase().chatId);
    const pending = chat.messages.find((m) => m.kind === 'confirm' && m.state === 'pending');
    if (pending) ACT.cY({ mid: pending.id });
    return card?.id;
  });
  await sleep(3500);
  await page.screenshot({ path: path.join(outDir, 'before-after-confirm.png'), fullPage: true });
  const afterConfirm = await chatText(page);
  const commands =
    await sql`SELECT count(*)::int AS n FROM device_commands WHERE session_id IS NOT NULL`;
  const sessions =
    await sql`SELECT count(*)::int AS n FROM resolution_sessions WHERE case_id = ${caseId}`;
  const log = summarizeLog(session.log, since);
  writeFileSync(
    path.join(outDir, 'before.json'),
    `${JSON.stringify(
      {
        caseId,
        calledResolve: log.filter((entry) => entry.path.startsWith('/api/resolve')),
        calledAi: log.filter((entry) => entry.path.startsWith('/api/ai')),
        sessions: sessions[0].n,
        commands: commands[0].n,
        demoShown: /デモ/.test(afterConfirm),
        hearing: hearing.slice(0, 600),
        afterConfirm: afterConfirm.slice(0, 1200),
        apiLog: log,
        external: session.external,
        pageErrors: session.pageErrors,
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    `before: case=${caseId} resolveCalls=${log.filter((e) => e.path.startsWith('/api/resolve')).length} sessions=${sessions[0].n} commands=${commands[0].n} demo=${/デモ/.test(afterConfirm)}`,
  );
}

// ── after: 変更後の実測 ───────────────────────────────────────────
const panel = '#aihdResolvePanel';

async function browserFetch(page, url, body) {
  return page.evaluate(
    async ([target, payload]) => {
      const response = await fetch(target, {
        method: payload === null ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload === null ? undefined : JSON.stringify(payload),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    },
    [url, body],
  );
}

/** ブラウザと同じ計算で承認ハッシュを求める（値は記録しない）。 */
async function hashOf(page, payload) {
  return page.evaluate(async (target) => {
    const stable = (value) => {
      if (value === null || typeof value !== 'object') return JSON.stringify(value);
      if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
      return `{${Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
        .join(',')}}`;
    };
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stable(target)));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }, payload);
}

const commandsOf = (sessionId) =>
  sql`SELECT id, status, step_id, skill_id FROM device_commands WHERE session_id = ${sessionId} ORDER BY created_at`;

async function main(browser, base, otherBase, staffBase, noRosterBase) {
  const report = { checks, apiLog: {}, ids: [], notes: [] };

  // ── A. 接続あり（--mock）: 相談 → 本人 Y → 結果 → 次の提案 → 引継ぎ ─────────
  const A = await openPage(browser, base, 'A');
  const deviceId = await A.page.evaluate(() => window.__AIHD_DEVICE_ID__);
  const token = await issueToken(EMAIL.requester, deviceId);
  const agent = startAgent(base, token, deviceId);
  await waitUntil(async () => {
    const status = await browserFetch(
      A.page,
      `/api/resolve/device-status?deviceId=${deviceId}`,
      null,
    );
    return status.body?.agentConnected === true;
  }, 'agent connected');

  const persona = await A.page.evaluate(() => ({
    roster: Boolean(typeof SELF_EMP_NO === 'undefined' ? null : SELF_EMP_NO),
    user: S.ui.user,
    device: USERS[S.ui.user]?.device,
    name: USERS[S.ui.user]?.name,
  }));
  check(
    'A0',
    '合成名簿の利用者として動く（デモ人物 u1 に切り替わらない）',
    persona.user !== 'u1',
    persona.name,
  );

  const since = Date.now();
  const caseId = await openPrintCase(A.page);
  await A.page.waitForSelector(`${panel} [data-aihd-resolve="start"]`, { timeout: 15_000 });
  await A.page.screenshot({ path: path.join(outDir, 'after-1-guide.png'), fullPage: true });
  const guideText = await chatText(A.page);
  const kinds = await A.page.evaluate(() =>
    S.chats.find((c) => c.id === curCase().chatId).messages.map((m) => m.kind),
  );
  check(
    'A1',
    '接続あり: デモ診断・デモ確認カードを出さない',
    !kinds.includes('diag') && !kinds.includes('confirm'),
    kinds.join(','),
  );
  const paneA = await paneText(A.page);
  check(
    'A2',
    '接続あり: STEP 3 の本文にデモデータの記述が無い',
    !/デモ/.test(paneA),
    paneA.slice(0, 80),
  );
  check('A3', '接続あり: 解決ループへ誘導する', /読み取り診断/.test(guideText));
  const beforeStart =
    await sql`SELECT count(*)::int AS n FROM resolution_sessions WHERE case_id = ${caseId}`;
  check('A4', '押すまでセッションを作らない', beforeStart[0].n === 0);

  await A.page.click(`${panel} [data-aihd-resolve="start"]`);
  await A.page.waitForSelector(`${panel} [data-aihd-resolve="approve"][data-decision="Y"]`);
  const proposalText = await A.page.innerText(panel);
  check(
    'A5',
    '提案は spooler.status の読み取りのみ',
    /印刷スプーラの状態を確認する/.test(proposalText) && /読み取りのみ/.test(proposalText),
  );
  const [session] =
    await sql`SELECT id, status FROM resolution_sessions WHERE case_id = ${caseId} AND user_email = ${EMAIL.requester}`;
  check('A6', 'Y の前は端末コマンドが 0 件', (await commandsOf(session.id)).length === 0);
  await A.page.screenshot({ path: path.join(outDir, 'after-2-proposal.png'), fullPage: true });

  await A.page.click(`${panel} [data-aihd-resolve="approve"][data-decision="Y"]`);
  await A.page.waitForSelector(`${panel} [data-aihd-result-source]`, { timeout: 30_000 });
  const resultText = await A.page.innerText(panel);
  await A.page.screenshot({ path: path.join(outDir, 'after-3-result-mock.png'), fullPage: true });
  const source = await A.page.getAttribute(
    `${panel} [data-aihd-result-source]`,
    'data-aihd-result-source',
  );
  check('A7', '--mock の結果は模擬と表示する', source === 'mock' && /模擬/.test(resultText));
  check(
    'A8',
    '--mock の結果に「端末エージェント（実端末）」と出さない',
    !/端末エージェント（実端末）/.test(resultText) &&
      !/端末エージェント（実端末）/.test(await chatText(A.page)),
  );
  check('A9', '読取成功で解決と断定しない', /まだ解決とは判定していません/.test(resultText));
  const [afterRead] = await sql`SELECT status FROM resolution_sessions WHERE id = ${session.id}`;
  const closed = await A.page.evaluate(() => curCase().closed);
  check(
    'A10',
    '読取成功だけで解決済みにしない',
    afterRead.status === 'waiting_continue' && !closed,
    `${afterRead.status}/${closed}`,
  );
  const [step1] =
    await sql`SELECT id, status, command_id, result_summary, result_ai FROM resolution_steps WHERE session_id = ${session.id} AND seq = 1`;
  check(
    'A11',
    'DB の結果に出所 mock を保存する',
    step1.result_summary.executionSource === 'mock' && step1.result_ai.executionSource === 'mock',
  );
  check('A12', '結果の形の機械検証が通る', step1.result_summary.resultShapeOk === true);

  // 再読み込みしても同じセッションの結果へ戻り、二重に開始しない。
  await A.page.reload({ waitUntil: 'load' });
  await A.page.waitForFunction(
    () => typeof S !== 'undefined' && Boolean(window.__AIHD_DEVICE_ID__),
  );
  await A.page.waitForSelector(`${panel} [data-aihd-result-source]`, { timeout: 15_000 });
  const reloadedSessions = await sql`
    SELECT count(*)::int AS n FROM resolution_sessions
    WHERE case_id = ${caseId} AND user_email = ${EMAIL.requester}
  `;
  check('A12b', '再読み込みで結果へ戻り、セッションを増やさない', reloadedSessions[0].n === 1);
  await A.page.click(`${panel} [data-aihd-resolve="continue"][data-decision="Y"]`);
  await A.page.waitForFunction(
    (selector) =>
      /OS/.test(document.querySelector(selector)?.innerText ?? '') &&
      document.querySelector(`${selector} [data-aihd-resolve="approve"]`),
    panel,
  );
  check(
    'A13',
    '次の提案は自動実行しない（コマンドは 1 件のまま）',
    (await commandsOf(session.id)).length === 1,
  );
  const proposeCalls = aiCalls.filter((call) => call.kind === 'propose');
  check(
    'A14',
    '次提案の AI 入力に結果の出所が入る',
    /"executionSource":"mock"/.test(proposeCalls.at(-1)?.lastResultSummary ?? ''),
  );
  await A.page.click(`${panel} [data-aihd-resolve="approve"][data-decision="Y"]`);
  await A.page.waitForFunction(
    (selector) =>
      document.querySelector(`${selector} [data-aihd-result-source]`) &&
      /os|OS/.test(document.querySelector(selector).innerText),
    panel,
  );
  await waitUntil(
    async () => (await commandsOf(session.id)).every((row) => row.status === 'done'),
    'commands done',
  );
  const commands = await commandsOf(session.id);
  check(
    'A15',
    '2 回目は別の承認で別のコマンドになる',
    commands.length === 2 && commands[0].id !== commands[1].id,
  );
  const approvals =
    await sql`SELECT count(DISTINCT approval_hash)::int AS n FROM resolution_steps WHERE session_id = ${session.id} AND approval_hash IS NOT NULL`;
  check('A16', '承認ハッシュはステップごとに異なる', approvals[0].n === 2);

  await A.page.click(`${panel} [data-aihd-resolve="escalate"]`);
  await A.page.waitForSelector('[data-act="wConsent"]');
  const consentPane = await A.page.innerText('#wzPane');
  await A.page.screenshot({
    path: path.join(outDir, 'after-4-handover-consent.png'),
    fullPage: true,
  });
  check('A17', '担当者へ進むと STEP 4 の同意画面になる', /担当者へ引き継ぎます/.test(consentPane));
  check(
    'A18',
    '同意画面に実診断の結果を選択肢として出す',
    /実診断の結果/.test(consentPane) && /模擬/.test(consentPane),
  );
  check('A19', '同意画面にデモ端末を出さない', !/MRK-/.test(consentPane));
  await A.page.click('[data-act="wConsent"]');
  await A.page.waitForFunction(() => S.tickets.length > 0 && curCase().step === 4);
  await sleep(800);
  const handed = await A.page.evaluate(() => {
    const c = curCase();
    const L = link(c);
    return {
      shared: L.tkt.shared,
      memo: L.inc?.handover ?? '',
      coworkShared: L.inc?.coworkShared ?? null,
    };
  });
  const handedText = JSON.stringify(handed);
  check(
    'A20',
    '引継ぎに実診断の結果が出所付きで入る',
    /模擬/.test(JSON.stringify(handed.shared['実診断の結果'] ?? '')),
  );
  check(
    'A21',
    '引継ぎにデモ値が入らない',
    !/デモデータ|MRK-|山田|見積書_第3版/.test(handedText) && !('AIの診断結果' in handed.shared),
  );
  check(
    'A22',
    '引継ぎの結果に実行 ID が入る',
    JSON.stringify(handed.shared['実診断の結果']).includes(commands[0].id),
  );
  await A.page.screenshot({ path: path.join(outDir, 'after-5-handover-done.png'), fullPage: true });

  // 担当者の AI 文脈（/api/ai/answer-case）。
  await A.page.click('[data-ahd="share-ok"]');
  await waitUntil(
    () => A.log.some((e) => e.path === '/api/case-handovers' && e.method === 'POST'),
    'share',
  );
  const shareEntry = A.log.find((e) => e.path === '/api/case-handovers' && e.method === 'POST');
  check('A26', '画面の宛先選択から案件を共有できる', shareEntry.status === 200, shareEntry.status);
  const staff = await openPage(browser, staffBase, 'staff');
  const aiBefore = aiCalls.length;
  const asked = await browserFetch(staff.page, '/api/ai/answer-case', {
    caseId,
    text: 'この案件の状況は？',
  });
  check('A27', '担当者の AI 追加質問が動く', asked.status === 200, asked.status);
  const staffPrompt = JSON.stringify(aiCalls.slice(aiBefore));
  check('A28', '担当者の AI 文脈に結果が出所付きで入る', /模擬/.test(staffPrompt));
  check('A29', '担当者の AI 文脈にデモ値が入らない', !/デモデータ|MRK-/.test(staffPrompt));

  // 突合表（UI / API / DB / エージェント）。
  const uiResults = await A.page.evaluate(() =>
    S.chats
      .find((c) => c.id === curCase().chatId)
      .messages.filter((m) => m.resolveResult)
      .map((m) => m.resolveResult),
  );
  const agentLog = readFileSync(agent.logPath, 'utf8');
  const steps = await sql`
    SELECT st.id, st.seq, st.skill_id, st.status, st.command_id, s.case_id, s.id AS session_id,
           s.device_id, dc.status AS command_status, dc.device_id AS command_device,
           dc.result->>'executionSource' AS source
    FROM resolution_steps st
    JOIN resolution_sessions s ON s.id = st.session_id
    LEFT JOIN device_commands dc ON dc.id = st.command_id
    WHERE s.id = ${session.id} ORDER BY st.seq
  `;
  for (const row of steps) {
    const ui = uiResults.find((item) => item.stepId === row.id);
    const api = A.resolveBodies.find(
      (item) => item.body?.step?.id === row.id && item.body?.command?.id,
    );
    report.ids.push({
      caseId: row.case_id,
      sessionId: row.session_id,
      stepId: row.id,
      commandId: row.command_id,
      skillId: row.skill_id,
      deviceId: row.device_id,
      source: row.source,
      ui: Boolean(
        ui &&
          ui.caseId === row.case_id &&
          ui.commandId === row.command_id &&
          ui.sessionId === row.session_id,
      ),
      api: Boolean(
        api && api.body.command.id === row.command_id && api.body.session.caseId === row.case_id,
      ),
      db: row.command_status === 'done' && row.command_device === row.device_id,
      agent: agentLog.includes(row.command_id) && agentLog.includes('(mock)'),
    });
  }
  check(
    'A30',
    'UI / API / DB / エージェントの ID が一致する',
    report.ids.length === 2 && report.ids.every((r) => r.ui && r.api && r.db && r.agent),
  );
  report.apiLog.A = summarizeLog(A.log, since);
  report.apiLog.staff = summarizeLog(staff.log);
  check(
    'A31',
    '相談から解決ループの API が呼ばれる',
    report.apiLog.A.some((e) => e.path === '/api/resolve/sessions' && e.status === 200),
  );
  check(
    'A32',
    '外部への通信が無い',
    A.external.length === 0 && staff.external.length === 0,
    [...A.external, ...staff.external].join(','),
  );
  check(
    'A33',
    'ページエラーが無い',
    A.pageErrors.length === 0 && staff.pageErrors.length === 0,
    [...A.pageErrors, ...staff.pageErrors].join(' / '),
  );

  // ── A2. 本人の「解決した」: 確認の後だけ解決にする。報告書へ出所付きで渡す ───
  const caseA2 = await openPrintCase(A.page);
  await A.page.waitForSelector(`${panel} [data-aihd-resolve="start"]`);
  await A.page.click(`${panel} [data-aihd-resolve="start"]`);
  await A.page.waitForSelector(`${panel} [data-aihd-resolve="approve"][data-decision="Y"]`);
  await A.page.click(`${panel} [data-aihd-resolve="approve"][data-decision="Y"]`);
  await A.page.waitForSelector(`${panel} [data-aihd-result-source]`, { timeout: 30_000 });
  const [a2Session] = await sql`
    SELECT id, status FROM resolution_sessions
    WHERE case_id = ${caseA2} AND user_email = ${EMAIL.requester}
  `;
  check(
    'A40',
    '本人の確認前は解決にならない',
    a2Session.status === 'waiting_continue' && !(await A.page.evaluate(() => curCase().closed)),
  );
  await A.page.click(`${panel} [data-aihd-resolve="resolve"]`);
  await A.page.waitForFunction(() => curCase().step === 7);
  const [a2After] = await sql`SELECT status FROM resolution_sessions WHERE id = ${a2Session.id}`;
  check(
    'A41',
    '本人の「解決した」で session=resolved・案件=完了',
    a2After.status === 'resolved' && (await A.page.evaluate(() => curCase().closed)) === 'ai',
  );
  const a2Payload = await A.page.evaluate(() => {
    const c = curCase();
    return window.__AIHD_ASSIST_BRIDGE__.reportPayload(c, link(c));
  });
  check(
    'A23',
    '報告書の診断欄に出所付きで入る',
    (a2Payload.ai?.diagnoses ?? []).some((d) => /模擬/.test(d.title)),
  );
  check(
    'A24',
    '報告書にデモ端末・デモ診断が入らない',
    !(a2Payload.ai?.diagnoses ?? []).some((d) => /デモ/.test(d.title)) &&
      !/MRK-/.test(JSON.stringify(a2Payload)),
  );
  const reportResponse = await browserFetch(A.page, '/api/reports/final', { report: a2Payload });
  check(
    'A25',
    '報告書 API が受理する',
    reportResponse.status === 200 || reportResponse.status === 201,
    `${reportResponse.status} ${JSON.stringify(reportResponse.body?.error ?? '').slice(0, 200)}`,
  );
  const reportUrl = reportResponse.body?.report?.files?.html?.url;
  const reportHtml = reportUrl
    ? await A.page.evaluate((url) => fetch(url).then((r) => r.text()), reportUrl)
    : '';
  writeFileSync(path.join(outDir, 'after-report-sample.html'), reportHtml);
  check(
    'A42',
    '報告書の本文に模擬の表示があり実端末と書かない',
    /模擬/.test(reportHtml) && !/端末エージェント（実端末）/.test(reportHtml),
  );
  check('A43', '報告書の本文にデモ端末が無い', !/MRK-|【デモデータ】/.test(reportHtml));
  report.apiLog.A2 = summarizeLog(A.log, since).filter((e) => e.path.startsWith('/api/reports'));

  // ── B. 未接続: 実結果に見せず、担当者へ引き継げると明示する ──────────────
  const B = await openPage(browser, otherBase, 'B');
  const sinceB = Date.now();
  const caseB = await openPrintCase(B.page);
  await sleep(1500);
  const textB = await chatText(B.page);
  const kindsB = await B.page.evaluate(() =>
    S.chats.find((c) => c.id === curCase().chatId).messages.map((m) => m.kind),
  );
  await B.page.screenshot({ path: path.join(outDir, 'after-6-no-agent.png'), fullPage: true });
  const paneB = await paneText(B.page);
  check(
    'B6',
    '未接続: STEP 3 の本文にデモデータの記述が無い',
    !/デモ/.test(paneB),
    paneB.slice(0, 80),
  );
  check(
    'B1',
    '未接続: 文言を明示する',
    textB.includes('端末エージェントが未接続のため実診断はできません。担当者へ引き継げます。'),
  );
  check(
    'B2',
    '未接続: デモの診断を出さない',
    !kindsB.includes('diag') && !kindsB.includes('confirm') && !/デモ/.test(textB),
    kindsB.join(','),
  );
  check(
    'B3',
    '未接続: 開始ボタンを出さない',
    (await B.page.locator(`${panel} [data-aihd-resolve="start"]`).count()) === 0,
  );
  check(
    'B4',
    '未接続: セッションを作らない',
    (
      await sql`SELECT count(*)::int AS n FROM resolution_sessions WHERE case_id = ${caseB} AND user_email = ${EMAIL.other}`
    )[0].n === 0,
  );
  await B.page.click(`${panel} [data-aihd-resolve="handover"]`);
  await B.page.waitForSelector('[data-act="wConsent"]');
  const consentB = await B.page.innerText('#wzPane');
  await B.page.click('[data-act="wConsent"]');
  await B.page.waitForFunction(() => S.tickets.length > 0);
  await sleep(600);
  const handedB = await B.page.evaluate(() => {
    const L = link(curCase());
    return { shared: L.tkt.shared, memo: L.inc?.handover ?? '' };
  });
  check(
    'B5',
    '未接続: 引継ぎにデモ値も実診断も入らない',
    !/デモデータ|MRK-|実診断/.test(`${consentB}${JSON.stringify(handedB)}`),
  );
  report.apiLog.B = summarizeLog(B.log, sinceB);

  // ── C. 名簿に無い利用者（デモ人物へ固定される経路） ──────────────────────
  const C = await openPage(browser, noRosterBase, 'C');
  const caseC = await openPrintCase(C.page);
  await sleep(1500);
  const textC = await chatText(C.page);
  check(
    'C1',
    '名簿外: 実診断できないと明示し、デモ人物の診断を出さない',
    /未接続/.test(textC) && !/山田|MRK-|見積書_第3版/.test(textC),
    caseC,
  );
  await C.context.close();

  // ── D. 拒否の確認（レート制限を空けてから） ──────────────────────────────
  await sleep(61_000);
  const startSession = async () => {
    const response = await browserFetch(A.page, '/api/resolve/sessions', { caseId, deviceId });
    if (response.status !== 200) throw new Error(`session ${response.status}`);
    return response.body;
  };

  const d1 = await startSession();
  const hashD1 = await hashOf(A.page, d1.step.approvalChallenge.payload);
  const foreign = await browserFetch(B.page, `/api/resolve/steps/${d1.step.id}/approve`, {
    decision: 'Y',
    approvalHash: hashD1,
  });
  check('D1', '本人以外の Y は 404', foreign.status === 404, foreign.status);
  const staffY = await browserFetch(staff.page, `/api/resolve/steps/${d1.step.id}/approve`, {
    decision: 'Y',
    approvalHash: hashD1,
  });
  check('D2', '担当者の Y も 404', staffY.status === 404, staffY.status);
  const staleHash = await browserFetch(A.page, `/api/resolve/steps/${d1.step.id}/approve`, {
    decision: 'Y',
    approvalHash: 'f'.repeat(64),
  });
  check(
    'D3',
    '違うハッシュは 400 APPROVAL_MISMATCH',
    staleHash.status === 400 && staleHash.body?.error?.code === 'APPROVAL_MISMATCH',
    staleHash.status,
  );
  const noHash = await browserFetch(A.page, `/api/resolve/steps/${d1.step.id}/approve`, {
    decision: 'Y',
  });
  check('D4', 'ハッシュなしの Y は 400', noHash.status === 400, noHash.status);
  check('D5', '拒否の間はコマンド 0 件', (await commandsOf(d1.session.id)).length === 0);

  // 同時の二重 Y。
  const raced = await A.page.evaluate(
    async ([stepId, approvalHash]) => {
      const call = () =>
        fetch(`/api/resolve/steps/${stepId}/approve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision: 'Y', approvalHash }),
        }).then((response) => response.status);
      return Promise.all([call(), call()]);
    },
    [d1.step.id, hashD1],
  );
  check(
    'D6',
    '同時の二重 Y は 1 回だけ通る',
    raced.sort().join(',') === '200,409',
    raced.join(','),
  );
  check('D7', '二重 Y でもコマンドは 1 件', (await commandsOf(d1.session.id)).length === 1);
  await waitUntil(async () => (await commandsOf(d1.session.id))[0].status === 'done', 'd1 done');
  await browserFetch(A.page, `/api/resolve/steps/${d1.step.id}`, null);
  const continued = await browserFetch(A.page, `/api/resolve/steps/${d1.step.id}/continue`, {
    decision: 'Y',
  });
  const oldHashOnNext = await browserFetch(
    A.page,
    `/api/resolve/steps/${continued.body.step.id}/approve`,
    { decision: 'Y', approvalHash: hashD1 },
  );
  check(
    'D8',
    '前のステップのハッシュは次のステップに使えない',
    oldHashOnNext.status === 400,
    oldHashOnNext.status,
  );
  check('D9', '次のステップはコマンドを作らない', (await commandsOf(d1.session.id)).length === 1);

  // N（画面）
  await A.page.reload({ waitUntil: 'load' });
  await A.page.waitForFunction(
    () => typeof S !== 'undefined' && Boolean(window.__AIHD_DEVICE_ID__),
  );
  await sleep(1200);
  await A.page.evaluate((id) => {
    S.ui.case = id;
    S.ui.screen = 'wizard';
    curCase().closed = null;
    uxRender();
  }, caseId);
  const d2 = await startSession();
  const hashD2 = await hashOf(A.page, d2.step.approvalChallenge.payload);
  const declined = await browserFetch(A.page, `/api/resolve/steps/${d2.step.id}/approve`, {
    decision: 'N',
  });
  const [d2Session] = await sql`SELECT status FROM resolution_sessions WHERE id = ${d2.session.id}`;
  check(
    'D10',
    'N で停止しコマンドを作らない',
    declined.status === 200 &&
      d2Session.status === 'stopped' &&
      (await commandsOf(d2.session.id)).length === 0,
  );
  const afterN = await browserFetch(A.page, `/api/resolve/steps/${d2.step.id}/approve`, {
    decision: 'Y',
    approvalHash: hashD2,
  });
  check('D11', 'N の後の Y は 409', afterN.status === 409, afterN.status);

  // 取消の後の Y。
  const d3 = await startSession();
  const hashD3 = await hashOf(A.page, d3.step.approvalChallenge.payload);
  await browserFetch(A.page, `/api/resolve/sessions/${d3.session.id}/stop`, {});
  const afterStop = await browserFetch(A.page, `/api/resolve/steps/${d3.step.id}/approve`, {
    decision: 'Y',
    approvalHash: hashD3,
  });
  check(
    'D12',
    '取消の後の Y は 409 でコマンドなし',
    afterStop.status === 409 && (await commandsOf(d3.session.id)).length === 0,
    afterStop.status,
  );

  // 期限切れ。
  const d4 = await startSession();
  const hashD4 = await hashOf(A.page, d4.step.approvalChallenge.payload);
  await sql`UPDATE resolution_steps SET approval_expires_at = now() - interval '1 minute' WHERE id = ${d4.step.id}`;
  const expired = await browserFetch(A.page, `/api/resolve/steps/${d4.step.id}/approve`, {
    decision: 'Y',
    approvalHash: hashD4,
  });
  check(
    'D13',
    '期限切れの Y は 409 APPROVAL_EXPIRED でコマンドなし',
    expired.status === 409 &&
      expired.body?.error?.code === 'APPROVAL_EXPIRED' &&
      (await commandsOf(d4.session.id)).length === 0,
    expired.status,
  );

  // エージェントを止めて Y → 取消 → 再開しても実行しない。承認のレート制限（10/分）を空ける。
  await sleep(61_000);
  process.kill(-agent.child.pid, 'SIGSTOP');
  const d5 = await startSession();
  const hashD5 = await hashOf(A.page, d5.step.approvalChallenge.payload);
  const queued = await browserFetch(A.page, `/api/resolve/steps/${d5.step.id}/approve`, {
    decision: 'Y',
    approvalHash: hashD5,
  });
  await browserFetch(A.page, `/api/resolve/sessions/${d5.session.id}/stop`, {});
  process.kill(-agent.child.pid, 'SIGCONT');
  await sleep(4000);
  const [d5Command] = await commandsOf(d5.session.id);
  check(
    'D14',
    'Y の後の取消で未取得のコマンドは実行しない',
    queued.status === 200 &&
      d5Command.status === 'expired' &&
      !readFileSync(agent.logPath, 'utf8').includes(d5Command.id),
    d5Command.status,
  );

  // 取消の後に届いた結果（配信済み）。
  const d6 = await startSession();
  const hashD6 = await hashOf(A.page, d6.step.approvalChallenge.payload);
  process.kill(-agent.child.pid, 'SIGSTOP');
  const d6Approved = await browserFetch(A.page, `/api/resolve/steps/${d6.step.id}/approve`, {
    decision: 'Y',
    approvalHash: hashD6,
  });
  const delivered = await fetch(`${base}/api/device/command`, {
    headers: { 'x-device-token': token, 'x-device-id': deviceId },
  });
  const deliveredCommand = (await delivered.json()).command;
  await browserFetch(A.page, `/api/resolve/sessions/${d6.session.id}/stop`, {});
  const late = await fetch(`${base}/api/device/command/${deliveredCommand.id}/result`, {
    method: 'POST',
    headers: {
      'x-device-token': token,
      'x-device-id': deviceId,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ok: true,
      result: {
        executionSource: 'endpoint_agent',
        normalized: { status: 'Running' },
        stdoutSummary: '',
      },
    }),
  });
  await browserFetch(A.page, `/api/resolve/steps/${d6.step.id}`, null);
  const [d6Session] = await sql`SELECT status FROM resolution_sessions WHERE id = ${d6.session.id}`;
  const [d6Step] =
    await sql`SELECT status, result_summary FROM resolution_steps WHERE id = ${d6.step.id}`;
  check(
    'D15',
    '取消の後に届いた結果で状態を進めない',
    d6Approved.status === 200 &&
      d6Session.status === 'stopped' &&
      d6Step.status === 'cancelled' &&
      d6Step.result_summary === null,
    `${late.status}/${d6Step.status}`,
  );
  process.kill(-agent.child.pid, 'SIGCONT');

  // ── E. 本番モード: 模擬の結果を入れない（専用 DB に対して NODE_ENV=production で起動） ──
  const prod = await startProductionApi();
  if (prod) {
    const prodDevice = 'WEB-FLOWE2E0';
    const prodToken = await issueToken(EMAIL.other, prodDevice);
    const [skill] =
      await sql`SELECT id, version, content_hash FROM skills WHERE id = 'spooler.status'`;
    const [queuedCommand] = await sql`
      INSERT INTO device_commands (user_email, device_id, op_id, params, skill_id, skill_version, skill_content_hash)
      VALUES (${EMAIL.other}, ${prodDevice}, ${skill.id}, '{}'::jsonb, ${skill.id}, ${skill.version}, ${skill.content_hash})
      RETURNING id
    `;
    const prodAgent = startAgent(prod, prodToken, prodDevice, 'agent-prod');
    await waitUntil(
      async () =>
        (await sql`SELECT status FROM device_commands WHERE id = ${queuedCommand.id}`)[0].status !==
          'queued' && /failed|poll error/.test(readFileSync(prodAgent.logPath, 'utf8')),
      'prod agent reported',
      20_000,
    );
    stopChild(prodAgent.child);
    const [row] =
      await sql`SELECT status, result, error FROM device_commands WHERE id = ${queuedCommand.id}`;
    check(
      'E1',
      '本番モード: --mock エージェントの結果を保存しない',
      row.status === 'failed' && row.result === null,
      row.status,
    );
    // 同じことを HTTP の応答でも確かめる。
    const [second] = await sql`
      INSERT INTO device_commands (user_email, device_id, op_id, params, skill_id, skill_version, skill_content_hash)
      VALUES (${EMAIL.other}, ${prodDevice}, ${skill.id}, '{}'::jsonb, ${skill.id}, ${skill.version}, ${skill.content_hash})
      RETURNING id
    `;
    const prodHeaders = {
      'x-device-token': prodToken,
      'x-device-id': prodDevice,
      'Content-Type': 'application/json',
    };
    await fetch(`${prod}/api/device/command`, { headers: prodHeaders });
    const rejected = await fetch(`${prod}/api/device/command/${second.id}/result`, {
      method: 'POST',
      headers: prodHeaders,
      body: JSON.stringify({
        ok: true,
        result: { executionSource: 'mock', normalized: { status: 'Running' } },
      }),
    });
    const rejectedBody = await rejected.json().catch(() => null);
    const [secondRow] =
      await sql`SELECT status, result FROM device_commands WHERE id = ${second.id}`;
    check(
      'E2',
      '本番モード: 模擬の結果は 403 MOCK_RESULT_FORBIDDEN',
      rejected.status === 403 &&
        rejectedBody?.error?.code === 'MOCK_RESULT_FORBIDDEN' &&
        secondRow.status === 'failed' &&
        secondRow.result === null,
      `${rejected.status}/${secondRow.status}`,
    );
    const [third] = await sql`
      INSERT INTO device_commands (user_email, device_id, op_id, params, skill_id, skill_version, skill_content_hash)
      VALUES (${EMAIL.other}, ${prodDevice}, ${skill.id}, '{}'::jsonb, ${skill.id}, ${skill.version}, ${skill.content_hash})
      RETURNING id
    `;
    await fetch(`${prod}/api/device/command`, { headers: prodHeaders });
    const unknownResult = await fetch(`${prod}/api/device/command/${third.id}/result`, {
      method: 'POST',
      headers: prodHeaders,
      body: JSON.stringify({ ok: true, result: { normalized: { status: 'Running' } } }),
    });
    const unknownBody = await unknownResult.json().catch(() => null);
    check(
      'E3',
      '本番モード: 申告の無い結果は 403 UNVERIFIED_RESULT_SOURCE',
      unknownResult.status === 403 && unknownBody?.error?.code === 'UNVERIFIED_RESULT_SOURCE',
      unknownResult.status,
    );
  } else {
    report.notes.push('本番モードの起動に失敗したため E1 は未確認（統合テストのみ）。');
  }

  writeFileSync(path.join(outDir, 'after.json'), `${JSON.stringify(report, null, 2)}\n`);
  await A.context.close();
  await B.context.close();
  await staff.context.close();
}

async function startProductionApi() {
  const allowlist = path.join(tmp, 'allow.txt');
  writeFileSync(allowlist, 'synth.requester@example.test\n');
  const port = 18984;
  const log = openSync(path.join(tmp, 'api-prod.log'), 'a');
  const child = spawn('npx', ['tsx', 'apps/api/src/index.ts'], {
    cwd: root,
    detached: true,
    stdio: ['ignore', log, log],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      HOST: '127.0.0.1',
      DATABASE_URL: dbUrl,
      MIRAI_INFO_DATABASE_URL: dbUrl,
      SESSION_SECRET: randomBytes(32).toString('hex'),
      AUTH_MODE: 'cloudflare-access',
      ACCESS_ALLOWLIST_FILE: allowlist,
      LOG_LEVEL: 'warn',
    },
  });
  children.push(child);
  try {
    await waitUntil(
      async () => {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/api/health`);
          const body = await response.json();
          return body.service === 'ai-helpdesk-api' && body.env === 'production';
        } catch {
          return false;
        }
      },
      'health prod',
      20_000,
    );
    return `http://127.0.0.1:${port}`;
  } catch {
    return null;
  }
}

// ── main ──────────────────────────────────────────────────────────
let exitCode = 0;
let aiServer;
let browser;
try {
  await prepareDb();
  aiServer = await startAiStub();
  const base = await startApi('requester');
  browser = await chromium.launch({ headless: true });
  if (phase === 'before') {
    await runBefore(browser, base);
  } else {
    const [otherBase, staffBase, noRosterBase] = await Promise.all([
      startApi('other'),
      startApi('staff'),
      startApi('noRoster'),
    ]);
    await main(browser, base, otherBase, staffBase, noRosterBase);
    if (checks.some((item) => !item.ok)) exitCode = 1;
  }
} catch (error) {
  exitCode = 1;
  console.error(String(error?.stack ?? error).slice(0, 2000));
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const child of children) stopChild(child);
  if (aiServer) aiServer.close();
  await sql.end({ timeout: 5 }).catch(() => {});
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(exitCode);
