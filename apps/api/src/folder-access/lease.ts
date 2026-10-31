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
      meshNodeId: string | null;
    }
  | { kind: 'pending'; code: LeasePendingCode };

// Mirai-Info の契約（Mirai-Info PR #262 / docs/CONSUMER-GUIDE.md）。
const RecordSchema = z.object({
  hostname: z.string().nullable().optional(),
  asset_tag: z.string().nullable().optional(),
  employee_no: z.string().nullable().optional(),
  mesh_node_id: z.string().nullable().optional(),
  employee_active: z.boolean().nullable().optional(),
  lease_active: z.boolean().nullable().optional(),
});

const ResponseSchema = z.object({
  ok: z.literal(true),
  source: z.string().optional(),
  generatedAt: z.string().nullable().optional(),
  // 絞り込み未対応の旧プロセスは filter を返さず全件を返すので、確定に使わない。
  filter: z.object({ employee_no: z.string() }).optional(),
  dataAsOf: z
    .object({ employeeDirectoryLastSeenAt: z.string().nullable().optional() })
    .optional(),
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
  const { records, generatedAt: generatedRaw, source, filter, dataAsOf } = parsed.data;

  // 絞り込みが効いていない応答（旧プロセス）は確定に使わない。
  if (filter?.employee_no !== employeeNo) return { kind: 'pending', code: 'LEASE_UNAVAILABLE' };
  if (records.some((record) => record.employee_no?.trim() !== employeeNo)) {
    return { kind: 'pending', code: 'LEASE_UNAVAILABLE' };
  }

  // 鮮度は名簿の最終取得時刻で判定する。generatedAt は応答の組み立て時刻で鮮度の根拠にならない。
  const generatedAt = generatedRaw ? new Date(generatedRaw) : null;
  const dataAt = dataAsOf?.employeeDirectoryLastSeenAt
    ? new Date(dataAsOf.employeeDirectoryLastSeenAt)
    : null;
  if (
    !generatedAt ||
    Number.isNaN(generatedAt.getTime()) ||
    !dataAt ||
    Number.isNaN(dataAt.getTime())
  ) {
    return { kind: 'pending', code: 'LEASE_STALE' };
  }
  const age = now.getTime() - dataAt.getTime();
  if (age > maxAgeHours * 3_600_000 || age < -FUTURE_TOLERANCE_MS) {
    return { kind: 'pending', code: 'LEASE_STALE' };
  }

  // 現貸与と認めるのは employee_active と lease_active がともに true の行だけ。
  const mine = records.filter(
    (record) =>
      record.employee_active === true &&
      record.lease_active === true &&
      normalizedHostname(record.hostname),
  );
  if (mine.length === 0) return { kind: 'pending', code: 'LEASE_NONE' };
  if (mine.length > 1) return { kind: 'pending', code: 'LEASE_MULTIPLE' };
  const record = mine[0];
  const hostname = record?.hostname?.trim();
  if (!record || !hostname) return { kind: 'pending', code: 'LEASE_NONE' };

  return {
    kind: 'verified',
    hostname,
    assetTag: record.asset_tag?.trim() || null,
    source: source ?? 'unknown',
    fetchedAt: now,
    generatedAt,
    // 手掛かりとして保存する。同一性は RSP で確認する。
    meshNodeId: record.mesh_node_id?.trim() || null,
  };
}

export async function fetchLease(employeeNo: string): Promise<LeaseResult> {
  const { LEASE_API_URL: base, LEASE_API_TOKEN_ID: id, LEASE_API_TOKEN_SECRET: secret } = config;
  if (!base || !id || !secret) return { kind: 'pending', code: 'LEASE_UNAVAILABLE' };

  let url: URL;
  try {
    // URL は設定値だけから組み立てる。社員番号はクエリとして渡す。API が絞り込まなくても
    // 応答側で照合するので結果は変わらない。
    url = new URL(base);
    url.searchParams.set('employee_no', employeeNo);
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
