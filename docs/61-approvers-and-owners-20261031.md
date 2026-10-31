# 本番承認者・責任者の 4 アカウント構成 — 2026-10-31

- ユーザー指示（2026-10-31）: 本番承認者及び責任者を次の 4 アカウントとし、それ以外の `@mirai-const.co.jp` は除外する。
- 関連: [docs/54](54-phase-c-approver-candidates.md)（候補整理。本稿で候補 4 名の案は不採用）/
  [docs/55](55-access-group-mapping.md) / [docs/57](57-shared-identity-20261028.md) / [docs/58](58-phase-c-applied-20261028.md)
- 区分: **Approval PR**（認可モデルの変更 + 外部公開範囲の拡大）。Y 取得前に本番へ適用しない。

## 1. 構成（社外の実メールはリポジトリに置かない）

| アカウント | 名簿の所属（2026-10-31 実測） | Access ログイン（変更前） | 人物 |
|---|---|---|---|
| `k-a***@mirai-const.co.jp` | DX推進部（MK0623） | 可 | A |
| `k***@gmail.com` | 名簿外（デモ扱い） | 可 | A（同一人物。`SHARED_IDENTITY_GROUPS` 設定済み） |
| `r-k***@mirai-const.co.jp` | 技術部 | 可 | B |
| `h***@（社外ドメイン）` | 名簿外（社外） | **不可** | C |

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
| `GET /api/knowledge/pending` | DX 推進部は `draft` + `pending`。DX 推進部以外の `approver` は `pending` のみ |
| ナレッジの判定時の本文 | 他人のナレッジの判定では本文を更新しない。確認後に本文が変わっていれば承認は 409。DX 推進部以外の `approver` が判定できるのは `pending` のみ。未知の `clientRef` からの行作成には DX 推進部の権限が必要 |
| 遠隔対応（`/api/remote-support/*`） | `users.role` に加えて DX 推進部の確認を必須にする（承認者に担当者権限を与えない） |
| `GET /api/employees`・`GET /api/case-handovers/recipients` | 名簿で解決できない利用者（社外）には空を返す |
| `docs/MailAddress.txt` | **変更しない**。公開リポジトリのため、社外の実メールはリポジトリ外の許可リスト（§5）に置く |

変更しないもの: 受信箱・claim・解決記録（DX 推進部のみ）、`ALLOW_SELF_APPROVAL=false`、`EMAIL_ALIASES`（空）、
`SHARED_IDENTITY_GROUPS`、画面の DOM / CSS。

## 5. 本番適用手順（Y 取得後）

| # | 作業 | 確認 |
|---|---|---|
| 1 | バックアップ（`pg_dump`、`api.conf` の複製） | 復元可能なファイルがある |
| 2 | 未登録の 2 名を `users` に登録（`role='requester'`、`password_hash='access-only$no-login'`） | パスワードログイン不可、主ロールが担当者でない |
| 3 | `sync-roles.ts` で 2 名に `approver` を付与し、シードの `w***@example.com` から `approver` を外す（dry-run → `--apply`） | 実効ロール（`user_roles`、0 行なら `users.role`）の `approver` が 4 アカウントだけ、監査 `auth.role.sync` |
| 4 | Access ポリシー `1a05a10a-…` の include に社外の 1 件を完全一致で追加。`~/.config/ai-helpdesk/access-allowlist.txt`（0600）を `docs/MailAddress.txt` + 社外 1 件で作成 | 他の include が不変、ドメイン許可なし |
| 5 | メイン作業ツリーをマージ済み commit へ更新し build。`ACCESS_ALLOWLIST_FILE`（上記の絶対パス）、`RESOLVE_ADMIN_ALLOWLIST`、`COMMIT_SHA` を設定して再起動 | `/api/health` = ok、commit 一致 |
| 6 | スモーク | 下記 §6 |

## 6. 本番スモーク

- 公開 URL 302、`/api/health` ok、再起動後の 5xx 0。
- 検証インスタンスで 4 アカウントのロール判定を確認。Access の JWT（enforce）のため、
  社外アカウントの実ログインは本人の One-time PIN 受信が必要（自動化不可）。

## 7. 既知の制約

