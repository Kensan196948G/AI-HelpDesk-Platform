/**
 * 未認証の経路（ヘルパーの登録・トークン確認の前）の接続元ごとの制限。
 * lib/rate-limit.ts のバケットは認証済みの経路と共有で、満杯になると新しいキーを拒否する。
 * 未認証の接続元で埋められないように別枠で持つ。満杯のときはこの枠の中だけで拒否する。
 */
const buckets = new Map<string, { count: number; resetAt: number }>();
const MAX_ADDRESS_BUCKETS = 2_000;

export function checkAddressLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  if (buckets.size >= MAX_ADDRESS_BUCKETS) {
    for (const [existing, bucket] of buckets) {
      if (now >= bucket.resetAt) buckets.delete(existing);
    }
  }
  const bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    if (buckets.size >= MAX_ADDRESS_BUCKETS) return false;
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count += 1;
  return true;
}

/** 数えずに、上限に達しているかだけを見る（失敗だけを数える制限に使う）。 */
export function isAddressLimited(key: string, limit: number): boolean {
  const bucket = buckets.get(key);
  return Boolean(bucket && Date.now() < bucket.resetAt && bucket.count >= limit);
}

/** テスト用。 */
export function resetAddressLimits(): void {
  buckets.clear();
}
