# Phase C（自己承認禁止）の適用 — 2026-10-28

- 決定: [docs/54](54-phase-c-approver-candidates.md) の要件を、**2つの保有アカウント**（k-aritoh / gmail）で満たし、
  `ALLOW_SELF_APPROVAL=false` を本番へ適用した。同一人物のため、職務分離は**アカウント単位**で成立する
  （人物単位ではない。監査には `sharedIdentity` を記録 — [docs/57](57-shared-identity-20261028.md)）。
- 検証: [docs/evidence/verify-20261027/delta/phasec-20261028.md](evidence/verify-20261027/delta/phasec-20261028.md)

## 1. 変更（本番）

| 対象 | 変更 |
|---|---|
| 本番 DB `user_roles` | `k-aritoh@mirai-const.co.jp` に `approver` を追加（`source='manual'`）。これで 2 アカウントとも `helpdesk + approver` |
| `~/.config/ai-helpdesk/api.conf` | `ALLOW_SELF_APPROVAL=false`（バックアップ `api.conf.bak3-20261028`） |
| サービス | `systemctl --user restart`（09:41） |

- 適用後の実測: `ALLOW_SELF_APPROVAL=false`・`EMAIL_ALIASES` 空・`/api/health` = `ok`/`db ok`/`commit=c0de9cb`、
  公開 URL 302、再起動後の 5xx **0**。
- 変更前の状態: gmail のみ `approver`、k-aritoh は `helpdesk` のみ、自己承認は許可。

## 2. 検証（検証インスタンス `:18962`・同一コード・`ALLOW_SELF_APPROVAL=false`）

| # | 観点 | 実測 |
|---|---|---|
| 1 | **同一アカウント**の承認 | **403 `SELF_APPROVAL_FORBIDDEN`** |
| 2 | **別アカウント**（同一人物）の承認 | **200**・`self_approved=false`・`sharedIdentity=true` |

- 既存の検証（[docs/56](56-identity-split-20261028.md)・[docs/57](57-shared-identity-20261028.md)）:
  状態キー分離・名簿解決分離・指名 claim・監査の両者記録 8/8 PASS。

## 3. 運用上の変化（重要）

- **同じアカウントで claim した案件は、そのアカウントでは承認できない**（403）。承認は**もう一方のアカウント**で行う。
  両方に `approver` があるため、どちら向きでも運用できる。
- 画面のログイン（Access）を切り替える必要がある。切替は Cloudflare Access のログイン（One-time PIN）。
- ナレッジの承認（`/api/knowledge/ui-sync` の approved）も同じ規則（作成者と承認者が別アカウント）。
- 監査・応答の `sharedIdentity=true` は「別アカウント・同一人物」を意味する（人物分離ではない）。

## 4. ロールバック

1. `cp -p ~/.config/ai-helpdesk/api.conf.bak3-20261028 ~/.config/ai-helpdesk/api.conf`
2. `systemctl --user restart ai-helpdesk-api.service`
3. `DELETE FROM user_roles WHERE role='approver' AND source='manual' AND user_id=(SELECT id FROM users WHERE lower(email)='k-aritoh@mirai-const.co.jp');`（任意）
4. `/api/health` が `ok`・`db ok` を確認。

## 5. 残課題

- **人物単位の職務分離**は未達（同一人物の2アカウント）。実在の2人目（MK0370 等）または共有承認アカウントの
  確定後に、`sharedIdentity` が常に `false` となる構成へ移行するのが本来の姿。
- 本番での実承認スモークは、Access の JWT（enforce）のため自動実行できない。人間のログインで1回確認する
  （[docs/54 §4](54-phase-c-approver-candidates.md) の手順 4〜6 相当）。
