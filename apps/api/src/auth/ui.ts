import type { FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { forbidden, unauthorized } from '../errors.js';
import { getAllowlist, isEmailAllowed } from './allowlist.js';

/**
 * Cloudflare Access が付与する email ヘッダーを検証する。
 * Cloudflare Access の allow ポリシーだけに依存せず、
 * `docs/MailAddress.txt`（ACCESS_ALLOWLIST_FILE）の許可リストでも照合する。
 * 許可リストが無い・空の場合は全拒否（fail-closed）。
 */
export async function requireCloudflareAccess(request: FastifyRequest): Promise<void> {
  const raw = request.headers['cf-access-authenticated-user-email'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (!header || typeof header !== 'string' || !header.trim()) {
    throw unauthorized('Cloudflare Access の認証が必要です。');
  }

  const email = header.trim().toLowerCase();
  if (!isEmailAllowed(getAllowlist(), email)) {
    throw forbidden('このメールアドレスは許可されていません。');
  }
  request.uiEmail = email;
}

/**
 * プロトタイプ UI / 状態保存 / AI 用の認証。
 * - cloudflare-access: Access の email ヘッダー + 許可リスト。
 * - local: 開発・テスト用に DEV_AUTH_EMAIL を使う。
 * アプリ内のパスワードログインは行わない。
 */
export async function authenticateUi(request: FastifyRequest): Promise<void> {
  if (config.AUTH_MODE === 'cloudflare-access') {
    await requireCloudflareAccess(request);
    return;
  }
  request.uiEmail = config.DEV_AUTH_EMAIL.toLowerCase();
}
