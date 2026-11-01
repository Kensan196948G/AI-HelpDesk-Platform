import {
  type ApprovalManifest,
  type ApprovedSkillEntry,
  computeSkillDefinitionHash,
  SKILL_CATALOG,
  type SkillDefinition,
} from '../resolve/skill-catalog.js';
import { ASSIST_SKILLS } from './assist-catalog.js';

/**
 * Skill の人間レビュー承認の計算（scripts/approve-skills.ts の本体）。ファイルを書かない。
 * 全書換えで以前の承認を失わないように、対象外の行と変更のない行はそのまま残す。
 * 変更された定義・スクリプトは、再承認するまで実行時のハッシュ照合で無効になる。
 */

export type ApprovalChangeKind = 'added' | 'updated' | 'unchanged' | 'retained' | 'missing_script';

export interface ApprovalChange {
  id: string;
  version: string;
  kind: ApprovalChangeKind;
  scriptHash: string | null;
  contentHash: string | null;
}

export interface ApprovalPlan {
  manifest: ApprovalManifest;
  changes: ApprovalChange[];
}

export interface ApprovalOptions {
  current: ApprovalManifest;
  targets: readonly SkillDefinition[];
  /** スクリプトの SHA-256。無ければ null。 */
  hashOf: (scriptPath: string) => string | null;
  approvedBy: string;
  note: string;
  now: string;
}

const entryKey = (id: string, version: string) => `${id}@${version}`;

export function planApproval(options: ApprovalOptions): ApprovalPlan {
  const { current, targets, hashOf, approvedBy, note, now } = options;
  const existing = new Map(
    current.skills.map((entry) => [entryKey(entry.id, entry.version), entry]),
  );
  const changes: ApprovalChange[] = [];
  const handled = new Set<string>();

  for (const definition of targets) {
    const key = entryKey(definition.id, definition.version);
    handled.add(key);
    const previous = existing.get(key);
    const scriptHash = hashOf(definition.scriptPath);
    if (!scriptHash) {
      // スクリプトが無いものは承認しない。以前の行は残すが、実行時の照合で無効になる。
      changes.push({
        id: definition.id,
        version: definition.version,
        kind: 'missing_script',
        scriptHash: null,
        contentHash: null,
      });
      continue;
    }
    const contentHash = computeSkillDefinitionHash(definition, scriptHash);
    const same = previous?.scriptHash === scriptHash && previous.contentHash === contentHash;
    if (!same) {
      existing.set(key, {
        id: definition.id,
        version: definition.version,
        scriptHash,
        contentHash,
        approvedBy,
        approvedAt: now,
        note,
      } satisfies ApprovedSkillEntry);
    }
    changes.push({
      id: definition.id,
      version: definition.version,
      kind: same ? 'unchanged' : previous ? 'updated' : 'added',
      scriptHash,
      contentHash,
    });
  }

  for (const entry of current.skills) {
    const key = entryKey(entry.id, entry.version);
    if (handled.has(key)) continue;
    changes.push({
      id: entry.id,
      version: entry.version,
      kind: 'retained',
      scriptHash: entry.scriptHash,
      contentHash: entry.contentHash,
    });
  }

  return { manifest: { version: current.version, skills: [...existing.values()] }, changes };
}

/** 承認できる Skill の一覧。検証用は明示したときだけ（本番の manifest に載せないため）。 */
export function approvalCatalog(options: { includeVerification: boolean }): SkillDefinition[] {
  const byId = new Map(SKILL_CATALOG.map((definition) => [definition.id, definition]));
  for (const skill of ASSIST_SKILLS) {
    if (skill.verificationManifestOnly && !options.includeVerification) continue;
    byId.set(skill.definition.id, skill.definition);
  }
  return [...byId.values()];
}

/** --only の絞り込み。カタログに無い ID（diag.sleep など）は承認させない。 */
export function selectApprovalTargets(
  catalog: readonly SkillDefinition[],
  only: readonly string[] | null,
): SkillDefinition[] {
  if (!only) return [...catalog];
  return only.map((id) => {
    const found = catalog.find((definition) => definition.id === id);
    if (!found) {
      throw new Error(
        `${id} は承認の対象にできません（未登録、または検証用で --include-verification がありません）。`,
      );
    }
    return found;
  });
}
