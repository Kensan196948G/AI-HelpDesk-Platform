import type { KnowledgeLike } from '../domain/ai.js';

/**
 * 承認済みナレッジ候補を、相談文と意図キーワードでスコアリングして上位を返す。
 * 日本語の形態素解析は行わず、意図キーワードと既知のキーワード配列で照合する（MVP）。
 */
export function scoreKnowledge(
  candidates: KnowledgeLike[],
  text: string,
  intentKeywords: string[],
  limit = 3,
): KnowledgeLike[] {
  const lowerText = text.toLowerCase();
  const tokens = new Set(
    intentKeywords.map((keyword) => keyword.toLowerCase()).filter((keyword) => keyword.length >= 2),
  );

  return candidates
    .map((knowledge) => {
      const haystack =
        `${knowledge.title}\n${knowledge.symptom}\n${knowledge.cause}\n${knowledge.keywords.join(' ')}`.toLowerCase();
      // 相談文に含まれる「専門キーワード」の一致を最優先する。
      // 「手順」のような一般語だけで他のKBが上位に来るのを防ぐ。
      let specific = 0;
      for (const keyword of knowledge.keywords) {
        if (keyword && lowerText.includes(keyword.toLowerCase())) specific += 4;
      }
      let contextual = 0;
      for (const token of tokens) {
        if (haystack.includes(token)) contextual += 1;
      }
      for (const keyword of intentKeywords) {
        if (knowledge.title.includes(keyword) || knowledge.symptom.includes(keyword)) {
          contextual += 1;
        }
      }
      return { knowledge, score: specific + contextual };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.knowledge);
}

/**
 * DB の承認済みナレッジ（knowledge.status = 'approved'）と、
 * 呼び出し元が渡す追加候補（例: 画面で承認したナレッジ）をまとめて検索する。
 */
export async function findApprovedKnowledge(
  tx: any,
  text: string,
  intentKeywords: string[],
  extra: KnowledgeLike[] = [],
): Promise<KnowledgeLike[]> {
  const rows: any[] = await tx`
    SELECT id, kb_no, title, symptom, cause, steps, keywords
    FROM knowledge
    WHERE status = 'approved'
    ORDER BY updated_at DESC
    LIMIT 100
  `;

  const fromDb: KnowledgeLike[] = rows.map((row) => ({
    id: row.id,
    kbNo: row.kb_no,
    title: row.title,
    symptom: row.symptom,
    cause: row.cause,
    steps: row.steps,
    keywords: row.keywords ?? [],
  }));
  const seen = new Set(fromDb.map((knowledge) => knowledge.kbNo));
  const candidates = [...fromDb, ...extra.filter((knowledge) => !seen.has(knowledge.kbNo))];
  return scoreKnowledge(candidates, text, intentKeywords);
}
