#!/usr/bin/env node
/**
 * 実端末コマンドエージェント（許可リストのみ）。
 *
 * サーバの /api/device/command をポーリングし、承認済みの操作だけを実行して
 * /api/device/command/:id/result へ結果を報告する。
 *
 * 使い方:
 *   node scripts/endpoint-command-agent.mjs --config ~/.config/ai-helpdesk/device-agent.json
 *   node scripts/endpoint-command-agent.mjs --once --dry-run
 *
 * 対応OS / 操作:
 *   - Windows: SPOOLER_RESTART（Restart-Service Spooler）
 *   - それ以外: 実行せず「未対応OS」として報告（Linux での動作確認用）
 *
 * 設定ファイルは endpoint-agent.mjs と同じものを使う（url / deviceToken /
 * cfAccessClientId / cfAccessClientSecret / proxySecret）。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = parseArgs(process.argv.slice(2));
const configPath =
  args.config ??
  process.env.AIHD_AGENT_CONFIG ??
  path.join(os.homedir(), '.config', 'ai-helpdesk', 'device-agent.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const baseUrl = (
  args.url ??
  process.env.AIHD_DEVICE_COMMAND_URL ??
  config.commandUrl ??
  String(config.url ?? '').replace(/\/api\/device\/agent\/?$/, '')
).replace(/\/$/, '');
const commandUrl = `${baseUrl}/api/device/command`;
const intervalSeconds = Number(args.interval ?? config.commandIntervalSeconds ?? 5);
const once = Boolean(args.once);
const dryRun = Boolean(args['dry-run']);

const headers = { Accept: 'application/json' };
if (config.deviceToken) headers['x-device-token'] = config.deviceToken;
if (config.cfAccessClientId) {
  headers['CF-Access-Client-Id'] = config.cfAccessClientId;
  headers['CF-Access-Client-Secret'] = config.cfAccessClientSecret;
}
if (config.proxySecret) headers['x-proxy-secret'] = config.proxySecret;
if (!config.deviceToken) {
  console.error('[command-agent] deviceToken が設定されていません。');
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (!current?.startsWith('--')) continue;
    const key = current.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function log(...parts) {
  console.log(new Date().toISOString(), ...parts);
}

function execute(command) {
  switch (command.op_id) {
    case 'SPOOLER_RESTART': {
      if (process.platform !== 'win32') {
        throw new Error('SPOOLER_RESTART は Windows のみ対応です（この端末では実行しません）');
      }
      execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', 'Restart-Service -Name Spooler -Force'],
        { timeout: 60_000, windowsHide: true },
      );
      return { opId: 'SPOOLER_RESTART', platform: 'win32', executedAt: new Date().toISOString() };
    }
    default:
      throw new Error(`未対応の操作です: ${command.op_id}`);
  }
}

async function fetchCommand() {
  const res = await fetch(commandUrl, { headers });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`コマンド取得に失敗しました: HTTP ${res.status}`);
  const body = await res.json();
  return body.command ?? null;
}

async function reportResult(id, outcome) {
  const res = await fetch(`${commandUrl}/${id}/result`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(outcome),
  });
  if (!res.ok) throw new Error(`結果報告に失敗しました: HTTP ${res.status}`);
}

async function tick() {
  const command = await fetchCommand();
  if (!command) return;
  log('command', command.id, command.op_id, dryRun ? '(dry-run)' : '');
  if (dryRun) {
    log('dry-run: 実行せずに終了します');
    return;
  }
  try {
    const result = execute(command);
    await reportResult(command.id, { ok: true, result });
    log('done', command.id);
  } catch (error) {
    await reportResult(command.id, { ok: false, error: String(error?.message ?? error) });
    log('failed', command.id, String(error?.message ?? error));
  }
}

async function main() {
  log('command-agent start', { commandUrl, intervalSeconds });
  do {
    try {
      await tick();
    } catch (error) {
      log('poll error', String(error?.message ?? error));
    }
    if (once) break;
    await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000));
  } while (true);
}

main().catch((error) => {
  console.error('[command-agent]', error);
  process.exit(1);
});
