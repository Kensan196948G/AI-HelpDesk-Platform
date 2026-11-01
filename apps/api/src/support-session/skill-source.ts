import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { repoRoot } from '../config.js';
import {
  type ApprovalManifest,
  computeScriptHash,
  readApprovalManifest,
} from '../resolve/skills.js';

/**
 * Skill の承認の入力（人が管理する scripts/skills/approved.json とスクリプト実体）。
 * テストはこのモジュールを合成 manifest に差し替える。approved.json を書き換えない。
 */

export function loadApprovalManifest(): ApprovalManifest {
  return readApprovalManifest(repoRoot);
}

const hashCache = new Map<string, { key: string; hash: string }>();

/**
 * スクリプトの SHA-256。無ければ null（未承認として扱う。fail-closed）。
 * トランザクションの中からも呼ばれるので、変更が無ければ読み直さない。
 * 変更の検知はサイズと mtime / ctime で行う（mtime を戻しても ctime は戻せない）。
 */
export function readSkillScriptHash(scriptPath: string): string | null {
  const absolute = path.join(repoRoot, scriptPath);
  try {
    const stat = statSync(absolute);
    const key = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    const cached = hashCache.get(absolute);
    if (cached?.key === key) return cached.hash;
    const hash = computeScriptHash(readFileSync(absolute));
    hashCache.set(absolute, { key, hash });
    return hash;
  } catch {
    hashCache.delete(absolute);
    return null;
  }
}
