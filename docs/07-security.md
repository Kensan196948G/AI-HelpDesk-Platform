# Security / Privacy（MVP）

## 1.  Secrets の扱い

| Secret | 置き場所 | リポジトリ |
|---|---|---|
| `DATABASE_URL` | `.env.local`（0600） / systemd `Environment=` | なし（`.env.example` はプレースホルダ） |
| `SESSION_SECRET` | 同上 | なし |
| `PROXY_SECRET` | 同上 + Cloudflare Worker Secret | なし |
| `SEED_PASSWORD` | `.env.local` のみ | なし |
| Cloudflare / GitHub の資格情報 | CLI の既存ストア | なし |

- `.gitignore` で `.env` / `.env.*`（`.env.example` を除く）/ `.dev.vars` / `.wrangler` を除外。
- `scripts/scan-secrets.sh` で代表的なトークン・秘密鍵パターンを検査。ローカルで検出 0。
- ログは Fastify の構造化ログ。Cookie / Authorization / X-Proxy-Secret を redact。本文は出さない。

## 2. 認証

- メール＋パスワード（scrypt, N=16384, r=8, p=1, 64 bytes）。
- セッショントークンは 32 bytes ランダム。DB には `SHA-256(SESSION_SECRET + token)` のみ保存。
- Cookie `aihd_session`: `HttpOnly` / `SameSite=Lax` / `Path=/` / 8 時間。Preview では `Secure`。
- ログイン試行は IP + email 単位で 10 回 / 15 分。
- 未登録ユーザーでもダミーハッシュを検証し、応答時間差を抑える。
- ログアウトでセッション削除。期限切れはログイン時に掃除。

## 3. 認可

| 操作 | 相談者 | ヘルプデスク | 承認者 |
|---|:--:|:--:|:--:|
| 自分の相談の作成・閲覧 | ○ | ○ | ○ |
| 他人の相談の閲覧 | ×（404） | ○ | ○ |
| PC 基本情報 | 本人 | 共有時のみ | 共有時のみ |
| 引継ぎ同意 | 本人 | × | × |
| 担当割当・解決記録 | × | ○ | × |
| ナレッジ下書き・申請 | × | ○ | × |
| ナレッジ承認 | × | ×（403） | ○（自分の申請は不可） |
| 監査ログ | × | × | ○ |

- 認可は API の `requireRole` と所有者チェックで実施。
- 他人の案件は 403 ではなく **404** を返し、存在を漏らさない。
- 承認者は申請者と同一人物になれない（400）。

## 4. 個人情報・機密

- 相談本文・件名・解決記録・ナレッジ下書きは保存前に伏せ字化。
  - パスワードらしき文字列、メール、電話、IP、カード番号、資産番号。
- PC 基本情報はデモ 31 項目。実端末・ファイル内容・閲覧履歴・キー入力・メール本文は取得しない。
- 外部 AI には接続しない（ルールベース）。外部送信そのものが発生しない。
- 相談本文は命令ではなくデータとして扱う。AI はルールベースで、本文中の命令を実行しない。
- 監査ログには本文・PII を入れず、操作・対象・件数などのメタ情報だけを入れる。

## 5. 通信・ヘッダ

- API: `Cache-Control: no-store` / `X-Content-Type-Options: nosniff` / `X-Frame-Options: DENY` / `Referrer-Policy: no-referrer`。
- Preview: Worker が CSP / 同等ヘッダを付与し、`/api/*` を共有秘密付きで API へプロキシする。
- `Origin` を許可リストと照合（POST/PATCH）。SameSite=Lax と併用。
- Local PostgreSQL はインターネットへ公開しない。API のみ Tunnel で公開。
- API は Worker 以外からの直接アクセスを `X-Proxy-Secret` で拒否（`REQUIRE_PROXY_SECRET=true`）。

## 6. 監査

- 追記のみ。`prev_hash` + SHA-256(canonical JSON) のチェーン。
- `pg_advisory_xact_lock` で同時実行時の分岐を防止。
- 承認者だけが `/api/audit/verify` で検証可能。
- 記録対象: ログイン/ログアウト、案件作成、AI 評価、引継ぎ、担当変更、解決、ナレッジ下書き/申請/承認/差戻し。

