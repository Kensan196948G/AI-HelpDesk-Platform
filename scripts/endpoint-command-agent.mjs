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
 * Skill 実行（Phase B 読み取り 5 件 / Phase 2 修復 7 件 / Phase 7 修復 4 件）:
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
 * 権限区分（AIHD_AGENT_PRIVILEGE / 既定 standard。docs/25 §12・§17-2）:
 *   - standard: 従来どおり。`config.deviceToken` を使い、昇格不要のコマンドだけを受け取る。
 *   - admin   : 昇格必須の Skill（ELEVATED_SKILL_IDS）だけを実行できる。`config.adminDeviceToken`
 *               （standard とは別トークン）が必須で、無ければ起動しない。許可リスト外の
 *               skill_id・skill_id なしのコマンドは「未知の Skill」として拒否する（二重防御）。
 *   - 分離の本体はサーバ側（device_tokens.privilege）で強制する。ここは
 *     設定ミスやサーバ侵害時に余計なコマンドを実行しないための二重防御であり、
 *     単独で信頼してはならない。昇格していないプロセスでは .ps1 が exit 3 で拒否する。
 *
 * fail-closed:
 *   - SKILL_SCRIPTS に無い skill_id は実行しない（未知 Skill を拒否）。
 *   - 人間が承認した scripts/skills/approved.json と id@version / contentHash /
 *     scriptHash が一致しない Skill も実行しない（承認は人間の Gate）。
 *   - Phase 2 / Phase 7 の修復 Skill は、人間が承認するまで manifest に無いため拒否される（仕様）。
 *   - パラメータは params を agent 側でも再検証し、許可値・整数範囲だけを引数にする。
 *   - 注意: 本ファイルの実行検証は Windows 実機が無いため未実施（静的な契約検証のみ）。
 *
 * 設定ファイルは endpoint-agent.mjs と同じものを使う（url / deviceToken /
 * browserDeviceId / cfAccessClientId / cfAccessClientSecret / proxySecret）。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

// ── 権限区分（既定 standard） ────────────────────────────────────────
// サーバ側 device_tokens.privilege と対になる。admin は昇格必須 Skill だけを実行する。
const AGENT_PRIVILEGES = Object.freeze(['standard', 'admin']);
// 昇格必須（skills.requires.elevation = true）の Skill。admin の許可リストはこれだけ。
// カタログ側の elevation:true と過不足なく一致させる（privilege.test.mjs が突き合わせる）。
const ELEVATED_SKILL_IDS = Object.freeze([
  'spooler.restart',
  'spooler.queue.purge',
  'service.start',
  'service.restart',
  'network.adapter.restart',
  'defender.update',
  'bitlocker.status',
  'defender.quickscan',
]);

function resolveAgentPrivilege() {
  const raw = args.privilege ?? process.env.AIHD_AGENT_PRIVILEGE ?? config.agentPrivilege;
  if (raw === undefined || raw === null || raw === '') return 'standard';
  const value = String(raw).trim().toLowerCase();
  if (!AGENT_PRIVILEGES.includes(value)) {
    console.error(
      `[command-agent] AIHD_AGENT_PRIVILEGE が不正です: ${value}（standard / admin のいずれか）`,
    );
    process.exit(1);
  }
  return value;
}

const agentPrivilege = resolveAgentPrivilege();
const isAdminAgent = agentPrivilege === 'admin';

// 端末識別: サーバ側の command.device_id（= ブラウザ端末 ID）と照合する。
const deviceIdHeader =
  typeof config.browserDeviceId === 'string' && config.browserDeviceId.trim() !== ''
    ? config.browserDeviceId.trim()
    : undefined;
const reportedDeviceId =
  deviceIdHeader ?? (config.deviceId ? String(config.deviceId) : os.hostname());

// トークンは権限ごとに分ける（standard と admin で別トークン・別サービス）。
const deviceToken = isAdminAgent ? config.adminDeviceToken : config.deviceToken;

