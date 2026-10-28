# Phase C（自己承認禁止）の前提整理 — 承認者2人目の候補（2026-10-28）

- 目的: `ALLOW_SELF_APPROVAL=false` へ切り替える前提（承認者が2名以上・別主体）を満たす候補を、
  実測データで整理する。**この稿は資料であり、実装・切替は行わない**（人間の判断待ち）。
- 関連: [docs/48](48-phase-c-cutover.md)（切替手順）/ [docs/49](49-role-model-decision.md)（ロールモデル）/
  [docs/47](47-role-separation-phase-a-b-20261027.md)（Phase A/B の実測）
- 実測: 2026-10-28 08:5x JST（本番 DB `ai_helpdesk_preview` と名簿 `mirai_info.employee_directory` の読み取りのみ）

## 1. 現状（実測）

| 項目 | 値 |
|---|---|
| `ALLOW_SELF_APPROVAL`（本番） | **true**（自己承認を許可し `self_approved=true` を記録） |
| 本番の承認ロール保持者 | **1 名**（`user_roles` の `approver` = 1） |
| その 1 名の実体 | シードのデモアカウント（`w***@example.com`） |
| 当該アカウントのログイン可否 | **不可**（`docs/MailAddress.txt` の許可リストは `kensan1969@gmail.com` と `@mirai-const.co.jp` のみ。`@example.com` は Access で拒否される） |
| 実在社員のアカウント | DX 推進部 5 名のうち **1 名のみ**（`MK0623`・`helpdesk`） |
| その 1 名の別名 | `EMAIL_ALIASES` により `k***@gmail.com` に正規化（＝依頼者と同一人物） |

**含意**: 現状の「承認者」は実質 **0 名**（ログインできる承認者がいない）。承認は
`ALLOW_SELF_APPROVAL=true` による自己承認（`helpdesk` の担当者）だけで成立している。
したがって **`ALLOW_SELF_APPROVAL=false` を先に切り替えると承認が全停止する**。
先に実在の承認者アカウントを2名以上用意する必要がある。

## 2. 候補（DX 推進部・実名とメールは伏せ字）

| 社員番号 | 所属 | メール | 既存アカウント | 別名衝突 |
|---|---|---|---|---|
| MK0370 | DX推進部 | あり | **なし** | なし |
| MK0655 | DX推進部 | あり | **なし** | なし |
| MK0952 | DX推進部 | あり | **なし** | なし |
| MK1073 | DX推進部 | あり | **なし** | なし |
| MK0623 | DX推進部 | あり | あり（`helpdesk`） | **あり**（`k***@gmail.com` に正規化） |

- 候補は **MK0370 / MK0655 / MK0952 / MK1073 の 4 名**。全員にメールがあり、Access の許可ドメイン
  （`@mirai-const.co.jp`）に該当する。
- **MK0623 は候補にしない**: 別名で 1 人に正規化されるため、職務分離の「別主体」にならない。
- 承認者を2名にする場合、上の 4 名から **2 名**を選ぶ（1 名は監査や他ロールと兼務可）。

## 3. 要件（Phase C を満たす条件）

1. 承認ロール保持者が **2 名以上**、かつ **同一人物（別名含む）でない**こと。
2. 全員が **Access でログインできる**こと（許可リスト内のドメイン／メール）。
3. 名簿で **DX 推進部**に解決できること（`requireHelpdeskActor` は所属で判定する）。
4. `auditor` と併存しないこと（`validateRoleSet` が拒否）。
5. 承認者自身が対応した案件を承認しないこと（`claimed_by` と承認者が別）。

## 4. 切替手順（案・実施は人間の判断後）

| # | 作業 | 実測で確認すること |
|---|---|---|
| 1 | 候補 2 名のアカウントを用意（初回 Access ログインで `users` に載るか、または `scripts/sync-roles.ts` の対象に含める） | `GET /api/me` が `employee` を返す（名簿で解決） |
| 2 | `hd-approver` グループに 2 名を追加し、`roles.json` を作る（[docs/55](55-access-group-mapping.md)） | `sync-roles.ts --file roles.json`（dry-run）で差分が想定どおり |
| 3 | `--apply --by <実行者>` で反映 | `user_roles` に `approver` が 2 名、監査 `auth.role.sync` が 1 行 |
| 4 | 承認の実測（検証環境で `ALLOW_SELF_APPROVAL=false`） | 自己承認 403 `SELF_APPROVAL_FORBIDDEN` / 別担当 200 `self_approved=false` |
| 5 | 本番の環境変数を `false` に変更して再起動 | `/api/health` が `ok`・`db:ok`、5xx 0 |
| 6 | スモーク（引継ぎ→承認→報告書） | 報告書 200・`audit_log` に `case_handover.approve` |

- **ロールバック**: 環境変数を `true` に戻して再起動（DB 変更なし）。ロール同期は
  `sync-roles.ts` を前の `roles.json` で再適用（監査が残る）。

## 5. 決定が必要な点（人間）

1. 承認者 2 名を誰にするか（MK0370 / MK0655 / MK0952 / MK1073 から）。
2. 切替の時期（Access グループ作成と同じタイミングか、別か）。
3. 切替後に `auditor` を誰にするか（併存不可のため、承認者と別人物）。

## 6. この稿で扱わないこと

- 実装・環境変数の変更・ユーザー作成・グループ作成（いずれも人間の判断後）。
- 監査ロールの割当（別途 [docs/55](55-access-group-mapping.md)）。

## 7. 実施状況（2026-10-28 追記）

- 2 アカウント（k-aritoh / gmail）で要件を満たし、`ALLOW_SELF_APPROVAL=false` を**適用済み**。
  適用内容・検証・ロールバック・運用上の変化は [docs/58](58-phase-c-applied-20261028.md)。
- **人物単位**の職務分離（実在の2人目・共有承認アカウント）は引き続き残課題。監査の `sharedIdentity` で
  「別アカウント・同一人物」を識別できる（[docs/57](57-shared-identity-20261028.md)）。
