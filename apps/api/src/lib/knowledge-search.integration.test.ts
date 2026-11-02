import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../config.js';
import { sql } from '../db.js';
import { composeAssessment, detectIntent } from '../domain/ai.js';
import { findApprovedKnowledge, MIN_SCORE, scoreKnowledge } from './knowledge-search.js';

/**
 * 一致点の下限で、案件診断（cases.ts）と AI の KB 提示が失われないことを、
 * 評価ハーネスと同じ相談集（scripts/eval/cases.jsonl）とシードの KB で確かめる。
 */
const cases = readFileSync(path.join(repoRoot, 'scripts/eval/cases.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line) as { id: string; text: string; mustCite?: string });

describe(`一致点の下限（${MIN_SCORE}）と KB 提示`, () => {
  const expected = cases.filter((testCase) => testCase.mustCite);

  it('評価の相談集に出典の期待値がある', () => {
    expect(expected.length).toBeGreaterThanOrEqual(15);
  });

  it('期待される KB を、下限で落とさない（案件診断の根拠にも残る）', async () => {
    const lost: string[] = [];
    for (const testCase of expected) {
      const intent = detectIntent('', testCase.text);
      const knowledge = await findApprovedKnowledge(sql, testCase.text, intent.keywords);
      const kbNos = knowledge.map((item) => item.kbNo);
      if (!kbNos.includes(String(testCase.mustCite))) lost.push(`${testCase.id}:${kbNos}`);
      const assessment = composeAssessment({
        category: 'other',
        subject: '',
        body: testCase.text,
        urgency: 'normal',
        pc: null,
        knowledge,
      } as Parameters<typeof composeAssessment>[0]);
      if (!assessment.security && knowledge.length > 0) {
        expect(assessment.sources.length, testCase.id).toBe(1);
      }
    }
    expect(lost).toEqual([]);
  });

  it('下限を 1 にしても増えるのは「意図語が 1 回だけ一致した」候補で、1 位は変わらない', async () => {
    const rows = await sql<any[]>`
      SELECT id, kb_no, title, symptom, cause, steps, keywords FROM knowledge
      WHERE status = 'approved'
    `;
    const candidates = rows.map((row) => ({
      id: row.id,
      kbNo: row.kb_no,
      title: row.title,
      symptom: row.symptom,
      cause: row.cause,
      steps: row.steps,
      keywords: row.keywords ?? [],
    }));
    for (const testCase of cases) {
      const intent = detectIntent('', testCase.text);
      const strict = scoreKnowledge(candidates, testCase.text, intent.keywords);
      const loose = scoreKnowledge(candidates, testCase.text, intent.keywords, 3, 1);
      if (strict.length > 0) expect(strict[0]?.kbNo, testCase.id).toBe(loose[0]?.kbNo);
    }
  });
});
