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
 *   node scripts/endpoint-command-agent.mjs --once --mock --config /tmp/device-agent.json
 *
 * 対応OS / 操作:
 *   - Windows: SPOOLER_RESTART（Restart-Service Spooler）
 *   - それ以外: 実行せず「未対応OS」として報告（Linux での動作確認用）
 *
 * Skill 実行（Phase B / 読み取り専用）:
 *   command に skill_id / skill_version がある場合だけ、リポジトリ内の許可済み
 *   PowerShell スクリプト（scripts/skills/windows/）を引数配列で実行する。
 *   - Windows: powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass
 *               -File <script> [args...]（シェル文字列連結はしない）
 *   - Windows 以外 / --mock: skill ごとの固定 fixture を返す（Linux での PoC 用）。
 *   - タイムアウト 60 秒、stdout/stderr は 64KB で打ち切り、報告は最大 2,000 字。
 *   - config.browserDeviceId を x-device-id ヘッダで送り、サーバが
 *     command.device_id と照合できるようにする。
 *   - 既存の SPOOLER_RESTART と --dry-run の挙動は変更しない。
 *
 * 設定ファイルは endpoint-agent.mjs と同じものを使う（url / deviceToken /
 * browserDeviceId / cfAccessClientId / cfAccessClientSecret / proxySecret）。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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
// --mock を付けた場合、または Windows 以外では PowerShell を実行せず fixture を返す。
const mockMode = Boolean(args.mock) || process.platform !== 'win32';

// 端末識別: サーバ側の command.device_id（= ブラウザ端末 ID）と照合する。
const deviceIdHeader =
  typeof config.browserDeviceId === 'string' && config.browserDeviceId.trim() !== ''
    ? config.browserDeviceId.trim()
    : undefined;
const reportedDeviceId =
  deviceIdHeader ?? (config.deviceId ? String(config.deviceId) : os.hostname());

const headers = { Accept: 'application/json' };
if (config.deviceToken) headers['x-device-token'] = config.deviceToken;
if (deviceIdHeader) headers['x-device-id'] = deviceIdHeader;
if (config.cfAccessClientId) {
  headers['CF-Access-Client-Id'] = config.cfAccessClientId;
  headers['CF-Access-Client-Secret'] = config.cfAccessClientSecret;
}
if (config.proxySecret) headers['x-proxy-secret'] = config.proxySecret;
if (!config.deviceToken) {
  console.error('[command-agent] deviceToken が設定されていません。');
  process.exit(1);
}

// ── Skill 定義（許可リスト） ──────────────────────────────────────────
// skill_id → リポジトリ同梱の読み取り専用スクリプト。ここに無い skill_id は実行しない。
const SKILLS_DIR = path.join(import.meta.dirname, 'skills', 'windows');
const SKILL_TIMEOUT_MS = 60_000;
const OUTPUT_LIMIT_BYTES = 64 * 1024;
const SUMMARY_LIMIT_CHARS = 2_000;
const SERVICE_NAMES = Object.freeze(['Spooler', 'W32Time', 'Winmgmt']);

const SKILL_SCRIPTS = new Map([
  ['os.info', { file: 'os-info.ps1', buildArgs: () => [] }],
  ['disk.space', { file: 'disk-space.ps1', buildArgs: () => [] }],
  ['spooler.status', { file: 'spooler-status.ps1', buildArgs: () => [] }],
  [
    'service.status',
    {
      file: 'service-status.ps1',
      buildArgs: (params) => ['-Service', requireAllowedService(params)],
    },
  ],
  ['network.adapters', { file: 'network-adapters.ps1', buildArgs: () => [] }],
]);

