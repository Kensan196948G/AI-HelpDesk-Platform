import type { FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { forbidden, unauthorized } from '../errors.js';
import { AccessJwtError, verifyAccessJwt } from './access-jwt.js';
import { getAllowlist, isEmailAllowed } from './allowlist.js';
import { canonicalEmail } from './email-alias.js';
import { loadRolesByEmail } from './roles.js';
import { assertNotAuditorWrite } from './session.js';
import type { AuthUser, Role } from './types.js';

/**
 * UI 経路のロール集合キャッシュ（docs/49 §3）。
 * UI は多数の API を呼ぶため、毎回 users/user_roles を引かないよう 30 秒だけ保持する。
 * ロール変更（sync-roles）の反映は最大 30 秒遅れるが、付与・剥奪とも業務を止めない。
 */
const ROLE_CACHE_TTL_MS = 30_000;
const roleCache = new Map<string, { roles: Role[] | null; expiresAt: number }>();

async function rolesForUi(email: string): Promise<Role[] | null> {
  const now = Date.now();
  const cached = roleCache.get(email);
  if (cached && cached.expiresAt > now) return cached.roles;
  const roles = await loadRolesByEmail(email);
  roleCache.set(email, { roles, expiresAt: now + ROLE_CACHE_TTL_MS });
  return roles;
}

/** テスト用: キャッシュを空にする。 */
export function clearUiRoleCache(): void {
  roleCache.clear();
}

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
  } else {
    request.loginEmail = config.DEV_AUTH_EMAIL.toLowerCase();
    request.uiEmail = canonicalEmail(request.loginEmail);
  }
  await applyUiRoles(request);
}

/**
 * UI 経路にもロール集合を適用する（docs/49 §3）。
 * - `request.uiRoles` に集合を載せる（今後の UI 側の権限分けの土台）。
 * - `auditor` は API 経路と同じく読み取り専用にする（書込みは 403）。
 * users に居ないアカウント（シード外・デモ）は従来どおり（ロール無し）。
 */
async function applyUiRoles(request: FastifyRequest): Promise<void> {
  const email = request.uiEmail;
  if (!email) return;
  const roles = await rolesForUi(email);
  if (!roles) return;
  request.uiRoles = roles;
  if (roles.includes('auditor')) {
    assertNotAuditorWrite({ role: 'auditor', roles } as AuthUser, request);
  }
}