const headers = { Accept: 'application/json' };
if (deviceToken) headers['x-device-token'] = deviceToken;
if (deviceIdHeader) headers['x-device-id'] = deviceIdHeader;
if (config.cfAccessClientId) {
  headers['CF-Access-Client-Id'] = config.cfAccessClientId;
  headers['CF-Access-Client-Secret'] = config.cfAccessClientSecret;
}
if (config.proxySecret) headers['x-proxy-secret'] = config.proxySecret;
if (!deviceToken) {
  console.error(
    isAdminAgent
      ? '[command-agent] admin エージェントには adminDeviceToken が必要です（standard とは別トークン）。'
      : '[command-agent] deviceToken が設定されていません。',
  );
  process.exit(1);
}
// 同じトークンを使い回すと、サーバ側では standard と判定され admin コマンドが
// 一切配信されない（設定ミスに気づかないまま機能が死ぬ）。起動時に拒否する。
if (isAdminAgent && config.deviceToken && config.deviceToken === config.adminDeviceToken) {
  console.error(
    '[command-agent] adminDeviceToken が deviceToken と同じです。別トークンを発行してください。',
  );
  process.exit(1);
}

// ── Skill 定義（許可リスト） ──────────────────────────────────────────
// skill_id → リポジトリ同梱のスクリプト。ここに無い skill_id は実行しない。
// buildArgs は「型付きパラメータ → 引数配列」の唯一の変換点であり、
// 許可リスト・整数範囲の検証もここで行う（シェル文字列は組み立てない）。
const SKILLS_DIR = path.join(import.meta.dirname, 'skills', 'windows');
// 端末エージェントの実行タイムアウト。Skill 定義の timeoutSec はこれを超えない
// （超えるとサーバ側の期限より先に agent が打ち切り、結果が返らなくなる）。
const SKILL_TIMEOUT_MS = 60_000;
const OUTPUT_LIMIT_BYTES = 64 * 1024;
const SUMMARY_LIMIT_CHARS = 2_000;
const SERVICE_NAMES = Object.freeze(['Spooler', 'W32Time', 'Winmgmt']);
const SERVICE_START_NAMES = Object.freeze(['Spooler', 'W32Time']);
// service.restart も service.start と同じ許可リスト（対象は増やさない）。
const SERVICE_RESTART_NAMES = Object.freeze(['Spooler', 'W32Time']);
// network.adapter.restart のアダプタ名は端末ごとに異なるため enum にできない。
// 長さだけを上限で絞り、実在確認は .ps1（実行端末の一覧との完全一致）が行う。
const INTERFACE_ALIAS_MAX_LENGTH = 64;
const PURGE_CONFIRM_TOKEN = 'PURGE';
const TEMP_CLEANUP_MIN_DAYS = 1;
const TEMP_CLEANUP_MAX_DAYS = 30;

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
  // ── Phase 2: 修復系 7 件（manifest 承認後にだけ実行できる） ──
  ['spooler.restart', { file: 'spooler-restart.ps1', buildArgs: () => [] }],
  [
    'spooler.queue.purge',
    {
      file: 'spooler-queue-purge.ps1',
      // 取消不可。params.confirm が 'PURGE' のときだけ -ConfirmPurge を渡す。
      buildArgs: (params) => {
        requirePurgeConfirm(params);
        return ['-ConfirmPurge'];
      },
    },
  ],
  [
    'service.start',
    {
      file: 'service-start.ps1',
      buildArgs: (params) => ['-Service', requireAllowedStartService(params)],
    },
  ],
  // ── Phase 7: 追加の修復系（manifest 承認後にだけ実行できる） ──
  [
    'service.restart',
    {
      file: 'service-restart.ps1',
      buildArgs: (params) => ['-Service', requireRestartService(params)],
    },
  ],
  [
    'network.adapter.restart',
    {
      file: 'network-adapter-restart.ps1',
      // アダプタ名は端末ごとに異なるため enum にできない。形だけを検証し、
      // 実在するアダプタ名との完全一致は .ps1 が実行時に確認する。
      buildArgs: (params) => ['-InterfaceAlias', requireInterfaceAlias(params)],
    },
  ],
  ['defender.update', { file: 'defender-update.ps1', buildArgs: () => [] }],
  ['recyclebin.clear', { file: 'recyclebin-clear.ps1', buildArgs: () => [] }],
  [
    'temp.cleanup',
    {
      file: 'temp-cleanup.ps1',
      buildArgs: (params) => ['-OlderThanDays', String(requireOlderThanDays(params))],
    },
  ],
  ['dns.flush', { file: 'dns-flush.ps1', buildArgs: () => [] }],
  ['bitlocker.status', { file: 'bitlocker-status.ps1', buildArgs: () => [] }],
  ['defender.quickscan', { file: 'defender-quickscan.ps1', buildArgs: () => [] }],
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
  // ── Phase 2: 修復系（PII なし・実出力キーに合わせた固定 fixture） ──
  'spooler.restart': Object.freeze({
    name: 'Spooler',
    displayName: 'Print Spooler',
    status: 'Running',
    startType: 'Auto',
    previousStatus: 'Running',
    restarted: true,
  }),
  'spooler.queue.purge': Object.freeze({
    purgedCount: 1,
    failedCount: 0,
    remainingErrorCount: 0,
    irreversible: true,
  }),
  'temp.cleanup': Object.freeze({
    freeBytesBefore: 1_073_741_824,
    freeBytesAfter: 1_178_599_424,
    freedBytes: 104_857_600,
    freedMB: 100,
    deletedBytes: 104_857_600,
    deletedCount: 12,
    skippedCount: 0,
    truncated: false,
  }),
  'dns.flush': Object.freeze({ flushed: true, exitCode: 0 }),
  'bitlocker.status': Object.freeze({
    supported: true,
    volumeCount: 1,
    volumes: [
      {
        mountPoint: 'C:',
        volumeStatus: 'FullyEncrypted',
        protectionStatus: 'On',
        encryptionMethod: 'XtsAes256',
        encryptionPercentage: 100,
      },
    ],
    bdeStatusExitCode: null,
  }),
  'defender.quickscan': Object.freeze({
    started: true,
    scanType: 'QuickScan',
    startedAt: '2026-10-25T00:00:00.0000000Z',
  }),
  // ── Phase 7: 追加の修復系（PII なし・実出力キーに合わせた固定 fixture） ──
  'defender.update': Object.freeze({
    updated: true,
    previousVersion: '1.415.118.0',
    currentVersion: '1.415.120.0',
    lastUpdated: '2026-10-25T00:00:00.0000000Z',
  }),
  'recyclebin.clear': Object.freeze({
    cleared: true,
    clearedCount: 12,
    itemsBefore: 12,
    itemsAfter: 0,
    alreadyEmpty: false,
    irreversible: true,
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

/** service.start の起動対象を許可リストで検証する（agent 側でも多層防御）。 */
function requireAllowedStartService(params) {
  const raw = params?.name;
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!SERVICE_START_NAMES.includes(name)) {
    throw new Error(
      `service.start の name が許可されていません: ${name === '' ? '(empty)' : name}`,
    );
  }
  return name;
}

/** service.restart の再起動対象を許可リストで検証する（agent 側でも多層防御）。 */
function requireRestartService(params) {
  const raw = params?.name;
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!SERVICE_RESTART_NAMES.includes(name)) {
    throw new Error(
      `service.restart の name が許可されていません: ${name === '' ? '(empty)' : name}`,
    );
  }
  return name;
}

