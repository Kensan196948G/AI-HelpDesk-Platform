import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { repoRoot } from '../config.js';
import {
  APPROVAL_MANIFEST_PATH,
  type ApprovalManifest,
  computeScriptHash,
} from '../resolve/skill-catalog.js';

/**
 * Skill の承認の入力（人が管理する scripts/skills/approved.json とスクリプト実体）。
 * テストはこのモジュールを合成 manifest に差し替える。approved.json を書き換えない。
 */

const manifestCache = new Map<string, { key: string; manifest: ApprovalManifest }>();

/**
 * 承認の manifest。変更が無ければ読み直さない（size と mtime / ctime で変更を検知する）。
 * 無い・壊れたファイルは空（未承認として扱う。fail-closed）。
 */
export function loadApprovalManifest(
  file: string = path.join(repoRoot, APPROVAL_MANIFEST_PATH),
): ApprovalManifest {
  try {
    const stat = statSync(file);
    const key = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    const cached = manifestCache.get(file);
    if (cached?.key === key) return cached.manifest;
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as ApprovalManifest;
    const manifest = Array.isArray(parsed.skills) ? parsed : { version: 1, skills: [] };
    manifestCache.set(file, { key, manifest });
    return manifest;
  } catch {
    manifestCache.delete(file);
    return { version: 1, skills: [] };
  }
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
