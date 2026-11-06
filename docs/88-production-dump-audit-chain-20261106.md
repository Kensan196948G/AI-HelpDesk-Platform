# 88. 本番 dump の監査鎖検証（2026-11-06 JST）

## 0. 結論

**本番の fresh dump を staging クラスタの使い捨て DB へ復元し、監査ハッシュ鎖を検証した。結果は本番と完全一致（`AUDIT_CHAIN_MATCH`）。**

| 項目 | 結果 |
|---|---|
| 入力 dump | `ai_helpdesk_preview-20261106-114516.dump`（266,592 B / sha256 `1d3a6f76…`） |
| 復元先 | `127.0.0.1:5437` の使い捨て DB `aihd_audit_chain_20261106071128`（**本番クラスタには作らない**） |
| 復元結果 | 35 table / `schema_migrations` 37 / `audit_log` 80 行 / `users` 10 行 |
| 検証 | `readOnly: true`、checked **80**、mismatchCount **2**、ids **`[10010, 10013]`**、kind **`hash_mismatch`** |
| 本番との比較 | **一致**（`AUDIT_CHAIN_MATCH`） |
| 後処理 | drill DB を削除（残留 0） |

## 1. 手順

```bash
# 1) staging クラスタ内に使い捨て DB を作成
psql -p 5437 -d postgres -c 'CREATE DATABASE "aihd_audit_chain_<ts>"'
# 2) 本番 dump を復元（本番 DB へは書き込まない）
pg_restore --no-owner --no-privileges --exit-on-error -d <drill> <dump>
# 3) 監査鎖を検証（設定は staging 設定ファイルから供給し、接続先だけ差し替える）
node scripts/run-with-env-file.mjs ~/.config/ai-helpdesk/stg-api.conf -- \
  env AUDIT_SCAN_DATABASE_URL=<drill> NODE_ENV=production \
  ./node_modules/.bin/tsx scripts/audit-find-breaks.ts
# 4) 本番の結果と機械比較（mismatchCount / ids / kinds）
# 5) drill DB を削除
```

**注意（実測）**: `SESSION_SECRET` 等を環境に用意せずに `tsx scripts/audit-find-breaks.ts` を直接実行すると `[config] 環境変数が不足しています: { SESSION_SECRET: ... }` で失敗する。`run-with-env-file.mjs` で設定ファイルを読ませ、`AUDIT_SCAN_DATABASE_URL` だけを上書きする形が正しい。

## 2. 意味と限界

- **意味**: バックアップから復元した DB の監査鎖は、本番が既知破断として扱っている 2 点（`10010` / `10013`、種別 `hash_mismatch`）以外に破断・欠損が無い。`prev_hash_mismatch` は 0 件。
- **限界**:
  - これは「復元しても監査鎖の検証結果が変わらない」ことの証拠であり、**チェーンの暗号学的な真正性・改ざん不能性の証明ではない**。
  - 既知破断 2 件は本番の `AUDIT_KNOWN_BREAKS` に登録済みのもので、**解消されたわけではない**。
  - 検証は read-only 接続で行ったが、DB のロール・ACL・所有権の一致は確認していない（`--no-owner` で復元）。
  - RPO / RTO の測定ではない。

## 3. 参照

- 切替記録: `docs/85`
- 再配備と rollback 訓練: `docs/86` / `docs/87`
- 復元訓練（行数照合）: `docs/78` §7-1、`docs/81` §10
- 監査の既知破断の扱い: `scripts/audit-find-breaks.ts` の `AUDIT_KNOWN_BREAKS`
