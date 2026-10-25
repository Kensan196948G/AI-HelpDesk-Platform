#!/usr/bin/env node
/**
 * 解決ループ（経路2）評価ハーネス。
 *
 * 目的:
 *   「AI が承認済み Skill を選び、端末で実行し、結果を見て次の手順へ進めるか」を
 *   同じケース集合で繰り返し測る。既存の run-eval.mjs は経路1（/api/ai/answer の
 *   テキスト回答）を測るものなので、こちらは別経路・別指標として独立に持つ。
 *
 * 参照実装:
 *   apps/api/src/resolve/routes.integration.test.ts の呼び出し順をそのまま踏襲する。
 *   セッション作成 → 承認ハッシュ計算（サーバが返す approvalChallenge.payload）→
 *   approve → 端末コマンド結果の反映（GET /resolve/steps/:id）→ continue。
 *   承認ハッシュは **サーバが返したチャレンジからだけ** 作る（自前で payload を組まない）。
 *
 * 模擬（重要）:
 *   端末は無い。実行は scripts/endpoint-command-agent.mjs --mock の fixture で代用する。
 *   したがって「実行成功」は **模擬成功** であり、実機で操作が成立した証明ではない。
 *   レポートには mock: true と steps[].executedBy: "mock" を必ず残す。
 *
 * 代行（重要）:
 *   実行前 Y / 結果後 Y は本来は利用者の判断。本ハーネスは評価のために自動で押す。
 *   レポートに approval.autoApproved: true と注記を残す。
 *   本人の「解決した」（POST /resolve/sessions/:id/resolve）は **代行しない**
 *   （解決したかどうかは利用者しか判断できないため）。
 *
 * 安全側の設計（既存 run-eval.mjs の作法を踏襲）:
 *   - 既定は dry-run。`--execute` を付けたときだけ API / DB を触る。
 *   - 接続先は loopback のみ（--allow-remote で明示的に解除できるが推奨しない）。
 *   - DB 名が ai_helpdesk_verify でなければ停止する（preview / 本番を触らない）。
 *   - ケース間は既定 3 秒待機。加えてサーバのレート制限（承認 10/分など）を
 *     クライアント側で先回りして守る（429 を出さない）。
 *   - 相談文・回答全文・rationale・実行結果の本文は保存しない（skillId / 状態 /
 *     パラメータのキー名 / 成否だけ）。
 *   - デバイストークンは実行時に生成し、値は出力しない（0600 のファイルに退避して再利用）。
 *
 * 使い方:
 *   node scripts/eval/run-loop-eval.mjs                        # dry-run（既定）
 *   node scripts/eval/run-loop-eval.mjs --execute --as user@example.com
 *   node scripts/eval/run-loop-eval.mjs --execute --as ... --only kb-03,kb-12
 *   node scripts/eval/run-loop-eval.mjs --execute --as ... --out /tmp/report.json
 *
 * 終了コード: 0 正常 / 2 引数・安全ゲート不正 / 3 実行エラー / 4 未達（--fail-on-miss）
 */
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import postgres from 'postgres';

const execFileAsync = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CASES_FILE = path.join(HERE, 'cases.jsonl');
const EXPECTATIONS_FILE = path.join(HERE, 'loop-expectations.json');
const AGENT_PATH = path.join(HERE, '..', 'endpoint-command-agent.mjs');

/** 検証用に固定する端末 ID と案件 ID の接頭辞（本物の案件と混ざらないようにする）。 */
const DEVICE_ID = 'LOOP-EVAL-01';
const CASE_PREFIX = 'EVAL-';
// device_inventories.source は CHECK で 'browser' / 'agent' に限定されている。
const DEVICE_SOURCE = 'agent';
const TOKEN_FILE = path.join(os.tmpdir(), '.aihd-loop-eval-device-tokens.json');
/** サーバ側の max_steps は 6。暴走時の最後の砦として 8 で打ち切る。 */
const HARD_STEP_GUARD = 8;
const DB_NAME_REQUIRED = 'ai_helpdesk_verify';
const TERMINAL_STATUSES = new Set(['resolved', 'escalated', 'stopped', 'expired']);
/** 409 でも「設計どおりの停止」なのでエラー扱いしないコード。 */
// STEP_LIMIT と AWAITING_DECISION は設計どおりの停止（エラーではない）。
const EXPECTED_CONTROL_CODES = new Set(['STEP_LIMIT', 'AWAITING_DECISION']);

