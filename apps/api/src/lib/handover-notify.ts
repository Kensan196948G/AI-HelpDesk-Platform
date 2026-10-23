import { config } from '../config.js';
import { sql } from '../db.js';
import { redactPII } from '../domain/pii.js';
import { getMailTransport, isValidEmail, type MailTransport, sanitizeHeader } from './mailer.js';

/**
 * 引継ぎのメール通知。
 *
 * - 引継ぎの作成時に「送信キュー」へ積む（best-effort。メールが失敗しても引継ぎは成功）。
 * - 送信はバックグラウンドで行い、失敗したら回数を数えて再試行する（5 回で打ち切り）。
 * - 本文には相談の本文や PC 情報を載せない（件名・案件 ID・依頼者・URL だけ）。
 */

export interface HandoverRecipient {
  email: string;
  name?: string | null;
}

export interface HandoverNoticeInput {
  handoverId: string;
  caseId: string;
  subject: string;
  requester: string;
  recipientName?: string | null;
  receivedAt?: Date;
}

const MAX_ATTEMPTS = 5;

function formatJst(date: Date): string {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/** メールに載せる件名（個人情報を伏せたうえで短くする）。 */
export function buildHandoverSubject(input: HandoverNoticeInput): string {
  const subject = sanitizeHeader(redactPII(input.subject || '(件名なし)').text, 80);
  return sanitizeHeader(`[AIヘルプデスク] 引継ぎ: ${subject}（${input.caseId}）`, 160);
}

/** メール本文。相談の本文・PC 情報は載せない。 */
export function buildHandoverBody(input: HandoverNoticeInput): string {
  const requester = sanitizeHeader(redactPII(input.requester || '').text, 60);
  const received = formatJst(input.receivedAt ?? new Date());
  const to = input.recipientName
    ? `${sanitizeHeader(redactPII(input.recipientName).text, 40)} さん`
    : 'DX 推進部のみなさま';
  const lines = [
    to,
    '',
    'AI 一次対応で解決しなかった案件が、DX 推進部へ引き継がれました。',
    '',
    `案件 ID : ${input.caseId}`,
    `件名    : ${sanitizeHeader(redactPII(input.subject || '(件名なし)').text, 120)}`,
  ];
  if (requester) lines.push(`依頼者  : ${requester} さん`);
  lines.push(
    `受付    : ${received}`,
    '',
    '受信箱を開いて、内容を確認してください。',
    config.NOTIFY_BASE_URL,
    '',
    '---',
    'このメールは自動送信です。相談の本文や PC の情報は、個人情報保護のためメールには載せていません。',
    '心当たりがない場合は、DX 推進部までご連絡ください。',
  );
  return lines.join('\n');
}

/**
 * 通知先を決める。
 * - 個人が指名されていれば、その人のメールアドレス（サーバー内でのみ解決）。
 * - 指名なしは HANDOVER_NOTIFY_EMAIL（グループ受信箱）。
 * メールアドレスは API のレスポンスには返さない。
 */
export function resolveConfiguredRecipients(): HandoverRecipient[] {
  return config.HANDOVER_NOTIFY_EMAIL.split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && isValidEmail(value))
    .map((email) => ({ email }));
}

/** 送信キューへ積む。同じ引継ぎ・同じ宛先は二重に積まない。 */
export async function enqueueHandoverNotifications(
  input: HandoverNoticeInput,
  recipients: HandoverRecipient[],
): Promise<number> {
  if (recipients.length === 0) return 0;
  // 送信手段が無い環境ではキューを積まない（設定後に溜まって一斉送信されるのを避ける）。
  if (getMailTransport().name === 'disabled') return 0;
  const subject = buildHandoverSubject(input);
  const body = buildHandoverBody(input);
  let queued = 0;
  for (const recipient of recipients) {
    if (!isValidEmail(recipient.email)) continue;
    const rows = await sql<{ id: string }[]>`
      INSERT INTO case_handover_notifications (
        handover_id, recipient_email, recipient_name, subject, body
      )
      VALUES (
        ${input.handoverId},
        ${recipient.email.toLowerCase()},
        ${recipient.name ?? null},
        ${subject},
        ${body}
      )
      ON CONFLICT (handover_id, recipient_email) DO NOTHING
      RETURNING id
    `;
    if (rows.length > 0) queued += 1;
  }
  return queued;
}

export interface FlushResult {
  sent: number;
  failed: number;
  remaining: number;
  transport: string;
}

interface PendingRow {
  id: string;
  handover_id: string;
  recipient_email: string;
  subject: string;
  body: string;
  attempts: number;
}

/** 送信キューを消化する（ワーカーとテストの両方から呼ぶ）。 */
export async function flushHandoverNotifications(options?: {
  limit?: number;
  transport?: MailTransport;
}): Promise<FlushResult> {
  const transport = options?.transport ?? getMailTransport();
  if (transport.name === 'disabled') {
    return { sent: 0, failed: 0, remaining: 0, transport: 'disabled' };
  }
  const limit = options?.limit ?? 20;
  let sent = 0;
  let failed = 0;

  await sql.begin(async (tx) => {
    const rows = await tx<PendingRow[]>`
      SELECT id, handover_id, recipient_email, subject, body, attempts
      FROM case_handover_notifications
      WHERE status = 'pending' AND attempts < ${MAX_ATTEMPTS}
      ORDER BY created_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `;
    for (const row of rows) {
      try {
        await transport.send({
          to: row.recipient_email,
          subject: row.subject,
          text: row.body,
        });
        await tx`
          UPDATE case_handover_notifications
          SET status = 'sent', attempts = attempts + 1, sent_at = now(), last_error = null
          WHERE id = ${row.id}
        `;
        sent += 1;
      } catch (error) {
        const message = String((error as Error)?.message ?? error).slice(0, 500);
        await tx`
          UPDATE case_handover_notifications
          SET attempts = attempts + 1,
              last_error = ${message},
              status = CASE WHEN attempts + 1 >= ${MAX_ATTEMPTS} THEN 'failed' ELSE 'pending' END
          WHERE id = ${row.id}
        `;
        failed += 1;
      }
    }
  });

  const remainingRows = await sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM case_handover_notifications WHERE status = 'pending'
  `;
  return {
    sent,
    failed,
    remaining: Number(remainingRows[0]?.count ?? 0),
    transport: transport.name,
  };
}

/**
 * バックグラウンドの送信ワーカー。起動時と一定間隔でキューを消化する。
 * 送信手段が無いときは何もしない（キューも積まない方針）。
 */
export function startHandoverNotificationWorker(log: {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}): () => void {
  const transport = getMailTransport();
  if (transport.name === 'disabled') {
    log.info(
      { transport: 'disabled' },
      'メール通知は無効です（SMTP_HOST か sendmail の設定で有効になります）。',
    );
    return () => {};
  }
  const run = async (): Promise<void> => {
    try {
      const result = await flushHandoverNotifications({ transport });
      if (result.sent > 0 || result.failed > 0) {
        log.info(result, '引継ぎ通知メールを送信しました。');
      }
    } catch (error) {
      log.warn({ err: error }, '引継ぎ通知メールの送信に失敗しました。');
    }
  };
  void run();
  const timer = setInterval(() => void run(), config.NOTIFY_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
