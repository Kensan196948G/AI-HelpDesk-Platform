import { createHmac } from 'node:crypto';
import { z } from 'zod';

/**
 * サーバとヘルパー（scripts/windows/）の間の契約（docs/63 §5〜§8）。
 * DB / 設定に依存しない。Windows 担当はこのファイルと contract.test.ts のベクトルを正とする。
 *
 * ── 経路（すべて既存の Access bypass 配下 /api/device/agent/folder-helper。ヘッダ x-folder-helper-token）
 *
 *   POST /poll             既存。本文に capabilities を足す → 応答に skillOps が増える
 *   POST /ops/:id/start    実行直前の再検証。started:true の応答を受けたときだけ実行する
 *                          （失効済みのトークンでも呼べて、必ず拒否される。拒否の記録に使う）
 *   POST /ops/:id/skill-result  結果の報告
 *
 * ── poll（list_metadata の正準形と ops / result は変更しない）
 *
 *   本文: { sid, sessionId, sessionState, capabilities?: ['skill_run/1'] }
 *   応答: { ops:[...既存...], skillOps:[SkillRunOp...], cancel:[opId...], revoked, paired,
 *           nextPollSeconds?: number }
 *
 *   - capabilities に 'skill_run/1' を含まないヘルパーには skillOps を配らない（既存ヘルパーは BAD_OP になるため）。
 *   - cancel には list_metadata と skill_run の両方の opId が入る。実行中なら Job Object を終了する。
 *   - revoked:true を受けたら、実行中の子を kill → 結果を報告 → トークン削除、の順に行う。
 *     失効後のトークンでも skill-result は受け付ける（§10）。
 *   - 実行中も poll を止めない（止めると取消が届かない）。
 *   - nextPollSeconds は未処理の操作があるときの推奨間隔。従わなくても 120 秒以内なら動く。
 *
 * ── ヘルパーの手順（docs/63 §6）
 *
 *   1. canonicalSkillRunJson で署名を検証（小文字 16 進、固定時間比較）。大文字は受けない。
 *   2. canon === 'skill_run/1'、operation === 'skill_run'、SID・セッション（active）・期限・非昇格、
 *      MachineGuid、skillId@skillVersion のローカルスクリプト（scripts/skills/windows/）の
 *      SHA-256（`sha256:<hex 小文字>`、ファイルのバイト列）が scriptHash と一致することを検証する。
 *      失敗したら実行せず、status:'rejected' と HelperRejectCode を skill-result へ報告する。
 *   3. POST /ops/:id/start。応答が 200 かつ started === true のときだけ次へ。
 *      それ以外（409、タイムアウト、通信断）は実行しない。再送しない（nonce は 1 回限り）。
 *   4. 実行記録を CreateNew で書く → 子プロセス起動（Job Object） → 結果報告。
 *      再起動時に実行記録があれば再実行せず status:'interrupted', resultCode:'INTERRUPTED' を報告する。
 *
 * ── スクリプトの入出力
 *
 *   入力: 標準入力に 1 行の JSON `{"params":{...},"target":{"root":"Documents","segments":[...]}}`
 *         （target は targetRoot が null のとき null）。パスはヘルパーが解決し、AI / サーバの文字列を実行しない。
 *   出力: 標準出力に JSON 1 行。任意で resultCode（固定コード）を含められる。無ければヘルパーは 'OK' を報告する。
 *   出力の許可フィールドは ASSIST_SKILL_OUTPUTS。それ以外はサーバが捨てる。
 *   disk.space は既存のスクリプトのまま（volumes の配列。サーバが件数と最小の空き容量だけを取り出す）。
 *   名前・パス・ユーザー名・ホスト名・自由文を出力しない。
 */

export const SKILL_RUN_CAPABILITY = 'skill_run/1';
export const SKILL_RUN_CANON = 'skill_run/1';
export const SKILL_RUN_OPERATION = 'skill_run';

export const EXECUTION_MODES = ['real', 'mock', 'manual'] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export const EXECUTION_ROLES = ['main', 'verify'] as const;
export type ExecutionRole = (typeof EXECUTION_ROLES)[number];

/** 署名の対象。キーはこの順、空白なし、UTF-8。エスケープ規則は docs/62 §9.1 と同じ。 */
export interface SignableSkillRun {
  canon: typeof SKILL_RUN_CANON;
  opId: string;
  requestId: string;
  supportSessionId: string;
  proposalId: string;
  stepSeq: number;
  role: ExecutionRole;
  sid: string;
  sessionId: number;
  machineGuid: string;
  operation: typeof SKILL_RUN_OPERATION;
  skillId: string;
  skillVersion: string;
  contentHash: string;
  scriptHash: string;
  /** 正準化済みの params の JSON 文字列。ヘルパーは署名の検証後にだけ解釈する。 */
  paramsJson: string;
  /** 対象フォルダの種別。フォルダを対象にしない Skill は null。 */
  targetRoot: string | null;
  targetSegments: readonly string[];
  /** POST /start へそのまま返す 1 回限りの値。 */
  startNonce: string;
  /** 受信した文字列のまま署名する。日時として整形し直さない。 */
  expiresAt: string;
  maxSeconds: number;
  maxOutputBytes: number;
}

