import { z } from 'zod';
import { config } from '../config.js';

/**
 * 貸与情報の取得（docs/62 §4）。Mirai-Info の PII API を読む。
 * `device_staff` ビューを SQL で直接読まない（PII API の Access 制御の迂回になる）。
 * 認証は Cloudflare Access サービストークン（ID と Secret の 2 値）。
 * 確定できない場合はすべて `pending` を返し、呼び出し側は device_pending に留める（fail-closed）。
 */

export type LeasePendingCode =
  | 'LEASE_UNAVAILABLE'
  | 'LEASE_STALE'
  | 'LEASE_NONE'
  | 'LEASE_MULTIPLE'
  | 'LEASE_CONFLICT';

export type LeaseResult =
  | {
      kind: 'verified';
      hostname: string;
      assetTag: string | null;
      source: string;
      fetchedAt: Date;
      generatedAt: Date;
    }
  | { kind: 'pending'; code: LeasePendingCode };

const RecordSchema = z.object({
  hostname: z.string().nullable().optional(),
  asset_tag: z.string().nullable().optional(),
  employee_no: z.string().nullable().optional(),
  staff_matched: z.boolean().nullable().optional(),
  // 返却済みなどで現在の貸与先でない行を Mirai-Info 側が示す場合に除外する。
  active: z.boolean().nullable().optional(),
});

const ResponseSchema = z.object({
  ok: z.literal(true),
  source: z.string().optional(),
  generatedAt: z.string().nullable().optional(),
  records: z.array(RecordSchema),
});

const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

function normalizedHostname(value: string | null | undefined): string {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

/** 応答の判定（テスト用に分離）。 */
export function evaluateLeaseResponse(
  raw: unknown,
  employeeNo: string,
  now: Date,
  maxAgeHours: number,
): LeaseResult {
  const parsed = ResponseSchema.safeParse(raw);
  if (!parsed.success) return { kind: 'pending', code: 'LEASE_UNAVAILABLE' };
  const { records, generatedAt: generatedRaw, source } = parsed.data;

  // generatedAt が無い・読めない・古い応答は確定に使わない。
  const generatedAt = generatedRaw ? new Date(generatedRaw) : null;
  if (!generatedAt || Number.isNaN(generatedAt.getTime())) {
    return { kind: 'pending', code: 'LEASE_STALE' };
  }
  const age = now.getTime() - generatedAt.getTime();
  if (age > maxAgeHours * 3_600_000 || age < -FUTURE_TOLERANCE_MS) {
    return { kind: 'pending', code: 'LEASE_STALE' };
  }

  const current = records.filter((record) => record.active !== false);
  const mine = current.filter(
    (record) =>
      record.employee_no?.trim() === employeeNo &&
      record.staff_matched !== false &&
      normalizedHostname(record.hostname),
  );
  if (mine.length === 0) return { kind: 'pending', code: 'LEASE_NONE' };
  if (mine.length > 1) return { kind: 'pending', code: 'LEASE_MULTIPLE' };
  const record = mine[0];
  const hostname = record?.hostname?.trim();
  if (!record || !hostname) return { kind: 'pending', code: 'LEASE_NONE' };

  // 同じ端末が別の社員にも貸与されている場合は照合競合。
  const conflict = current.some(
    (other) =>
      other !== record &&
      normalizedHostname(other.hostname) === hostname.toLowerCase() &&
      other.employee_no?.trim() !== employeeNo,
  );
  if (conflict) return { kind: 'pending', code: 'LEASE_CONFLICT' };

  return {
    kind: 'verified',
    hostname,
    assetTag: record.asset_tag?.trim() || null,
    source: source ?? 'unknown',
    fetchedAt: now,
    generatedAt,
  };
}

export async function fetchLease(employeeNo: string): Promise<LeaseResult> {
  const { LEASE_API_URL: base, LEASE_API_TOKEN_ID: id, LEASE_API_TOKEN_SECRET: secret } = config;
  if (!base || !id || !secret) return { kind: 'pending', code: 'LEASE_UNAVAILABLE' };

  let url: URL;
  try {
    // URL は設定値だけから組み立てる。社員番号はクエリとして渡すが、API が絞り込まなくても
    // 応答側で照合するので結果は変わらない。
    url = new URL(base);
    url.searchParams.set('employee_no', employeeNo);
    url.searchParams.set('limit', '2000');
  } catch {
    return { kind: 'pending', code: 'LEASE_UNAVAILABLE' };
  }

  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'CF-Access-Client-Id': id,
        'CF-Access-Client-Secret': secret,
      },
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return { kind: 'pending', code: 'LEASE_UNAVAILABLE' };
    // 資格情報が受理されないと Access のログイン画面（200 HTML）が返るので、JSON 失敗も同じ扱い。
    const body: unknown = await response.json();
    return evaluateLeaseResponse(body, employeeNo, new Date(), config.LEASE_MAX_AGE_HOURS);
  } catch {
    return { kind: 'pending', code: 'LEASE_UNAVAILABLE' };
  }
}
