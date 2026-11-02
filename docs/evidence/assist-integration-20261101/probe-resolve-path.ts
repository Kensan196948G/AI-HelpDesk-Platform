/**
 * #120 の対策が resolve の経路（docs/67 の ②）に効いているかの確認。DB も通信も使わない。
 * 実行: npx tsx docs/evidence/assist-integration-20261101/probe-resolve-path.ts
 * 実行には NODE_ENV=test と .env.test.local が要る（config の読み込みのため）。
 */
import { fallbackPropose, proposalFromAiBody } from '../../../apps/api/src/resolve/proposer.js';
import { SKILL_CATALOG } from '../../../apps/api/src/resolve/skill-catalog.js';
import { acceptAiExplanation, buildCaseFacts } from '../../../apps/api/src/support-session/case-facts.js';

const skills = SKILL_CATALOG.filter((s) => s.id === 'spooler.status' || s.id === 'os.info').map(
  (s) => ({ ...s, contentHash: 'sha256:probe' }),
) as never[];
const texts = ['印刷エラーはありません', '昨日は印刷できなかったが今は印刷できます', '印刷できません'];
const symptom = texts.map((text) => ({
  text,
  path3_symptomTags: buildCaseFacts({ case: { subject: text } }).symptomTags,
  path2_ruleProposal: fallbackPropose({ text, lastSummary: null, history: [], skills })?.skillId ?? null,
}));
const rationale = '解決しました';
const body = { skillId: 'spooler.status', params: {}, rationale, decision: null };
console.log(
  JSON.stringify(
    {
      symptom,
      assertion: {
        rationale,
        path3_accepted: acceptAiExplanation(rationale, 'unknown', true),
        path2_rationale: proposalFromAiBody(body, { skills, history: [] })?.rationale ?? null,
      },
    },
    null,
    2,
  ),
);
