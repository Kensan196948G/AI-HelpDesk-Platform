import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import nodemailer from 'nodemailer';
import { config } from '../config.js';

/**
 * メール送信の最小実装（引継ぎ通知用）。
 *
 * - smtp: SMTP リレーへ送る（nodemailer）。
 * - sendmail: ローカルの sendmail/msmtp に渡す（`-t` でヘッダーの宛先を使う。明示指定のみ）。
 * - disabled: 送らない。
 *
 * 設定が無い環境では黙って送らない（起動は止めない）。送信に失敗しても
 * 引継ぎ自体は成功させ、失敗はキューに記録して再試行する。
 */

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export type TransportName = 'smtp' | 'sendmail' | 'disabled';

export interface MailTransport {
  name: TransportName;
  send(message: MailMessage): Promise<void>;
}

export class MailDisabledError extends Error {
  constructor(message = 'メール送信が設定されていません。') {
    super(message);
    this.name = 'MailDisabledError';
  }
}

const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

export function isValidEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}

/** ヘッダーインジェクション（改行混入）を防ぐ。 */
export function sanitizeHeader(value: string, maxLength = 200): string {
  return value
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

/** 日本語を含むヘッダーを RFC 2047（Base64）で符号化する。 */
export function encodeHeaderValue(value: string): string {
  // ASCII だけなら素のまま（可読性のため）。
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function sendmailBinary(): string | null {
  for (const candidate of ['/usr/sbin/sendmail', '/usr/bin/msmtp', '/usr/lib/sendmail']) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function resolveTransportName(): TransportName {
  // テストでは実メールを送らない（明示指定がある場合だけ従う）。
  if (config.NODE_ENV === 'test' && config.MAIL_TRANSPORT === 'auto') return 'disabled';
  switch (config.MAIL_TRANSPORT) {
    case 'smtp':
      return 'smtp';
    case 'sendmail':
      return sendmailBinary() ? 'sendmail' : 'disabled';
    case 'disabled':
      return 'disabled';
    default:
      // auto は SMTP の設定があるときだけ有効にする。
      // 未設定の msmtp などを掴んで失敗し続けるのを避ける（sendmail は明示指定）。
      return config.SMTP_HOST ? 'smtp' : 'disabled';
  }
}

export function fromAddress(): string {
  return config.MAIL_FROM ?? config.SMTP_USER ?? 'ai-helpdesk@localhost';
}

function buildRawMessage(message: MailMessage): string {
  const to = sanitizeHeader(message.to, 320);
  const subject = encodeHeaderValue(sanitizeHeader(message.subject));
  const body = Buffer.from(message.text, 'utf8').toString('base64');
  return [
    `From: ${sanitizeHeader(fromAddress(), 320)}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
    '',
  ].join('\r\n');
}

function sendViaSendmail(binary: string): MailTransport {
  return {
    name: 'sendmail',
    send(message) {
      return new Promise((resolve, reject) => {
        const child = spawn(binary, ['-t', '-i'], { stdio: ['pipe', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr?.on('data', (chunk: Buffer) => {
          if (stderr.length < 2000) stderr += chunk.toString('utf8');
        });
        child.on('error', reject);
        child.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`sendmail exit ${code}: ${stderr.trim().slice(0, 300)}`));
        });
        child.stdin?.end(buildRawMessage(message));
      });
    },
  };
}

function sendViaSmtp(): MailTransport {
  const transport = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE === 'true',
    ...(config.SMTP_USER ? { auth: { user: config.SMTP_USER, pass: config.SMTP_PASS ?? '' } } : {}),
    // 接続が張れないときに無限に待たない。
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return {
    name: 'smtp',
    async send(message) {
      await transport.sendMail({
        from: fromAddress(),
        to: sanitizeHeader(message.to, 320),
        subject: sanitizeHeader(message.subject),
        text: message.text,
      });
    },
  };
}

let cached: MailTransport | null = null;

/** 送信手段を返す（設定が無ければ disabled）。 */
export function getMailTransport(): MailTransport {
  if (cached) return cached;
  const name = resolveTransportName();
  if (name === 'smtp') {
    if (!config.SMTP_HOST) throw new MailDisabledError('SMTP_HOST が未設定です。');
    cached = sendViaSmtp();
  } else if (name === 'sendmail') {
    const binary = sendmailBinary();
    cached = binary ? sendViaSendmail(binary) : { name: 'disabled', send: neverDisabled };
  } else {
    cached = { name: 'disabled', send: neverDisabled };
  }
  return cached;
}

async function neverDisabled(): Promise<void> {
  throw new MailDisabledError();
}

/** テスト用にキャッシュを捨てる。 */
export function resetMailTransport(): void {
  cached = null;
}

/** 起動ログ用の説明。秘密は含めない。 */
export function describeMailTransport(): string {
  const name = resolveTransportName();
  if (name === 'smtp') return `smtp:${config.SMTP_HOST}:${config.SMTP_PORT}`;
  if (name === 'sendmail') return `sendmail:${sendmailBinary() ?? '?'}`;
  return 'disabled';
}
