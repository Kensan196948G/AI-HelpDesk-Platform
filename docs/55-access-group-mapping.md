# Access 4グループ → ロール同期の設計案（2026-10-28）

- 目的: Cloudflare Access に `hd-support` / `hd-approver` / `hd-auditor` / `hd-itops` の 4 グループを
  作ったあと、**誰にどのロールを与えるか**を機械的に適用できるようにする。**この稿は設計案であり、
  グループ作成・ロール適用は行わない**（いずれも人間の作業）。
- 関連: [docs/43](43-role-separation-design.md)（設計）/ [docs/49](49-role-model-decision.md)（決定）/
  [docs/47](47-role-separation-phase-a-b-20261027.md)（実装）/ [docs/54](54-phase-c-approver-candidates.md)（承認者候補）

## 1. 対応表（グループ → ロール → できること）

| グループ（案） | ロール | できること | できないこと |
|---|---|---|---|
| `hd-support` | `helpdesk` | 引継ぎの受信箱・claim・解決記録、RSP 実行セッション、ナレッジ下書き/申請 | 承認（`hd-approver` が別人物の場合）、監査の確定 |
| `hd-approver` | `approver` | ナレッジ承認（`/knowledge/ui-sync` の approved）、監査の閲覧（`GET /audit`） | 監査ロール専用の書込み拒否の対象外（approver は書込み可） |
| `hd-auditor` | `auditor` | 監査の閲覧（`GET /audit`）・監査チェーンの検証（`POST /audit/verify`） | **すべての書込み（403）**・他ロールとの併存 |
| `hd-itops` | `itops` | 端末系（現状は `helpdesk` と同じ経路。ロールによる制限は未実装） | 現時点で固有の制限は無い（docs/43 §2-2 の第2段） |

- 1 人が複数グループに入ることは可（`user_roles` に複数行）。ただし **`auditor` は単独**。
- 主ロール（`users.role`）は既存互換のため残す。判定は `user_roles` の集合を正本とする。

## 2. 同期の入力（`roles.json`）

`scripts/sync-roles.ts` は「メール → ロール配列」の JSON を `user_roles` に適用する。

```json
{
  "users": {
    "member-a@mirai-const.co.jp": ["helpdesk"],
    "member-b@mirai-const.co.jp": ["approver"],
    "member-c@mirai-const.co.jp": ["auditor"],
    "member-d@mirai-const.co.jp": ["helpdesk", "itops"]
  }
}
```

- 形式は `{"users": {...}}` でも、フラットな `{"a@…": ["helpdesk"]}` でもよい。
- **不明なメールは既定でエラー**（誤字で権限を付けない）。緩めたい場合だけ `--allow-unknown`。
- `auditor` と他ロールの併存は `validateRoleSet` が拒否する（同期全体が失敗する）。

## 3. 適用手順

```bash
# 1) 差分の確認（DB は変更しない）
npx tsx scripts/sync-roles.ts --file roles.json

# 2) 適用（1 トランザクションで置換 + 監査 auth.role.sync）
npx tsx scripts/sync-roles.ts --file roles.json --apply --by "<実行者メール>" --source access-group
```

- 適用後は `user_roles` が**置き換え**になる（差分適用ではない）。`roles.json` は常に「あるべき姿」を書く。
- 実行者のメールは `--by` に明示する（監査 `detail.actorEmail` に入る）。
- 反映は API 側のロールキャッシュ（30 秒）を待つか、再起動で即時反映。

## 4. グループ未設定時のフォールバック（現行）

- Access グループが未作成・未同期の間は、`users.role`（主ロール）と名簿の所属で従来どおり動く。
- `requireHelpdeskActor` は **名簿の所属（DX 推進部）** で判定するため、グループ未設定でも
  担当者の権限は失われない（fail-closed は「名簿で解決できない場合」だけ）。
- この間、`approver` は 1 名（実質ログイン不可）なので、承認は自己承認で運用している
  （[docs/54 §1](54-phase-c-approver-candidates.md)）。

## 5. 適用手順（グループ作成後）

| # | 作業 | 確認 |
|---|---|---|
| 1 | Access で 4 グループを作成し、メンバーを割当 | グループに 2 名以上（`hd-approver`） |
| 2 | グループのメンバーを `roles.json` に書き出す | メールは `@mirai-const.co.jp` のみ（許可リスト内） |
| 3 | `sync-roles.ts --file roles.json`（dry-run） | 追加・削除の差分が想定どおり |
| 4 | `--apply --by` で反映 | `user_roles` の件数、監査 `auth.role.sync` 1 行 |
| 5 | 実測（検証環境） | `auditor` の書込み 403 / `approver` の承認 200 / `helpdesk` の受信箱 200 |
| 6 | UI のロール出し分け（未実装） | docs/49 §3 の残課題。API は判定済み |

## 6. ロールバック

- `roles.json` を前の内容に戻して `sync-roles.ts --apply` を再実行（監査は追記のみ）。
- 緊急時は対象行を `DELETE FROM user_roles WHERE source='access-group'` で戻し、
  主ロール（`users.role`）へフォールバックさせる。

## 7. リスクと対策

| リスク | 対策 |
|---|---|
| グループ未作成のまま `--apply` して全員のロールを消す | dry-run の差分確認を必須にする。`roles.json` は「あるべき姿」を完全に書く |
| 別名（`EMAIL_ALIASES`）で同一人物に 2 ロールが付く | 同期前に正規化後のメールで重複を検査する（`auditor` 併存は自動で拒否） |
| `itops` に固有の制限が無いまま権限を付ける | 現状は `helpdesk` と同じ。端末系の認可は第2段として別途設計（docs/43 §2-2） |
| 監査ロールの書込み | `authenticate` が 403 で拒否（[docs/47 §2](47-role-separation-phase-a-b-20261027.md)） |

## 8. この稿で扱わないこと

- グループの作成・メンバー割当（Cloudflare 側の人間作業）。
- `roles.json` の適用（承認者2人目の確定後。[docs/54 §4](54-phase-c-approver-candidates.md)）。
- UI のロール出し分け実装（docs/49 §3 の残課題）。
