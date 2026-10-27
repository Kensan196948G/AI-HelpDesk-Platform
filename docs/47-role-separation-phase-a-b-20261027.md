# 4ロール職務分離 Phase A（突合レポート）と Phase B（実装）— 2026-10-27

- 正本: [docs/43](43-role-separation-design.md)（設計提案）
- 本稿: Phase A の実測レポートと、Phase B で実装した内容
- 前提: Cloudflare Access のグループ作成は**人間ゲート**（アプリ側はグループ未設定でも現行動作を維持する）

## 1. Phase A: 名簿の DX 所属（実測）

名簿 `mirai_info.employee_directory`（有効）から DX 推進部を抽出した（2026-10-27 18:47・読み取りのみ）。

| 社員番号 | 氏名（伏せ字） | 所属 | メール |
|---|---|---|---|
| MK0370 | 加** | DX推進部 | あり |
| MK0623 | 有** | DX推進部 | あり |
| MK0655 | 岡** | DX推進部 | あり |
| MK0952 | 砂** | DX推進部 | あり |
| MK1073 | 佐** | DX推進部 | あり |

- DX 推進部の有効社員は **5 名**、全員にメールがある。全社の有効社員は 433 名。
- 実名・メールは本稿に書かない（リポジトリ規約）。

### 1-1. Access グループとの突合（現状）

| グループ（案） | 用途 | 現状の割当 |
|---|---|---|
| `hd-support` | 担当（引継ぎ・RSP 実行） | **未作成**（Cloudflare 側の人間作業） |
| `hd-approver` | ナレッジ承認 | **未作成** |
| `hd-auditor` | 監査（読み取り専用） | **未作成** |
| `hd-itops` | IT 端末管理 | **未作成** |

- したがって **5 名全員が未割当**。アプリはグループ未設定のとき従来どおり `helpdesk` 相当で動く（Phase B のフォールバック）。
- 割当案（人数の根拠）: `hd-approver` は職務分離のため **2 名以上**（Phase C の前提）、`hd-auditor` は 1 名（兼務可）、`hd-itops` は 1 名。具体名は Access 管理者が決める。

## 2. Phase B: 実装（2026-10-27）

| 変更 | 内容 |
|---|---|
| ロール拡張 | `apps/api/src/auth/types.ts`: `requester / helpdesk / approver / auditor / itops` の 5 種 |
| DB | **migration 024**: `users_role_check` の許可値を 5 種へ（既存行は不変） |
| 監査の分離 | `auditor` は **読み取り専用**。`authenticate()` で GET/HEAD/OPTIONS と `/api/auth/logout`・`/api/audit/verify` 以外の呼び出しを **403**（`監査ロールは閲覧のみです`） |
| 監査の閲覧 | `GET /api/audit` と `POST /api/audit/verify` を `approver` **または** `auditor` に許可 |
| 互換性 | `helpdesk` / `approver` / `requester` の権限は変更しない（Access グループ未設定でも現行動作） |

### 2-1. テスト

`apps/api/src/auth/role-separation.integration.test.ts`（4件・すべて pass）:

1. `assertNotAuditorWrite`: 監査の書込みは 403、GET・監査検証・ログアウトは許可、他ロールは不変
2. `auditor` セッションで `GET /api/audit` → **200**
3. `auditor` セッションで書込み API（`POST /api/knowledge/:id/review`）→ **403**（監査ロールのメッセージ）
4. `approver` セッションで `GET /api/audit` → **200**（従来どおり）

### 2-2. 未実装（Phase B の残り）

- **Access グループ → `users.role` の同期**: グループ未作成のため未実装（人間ゲート後）。
- **`itops` の端末系権限**: `routes/device.ts` / `routes/terminal.ts` は現在 `authenticateTerminal` / `authenticateUi` と名簿判定で、`requireRole` を使っていない。`itops` への置換は端末系の認可モデルを変えるため Phase B の第2段として分離した（現状 `helpdesk` が端末系を使える既存挙動は維持）。
- **Phase C**（`ALLOW_SELF_APPROVAL=false` を本番既定へ）: 承認者が 2 名以上いることの確認後（未）。

## 3. ロールバック

- migration 024 は CHECK 制約の許可値追加のみ。戻す場合は `auditor`/`itops` の行が 0 件であることを確認してから 3 値へ戻す。
- コードは revert → build → restart。
