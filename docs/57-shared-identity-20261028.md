# 承認の「同一人物」を記録する（sharedIdentity）— 2026-10-28

- 背景: [docs/56](56-identity-split-20261028.md) でメール別名を解除し、運用（k-aritoh）と承認（gmail）を
  別アカウントにした。これにより `self_approved=false` になるが、これは**別アカウント**の意味であり
  **同じ人物**である。監査・報告書が「別の担当者が承認した」と読めないよう、事実を記録する。
- 設計方針: `EMAIL_ALIASES` は引き続き **同一視（正規化）しない**。新設の `SHARED_IDENTITY_GROUPS` は
  **正規化せず、記録のためだけ**に使う。既定は空＝従来と完全に同じ挙動。

## 1. 変更

| 対象 | 変更 |
|---|---|
| 設定 | `SHARED_IDENTITY_GROUPS`（`a@x|b@y;c@z|d@w`）。既定 `''` |
| 判定 | `apps/api/src/auth/shared-identity.ts`（`sameHuman`。同じ文字列は false） |
| 引継ぎの承認 | 応答と監査 `case_handover.approve` の `detail` に `sharedIdentity` を追加。一覧/詳細 API も算出して返す |
| ナレッジ承認 | `/api/knowledge/ui-sync` の承認で、応答・監査 `knowledge.approve` に `sharedIdentity` を追加 |
| 報告書 | 引継ぎ欄に「承認者・承認日時・承認の性質（自己承認／別の担当者／別アカウント（同一人物））」を追加（値がある場合のみ） |

- `self_approved`（自己承認か）は従来どおり**アカウント一致**で判定し、意味を変えていない。
- `sharedIdentity` は「アカウントは違うが同一人物の組に含まれる」場合だけ `true`。

## 2. 検証（検証インスタンス `:18962`・`SHARED_IDENTITY_GROUPS` 設定あり）

`scripts/verify/split-identity-20261028.mjs` → **8/8 PASS**（詳細は
[docs/evidence/verify-20261027/delta/identity-split-20261028.md](evidence/verify-20261027/delta/identity-split-20261028.md)）。

| 観点 | 実測 |
|---|---|
| 引継ぎ承認の応答 | `handover.sharedIdentity=true`（`selfApproved=false`） |
| 引継ぎ承認の監査 | `case_handover.approve` の `detail.sharedIdentity=true` |
| ナレッジ承認 | 応答 `sharedIdentity=true`・監査 `selfApproved=false` / `sharedIdentity=true` |
| 回帰（ユニット） | `shared-identity` 5件・`final-report` 14件 PASS |
| 回帰（統合） | `case-handovers` / `knowledge-ui` 23件 PASS |

## 3. 限界（正直な範囲）

- **報告書は作成時点で承認情報がある場合だけ**表示する。端末セッションの報告書は対応中に作られ、
  承認（`completed`）はその後が多いため、実際には「承認の性質」が空になることがある。
- 画面（プロトタイプ JS）が組み立てる最終報告書は、UI が `handover.approvedBy` 等を送らない限り
  承認欄は入らない（サーバ側の端末報告書のみ対応）。
- `SHARED_IDENTITY_GROUPS` は運用設定であり、**人物の同一性を自動判定するものではない**。
  組の更新は人間が行う（別名の追加・退職時の削除）。

## 4. 本番反映

- `~/.config/ai-helpdesk/api.conf` に `SHARED_IDENTITY_GROUPS=kensan1969@gmail.com|k-aritoh@mirai-const.co.jp` を追加し、
  `COMMIT_SHA` を反映 commit に更新して再起動する（手順は [docs/40](40-deploy-20261027.md) と同じ）。
- ロールバック: 当該行を削除して再起動（コードは残るが、組が空なら従来挙動）。
