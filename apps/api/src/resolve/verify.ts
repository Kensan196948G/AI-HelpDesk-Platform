/**
 * Skill の verify（実行後の確認条件）をサーバ側で決定的に評価する。
 *
 * 設計上の前提（docs/25 §4-3 / docs/30 §4）:
 * - verify には 2 形態がある。
 *   1. `{ resultField, equals | minimum }`: 端末が返した結果から、この場で評価できる。
 *   2. `{ script, args, expect }`: 確認用スクリプトの追加実行が必要。この場では評価できない。
 * - 「評価できない」を「成功」と見なしてはならない（未検証のまま解決扱いにしない）。
 *   そのため形態 2 は `ok: null, evaluated: false, reason: 'requires_followup'` を返す。
 * - 例外は投げない。壊れた verify / 結果が来ても、解決ループ自体を止めない
 *   （呼び出し側は「評価不能」として扱う）。
 * - 形態 2 は Phase 6a で追撃ステップ（サーバ主導の追加実行）を経て、
 *   `evaluateFollowupVerify` が expect をサブセット一致で評価する。
 */

/** 評価できなかった理由。`ok === null` のときだけ設定される。 */
export type VerifyOutcomeReason =
  | 'no_verify_definition'
  | 'requires_followup'
  | 'field_missing'
  | 'no_comparator'
  | 'type_mismatch';

export interface VerifyOutcome {
  /** true = 条件を満たした / false = 満たさない / null = 評価不能。 */
  ok: boolean | null;
  /** 比較まで到達したか（false のとき ok は必ず null）。 */
  evaluated: boolean;
  /** verify.description（画面・監査向けの説明）。 */
  description?: string;
  /** 評価に使った resultField。 */
  field?: string;
  /** 結果側の実際値。 */
  actual?: unknown;
  /** verify 側の期待値（equals / minimum）。 */
  expected?: unknown;
  reason?: VerifyOutcomeReason;
}

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** equals の比較対象はプリミティブ（string / number / boolean / null）だけに限る。 */
function isPrimitive(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * verify を評価する。`resultField` は `resultSummary` の**トップレベルキー**として
 * だけ解決する（`a.b` のようなドットパスは解釈しない）。
 *
 * @param verify Skill 定義の verify（未定義・壊れた値でもよい）
 * @param resultSummary 端末結果のトップレベルオブジェクト
 *   （呼び出し側は result_summary.normalized を渡す。無い場合のみ result_summary 自体）
 */
export function evaluateVerify(verify: unknown, resultSummary: unknown): VerifyOutcome {
  if (!isPlainObject(verify)) {
    return { ok: null, evaluated: false, reason: 'no_verify_definition' };
  }

  const description = isNonEmptyString(verify.description) ? verify.description : undefined;
  const base = description ? { description } : {};

  // resultField が無い verify は、確認用スクリプトの実行（script 形態）でのみ確認できる。
  if (!isNonEmptyString(verify.resultField)) {
    const hasScript = isNonEmptyString(verify.script);
    return {
      ok: null,
      evaluated: false,
      ...base,
      reason: hasScript ? 'requires_followup' : 'no_verify_definition',
    };
  }

  const field = verify.resultField.trim();
  const hasEquals = Object.hasOwn(verify, 'equals');
  const hasMinimum = Object.hasOwn(verify, 'minimum');
  // comparator は equals / minimum のどちらか一方だけを許す（両方・どちらも無しは評価不能）。
  if (hasEquals === hasMinimum) {
    return { ok: null, evaluated: false, ...base, field, reason: 'no_comparator' };
  }

  const expected = hasEquals ? verify.equals : verify.minimum;
  const summary = isPlainObject(resultSummary) ? resultSummary : null;
  if (!summary || !Object.hasOwn(summary, field)) {
    return { ok: null, evaluated: false, ...base, field, reason: 'field_missing' };
  }

  const actual = summary[field];
  if (hasEquals) {
    // プリミティブの厳密比較のみ（オブジェクト・配列は比較しない）。
    if (!isPrimitive(actual) || !isPrimitive(expected)) {
      return {
        ok: null,
        evaluated: false,
        ...base,
        field,
        actual,
        expected,
        reason: 'type_mismatch',
      };
    }
    return { ok: actual === expected, evaluated: true, ...base, field, actual, expected };
  }

  // minimum は数値同士のときだけ比較する（文字列の "10" 等は型不一致）。
  if (
    typeof actual !== 'number' ||
    typeof expected !== 'number' ||
    !Number.isFinite(actual) ||
    !Number.isFinite(expected)
  ) {
    return {
      ok: null,
      evaluated: false,
      ...base,
      field,
      actual,
      expected,
      reason: 'type_mismatch',
    };
  }
  return { ok: actual >= expected, evaluated: true, ...base, field, actual, expected };
}

/**
 * 追撃実行（script 形態 verify）の評価結果。
 *
 * 親ステップの verify.expect を、追撃ステップの結果（normalized 等）に対して
 * **サブセット一致**で評価したもの。resultField を持たないため `field` は null。
 */
export interface FollowupVerifyOutcome {
  ok: boolean;
  evaluated: true;
  description?: string;
  field: null;
  /** expect のキーだけを抜き出した実際値（欠落キーは null）。 */
  actual: Record<string, unknown>;
  /** 親 verify.expect（そのまま）。 */
  expected: Record<string, unknown>;
  reason?: 'attempt_expect_mismatch';
}

/** 値の厳密な深い比較（配列・オブジェクトは中身まで比較する）。 */
function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    return left.length === right.length && left.every((item, i) => deepEqual(item, right[i]));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]));
  }
  return false;
}

/**
 * `expected` が `actual` のサブセットか（オブジェクトは再帰、配列・プリミティブは厳密比較）。
 * 期待したキーが実際値に無い場合は不一致（undefined 同士でも一致にしない）。
 */
function containsExpected(actual: unknown, expected: unknown): boolean {
  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) return false;
    return Object.keys(expected).every(
      (key) => Object.hasOwn(actual, key) && containsExpected(actual[key], expected[key]),
    );
  }
  return deepEqual(actual, expected);
}

/**
 * script 形態 verify（`{script, args, expect}`）の expect を追撃結果に対して評価する。
 *
 * - expect が空・オブジェクトでない・verify が壊れている場合は null（評価不能）。
 * - `actual` には expect のキーだけを残す（結果全文は保存しない）。
 * - 一致しなければ `ok: false, reason: 'attempt_expect_mismatch'`。
 */
export function evaluateFollowupVerify(
  verify: unknown,
  resultSummary: unknown,
): FollowupVerifyOutcome | null {
  if (!isPlainObject(verify)) return null;
  const expect = verify.expect;
  if (!isPlainObject(expect) || Object.keys(expect).length === 0) return null;

  const target = isPlainObject(resultSummary) ? resultSummary : {};
  const actual: Record<string, unknown> = {};
  let ok = true;
  for (const key of Object.keys(expect)) {
    actual[key] = Object.hasOwn(target, key) ? target[key] : null;
    if (!containsExpected(target[key], expect[key])) ok = false;
  }

  const description = isNonEmptyString(verify.description) ? verify.description : undefined;
  return {
    ok,
    evaluated: true,
    ...(description ? { description } : {}),
    field: null,
    actual,
    expected: expect,
    ...(ok ? {} : { reason: 'attempt_expect_mismatch' as const }),
  };
}
