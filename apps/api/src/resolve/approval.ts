import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { stableStringify } from '../domain/audit.js';

/** 承認ハッシュの有効期限（設計 §5-2: 5 分）。 */
export const APPROVAL_TTL_MS = 5 * 60 * 1000;

/** セッションの最大経過時間（設計 §4-3: 30 分）。 */
export const SESSION_TTL_MS = 30 * 60 * 1000;

/** 1 セッションの最大ステップ数（設計 §4-3: 6）。 */
export const DEFAULT_MAX_STEPS = 6;

/**
 * 承認ハッシュの対象（設計 §5-2）。
 * nonce / expiresAt も含めた完全形。キー順は stableStringify で吸収する。
 */
export interface ApprovalPayload {
  sessionId: string;
  stepId: string;
  seq: number;
  skillId: string;
  skillVersion: string;
  skillContentHash: string;
  params: Record<string, unknown>;
  deviceId: string;
  userEmail: string;
  riskLevel: number;
  nonce: string;
  expiresAt: string;
}

/** 画面に返す承認チャレンジ。payload をそのまま stableStringify + SHA-256 すれば approvalHash になる。 */
export interface ApprovalChallenge {
  payload: ApprovalPayload;
  nonce: string;
  expiresAt: string;
}

/** 承認ハッシュを再計算するための元データ（step / session の列から再構築する）。 */
export interface ApprovalPayloadSource {
  sessionId: string;
  stepId: string;
  seq: number;
  skillId: string;
  skillVersion: string;
  skillContentHash: string;
  params: Record<string, unknown>;
  deviceId: string;
  userEmail: string;
  riskLevel: number;
  nonce: string;
  expiresAt: Date | string;
}

/** 1 回限りの nonce（base64url 16 bytes = 22 文字）。 */
export function newNonce(): string {
  return randomBytes(16).toString('base64url');
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * payload を step / session の列から組み立てる。
 * 保存済みの payload を信頼せず、毎回この関数で再構築してからハッシュを計算する。
 */
export function buildApprovalPayload(source: ApprovalPayloadSource): ApprovalPayload {
  return {
    sessionId: source.sessionId,
    stepId: source.stepId,
    seq: source.seq,
    skillId: source.skillId,
    skillVersion: source.skillVersion,
    skillContentHash: source.skillContentHash,
    params: source.params,
    deviceId: source.deviceId,
    userEmail: source.userEmail,
    riskLevel: source.riskLevel,
    nonce: source.nonce,
    expiresAt: toIsoString(source.expiresAt),
  };
}

/** 承認ハッシュ = SHA-256(stableStringify(payload)) の hex。 */
export function computeApprovalHash(payload: ApprovalPayload): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

/**
 * リスク 4 以上の Skill に対する IT 管理者承認の payload（設計 §4-3）。
 *
 * 利用者の承認 payload（12 キー固定）とは **別物** にする。既存テストと画面の
 * ハッシュ計算が 12 キーに依存しているため、管理者承認の追加で壊してはいけない。
 * adminEmail を含めることで「誰の承認か」をハッシュに束縛する。
 */
export interface AdminApprovalPayload {
  stepId: string;
  sessionId: string;
  seq: number;
  skillId: string;
  skillVersion: string;
  skillContentHash: string;
  params: Record<string, unknown>;
  deviceId: string;
  userEmail: string;
  riskLevel: number;
  adminEmail: string;
  nonce: string;
  expiresAt: string;
}

/** 管理者承認 payload の元データ（step / session / 承認者の列から再構築する）。 */
export interface AdminApprovalPayloadSource {
  stepId: string;
  sessionId: string;
  seq: number;
  skillId: string;
  skillVersion: string;
  skillContentHash: string;
  params: Record<string, unknown>;
  deviceId: string;
  userEmail: string;
  riskLevel: number;
  adminEmail: string;
  nonce: string;
  expiresAt: Date | string;
}

export function buildAdminApprovalPayload(
  source: AdminApprovalPayloadSource,
): AdminApprovalPayload {
  return {
    stepId: source.stepId,
    sessionId: source.sessionId,
    seq: source.seq,
    skillId: source.skillId,
    skillVersion: source.skillVersion,
    skillContentHash: source.skillContentHash,
    params: source.params,
    deviceId: source.deviceId,
    userEmail: source.userEmail,
    riskLevel: source.riskLevel,
    adminEmail: source.adminEmail,
    nonce: source.nonce,
    expiresAt: toIsoString(source.expiresAt),
  };
}

/** 管理者承認ハッシュ（利用者側と同じ SHA-256(stableStringify(payload))）。 */
export function computeAdminApprovalHash(payload: AdminApprovalPayload): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

/**
 * 送信された approvalHash とサーバ再計算値を定数時間で比較する。
 * 形式不正（64 桁 hex 以外）は比較せず false。
 */
export function approvalHashMatches(submitted: string, expected: string): boolean {
  if (typeof submitted !== 'string' || !/^[0-9a-f]{64}$/i.test(submitted)) return false;
  if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/i.test(expected)) return false;
  const actualBuffer = Buffer.from(submitted.toLowerCase(), 'hex');
  const expectedBuffer = Buffer.from(expected.toLowerCase(), 'hex');
  return (
    actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
  );
}