/** poll の skillOps の 1 要素。 */
export interface SkillRunOp extends SignableSkillRun {
  sig: string;
}

/**
 * 版付きの正準形。先頭の canon により list_metadata の正準形（opId から始まる）と
 * 同じバイト列にならない（同じトークンを鍵にしても署名を流用できない）。
 */
export function canonicalSkillRunJson(op: SignableSkillRun): string {
  return JSON.stringify({
    canon: op.canon,
    opId: op.opId,
    requestId: op.requestId,
    supportSessionId: op.supportSessionId,
    proposalId: op.proposalId,
    stepSeq: op.stepSeq,
    role: op.role,
    sid: op.sid,
    sessionId: op.sessionId,
    machineGuid: op.machineGuid,
    operation: op.operation,
    skillId: op.skillId,
    skillVersion: op.skillVersion,
    contentHash: op.contentHash,
    scriptHash: op.scriptHash,
    paramsJson: op.paramsJson,
    targetRoot: op.targetRoot,
    targetSegments: op.targetSegments,
    startNonce: op.startNonce,
    expiresAt: op.expiresAt,
    maxSeconds: op.maxSeconds,
    maxOutputBytes: op.maxOutputBytes,
  });
}

/** 鍵はヘルパートークンの平文（UTF-8）。DB には無いので poll のヘッダの値で配信時に計算する。 */
export function signSkillRun(helperToken: string, op: SignableSkillRun): string {
  return createHmac('sha256', helperToken).update(canonicalSkillRunJson(op), 'utf8').digest('hex');
}

/**
 * params の正準形。値は文字列・整数・真偽値だけ、入れ子なし。キーはコード単位の昇順。
 * `stableStringify` は localeCompare で並べるので、端末と共有するこの形には使わない。
 */
export function canonicalParamsJson(params: Record<string, unknown>): string {
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(params).sort()) {
    const value = params[key];
    if (typeof value !== 'string' && typeof value !== 'boolean' && !Number.isInteger(value)) {
      throw new Error('params の値は文字列・整数・真偽値だけです。');
    }
    ordered[key] = value;
  }
  return JSON.stringify(ordered);
}

// ── POST /ops/:id/start ──────────────────────────────────────────

const ScriptHash = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const FixedCode = z.string().regex(/^[A-Z0-9_]{1,64}$/);

export const StartBodySchema = z.object({
  actorSid: z.string().trim().min(1).max(200),
  sessionId: z.number().int().min(0).max(65535),
  machineGuid: z.string().trim().min(1).max(64),
  startNonce: z.string().min(16).max(64),
  scriptHash: ScriptHash,
});
export type StartBody = z.infer<typeof StartBodySchema>;

/** /start の拒否理由。409 + `{ok:false, started:false, reason}`。 */
export const START_REJECT_CODES = [
  'OP_NOT_DELIVERED',
  'NONCE_MISMATCH',
  'NONCE_CONSUMED',
  'OP_EXPIRED',
  'SESSION_NOT_ACTIVE',
  'SESSION_ENDED',
  'CONSENT_INVALID',
  'APPROVAL_INVALID',
  'ASSIGNEE_CHANGED',
  'SID_MISMATCH',
  'SESSION_MISMATCH',
  'DEVICE_MISMATCH',
  'SCRIPT_HASH_MISMATCH',
  'SKILL_NOT_APPROVED',
] as const;
export type StartRejectCode = (typeof START_REJECT_CODES)[number];

/** 成功は 200 + これ。これ以外の応答では実行しない。 */
export interface StartAccepted {
  ok: true;
  started: true;
  opId: string;
  /** この時刻までに結果が無ければサーバは timeout として扱う。 */
  deadlineAt: string;
}

export interface StartRejected {
  ok: false;
  started: false;
  reason: StartRejectCode;
}

// ── POST /ops/:id/skill-result ───────────────────────────────────

/**
 * 実行前に拒否したときの resultCode（status:'rejected'）。
 * この報告は「実行していない」という申告であり、成功の証拠にならない。
 */
export const HELPER_REJECT_CODES = [
  'BAD_OP',
  'BAD_SIGNATURE',
  'ELEVATED',
  'SID_MISMATCH',
  'SESSION_MISMATCH',
  'SESSION_NOT_ACTIVE',
  'DEVICE_MISMATCH',
  'EXPIRED',
  'SKILL_NOT_FOUND',
  'SCRIPT_HASH_MISMATCH',
  'INVALID_PARAMS',
  'INVALID_TARGET',
] as const;

/** 実行後の失敗で共通に使う resultCode。 */
export const HELPER_FAILURE_CODES = [
  'INTERRUPTED',
  'TIMEOUT',
  'CANCELLED',
  'EXEC_FAILED',
  'OUTPUT_INVALID',
  'OUTPUT_TOO_LARGE',
  'ACCESS_DENIED',
  'NOT_FOUND',
  'INTERNAL_ERROR',
] as const;

