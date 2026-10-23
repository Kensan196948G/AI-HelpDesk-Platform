import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { draftRemotePrompt } from '../ai/remote-prompt.js';
import { authenticateUi } from '../auth/ui.js';
import { config } from '../config.js';
import { ApiError, badRequest, forbidden } from '../errors.js';
import { findEmployeeByEmail } from '../lib/mirai-info.js';
import { checkRateLimit } from '../lib/rate-limit.js';

function isDemoAccount(email: string): boolean {
  return config.PERSONA_SWITCH_ALLOWLIST.split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .includes(email);
}

/**
 * 本番（cloudflare-access）では、案内文の下書きを DX推進部（ヘルプデスク）に限定する。
 * - 名簿が取得できない場合は fail-closed（403）。
 * - 開発・テスト（local）は従来どおり許可する。
 * - デモ用アカウント（PERSONA_SWITCH_ALLOWLIST）は名簿に無くても許可する。
 */
async function requireHelpdeskRole(email: string): Promise<void> {
  if (config.AUTH_MODE !== 'cloudflare-access') return;
  if (isDemoAccount(email)) return;
  const employee = await findEmployeeByEmail(email);
  if (!employee || employee.section !== 'DX推進部') {
    throw forbidden('遠隔支援の案内文はヘルプデスク担当（DX推進部）のみ利用できます。');
  }
}

const BodySchema = z.object({
  intent: z.string().trim().min(1).max(1000),
  context: z
    .object({
      caseId: z.string().trim().max(40).optional(),
      subject: z.string().max(500).optional(),
      body: z.string().max(8000).optional(),
      pcSummary: z.string().max(4000).optional(),
      priorPrompts: z.array(z.string().max(1000)).max(10).optional(),
    })
    .default({}),
});

/**
 * 遠隔支援（同意した範囲）で、担当者が相談者へ送る案内文の下書き。
 * - 文章を返すだけで、端末操作・コマンド実行は行わない。
 * - 端末の変更は、既存の許可リスト（SPOOLER_RESTART）と本人の Y/N 承認を通す。
 * - PII は送信前に伏せ字化する（ai/remote-prompt.ts）。
 */
export async function remoteAssistRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/ai/remote-prompt',
    { preHandler: authenticateUi, bodyLimit: 64 * 1024 },
    async (request) => {
      if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
      await requireHelpdeskRole(request.uiEmail);
      if (!checkRateLimit(`remote-prompt:${request.uiEmail}`, 20, 60_000)) {
        throw new ApiError(
          429,
          'RATE_LIMITED',
          '案内文の作成が多すぎます。少し待ってから再試行してください。',
        );
      }
      const input = BodySchema.parse(request.body);
      const draft = await draftRemotePrompt(input.intent, input.context);
      return { ok: true, draft };
    },
  );
}