/**
 * network.adapter.restart の interfaceAlias を検証する（agent 側でも多層防御）。
 *
 * 値はシェルを介さず引数配列で渡すが、先頭 '-'（PowerShell のパラメータ名と
 * 誤認され得る）・制御文字・長すぎる値を拒否する。実在するアダプタ名かどうかは
 * .ps1 が実行端末の一覧と完全一致で確認する（ここでは端末の一覧を持たない）。
 */
function requireInterfaceAlias(params) {
  const raw = params?.interfaceAlias;
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('network.adapter.restart の interfaceAlias は空でない文字列で指定してください');
  }
  if (raw.length > INTERFACE_ALIAS_MAX_LENGTH) {
    throw new Error(
      `network.adapter.restart の interfaceAlias は ${INTERFACE_ALIAS_MAX_LENGTH} 文字以内で指定してください`,
    );
  }
  if (raw.startsWith('-')) {
    throw new Error('network.adapter.restart の interfaceAlias を "-" で開始できません');
  }
  // 制御文字（改行・タブ等）はアダプタ名に現れない（.ps1 でも同じ検査をする）。
  for (const char of raw) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      throw new Error('network.adapter.restart の interfaceAlias に制御文字を含められません');
    }
  }
  return raw;
}

/**
 * spooler.queue.purge の二重確認トークンを検証する。
 * 利用者の実行前 Y/N（承認ハッシュ）と合わせて二重確認とし、サーバ・端末の両方で見る。
 */
