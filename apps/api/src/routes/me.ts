import type { FastifyInstance } from 'fastify';
import { emailVariants } from '../auth/email-alias.js';
import { authenticateUi } from '../auth/ui.js';
import { badRequest } from '../errors.js';
import { findEmployeeByEmail } from '../lib/mirai-info.js';
import { checkRateLimit } from '../lib/rate-limit.js';

/**
 * ログインした本人の社員情報。
 * - Cloudflare Access のメール（request.uiEmail）から名簿を引き、氏名・所属・社員番号だけ返す。
 * - メールアドレスは返さない（PII を増やさない）。
 * - 見つからない場合は employee=null（画面は従来どおり手動選択にフォールバックする）。
 */
export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.get('/me', { preHandler: authenticateUi }, async (request) => {
    if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
    if (!checkRateLimit(`me:${request.uiEmail}`, 60, 60_000)) {
      const error = new Error('本人情報の取得が多すぎます。少し待ってください。');
      (error as Error & { statusCode?: number }).statusCode = 429;
      throw error;
    }
    // 別名（同一人物の別メール）でも同じ社員に解決する。
    let employee = null;
    for (const candidate of emailVariants(request.uiEmail)) {
      employee = await findEmployeeByEmail(candidate);
      if (employee) break;
    }
    return {
      ok: true,
      employee,
      // V-01: UI がロール集合（複数ロール）を取得できるようにする。users に居ない
      // アカウントは空配列（従来どおり「ロール無し」）。判定はサーバ側が正本。
      roles: request.uiRoles ?? [],
      source: 'mirai-info.employee_directory',
    };
  });
}
