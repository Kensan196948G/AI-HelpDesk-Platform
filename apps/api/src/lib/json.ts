/** postgres.js は環境によって jsonb を文字列で返すため、配列/オブジェクトへ正規化する。 */
export function asJsonArray<T = unknown>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function asJsonObject<T extends Record<string, unknown> = Record<string, unknown>>(
  value: unknown,
): T {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as T;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as T;
    } catch {
      // ignore
    }
  }
  return {} as T;
}