// ── mock fixture（Windows 以外 / --mock 用・PII なし） ─────────────────
const MOCK_FIXTURES = Object.freeze({
  'os.info': Object.freeze({
    osName: 'Microsoft Windows 11 Pro',
    version: '10.0.22631',
    buildNumber: '22631',
    architecture: '64-bit',
    computerName: 'PC-HELPDESK-01',
  }),
  'disk.space': Object.freeze({
    volumes: [
      { deviceId: 'C:', freeGB: 118.42, totalGB: 475.9 },
      { deviceId: 'D:', freeGB: 812.65, totalGB: 953.67 },
    ],
  }),
  'spooler.status': Object.freeze({
    name: 'Spooler',
    displayName: 'Print Spooler',
    status: 'Running',
    startType: 'Auto',
  }),
  'network.adapters': Object.freeze({
    adapters: [
      {
        name: 'Ethernet',
        status: 'Up',
        linkSpeed: '1 Gbps',
        interfaceDescription: 'Intel(R) Ethernet Connection I219-LM',
      },
      {
        name: 'Wi-Fi',
        status: 'Disconnected',
        linkSpeed: '866 Mbps',
        interfaceDescription: 'Intel(R) Wi-Fi 6 AX201 160MHz',
      },
    ],
  }),
});

const MOCK_SERVICES = Object.freeze({
  Spooler: Object.freeze({
    name: 'Spooler',
    displayName: 'Print Spooler',
    status: 'Running',
    startType: 'Auto',
  }),
  W32Time: Object.freeze({
    name: 'W32Time',
    displayName: 'Windows Time',
    status: 'Running',
    startType: 'Manual',
  }),
  Winmgmt: Object.freeze({
    name: 'Winmgmt',
    displayName: 'Windows Management Instrumentation',
    status: 'Running',
    startType: 'Auto',
  }),
});

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

function truncate(text, limit) {
  const value = String(text ?? '');
  return value.length <= limit ? value : value.slice(0, limit);
}

function truncateBytes(text, maxBytes) {
  const value = String(text ?? '');
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  return Buffer.from(value, 'utf8').subarray(0, maxBytes).toString('utf8');
}

function asParams(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

/** service.status の対象サービスを許可リストで検証する（agent 側でも多層防御）。 */
function requireAllowedService(params) {
  const raw = params?.service;
  const service = typeof raw === 'string' ? raw.trim() : '';
  if (!SERVICE_NAMES.includes(service)) {
    throw new Error(
      `service.status の service が許可されていません: ${service === '' ? '(empty)' : service}`,
    );
  }
  return service;
}

const APPROVAL_MANIFEST = path.join(import.meta.dirname, 'skills', 'approved.json');

/**
 * サーバが承認した Skill 定義（id@version / contentHash / scriptHash）を読む。
 * 端末側でも manifest とローカルスクリプトの SHA-256 を照合し、
 * 一致しない Skill は実行しない（サーバ侵害時の多層防御）。
 */
function loadApprovalManifest() {
  try {
    if (!existsSync(APPROVAL_MANIFEST)) return new Map();
    const parsed = JSON.parse(readFileSync(APPROVAL_MANIFEST, 'utf8'));
    const entries = Array.isArray(parsed?.skills) ? parsed.skills : [];
    return new Map(entries.map((entry) => [`${entry.id}@${entry.version}`, entry]));
  } catch (error) {
    log('approval manifest read failed', String(error.message || error));
    return new Map();
  }
}

const APPROVED_SKILLS = loadApprovalManifest();

function scriptSha256(skillId) {
  const entry = SKILL_SCRIPTS.get(skillId);
  if (!entry) return null;
  const scriptPath = path.join(SKILLS_DIR, entry.file);
  if (!existsSync(scriptPath)) return null;
  return `sha256:${createHash('sha256').update(readFileSync(scriptPath)).digest('hex')}`;
}

function verifySkillApproval(command) {
  const skillId = String(command.skill_id || '');
  const version = String(command.skill_version || '');
  const key = `${skillId}@${version}`;
  const approved = APPROVED_SKILLS.get(key);
  if (!approved) throw new Error(`承認されていない Skill です: ${key}`);
  if (command.skill_content_hash && approved.contentHash !== command.skill_content_hash) {
    throw new Error(`Skill 定義のハッシュが一致しません: ${key}`);
  }
  const localHash = scriptSha256(skillId);
  if (!localHash || approved.scriptHash !== localHash) {
    throw new Error(`Skill スクリプトのハッシュが一致しません: ${key}`);
  }
}

/** mock モード: skill ごとの固定 JSON を返す（実行なし）。 */
function runMockSkill(skillId, params) {
  const startedAt = Date.now();
  let normalized;

  if (skillId === 'service.status') {
    const service = requireAllowedService(params);
    normalized = { ...MOCK_SERVICES[service] };
  } else {
    const fixture = MOCK_FIXTURES[skillId];
    if (!fixture) throw new Error(`未対応の Skill です: ${skillId}`);
    normalized = structuredClone(fixture);
  }

  return {
    normalized,
    stdoutSummary: truncate(JSON.stringify(normalized), SUMMARY_LIMIT_CHARS),
    stderrSummary: '',
    exitCode: 0,
    durationMs: Math.max(1, Date.now() - startedAt),
  };
}

/** 実実行: 許可済み PowerShell スクリプトを引数配列で実行する（シェル文字列連結なし）。 */
function runPowerShellSkill(skillId, params) {
  const entry = SKILL_SCRIPTS.get(skillId);
  if (!entry) throw new Error(`未対応の Skill です: ${skillId}`);

  const scriptPath = path.join(SKILLS_DIR, entry.file);
  if (!existsSync(scriptPath)) {
    throw new Error(`Skill スクリプトが見つかりません: ${entry.file}`);
  }
  const skillArgs = entry.buildArgs(params);

  const startedAt = Date.now();
  const child = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      ...skillArgs,
    ],
    {
      encoding: 'utf8',
      timeout: SKILL_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    },
  );
  const durationMs = Date.now() - startedAt;
  const stdout = truncateBytes(String(child.stdout ?? ''), OUTPUT_LIMIT_BYTES);
  const stderr = truncateBytes(String(child.stderr ?? ''), OUTPUT_LIMIT_BYTES);

  if (child.error) {
    if (child.error.code === 'ETIMEDOUT') {
      throw new Error(`Skill の実行がタイムアウトしました（${skillId}, ${SKILL_TIMEOUT_MS}ms）`);
    }
    throw new Error(
      `Skill の実行に失敗しました（${skillId}）: ${truncate(
        String(child.error.message ?? child.error),
        500,
      )}`,
    );
  }
  if (child.status !== 0) {
    throw new Error(
      `Skill が終了コード ${String(child.status)} で失敗しました（${skillId}）: ${truncate(
        stderr.trim(),
        500,
      )}`,
    );
  }

  let normalized;
  try {
    normalized = JSON.parse(stdout.trim());
  } catch {
    throw new Error(`Skill の出力を JSON として解析できませんでした（${skillId}）`);
  }
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) {
    throw new Error(`Skill の出力が JSON オブジェクトではありません（${skillId}）`);
  }

  return {
    normalized,
    stdoutSummary: truncate(stdout.trim(), SUMMARY_LIMIT_CHARS),
    stderrSummary: truncate(stderr.trim(), SUMMARY_LIMIT_CHARS),
    exitCode: child.status ?? 0,
    durationMs,
  };
}