## 7. 残存リスク（MVP として受容）

| Risk | 内容 | 対策 / 次段階 |
|---|---|---|
| デモパスワード | Seed ユーザーは共通のデモパスワード | Preview のみ。本番は SSO（Entra ID）へ |
| Cloudflare Access 未使用 | アプリ認証のみ | 本番は Access + WAF + Turnstile を検討 |
| ルールベース AI | 回答品質・網羅性に限界 | AI Provider 抽象化済み。外部 AI 接続は Backlog |
| PC 情報がデモ | 実端末の状態を反映しない | 実 PC エージェントは別プロジェクト |
| DB 接続ロール | Local PG の既存スーパーユーザーを使用 | 本番は専用ロール・最小権限へ |
| CSRF トークンなし | SameSite=Lax + Origin 検証で代替 | 本番は CSRF トークンも検討 |
| 添付なし | マルウェア検査・区分判定が未実装 | 対象外。必要時に設計 |
| 監査ログの保全 | ローカル DB。SIEM 連携なし | 本番は追記専用ストレージ / SIEM |
| Preview 未配備 | policy gate により deploy 不可 | [docs/08-deployment.md](08-deployment.md) の Blocker 参照 |

## 7-1. Cloudflare Access 運用（2026-10-23 更新）

- 本番/Preview の認証は **Cloudflare Access のみ**。アプリ内ログインは `AUTH_MODE=cloudflare-access` で無効（`/api/auth/login` 404）。
- Access アプリ: `Mirai AI HelpDesk MVP` / `ai-helpdesk.mirai-dx-platform.com` / session 12h / One-time PIN。
- Access の allow ポリシー（2026-10-23 適用）: `kensan1969@gmail.com`（完全一致）と `@mirai-const.co.jp`（メールドメイン）。
- **許可リストの正本は `docs/MailAddress.txt`**。Node API は `ACCESS_ALLOWLIST_FILE`（既定 `docs/MailAddress.txt`）を読み、完全一致メールと `@domain` を照合する。
  - ヘッダーなし 401、許可外 403。
  - ファイルなし・空・読めない場合は **全拒否（fail-closed）** とし、ログにエラーを出す。
  - `ACCESS_ALLOWED_EMAIL` は非推奨。後方互換のため受理するが、判定には使わない。
  - `例：` / `e.g.` 以降の例示と `#` 以降のコメントは無視する。`k-aritoh@mirai-ocnst.co.jp` は例示の typo のため許可しない。
  - サブドメインは許可しない（`taro@sub.mirai-const.co.jp` は 403）。
- Access ポリシーとアプリの許可リストは**同じ内容に保つ**（二重チェック）。変更時は両方を更新し、API は再起動する（mtime 監視で自動反映もする）。
- Origin は 127.0.0.1 のみ。Tunnel 経由でのみ公開し、DB は公開しない。
- 残存リスク: Access ヘッダーの信頼（JWT 検証は未実装）、ローカル origin への直接アクセス、DNS キャッシュ。
- 12h の自動ログオフは Access のセッション期限に依存する。

## 7-2. DeepSeek API

- 自由記述の回答のみ。PII を伏せ字化し、承認済みナレッジを根拠として送信する。
- 診断・修復・セキュリティ初動・禁止操作は DeepSeek に判断させず、元の決定ルールを維持。
- API キーは `~/.config/ai-helpdesk/api.conf`（0600）。リポジトリ・ログへ書かない。
- キー未設定・障害時は承認済みナレッジのフォールバック。UI に「DeepSeek API 未設定」を表示。
- 残存リスク: DeepSeek への送信内容（伏せ字済み・承認済みナレッジ）、外部 API の可用性・費用。

## 8. 禁止・対象外

- パスワード確認・再設定、権限付与、セキュリティ判断、端末の隔離・削除は AI が行わない。
- 通報・ハラスメント相談の本文保存は対象外（専用窓口へ）。
- 本番データ・実個人情報を Seed / テストへ入れない。
- Production 環境・課金・契約・認証方式の重大変更は行わない。
