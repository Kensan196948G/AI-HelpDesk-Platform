-- F-10: 同一利用者・同一内容の最終報告書の二重作成を防ぐ。
--
-- POST /api/reports/final は (user_email, sha256) が同じ既存行を返す（reused=true）
-- ようにしたが、同時リクエストの競合を DB 側でも止める必要がある。
--
-- 既存データの重複について:
--   2026-10-27 時点の本番 DB（final_reports 3 件）とテスト DB では
--   (user_email, sha256) の重複は 0 件だった。ただし他環境で重複が残っていても
--   migration が失敗しないよう、先に「最後に作成された行」だけを残して解消する。
--   重複が無い環境では DELETE は 0 行。
DELETE FROM final_reports a
USING final_reports b
WHERE a.user_email = b.user_email
  AND a.sha256 = b.sha256
  AND (a.created_at, a.id) < (b.created_at, b.id);

-- sha256 は NOT NULL だが、将来 NULL 許容へ広げても意図せず衝突しないよう
-- 部分一意インデックスにする（NULL の行は対象外）。
CREATE UNIQUE INDEX IF NOT EXISTS final_reports_user_sha256_uq
  ON final_reports (user_email, sha256)
  WHERE sha256 IS NOT NULL;