/** skill_id 付き command の実行。結果は §8-3 の報告形に合わせる。 */
function executeSkill(command) {
  verifySkillApproval(command);
  const skillId = String(command.skill_id);
  const params = asParams(command.params);
  log('skill', command.id, skillId, command.skill_version ?? '-', mockMode ? '(mock)' : '');

  const output = mockMode ? runMockSkill(skillId, params) : runPowerShellSkill(skillId, params);
  return {
    normalized: output.normalized,
    stdoutSummary: truncate(output.stdoutSummary, SUMMARY_LIMIT_CHARS),
    stderrSummary: truncate(output.stderrSummary, SUMMARY_LIMIT_CHARS),
    exitCode: output.exitCode,
    durationMs: output.durationMs,
    deviceId: reportedDeviceId,
  };
}

function execute(command) {
  // 既存の SPOOLER_RESTART 等（skill_id なし）は従来経路のまま。
  if (command.skill_id) return executeSkill(command);

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
    const message = truncate(String(error?.message ?? error), SUMMARY_LIMIT_CHARS);
    await reportResult(command.id, { ok: false, error: message });
    log('failed', command.id, message);
  }
}

async function main() {
  log('command-agent start', { commandUrl, intervalSeconds, mock: mockMode });
  if (!deviceIdHeader) {
    log('警告: config.browserDeviceId が未設定のため x-device-id を送りません');
  }
  for (;;) {
    try {
      await tick();
    } catch (error) {
      log('poll error', String(error?.message ?? error));
    }
    if (once) break;
    await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000));
  }
}

main().catch((error) => {
  console.error('[command-agent]', error);
  process.exit(1);
});