1. **画面経路（未解消）**:
   - 技術部・社外の承認者は画面で一般社員扱いになり（`/api/me` の `roles` は画面の役割判定に使われない）、
     **ナレッジ承認画面を開けない**。権限があるのは API のみ（コード読解による。実ブラウザでは未確認）。
   - 引継ぎの完了承認は `ALLOW_SELF_APPROVAL=false` の間、画面から行えず API の直接呼び出しが必要。この制約は本変更の前から存在する。
   - そのため現時点で画面からナレッジ承認できるのは人物 A の 2 アカウントだけで、A の下書きを別人物が画面で承認できない。
2. **社外アカウントの権限**: 申請済みナレッジの本文（伏せ字後）と作成者メールの閲覧・判定に加え、責任者として
   リスク 4 以上の Skill の**管理者承認を実行できる**（`/api/resolve/steps/:id/admin-approve`）。承認待ち一覧
   （`/api/resolve/admin/pending`）では**依頼者メールと deviceId も閲覧できる**。この機能は現在の本番では未設定で、
   本変更で初めて有効になる。
   一般利用者向けの機能（AI 回答、DX 推進部への引継ぎ作成）も依頼者と同様に使える。
3. **同一人物**: A の 2 アカウント間の承認は職務分離が人物単位で成立しない（監査に記録）。
4. **除外の範囲**: 除外した DX 推進部 4 名は担当者業務（受信箱・claim・解決記録）を続けられる。
   自分の下書きを画面で差し戻すと、ローカルは差戻しになるがサーバは 403 で `pending` のまま残る。
5. **名簿障害時**: 名簿を参照できないと社内利用者にも社員一覧が空で返る（`source=restricted`。fail-closed）。
6. **許可リストの正本**: 適用後の本番は `~/.config/ai-helpdesk/access-allowlist.txt` を読む。`docs/MailAddress.txt` を
   更新しても本番には反映されない。
7. **本文照合の限界**: 照合はトランザクション外の読み取りで行い、`keywords` は対象外。照合直後の並行更新は検出できない。
   DX 推進部の `approver` が他人の行を `pending` で書き換えてから承認する経路は既存のまま残る。

## 8. ロールバック

1. Access ポリシーから社外の 1 件を削除する。
2. `api.conf` をバックアップへ戻し、前の commit を build して再起動する。再起動の成功後に
   `access-allowlist.txt` を削除する（先に消すと fail-closed で全利用者が 403 になる）。
3. `sync-roles.ts` を変更前の内容で再適用する（監査は追記のみ）。
   追加した `users` 行は `is_active=false` にする（履歴の参照のため削除しない）。

## 9. 本番適用結果（2026-10-31 19:36 JST・ユーザー Y 判定後）

| 項目 | 結果 |
|---|---|
| マージ / デプロイ | PR #115 head `1130d93` → squash `98f80ec`。`/api/health` は ok・db ok・commit 一致 |
| DB | スキーマ変更なし。`users` 2 行追加、ロール変更 3 件（監査 `auth.role.sync` 3 行） |
| 実効 `approver` | 指定の 4 アカウントのみ |
| Access | allow ポリシーに社外 1 件を完全一致で追加。他の include は不変 |
| 設定 | `ACCESS_ALLOWLIST_FILE`（リポジトリ外）、`RESOLVE_ADMIN_ALLOWLIST`（4 件）、`COMMIT_SHA` |
| 公開 URL / 再起動後のエラー | 302 / 5xx・error ログ 0 |

検証（`127.0.0.1` のみ・DB 読み取り専用の確認用インスタンス。Access の JWT 検証は無効）:

| アカウント | 実測 |
|---|---|
| 人物 A の 2 アカウント | `approver + helpdesk`、責任者、受信箱 200 |
| 技術部の承認者 | `approver`、責任者、受信箱 403、遠隔対応 403 |
| 社外の承認者 | `approver`、責任者、受信箱 403、遠隔対応 403、社員名簿・宛先候補 0 件 |
| 同じ社外ドメインの別アカウント | 全 API 403 |
| 除外した DX 担当者（1 名で確認） | ロールなし、受信箱 200、引継ぎ承認 403 |

未実施: 実ブラウザでの確認、社外アカウントの実ログイン（本人の One-time PIN が必要）、書き込みを伴う承認の本番実行。
