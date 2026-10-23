import type { KnowledgeLike } from '../domain/ai.js';

/**
 * 承認済みナレッジを、相談文と意図キーワードでスコアリングして返す。
 * 日本語の形態素解析は行わず、意図キーワードと既知のキーワード配列で照合する（MVP）。
 */
export async function findApprovedKnowledge(
  tx: any,
  text: string,
  intentKeywords: string[],
): Promise<KnowledgeLike[]> {
  const rows: any[] = await tx`
    SELECT id, kb_no, title, symptom, cause, steps, keywords
    FROM knowledge
    WHERE status = 'approved'
    ORDER BY updated_at DESC
    LIMIT 100
  `;

  const lowerText = text.toLowerCase();
  const tokens = new Set(
    intentKeywords.map((keyword) => keyword.toLowerCase()).filter((keyword) => keyword.length >= 2),
  );

  const scored = rows
    .map((row: any) => {
      const haystack =
        `${row.title}\n${row.symptom}\n${row.cause}\n${(row.keywords ?? []).join(' ')}`.toLowerCase();
      // 相談文に含まれる「専門キーワード」の一致を最優先する。
      // 「手順」のような一般語だけで他のKBが上位に来るのを防ぐ。
      let specific = 0;
      for (const keyword of (row.keywords ?? []) as string[]) {
        if (lowerText.includes(keyword.toLowerCase())) specific += 4;
      }
      let contextual = 0;
      for (const token of tokens) {
        if (haystack.includes(token)) contextual += 1;
      }
      for (const keyword of intentKeywords) {
        if (row.title.includes(keyword) || row.symptom.includes(keyword)) contextual += 1;
      }
      return { row, score: specific + contextual };
    })
    .filter((entry: { score: number }) => entry.score > 0)
    .sort((a: { score: number }, b: { score: number }) => b.score - a.score)
    .slice(0, 3);

  return scored.map(({ row }: { row: any }) => ({
    id: row.id,
    kbNo: row.kb_no,
    title: row.title,
    symptom: row.symptom,
    cause: row.cause,
    steps: row.steps,
    keywords: row.keywords ?? [],
  }));
}
