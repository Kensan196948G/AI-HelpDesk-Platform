# 本番承認者・責任者の 4 アカウント構成 — 2026-10-31

- ユーザー指示（2026-10-31）: 本番承認者及び責任者を次の 4 アカウントとし、それ以外の `@mirai-const.co.jp` は除外する。
- 関連: [docs/54](54-phase-c-approver-candidates.md)（候補整理。本稿で候補 4 名の案は不採用）/
  [docs/55](55-access-group-mapping.md) / [docs/57](57-shared-identity-20261028.md) / [docs/58](58-phase-c-applied-20261028.md)
- 区分: **Approval PR**（認可モデルの変更 + 外部公開範囲の拡大）。Y 取得前に本番へ適用しない。

## 1. 構成（実メールは運用設定と `docs/MailAddress.txt` のみに置く）

| アカウント | 名簿の所属（2026-10-31 実測） | Access ログイン（変更前） | 人物 |
|---|---|---|---|
| `k-a***@mirai-const.co.jp` | DX推進部（MK0623） | 可 | A |
| `k***@gmail.com` | 名簿外（デモ扱い） | 可 | A（同一人物。`SHARED_IDENTITY_GROUPS` 設定済み） |
| `r-k***@mirai-const.co.jp` | 技術部（MK0613） | 可 | B |
| `h***@takamatsu-cg.co.jp` | 名簿外（社外） | **不可** | C |

アカウントは 4、人物は 3。A の 2 アカウント間の承認は従来どおり `sharedIdentity=true` で記録する。

## 2. 解釈（前提）

| 指示 | 解釈 | 理由 |
|---|---|---|
| 本番承認者 | `user_roles.approver` の保持者。引継ぎ承認とナレッジ承認/差戻しの実行権 | 既存のロール定義 |
| 責任者 | `RESOLVE_ADMIN_ALLOWLIST`（リスク 4 以上の Skill 承認） | コード上「責任者」というロールは無く、最も権限の重い承認がこれに当たる。現在の本番は未設定（誰も承認できない） |
| 他の `@mirai-const.co.jp` を除外 | **承認権限からの除外**。ログイン許可は狭めない | 依頼者は全社員。ログインから除外すると相談窓口自体が使えなくなる |

## 3. 変更前の問題

承認 API は `user_roles` を見ず、名簿の所属（DX 推進部）だけで判定していた。そのため次の状態だった。

- 除外対象の DX 推進部 4 名（MK0370 / MK0655 / MK0952 / MK1073）が承認できる。
- `approver` を付与しても、技術部と社外の承認者は 403 で承認できない。

## 4. 変更（コード）

| 対象 | 変更後 |
|---|---|
| `POST /api/case-handovers/:id/approve` | `approver` ロールのみ（所属不問） |
| `POST /api/knowledge/ui-sync` の `approved` / `rejected` | `approver` ロールのみ（所属不問）。`draft` / `pending` は従来どおり DX 推進部 |
| `GET /api/knowledge/pending` | `approver` または DX 推進部 |
| `GET /api/employees`・`GET /api/case-handovers/recipients` | 名簿で解決できない利用者（社外）には空を返す |
| `docs/MailAddress.txt` | 社外の承認者 1 件を**完全一致**で追加（ドメインは許可しない） |

変更しないもの: 受信箱・claim・解決記録（DX 推進部のみ）、`ALLOW_SELF_APPROVAL=false`、`EMAIL_ALIASES`（空）、
`SHARED_IDENTITY_GROUPS`、画面の DOM / CSS。

## 5. 本番適用手順（Y 取得後）

| # | 作業 | 確認 |
|---|---|---|
| 1 | バックアップ（`pg_dump`、`api.conf` の複製） | 復元可能なファイルがある |
| 2 | 名簿外・未登録の 2 名を `users` に登録（`password_hash='access-only$no-login'`） | パスワードログイン不可 |
| 3 | `sync-roles.ts` で 2 名に `approver` を付与し、シードの `w***@example.com` から `approver` を外す（dry-run → `--apply`） | `approver` が 4 アカウントだけ、監査 `auth.role.sync` |
| 4 | Access ポリシー `1a05a10a-…` の include に社外の 1 件を完全一致で追加 | 他の include が不変 |
| 5 | メイン作業ツリーをマージ済み commit へ更新し build。`RESOLVE_ADMIN_ALLOWLIST` と `COMMIT_SHA` を設定して再起動 | `/api/health` = ok、commit 一致 |
| 6 | スモーク | 下記 §6 |

## 6. 本番スモーク

- 公開 URL 302、`/api/health` ok、再起動後の 5xx 0。
- 検証インスタンスで 4 アカウントのロール判定を確認。Access の JWT（enforce）のため、
  社外アカウントの実ログインは本人の One-time PIN 受信が必要（自動化不可）。

## 7. 既知の制約

1. **引継ぎ承認の画面経路**: 画面は「自分の状態にある案件」から承認する。受信箱・claim を持たない
   技術部・社外の承認者は、API の権限はあっても**画面から引継ぎ承認へ到達できない**。ナレッジ承認
   （`GET /api/knowledge/pending` の一覧）は画面から操作できる。引継ぎ承認は当面 DX 推進部の承認者
   2 アカウントで運用する。
2. **社外アカウントが閲覧できる情報**: 承認待ちナレッジの本文（伏せ字後）と作成者メール、自分の相談画面。
3. **同一人物**: A の 2 アカウント間の承認は職務分離が人物単位で成立しない（監査に記録）。
4. **除外の範囲**: 除外した DX 推進部 4 名は担当者業務（受信箱・claim・解決記録）を続けられる。

## 8. ロールバック

1. Access ポリシーから社外の 1 件を削除する。
2. `api.conf` をバックアップへ戻し、前の commit を build して再起動する。
3. `sync-roles.ts` を変更前の内容で再適用する（監査は追記のみ）。
   追加した `users` 行は `is_active=false` にする（履歴の参照のため削除しない）。
