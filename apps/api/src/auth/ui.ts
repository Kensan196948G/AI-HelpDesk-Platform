import type { FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { forbidden, unauthorized } from '../errors.js';
import { AccessJwtError, verifyAccessJwt } from './access-jwt.js';
import { getAllowlist, isEmailAllowed } from './allowlist.js';
import { canonicalEmail } from './email-alias.js';

let reportedJwtSuccess = false;

/**
 * Cloudflare Access の JWT を検証する（ACCESS_JWT_MODE）。
 * - enforce: 署名・aud・iss・期限・email の一致を満たさなければ 401。
 * - report: 結果をログに出すだけで通す（本番適用前の確認用）。
 */
async function checkAccessJwt(request: FastifyRequest, email: string): Promise<void> {
  if (config.ACCESS_JWT_MODE === 'off' || !config.ACCESS_TEAM_DOMAIN || !config.ACCESS_AUD) {
    return;
  }
  const raw = request.headers['cf-access-jwt-assertion'];
  const token = Array.isArray(raw) ? raw[0] : raw;
  let reason: string | null = null;
  try {
    if (!token) throw new AccessJwtError('JWT がありません');
    const claims = await verifyAccessJwt(token, {
      teamDomain: config.ACCESS_TEAM_DOMAIN,
      audience: config.ACCESS_AUD,
    });
    if (claims.email?.trim().toLowerCase() !== email) {
      throw new AccessJwtError('JWT の email がヘッダーと一致しません');
    }
  } catch (error) {
    reason = error instanceof AccessJwtError ? error.message : 'JWT を検証できませんでした';
  }

  if (!reason) {
    if (!reportedJwtSuccess) {
      reportedJwtSuccess = true;
      request.log.info({ mode: config.ACCESS_JWT_MODE }, 'Cloudflare Access JWT を検証しました。');
    }
    return;
  }
  request.log.warn({ mode: config.ACCESS_JWT_MODE, reason }, 'Cloudflare Access JWT の検証に失敗');
  if (config.ACCESS_JWT_MODE === 'enforce') {
    throw unauthorized('Cloudflare Access の認証を確認できませんでした。');
  }
}

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
  await checkAccessJwt(request, email);
  request.uiEmail = email;
}

/**
 * プロトタイプ UI / 状態保存 / AI 用の認証。
 * - cloudflare-access: Access の email ヘッダー + 許可リスト（+ JWT 検証）。
 * - local: 開発・テスト用に DEV_AUTH_EMAIL を使う（本番では config が起動を拒否する）。
 * アプリ内のパスワードログインは行わない。
 */
export async function authenticateUi(request: FastifyRequest): Promise<void> {
  if (config.AUTH_MODE === 'cloudflare-access') {
    await requireCloudflareAccess(request);
    // 同一人物の複数メールを 1 つの状態・権限に正規化する（表示用に元のメールも残す）。
    request.loginEmail = request.uiEmail;
    request.uiEmail = canonicalEmail(request.uiEmail);
    return;
  }
  request.loginEmail = config.DEV_AUTH_EMAIL.toLowerCase();
  request.uiEmail = canonicalEmail(request.loginEmail);
}
