import { z } from 'zod';

/**
 * 本人同意付きフォルダ一覧の純関数（docs/62）。DB / ネットワークに触れない。
 * 状態遷移・束縛の判定・入力の正規化をここへ集め、ルートと単体テストで共有する。
 */

export const FOLDER_ROOTS = [
  'Desktop',
  'Documents',
  'Downloads',
  'Pictures',
  'Music',
  'Videos',
] as const;
export type FolderRoot = (typeof FOLDER_ROOTS)[number];

export const REQUEST_STATUSES = [
  'device_pending',
  'helper_pending',
  'consent_pending',
  'active',
  'ended',
  'revoked',
  'expired',
  'denied',
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const OPEN_STATUSES = [
  'device_pending',
  'helper_pending',
  'consent_pending',
  'active',
] as const satisfies readonly RequestStatus[];

export type EndReason =
  | 'operator_end'
  | 'requester_revoked'
  | 'expired'
  | 'assignee_changed'
  | 'session_changed'
  | 'user_logged_off'
  | 'helper_revoked'
  | 'lease_conflict'
  | 'device_mismatch'
  | 'sid_mismatch';

export const LIMITS = {
  maxEntries: 500,
  maxBytes: 32 * 1024,
  maxSeconds: 15,
  maxTtlMinutes: 60,
  maxSegments: 16,
  maxNameLength: 260,
  pairingMinutes: 10,
  maxPairAttempts: 5,
  /** 同意前の依頼の有効期限。 */
  requestMinutes: 30,
  /** 操作 1 件の配信期限。 */
  opSeconds: 120,
  /** この秒数 heartbeat が無ければログオフ扱いにする（ヘルパーのポーリングは 60 秒以内）。 */
  helperStaleSeconds: 180,
  /** 状態確認のついでに RSP へ結果を問い合わせる最短間隔。 */
  probeCheckSeconds: 5,
  maxProbeAttempts: 3,
} as const;

const TRANSITIONS: Record<RequestStatus, readonly RequestStatus[]> = {
  device_pending: ['helper_pending', 'denied', 'revoked', 'expired', 'ended'],
  helper_pending: ['consent_pending', 'denied', 'revoked', 'expired', 'ended'],
  consent_pending: ['active', 'denied', 'revoked', 'expired', 'ended'],
  active: ['ended', 'denied', 'revoked', 'expired'],
  ended: [],
  revoked: [],
  expired: [],
  denied: [],
};

export function canTransition(from: RequestStatus, to: RequestStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(status: string): boolean {
  return !(OPEN_STATUSES as readonly string[]).includes(status);
}

/** 終了理由から終端状態を決める。 */
export function terminalStatusFor(reason: EndReason): RequestStatus {
  switch (reason) {
    case 'requester_revoked':
    case 'helper_revoked':
      return 'revoked';
    case 'expired':
      return 'expired';
    case 'lease_conflict':
    case 'device_mismatch':
      return 'denied';
    default:
      return 'ended';
  }
}

/** 終端状態に対応する監査アクション（docs/62 §7）。 */
export function endAuditAction(status: RequestStatus): string {
  switch (status) {
    case 'revoked':
      return 'folder_access.revoke';
    case 'expired':
      return 'folder_access.expire';
    case 'denied':
      return 'folder_access.deny';
    default:
      return 'folder_access.end';
  }
}

// ── SID / セッション ─────────────────────────────────────────────

const USER_SID = /^S-1-(5-21|12-1)(-\d{1,10}){2,6}$/;

/** 本人のユーザー SID だけを受ける（S-1-5-18/19/20 や組み込みグループは拒否）。 */
export function isUserSid(sid: string): boolean {
  return USER_SID.test(sid);
}

export function normalizeSessionState(value: string): string {
  return value.trim().toLowerCase();
}

export type HeartbeatDecision =
  | { kind: 'ok'; sessionActive: boolean }
  | { kind: 'end'; reason: EndReason };

/**
 * heartbeat とペアリング時の束縛を比べる（docs/62 §6）。
 * disconnected（画面切断）は同意を保つが操作は配らない。それ以外の状態はログオフ扱い。
 */
export function heartbeatDecision(
  bound: { sid: string; sessionId: number },
  heartbeat: { sid: string; sessionId: number; sessionState: string },
): HeartbeatDecision {
  if (heartbeat.sid !== bound.sid) return { kind: 'end', reason: 'sid_mismatch' };
  if (heartbeat.sessionId !== bound.sessionId) return { kind: 'end', reason: 'session_changed' };
  const state = normalizeSessionState(heartbeat.sessionState);
  if (state === 'active') return { kind: 'ok', sessionActive: true };
  if (state === 'disconnected') return { kind: 'ok', sessionActive: false };
  return { kind: 'end', reason: 'user_logged_off' };
}

export interface BindingFacts {
  consentExpired: boolean;
  handoverStatus: string;
  claimedBy: string | null;
  assigneeEmail: string;
  ownerEmail: string;
  requesterEmail: string;
  helperPresent: boolean;
  helperRevoked: boolean;
  helperStale: boolean;
  helperBoundToRequest: boolean;
}

/** 毎操作のサーバ検証（docs/62 §6）。違反があれば終了理由を返す。 */
export function bindingViolation(facts: BindingFacts): EndReason | null {
  if (facts.consentExpired) return 'expired';
  if (
    facts.claimedBy !== facts.assigneeEmail ||
    !['claimed', 'resolved'].includes(facts.handoverStatus)
  ) {
    return 'assignee_changed';
  }
  if (facts.ownerEmail !== facts.requesterEmail) return 'assignee_changed';
  if (!facts.helperPresent || facts.helperRevoked || !facts.helperBoundToRequest) {
    return 'helper_revoked';
  }
  if (facts.helperStale) return 'user_logged_off';
  return null;
}

// ── 相対サブフォルダ ─────────────────────────────────────────────

const RESERVED_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i;
// biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字の拒否そのものが目的。
const FORBIDDEN_SEGMENT_CHARS = /[\u0000-\u001f\u007f-\u009f\\/:*?"<>|]/;

/** サブフォルダ 1 段を検証する（端末側と同じ規則の二重防御。docs/62 §6）。 */
export function isSafeSegment(segment: string): boolean {
  if (segment.length === 0 || segment.length > 255) return false;
  if (segment === '.' || segment === '..') return false;
  if (FORBIDDEN_SEGMENT_CHARS.test(segment)) return false;
  if (/[. ]$/.test(segment)) return false;
  if (RESERVED_NAME.test(segment)) return false;
  return true;
}

export const SegmentsSchema = z
  .array(z.string().refine(isSafeSegment, 'サブフォルダ名に使えない文字が含まれています。'))
  .max(LIMITS.maxSegments);

export const ConsentBodySchema = z.object({
  root: z.enum(FOLDER_ROOTS),
  segments: SegmentsSchema,
  ttlMinutes: z.number().int().min(1).max(LIMITS.maxTtlMinutes),
});

// ── 結果の正規化 ─────────────────────────────────────────────────

const ResultEntrySchema = z.object({
  name: z.string().max(4096),
  type: z.enum(['file', 'directory', 'link', 'other']),
  size: z.number().int().min(0).nullable().optional(),
  modifiedAt: z.string().datetime({ offset: true }).nullable().optional(),
  attrs: z
    .object({
      reparse: z.boolean().optional(),
      cloudOnly: z.boolean().optional(),
      hidden: z.boolean().optional(),
    })
    .optional(),
});
export type ResultEntry = z.infer<typeof ResultEntrySchema>;

export const ResultBodySchema = z.object({
  actorSid: z.string().trim().min(1).max(200),
  sessionId: z.number().int().min(0).max(65535),
  root: z.enum(FOLDER_ROOTS),
  status: z.enum(['ok', 'partial', 'error']),
  // 理由は固定コードだけを受ける（パスやファイル名が紛れ込まないようにする）。
  reason: z
    .string()
    .regex(/^[A-Z0-9_]{1,64}$/)
    .optional(),
  truncated: z.boolean(),
  elapsedMs: z.number().int().min(0).max(3_600_000),
  entries: z.array(ResultEntrySchema).max(5000),
});

// C0 / C1 / DEL に加え、表示を偽装できる双方向制御文字も取り除く。
const UNSAFE_NAME_CHARS =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字の除去そのものが目的。
  /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

export function sanitizeEntryName(name: string): string {
  return name.replace(UNSAFE_NAME_CHARS, '').slice(0, LIMITS.maxNameLength);
}

/** 名前を無害化し、500 件 / 32KB に収める。超過分は捨てて truncated にする。 */
export function normalizeEntries(
  entries: readonly ResultEntry[],
  limits: { maxEntries: number; maxBytes: number } = LIMITS,
): { entries: ResultEntry[]; truncated: boolean } {
  const kept: ResultEntry[] = [];
  let bytes = 2;
  let truncated = false;
  for (const entry of entries) {
    const name = sanitizeEntryName(entry.name);
    if (!name) continue;
    if (kept.length >= limits.maxEntries) {
      truncated = true;
      break;
    }
    const normalized: ResultEntry = { ...entry, name };
    const size = Buffer.byteLength(JSON.stringify(normalized), 'utf8') + 1;
    if (bytes + size > limits.maxBytes) {
      truncated = true;
      break;
    }
    bytes += size;
    kept.push(normalized);
  }
  return { entries: kept, truncated };
}

// ── RSP 固定テンプレートの結果 ───────────────────────────────────

export interface ProbeSession {
  user: string;
  sessionId: number;
  state: 'active' | 'disconnected' | 'other';
}

export interface ProbeResult {
  machineGuid: string;
  sessions: ProbeSession[];
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isMachineGuid(value: string): boolean {
  return GUID.test(value);
}

function sessionStateFrom(raw: string): ProbeSession['state'] {
  const state = raw.toLowerCase();
  if (state === 'active' || state === 'アクティブ' || state === '運用中') return 'active';
  if (state === 'disc' || state === 'disconnected' || state === '切断') return 'disconnected';
  return 'other';
}

/** quser の出力行を解釈する。見出し行（ID が数字でない）は無視する。 */
export function parseQuserLines(lines: readonly string[]): ProbeSession[] {
  const sessions: ProbeSession[] = [];
  for (const line of lines) {
    const match = /^[>\s]*(\S+)\s+(?:\S+\s+)?(\d+)\s+(\S+)(?:\s|$)/.exec(line);
    if (!match) continue;
    const [, user, id, state] = match;
    if (!user || !id || !state) continue;
    sessions.push({ user, sessionId: Number(id), state: sessionStateFrom(state) });
  }
  return sessions;
}

/** 固定テンプレートの出力（JSON 1 行）を解釈する。解釈できなければ null（fail-closed）。 */
export function parseProbeOutput(output: unknown): ProbeResult | null {
  if (typeof output !== 'string') return null;
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const { machineGuid, quser } = parsed as { machineGuid?: unknown; quser?: unknown };
  if (typeof machineGuid !== 'string' || !isMachineGuid(machineGuid.trim())) return null;
  const lines = Array.isArray(quser)
    ? quser.filter((line): line is string => typeof line === 'string')
    : typeof quser === 'string'
      ? [quser]
      : [];
  return { machineGuid: machineGuid.trim(), sessions: parseQuserLines(lines) };
}

/**
 * RSP の結果がヘルパーの登録より前に完了したか。古い quser ではセッションを判断できない。
 * タイムゾーンの無い時刻は比較できないので「古くない」と扱う（照合そのものは行う）。
 */
export function probeCompletedBefore(completedAt: string | null, helperCreatedAt: Date): boolean {
  if (!completedAt || !/(Z|[+-]\d{2}:?\d{2})$/i.test(completedAt)) return false;
  const time = new Date(completedAt).getTime();
  return !Number.isNaN(time) && time < helperCreatedAt.getTime();
}

function comparableUser(name: string): string {
  const short = name.slice(name.lastIndexOf('\\') + 1).toLowerCase();
  // quser はユーザー名を 20 文字で切り詰める。
  return short.slice(0, 20);
}

export type ProbeDecision =
  | { kind: 'ok' }
  | { kind: 'device_mismatch' }
  | { kind: 'pending'; code: 'NOT_LOGGED_ON' | 'SESSION_UNRESOLVED' };

/**
 * RSP 側の事実とヘルパーの申告を照合する（docs/62 §4）。
 * 同じユーザーのセッションが複数あると、どちらの画面でコードを見たか確定できないので進めない。
 */
export function evaluateProbe(
  probe: ProbeResult,
  helper: { machineGuid: string; sessionId: number; userName: string | null },
): ProbeDecision {
  if (probe.machineGuid.toLowerCase() !== helper.machineGuid.toLowerCase()) {
    return { kind: 'device_mismatch' };
  }
  if (probe.sessions.length === 0) return { kind: 'pending', code: 'NOT_LOGGED_ON' };
  const user = comparableUser(helper.userName ?? '');
  const sameUser = probe.sessions.filter((session) => comparableUser(session.user) === user);
  if (sameUser.length !== 1) return { kind: 'pending', code: 'SESSION_UNRESOLVED' };
  const session = sameUser[0];
  if (session?.sessionId !== helper.sessionId || session.state !== 'active') {
    return { kind: 'pending', code: 'SESSION_UNRESOLVED' };
  }
  return { kind: 'ok' };
}
