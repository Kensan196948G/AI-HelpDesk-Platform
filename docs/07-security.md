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
- PC 基本情報は、ログイン中のブラウザと読み取り専用の端末エージェントから取得する（35 項目）。
  - 取得する: OS / CPU / メモリ / ディスク / GPU / ネットワーク / 画面 / 音声 / プリンター / USB / 導入ソフト / セキュリティ状態。
  - 取得しない: ファイル内容 / 閲覧履歴 / 画面 / キー入力 / メール本文 / 個人フォルダ一覧。
  - 保存先は `device_inventories`（ユーザー + 端末単位）。ブラウザ端末と同一 `device_id` にリンクされたエージェントだけをマージし、別端末のエージェントは表示しない。
  - 端末エージェントのトークンは SHA-256 ハッシュのみを `device_tokens` に保存する。
  - AI へ渡す PC コンテキストからは IP・シリアル・資産番号・メールアドレスを除外する。
- 相談本文は命令ではなくデータとして扱う。AI は本文・PC 情報中の命令を実行しない。
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
| 端末エージェントの配布 | 手動配布・Node.js 必須・1ユーザー1端末 | Windows インストーラ / 署名 / 自動更新を次段階で整備 |
| エージェント用 Access bypass | `/api/device/agent` は Access をバイパスし、デバイストークンで認証 | レート制限 + トークン失効。将来は Access サービスドメインへ移行 |
| AI の幻覚 | DeepSeek は誤った一般論を生成しうる | 承認済みナレッジ + PC 情報に限定し、根拠 KB を表示。設定変更は AI に実行させない |
| PC ソフト情報の機密性 | 導入ソフト名に業務システムが含まれうる | 本人と共有された担当者のみ閲覧。AI へは関連ソフトのみ送信 |
| DB 接続ロール | Local PG の既存スーパーユーザーを使用 | 本番は専用ロール・最小権限へ |
| CSRF トークンなし | SameSite=Lax + Origin 検証で代替 | 本番は CSRF トークンも検討 |
| 添付なし | マルウェア検査・区分判定が未実装 | 対象外。必要時に設計 |
| 監査ログの保全 | ローカル DB。SIEM 連携なし | 本番は追記専用ストレージ / SIEM |
| Preview の CI | policy gate により workflow 追加不可 | 人間による追加、または policy 例外 |

## 7-1. Cloudflare Access 運用（2026-10-23 更新）

- 本番/Preview の認証は **Cloudflare Access のみ**。アプリ内ログインは `AUTH_MODE=cloudflare-access` で無効（`/api/auth/login` 404）。
- Access アプリ: `Mirai AI HelpDesk MVP` / `ai-helpdesk.mirai-dx-platform.com` / session 12h / One-time PIN。
- Access の allow ポリシー（2026-10-23 適用）: `kensan1969@gmail.com`（完全一致）と `@mirai-const.co.jp`（メールドメイン）。
- OTP 実ログインを 2026-10-23 15:32 JST に確認（Cloudflare Access ログ: `Mirai AI HelpDesk MVP` / `onetimepin` / `allowed=true`）。
- **許可リストの正本は `docs/MailAddress.txt`**。Node API は `ACCESS_ALLOWLIST_FILE`（既定 `docs/MailAddress.txt`）を読み、完全一致メールと `@domain` を照合する。
  - ヘッダーなし 401、許可外 403。
  - ファイルなし・空・読めない場合は **全拒否（fail-closed）** とし、ログにエラーを出す。
  - `ACCESS_ALLOWED_EMAIL` は非推奨。後方互換のため受理するが、判定には使わない。
  - `例：` / `e.g.` 以降の例示と `#` 以降のコメントは無視する。`k-aritoh@mirai-ocnst.co.jp` は例示の typo のため許可しない。
  - サブドメインは許可しない（`taro@sub.mirai-const.co.jp` は 403）。
- Access ポリシーとアプリの許可リストは**同じ内容に保つ**（二重チェック）。変更時は両方を更新し、API は再起動する（mtime 監視で自動反映もする）。
- Origin は 127.0.0.1 のみ。Tunnel 経由でのみ公開し、DB は公開しない。
- 端末エージェント用に `/api/device/agent` だけの Access アプリを作成し、**bypass + アプリ側デバイストークン**で保護する（アプリ ID `250fa30a-d49c-4a83-b773-8fbdec3c0b6a` / ポリシー `490f1c8f-4700-46e6-b928-b990c6a98cf6`）。人間の UI / API は従来どおり Access 必須。
  - デバイストークンは 32 bytes ランダム。DB には SHA-256 ハッシュのみ。`scripts/issue-device-token.ts` で発行し、0600 の設定ファイルに保存する。
  - エージェント API は IP 単位 30 回/分に制限。不正トークンは 401。
  - エージェントは画面の `WEB-XXXXXXXX` を `browserDeviceId` に指定して端末へリンクする。未リンクのエージェントは保存されるが、ブラウザのPC情報には混ぜない。