function requirePurgeConfirm(params) {
  const raw = params?.confirm;
  const token = typeof raw === 'string' ? raw.trim() : '';
  if (token !== PURGE_CONFIRM_TOKEN) {
    throw new Error(`spooler.queue.purge には confirm="${PURGE_CONFIRM_TOKEN}" が必要です`);
  }
  return token;
}

/** temp.cleanup の olderThanDays を 1..30 の整数として検証する。 */
function requireOlderThanDays(params) {
  const raw = params?.olderThanDays;
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    throw new Error('temp.cleanup の olderThanDays は整数で指定してください');
  }
  if (raw < TEMP_CLEANUP_MIN_DAYS || raw > TEMP_CLEANUP_MAX_DAYS) {
    throw new Error(
      `temp.cleanup の olderThanDays は ${TEMP_CLEANUP_MIN_DAYS}..${TEMP_CLEANUP_MAX_DAYS} で指定してください`,
    );
  }
  return raw;
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
  } else if (skillId === 'service.start') {
    // 起動対象も mock で検証する（本番と同じ fail-closed を維持）。
    const name = requireAllowedStartService(params);
    normalized = { ...MOCK_SERVICES[name], previousStatus: 'Stopped', started: true };
  } else if (skillId === 'service.restart') {
    // 再起動対象も mock で検証する（本番と同じ fail-closed を維持）。
    const name = requireRestartService(params);
    normalized = { ...MOCK_SERVICES[name], previousStatus: 'Running', restarted: true };
  } else if (skillId === 'network.adapter.restart') {
    // アダプタ名も mock で検証する（本番と同じ fail-closed を維持）。
    const alias = requireInterfaceAlias(params);
    normalized = {
      name: alias,
      interfaceDescription: 'Intel(R) Ethernet Connection I219-LM',
      previousStatus: 'Disabled',
      status: 'Up',
      restarted: true,
    };
  } else if (skillId === 'spooler.queue.purge') {
    requirePurgeConfirm(params);
    normalized = structuredClone(MOCK_FIXTURES[skillId]);
  } else if (skillId === 'temp.cleanup') {
    requireOlderThanDays(params);
    normalized = structuredClone(MOCK_FIXTURES[skillId]);
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
    // 結果の出所。fixture を実端末の結果に見せない（サーバは本番で mock を拒否する）。
    executionSource: mockMode ? 'mock' : 'endpoint_agent',
    normalized: output.normalized,
    stdoutSummary: truncate(output.stdoutSummary, SUMMARY_LIMIT_CHARS),
    stderrSummary: truncate(output.stderrSummary, SUMMARY_LIMIT_CHARS),
    exitCode: output.exitCode,
    durationMs: output.durationMs,
    deviceId: reportedDeviceId,
  };
}

/**
 * admin エージェントの許可リスト（昇格必須 5 件）を強制する（二重防御）。
 * サーバが privilege を誤って配信しても、standard 系 Skill や skill_id なしの
 * 既存経路（SPOOLER_RESTART 等）は実行しない。
 */
function assertSkillAllowedForPrivilege(command) {
  if (!isAdminAgent) return;
  const skillId = command?.skill_id ? String(command.skill_id) : '';
  if (!skillId || !ELEVATED_SKILL_IDS.includes(skillId)) {
    throw new Error(
      `管理者エージェントは昇格必須 Skill 以外を実行しません: ${
        skillId === '' ? String(command?.op_id ?? '(unknown)') : skillId
      }`,
    );
  }
}

function execute(command) {
  assertSkillAllowedForPrivilege(command);
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
  log('command-agent start', {
    commandUrl,
    intervalSeconds,
    mock: mockMode,
    privilege: agentPrivilege,
  });
  if (isAdminAgent) {
    log('管理者エージェント: 昇格必須 Skill のみ実行します', ELEVATED_SKILL_IDS.join(', '));
  }
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
