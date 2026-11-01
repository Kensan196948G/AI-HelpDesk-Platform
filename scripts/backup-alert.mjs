/**
 * 日次バックアップの通知。ai-helpdesk-backup.service の ExecStopPost から実行する。
 *
 * - バックアップの失敗（systemd が渡す SERVICE_RESULT で判定）か、ディスク使用率の
 *   しきい値超えがあるときだけメールを送る。どちらも無ければ何も送らない。
 * - 宛先は OPS_ALERT_EMAIL、無ければ HANDOVER_NOTIFY_EMAIL（どちらもカンマ区切り可）。
 * - 本文とログに秘密・接続文字列・メールアドレスを入れない。SMTP サーバーの応答は
 *   宛先を含むことがあるので、エラーは固定の理由コードだけを出す。
 *
 *   node scripts/backup-alert.mjs --dry-run   # 送らずに本文を標準出力へ出す
 *   node scripts/backup-alert.mjs --test      # 配送確認の試験メールを実際に送る
 */
import { appendFileSync, readFileSync, statfsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createSmtpTransport, fromAddress, readEnvFile } from './lib/ops-mail.mjs';

const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;
const DEFAULT_DISK_WARN_PCT = 90;
const TIMESTAMP = '\\d{4}-\\d{2}-\\d{2}T[0-9:+-]+';
const FAIL_LINE = new RegExp(`^(${TIMESTAMP}) FAIL stage=([a-z]+) exit=(\\d+)$`);
const OK_LINE = new RegExp(`^(${TIMESTAMP}) OK `);

const args = new Set(process.argv.slice(2));
for (const arg of args) {
  if (arg !== '--test' && arg !== '--dry-run') {
    console.error('backup-alert: unknown argument');
    process.exit(2);
  }
}
const isTest = args.has('--test');
const isDryRun = args.has('--dry-run');

const home = homedir();
const envFile = process.env.AIHD_ENV_FILE || path.join(home, '.config/ai-helpdesk/api.conf');
const backupDir = process.env.AIHD_BACKUP_DIR || path.join(home, 'backups/ai-helpdesk');
const logFile = path.join(backupDir, 'backup.log');
const diskPath = process.env.AIHD_DISK_PATH || '/';

/** systemd の値でも、想定外の文字列は本文へ載せない。 */
function safeToken(value) {
  return /^[A-Za-z0-9_-]{1,32}$/.test(value ?? '') ? value : '不明';
}

/** df と同じ計算（root 予約分を除いた容量に対する使用率、切り上げ）。 */
function diskUsedPct() {
  try {
    const { blocks, bfree, bavail } = statfsSync(diskPath);
    const used = blocks - bfree;
    const total = used + bavail;
    return total > 0 ? Math.ceil((used * 100) / total) : null;
  } catch {
    return null;
  }
}

function diskWarnPct() {
  const value = Number(process.env.AIHD_DISK_WARN_PCT);
  return process.env.AIHD_DISK_WARN_PCT && Number.isFinite(value) ? value : DEFAULT_DISK_WARN_PCT;
}

/** backup.log から時刻・段階・終了コードだけを取り出す。行をそのまま本文へ載せない。 */
function readBackupLog() {
  let lines = [];
  try {
    lines = readFileSync(logFile, 'utf8')
      .split('\n')
      .filter((line) => line && !line.startsWith('NOTIFY'));
  } catch {
    // ログが無くても通知は止めない。
  }
  const fail = FAIL_LINE.exec(lines.at(-1) ?? '');
  const ok = lines.findLast((line) => OK_LINE.test(line));
  return {
    fail: fail ? { at: fail[1], stage: fail[2], exit: fail[3] } : null,
    lastOkAt: ok ? OK_LINE.exec(ok)[1] : null,
  };
}

