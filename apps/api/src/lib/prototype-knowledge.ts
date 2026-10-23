import { z } from 'zod';
import type { KnowledgeLike } from '../domain/ai.js';

/**
 * 画面（既存プロトタイプのヘルプデスク）で承認・公開したナレッジを、AI 回答の根拠に使う。
 * 状態は prototype_states(name = 'helpdesk') の data.kb に保存されている。
 * - status = 'active'（承認済み・使用中）のみ。使用停止中は使わない。
 * - ユーザー（Access メール）単位の状態なので、他ユーザーの承認内容は混ざらない。
 * - 形が不正な要素は捨てる（状態はブラウザから送られる JSON のため）。
 */
const MAX_ITEMS = 200;

const text = (max: number) => z.string().trim().min(1).max(max);

const PrototypeKbSchema = z.object({
  id: z.string().regex(/^KB-[0-9A-Za-z-]{1,32}$/),
  title: text(200),
  symptom: z.string().max(2000).default(''),
  cause: z.string().max(2000).default(''),
  steps: z.union([z.array(z.string().max(1000)).max(50), z.string().max(8000)]).default([]),
  keywords: z.array(z.string().max(60)).max(50).default([]),
  status: z.string(),
});

export function extractPrototypeKnowledge(state: unknown): KnowledgeLike[] {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return [];
  const kb = (state as { kb?: unknown }).kb;
  if (!Array.isArray(kb)) return [];

  const result: KnowledgeLike[] = [];
  for (const raw of kb.slice(0, MAX_ITEMS)) {
    const parsed = PrototypeKbSchema.safeParse(raw);
    if (!parsed.success || parsed.data.status !== 'active') continue;
    const item = parsed.data;
    const steps = Array.isArray(item.steps)
      ? item.steps
          .map((step) => step.trim())
          .filter(Boolean)
          .map((step, index) => `${index + 1}. ${step}`)
          .join('\n')
      : item.steps;
    result.push({
      id: `prototype:${item.id}`,
      kbNo: item.id,
      title: item.title,
      symptom: item.symptom,
      cause: item.cause,
      steps,
      keywords: item.keywords.map((keyword) => keyword.trim()).filter(Boolean),
    });
  }
  return result;
}

export async function loadPrototypeKnowledge(tx: any, email: string): Promise<KnowledgeLike[]> {
  const rows: Array<{ data: unknown }> = await tx`
    SELECT data FROM prototype_states WHERE user_email = ${email} AND name = 'helpdesk'
  `;
  let data = rows[0]?.data;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      return [];
    }
  }
  return extractPrototypeKnowledge(data);
}
