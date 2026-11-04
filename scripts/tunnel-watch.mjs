#!/usr/bin/env node
/**
 * トンネル経路（Cloudflare Tunnel → プロキシ → API）の要求失敗を数え、多ければメールで知らせる。
 * ai-helpdesk-tunnel-watch.timer から 5 分ごとに実行する。
 *
 * 2026-11-04 に、トンネルの不調で画面の表示と状態の保存が 30 分以上止まり、誰も気づけなかった
 * （docs/68 §9）。API の health は正常のままだったので、トンネルとプロキシのログを見る。
 *
 * - 読むのは journal だけ。サービスの再起動などの操作はしない（判断は人が行う）。
 * - 同じ通知は 60 分に 1 回まで（共用の送信アカウントの上限を使い切らない）。
 * - 本文とログに URL、IP、メールアドレスを入れない。件数と時刻だけを出す。
 *
 *   node scripts/tunnel-watch.mjs --dry-run   # 送らずに判定と本文を標準出力へ出す
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSmtpTransport, fromAddress, readEnvFile } from './lib/ops-mail.mjs';

const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;
/** cloudflared の要求失敗と、プロキシの API への転送失敗。 */
const FAILURE_RE = /(ERR Request failed|\[proxy\] upstream error)/;

export const DEFAULTS = Object.freeze({ windowMin: 10, threshold: 3, cooldownMin: 60 });

/** journal の行から失敗の件数を数える。 */
export function countFailures(lines) {
  let count = 0;
  for (const line of lines) if (FAILURE_RE.test(line)) count += 1;
  return count;
}

/** 通知するか。しきい値以上で、前回の送信から cooldown 以上たっているとき。 */
export function shouldNotify({ count, threshold, lastSentAt, now, cooldownMin }) {
  if (count < threshold) return false;
  if (lastSentAt === null) return true;
  return now - lastSentAt >= cooldownMin * 60_000;
}

export function buildMessage({ count, windowMin }) {
  return {
    subject: '[AIヘルプデスク] トンネル経路の要求失敗が続いています',
    text: [
      `直近 ${windowMin} 分で、トンネルまたはプロキシの要求失敗が ${count} 件ありました。`,
      '画面の表示や状態の保存が止まっている可能性があります。API の health だけでは検知できません。',
      '',
      '確認:',
      '  journalctl --user -u ai-helpdesk-cloudflared -u ai-helpdesk-proxy --since -15min --no-pager',
      '  systemctl --user status ai-helpdesk-cloudflared',
      '',
      '手順: docs/09-operations.md 5-2（再起動は人が判断する）',
      '',
    ].join('\n'),
  };
}

function readLastSent(stateFile) {
  try {
    const value = Number(readFileSync(stateFile, 'utf8').trim());
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  for (const arg of args) {
    if (arg !== '--dry-run') {
      console.error('tunnel-watch: unknown argument');
      process.exit(2);
    }
  }
  const home = homedir();
  const envFile = process.env.AIHD_ENV_FILE || path.join(home, '.config/ai-helpdesk/api.conf');
  const stateDir = process.env.AIHD_STATE_DIR || path.join(home, '.local/state/ai-helpdesk');
  const stateFile = path.join(stateDir, 'tunnel-watch-last-sent');
  const windowMin = Number(process.env.AIHD_TUNNEL_WINDOW_MIN) || DEFAULTS.windowMin;
  const threshold = Number(process.env.AIHD_TUNNEL_THRESHOLD) || DEFAULTS.threshold;

  let output;
  try {
    output = execFileSync(
      'journalctl',
      [
        '--user',
        '-u',
        'ai-helpdesk-cloudflared',
        '-u',
        'ai-helpdesk-proxy',
        '--since',
        `-${windowMin}min`,
        '--no-pager',
        '-o',
        'cat',
      ],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    );
  } catch {
    console.error('tunnel-watch: journal-unreadable');
    process.exit(1);
  }
  const count = countFailures(output.split('\n'));
  const now = Date.now();
  const lastSentAt = readLastSent(stateFile);
  const notify = shouldNotify({
    count,
    threshold,
    lastSentAt,
    now,
    cooldownMin: DEFAULTS.cooldownMin,
  });
  if (!notify) {
    console.log(`tunnel-watch: ok (failures=${count} window=${windowMin}min)`);
    return;
  }
  const message = buildMessage({ count, windowMin });
  if (args.has('--dry-run')) {
    console.log(`Subject: ${message.subject}\n\n${message.text}`);
    return;
  }
  try {
    const env = readEnvFile(envFile);
    const recipients = (env.OPS_ALERT_EMAIL || env.HANDOVER_NOTIFY_EMAIL || '')
      .split(',')
      .map((value) => value.trim())
      .filter((value) => EMAIL_RE.test(value));
    if (!env.SMTP_HOST || recipients.length === 0) throw new Error('not-configured');
    await createSmtpTransport(env).sendMail({
      from: fromAddress(env),
      to: recipients.join(', '),
      subject: message.subject,
      text: message.text,
    });
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(stateFile, `${now}\n`, { mode: 0o600 });
    console.log(`tunnel-watch: sent (failures=${count} recipients=${recipients.length})`);
  } catch (error) {
    const reason = error?.message === 'not-configured' ? 'not-configured' : 'send-failed';
    console.error(`tunnel-watch: not sent (failures=${count} reason=${reason})`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