- **Access JWT 検証（2026-10-23 追加）**: `ACCESS_JWT_MODE=off|report|enforce`、`ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`。
  `Cf-Access-Jwt-Assertion` の RS256 署名（`https://<team>/cdn-cgi/access/certs`、1h キャッシュ・kid 不明時は再取得）、
  `aud`・`iss`・`exp`/`nbf`（±60 秒）と、JWT の email とヘッダー email の一致を確認する。
  同一ホスト上のプロセスや SSRF から 127.0.0.1 へ偽の email ヘッダーを送るなりすましを防ぐ。
  段階導入: `report`（失敗をログに出すだけ）で実ログインの成功ログ「Cloudflare Access JWT を検証しました。」を確認してから `enforce` にする。
- **本番で認証なしの起動を拒否**: `NODE_ENV=production` で `AUTH_MODE=local`（既定値を含む）なら起動しない。
- **接続元の扱い**: `trustProxy` はループバック（cloudflared）のみ。レート制限のキーは Tunnel 経由なら `CF-Connecting-IP`。
  利用者が送る `X-Forwarded-For` の左端は使わない。レート制限のバケットは上限 1 万件で期限切れを掃除する。
- **AI 回答のレート制限**: `/api/ai/answer` は利用者（Access メール）単位で 1 分 20 回（超過は 429）。外部 AI の費用を抑える。
- 残存リスク: `ACCESS_JWT_MODE=off` の間は Access ヘッダーの信頼、DNS キャッシュ、エージェント用 bypass パス。
- 12h の自動ログオフは Access のセッション期限に依存する。

## 7-2. DeepSeek API（DeepSeek-V4.1-Flash）

- モデル: `deepseek-flash`（DeepSeek-V4.1-Flash）。`DEEPSEEK_MODEL=deepseek-flash`、`DEEPSEEK_THINKING=disabled`（速度・安定性優先）。
- 自由記述の回答のみ。PII を伏せ字化し、承認済みナレッジと実 PC 情報を根拠として送信する。
- 伏せ字（`domain/pii.ts`）は全角数字・`＠`・`+81`・空白区切りの電話番号・IPv6・`PW:` / `pass=` / 「パスワード abc123」にも対応（2026-10-23）。
  「パスワード 変更方法を教えて」のような通常の相談文は伏せない。
- 診断・修復・セキュリティ初動・禁止操作は DeepSeek に判断させず、元の決定ルールを維持。
- API キーは `~/.config/ai-helpdesk/api.conf`（0600）。リポジトリ・ログへ書かない。
- キー未設定・障害時は承認済みナレッジのフォールバック。UI に「DeepSeek API 未設定」を表示。
- `deepseek/deepseek-v4.1-flash-1017` は公式 API では 400（受付 ID は `deepseek-flash` / `deepseek-v4-pro` のみ）。他プロバイダの ID を使う場合は `DEEPSEEK_BASE_URL` とキーを合わせる。
- 残存リスク: DeepSeek への送信内容（伏せ字済み・承認済みナレッジ・関連ソフト名）、外部 API の可用性・費用。

## 8. 禁止・対象外

- パスワード確認・再設定、権限付与、セキュリティ判断、端末の隔離・削除は AI が行わない。
- 通報・ハラスメント相談の本文保存は対象外（専用窓口へ）。
- 本番データ・実個人情報を Seed / テストへ入れない。
- Production 環境・課金・契約・認証方式の重大変更は行わない。

## 本人以外への「操作する人」切替の禁止（2026-10-23）

- 本番（`AUTH_MODE=cloudflare-access`）では、ヘッダーの「操作する人」を**ログイン本人以外に切り替えられない**（`switchMode=self`）。画面は `/api/me` で本人を解決し、**本人のロール違い（一般社員／ヘルプデスク担当／ナレッジ承認者／監査担当者／IT端末管理者）だけ**を選択肢にする。
- 開発・テスト（`AUTH_MODE=local`）は従来どおり自由に切り替えられる（デモ用）。
- 本番でデモを行うアカウントだけ `PERSONA_SWITCH_ALLOWLIST`（カンマ区切りメール）に列挙し、そのアカウントに限り `any` を許可する。
- 本人が名簿に無い場合は切替を無効化し「名簿未登録」と表示する（メール不備は別途修正）。
- 切替はすべて監査ログ（`persona_switch`）に残る。自動選択は `{auto:true}`。

## 同一人物の複数メール（別名の正規化・2026-10-23）

- Cloudflare Access では同じ人が複数のメール（例: Gmail と会社アドレス）でログインできる。
- `EMAIL_ALIASES`（`alias=primary` のカンマ区切り）に登録した別名は、**認証後に primary へ正規化**する。
  - 状態（`prototype_states`）・「操作する人」の切替可否・`/api/me` の名簿照合が 1 人分に揃う。
  - 画面のプロフィールには**ログインに使ったメール**（`loginEmail`）を表示し、内部の状態は primary を使う。
- 許可リスト（`PERSONA_SWITCH_ALLOWLIST`）は正規化後のメールで照合する（別名側に書いても同じ扱い）。
- 別名は秘密ではないが、設定ファイル（`~/.config/ai-helpdesk/api.conf`・0600）に置き、リポジトリには実値を書かない。
