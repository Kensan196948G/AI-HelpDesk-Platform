#!/usr/bin/env node
/**
 * README のデータの流れを 1 シナリオで通しに実操作して記録する（#125 + #126 の統合の検証）。
 *
 * 相談者 A: 印刷の相談 → 本人 Y → 実行（--mock）→ 結果（解決と判定しない）→ 引継ぎ
 * 担当者: 引き受け → 対応 → 解決記録 → KB 下書き → 承認申請
 * 別人の承認者: サーバ下書きを承認
 * 別の相談者 B: 次の相談 → AI 入力に承認済み KB が [KB番号 v版] で入る
 *
 * 検証専用。本番・Preview・実端末・RSP・Mesh には触れない。
 * - DB 名が `_e2e` で終わらなければ起動しない。NODE_ENV=production では起動しない。
 * - 認証は AUTH_MODE=local（DEV_AUTH_EMAIL）。Cloudflare Access の検証ではない。
 * - 名簿は同じ DB に作る合成の mirai_info.employee_directory（example.test のみ）。
 * - AI は全経路スタブ。実行器は endpoint-command-agent.mjs --mock。どちらも実受入に数えない。
 * - DATAFLOW_REAL_AI_CONF を指定したときだけ、最後に AI 入力の部分を最大 2 回まで実 AI へ送る。
 *   DEEPSEEK_* の行だけを読み、値を表示しない。合成の相談文と合成の KB だけを送る。
 *
 * 使い方:
 *   FLOW_E2E_DB_URL=... PLAYWRIGHT_CORE_PATH=.../playwright-core FLOW_E2E_OUT=<dir> \
 *     node scripts/e2e/dataflow-integration.mjs
 *
 * DATAFLOW_REAL_AI_CONF=<api.conf> を付けた回は、最後に AI 入力の部分を最大 2 回まで実 AI へ送る。
 * 中継は端末情報を検出すると転送しない（既定の共有のまま流し、KB に端末情報が入らないことも確かめる）。
 * DATAFLOW_NARROW_SHARE=1 は、引継ぎで「端末」「PC 基本情報」「実診断の結果」を画面で外す回。
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import postgres from 'postgres';

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
const tmp = mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'dataflow-e2e-'));
const skipReject =
  process.env.DATAFLOW_SKIP_REJECT === '1' || Boolean(process.env.DATAFLOW_REAL_AI_CONF);
const narrowShare = process.env.DATAFLOW_NARROW_SHARE === '1';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE_PATH ?? 'playwright-core');

const PORTS = {
  requesterA: 19401,
  requesterB: 19402,
  staff: 19403,
  approver: 19404,
  outsideApprover: 19405,
  requesterC: 19406,
  ai: 19407,
  aiProxy: 19408,
};
const EMAIL = {
  requesterA: 'synth.requester-a@example.test',
  requesterB: 'synth.requester-b@example.test',
  staff: 'synth.staff@example.test',
  approver: 'synth.approver@example.test',
  outsideApprover: 'synth.outside-approver@example.test',
  requesterC: 'synth.requester-c@example.test',
};
const EMP = {
  requesterA: 'MK9101',
  requesterB: 'MK9102',
  staff: 'MK9103',
  approver: 'MK9104',
  outsideApprover: 'MK9105',
  requesterC: 'MK9106',
};
const PRINT_SUBJECT = '印刷ができません';
const PRINT_BODY = '印刷ボタンを押してもプリンターから紙が出ません';
const CAUSE = '印刷スプーラの待機ジョブが滞留していた（検証用の記録）';
const STEPS = 'スプーラの状態を読み取って確認する\n待機ジョブの有無を担当者が確認する';
// 原本の印刷ルール（detectIntent の print）に当たらない相談。H.kb → /api/ai/answer へ進む。
const FREE_SUBJECT = 'スプーラの不調';
const FREE_BODY = 'スプーラが止まっているようで書類が出てきません';
// 実 AI の確認に使う、この流れの KB（待機ジョブの滞留）に該当する相談文。合成。
const REAL_AI_CONSULTS = [
  [
    '待機ジョブの滞留',
    'スプーラの待機ジョブが滞留して書類が出てきません。どう確認すればよいですか',
  ],
  [
    '待機ジョブの確認',
    'スプーラの待機ジョブが滞留していると言われました。状態の確認方法を教えてください',
  ],
];
const INJECT_MARKER = 'ZX9注入マーカー';
const SELF_MARKER = 'ZX9自己承認マーカー';
// デモ値（固定データの診断・端末）。引継ぎ、報告、AI 文脈、KB へ流れてはいけない。
const DEMO =
  /MRK-|見積書_第3版|【デモデータ】|デモ端末|山田 太郎|PCエージェント オンライン|サーバ側の実行前検証/;

const sql = postgres(dbUrl, { max: 2, onnotice: () => {} });
const checks = [];
const children = [];
const report = {
  scope:
    '検証用。認証は AUTH_MODE=local、名簿は合成、実行器は --mock。Cloudflare Access・実端末・RSP・Mesh は使っていない。',
  run: process.env.DATAFLOW_REAL_AI_CONF
    ? 'real-ai（スタブ + /api/ai/answer のみ実 AI、最大 2 回）'
    : 'stub（AI は全経路スタブ）',
  share: narrowShare ? '端末・PC 基本情報・実診断の結果を外す' : '既定',
  checks,
  apiLog: {},
  ids: {},
  aiInputs: {},
  findings: [],
  realAi: null,
};

function check(id, title, ok, note = '') {
  checks.push({ id, title, ok: Boolean(ok), note: String(note).slice(0, 300) });
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${id} ${title}${note ? ` (${String(note).slice(0, 200)})` : ''}`,
  );
}

function finding(id, text) {
  report.findings.push({ id, text });
  console.log(`NOTE ${id} ${text}`);
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
  await sql`DELETE FROM final_reports`;
  await sql`DELETE FROM knowledge WHERE client_ref IS NOT NULL`;
  await sql`CREATE SCHEMA IF NOT EXISTS mirai_info`;
  await sql`
    CREATE TABLE IF NOT EXISTS mirai_info.employee_directory (
      employee_no text PRIMARY KEY, name text NOT NULL, organization text, division text,
      section text, status text NOT NULL, email text, updated_at timestamptz DEFAULT now()
    )
  `;
  await sql`TRUNCATE mirai_info.employee_directory`;
  const rows = [
    [EMP.requesterA, '合成 相談者A', EMAIL.requesterA, '総務部'],
    [EMP.requesterB, '合成 相談者B', EMAIL.requesterB, '総務部'],
    [EMP.staff, '合成 担当者', EMAIL.staff, 'DX推進部'],
    [EMP.approver, '合成 承認者', EMAIL.approver, 'DX推進部'],
    [EMP.outsideApprover, '合成 部外承認者', EMAIL.outsideApprover, '技術部'],
    [EMP.requesterC, '合成 相談者C', EMAIL.requesterC, '総務部'],
  ];
  for (const [no, name, email, section] of rows) {
    await sql`
      INSERT INTO mirai_info.employee_directory
        (employee_no, name, organization, division, section, status, email)
      VALUES (${no}, ${name}, '合成組織', '管理本部', ${section}, '有効', ${email})
    `;
  }
  // 承認権限は user_roles が正本。担当者には与えない。
  for (const [email, name] of [
    [EMAIL.approver, '合成 承認者'],
    [EMAIL.outsideApprover, '合成 部外承認者'],
  ]) {
    const [user] = await sql`
      INSERT INTO users (email, name, role, password_hash)
      VALUES (${email}, ${name}, 'approver', 'access-only$no-login')
      ON CONFLICT (lower(email)) DO UPDATE SET role = 'approver', updated_at = now()
      RETURNING id
    `;
    await sql`
      INSERT INTO user_roles (user_id, role) VALUES (${user.id}, 'approver')
      ON CONFLICT DO NOTHING
    `;
  }
}

// ── AI スタブ ─────────────────────────────────────────────────────
const aiCalls = [];
// スタブの提案が usedKnowledge を返すか（AI が使ったときだけ「使った」と出ることを確かめる）。
let stubUsesKnowledge = false;
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
          user,
        });
        const usedKnowledge =
          stubUsesKnowledge && Array.isArray(parsed.knowledgeRefs)
            ? parsed.knowledgeRefs.map((ref) => ref.kbNo)
            : undefined;
        content = executed.includes('spooler.status')
          ? JSON.stringify({
              skillId: 'os.info',
              params: {},
              rationale: 'スタブ: OS を確認する',
              usedKnowledge,
            })
          : JSON.stringify({
              skillId: 'spooler.status',
              params: {},
              rationale: 'スタブ: スプーラの状態を読み取る',
              usedKnowledge,
            });
      } else {
        aiCalls.push({ kind: 'answer', user, system });
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
async function startApi(role, overrides = {}) {
  const port = PORTS[role];
  const log = openSync(path.join(tmp, `api-${role}.log`), 'a');
  // tsx の CLI は IPC のパイプを PID 名で作り、並行起動で衝突することがあるので --import で読む。
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/api/src/index.ts'], {
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
      DEV_AUTH_EMAIL: EMAIL[role],
      DEEPSEEK_API_KEY: 'stub-not-a-real-key',
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${PORTS.ai}`,
      MAIL_TRANSPORT: 'disabled',
      LOG_LEVEL: 'warn',
      ...overrides,
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
async function issueToken(email, deviceId) {
  const token = randomBytes(32).toString('hex');
  const hash = createHash('sha256').update(token).digest('hex');
  await sql`
    INSERT INTO device_tokens (token_hash, user_email, label, device_id)
    VALUES (${hash}, ${email}, 'dataflow-e2e-mock', ${deviceId})
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
  children.push(child);
  return { child, logPath };
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
async function openPage(browser, base, label, options = {}) {
  const context = await browser.newContext({
    viewport: { width: 1360, height: 1000 },
    locale: 'ja-JP',
  });
  const page = await context.newPage();
  const log = [];
  const external = [];
  const pageErrors = [];
  const resolveBodies = [];
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== '127.0.0.1') {
      external.push(url.host);
      return route.abort();
    }
    // 実 AI の確認では端末情報を外へ出さないよう、保存そのものを止める。
    if (options.blockDevice && /^\/api\/device\//.test(url.pathname)) return route.abort();
    return route.continue();
  });
  page.on('pageerror', (error) => pageErrors.push(String(error.message).slice(0, 200)));
  page.on('response', async (response) => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith('/api/')) return;
    const method = response.request().method();
    log.push({ label, at: Date.now(), method, path: url.pathname, status: response.status() });
    if (url.pathname.startsWith('/api/resolve/') && method === 'POST') {
      const body = await response.json().catch(() => null);
      resolveBodies.push({ path: url.pathname, status: response.status(), body });
    }
  });
  await page.goto(`${base}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof S !== 'undefined' && Boolean(window.__AIHD_DEVICE_ID__));
  await sleep(1200);
  return { context, page, log, external, pageErrors, resolveBodies };
}

async function waitAfterReload(page) {
  await page.waitForFunction(() => typeof S !== 'undefined' && Boolean(window.__AIHD_DEVICE_ID__));
  await sleep(1500);
}

async function openCase(page, subject, body) {
  await page.evaluate(() => {
    ACT.wStart();
  });
  await page.waitForSelector('[data-act="wKind"][data-k="pc"]');
  await page.click('[data-act="wKind"][data-k="pc"]');
  await page.click('[data-act="wStep"][data-s="2"]');
  await page.waitForSelector('[data-w="subject"]');
  await page.fill('[data-w="subject"]', subject);
  await page.fill('[data-w="body"]', body);
  // PC 基本情報の事前取得（ブラウザ）が終わるまで少し待つ。
  await sleep(2500);
  await page.click('[data-act="wSend"]');
  await page.waitForSelector('#wzMsgs');
  await sleep(1800);
  return page.evaluate(() => curCase().id);
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

/** 「操作する人」のプルダウンから役割を選ぶ（担当者・承認者の画面へ入る正規の操作）。 */
async function selectRole(page, role, employeeNo) {
  const value = `emp:${role}:${employeeNo}`;
  await waitUntil(
    () =>
      page.evaluate(
        (target) =>
          [...(document.querySelector('#uxWho')?.options ?? [])].some((o) => o.value === target),
        value,
      ),
    `persona option ${value}`,
    15_000,
  );
  await page.selectOption('#uxWho', value);
  await sleep(600);
}

