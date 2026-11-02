#!/usr/bin/env node
/**
 * command-agent.ps1 を実 API と結合して、配信から結果の保存までを確かめる（Linux の pwsh）。
 *
 * 検証専用。本番・Preview・実端末・RSP・Mesh には触れない。
 * - DB 名が `_e2e` で終わらなければ起動しない。
 * - Skill のスクリプトは Linux で実行できないので、一時フォルダのスタブ（模擬）にする。
 *   結果は実端末の結果ではなく、エージェントは Windows 以外で executionSource=mock と申告する。
 * - 本物の Skill、Windows PowerShell 5.1、endpoint_agent の申告はここでは通らない。
 *
 * 使い方: FLOW_E2E_DB_URL=... FLOW_E2E_OUT=<dir> node scripts/e2e/command-agent-ps1.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import postgres from 'postgres';

const dbUrl = process.env.FLOW_E2E_DB_URL ?? '';
const dbName = (() => {
  try {
    return new URL(dbUrl).pathname.slice(1);
  } catch {
    return '';
  }
})();
if (!/_e2e$/.test(dbName) || process.env.NODE_ENV === 'production') {
  console.error('FLOW_E2E_DB_URL の DB 名は _e2e で終わる必要があります。');
  process.exit(2);
}

const root = path.resolve(import.meta.dirname, '..', '..');
const outDir = path.resolve(process.env.FLOW_E2E_OUT ?? path.join(root, '.e2e-out'));
mkdirSync(outDir, { recursive: true });
const tmp = mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'ps1-agent-'));
const EMAIL = 'synth.ps1-agent@example.test';
const DEVICE = 'ps1-agent-device-0001';
const CASE_ID = 'CASE-PS1-AGENT';
const PORTS = { dev: 19411, prod: 19412 };
const sql = postgres(dbUrl, { max: 2, onnotice: () => {} });
const checks = [];
const children = [];

function check(id, title, ok, note = '') {
  checks.push({ id, title, ok: Boolean(ok), note: String(note).slice(0, 300) });
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${id} ${title}${note ? ` (${String(note).slice(0, 200)})` : ''}`,
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (data) => `sha256:${createHash('sha256').update(data).digest('hex')}`;

function runScript(script, env) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', script], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`${script} failed: ${result.stderr.slice(-400)}`);
}

async function startApi(name, env) {
  const log = openSync(path.join(tmp, `api-${name}.log`), 'a');
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/api/src/index.ts'], {
    cwd: root,
    detached: true,
    stdio: ['ignore', log, log],
    env: {
      ...process.env,
      PORT: String(PORTS[name]),
      HOST: '127.0.0.1',
      DATABASE_URL: dbUrl,
      MIRAI_INFO_DATABASE_URL: dbUrl,
      SESSION_SECRET: randomBytes(32).toString('hex'),
      MAIL_TRANSPORT: 'disabled',
      LOG_LEVEL: 'warn',
      ...env,
    },
  });
  children.push(child);
  const base = `http://127.0.0.1:${PORTS[name]}`;
  for (let i = 0; i < 120; i += 1) {
    try {
      const body = await (await fetch(`${base}/api/health`)).json();
      if (body.service === 'ai-helpdesk-api' && body.env === env.NODE_ENV) return base;
    } catch {
      // 起動を待つ。
    }
    await sleep(250);
  }
  throw new Error(
    `health ${name}: ${readFileSync(path.join(tmp, `api-${name}.log`), 'utf8').slice(-400)}`,
  );
}

/** 本番と同じ配置を一時フォルダへ作る。Skill はスタブ（模擬）。 */
function layout(contentHash, version) {
  const dir = path.join(tmp, 'agent');
  const skills = path.join(dir, 'scripts', 'skills', 'windows');
  mkdirSync(path.join(dir, 'scripts', 'windows'), { recursive: true });
  mkdirSync(skills, { recursive: true });
  const agentPath = path.join(dir, 'scripts', 'windows', 'command-agent.ps1');
  copyFileSync(path.join(root, 'scripts', 'windows', 'command-agent.ps1'), agentPath);
  const stub = `Write-Output '{"name":"Spooler","displayName":"Print Spooler","status":"Running","startType":"Auto","stub":"模擬（Linux のスタブ）"}'\n`;
  writeFileSync(path.join(skills, 'spooler-status.ps1'), stub);
  writeFileSync(
    path.join(dir, 'scripts', 'skills', 'approved.json'),
    JSON.stringify({
      version: 1,
      skills: [{ id: 'spooler.status', version, contentHash, scriptHash: sha256(stub) }],
    }),
  );
  return agentPath;
}

