import { config } from '../config.js';
import { ApiError } from '../errors.js';

/** RSP の端末検索結果（PII なし）。 */
export interface RspDeviceMatch {
  device_id: string;
  hostname: string;
  agent_installed: boolean;
  agent_online: boolean;
  mesh_deploy_status: string | null;
}

/** RSP ensure-agent の結果。 */
export interface RspEnsureResult extends RspDeviceMatch {
  triggered_deploy: boolean;
  retrigger_suppressed: boolean;
  mesh_node_id: string | null;
  ping_ok: boolean;
  winrm_ok: boolean;
}

function rspBaseUrl(): string {
  return config.RSP_BASE_URL.replace(/\/$/, '');
}

function serviceKey(): string {
  const key = config.RSP_SERVICE_KEY;
  if (!key) {
    throw new ApiError(
      503,
      'RSP_NOT_CONFIGURED',
      '遠隔対応の連携が未設定です（RSP_SERVICE_KEY）。管理者に連絡してください。',
    );
  }
  return key;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${rspBaseUrl()}${path}`, {
      ...init,
      headers: {
        'X-RSP-Service-Key': serviceKey(),
        Accept: 'application/json',
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(8000),
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      502,
      'RSP_UNAVAILABLE',
      'RSP に接続できませんでした。時間をおいて再試行してください。',
    );
  }
  const body = (await response.json().catch(() => null)) as {
    success?: boolean;
    data?: unknown;
    error_code?: string;
    message?: string;
  } | null;
  if (!response.ok || !body) {
    const code = body?.error_code ?? 'RSP_UNAVAILABLE';
    const message =
      body?.message ??
      (response.status === 401 || response.status === 403
        ? 'RSP のサービス認証に失敗しました。管理者に連絡してください。'
        : 'RSP でエラーが発生しました。時間をおいて再試行してください。');
    throw new ApiError(502, code, message);
  }
  return body.data as T;
}

/** hostname（完全一致・大小文字無視）で RSP 端末を検索する。 */
export async function lookupRspDevices(
  hostname: string,
): Promise<{ count: number; matches: RspDeviceMatch[] }> {
  return request(`/api/v1/service/devices?hostname=${encodeURIComponent(hostname)}`);
}

/** MeshAgent の導入状態を確認し、未導入なら展開キューへ投入する。 */
export async function ensureRspAgent(rspDeviceId: string): Promise<RspEnsureResult> {
  return request(`/api/v1/service/devices/${encodeURIComponent(rspDeviceId)}/ensure-agent`, {
    method: 'POST',
  });
}

/** RSP のコマンド実行ログ相関（SM-09）。PII は最小限（担当者メールのみ）。 */
export interface RspCommandCorrelation {
  logId: string;
  deviceId: string;
  hostname: string;
  status: string;
  channel: string;
  operatorEmail: string | null;
  createdAt: string | null;
}

export type RspCorrelationResult =
  | { kind: 'ok'; correlation: RspCommandCorrelation }
  | { kind: 'not_found' }
  | { kind: 'unavailable'; reason: string };

/** 相関確認に必要な設定（サービスキー）があるか。RSP_BASE_URL は既定値を持つ。 */
export function isRspConfigured(): boolean {
  return Boolean(config.RSP_SERVICE_KEY);
}

/**
 * コマンド実行ログの相関情報を RSP から取得する（SM-09）。
 * - 200: 実行端末（hostname）などを返す
 * - 404: 存在しない log_id（not_found）
 * - それ以外（タイムアウト・5xx・不正応答）: unavailable（呼び出し側は記録を許可し警告）
 *
 * URL は設定値（RSP_BASE_URL）だけから組み立て、log_id は encodeURIComponent する（SSRF 対策）。
 */
export async function fetchRspCommandCorrelation(logId: string): Promise<RspCorrelationResult> {
  if (!isRspConfigured()) {
    return { kind: 'unavailable', reason: 'RSP のサービスキーが未設定です。' };
  }
  const url = `${rspBaseUrl()}/api/v1/service/commands/${encodeURIComponent(logId)}/correlation`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        'X-RSP-Service-Key': serviceKey(),
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return { kind: 'unavailable', reason: 'RSP に接続できませんでした。' };
  }
  const body = (await response.json().catch(() => null)) as {
    success?: boolean;
    data?: unknown;
    error_code?: string;
    message?: string;
  } | null;
  if (response.status === 404) return { kind: 'not_found' };
  if (!response.ok || !body || body.success !== true || !body.data) {
    return { kind: 'unavailable', reason: `RSP が HTTP ${response.status} を返しました。` };
  }
  if (typeof body.data !== 'object') {
    return { kind: 'unavailable', reason: 'RSP の応答形式が不正です。' };
  }
  const data = body.data as Record<string, unknown>;
  const hostname = String(data.hostname ?? '').trim();
  if (!hostname) {
    return { kind: 'unavailable', reason: 'RSP の応答に hostname がありません。' };
  }
  return {
    kind: 'ok',
    correlation: {
      logId: String(data.log_id ?? logId),
      deviceId: String(data.device_id ?? ''),
      hostname,
      status: String(data.status ?? ''),
      channel: String(data.channel ?? ''),
      operatorEmail: data.operator_email ? String(data.operator_email) : null,
      createdAt: data.created_at ? String(data.created_at) : null,
    },
  };
}
