/** キー順に依存しない JSON。設定や DB に依存しない（承認ツールからも使う）。 */
export function stableStringify(value: unknown): string {
  // Date は JSON.stringify では ISO 文字列になる。保存時（jsonb）と同じ表現にそろえる。
  // ここを `{}` として扱うと、保存値から再計算したハッシュが一致しなくなる（G-01-F1）。
  if (value instanceof Date) {
    return JSON.stringify(Number.isNaN(value.getTime()) ? null : value.toISOString());
  }
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}
