import { ApiError } from '../errors.js';

/**
 * 出力の自動取込（設計 §4-4）。
 *
 * 決定（2026-10-26 オーナー承認）: 出力取り込みは「自動優先・手動フォールバック」。
 * ただし RSP 側にターミナルのログ/API がまだ無いため、現時点では **自動は未対応** と
 * 明示し、手動貼り付けに落とす。自動取込が動いているように見せることはしない。
 *
 * 差し替え点はこのファイルだけ:
 * - RSP の transcript API 仕様が決まったら `captureCapability()` を `supported: true` にし、
 *   `captureOutput()` で対象セッションの出力を取得して返す。
 * - 呼び出し側（POST /terminal/steps/:id/record）は `outputSource: "auto"` のときだけ
 *   `assertCaptureAllowed()` を通す。UI は `capture.supported` を見て手動欄を出す。
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

export function captureCapability(): CaptureCapability {
  return { supported: false, reason: UNSUPPORTED_REASON };
}

/** `outputSource: "auto"` を受理してよいか。未対応のまま自動扱いにしない。 */
export function assertCaptureAllowed(outputSource: 'auto' | 'manual'): void {
  const capability = captureCapability();
  if (outputSource === 'auto' && !capability.supported) {
    throw new ApiError(400, 'CAPTURE_UNAVAILABLE', capability.reason ?? UNSUPPORTED_REASON);
  }
}
