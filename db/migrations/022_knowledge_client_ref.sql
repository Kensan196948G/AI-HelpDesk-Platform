-- F-06: ナレッジ下書き・承認のサーバ永続化。
--
-- 従来、画面（STEP6 の下書き作成・承認・差戻し）はブラウザ内の state だけを
-- 更新しており、サーバの knowledge テーブルは空のままだった（docs/39 の F-06）。
-- docs/41 の「別 ID での承認」も、下書きがクライアント状態のため API 直接で
-- しか検証できていなかった。
--
-- 画面の下書き ID をキーに POST /api/knowledge/ui-sync が冪等に同期できるよう
-- client_ref を追加する。既存行（サーバ API から作成されたもの）は
-- client_ref IS NULL のままで、部分一意インデックスの対象外なので影響を受けない。
ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS client_ref text;

CREATE UNIQUE INDEX IF NOT EXISTS knowledge_client_ref_uq
  ON knowledge (client_ref)
  WHERE client_ref IS NOT NULL;

COMMENT ON COLUMN knowledge.client_ref IS
  '画面（プロトタイプ UI）の下書き ID。UI からの同期を冪等にする外部キー（F-06）。';
