import { sameHuman } from '../auth/shared-identity.js';
import { type KnowledgeLike, keywordForms } from '../domain/ai.js';
import { redactPII } from '../domain/pii.js';

/**
 * これ未満の一致は根拠にしない。原因欄に意図語が 1 回出るだけの KB まで外部 AI へ送らない。
 * 専門キーワードの一致は 1 語で 4 点なので、この下限にはかからない。
 */
const MIN_SCORE = 2;

/**
 * 画面経路の KB は keywords が空で保存される（原本の draftForSync が返さない）。
 * 空なら題名から語を取り出して照合する。保存値は変えない。
 * 「起動」「対処」のような 2 文字の一般語で無関係な KB を拾わないよう、3 文字以上に限る。
 */
export function keywordsFromTitle(title: string): string[] {
  const terms = title.match(/[\p{Script=Han}\p{Script=Katakana}A-Za-z0-9ー]{3,}/gu) ?? [];
  return [...new Set(terms)];
}

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
    intentKeywords
      .flatMap((keyword) => keywordForms(keyword))
      .filter((keyword) => keyword.length >= 2),
  );

  return candidates
    .map((knowledge) => {
      const haystack =
        `${knowledge.title}\n${knowledge.symptom}\n${knowledge.cause}\n${knowledge.keywords.join(' ')}`.toLowerCase();
      // 相談文に含まれる「専門キーワード」の一致を最優先する。
      // 「手順」のような一般語だけで他のKBが上位に来るのを防ぐ。
      // 活用差（遅い／遅く）は keywordForms で吸収する。
      let specific = 0;
      for (const keyword of knowledge.keywords) {
        if (keyword && keywordForms(keyword).some((form) => lowerText.includes(form)))
          specific += 4;
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
    .filter((entry) => entry.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.knowledge);
}

/**
 * AI の根拠にしてよい DB のナレッジを検索する。ブラウザが送る state は読まない。
 *
 * - status = 'approved' で、承認者と承認時刻が記録されている。
 * - 承認者 ≠ 作成者（職務分離）。別アカウントでも同一人物（SHARED_IDENTITY_GROUPS）は除く。
 * - 承認時の版のまま（approved_at より後に行が更新されていない）。承認と version 加算は
 *   同じトランザクションなので、updated_at（トリガ）は approved_at と一致する。
 * - 本文は DB の行から取り、外へ出す前に改めて伏せ字にする。
 */
export async function findApprovedKnowledge(
  tx: any,
  text: string,
  intentKeywords: string[],
): Promise<KnowledgeLike[]> {
  const rows: any[] = await tx`
    SELECT k.id, k.kb_no, k.title, k.symptom, k.cause, k.steps, k.keywords, k.version,
           au.email AS author_email, pu.email AS approver_email
    FROM knowledge k
    LEFT JOIN users au ON au.id = k.author_id
    LEFT JOIN users pu ON pu.id = k.approver_id
    WHERE k.status = 'approved'
      AND k.approver_id IS NOT NULL
      AND k.approved_at IS NOT NULL
      AND k.approver_id <> k.author_id
      AND k.version >= 1
      AND k.updated_at <= k.approved_at
    ORDER BY k.updated_at DESC
    LIMIT 100
  `;

  const candidates: KnowledgeLike[] = rows
    .filter((row) => !sameHuman(row.author_email, row.approver_email))
    .map((row) => ({
      id: row.id,
      kbNo: row.kb_no,
      title: redactPII(row.title).text,
      symptom: redactPII(row.symptom).text,
      cause: redactPII(row.cause).text,
      steps: redactPII(row.steps).text,
      keywords: row.keywords?.length ? row.keywords : keywordsFromTitle(row.title),
      version: row.version,
    }));
  return scoreKnowledge(candidates, text, intentKeywords);
}
