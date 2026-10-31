import { readFileSync } from 'node:fs';
import path from 'node:path';
import { repoRoot } from '../config.js';
import { type ApprovalManifest, readApprovalManifest } from '../resolve/skills.js';

/**
 * Skill の承認の入力（人が管理する scripts/skills/approved.json とスクリプト実体）。
 * テストはこのモジュールを合成 manifest に差し替える。approved.json を書き換えない。
 */

export function loadApprovalManifest(): ApprovalManifest {
  return readApprovalManifest(repoRoot);
}

/** スクリプトのバイト列。無ければ null（未承認として扱う。fail-closed）。 */
export function readSkillScript(scriptPath: string): Buffer | null {
  try {
    return readFileSync(path.join(repoRoot, scriptPath));
  } catch {
    return null;
  }
}
