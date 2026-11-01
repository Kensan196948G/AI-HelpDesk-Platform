/**
 * 運用スクリプト用の設定読み取りと SMTP 送信の共通部分。
 *
 * api.conf は systemd の EnvironmentFile 形式なので、シェルとして読み込まない
 * （値の `|` などが解釈され、2026-10-29 以降のバックアップ失敗の原因になった）。
 * API の lib/mailer.ts は config.ts 経由で設定全体を検証するので、設定の不備を
 * 知らせる側の処理が同じ不備で止まらないよう、ここでは必要な値だけを読む。
 */
import { readFileSync } from 'node:fs';
import nodemailer from 'nodemailer';

/** 同じキーは最後の行を採用し、外側の引用符を 1 組だけ外す。値は展開しない。 */
export function readEnvFile(file) {
  const values = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (value.length >= 2 && value[0] === value.at(-1) && (value[0] === '"' || value[0] === "'")) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

/** lib/mailer.ts の sendViaSmtp と同じ接続条件。 */
export function createSmtpTransport(env) {
  return nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT || 587),
    secure: env.SMTP_SECURE === 'true',
    ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASS ?? '' } } : {}),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}

/** lib/mailer.ts の fromAddress と同じ優先順位。 */
export function fromAddress(env) {
  return env.MAIL_FROM || env.SMTP_USER || 'ai-helpdesk@localhost';
}
