import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticateUi } from '../auth/ui.js';
import { sql } from '../db.js';
import { badRequest, forbidden } from '../errors.js';
import { appendAudit } from '../lib/audit-log.js';
import { jsonbValue } from '../lib/jsonb-value.js';

/**
 * 運用統合 UI のシステム設定（docs/100 P6）。
 *
 * - これまで各ブラウザの localStorage にあった設定を **サーバの 1 行**に移す。
 * - 変更できるのは承認者のみ。変更は監査に残す。
 * - 秘密値は置かない（通知先・パスワード等は別管理）。
 */

export interface OpsSettings {
  thHigh: number;
  thLow: number;
  candMin: number;
  sla: { P1: number; P2: number; P3: number; P4: number };
  std: { forti: string; dc: string };
  pc: boolean;
  remote: boolean;
  motion: boolean;
}

export const DEFAULT_SETTINGS: OpsSettings = {
  thHigh: 0.42,
  thLow: 0.22,
  candMin: 0.1,
  sla: { P1: 60, P2: 240, P3: 480, P4: 4320 },
  std: { forti: '7.2.10', dc: '5.4.2' },
  pc: true,
  remote: true,
  motion: true,
};

const SettingsSchema = z.object({
  thHigh: z.number().min(0).max(1),
  thLow: z.number().min(0).max(1),
  candMin: z.number().min(0).max(1),
  sla: z.object({
    P1: z.number().int().min(1).max(100000),
    P2: z.number().int().min(1).max(100000),
    P3: z.number().int().min(1).max(100000),
    P4: z.number().int().min(1).max(100000),
  }),
  std: z.object({
    forti: z.string().trim().min(1).max(40),
    dc: z.string().trim().min(1).max(40),
  }),
  pc: z.boolean(),
  remote: z.boolean(),
  motion: z.boolean(),
});

/** 失敗したら既定値で動く（画面を止めない）。 */
export async function loadSettings(): Promise<OpsSettings> {
  const rows = await sql<{ value: unknown }[]>`
    SELECT value FROM ops_settings WHERE key = 'ui' LIMIT 1
  `;
  const stored = rows[0]?.value;
  if (!stored || typeof stored !== 'object') return DEFAULT_SETTINGS;
  return { ...DEFAULT_SETTINGS, ...(stored as Partial<OpsSettings>) };
}

export async function opsSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/ops/settings', { preHandler: authenticateUi }, async () => {
    return { ok: true, settings: await loadSettings() };
  });

  app.put('/ops/settings', { preHandler: authenticateUi }, async (request) => {
    if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
    const email = request.uiEmail;
    const roles = request.uiRoles ?? [];
    if (!roles.includes('approver')) {
      throw forbidden('システム設定を変更できるのは承認者のみです。');
    }
    const next = SettingsSchema.parse(request.body ?? {});
    if (!(next.thLow < next.thHigh)) {
      throw badRequest('「候補を提示する下限」は「手順を提示する一致度」より小さくしてください。');
    }
    if (!(next.candMin <= next.thLow)) {
      throw badRequest('「ほかの手順として出す下限」は「候補を提示する下限」以下にしてください。');
    }
    const { P1, P2, P3, P4 } = next.sla;
    if (!(P1 < P2 && P2 < P3 && P3 < P4)) {
      throw badRequest('SLA は P1＜P2＜P3＜P4 の順にしてください。');
    }
    const before = await loadSettings();
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO ops_settings (key, value, updated_by, updated_at)
        VALUES ('ui', ${jsonbValue(next)}, ${email}, now())
        ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
      `;
      const changed = (Object.keys(next) as (keyof OpsSettings)[]).filter(
        (key) => JSON.stringify(before[key]) !== JSON.stringify(next[key]),
      );
      await appendAudit(tx, {
        actorId: null,
        action: 'ops.settings.update',
        targetType: 'ops_settings',
        targetId: 'ui',
        detail: { email, changed },
      });
    });
    return { ok: true, settings: await loadSettings() };
  });
}
