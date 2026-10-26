import { ApiError } from '../errors.js';
import type { OutputSource } from './session.js';

/**
 * 出力の自動取込（設計 §4-4）。
 *
 * 決定（2026-10-26 オーナー承認）: 出力取り込みは「自動優先・手動フォールバック」。
 * ただし RSP 側にターミナルのログ/API がまだ無いため、ターミナルログからの自動取込
 * （`outputSource: "auto"`）は **Phase 4 まで未対応** と明示し、手動貼り付けに落とす。
 * 自動取込が動いているように見せることはしない。
 *
 * Phase 2（2026-10-26）: RSP の W23 コマンドキューで実行した実出力を `rsp_command` として
 * 取り込めるようにした。実行主体は RSP のキューで、HelpDesk は取得済みの出力を保存するだけ
 * なので、`captureCapability()`（ターミナルログの能力）とは独立に常に受理する。
 *
 * 差し替え点はこのファイルだけ:
 * - RSP の transcript API 仕様が決まったら `captureCapability()` を `supported: true` にし、
 *   `captureOutput()` で対象セッションの出力を取得して返す。
 * - 呼び出し側（POST /terminal/steps/:id/record）は `assertCaptureAllowed()` を通す。
 *   UI は `capture.supported` を見て手動欄を出す。
 */

export interface CaptureCapability {
  supported: boolean;
  reason: string | null;
}

export interface CapturedOutput {
  output: string;
  /** RSP 側の記録 ID など、出所を追える値（あれば）。 */
  sourceRef?: string;
}

const UNSUPPORTED_REASON = 'RSPのターミナルログAPIが未提供のため、手動貼り付けを使用します。';

/**
 * RSP ターミナルログの自動取込能力。
 *
 * `supported: false` はあくまで **ターミナルログ**（`outputSource: "auto"`）の話で、
 * RSP のコマンドキュー経由の取込（`outputSource: "rsp_command"`）は別経路のため影響しない。
 */
export function captureCapability(): CaptureCapability {
  return { supported: false, reason: UNSUPPORTED_REASON };
}

/**
 * 指定の出力ソースを受理してよいか。
 *
 * - `auto`: ターミナルログの自動取込は Phase 4 まで未対応なので 400 `CAPTURE_UNAVAILABLE`。
 * - `manual`: 従来どおり常に受理（担当者が貼り付けた出力）。
 * - `rsp_command`: RSP のコマンドキューが実行主体で実出力を取得済みのため常に受理。
 */
export function assertCaptureAllowed(outputSource: OutputSource): void {
  if (outputSource !== 'auto') return;
  const capability = captureCapability();
  if (!capability.supported) {
    throw new ApiError(400, 'CAPTURE_UNAVAILABLE', capability.reason ?? UNSUPPORTED_REASON);
  }
}
