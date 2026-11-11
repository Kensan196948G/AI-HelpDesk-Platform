import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireHelpdeskActor } from '../auth/helpdesk-scope.js';
import { authenticateUi } from '../auth/ui.js';
import { previewIntake } from '../domain/intake-preview.js';
import { badRequest } from '../errors.js';

/**
 * 代行受付の入力チェック（読み取り専用）。
 * AI を呼ばず、`domain/signal.ts` と `domain/pii.ts` の既存規則だけを使う。
 * 画面の入力中に呼ばれるため、DB も読まない（docs/97）。
 */
const CategorySchema = z.enum([
  'pc_network',
  'account',
  'file_share',
  'procedure',
  'security',
  'other',
]);

const PreviewSchema = z.object({
  subject: z.string().max(4000).default(''),
  body: z.string().max(8000).default(''),
  category: CategorySchema.optional(),
  urgency: z.enum(['normal', 'urgent']).optional(),
});

export async function intakeRoutes(app: FastifyInstance): Promise<void> {
  app.post('/intake/preview', { preHandler: authenticateUi }, async (request) => {
    if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
    await requireHelpdeskActor(request.uiEmail);
    const input = PreviewSchema.parse(request.body ?? {});
    return previewIntake(input);
  });
}
