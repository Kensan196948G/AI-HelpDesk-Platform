# 79. 公開リポジトリの PII 露出（2026-11-06 調査・一次是正）

## 0. 結論

**公開リポジトリ `Kensan196948G/AI-HelpDesk-Platform`（visibility=PUBLIC）に、実在形式のメールアドレスが含まれている。** 本記録はその範囲を測り、HEAD から除去できるものを除去し、履歴の扱いを人間判断に上げるためのものである。

- Critical/High のセキュリティ欠陥（認証・権限・秘密）は別監査で 0 件。本件は**プライバシー/情報露出**の所見。
- 実行時の認証は fail-closed で、リポジトリ内のファイルは本番の許可リストとして使われていない（本番は `ACCESS_ALLOWLIST_FILE` で `~/.config` 側を指す）。
- ただし **Git 履歴は公開されており、HEAD から消しても過去 commit から取得できる**。完全な是正には履歴書換（force push）が必要で、これは不可逆・要承認。

## 1. 実測（read-only）

| 指標 | 値 | 方法 |
|---|---|---|
| リポジトリ公開範囲 | PUBLIC | `gh repo view --json visibility` |
| `docs/MailAddress.txt` の実アドレス | 個人アドレス 1 件（有効な許可エントリ） + 例示 1 件（パーサは `例：` 以降を無視） + ドメイン規則 1 件 | ファイル読取 |
| `mirai-const.co.jp` を含む追跡ファイル | **47 ファイル / 103 箇所** | `git grep -l` / `git grep -o` |
| `kensan1969` を含むファイル | 45 ファイル（管理者自身の識別子。個人特定性は低いが PII） | `grep -rl`（`.git`/`node_modules` 除外） |
| mirai-const/gmail の一意アドレス | 21 件（マスク集計） | `git grep -o` + 正規化 |

主な所在: `docs/MailAddress.txt`、`docs/07`〜`docs/75` の運用記録、`.env.example`（`SHARED_IDENTITY_GROUPS` の例）、テストの一部。

## 2. 今回の一次是正（HEAD）

| 対象 | 変更 |
|---|---|
| `docs/MailAddress.txt` | 個人アドレスを `admin@example.com` に置換。ファイルが**見本**であることと、実運用の正本は `ACCESS_ALLOWLIST_FILE`（リポジトリ外）であることを明記。ドメイン規則は方針として維持。 |
| `.env.example` | `SHARED_IDENTITY_GROUPS` の実アドレス例を `example.com` に置換。 |

これにより、**新規に clone した人が HEAD から得られる個人アドレス**は、当該ファイルと `.env.example` からは消える。ただし docs の記録には残る（§3）。

## 3. 未了（要承認）

1. **Git 履歴の書換**（`git filter-repo` 等 + force push）。全 clone・PR 参照・CI 履歴に影響する不可逆操作。**未実施**。
2. docs 内の 47 ファイル / 103 箇所の一括置換。証跡記録の改変でもあるため、方針決定後に一括実施するか、履歴書換と同時に行うかを決める必要がある。
3. GitHub 側のキャッシュ（fork・PR のスナップショット・検索インデックス）は履歴書換後も残り得る。GitHub Support への削除依頼が必要になる場合がある。
4. 漏洩した可能性のあるアドレスへの通知・パスワード再利用の確認（運用判断）。

## 4. 影響評価

- 露出しているのは**メールアドレスと社内ドメイン**が中心で、パスワード・トークン・秘密鍵は検出されていない（`scripts/scan-secrets.sh` exit 0、`npm audit` 0 件）。
- 実害は「標的型メール・なりすましの手がかり」程度だが、公開期間が長いため、履歴書換の要否は人間判断とする。
- 本番の認証強度（Access + アプリ側 fail-closed + JWT enforce）は本件と独立に維持されている。

## 5. 再発防止

- `scripts/scan-secrets.sh` にメールアドレス検出を追加するか、CI で `git grep` による実ドメイン検査を追加する（未実装）。
- 設計・運用記録には実アドレスを書かず、`example.com` と役割名で書く（docs/61 の方針を徹底）。
- 許可リストの正本は常にリポジトリ外（`~/.config/...`）に置く。
