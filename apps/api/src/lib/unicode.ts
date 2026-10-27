/**
 * 端末エージェントが送る文字列のサニタイズ。
 *
 * Why this exists
 * ---------------
 * Windows の端末エージェントは WMI / レジストリ由来の文字列をそのまま送る。
 * その中に U+0000 (NUL) や単独サロゲート（壊れた UTF-16）が混ざることがあり、
 * PostgreSQL の jsonb / text へ投入すると次のいずれかで失敗する。
 *
 *   - jsonb: `unsupported Unicode escape sequence`（\u0000 は jsonb で禁止）
 *   - text : `invalid byte sequence for encoding "UTF8": 0x00`
 *
 * 2026-10-27 実測: `POST /api/device/agent` が 17:52 / 18:11 に 500 で失敗し、
 * PC 情報の更新が止まった（端末はオンラインなのに在庫が古いまま）。
 * 端末側を直すのを待たず、サーバの取り込み境界で落とす。
 *
 * Policy
 * ------
 * - NUL は除去する（意味を持たない制御文字で、表示・保存に不要）。
 * - 単独サロゲートは U+FFFD（置換文字）へ置き換える（文字数を保ち、欠落を可視化）。
 * - それ以外の文字は変更しない（絵文字・結合文字・異体字を壊さない）。
 */

const NUL = String.fromCharCode(0);
// 高位サロゲートの直後が低位サロゲートでない、または低位サロゲートの直前が
// 高位サロゲートでない箇所を「単独サロゲート」として扱う。
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function sanitizeText(value: string): string {
  return value.replaceAll(NUL, '').replace(LONE_SURROGATE, '\uFFFD');
}

/**
 * JSON へ投入する値から、PostgreSQL が受け付けない文字を取り除く。
 * 配列・オブジェクトは再帰的に処理し、キー名も同様にサニタイズする。
 */
export function sanitizeForJson<T>(value: T): T {
  if (typeof value === 'string') return sanitizeText(value) as T;
  if (Array.isArray(value)) return value.map((item) => sanitizeForJson(item)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[sanitizeText(key)] = sanitizeForJson(item);
    }
    return out as T;
  }
  return value;
}
