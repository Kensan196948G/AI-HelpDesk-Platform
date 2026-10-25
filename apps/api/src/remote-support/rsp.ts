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
