import { createHash, createHmac, randomBytes, randomInt } from 'node:crypto';
import { config } from '../config.js';

/** トークンの保存形（SHA-256）。平文は発行時に 1 度だけ返す。 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * 監査に書く参照。監査ログは保持期限の後も残るので、端末の識別子を平文や素のハッシュで残さない
 * （SID・ホスト名は候補から総当たりで戻せる）。サーバの秘密で HMAC し、種類ごとに分ける。
 */
export function auditRef(
  kind: 'sid' | 'hostname' | 'rsp_device' | 'mesh_node',
  value: string,
): string {
  const normalized = kind === 'hostname' ? value.toLowerCase() : value;
  return createHmac('sha256', config.SESSION_SECRET)
    .update(`folder-access-audit:${kind}:${normalized}`)
    .digest('hex');
}

/** 監査に書く SID の参照。SID そのものは監査へ入れない。 */
export function hashSid(sid: string): string {
  return auditRef('sid', sid);
}

/**
 * ペアリングコードの保存形。8 桁は素の SHA-256 だと総当たりで戻せるため、
 * サーバの秘密で HMAC する。入力コードから引けるようにソルトは使わない。
 */
export function hashPairingCode(code: string): string {
  return createHmac('sha256', config.SESSION_SECRET)
    .update(`folder-access-pairing:${code}`)
    .digest('hex');
}

export function generateHelperToken(): string {
  return randomBytes(32).toString('base64url');
}

export function generatePairingCode(): string {
  return String(randomInt(0, 100_000_000)).padStart(8, '0');
}

export interface SignableOp {
  opId: string;
  requestId: string;
  sid: string;
  sessionId: number;
  root: string;
  segments: readonly string[];
  operation: string;
  expiresAt: string;
}

/**
 * 署名対象の正規形（docs/62 §5）。キーはこの順、空白なし、UTF-8。
 * `isSafeSegment` が `"` `\` と制御文字を拒否するため、エスケープは発生しない。
 */
export function canonicalOpJson(op: SignableOp): string {
  return JSON.stringify({
    opId: op.opId,
    requestId: op.requestId,
    sid: op.sid,
    sessionId: op.sessionId,
    root: op.root,
    segments: op.segments,
    operation: op.operation,
    expiresAt: op.expiresAt,
  });
}

/**
 * 操作の署名。鍵はヘルパートークンの平文（DB には無い）なので、
 * poll のヘッダで受け取った値を使って配信時に計算する。
 */
export function signOp(helperToken: string, op: SignableOp): string {
  return createHmac('sha256', helperToken).update(canonicalOpJson(op), 'utf8').digest('hex');
}
