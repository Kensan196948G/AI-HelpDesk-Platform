import type { FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { forbidden, unauthorized } from '../errors.js';

/**
 * プロトタイプ UI / 状態保存 / AI 用の認証。
 * - cloudflare-access: Cloudflare Access が付与する email ヘッダだけを信頼する。
 * - local: 開発・テスト用に DEV_AUTH_EMAIL を使う。
 * アプリ内のパスワードログインは行わない。
 */
export async function authenticateUi(request: FastifyRequest): Promise<void> {
  if (config.AUTH_MODE === 'cloudflare-access') {
    const raw = request.headers['cf-access-authenticated-user-email'];
    const header = Array.isArray(raw) ? raw[0] : raw;
    if (!header || typeof header !== 'string' || !header.trim()) {
      throw unauthorized('Cloudflare Access の認証が必要です。');
    }
    const email = header.trim().toLowerCase();
    if (config.ACCESS_ALLOWED_EMAIL && email !== config.ACCESS_ALLOWED_EMAIL.toLowerCase()) {
      throw forbidden('このメールアドレスは許可されていません。');
    }
    request.uiEmail = email;
    return;
  }
  request.uiEmail = config.DEV_AUTH_EMAIL.toLowerCase();
}