async function openTool(page, view) {
  await page.click('[data-act="wRail"][data-r="tools"]');
  await page.waitForSelector(`[data-act="wTool"][data-v="${view}"]`);
  await page.click(`[data-act="wTool"][data-v="${view}"]`);
  await sleep(500);
}

// ── 通しのシナリオ ─────────────────────────────────────────────────
async function main(browser) {
  const baseA = await startApi('requesterA');
  const baseB = await startApi('requesterB');
  const baseStaff = await startApi('staff');
  const baseApprover = await startApi('approver');
  const baseOutside = await startApi('outsideApprover');

  // ── 1. 相談者 A: 印刷の相談 → 本人 Y → 結果 ──────────────────────
  const A = await openPage(browser, baseA, 'A');
  const deviceId = await A.page.evaluate(() => window.__AIHD_DEVICE_ID__);
  const token = await issueToken(EMAIL.requesterA, deviceId);
  const agent = startAgent(baseA, token, deviceId);
  await waitUntil(async () => {
    const status = await browserFetch(
      A.page,
      `/api/resolve/device-status?deviceId=${deviceId}`,
      null,
    );
    return status.body?.agentConnected === true;
  }, 'agent connected');

  const persona = await A.page.evaluate(() => ({ user: S.ui.user, name: USERS[S.ui.user]?.name }));
  check('A0', '相談者 A は合成名簿の本人として動く', persona.name === '合成 相談者A', persona.name);

  const panel = '#aihdResolvePanel';
  const aiBeforeA = aiCalls.length;
  const sinceA = Date.now();
  const caseId = await openCase(A.page, PRINT_SUBJECT, PRINT_BODY);
  await A.page.waitForSelector(`${panel} [data-aihd-resolve="start"]`, { timeout: 15_000 });
  await A.page.screenshot({ path: path.join(outDir, '1-a-guide.png'), fullPage: true });
  report.apiLog.A_consult = summarizeLog(A.log, sinceA);
  check(
    'A1',
    '印刷の相談は /api/ai/answer を呼ばない（固定ルールでも AI でもなく解決ループへ）',
    !report.apiLog.A_consult.some((e) => e.path === '/api/ai/answer') &&
      aiCalls.length === aiBeforeA,
    report.apiLog.A_consult.map((e) => `${e.method} ${e.path} ${e.status}`).join(' / '),
  );
  const kinds = await A.page.evaluate(() =>
    S.chats.find((c) => c.id === curCase().chatId).messages.map((m) => m.kind),
  );
  check(
    'A2',
    'デモの診断・確認カードを出さない',
    !kinds.includes('diag') && !kinds.includes('confirm'),
    kinds.join(','),
  );
  const noSession =
    await sql`SELECT count(*)::int AS n FROM resolution_sessions WHERE case_id = ${caseId}`;
  check('A3', '押すまでセッションを作らない', noSession[0].n === 0);

  await A.page.click(`${panel} [data-aihd-resolve="start"]`);
  await A.page.waitForSelector(`${panel} [data-aihd-resolve="approve"][data-decision="Y"]`);
  const [session] =
    await sql`SELECT id, status, device_id FROM resolution_sessions WHERE case_id = ${caseId} AND user_email = ${EMAIL.requesterA}`;
  check('A4', 'Y の前は端末コマンドが 0 件', (await commandsOf(session.id)).length === 0);
  await A.page.screenshot({ path: path.join(outDir, '2-a-proposal.png'), fullPage: true });

  await A.page.click(`${panel} [data-aihd-resolve="approve"][data-decision="Y"]`);
  await A.page.waitForSelector(`${panel} [data-aihd-result-source]`, { timeout: 30_000 });
  const resultText = await A.page.innerText(panel);
  await A.page.screenshot({ path: path.join(outDir, '3-a-result-mock.png'), fullPage: true });
  const source = await A.page.getAttribute(
    `${panel} [data-aihd-result-source]`,
    'data-aihd-result-source',
  );
  check(
    'A5',
    '--mock の結果は模擬と表示する',
    source === 'mock' && /模擬/.test(resultText),
    source,
  );
  check('A6', '読取成功で解決と断定しない', /まだ解決とは判定していません/.test(resultText));
  const [afterRead] = await sql`SELECT status FROM resolution_sessions WHERE id = ${session.id}`;
  const closed = await A.page.evaluate(() => curCase().closed);
  check(
    'A7',
    '読取成功だけで解決済みにならない（DB・画面）',
    afterRead.status === 'waiting_continue' && !closed,
    `${afterRead.status}/${closed}`,
  );
  const [stepRow] = await sql`
    SELECT st.id, st.status, st.command_id, st.result_summary, st.result_ai, st.skill_id
    FROM resolution_steps st WHERE st.session_id = ${session.id} AND st.seq = 1
  `;
  check(
    'A8',
    'DB の結果に出所 mock を保存する',
    stepRow.result_summary?.executionSource === 'mock' &&
      stepRow.result_ai?.executionSource === 'mock',
  );
  check(
    'A9',
    '実行は spooler.status のみ',
    stepRow.skill_id === 'spooler.status',
    stepRow.skill_id,
  );

  // ── 2. A: 引継ぎ ─────────────────────────────────────────────────
  const sinceHandover = Date.now();
  await A.page.click(`${panel} [data-aihd-resolve="escalate"]`);
  await A.page.waitForSelector('[data-act="wConsent"]');
  const consentPane = await A.page.innerText('#wzPane');
  await A.page.screenshot({ path: path.join(outDir, '4-a-consent.png'), fullPage: true });
  check(
    'H1',
    '同意画面に結果を出所付きで出す',
    /実診断の結果/.test(consentPane) && /模擬/.test(consentPane),
  );
  check('H2', '同意画面にデモ値を出さない', !DEMO.test(consentPane));
  if (narrowShare) {
    // 画面のチェックボックスで「端末」「PC 基本情報」「実診断の結果」を外す。
    for (const key of ['device', 'pc', 'realDiag']) {
      const box = A.page.locator(`[data-w="share"][data-k="${key}"]`);
      if ((await box.count()) > 0 && (await box.first().isChecked())) await box.first().uncheck();
      await sleep(300);
    }
  }
  await A.page.click('[data-act="wConsent"]');
  await A.page.waitForFunction(() => S.tickets.length > 0 && curCase().step === 4);
  await A.page.waitForSelector('[data-ahd="share-ok"]', { timeout: 10_000 });
  await A.page.click('[data-ahd="share-ok"]');
  await waitUntil(
    () => A.log.some((e) => e.path === '/api/case-handovers' && e.method === 'POST'),
    'share',
  );
  await sleep(800);
  const shareEntry = A.log.find((e) => e.path === '/api/case-handovers' && e.method === 'POST');
  check('H3', '宛先の選択から案件を共有できる', shareEntry.status === 200, shareEntry.status);
  report.apiLog.A_handover = summarizeLog(A.log, sinceHandover);
  const [handover] = await sql`
    SELECT id, status, snapshot, owner_email FROM case_handovers WHERE case_id = ${caseId}
  `;
  const snapshotText = JSON.stringify(handover.snapshot);
  if (narrowShare) {
    const shared = JSON.stringify(handover.snapshot.ticket?.shared ?? {});
    const body = String(handover.snapshot.inc?.body ?? '');
    const webId = `WEB-${deviceId.slice(0, 8).toUpperCase()}`;
    check(
      'H7',
      '外した項目は引継ぎ本文へ渡らない（端末・PC 基本情報・実行 ID）',
      !`${shared}${body}`.includes(webId) &&
        !/PC基本情報|取得日時/.test(`${shared}${body}`) &&
        !`${shared}${body}`.includes(stepRow.command_id),
      body.slice(0, 120),
    );
  } else {
    check(
      'H4',
      '引継ぎの DB スナップショットに実行 ID が入る',
      snapshotText.includes(stepRow.command_id),
    );
    check('H5', '引継ぎの DB スナップショットに「模擬」が入る', /模擬/.test(snapshotText));
  }
  const demoInSnapshot = snapshotText.match(DEMO)?.[0] ?? '';
  check('H6', '引継ぎの DB スナップショットにデモ値が無い', !demoInSnapshot, demoInSnapshot);
  await A.page.screenshot({ path: path.join(outDir, '5-a-handed-over.png'), fullPage: true });

  // ── 3. 担当者: 引き受け → 対応 → KB 下書き → 申請 ─────────────────
  const staff = await openPage(browser, baseStaff, 'staff');
  await selectRole(staff.page, 'staff', EMP.staff);
  await staff.page.reload({ waitUntil: 'load' });
  await waitAfterReload(staff.page);
  await staff.page.waitForSelector('[data-act="wClaimHandover"]', { timeout: 15_000 });
  await staff.page.screenshot({ path: path.join(outDir, '6-staff-inbox.png'), fullPage: true });
  await staff.page.click(`[data-act="wClaimHandover"][data-id="${handover.id}"]`);
  await waitUntil(
    async () =>
      (await sql`SELECT status FROM case_handovers WHERE id = ${handover.id}`)[0].status ===
      'claimed',
    'claimed',
  );
  await sleep(1200);
  await waitAfterReload(staff.page);
  check('S1', '担当者が受信箱から引き受ける（画面）', true);

  // 担当者の AI 追加質問（画面）。AI 文脈に結果が出所付きで入り、デモ値は入らない。
  await selectRole(staff.page, 'staff', EMP.staff);
  await openTool(staff.page, 'h.queue');
  await staff.page.waitForSelector('#ahd-hw-launcher:not([hidden])');
  await staff.page.click('#ahd-hw-launcher');
  const ticketId = await staff.page.evaluate((id) => {
    const target = S.cases.find((c) => c.id === id);
    return target ? link(target).tkt?.id : null;
  }, caseId);
  check('S2', '担当者の状態に案件が入る', Boolean(ticketId), ticketId);
  const hwCards = await staff.page
    .locator('[data-hw="select"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-id')));
  const incId = await staff.page.evaluate((id) => {
    const target = S.cases.find((c) => c.id === id);
    return target ? link(target).inc?.id : null;
  }, caseId);
  const hdTicket = hwCards.find((id) => id === incId) ?? incId;
  await staff.page.click(`[data-hw="select"][data-id="${hdTicket}"]`);
  await staff.page.waitForSelector('[data-hw="start"]', { timeout: 10_000 });
  await staff.page.screenshot({ path: path.join(outDir, '7-staff-workspace.png'), fullPage: true });
  const workspaceText = await staff.page.innerText('#ahd-hw');
  const demoInWorkspace = workspaceText.match(DEMO)?.[0] ?? '';
  check('S5', '担当者の画面にデモ値が無い', !demoInWorkspace, demoInWorkspace);
  // 担当者の既定値は原本のデモ担当者名になっている。本人を選び直す（画面の選択肢で）。
  const assignee = await staff.page.evaluate(() => {
    const select = document.querySelector('#hw-assignee');
    return {
      selected: select?.value ?? '',
      options: [...(select?.options ?? [])].map((option) => option.value),
    };
  });
  report.ids.workspaceAssigneeDefault = assignee.selected;
  check(
    'S7',
    '担当者欄の既定値がログイン本人である（デモの担当者名でない）',
    assignee.selected === '合成 担当者',
    assignee.selected,
  );
  check(
    'S8',
    '担当者欄で本人を選べる',
    assignee.options.includes('合成 担当者'),
    assignee.options.length,
  );
  if (assignee.options.includes('合成 担当者')) {
    await staff.page.selectOption('#hw-assignee', '合成 担当者');
  }
  await staff.page.click('[data-hw="start"]');
  await staff.page.waitForSelector('#hw-cause', { timeout: 10_000 });

  const aiBeforeStaff = aiCalls.length;
  const askBox = staff.page.locator('section.hw-ai textarea');
  if ((await askBox.count()) > 0) {
    await askBox.first().fill('この案件の状況は？');
    await staff.page.click('[data-hw="ai"]');
    await waitUntil(() => aiCalls.length > aiBeforeStaff, 'staff ai', 15_000);
    await sleep(600);
  }
  const staffPrompt = aiCalls
    .slice(aiBeforeStaff)
    .map((call) => call.user)
    .join('\n');
  if (narrowShare) {
    check(
      'S6',
      '外した実診断の結果は担当者の AI 文脈に入らない',
      !staffPrompt.includes('status=Running'),
    );
  } else {
    check('S3', '担当者の AI 文脈に結果が出所付きで入る（画面から）', /模擬/.test(staffPrompt));
  }
  const demoInStaff = staffPrompt.match(DEMO)?.[0] ?? '';
  check('S4', '担当者の AI 文脈にデモ値が無い', !demoInStaff, demoInStaff);
  report.aiInputs.staff = {
    api: staff.log.some((e) => e.path === '/api/ai/answer-case') ? '/api/ai/answer-case' : 'なし',
    containsMock: /模擬/.test(staffPrompt),
    containsCommandId: staffPrompt.includes(stepRow.command_id),
  };

  await staff.page.fill('#hw-cause', CAUSE);
  await staff.page.fill('#hw-steps', STEPS);
  await staff.page.click('[data-hw="resolve"]');
  await staff.page.waitForFunction(
    () => /下書き/.test(document.querySelector('#hdMain h1')?.textContent ?? ''),
    null,
    { timeout: 10_000 },
  );
  await staff.page.screenshot({ path: path.join(outDir, '8-staff-draft.png'), fullPage: true });
  // 下書きを画面で確認する導線で、何が入るかを記録する。
  const draftView = await staff.page.evaluate(() => ({
    title: document.querySelector('#d_title')?.value ?? null,
    symptom: document.querySelector('#d_sym')?.value ?? null,
    cause: document.querySelector('#d_cause')?.value ?? null,
    steps: document.querySelector('#d_steps')?.value ?? null,
  }));
  report.ids.draftView = draftView;
  const webIdA = `WEB-${deviceId.slice(0, 8).toUpperCase()}`;
  check(
    'K18',
    '下書きの画面に A の端末 ID と PC 基本情報が入らない',
    draftView.symptom !== null &&
      !draftView.symptom.includes(webIdA) &&
      !/PC基本情報|取得日時/.test(draftView.symptom),
    String(draftView.symptom).slice(0, 120),
  );
  await staff.page.locator('#hdMain button', { hasText: '承認申請' }).click();
  await sleep(1500);
  const [draftRow] = await waitUntil(async () => {
    const rows = await sql`
      SELECT k.*, u.email AS author_email FROM knowledge k JOIN users u ON u.id = k.author_id
      WHERE k.client_ref IS NOT NULL ORDER BY k.created_at DESC LIMIT 1
    `;
    return rows.length ? rows : null;
  }, 'knowledge row');
  check(
    'K1',
    '申請で DB に pending の行ができる（作成者=担当者）',
    draftRow.status === 'pending' && draftRow.author_email === EMAIL.staff,
    `${draftRow.status}/${draftRow.kb_no}`,
  );
  const kbText = [draftRow.title, draftRow.symptom, draftRow.cause, draftRow.steps].join('\n');
  const demoInKb = kbText.match(DEMO)?.[0] ?? '';
  check('K2', 'KB 下書きにデモ値が無い', !demoInKb, demoInKb);
  check('K3', 'KB 下書きに担当者の入力が入る', kbText.includes('待機ジョブ'));
  const [statusAfterResolve] =
    await sql`SELECT status FROM case_handovers WHERE id = ${handover.id}`;
  report.ids.handoverStatusAfterStaffResolve = statusAfterResolve.status;

  // ── 4. 承認前: B の相談に KB が入らない ──────────────────────────
  const B = await openPage(browser, baseB, 'B');
  const aiBeforeB0 = aiCalls.length;
  const sinceB0 = Date.now();
  await openCase(B.page, FREE_SUBJECT, FREE_BODY);
  await waitUntil(() => aiCalls.length > aiBeforeB0, 'B pre answer');
  report.apiLog.B_preApproval = summarizeLog(B.log, sinceB0);
  const preInput = aiCalls
    .slice(aiBeforeB0)
    .map((c) => c.user)
    .join('\n');
  check(
    'K4',
    '承認前は pending の KB が AI 入力に入らない',
    !preInput.includes(draftRow.kb_no),
    draftRow.kb_no,
  );

  // 権限のない者の承認は通らない。
  const approvePayload = (row) => ({
    clientRef: row.client_ref,
    status: 'approved',
    title: row.title,
    symptom: row.symptom,
    cause: row.cause,
    steps: row.steps,
    keywords: [],
    checklist: { reproducible: true, noSecrets: true, noBlame: true, scopeClear: true },
    comment: '',
  });
  const byRequester = await browserFetch(
    B.page,
    '/api/knowledge/ui-sync',
    approvePayload(draftRow),
  );
  check('K5', '相談者の承認は 403', byRequester.status === 403, byRequester.status);
  const byAuthor = await browserFetch(
    staff.page,
    '/api/knowledge/ui-sync',
    approvePayload(draftRow),
  );
  check('K6', '担当者（approver なし）の承認は 403', byAuthor.status === 403, byAuthor.status);

  // 部外の承認者: 権限は API にあるが、画面の役割に承認者が出ない（docs/61 §7）。
  const outside = await openPage(browser, baseOutside, 'outside');
  const outsideOptions = await outside.page.evaluate(() =>
    [...(document.querySelector('#uxWho')?.options ?? [])].map((o) => o.value),
  );
  const outsideCanSelect = outsideOptions.includes(`emp:approver:${EMP.outsideApprover}`);
  check(
    'U1',
    'DX 推進部以外の承認者は原本の役割の選択には出ない（docs/61 §7。入口は U2 の承認者パネル）',
    !outsideCanSelect,
  );
  // 所属外の承認者も、画面の操作で承認の一覧へ届く（docs/14 §2-17）。
  await outside.page.waitForSelector('#ahApproverEntry', { timeout: 15_000 });
  await outside.page.click('#ahApproverEntry');
  await outside.page.waitForSelector('#ahApproverKnowledge', { timeout: 15_000 });
  const outsidePanel = await outside.page.locator('#ahApproverPanel').innerText();
  check(
    'U2',
    '所属外の承認者が画面のボタンで承認者のパネルを開ける（完了承認と公開承認が別の見出し）',
    outsidePanel.includes('① 引継ぎの完了承認') && outsidePanel.includes('② ナレッジの公開承認'),
  );
  await outside.page.screenshot({ path: path.join(outDir, '5a-outside-approver-panel.png'), fullPage: true });
  report.apiLog.outside_all = summarizeLog(outside.log);
  await outside.context.close();

  // ── 5. 別人の承認者: サーバ下書きを画面で承認 ─────────────────────
  const approver = await openPage(browser, baseApprover, 'approver');
  await selectRole(approver.page, 'approver', EMP.approver);
  await openTool(approver.page, 'h.approve');
  await approver.page.waitForSelector(`[data-pd-item="${draftRow.id}"]`, { timeout: 15_000 });
  await approver.page.screenshot({
    path: path.join(outDir, '9-approver-pending.png'),
    fullPage: true,
  });
  const pendingItem = approver.page.locator(`[data-pd-item="${draftRow.id}"]`);
  const pendingText = await pendingItem.innerText();
  check(
    'K19',
    '承認者の画面に症状・原因・手順が出る（確認しないまま承認させない）',
    pendingText.includes('待機ジョブ') && pendingText.includes(PRINT_SUBJECT),
    pendingText.slice(0, 120),
  );
  const boxes = pendingItem.locator('input[type="checkbox"]');
  for (let index = 0; index < (await boxes.count()); index += 1) await boxes.nth(index).check();
  await pendingItem.locator('[data-ahd="pd-approve"]').click();
  const [approvedRow] = await waitUntil(
    async () => {
      const rows = await sql`
      SELECT k.id, k.kb_no, k.status, k.version, k.approver_id, k.author_id, k.approved_at,
             k.updated_at, a.email AS approver_email, u.email AS author_email
      FROM knowledge k
      JOIN users u ON u.id = k.author_id
      LEFT JOIN users a ON a.id = k.approver_id
      WHERE k.id = ${draftRow.id} AND k.status = 'approved'
    `;
      return rows.length ? rows : null;
    },
    'knowledge approved',
    10_000,
  );
  check(
    'K7',
    '別人の承認者が画面から承認し、承認者 ≠ 作成者で DB に残る',
    approvedRow.approver_email === EMAIL.approver &&
      approvedRow.author_email === EMAIL.staff &&
      approvedRow.approver_id !== approvedRow.author_id,
  );
  check('K8', '承認で版が 1 以上になる', approvedRow.version >= 1, approvedRow.version);
  // KB から元の案件へたどれる。承認した本文の指紋と公開版が残る（docs/64 §10、§12）。
  const [trace] = await sql`
    SELECT k.source_case_ref, k.source_handover_id, r.content_hash, r.reviewed_version,
           r.published_version
    FROM knowledge k
    LEFT JOIN knowledge_reviews r ON r.knowledge_id = k.id AND r.decision = 'approved'
    WHERE k.id = ${draftRow.id}
  `;
  check(
    'K20',
    'KB から元の案件と引継ぎをたどれる',
    trace.source_case_ref === caseId && trace.source_handover_id === handover.id,
    trace.source_case_ref,
  );
  check(
    'K21',
    '承認の記録に確認した本文の指紋と公開版が残る',
    /^sha256:/.test(trace.content_hash ?? '') && trace.published_version === approvedRow.version,
    `${trace.reviewed_version}->${trace.published_version}`,
  );
  await sleep(500);
  await approver.page.screenshot({
    path: path.join(outDir, '10-approver-done.png'),
    fullPage: true,
  });
  const [statusAfterKb] = await sql`SELECT status FROM case_handovers WHERE id = ${handover.id}`;
  report.ids.handoverStatusAfterKbApproval = statusAfterKb.status;
  check(
    'K9',
    'KB の承認は引継ぎの完了承認を兼ねない（引継ぎは未完了のまま）',
    statusAfterKb.status !== 'completed',
    statusAfterKb.status,
  );

  // ── 6. 相談者 B: 次の相談の AI 入力に承認済み KB が入る ─────────────
  const kbLabel = `[${approvedRow.kb_no} v${approvedRow.version}]`;
  const aiBeforeB1 = aiCalls.length;
  const sinceB1 = Date.now();
  await B.page.evaluate(() => {
    S.ui.screen = 'home';
    uxRender();
  });
  const caseB = await openCase(B.page, `${FREE_SUBJECT}（再）`, FREE_BODY);
  await waitUntil(() => aiCalls.length > aiBeforeB1, 'B answer');
  await sleep(800);
  report.apiLog.B_consult = summarizeLog(B.log, sinceB1);
  const answerInput = aiCalls
    .slice(aiBeforeB1)
    .map((c) => c.user)
    .join('\n');
  check(
    'K10',
    `B の自由記述の相談で AI 入力に ${kbLabel} が入る`,
    answerInput.includes(kbLabel),
    kbLabel,
  );
  const demoInAnswer = answerInput.match(DEMO)?.[0] ?? '';
  check('K11', 'B の AI 入力にデモ値が無い', !demoInAnswer, demoInAnswer);
  check(
    'K12',
    'B の AI 入力に A の案件の実行 ID・相談者名が無い',
    !answerInput.includes(stepRow.command_id) && !answerInput.includes('合成 相談者A'),
  );
  // 承認した KB の節だけを見る（B 自身の PC 情報や、他の KB と混ぜない）。
  const kbSegment =
    answerInput
      .slice(answerInput.indexOf('ナレッジ:'))
      .split('\n\n---\n\n')
      .find((part) => part.includes(kbLabel)) ?? '';
  const aWebId = `WEB-${deviceId.slice(0, 8).toUpperCase()}`;
  report.ids.knowledgeSegmentHead = kbSegment.slice(0, 220);
  check('K14', 'B の AI 入力の KB に A の端末 ID が入らない', !kbSegment.includes(aWebId), aWebId);
  check(
    'K15',
    'B の AI 入力の KB に A の PC 基本情報が入らない',
    !/PC基本情報|取得日時/.test(kbSegment),
    kbSegment.slice(0, 120),
  );
  check(
    'K16',
    'B の AI 入力の KB に A の実行 ID が入らない',
    !kbSegment.includes(stepRow.command_id),
  );
  const consultApi = report.apiLog.B_consult.find((e) => e.path === '/api/ai/answer');
  check(
    'K13',
    'B の相談から /api/ai/answer が呼ばれる',
    consultApi?.status === 200,
    consultApi?.status,
  );
  await B.page.screenshot({ path: path.join(outDir, '11-b-answer.png'), fullPage: true });
  report.aiInputs.requesterB = {
    api: '/api/ai/answer',
    consult: FREE_BODY,
    kbLabels: [...new Set(answerInput.match(/\[KB-[^\]]+\]/g) ?? [])].map((label) => ({
      label,
      origin: label === kbLabel ? 'この流れで承認した KB' : 'シード（scripts/seed.ts）',
    })),
  };

  // 作成者本人の承認（自己承認）の KB は根拠にならない。
  const selfDraft = {
    clientRef: 'ui-SELF-E2E',
    title: `スプーラ ${SELF_MARKER}`,
    symptom: `スプーラが止まる ${SELF_MARKER}`,
    cause: SELF_MARKER,
    steps: SELF_MARKER,
    keywords: [],
  };
  await browserFetch(approver.page, '/api/knowledge/ui-sync', { ...selfDraft, status: 'pending' });
  const selfApproved = await browserFetch(approver.page, '/api/knowledge/ui-sync', {
    ...selfDraft,
    status: 'approved',
    checklist: { reproducible: true, noSecrets: true, noBlame: true, scopeClear: true },
    comment: '',
  });
  const aiBeforeSelf = aiCalls.length;
  await browserFetch(B.page, '/api/ai/answer', { text: FREE_BODY });
  await waitUntil(() => aiCalls.length > aiBeforeSelf, 'B self answer');
  const selfInput = aiCalls
    .slice(aiBeforeSelf)
    .map((c) => c.user)
    .join('\n');
  check(
    'K17',
    '自己承認の KB は AI 入力に入らない（API 直接）',
    !selfInput.includes(SELF_MARKER) && selfApproved.body?.aiUsable !== true,
    `${selfApproved.status}/aiUsable=${selfApproved.body?.aiUsable}`,
  );

  // ── 7. B の state に active KB を入れても根拠にならない ─────────────
  const injected = await B.page.evaluate((marker) => {
    const key = 'mirai-wizard-v31-helpdesk';
    const data = JSON.parse(localStorage.getItem(key));
    if (!data || !Array.isArray(data.kb)) return false;
    data.kb.unshift({
      id: 'KB-INJECT',
      title: `スプーラ ${marker}`,
      status: 'active',
      cat: 'device',
      symptom: `スプーラが止まる ${marker}`,
      cause: marker,
      steps: [marker],
      keywords: ['スプーラ'],
      version: 9,
      approvedBy: '合成 相談者B',
      history: [],
    });
    localStorage.setItem(key, JSON.stringify(data));
    return true;
  }, INJECT_MARKER);
  check('I1', 'B のブラウザの state に active KB を入れる', injected);
  await waitUntil(async () => {
    const rows = await sql`
      SELECT data::text AS t FROM prototype_states
      WHERE user_email = ${EMAIL.requesterB} AND name = 'helpdesk'
    `;
    return rows[0]?.t.includes(INJECT_MARKER);
  }, 'injected state saved');
  check('I2', '注入した KB は B の state として DB に保存される（前提の確認）', true);
  // 再読み込みで DB の state からブラウザへ戻してから、画面で相談する。
  await B.page.reload({ waitUntil: 'load' });
  await waitAfterReload(B.page);
  const aiBeforeInject = aiCalls.length;
  const injectAnswered = B.page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/ai/answer',
    { timeout: 20_000 },
  );
  await openCase(B.page, `${FREE_SUBJECT}（注入後）`, FREE_BODY);
  const injectResponse = await (await injectAnswered).json().catch(() => null);
  await waitUntil(() => aiCalls.length > aiBeforeInject, 'B inject answer');
  const injectInput = aiCalls
    .slice(aiBeforeInject)
    .map((c) => c.user)
    .join('\n');
  check(
    'I3',
    '注入した KB は AI 入力に入らない（画面から相談）',
    !injectInput.includes(INJECT_MARKER),
  );
  check(
    'I4',
    '注入した KB は出典に出ない',
    !JSON.stringify(injectResponse?.sources ?? []).includes('INJECT') &&
      !JSON.stringify(injectResponse?.sources ?? []).includes(INJECT_MARKER),
    JSON.stringify((injectResponse?.sources ?? []).map((source) => source.kbNo)),
  );
  check('I5', '注入後も承認済み KB は AI 入力に入る', injectInput.includes(kbLabel));
  const injectedState = await B.page.evaluate(() => {
    const item = window.HD?.kb?.().find((k) => k.id === 'KB-INJECT');
    return item ? { owner: item.owner, src: item.src } : null;
  });
  check(
    'I6',
    '注入した KB は画面でも承認済みと表示しない',
    injectedState?.src === 'local' && /未承認/.test(injectedState?.owner ?? ''),
    JSON.stringify(injectedState),
  );

  // ── 8. B の「印刷」の相談: 解決ループの提案と案内に承認済み KB が届く ─────
  // 8-1. 端末エージェントが未接続なら解決ループへ進めない（KB も出ない。残課題として記録）。
  const sinceBPrint = Date.now();
  await B.page.reload({ waitUntil: 'load' });
  await waitAfterReload(B.page);
  await openCase(B.page, PRINT_SUBJECT, PRINT_BODY);
  await sleep(1500);
  report.apiLog.B_printConsult_noAgent = summarizeLog(B.log, sinceBPrint);
  const noAgentChat = await chatText(B.page);
  report.ids.printNoAgentShowsKb = noAgentChat.includes(approvedRow.kb_no);
  const noAgentHandover = await B.page.locator('[data-aihd-kb-guide]').count();
  const noAgentSessions = await sql`
    SELECT count(*)::int AS n FROM resolution_sessions WHERE user_email = ${EMAIL.requesterB}
  `;
  check(
    'N0',
    'エージェント未接続でも、端末を操作せず承認済み KB を画面で案内する',
    report.ids.printNoAgentShowsKb && noAgentHandover > 0 && noAgentSessions[0].n === 0,
    `kb=${report.ids.printNoAgentShowsKb} sessions=${noAgentSessions[0].n}`,
  );
  check(
    'N0b',
    '案内の外部 AI 呼び出しなし（/api/ai/answer を呼ばない）',
    !JSON.stringify(report.apiLog.B_printConsult_noAgent).includes('/api/ai/answer'),
  );
  check(
    'N0c',
    'エージェント未接続でも担当者へ引き継ぐ導線が残る',
    noAgentChat.includes('担当者へ引き継'),
  );
  await B.page.screenshot({ path: path.join(outDir, '11a-b-print-no-agent-kb.png'), fullPage: true });
  finding(
    'N0-old',
    `（修正前）端末エージェント未接続の印刷の相談は解決ループへ進まないので、承認済み KB は案内されない（画面に KB 番号: ${report.ids.printNoAgentShowsKb}）。`,
  );

  // 8-2. 接続あり: 提案の AI 入力に KB の参照が入り、結果の後に出典付きで案内する。
  const deviceIdB = await B.page.evaluate(() => window.__AIHD_DEVICE_ID__);
  const tokenB = await issueToken(EMAIL.requesterB, deviceIdB);
  startAgent(baseB, tokenB, deviceIdB, 'agent-b');
  await waitUntil(async () => {
    const status = await browserFetch(
      B.page,
      `/api/resolve/device-status?deviceId=${deviceIdB}`,
      null,
    );
    return status.body?.agentConnected === true;
  }, 'agent b connected');
  const aiBeforePrint = aiCalls.length;
  const sinceBAgent = Date.now();
  stubUsesKnowledge = false;
  const caseBPrint = await openCase(B.page, PRINT_SUBJECT, PRINT_BODY);
  await B.page.waitForSelector(`${panel} [data-aihd-resolve="start"]`, { timeout: 15_000 });
  await B.page.click(`${panel} [data-aihd-resolve="start"]`);
  await B.page.waitForSelector(`${panel} [data-aihd-resolve="approve"][data-decision="Y"]`);
  const proposeInputs = () =>
    aiCalls
      .slice(aiBeforePrint)
      .filter((call) => call.kind === 'propose')
      .map((call) => JSON.parse(call.user));
  const firstPropose = proposeInputs().at(-1) ?? {};
  const firstRefs = firstPropose.knowledgeRefs ?? [];
  report.aiInputs.printPropose = {
    api: 'POST /api/resolve/sessions',
    knowledgeRefs: firstRefs.map((ref) => ({
      kbNo: ref.kbNo,
      version: ref.version,
      stepsSummaryLength: String(ref.stepsSummary ?? '').length,
      origin:
        ref.kbNo === approvedRow.kb_no ? 'この流れで承認した KB' : 'シード（scripts/seed.ts）',
    })),
  };
  check(
    'N1',
    `印刷の相談の提案の AI 入力に ${kbLabel} の参照が入る`,
    firstRefs.some(
      (ref) => ref.kbNo === approvedRow.kb_no && ref.version === approvedRow.version && ref.title,
    ),
    JSON.stringify(firstRefs.map((ref) => ref.kbNo)),
  );
  check(
    'N2',
    '提案の AI 入力に注入した state の KB と A の端末情報が入らない',
    !JSON.stringify(firstPropose).includes(INJECT_MARKER) &&
      !JSON.stringify(firstPropose).includes(aWebId) &&
      !/取得日時/.test(JSON.stringify(firstRefs)),
  );
  await B.page.click(`${panel} [data-aihd-resolve="approve"][data-decision="Y"]`);
  await B.page.waitForSelector(`${panel} [data-aihd-result-source]`, { timeout: 30_000 });
  await sleep(500);
  const notUsedCard = await B.page.innerText(panel);
  await B.page.screenshot({
    path: path.join(outDir, '11b-b-print-kb-not-used.png'),
    fullPage: true,
  });
  check(
    'N3',
    '実診断の後の案内に KB 番号・版・題名を出す',
    notUsedCard.includes(approvedRow.kb_no) && notUsedCard.includes(`v${approvedRow.version}`),
    notUsedCard.slice(0, 200),
  );
  check(
    'N4',
    'AI が使っていないときに「AI が参照」と表示しない',
    !/AI が参照しました/.test(notUsedCard) && /AI の参照はありません/.test(notUsedCard),
  );
  const origins = await B.page.evaluate(
    (selector) =>
      Object.fromEntries(
        [...document.querySelectorAll(`${selector} [data-aihd-kb-ref]`)].map((el) => [
          el.getAttribute('data-aihd-kb-ref'),
          el.getAttribute('data-aihd-kb-origin'),
        ]),
      ),
    panel,
  );
  report.ids.cardOrigins = origins;
  check(
    'N7',
    '結果カードの出所: この流れの KB は別の担当者、シードは初期登録と区別する',
    origins[approvedRow.kb_no] === 'other_person' &&
      origins['KB-2026-0003'] === 'seed' &&
      /初期登録の資料（人の承認記録なし）/.test(notUsedCard) &&
      !/別の担当者が承認したナレッジ/.test(notUsedCard),
    JSON.stringify(origins),
  );
  stubUsesKnowledge = true;
  await B.page.click(`${panel} [data-aihd-resolve="continue"][data-decision="Y"]`);
  await B.page.waitForFunction(
    (selector) => document.querySelector(`${selector} [data-aihd-resolve="approve"]`),
    panel,
  );
  await B.page.click(`${panel} [data-aihd-resolve="approve"][data-decision="Y"]`);
  // 実行中のカードにも「失敗」の語があるので、結果の表示だけを待つ。
  await waitUntil(
    async () => /AI が参照しました/.test(await B.page.innerText(panel)),
    'kb used shown',
    20_000,
  ).catch(() => null);
  const usedCard = await B.page.innerText(panel);
  await B.page.screenshot({ path: path.join(outDir, '11c-b-print-kb-used.png'), fullPage: true });
  check(
    'N5',
    'AI が usedKnowledge で示した KB だけ「AI が参照」と表示する',
    /AI が参照しました/.test(usedCard) && usedCard.includes(approvedRow.kb_no),
    usedCard.slice(0, 200),
  );
  stubUsesKnowledge = false;
  const [bSession] =
    await sql`SELECT status FROM resolution_sessions WHERE case_id = ${caseBPrint} AND user_email = ${EMAIL.requesterB}`;
  check(
    'N6',
    '案内を出しても解決にしない',
    bSession?.status === 'waiting_continue',
    bSession?.status,
  );
  report.apiLog.B_printConsult_agent = summarizeLog(B.log, sinceBAgent);

  // ── 9. 引継ぎの完了承認と報告書 ────────────────────────────────────
  const staffHasDraft = await staff.page.evaluate((id) => {
    const target = S.cases.find((c) => c.id === id);
    return target ? Boolean(link(target).dr) : false;
  }, caseId);
  const approverHasCase = await approver.page.evaluate(
    (id) => (S.cases || []).some((c) => c.id === id),
    caseId,
  );
  check(
    'C1',
    '別人の承認者の状態に案件が無くても、完了承認の導線が画面にある',
    !approverHasCase,
    `staffHasDraft=${staffHasDraft}`,
  );
  // API の直接呼び出しではなく、承認者のパネルのボタンを押す（docs/14 §2-17）。
  await approver.page.reload({ waitUntil: 'load' });
  await waitAfterReload(approver.page);
  await approver.page.waitForSelector('#ahApproverEntry', { timeout: 15_000 });
  await approver.page.click('#ahApproverEntry');
  const handoverButton = approver.page.locator(`[data-ahd="ho-approve"][data-id="${handover.id}"]`);
  await handoverButton.waitFor({ timeout: 15_000 });
  await approver.page.screenshot({ path: path.join(outDir, '10a-approver-panel-handover.png'), fullPage: true });
  await handoverButton.click();
  const completedRow = await waitUntil(
    async () => {
      const rows =
        await sql`SELECT status, approved_by FROM case_handovers WHERE id = ${handover.id}`;
      return rows[0]?.status === 'completed' ? rows[0] : null;
    },
    'handover completed',
    15_000,
  );
  check('C2', '完了承認を画面のボタンで行う（API 直接ではない）', Boolean(completedRow));
  await A.page.reload({ waitUntil: 'load' });
  await waitAfterReload(A.page);
  await A.page.evaluate((id) => {
    S.ui.case = id;
    S.ui.screen = 'wizard';
    uxRender();
  }, caseId);
  await waitUntil(
    () =>
      A.page.evaluate(() =>
        Boolean(document.querySelector('[data-act="wReport"][data-fmt="html"]')),
      ),
    'A report button',
    60_000,
  ).catch(() => null);
  const hasReportButton = await A.page.locator('[data-act="wReport"][data-fmt="html"]').count();
  check('R1', '完了後に相談者 A の画面に報告書の出力が出る', hasReportButton > 0);
  await A.page.screenshot({ path: path.join(outDir, '12-a-completed.png'), fullPage: true });
  if (hasReportButton > 0) {
    await A.page.click('[data-act="wReport"][data-fmt="html"]');
    await waitUntil(
      () => A.log.some((e) => e.path === '/api/reports/final' && e.method === 'POST'),
      'report post',
    );
    await sleep(1500);
    const reportEntry = A.log.find((e) => e.path === '/api/reports/final' && e.method === 'POST');
    check('R2', '報告書を画面から出力できる', reportEntry.status < 300, reportEntry.status);
    const rows = await sql`SELECT * FROM final_reports WHERE case_id = ${caseId}`;
    const rowText = JSON.stringify(rows[0] ?? {});
    writeFileSync(path.join(outDir, 'report-sample.html'), String(rows[0]?.html ?? ''));
    if (!narrowShare) check('R3', '報告書の DB 記録に「模擬」が入る', /模擬/.test(rowText));
    const demoInReport = rowText.match(DEMO)?.[0] ?? '';
    check('R4', '報告書にデモ値が無い', !demoInReport, demoInReport);
    check('R5', '報告書に実端末と書かない', !/端末エージェント（実端末）/.test(rowText));
    if (!narrowShare) check('R6', '報告書に実行 ID が入る', rowText.includes(stepRow.command_id));
  }

  // ── 10. ID の突合 ──────────────────────────────────────────────────
  const uiResult = await A.page.evaluate(
    (id) =>
      S.chats
        .find((c) => c.id === S.cases.find((x) => x.id === id)?.chatId)
        ?.messages.filter((m) => m.resolveResult)
        .map((m) => m.resolveResult) ?? [],
    caseId,
  );
  const agentLog = readFileSync(agent.logPath, 'utf8');
  const [joined] = await sql`
    SELECT st.id AS step_id, st.command_id, st.skill_id, s.case_id, s.id AS session_id, s.device_id,
           dc.status AS command_status, dc.device_id AS command_device,
           dc.result->>'executionSource' AS source
    FROM resolution_steps st
    JOIN resolution_sessions s ON s.id = st.session_id
    LEFT JOIN device_commands dc ON dc.id = st.command_id
    WHERE s.id = ${session.id} AND st.seq = 1
  `;
  const apiApprove = A.resolveBodies.find(
    (item) => item.body?.step?.id === joined.step_id && item.body?.command?.id,
  );
  const ui = uiResult.find((item) => item.stepId === joined.step_id);
  const idRow = {
    caseId: joined.case_id,
    sessionId: joined.session_id,
    proposalStepId: joined.step_id,
    commandId: joined.command_id,
    deviceId: joined.device_id,
    source: joined.source,
    ui: Boolean(
      ui &&
        ui.caseId === joined.case_id &&
        ui.commandId === joined.command_id &&
        ui.sessionId === joined.session_id,
    ),
    api: Boolean(
      apiApprove &&
        apiApprove.body.command.id === joined.command_id &&
        apiApprove.body.session.caseId === joined.case_id,
    ),
    db: joined.command_status === 'done' && joined.command_device === joined.device_id,
    agent: agentLog.includes(joined.command_id) && agentLog.includes('(mock)'),
    handoverSnapshot: snapshotText.includes(joined.command_id),
  };
  report.ids.flow = idRow;
  report.ids.handoverId = handover.id;
  report.ids.knowledge = {
    id: approvedRow.id,
    kbNo: approvedRow.kb_no,
    version: approvedRow.version,
    approverIsNotAuthor: approvedRow.approver_id !== approvedRow.author_id,
    labelInAiInput: answerInput.includes(kbLabel),
    caseB,
  };
  check(
    'X1',
    'UI / API / DB / エージェント / 引継ぎの ID が一致する',
    idRow.ui && idRow.api && idRow.db && idRow.agent && (narrowShare || idRow.handoverSnapshot),
    JSON.stringify({ ui: idRow.ui, api: idRow.api, db: idRow.db, agent: idRow.agent }),
  );

  // ── 11. 拒否の確認 ────────────────────────────────────────────────
  if (!skipReject) await rejections({ A, B, staff, baseA, deviceId, token, agent });

  report.apiLog.staff_all = summarizeLog(staff.log);
  report.apiLog.approver_all = summarizeLog(approver.log);
  report.apiLog.A_all = summarizeLog(A.log);
  report.apiLog.B_all = summarizeLog(B.log);
  check(
    'Z1',
    '外部への通信が無い（ブラウザ）',
    [A, B, staff, approver].every((p) => p.external.length === 0),
  );
  const pageErrors = [A, B, staff, approver].flatMap((p) => p.pageErrors);
  check('Z2', 'ページエラーが無い', pageErrors.length === 0, pageErrors.join(' / '));
  // 実 AI の確認の前に、スタブの段階の AI 文脈全体でデモ値を確かめる。
  const allPrompts = aiCalls.map((c) => c.user).join('\n');
  const demoInPrompts = allPrompts.match(DEMO)?.[0] ?? '';
  check('Z3', 'スタブが受けた全 AI 入力にデモ値が無い', !demoInPrompts, demoInPrompts);
  report.aiCalls = {
    answer: aiCalls.filter((c) => c.kind === 'answer').length,
    propose: aiCalls.filter((c) => c.kind === 'propose').length,
  };

  await realAi(browser, kbLabel, deviceId);

  for (const session of [A, B, staff, approver]) await session.context.close();
}