export const SKILL_RESULT_STATUSES = [
  'ok',
  'error',
  'timeout',
  'cancelled',
  'interrupted',
  'rejected',
] as const;
export type SkillResultStatus = (typeof SKILL_RESULT_STATUSES)[number];

/**
 * stopped: 動いていた子を止めた。stop_failed: 止められなかった。
 * not_running: 実行していない。completed_before_stop: 動いて完了した後に取消を受けた（変更は生じ得る）。
 */
export const STOP_OUTCOMES = [
  'stopped',
  'stop_failed',
  'not_running',
  'completed_before_stop',
] as const;

export const SkillResultBodySchema = z.object({
  /** 'real' 以外は本番で拒否（403）。本番以外でも証拠にならない。 */
  executionMode: z.enum(EXECUTION_MODES),
  actorSid: z.string().trim().min(1).max(200),
  sessionId: z.number().int().min(0).max(65535),
  skillId: z.string().min(1).max(100),
  skillVersion: z.string().min(1).max(40),
  /** 実際に実行したスクリプトの SHA-256。op の scriptHash と違えば証拠にしない。 */
  scriptHash: ScriptHash,
  status: z.enum(SKILL_RESULT_STATUSES),
  resultCode: FixedCode,
  exitCode: z.number().int().nullable(),
  startedAt: z.string().datetime({ offset: true }).nullable(),
  finishedAt: z.string().datetime({ offset: true }).nullable(),
  elapsedMs: z.number().int().min(0).max(3_600_000),
  /** スクリプトの出力（JSON オブジェクト）。許可フィールド以外はサーバが捨てる。無ければ null。 */
  output: z.record(z.string(), z.unknown()).nullable(),
  /** 取消・停止を受けたときの結果。受けていなければ省く。 */
  stopOutcome: z.enum(STOP_OUTCOMES).optional(),
  /**
   * 既に生じた変更や停止不能を隠さず報告する（docs/63 §10）。固定コードだけを受ける。
   * 例: MARKER_WRITTEN, RESTORE_FAILED, STOP_FAILED_CHILD_RUNNING
   */
  partialEffect: z.array(FixedCode).max(8).optional(),
});
export type SkillResultBody = z.infer<typeof SkillResultBodySchema>;

/**
 * 応答は常にこの形（機密は返さない）。再送しない。
 * - accepted:true  検証の材料として受理した
 * - accepted:false 記録はしたが次へ進めない（reason: LATE_RESULT / DUPLICATE / NOT_STARTED / ...）
 * 本番で mock / manual を送ると 403 EXECUTION_MODE_REJECTED。
 * トークンの失効から 24 時間（ASSIST_LIMITS.revokedReportHours）を過ぎた報告は
 * 410 RESULT_REPORT_EXPIRED（保存しない。accepted:false の遅延結果とは別）。再送しても期限は延びない。
 * 410 を受けたら再送をやめ、実行記録とトークンを片付ける。
 */
export interface SkillResultResponse {
  ok: true;
  accepted: boolean;
  reason?: string;
}

// ── Skill の入出力（スクリプト担当との契約） ──────────────────────

export type OutputFieldType = 'boolean' | 'count' | 'bytes' | 'marker' | 'gigabytes';

/**
 * Skill ごとの許可フィールド。型が違う値は捨てる（欠落として扱うので成功にならない）。
 * count / bytes は 0 以上の整数、gigabytes は 0 以上の数値、marker は `^[A-Z0-9_-]{1,32}$` か null。
 */
export const ASSIST_SKILL_OUTPUTS: Record<string, Record<string, OutputFieldType>> = {
  // scripts/skills/windows/folder-summary.ps1。許可フォルダ直下だけ。名前を返さない。
  'folder.summary': {
    accessible: 'boolean',
    fileCount: 'count',
    directoryCount: 'count',
    linkCount: 'count',
    totalBytes: 'bytes',
    truncated: 'boolean',
  },
  // scripts/skills/windows/user-marker-set.ps1。HKCU\Software\AIHelpDesk\Verify の合成値のみ。
  'user.marker.set': {
    applied: 'boolean',
    previousPresent: 'boolean',
    previousValue: 'marker',
  },
  // scripts/skills/windows/user-marker-clear.ps1。
  'user.marker.clear': {
    cleared: 'boolean',
    previousPresent: 'boolean',
    previousValue: 'marker',
  },
  // scripts/skills/windows/user-marker-status.ps1。set / clear の確認操作（読み取りのみ）。
  'user.marker.status': {
    present: 'boolean',
    value: 'marker',
  },
};

/**
 * 成功時（status:'ok'）の resultCode。ヘルパーが 'OK' を報告したらサーバがこの値に読み替える。
 * 進捗なしの判定（結果コードが 2 回同じ）に使う。
 */
export const ASSIST_SKILL_SUCCESS_CODES: Record<string, string> = {
  'folder.summary': 'FOLDER_SUMMARY_OK',
  'disk.space': 'DISK_SPACE_OK',
  'user.marker.set': 'MARKER_SET',
  'user.marker.clear': 'MARKER_CLEARED',
  'user.marker.status': 'MARKER_STATUS_OK',
};