function runAgent(agentPath, base, token) {
  const config = path.join(tmp, 'config.json');
  rmSync(config, { force: true });
  writeFileSync(
    config,
    JSON.stringify({
      url: `${base}/api/device/agent`,
      deviceToken: token,
      browserDeviceId: DEVICE,
    }),
  );
  chmodSync(config, 0o600);
  const result = spawnSync(
    'pwsh',
    ['-NoProfile', '-NonInteractive', '-File', agentPath, '-Once', '-ConfigPath', config],
    { encoding: 'utf8', timeout: 90_000 },
  );
  return { status: result.status, log: `${result.stdout}${result.stderr}` };
}

const stable = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
    .join(',')}}`;
};

async function main() {
  const env = {
    NODE_ENV: 'development',
    DATABASE_URL: dbUrl,
    SEED_PASSWORD: randomBytes(12).toString('hex'),
    SESSION_SECRET: randomBytes(32).toString('hex'),
  };
  runScript('scripts/migrate.ts', env);
  runScript('scripts/seed.ts', env);
  await sql`DELETE FROM device_commands WHERE user_email = ${EMAIL}`;
  await sql`DELETE FROM resolution_sessions WHERE user_email = ${EMAIL}`;
  await sql`DELETE FROM device_tokens WHERE user_email = ${EMAIL}`;
  await sql`DELETE FROM device_inventories WHERE user_email = ${EMAIL}`;

  const token = `aihd_${randomBytes(24).toString('hex')}`;
  await sql`
    INSERT INTO device_tokens (token_hash, user_email, label, device_id, last_used_at, privilege)
    VALUES (${createHash('sha256').update(token).digest('hex')}, ${EMAIL}, 'ps1-agent-e2e',
      ${DEVICE}, now(), 'standard')
  `;
  await sql`
    INSERT INTO device_inventories (user_email, source, device_id, data)
    VALUES (${EMAIL}, 'browser', ${DEVICE}, '{}'::jsonb)
  `;

  const dev = await startApi('dev', {
    NODE_ENV: 'development',
    AUTH_MODE: 'local',
    DEV_AUTH_EMAIL: EMAIL,
  });
  const api = async (method, url, body) => {
    const response = await fetch(`${dev}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  // 1. 実 API の経路: 案件 → セッション → 本人 Y → 配信 → 実行（スタブ）→ 結果の保存。
  const saved = await api('PUT', '/api/state/cowork', {
    data: {
      v: 31,
      cases: [
        { id: CASE_ID, userId: 'u1', subject: '印刷できない', body: 'プリンタで印刷できない' },
      ],
    },
  });
  check('P0', '案件を状態へ保存する', saved.status === 200, saved.status);
  const started = await api('POST', '/api/resolve/sessions', { caseId: CASE_ID, deviceId: DEVICE });
  check(
    'P1',
    '解決ループが spooler.status を提案する',
    started.status === 200 && started.body?.step?.skill?.id === 'spooler.status',
    `${started.status} ${started.body?.step?.skillId ?? ''}`,
  );
  const step = started.body.step;
  const version = step.skill.version;
  const contentHash = step.skill.contentHash;
  const agentPath = layout(contentHash, version);
  const approvalHash = createHash('sha256')
    .update(stable(step.approvalChallenge.payload))
    .digest('hex');
  const approved = await api('POST', `/api/resolve/steps/${step.id}/approve`, {
    decision: 'Y',
    approvalHash,
  });
  const commandId = approved.body?.command?.id;
  check(
    'P2',
    '本人の Y でコマンドが作られる',
    approved.status === 200 && commandId,
    approved.status,
  );

  const first = runAgent(agentPath, dev, token);
  check('P3', 'エージェントが正常に終了する', first.status === 0, first.log.slice(-300));
  check('P4', 'ログにトークンを出さない', !first.log.includes(token));
  const [row] = await sql`
    SELECT status, device_id, delivered_at, completed_at, result, error
    FROM device_commands WHERE id = ${commandId}
  `;
  check(
    'P5',
    'コマンドが done で保存される',
    row.status === 'done',
    `${row.status} ${row.error ?? ''}`,
  );
  check('P6', '端末 ID が一致する（x-device-id）', row.device_id === DEVICE, row.device_id);
  check('P7', '配信と完了の時刻が残る', Boolean(row.delivered_at && row.completed_at));
  check(
    'P8',
    '出所は mock（Linux のスタブを実端末と申告しない）',
    row.result?.executionSource === 'mock',
    row.result?.executionSource,
  );
  check('P9', 'スタブの結果が保存される', row.result?.normalized?.status === 'Running');
  const reread = await api('GET', `/api/resolve/steps/${step.id}`);
  check(
    'P10',
    'ステップの API に結果と出所が出る',
    reread.body?.step?.status === 'done' && reread.body?.step?.executionSource === 'mock',
    `${reread.body?.step?.status}/${reread.body?.step?.executionSource}`,
  );
  const [sessionRow] =
    await sql`SELECT status FROM resolution_sessions WHERE id = ${started.body.session.id}`;
  check(
    'P11',
    '読取成功だけで解決にしない',
    sessionRow.status === 'waiting_continue',
    sessionRow.status,
  );

  // 2. 定義のハッシュが違うコマンドは、実 API に失敗として残る。
  const [badHash] = await sql`
    INSERT INTO device_commands (user_email, device_id, op_id, params, skill_id, skill_version, skill_content_hash)
    VALUES (${EMAIL}, ${DEVICE}, 'spooler.status', '{}'::jsonb, 'spooler.status', ${version},
      ${`sha256:${'d'.repeat(64)}`})
    RETURNING id
  `;
  const second = runAgent(agentPath, dev, token);
  const [badRow] =
    await sql`SELECT status, error, result FROM device_commands WHERE id = ${badHash.id}`;
  check(
    'P12',
    '定義のハッシュが違えば実行せず failed で保存される',
    badRow.status === 'failed' && /ハッシュ/.test(badRow.error ?? '') && badRow.result === null,
    `${badRow.status} ${second.status}`,
  );

  // 3. 本番モードのサーバは、このエージェントの mock の申告を受け付けない。
  const allowlist = path.join(tmp, 'allow.txt');
  writeFileSync(allowlist, `${EMAIL}\n`);
  const prod = await startApi('prod', {
    NODE_ENV: 'production',
    AUTH_MODE: 'cloudflare-access',
    ACCESS_ALLOWLIST_FILE: allowlist,
  });
  const [prodCommand] = await sql`
    INSERT INTO device_commands (user_email, device_id, op_id, params, skill_id, skill_version, skill_content_hash)
    VALUES (${EMAIL}, ${DEVICE}, 'spooler.status', '{}'::jsonb, 'spooler.status', ${version}, ${contentHash})
    RETURNING id
  `;
  const third = runAgent(agentPath, prod, token);
  const [prodRow] =
    await sql`SELECT status, result, error FROM device_commands WHERE id = ${prodCommand.id}`;
  check(
    'P13',
    '本番モード: mock の申告は保存されない（failed、結果なし）',
    prodRow.status === 'failed' && prodRow.result === null,
    `${prodRow.status} ${prodRow.error ?? ''}`,
  );
  check('P14', '本番モードの拒否でもログにトークンを出さない', !third.log.includes(token));

  writeFileSync(
    path.join(outDir, 'result.json'),
    `${JSON.stringify(
      {
        scope:
          'Linux の pwsh と実 API の結合。Skill はスタブ（模擬）で実端末の結果ではない。Windows PowerShell 5.1、本物の Skill、endpoint_agent の申告は未確認。認証は AUTH_MODE=local、名簿は使っていない。',
        pwsh: spawnSync(
          'pwsh',
          ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'],
          {
            encoding: 'utf8',
          },
        ).stdout.trim(),
        checks,
        ids: { caseId: CASE_ID, stepId: step.id, commandId, device: DEVICE },
        savedResult: { ...row.result, deviceId: DEVICE },
      },
      null,
      2,
    )}\n`,
  );
}

let exitCode = 0;
try {
  await main();
  if (checks.some((item) => !item.ok)) exitCode = 1;
} catch (error) {
  exitCode = 1;
  console.error(String(error?.stack ?? error).slice(0, 1500));
} finally {
  for (const child of children) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // すでに終了している。
    }
  }
  await sql.end({ timeout: 5 }).catch(() => {});
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`checks=${checks.length} failed=${checks.filter((item) => !item.ok).length}`);
process.exit(exitCode);