async function rejections({ A, B, staff, baseA, deviceId, token, agent }) {
  // ここから D1〜D14 は、ブラウザの文脈から API を直接呼ぶ（画面のクリックではない）。
  // 画面には不正な Y を送るボタンが無いので、サーバの拒否を確かめる。レート制限（承認 10/分）を空ける。
  await sleep(61_000);
  await A.page.reload({ waitUntil: 'load' });
  await waitAfterReload(A.page);
  const caseR = await openCase(A.page, PRINT_SUBJECT, PRINT_BODY);
  const startSession = async () => {
    const response = await browserFetch(A.page, '/api/resolve/sessions', {
      caseId: caseR,
      deviceId,
    });
    if (response.status !== 200) throw new Error(`session ${response.status}`);
    return response.body;
  };

  const d1 = await startSession();
  const hashD1 = await hashOf(A.page, d1.step.approvalChallenge.payload);
  const foreign = await browserFetch(B.page, `/api/resolve/steps/${d1.step.id}/approve`, {
    decision: 'Y',
    approvalHash: hashD1,
  });
  check('D1', '他の相談者の Y は 404', foreign.status === 404, foreign.status);
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
  await browserFetch(A.page, `/api/resolve/sessions/${d1.session.id}/stop`, {});

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

  await sleep(61_000);
  // エージェントを止めて Y → 取消 → 再開しても実行しない。
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
    'D13',
    'Y の後の取消で未取得のコマンドは実行しない',
    queued.status === 200 &&
      d5Command.status === 'expired' &&
      !readFileSync(agent.logPath, 'utf8').includes(d5Command.id),
    d5Command.status,
  );

  // 取消の後に届いた結果（配信済み）で状態を進めない。
  const d6 = await startSession();
  const hashD6 = await hashOf(A.page, d6.step.approvalChallenge.payload);
  process.kill(-agent.child.pid, 'SIGSTOP');
  const d6Approved = await browserFetch(A.page, `/api/resolve/steps/${d6.step.id}/approve`, {
    decision: 'Y',
    approvalHash: hashD6,
  });
  const delivered = await fetch(`${baseA}/api/device/command`, {
    headers: { 'x-device-token': token, 'x-device-id': deviceId },
  });
  const deliveredCommand = (await delivered.json()).command;
  await browserFetch(A.page, `/api/resolve/sessions/${d6.session.id}/stop`, {});
  const late = await fetch(`${baseA}/api/device/command/${deliveredCommand.id}/result`, {
    method: 'POST',
    headers: {
      'x-device-token': token,
      'x-device-id': deviceId,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ok: true,
      result: { executionSource: 'mock', normalized: { status: 'Running' }, stdoutSummary: '' },
    }),
  });
  await browserFetch(A.page, `/api/resolve/steps/${d6.step.id}`, null);
  const [d6Session] = await sql`SELECT status FROM resolution_sessions WHERE id = ${d6.session.id}`;
  const [d6Step] =
    await sql`SELECT status, result_summary FROM resolution_steps WHERE id = ${d6.step.id}`;
  check(
    'D14',
    '取消の後に届いた応答で状態を進めない',
    d6Approved.status === 200 &&
      d6Session.status === 'stopped' &&
      d6Step.status === 'cancelled' &&
      d6Step.result_summary === null,
    `${late.status}/${d6Step.status}`,
  );
  process.kill(-agent.child.pid, 'SIGCONT');
}