function buildMessage({ failed, diskOver, pct, warnPct }) {
  const titles = [];
  if (failed) titles.push('バックアップ失敗');
  if (diskOver) titles.push('ディスク残量警告');
  if (isTest) titles.push('配送確認の試験');
  const { fail, lastOkAt } = readBackupLog();
  const { SERVICE_RESULT, EXIT_CODE, EXIT_STATUS } = process.env;

  const lines = [];
  if (isTest) lines.push('これは配送確認の試験です。対応は不要です。', '');
  lines.push(
    failed
      ? `バックアップ: 失敗（result=${safeToken(SERVICE_RESULT)} code=${safeToken(EXIT_CODE)} status=${safeToken(EXIT_STATUS)}）`
      : 'バックアップ: 失敗の報告なし',
  );
  // 起動できなかった場合は FAIL 行が書かれないので、時刻で今回の記録か確かめられるようにする。
  if (failed && fail) {
    lines.push(`直近の FAIL 記録: ${fail.at} stage=${fail.stage} exit=${fail.exit}`);
  }
  lines.push(
    `最後の成功: ${lastOkAt ?? '記録なし'}`,
    pct === null
      ? `ディスク: ${diskPath} の使用率を取得できませんでした`
      : `ディスク: ${diskPath} の使用率 ${pct}%（警告は ${warnPct}% 超）`,
    '',
    '確認:',
    '  systemctl --user status ai-helpdesk-backup.service',
    '  journalctl --user -u ai-helpdesk-backup.service -n 50 --no-pager',
    '  tail -n 5 ~/backups/ai-helpdesk/backup.log',
    '',
    '手順: docs/09-operations.md 4-1',
    '',
  );
  return { subject: `[AIヘルプデスク] ${titles.join('・')}`, text: lines.join('\n') };
}

class NotifyError extends Error {}

async function send(message) {
  let env;
  try {
    env = readEnvFile(envFile);
  } catch {
    throw new NotifyError('env-file-unreadable');
  }
  const transportName = env.MAIL_TRANSPORT || 'auto';
  if (transportName === 'disabled') throw new NotifyError('transport-disabled');
  if (transportName !== 'auto' && transportName !== 'smtp') {
    throw new NotifyError('transport-unsupported');
  }
  if (!env.SMTP_HOST) throw new NotifyError('smtp-host-missing');
  const recipients = (env.OPS_ALERT_EMAIL || env.HANDOVER_NOTIFY_EMAIL || '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => EMAIL_RE.test(value));
  if (recipients.length === 0) throw new NotifyError('recipient-missing');
  try {
    await createSmtpTransport(env).sendMail({
      from: fromAddress(env),
      to: recipients.join(', '),
      subject: message.subject,
      text: message.text,
    });
  } catch (error) {
    throw new NotifyError(safeToken(error?.code ?? 'send-failed'));
  }
  return recipients.length;
}

/** ディスク満杯でも結果は journal に残るので、ログの追記の失敗は無視する。 */
function appendLog(line) {
  try {
    appendFileSync(logFile, `NOTIFY ${new Date().toISOString()} ${line}\n`);
  } catch {
    // 無視する。
  }
}

const serviceResult = process.env.SERVICE_RESULT ?? '';
const failed = serviceResult !== '' && serviceResult !== 'success';
const pct = diskUsedPct();
const warnPct = diskWarnPct();
const diskOver = pct !== null && pct > warnPct;

if (!failed && !diskOver && !isTest) {
  console.log(`backup-alert: nothing to report (disk ${pct ?? 'unknown'}%)`);
} else {
  const message = buildMessage({ failed, diskOver, pct, warnPct });
  if (isDryRun) {
    console.log(`Subject: ${message.subject}\n\n${message.text}`);
  } else {
    try {
      const count = await send(message);
      console.log(`backup-alert: sent (recipients=${count})`);
      appendLog(`sent recipients=${count}`);
    } catch (error) {
      const reason = error instanceof NotifyError ? error.message : 'internal-error';
      console.error(`backup-alert: not sent (reason=${reason})`);
      appendLog(`not-sent reason=${reason}`);
      process.exitCode = 1;
    }
  }
}
