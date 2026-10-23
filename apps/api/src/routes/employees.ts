import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticateUi } from '../auth/ui.js';
import { badRequest } from '../errors.js';
import { listEmployees } from '../lib/mirai-info.js';
import { checkRateLimit } from '../lib/rate-limit.js';

const ScopeSchema = z.enum(['staff', 'all']).catch('all');

export async function employeeRoutes(app: FastifyInstance): Promise<void> {
  // 社員選択用の名簿（氏名・部署・社員番号）。メール等は返さない。
  app.get('/employees', { preHandler: authenticateUi }, async (request) => {
    if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
    if (!checkRateLimit(`employees:${request.uiEmail}`, 60, 60_000)) {
      const error = new Error('社員名簿の取得が多すぎます。少し待ってください。');
      (error as Error & { statusCode?: number }).statusCode = 429;
      throw error;
    }
    const scope = ScopeSchema.parse((request.query as { scope?: string })?.scope);
    const result = await listEmployees(scope);
    return { ok: !result.error, scope, ...result, source: 'mirai-info.employee_directory' };
  });
}