function parseArgs(argv) {
  const out = {
    base: 'http://127.0.0.1:19311',
    as: process.env.AIHD_EVAL_EMAIL ?? null,
    execute: false,
    allowRemote: false,
    out: null,
    only: null,
    limit: null,
    paceMs: 3000,
    timeoutMs: 30_000,
    databaseUrl: process.env.DATABASE_URL ?? null,
    failOnMiss: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} に値がありません`);
      return argv[i];
    };
    switch (arg) {
      case '--base':
        out.base = next();
        break;
      case '--as':
        out.as = next();
        break;
      case '--execute':
        out.execute = true;
        break;
      case '--allow-remote':
        out.allowRemote = true;
        break;
      case '--out':
        out.out = next();
        break;
      case '--only':
        out.only = next()
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean);
        break;
      case '--limit':
        out.limit = Number(next());
        break;
      case '--pace-ms':
        out.paceMs = Number(next());
        break;
      case '--timeout-ms':
        out.timeoutMs = Number(next());
        break;
      case '--database-url':
        out.databaseUrl = next();
        break;
      case '--fail-on-miss':
        out.failOnMiss = true;
        break;
      case '--help':
      case '-h':
        out.help = true;
        break;
      default:
        throw new Error(`未知の引数: ${arg}`);
    }
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLoopbackHost(hostname) {
  return (
    hostname === 'localhost' ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    /^127\.\d+\.\d+\.\d+$/.test(hostname)
  );
}

function databaseName(databaseUrl) {
  const parsed = new URL(databaseUrl);
  return decodeURIComponent(parsed.pathname.replace(/^\//, ''));
}

function loadCases(opts) {
  const lines = readFileSync(CASES_FILE, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '');
  let cases = lines.map((line) => JSON.parse(line));
  if (opts.only) {
    const wanted = new Set(opts.only);
    cases = cases.filter((testCase) => wanted.has(testCase.id));
    const found = new Set(cases.map((testCase) => testCase.id));
    const missing = opts.only.filter((id) => !found.has(id));
    if (missing.length > 0) throw new Error(`--only に存在しない ID: ${missing.join(',')}`);
  }
  if (opts.limit) cases = cases.slice(0, opts.limit);
  return cases;
}

function loadExpectations() {
  const parsed = JSON.parse(readFileSync(EXPECTATIONS_FILE, 'utf8'));
  if (!parsed?.cases || typeof parsed.cases !== 'object') {
    throw new Error('loop-expectations.json の cases が読めません');
  }
  return parsed;
}

/**
 * 承認ハッシュの対象を正規化する（apps/api/src/domain/audit.ts の stableStringify と同一）。
 * サーバと同じ文字列を作らないとハッシュが一致しないため、実装を写している。
 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/** サーバが返した approvalChallenge.payload からハッシュを作る（payload を自前で組まない）。 */
function computeApprovalHash(payload) {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

function sha256Hex(text) {
  return createHash('sha256').update(text).digest('hex');
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function countBy(values, keyOf) {
  const counts = {};
  for (const value of values) {
    const key = keyOf(value) ?? 'unknown';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/**
 * 固定ウィンドウ（60 秒）のレート制限をクライアント側で先回りして守る。
 * サーバの上限より 1 小さい値にして、境界の取り違えで 429 にならないようにする。
 */
/** 429 を受けたときの待機（サーバの固定ウィンドウ 60 秒を跨ぐ長さにしてある）。 */
const RATE_LIMIT_BACKOFF_MS = Object.freeze([15_000, 30_000, 45_000]);

const RATE_LIMITS = Object.freeze({
  sessionStart: 18, // サーバ 20/分
  approve: 9, // サーバ 10/分
  continue: 18, // サーバ 20/分
  stepGet: 100, // サーバ 120/分
  sessionGet: 100,
  stop: 8, // サーバ 10/分
});

function createRateGate() {
  const log = new Map();
  return {
    async take(key) {
      const limit = RATE_LIMITS[key];
      if (!limit) return;
      for (;;) {
        const now = Date.now();
        const hits = (log.get(key) ?? []).filter((at) => now - at < 60_000);
        log.set(key, hits);
        if (hits.length < limit) {
          hits.push(now);
          return;
        }
        await sleep(60_000 - (now - hits[0]) + 50);
      }
    },
  };
}

function createApi(opts, gate) {
  let requestCount = 0;
  async function request(method, pathname, body, gateKey) {
    const gateStartedAt = Date.now();
    if (gateKey) await gate.take(gateKey);
    let gateMs = Date.now() - gateStartedAt;
    const headers = { accept: 'application/json' };
    if (opts.as) headers['cf-access-authenticated-user-email'] = opts.as;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let response;
    let fetchMs = 0;
    for (let attempt = 0; ; attempt += 1) {
      const fetchStartedAt = Date.now();
      response = await fetch(new URL(pathname, opts.base), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      fetchMs += Date.now() - fetchStartedAt;
      // ゲートをすり抜けた場合の保険。サーバの固定ウィンドウ（60 秒）が明けるまで待つ。
      // 承認チャレンジの有効期限は 5 分なので、ここで 90 秒待っても承認は失効しない。
      if (response.status !== 429 || attempt >= RATE_LIMIT_BACKOFF_MS.length) break;
      const backoff = RATE_LIMIT_BACKOFF_MS[attempt];
      gateMs += backoff;
      await sleep(backoff);
    }
    requestCount += 1;
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    // gateMs = レート制御のためにハーネスが待った時間 / fetchMs = HTTP の実処理時間。
    return { status: response.status, ok: response.ok, body: parsed, gateMs, fetchMs };
  }
  return {
    request,
    get requestCount() {
      return requestCount;
    },
  };
}

function errorCode(response) {
  return response?.body?.error?.code ?? null;
}

function errorMessage(response) {
  return response?.body?.error?.message ?? null;
}

function evalCaseId(id) {
  return `${CASE_PREFIX}${id}`;
}

/** 端末トークンは 1 回だけ生成し、0600 のファイルに退避して再実行で使い回す（値は出力しない）。 */
function loadOrCreateTokens() {
  if (existsSync(TOKEN_FILE)) {
    try {
      const parsed = JSON.parse(readFileSync(TOKEN_FILE, 'utf8'));
      if (parsed?.standard && parsed?.admin) return parsed;
    } catch {
      // 壊れていたら作り直す。
    }
  }
  const tokens = {
    standard: randomBytes(32).toString('hex'),
    admin: randomBytes(32).toString('hex'),
  };
  writeFileSync(TOKEN_FILE, JSON.stringify(tokens), { mode: 0o600 });
  chmodSync(TOKEN_FILE, 0o600);
  return tokens;
}

/**
 * 承認時の端末オンライン判定（device_tokens.last_used_at）を満たす。
 * /api/device/command を呼ぶと queued のコマンドを「配信済み」にしてしまい、
 * 直後のエージェントが取得できなくなるため、ポーリング相当として last_used_at だけ更新する。
 */
async function touchDevice(sql, tokenHashes) {
  for (const hash of tokenHashes) {
    await sql`
      UPDATE device_tokens SET last_used_at = now()
      WHERE token_hash = ${hash} AND revoked_at IS NULL
    `;
  }
}

/**
 * 専用デバイスを用意する。
 * - device_inventories: セッション開始は「本人の端末」だけ許可されるため必須。
 * - device_tokens: 承認時のオンライン判定と、端末エージェントの認証に必要。
 *   privilege='standard' と 'admin' の 2 本を持つ（昇格必須 Skill は admin にしか配信されない）。
 */
async function prepareDevice(sql, email, tokens) {
  const standardHash = sha256Hex(tokens.standard);
  const adminHash = sha256Hex(tokens.admin);
  await sql`
    INSERT INTO device_inventories (user_email, source, device_id, data)
    VALUES (${email}, ${DEVICE_SOURCE}, ${DEVICE_ID}, '{}'::jsonb)
    ON CONFLICT (user_email, source, device_id) DO NOTHING
  `;
  for (const row of [
    { hash: standardHash, label: 'loop-eval-standard', privilege: 'standard' },
    { hash: adminHash, label: 'loop-eval-admin', privilege: 'admin' },
  ]) {
    await sql`
      INSERT INTO device_tokens (token_hash, user_email, label, device_id, privilege, last_used_at)
      VALUES (${row.hash}, ${email}, ${row.label}, ${DEVICE_ID}, ${row.privilege}, now())
      ON CONFLICT (token_hash) DO UPDATE
        SET user_email = EXCLUDED.user_email,
            device_id = EXCLUDED.device_id,
            privilege = EXCLUDED.privilege,
            revoked_at = NULL,
            last_used_at = now()
    `;
  }
  return { standardHash, adminHash };
}

/**
 * cases.jsonl の 30 件を、検証 DB の cowork 案件として投入する。
 * 既存の案件は消さない（EVAL- 接頭辞の分だけ入れ替える）。
 * 相談文はこの DB にしか置かず、レポートには保存しない。
 */
async function seedCases(sql, email, cases) {
  const rows = await sql`
    SELECT data FROM prototype_states WHERE user_email = ${email} AND name = 'cowork' LIMIT 1
  `;
  let state = rows[0]?.data;
  if (typeof state === 'string') {
    try {
      state = JSON.parse(state);
    } catch {
      state = null;
    }
  }
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    state = { v: 31, estop: false, cases: [] };
  }
  const existing = Array.isArray(state.cases) ? state.cases : [];
  const kept = existing.filter((item) => !String(item?.id ?? '').startsWith(CASE_PREFIX));
  const seeded = cases.map((testCase) => ({
    id: evalCaseId(testCase.id),
    userId: 'eval',
    subject: '',
    body: testCase.text,
    urg: '通常',
    kind: 'eval',
    closed: null,
    chatId: null,
  }));
  const next = { ...state, cases: [...seeded, ...kept] };
  if (rows[0]) {
    await sql`
      UPDATE prototype_states SET data = ${sql.json(next)}, updated_at = now()
      WHERE user_email = ${email} AND name = 'cowork'
    `;
  } else {
    await sql`
      INSERT INTO prototype_states (user_email, name, data)
      VALUES (${email}, 'cowork', ${sql.json(next)})
    `;
  }
  return { seeded: seeded.length, kept: kept.length, estop: Boolean(next.estop) };
}

/**
 * 前回の途中終了（中断・レート制限）で残った EVAL- セッションを畳む。
 * 残すと queued のコマンドが次のケースのエージェントに拾われ、測定が混ざる。
 * 対象は EVAL- 接頭辞のケースだけ（本物の案件・他担当のセッションには触らない）。
 */
async function resetPreviousRuns(sql, email) {
  const sessions = await sql`
    UPDATE resolution_sessions SET status = 'stopped', updated_at = now()
    WHERE user_email = ${email}
      AND case_id LIKE ${`${CASE_PREFIX}%`}
      AND status NOT IN ('resolved', 'escalated', 'stopped', 'expired')
    RETURNING id
  `;
  await sql`
    UPDATE resolution_steps SET status = 'cancelled'
    WHERE status IN ('proposed', 'approved', 'executing')
      AND session_id IN (
        SELECT id FROM resolution_sessions
        WHERE user_email = ${email} AND case_id LIKE ${`${CASE_PREFIX}%`}
      )
  `;
  await sql`
    UPDATE device_commands SET status = 'expired', completed_at = now()
    WHERE user_email = ${email} AND status = 'queued'
      AND session_id IN (
        SELECT id FROM resolution_sessions
        WHERE user_email = ${email} AND case_id LIKE ${`${CASE_PREFIX}%`}
      )
  `;
  return sessions.length;
}

/** 端末エージェントを 1 回だけ動かす（--mock で fixture 実行）。 */
async function runMockAgent(configPath, privilege) {
  const args = [AGENT_PATH, '--once', '--mock', '--config', configPath, '--privilege', privilege];
  try {
    await execFileAsync(process.execPath, args, { timeout: 90_000, maxBuffer: 2 * 1024 * 1024 });
    return { ran: true };
  } catch (error) {
    // エージェントは失敗も result 報告で返す設計なので、ここに来るのは起動失敗など。
    return { ran: false, detail: String(error?.message ?? error).slice(0, 300) };
  }
}

/** approve のエラーコードから停止理由を決める。 */
function approveStopReason(code) {
  switch (code) {
    case 'DEVICE_OFFLINE':
      return 'device_offline';
    case 'APPROVAL_EXPIRED':
      return 'approval_expired';
    case 'SESSION_EXPIRED':
      return 'session_expired';
    case 'SKILL_NOT_ALLOWED':
      return 'skill_not_allowed';
    case 'ADMIN_APPROVAL_REQUIRED':
      return 'admin_approval_required';
    case 'RATE_LIMITED':
      return 'rate_limited';
    default:
      return 'approve_error';
  }
}

function continueStopReason(code) {
  switch (code) {
    case 'STEP_LIMIT':
      return 'step_limit';
    case 'AWAITING_DECISION':
      // verify 成功後は利用者の判断待ち。ループとしては正常終了。
      return 'verified_awaiting_decision';
    case 'SESSION_EXPIRED':
      return 'session_expired';
    case 'RATE_LIMITED':
      return 'rate_limited';
    default:
      return 'continue_error';
  }
}

function reasonFromContinue(reason) {
  if (reason === 'NO_SKILL') return 'no_skill';
  if (reason === 'NO_PROGRESS') return 'no_progress';
  return 'no_next_step';
}

/**
 * モード分類（停止理由の整理）。優先順位は C → R → B → A → D。
 *   C 実行失敗 … 端末実行が 1 回でも失敗した
 *   R 解決候補 … verify 成功でループが止まり、利用者の判断待ち（awaitingResolution）
 *   B 誤選択   … 明示期待があるのに、その Skill を一度も提案しなかった
 *   A 手順なし … no_skill で引き継ぎ。期待 Skill を提案できていた場合は D 側に倒す
 *   D 引継ぎ   … それ以外で escalated（no_progress / step_limit など）
 *   U 未終局   … 終局状態に到達しなかった（ハーネス側の後始末で停止）
 */
function classifyMode(record) {
  if (record.steps.some((step) => step.status === 'failed')) return 'C';
  if (record.awaitingResolution === true) return 'R';
  const expected = record.expectation.expectSkillIds ?? [];
  if (expected.length > 0 && record.selectionMatched !== true) return 'B';
  // no_skill でも、期待した Skill を実際に提案・実行できていたなら「手順が無い」ではない（D 側）。
  if (record.stopReason === 'no_skill' && record.selectionMatched !== true) return 'A';
  if (record.finalStatus === 'escalated') return 'D';
  return 'U';
}

async function finishCase(record, startedAt) {
  if (!record.finalStatus) record.finalStatus = 'unknown';
  const expected = record.expectation.expectSkillIds ?? [];
  const first = record.proposals[0]?.skillId ?? null;
  record.firstProposal = first;
  record.selectionMatched =
    expected.length === 0
      ? null
      : expected.some((id) => record.proposals.some((proposal) => proposal.skillId === id));
  record.firstProposalMatched = expected.length === 0 ? null : expected.includes(first);
  record.mode = classifyMode(record);
  record.latencyMs = Date.now() - startedAt;
  return record;
}

/**
 * 1 ケースを「提案 → 承認 →（mock）実行 → 継続」で終局まで回す。
 * 途中の HTTP エラーは握りつぶさず httpErrors に積み、そのケースだけ止めて次へ進む。
 */
async function runCase(ctx, testCase) {
  const startedAt = Date.now();
  const expect = ctx.expectations.cases[testCase.id] ?? {
    kbNo: null,
    basis: 'escalate',
    expectSkillIds: [],
    escalateAcceptable: true,
  };
  const record = {
    id: testCase.id,
    group: testCase.group,
    kbNo: expect.kbNo ?? null,
    caseId: evalCaseId(testCase.id),
    expectation: {
      basis: expect.basis,
      expectSkillIds: expect.expectSkillIds ?? [],
      escalateAcceptable: expect.escalateAcceptable !== false,
    },
    sessionId: null,
    steps: [],
    proposals: [],
    statusPath: [],
    finalStatus: null,
    stopReason: null,
    mode: null,
    // verify 成功でループが止まり、利用者の判断待ちになったか（解決候補）。
    awaitingResolution: false,
    // script 形態 verify の追撃実行を何回行ったか（サーバ主導）。
    verifyFollowups: 0,
    selectionMatched: null,
    httpErrors: [],
    controlSignals: [],
    cleanup: null,
    latencyMs: null,
    gateWaitMs: 0,
    requestMs: 0,
  };

  let session = null;
  let step = null;
  const track = (response) => {
    record.gateWaitMs += response.gateMs ?? 0;
    record.requestMs += response.fetchMs ?? 0;
    return response;
  };

  const start = track(
    await ctx.api.request(
      'POST',
      '/api/resolve/sessions',
      { caseId: record.caseId, deviceId: DEVICE_ID },
      'sessionStart',
    ),
  );
  if (!start.ok) {
    const code = errorCode(start);
    record.httpErrors.push({
      op: 'session',
      status: start.status,
      code,
      message: errorMessage(start),
    });
    if (code === 'NO_SKILL') {
      record.finalStatus = 'escalated';
      record.stopReason = 'no_skill';
    } else {
      record.finalStatus = 'unknown';
      record.stopReason = code === 'ESTOP_ACTIVE' ? 'estop' : 'session_error';
    }
    return finishCase(record, startedAt);
  }

  session = start.body.session;
  step = start.body.step;
  record.sessionId = session.id;
  record.maxSteps = session.maxSteps ?? null;
  record.statusPath.push(session.status);
  if (step) {
    record.proposals.push({
      seq: step.seq,
      skillId: step.skillId,
      riskLevel: step.riskLevel,
      paramKeys: Object.keys(step.params ?? {}),
    });
  }

  for (let guard = 0; guard < HARD_STEP_GUARD; guard += 1) {
    if (!step) break;

    // ── 実行前 Y（利用者の代わりに押す） ──
    const challenge = step.approvalChallenge;
    if (!challenge?.payload) {
      record.stopReason = 'no_challenge';
      break;
    }
    const stepStartedAt = Date.now();
    await touchDevice(ctx.sql, [ctx.device.standardHash, ctx.device.adminHash]);
    const approvalHash = computeApprovalHash(challenge.payload);
    const approved = track(
      await ctx.api.request(
        'POST',
        `/api/resolve/steps/${step.id}/approve`,
        { decision: 'Y', approvalHash },
        'approve',
      ),
    );
    if (!approved.ok) {
      record.httpErrors.push({
        op: 'approve',
        status: approved.status,
        code: errorCode(approved),
        message: errorMessage(approved),
      });
      record.stopReason = approveStopReason(errorCode(approved));
      break;
    }
    session = approved.body.session;
    record.statusPath.push(session.status);

    // ── 端末実行（mock fixture） ──
    // standard と admin の両方を 1 回ずつ動かす。権限が合わない側は 204 で何もしない。
    const standardRun = await runMockAgent(ctx.configPath, 'standard');
    const adminRun = await runMockAgent(ctx.configPath, 'admin');
    if (!standardRun.ran && !adminRun.ran) {
      record.httpErrors.push({ op: 'agent', status: null, code: 'AGENT_FAILED', message: null });
    }

    // ── 端末結果の反映 ──
    const detail = track(
      await ctx.api.request('GET', `/api/resolve/steps/${step.id}`, undefined, 'stepGet'),
    );
    if (!detail.ok) {
      record.httpErrors.push({
        op: 'step',
        status: detail.status,
        code: errorCode(detail),
        message: errorMessage(detail),
      });
      record.stopReason = 'step_read_error';
      break;
    }
    const current = detail.body.step;
    session = detail.body.session;
    record.statusPath.push(session.status);

    // ── script 形態 verify の追撃実行（サーバ主導 / Migration 018）────────
    // 親ステップが done でも、サーバが確認用の追撃コマンドを積んでいる間は
    // セッションが executing のまま。追撃を実行し、完了するまで待つ。
    // ここを追わないと continue が STEP_NOT_CONTINUABLE になり「未終局」になる
    // （2026-10-26 の 1 ケース実測で確認）。
    let verifyFollowups = 0;
    let parentVerify = current.verifyResult;
    while (session.status === 'executing' && verifyFollowups < 3) {
      await runMockAgent(ctx.configPath, 'standard');
      await runMockAgent(ctx.configPath, 'admin');
      verifyFollowups += 1;
      await new Promise((resolve) => setTimeout(resolve, 400));
      const refreshed = track(
        await ctx.api.request('GET', `/api/resolve/steps/${step.id}`, undefined, 'stepGet'),
      );
      if (!refreshed.ok) break;
      session = refreshed.body.session;
      parentVerify = refreshed.body.step?.verifyResult ?? parentVerify;
      record.statusPath.push(session.status);
    }
    if (verifyFollowups > 0) record.verifyFollowups += verifyFollowups;

    record.steps.push({
      seq: current.seq,
      skillId: current.skillId,
      riskLevel: current.riskLevel,
      status: current.status,
      ok: current.resultSummary?.ok ?? null,
      verify: parentVerify ?? null,
      paramKeys: Object.keys(current.params ?? {}),
      executedBy: 'mock',
      latencyMs: Date.now() - stepStartedAt,
    });

    if (current.status === 'done') {
      // ── 結果後 Y（利用者の代わりに押す） ──
      const cont = track(
        await ctx.api.request(
          'POST',
          `/api/resolve/steps/${current.id}/continue`,
          { decision: 'Y' },
          'continue',
        ),
      );
      if (!cont.ok) {
        const code = errorCode(cont);
        const signal = {
          op: 'continue',
          status: cont.status,
          code,
          message: errorMessage(cont),
        };
        // STEP_LIMIT は設計どおりの停止（エラーではない）。それ以外は想定外として残す。
        if (EXPECTED_CONTROL_CODES.has(code)) record.controlSignals.push(signal);
        else record.httpErrors.push(signal);
        record.stopReason = continueStopReason(code);
        break;
      }
      session = cont.body.session;
      record.statusPath.push(session.status);
      // verify 成功によりループが止まった（提案を続けない）。利用者の判断待ち。
      if (cont.body.awaitingResolution === true) {
        record.awaitingResolution = true;
        record.stopReason = 'verified_awaiting_decision';
        break;
      }
      if (!cont.body.step) {
        record.stopReason = reasonFromContinue(cont.body.reason);
        break;
      }
      step = cont.body.step;
      record.proposals.push({
        seq: step.seq,
        skillId: step.skillId,
        riskLevel: step.riskLevel,
        paramKeys: Object.keys(step.params ?? {}),
      });
      continue;
    }

    if (current.status === 'failed') {
      record.stopReason = 'execution_failed';
      break;
    }
    if (current.status === 'cancelled') {
      record.stopReason = 'cancelled';
      break;
    }
    // approved / executing のまま = 端末結果が返っていない（権限差・mock 側の失敗など）
    record.stopReason = 'no_result';
    break;
  }

  if (!record.stopReason) record.stopReason = 'harness_step_guard';

  // 終局状態はサーバが決める。409 の応答本文には session が無いので、最後に読み直して確定させる。
  if (record.sessionId) {
    const latest = track(
      await ctx.api.request(
        'GET',
        `/api/resolve/sessions/${record.sessionId}`,
        undefined,
        'sessionGet',
      ),
    );
    if (latest.ok && latest.body?.session) {
      record.finalStatus = latest.body.session.status;
      record.statusPath.push(record.finalStatus);
    }
  }
  if (!record.finalStatus) record.finalStatus = session?.status ?? 'unknown';

  // 終局していないセッションは後始末してから次へ進む（queued のコマンドを持ち越さない）。
  // ただし「解決候補（利用者の判断待ち）」は後始末しない。停止させると判断待ちの状態が消える。
  if (
    record.sessionId &&
    !TERMINAL_STATUSES.has(record.finalStatus) &&
    !record.awaitingResolution
  ) {
    const observed = record.finalStatus;
    const stopped = track(
      await ctx.api.request('POST', `/api/resolve/sessions/${record.sessionId}/stop`, {}, 'stop'),
    );
    record.cleanup = { stopped: stopped.ok, observedStatus: observed };
  }

  return finishCase(record, startedAt);
}

/** 提案が AI 由来か fallback 由来かは監査ログにしか残らないため、あとから突き合わせる。 */
async function loadProposalSources(sql, sessionIds, sinceIso) {
  const map = new Map();
  if (sessionIds.length === 0) return map;
  const wanted = new Set(sessionIds);
  const rows = await sql`
    SELECT target_id, detail FROM audit_log
    WHERE action = 'resolution.proposed' AND created_at >= ${sinceIso}
  `;
  for (const row of rows) {
    if (!wanted.has(row.target_id)) continue;
    const detail = row.detail ?? {};
    if (!map.has(row.target_id)) map.set(row.target_id, new Map());
    map.get(row.target_id).set(Number(detail.seq), detail.source ?? null);
  }
  return map;
}

function aggregate(records, ctx) {
  const total = records.length;
  const allSteps = records.flatMap((record) => record.steps);
  const doneSteps = allSteps.filter((step) => step.status === 'done');
  const failedSteps = allSteps.filter((step) => step.status === 'failed');
  // boundary（2 つの KB にまたがる複合相談）は期待集合が広く当たりやすいので分母から外す。
  const judged = records.filter(
    (record) =>
      record.expectation.expectSkillIds.length > 0 && record.expectation.basis !== 'boundary',
  );
  const boundaryJudged = records.filter(
    (record) =>
      record.expectation.expectSkillIds.length > 0 && record.expectation.basis === 'boundary',
  );
  const matched = judged.filter((record) => record.selectionMatched === true);
  const firstMatched = judged.filter((record) => record.firstProposalMatched === true);
  const byBasis = {};
  for (const record of judged) {
    const basis = record.expectation.basis;
    byBasis[basis] ??= { judged: 0, matched: 0, firstMatched: 0 };
    byBasis[basis].judged += 1;
    if (record.selectionMatched === true) byBasis[basis].matched += 1;
    if (record.firstProposalMatched === true) byBasis[basis].firstMatched += 1;
  }
  const escalateExpected = records.filter(
    (record) => record.expectation.expectSkillIds.length === 0,
  );
  const boundary = records.filter((record) => record.expectation.basis === 'boundary');
  const changeSteps = allSteps.filter((step) => ctx.changeSkillIds.has(step.skillId));
  const readOnlySteps = allSteps.filter((step) => ctx.readOnlySkillIds.has(step.skillId));
  const terminal = records.filter((record) => TERMINAL_STATUSES.has(record.finalStatus));
  // 本人の「解決した」は代行しない（人の判断だから）。よって resolved は 0 件になる。
  // 代わりに「対処到達」= 変更系 Skill が 1 つ以上成功し、実行失敗が 0 件のケースを数える。
  // これは能力の指標であり、正しさ（期待 Skill を選んだか）は selection 側で測る。
  const treatmentReached = records.filter(
    (record) =>
      record.steps.some((step) => step.status === 'done' && ctx.changeSkillIds.has(step.skillId)) &&
      !record.steps.some((step) => step.status === 'failed'),
  );
  // 診断止まり = 手順はすべて読み取りで、変更系が 1 度も成功せず引き継ぎになったケース。
  const diagnosisOnly = records.filter(
    (record) =>
      record.steps.length > 0 &&
      record.steps.every(
        (step) => step.status === 'done' && ctx.readOnlySkillIds.has(step.skillId),
      ) &&
      record.finalStatus === 'escalated',
  );
  const latencies = records.map((record) => record.latencyMs).filter((v) => typeof v === 'number');
  const gateWaits = records.map((record) => record.gateWaitMs).filter((v) => typeof v === 'number');
  const requestTimes = records
    .map((record) => record.requestMs)
    .filter((v) => typeof v === 'number');
  const modes = { A: 0, B: 0, C: 0, D: 0, R: 0, U: 0 };
  for (const record of records) modes[record.mode] = (modes[record.mode] ?? 0) + 1;
  const resolutionCandidates = records.filter((record) => record.awaitingResolution === true);

  return {
    total,
    resolution: {
      definition:
        '対処到達 = 変更系（修復）Skill が 1 つ以上成功し、実行失敗が 0 件のケース。解決候補 = verify 成功でループが止まり利用者の判断待ちになったケース。本人確認の resolved は代行しないため別に数える。',
      resolvedByUser: records.filter((record) => record.finalStatus === 'resolved').length,
      reachedTreatment: treatmentReached.length,
      reachedTreatmentRate:
        total === 0 ? null : Number((treatmentReached.length / total).toFixed(4)),
      reachedResolutionCandidate: resolutionCandidates.length,
      reachedResolutionCandidateRate:
        total === 0 ? null : Number((resolutionCandidates.length / total).toFixed(4)),
      escalated: records.filter((record) => record.finalStatus === 'escalated').length,
      escalatedRate:
        total === 0
          ? null
          : Number(
              (
                records.filter((record) => record.finalStatus === 'escalated').length / total
              ).toFixed(4),
            ),
    },
    reachedTerminal: terminal.length,
    reachedTerminalRate: total === 0 ? null : Number((terminal.length / total).toFixed(4)),
    diagnosisOnly: diagnosisOnly.length,
    diagnosisOnlyRate: total === 0 ? null : Number((diagnosisOnly.length / total).toFixed(4)),
    finalStatusCounts: countBy(records, (record) => record.finalStatus),
    stopReasonCounts: countBy(records, (record) => record.stopReason),
    modes,
    selection: {
      judged: judged.length,
      matched: matched.length,
      accuracy: judged.length === 0 ? null : Number((matched.length / judged.length).toFixed(4)),
      // 「セッション中に一度でも当てたか」は最大 6 手まで試せるため甘い。
      // 最初の提案で当てたか（firstAccuracy）を厳しめの指標として併記する。
      firstMatched: firstMatched.length,
      firstAccuracy:
        judged.length === 0 ? null : Number((firstMatched.length / judged.length).toFixed(4)),
      byBasis,
      escalateExpected: escalateExpected.length,
      escalateExpectedButProposed: escalateExpected.filter((record) => record.proposals.length > 0)
        .length,
      boundary: boundary.length,
      boundaryJudged: boundaryJudged.length,
      boundaryMatched: boundaryJudged.filter((record) => record.selectionMatched === true).length,
      boundaryFirstMatched: boundaryJudged.filter((record) => record.firstProposalMatched === true)
        .length,
      mismatched: judged
        .filter((record) => record.selectionMatched !== true)
        .map((record) => ({
          id: record.id,
          expected: record.expectation.expectSkillIds,
          proposed: record.proposals.map((proposal) => proposal.skillId),
        })),
    },
    steps: {
      total: allSteps.length,
      done: doneSteps.length,
      failed: failedSteps.length,
      successRate:
        allSteps.length === 0 ? null : Number((doneSteps.length / allSteps.length).toFixed(4)),
      readOnly: readOnlySteps.length,
      change: changeSteps.length,
      changeDone: changeSteps.filter((step) => step.status === 'done').length,
      executedByMock: allSteps.filter((step) => step.executedBy === 'mock').length,
      // script 形態 verify の追撃実行（サーバ主導）の回数。
      verifyFollowups: records.reduce((total, record) => total + (record.verifyFollowups ?? 0), 0),
    },
    proposalSources: countBy(
      records.flatMap((record) => record.proposals),
      (proposal) => proposal.source,
    ),
    stepLatencyMs: {
      p50: percentile(
        allSteps.map((step) => step.latencyMs).filter((value) => typeof value === 'number'),
        50,
      ),
      p95: percentile(
        allSteps.map((step) => step.latencyMs).filter((value) => typeof value === 'number'),
        95,
      ),
      max: allSteps.length === 0 ? null : Math.max(...allSteps.map((step) => step.latencyMs ?? 0)),
    },
    // 1 ケースの内訳: gateWaitMs はハーネス側の待機（レート制御）、requestMs は HTTP 実処理の合計。
    gateWaitMs: {
      p50: percentile(gateWaits, 50),
      p95: percentile(gateWaits, 95),
      total: gateWaits.reduce((sum, value) => sum + value, 0),
    },
    requestMs: {
      p50: percentile(requestTimes, 50),
      p95: percentile(requestTimes, 95),
      total: requestTimes.reduce((sum, value) => sum + value, 0),
    },
    latencyMs: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      max: latencies.length === 0 ? null : Math.max(...latencies),
      mean:
        latencies.length === 0
          ? null
          : Number(
              (latencies.reduce((sum, value) => sum + value, 0) / latencies.length).toFixed(0),
            ),
    },
  };
}

function printDryRun(opts, cases, expectations) {
  console.log(`[dry-run] 接続先: ${opts.base}`);
  console.log(`[dry-run] ケース数: ${cases.length}`);
  console.log(
    '[dry-run] 端末実行は mock（scripts/endpoint-command-agent.mjs --mock）で代用します。',
  );
  console.log('[dry-run] 実行前 Y / 結果後 Y はハーネスが利用者に代わって押します。');
  const judged = cases.filter(
    (testCase) => (expectations.cases[testCase.id]?.expectSkillIds ?? []).length > 0,
  );
  console.log(`[dry-run] 期待 Skill が定義されたケース: ${judged.length}`);
  for (const testCase of cases.slice(0, 8)) {
    const expect = expectations.cases[testCase.id] ?? {};
    const expected =
      (expect.expectSkillIds ?? []).length > 0
        ? expect.expectSkillIds.join('|')
        : `引き継ぎ(${expect.basis ?? 'unknown'})`;
    console.log(`  - ${testCase.id} (${testCase.group}) → ${expected}`);
  }
  if (cases.length > 8) console.log(`  ... 他 ${cases.length - 8} 件`);
  console.log('[dry-run] 実行するには --execute を付けてください。');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]);
    return 0;
  }

  const target = new URL(opts.base);
  if (!isLoopbackHost(target.hostname) && !opts.allowRemote) {
    console.error(
      `拒否: ${target.hostname} は loopback ではありません。本番を誤って叩かないため停止します。`,
    );
    console.error('どうしても必要なら --allow-remote を明示してください（推奨しません）。');
    return 2;
  }
  if (opts.databaseUrl) {
    const name = databaseName(opts.databaseUrl);
    if (name !== DB_NAME_REQUIRED) {
      console.error(
        `拒否: DB 名が ${name} です。${DB_NAME_REQUIRED} 以外には接続しません（preview / 本番を守るため）。`,
      );
      return 2;
    }
  }

  const cases = loadCases(opts);
  const expectations = loadExpectations();
  const readOnlySkillIds = new Set(expectations.readOnlySkillIds ?? []);
  const changeSkillIds = new Set(expectations.changeSkillIds ?? []);

  if (!opts.execute) {
    printDryRun(opts, cases, expectations);
    return 0;
  }

  if (!opts.databaseUrl) {
    console.error('DATABASE_URL（または --database-url）が必要です。');
    return 2;
  }
  if (!opts.as) {
    console.error('--as（検証インスタンスの利用者メール）が必要です。');
    return 2;
  }

  const sql = postgres(opts.databaseUrl, { max: 2, onnotice: () => {} });
  const gate = createRateGate();
  const api = createApi(opts, gate);
  const tokens = loadOrCreateTokens();
  const configPath = path.join(os.tmpdir(), `aihd-loop-eval-agent-${process.pid}.json`);
  writeFileSync(
    configPath,
    JSON.stringify({
      url: opts.base,
      browserDeviceId: DEVICE_ID,
      deviceToken: tokens.standard,
      adminDeviceToken: tokens.admin,
    }),
    { mode: 0o600 },
  );
  chmodSync(configPath, 0o600);

  const runStartedAt = new Date();
  const records = [];
  try {
    // 事前準備
    const device = await prepareDevice(sql, opts.as, tokens);
    const resetCount = await resetPreviousRuns(sql, opts.as);
    if (resetCount > 0) {
      console.log(`前回の未終局セッションを ${resetCount} 件停止しました（EVAL- ケースのみ）。`);
    }
    const seeded = await seedCases(sql, opts.as, cases);
    if (seeded.estop) {
      console.error(
        '拒否: この利用者の緊急停止（estop）が ON です。解除してから実行してください（ハーネスは解除しません）。',
      );
      return 2;
    }
    const caseRows = await sql`
      SELECT (data #>> '{}')::jsonb -> 'cases' AS cases
      FROM prototype_states WHERE user_email = ${opts.as} AND name = 'cowork' LIMIT 1
    `;
    const storedIds = new Set((caseRows[0]?.cases ?? []).map((item) => String(item?.id ?? '')));
    const missing = cases.filter((testCase) => !storedIds.has(evalCaseId(testCase.id)));
    if (missing.length > 0) {
      throw new Error(`案件の投入に失敗しました（${missing.map((c) => c.id).join(',')}）`);
    }

    const catalog = await api.request('GET', '/api/resolve/skills', undefined, 'stepGet');
    if (!catalog.ok) {
      throw new Error(`GET /api/resolve/skills が HTTP ${catalog.status} を返しました`);
    }
    const catalogIds = (catalog.body?.skills ?? []).map((skill) => skill.id);

    console.log(`接続先: ${opts.base}`);
    console.log(`DB: ${DB_NAME_REQUIRED} / 端末: ${DEVICE_ID}`);
    console.log(`承認済み Skill: ${catalogIds.length} 件`);
    console.log(`ケース数: ${cases.length} / ケース間待機: ${opts.paceMs}ms`);
    console.log('端末実行: mock fixture（実機では実行していません）');
    console.log('承認: ハーネスが利用者に代わって Y を押します');
    console.log('');

    for (const [index, testCase] of cases.entries()) {
      if (index > 0 && opts.paceMs > 0) await sleep(opts.paceMs);
      let record;
      try {
        record = await runCase({ api, sql, expectations, device, configPath }, testCase);
      } catch (error) {
        record = {
          id: testCase.id,
          group: testCase.group,
          kbNo: expectations.cases[testCase.id]?.kbNo ?? null,
          caseId: evalCaseId(testCase.id),
          expectation: {
            basis: expectations.cases[testCase.id]?.basis ?? 'escalate',
            expectSkillIds: expectations.cases[testCase.id]?.expectSkillIds ?? [],
            escalateAcceptable: true,
          },
          sessionId: null,
          steps: [],
          proposals: [],
          statusPath: [],
          finalStatus: 'unknown',
          stopReason: 'harness_error',
          mode: 'U',
          selectionMatched: null,
          firstProposal: null,
          firstProposalMatched: null,
          httpErrors: [
            {
              op: 'harness',
              status: null,
              code: 'HARNESS_ERROR',
              message: String(error?.message ?? error).slice(0, 200),
            },
          ],
          controlSignals: [],
          cleanup: null,
          latencyMs: null,
          gateWaitMs: 0,
          requestMs: 0,
        };
      }
      records.push(record);
      const proposed = record.proposals.map((proposal) => proposal.skillId).join('>') || '-';
      console.log(
        `  [${index + 1}/${cases.length}] ${record.id} ${record.finalStatus}(${record.stopReason}) mode=${record.mode} 提案=${proposed} ${record.latencyMs ?? '-'}ms`,
      );
    }

    // 提案の出所（ai / fallback）を監査ログから補う。
    const sessionIds = records.map((record) => record.sessionId).filter(Boolean);
    const sources = await loadProposalSources(sql, sessionIds, runStartedAt.toISOString());
    for (const record of records) {
      const perSession = record.sessionId ? sources.get(record.sessionId) : null;
      if (!perSession) continue;
      for (const proposal of record.proposals) {
        proposal.source = perSession.get(Number(proposal.seq)) ?? 'unknown';
      }
    }
  } finally {
    // エージェント設定（トークン入り）は使い捨てる。トークン本体は TOKEN_FILE にだけ残す。
    try {
      if (existsSync(configPath)) unlinkSync(configPath);
    } catch {
      // 消せなくても 0600。処理は続ける。
    }
    try {
      await sql.end({ timeout: 5 });
    } catch {
      // 後始末の失敗は無視する。
    }
  }

  const summary = aggregate(records, { readOnlySkillIds, changeSkillIds });
  const finishedAt = new Date();
  const report = {
    harness: 'run-loop-eval',
    version: 1,
    path: 'loop',
    at: runStartedAt.toISOString(),
    base: opts.base,
    database: DB_NAME_REQUIRED,
    deviceId: DEVICE_ID,
    mock: true,
    mockNote:
      '端末実行は scripts/endpoint-command-agent.mjs --mock の fixture。実機での操作成立を示すものではない。',
    approval: {
      autoApproved: true,
      note: '実行前 Y / 結果後 Y は評価ハーネスが利用者の代わりに押している。本番の利用者判断ではない。',
      humanResolveSimulated: false,
      note2: '本人の「解決した」（resolved）は代行しないため resolved は 0 件になる。',
    },
    expectationsFile: 'scripts/eval/loop-expectations.json',
    startedAt: runStartedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - runStartedAt.getTime(),
    requestCount: api.requestCount,
    summary,
    cases: records,
  };

  console.log('');
  console.log('=== summary（解決ループ / 経路2） ===');
  console.log(
    `終局到達 ${summary.reachedTerminal}/${summary.total} (${((summary.reachedTerminalRate ?? 0) * 100).toFixed(1)}%)` +
      ` / 対処到達(変更系の成功) ${summary.resolution.reachedTreatment}/${summary.total}` +
      ` (${((summary.resolution.reachedTreatmentRate ?? 0) * 100).toFixed(1)}%)` +
      ` / 解決候補(verify成功・判断待ち) ${summary.resolution.reachedResolutionCandidate}/${summary.total}` +
      ` (${((summary.resolution.reachedResolutionCandidateRate ?? 0) * 100).toFixed(1)}%)` +
      ` / resolved(本人確認) ${summary.resolution.resolvedByUser}（代行しない）`,
  );
  console.log(
    `引継ぎ(escalated) ${summary.resolution.escalated}/${summary.total} (${((summary.resolution.escalatedRate ?? 0) * 100).toFixed(1)}%)`,
  );
  console.log(
    `停止理由: ${Object.entries(summary.stopReasonCounts)
      .map(([key, value]) => `${key}=${value}`)
      .join(' ')}`,
  );
  console.log(
    `最終状態: ${Object.entries(summary.finalStatusCounts)
      .map(([key, value]) => `${key}=${value}`)
      .join(' ')}`,
  );
  console.log(
    `モード: A(no_skill)=${summary.modes.A} B(誤選択)=${summary.modes.B} C(実行失敗)=${summary.modes.C} R(解決候補)=${summary.modes.R} D(引継ぎ)=${summary.modes.D} U(未終局)=${summary.modes.U}`,
  );
  console.log(
    `選択精度(どこかで一致): ${summary.selection.matched}/${summary.selection.judged} (${((summary.selection.accuracy ?? 0) * 100).toFixed(1)}%)` +
      ` / 初手一致: ${summary.selection.firstMatched}/${summary.selection.judged} (${((summary.selection.firstAccuracy ?? 0) * 100).toFixed(1)}%)`,
  );
  console.log(
    `  内訳 ${Object.entries(summary.selection.byBasis)
      .map(
        ([key, value]) =>
          `${key}=どこか${value.matched}/${value.judged}・初手${value.firstMatched}/${value.judged}`,
      )
      .join(' ')}`,
  );
  console.log(
    `  boundary(複合相談・参考) ${summary.selection.boundaryMatched}/${summary.selection.boundaryJudged}` +
      ` / 初手 ${summary.selection.boundaryFirstMatched}/${summary.selection.boundaryJudged}`,
  );
  console.log(
    `  引き継ぎ期待 ${summary.selection.escalateExpected} 件中、手順を提案したもの ${summary.selection.escalateExpectedButProposed} 件`,
  );
  console.log(
    `ステップ: 実行 ${summary.steps.total} / 成功 ${summary.steps.done} (${((summary.steps.successRate ?? 0) * 100).toFixed(1)}%)` +
      ` / 変更系 ${summary.steps.changeDone}/${summary.steps.change} / mock 実行 ${summary.steps.executedByMock}`,
  );
  console.log(
    `診断止まり: ${summary.diagnosisOnly}/${summary.total} (${((summary.diagnosisOnlyRate ?? 0) * 100).toFixed(1)}%)`,
  );
  console.log(
    `提案の出所: ${Object.entries(summary.proposalSources)
      .map(([key, value]) => `${key}=${value}`)
      .join(' ')}`,
  );
  console.log(
    `レイテンシ(1 ケース): p50=${summary.latencyMs.p50}ms p95=${summary.latencyMs.p95}ms max=${summary.latencyMs.max}ms mean=${summary.latencyMs.mean}ms`,
  );
  console.log(
    `レイテンシ(1 ステップ: 承認→結果反映→実行): p50=${summary.stepLatencyMs.p50}ms p95=${summary.stepLatencyMs.p95}ms max=${summary.stepLatencyMs.max}ms`,
  );
  console.log(
    `  内訳: HTTP 実処理の合計 p50=${summary.requestMs.p50}ms p95=${summary.requestMs.p95}ms` +
      ` / ハーネス待機（レート制御）p50=${summary.gateWaitMs.p50}ms p95=${summary.gateWaitMs.p95}ms` +
      ` 合計 ${(summary.gateWaitMs.total / 1000).toFixed(1)}s`,
  );
  console.log(
    `総所要: ${(report.durationMs / 1000).toFixed(1)}s / リクエスト ${report.requestCount} 回`,
  );
  console.log('※ 端末実行は mock fixture による模擬。承認 Y はハーネスによる代行。');

  const outPath = opts.out ?? path.join('/tmp', `aihd-loop-eval-${Date.now()}.json`);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`report: ${outPath}`);

  if (opts.failOnMiss) {
    const failedCases = records.filter((record) => record.httpErrors.length > 0);
    const misselected = summary.selection.judged - summary.selection.matched;
    if (failedCases.length > 0 || misselected > 0) return 4;
  }

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`ハーネスエラー: ${error.message}`);
    process.exit(3);
  });