/**
 * AI 入力の部分だけ実 AI で 1 回確かめる。
 * 間に記録用の中継を置き、送信内容が合成であることを確かめてから転送する。認証ヘッダは記録しない。
 */
async function realAi(browser, kbLabel, requesterDeviceId) {
  const confPath = process.env.DATAFLOW_REAL_AI_CONF;
  if (!confPath) {
    report.realAi = { executed: false, reason: 'DATAFLOW_REAL_AI_CONF 未指定' };
    return;
  }
  const conf = {};
  for (const line of readFileSync(confPath, 'utf8').split('\n')) {
    const match = /^(DEEPSEEK_[A-Z_]+)=(.*)$/.exec(line.trim());
    if (match) conf[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
  if (!conf.DEEPSEEK_API_KEY) {
    report.realAi = { executed: false, reason: 'DEEPSEEK_API_KEY が読めない' };
    check('Q0', '実 AI の設定を読める', false);
    return;
  }
  const upstream = (conf.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
  const forbidden = [os.hostname(), os.userInfo().username].filter(Boolean);
  const sent = [];
  const proxy = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', async () => {
      const parsed = JSON.parse(raw);
      const user = String(parsed.messages?.at(-1)?.content ?? '');
      // fail-closed: 合成の相談文と KB だけを送る。端末情報を検出したら転送しない。
      const blockedBy = [
        forbidden.some((word) => raw.includes(word)) && 'host',
        /[\w.+-]+@(?!example\.test)[\w-]+\.[\w.-]+/.test(raw) && 'email',
        /WEB-[0-9A-F]{8}/.test(user) && 'web-id',
        /PC基本情報|取得日時/.test(user) && 'pc-info',
        user.includes(requesterDeviceId) && 'device-id',
      ].filter(Boolean);
      const blocked = blockedBy.length > 0;
      sent.push({
        blocked,
        blockedBy,
        model: parsed.model,
        messages: parsed.messages?.length,
        user,
      });
      if (blocked || sent.length > REAL_AI_CONSULTS.length) {
        response.statusCode = 500;
        response.end('{"error":"blocked by e2e proxy"}');
        return;
      }
      try {
        const upstreamResponse = await fetch(`${upstream}${request.url}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: request.headers.authorization ?? '',
          },
          body: raw,
          signal: AbortSignal.timeout(60_000),
        });
        response.statusCode = upstreamResponse.status;
        response.setHeader('Content-Type', 'application/json');
        response.end(await upstreamResponse.text());
      } catch (error) {
        response.statusCode = 502;
        response.end(JSON.stringify({ error: String(error?.name ?? 'fetch failed') }));
      }
    });
  });
  await new Promise((resolve) => proxy.listen(PORTS.aiProxy, '127.0.0.1', resolve));
  try {
    const base = await startApi('requesterC', {
      DEEPSEEK_API_KEY: conf.DEEPSEEK_API_KEY,
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${PORTS.aiProxy}`,
      DEEPSEEK_MODEL: conf.DEEPSEEK_MODEL ?? 'deepseek-flash',
      DEEPSEEK_TIMEOUT_MS: conf.DEEPSEEK_TIMEOUT_MS ?? '30000',
      DEEPSEEK_THINKING: conf.DEEPSEEK_THINKING ?? 'disabled',
    });
    const C = await openPage(browser, base, 'realAi', { blockDevice: true });
    // 最大 2 回。1 回目が承認済み KB を根拠にしたら 2 回目は送らない。条件は緩めない。
    const attempts = [];
    for (const [subject, consult] of REAL_AI_CONSULTS) {
      const answered = C.page.waitForResponse(
        (response) => new URL(response.url()).pathname === '/api/ai/answer',
        { timeout: 90_000 },
      );
      await C.page.evaluate(() => {
        S.ui.screen = 'home';
        uxRender();
      });
      const sentBefore = sent.length;
      await openCase(C.page, subject, consult);
      const response = await answered;
      const body = await response.json().catch(() => null);
      await sleep(1500);
      const input = sent[sentBefore]?.user ?? '';
      const cited = (body?.sources ?? []).map((source) => `${source.kbNo} v${source.version}`);
      const answer = String(body?.answer ?? '');
      attempts.push({
        attempt: attempts.length + 1,
        subject,
        consult,
        status: response.status(),
        provider: body?.provider,
        model: body?.model,
        blockedBy: sent[sentBefore]?.blockedBy ?? [],
        kbLabelsInInput: [...new Set(input.match(/\[KB-[^\]]+\]/g) ?? [])],
        kbSegmentHead:
          input
            .slice(input.indexOf('ナレッジ:'))
            .split('\n\n---\n\n')
            .find((part) => part.includes(kbLabel))
            ?.slice(0, 240) ?? '',
        cited,
        citesFlowKb: cited.some((item) => kbLabel.includes(item.split(' ')[0])),
        mentionsInjection: /指示が含まれ/.test(answer),
        answer: answer.slice(0, 400),
        chatHasAnswer: (await chatText(C.page)).includes(answer.slice(0, 12)),
      });
      await C.page.screenshot({
        path: path.join(outDir, `13-real-ai-answer-${attempts.length}.png`),
        fullPage: true,
      });
      if (attempts.at(-1).citesFlowKb) break;
    }
    check(
      'Q1',
      `実 AI: 要求は最大 ${REAL_AI_CONSULTS.length} 回`,
      sent.length >= 1 && sent.length <= REAL_AI_CONSULTS.length,
      sent.length,
    );
    check(
      'Q2',
      '実 AI: 全要求が送信内容の確認（端末情報・実メール・ホスト名なし）を通過',
      sent.length > 0 && sent.every((item) => !item.blocked),
      sent.flatMap((item) => item.blockedBy).join(','),
    );
    check(
      'Q3',
      `実 AI: 送った入力に ${kbLabel} が入る`,
      attempts.every((item) => item.kbLabelsInInput.includes(kbLabel)),
    );
    check(
      'Q4',
      '実 AI: API の応答が provider=deepseek（フォールバックでない）',
      attempts.every((item) => item.status === 200 && item.provider === 'deepseek'),
      attempts.map((item) => `${item.status}/${item.provider}`).join(' '),
    );
    check(
      'Q5',
      '実 AI: 回答がこの流れの承認済み KB を根拠に挙げる',
      attempts.some((item) => item.citesFlowKb),
      attempts.map((item) => `#${item.attempt}:${item.cited.join('+') || 'なし'}`).join(' '),
    );
    check(
      'Q6',
      '実 AI: 画面に回答が出る',
      attempts.every((item) => item.chatHasAnswer),
    );
    check(
      'Q7',
      '実 AI: 相談者に「入力に指示が含まれていました」の文を見せない',
      attempts.every((item) => !item.mentionsInjection),
    );
    report.realAi = {
      executed: true,
      requestCount: sent.length,
      attempts,
      scope:
        '実 AI で確認したのは /api/ai/answer の入力と応答のみ。解決ループの提案、担当者の AI 文脈はスタブ。',
    };
    await C.context.close();
  } finally {
    proxy.close();
  }
}

// ── main ──────────────────────────────────────────────────────────
let exitCode = 0;
let aiServer;
let browser;
try {
  await prepareDb();
  aiServer = await startAiStub();
  browser = await chromium.launch({ headless: true });
  await main(browser);
  if (checks.some((item) => !item.ok)) exitCode = 1;
} catch (error) {
  exitCode = 1;
  report.crash = String(error?.message ?? error).slice(0, 500);
  console.error(String(error?.stack ?? error).slice(0, 2000));
  for (const role of Object.keys(EMAIL)) {
    try {
      console.error(
        `--- api-${role}\n${readFileSync(path.join(tmp, `api-${role}.log`), 'utf8').slice(-600)}`,
      );
    } catch {
      // 起動していない。
    }
  }
} finally {
  writeFileSync(path.join(outDir, 'result.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (browser) await browser.close().catch(() => {});
  for (const child of children) stopChild(child);
  if (aiServer) aiServer.close();
  await sql.end({ timeout: 5 }).catch(() => {});
  rmSync(tmp, { recursive: true, force: true });
}
const failed = checks.filter((item) => !item.ok);
console.log(`checks=${checks.length} failed=${failed.length}`);
process.exit(exitCode);
