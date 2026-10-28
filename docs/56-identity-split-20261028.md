# 同一人物のメール別名の解除（運用=k-aritoh / 承認=gmail）— 2026-10-28

- 決定: Phase C の前提として、`EMAIL_ALIASES` による同一視（`k-aritoh@mirai-const.co.jp` →
  `kensan1969@gmail.com`）を解除し、**運用アカウントと承認アカウントを分ける**。
- 目的: 別アカウントによる承認（`self_approved=false`）を成立させ、承認者2人目の要件を満たす。
- 検証: [docs/evidence/verify-20261027/delta/identity-split-20261028.md](evidence/verify-20261027/delta/identity-split-20261028.md)

## 1. 変更内容（本番）

| 対象 | 変更 | バックアップ |
|---|---|---|
| `~/.config/ai-helpdesk/api.conf`（systemd `EnvironmentFile`） | `EMAIL_ALIASES=k-aritoh@mirai-const.co.jp=kensan1969@gmail.com` → `EMAIL_ALIASES=`（空） | `api.conf.bak-20261028`（600・同内容） |
| `user_roles`（本番 DB `ai_helpdesk_preview`） | `kensan1969@gmail.com` に `approver` を追加（`source='manual'`, `granted_by='k-aritoh@mirai-const.co.jp'`） | 不要（1行） |
| サービス | `systemctl --user restart ai-helpdesk-api.service`（09:23:36） | — |

- 先に systemd の drop-in（`Environment="EMAIL_ALIASES="`）を試したが、**`EnvironmentFile=` が後から読まれて上書き**されるため無効だった。drop-in は削除し、`api.conf` の1行を変更した。
- 変更後の実測: `EMAIL_ALIASES` は空（`/proc/<pid>/environ`）・`/api/health` は `ok`/`db ok`/`commit=be1e0c3`。

## 2. 検証（検証インスタンス `:18962`・同一コード `05b2398`・`EMAIL_ALIASES=''`）

`scripts/verify/split-identity-20261028.mjs` で **5/5 PASS**。

| 観点 | 実測 |
|---|---|
| 状態キーの分離 | `operator=k-aritoh@mirai-const.co.jp` / `approver=kensan1969@gmail.com` |
| 名簿解決の分離 | operator=`MK0623`（DX）/ approver=`null`（demo 扱い） |
| 指名付き引継ぎの claim | operator で **200** |
| 別アカウント承認 | approver で **200**・`self_approved=false`（API と DB の両方） |
| 監査 | `case_handover.create/claim/approve` に運用者と承認者が**別々**に記録 |

## 3. 影響（期待どおりの副作用）

- **gmail は demo 扱い**になる（`PERSONA_SWITCH_ALLOWLIST` で許可）。`employeeNo=null` のため
  `/api/me` は `employee=null`、**宛先を指名した引継ぎの claim は 403**（本人確認できない）。
  → 運用は k-aritoh（名簿あり）、承認は gmail、という役割分担を前提とする。
- 既存データ（`prototype_states`・`case_handovers.owner_email` 等）の帰属は**変更しない**（gmail 名義のまま）。
- 「操作する人」の切替は gmail のみ `any`（従来どおり）。k-aritoh は `self`。

## 4. インシデント（同日 09:25・復旧済み）

- 検証インスタンス（`:18962`）を止める際に `pkill -TERM -f "node apps/api/dist/index.js"` を使い、
  **同じコマンドラインで動く本番 API も停止**した（約 20 秒: 09:25:0x〜09:25:22）。
- `systemctl --user start ai-helpdesk-api.service` で復旧。`/api/health` は `ok`/`db ok`/`commit=be1e0c3`、
  公開 URL は 302。アプリログ上の 5xx は 0（停止中はアプリが応答しないため、外形は 502/接続不可）。
- 原因: ①パターン一致が広すぎた ②本番ユニットに `Restart=` が無く自動復帰しない（`NRestarts=0`）。
- 再発防止（実施済み）: 以後は **PID/ポート指定**で停止する。`Restart=always` の追加は未実施（提案）。

## 5. ロールバック

1. `cp -p ~/.config/ai-helpdesk/api.conf.bak-20261028 ~/.config/ai-helpdesk/api.conf`
2. `systemctl --user restart ai-helpdesk-api.service`
3. `DELETE FROM user_roles WHERE user_id = (SELECT id FROM users WHERE lower(email)='kensan1969@gmail.com') AND role='approver' AND source='manual';`
4. `/api/health` が `ok`・`db ok`、`EMAIL_ALIASES` が元に戻ったことを確認。

## 6. 未実施・注意

- **本番での実承認スモーク**は未実施（本番は `ACCESS_JWT_MODE=enforce` のため、Access の JWT なしでは
  認証済み API を自動実行できない）。実測は検証インスタンス（同一コード・同一設定）で行った。
- `self_approved=false` は「**別アカウント**」の意味であり、**同じ人物**である。監査・報告書が
  「別の担当者が承認した」と読めないよう、人物レベルの同一性を記録する小改修（`sharedIdentity`）は未実施。
