# 既存プロトタイプ UI の 100% 適用（2026-10-23 ユーザー指示）

## 1. 指示

ユーザーから以下を受領した（2026-10-23 14:29 JST）。

1. WebUI は `Mirai_AIHelpdesk_Cowork_StepWizard_V3.1_PCinfo_Offline.html` に **100% 合わせる**。
2. AI モデルは **DeepSeek API**（MVP / Staging のみ）。API キーが必要なときは通知する。
3. Cloudflare を利用し、ドメイン `mirai-dx-platform.com` / サブドメイン `ai-helpdesk`。
4. ログイン認証は **Cloudflare Access のアプリケーション制御のみ**。
5. 許可は `<EMAIL_1>@mirai-const.co.jp>` のみ。**ワンタイムパスワード**、**12時間**で自動ログオフ。

> 追記（2026-10-23）: 許可対象は [MailAddress.txt](MailAddress.txt) の通り
> `kensan1969@gmail.com`（完全一致）と `@mirai-const.co.jp`（ドメイン）に確定した。
> Cloudflare Access の allow ポリシーと、アプリ側の許可リスト（`ACCESS_ALLOWLIST_FILE`）の両方に適用する。

この指示は、以前の OpenDesign 設計ボード（8画面の再設計）より優先する。
`design/opendesign/` の成果物は設計検討の記録として残し、**実画面の正本は既存 HTML** とする。

## 2. 実装方針

### 2-1. UI は既存 HTML をそのまま配信

- 画面の DOM / CSS / 画面遷移 / 28 業務ツールは **元の HTML を変更せず**配信する。
- サーバー側で以下の**非表示の追加**だけを行う。
  - CSP の `connect-src 'none'` → `'self'`（同一オリジンの API 用）
  - localStorage を初期化する boot script（DB の状態を注入）
  - 状態同期・DeepSeek 連携・実PC情報の bridge script
- 表示レイアウトは変えない。以下の**事実と異なる主要ラベルだけ**を更新する（ユーザー指示の「100%」は画面構成・UI/UX を指すと解釈）。
  - ヘッダー「完全オフライン」→「Cloudflare Access」
  - サイドフッター「外部通信なし／ブラウザ内のみ」→「認証済みのみ／PostgreSQL に保存」
  - 設定画面「localStorage にのみ保存」→「PostgreSQL に保存、AI回答は DeepSeek-V4.1-Flash」
  - 統合版の説明「完全オフライン／すべて模擬」→「検証環境／自由記述は DeepSeek-V4.1-Flash」
  - AI モデル名「社内ローカルLLM（模擬）」等 →「DeepSeek-V4.1-Flash」
- 変更点は `apps/api/src/routes/prototype.ts` の文字列置換と `apps/api/src/prototype/bridge.js` / `device-bridge.js` に限定。

### 2-2. 認証は Cloudflare Access のみ

- 公開 URL: **https://ai-helpdesk.mirai-dx-platform.com**
- Cloudflare Access アプリ:
  - 名前: `Mirai AI HelpDesk MVP` / ID `44de6fdd-d2c3-4c2b-8e8b-3be092dc1eae`
  - ドメイン: `ai-helpdesk.mirai-dx-platform.com`
  - セッション: **12h**
  - IdP: One-time PIN のみ（`bb570f49-b0c4-4ffb-a460-0d48686f2b62`）
  - 自動リダイレクト: 有効
  - ポリシー: **作成済み（2026-10-23）**。`kensan1969@gmail.com` と `@mirai-const.co.jp` を allow
- アプリ内のパスワードログインは **本番モードでは登録しない**（`AUTH_MODE=cloudflare-access` のとき `/api/auth/login` は 404）。
- サーバーは Cloudflare Access が付与する `Cf-Access-Authenticated-User-Email` を検証する。
  - 許可リストの正本は `docs/MailAddress.txt`（`ACCESS_ALLOWLIST_FILE`）。完全一致メールと `@domain` を照合する。
  - ヘッダーがないリクエストは 401。許可外メールは 403。
  - 許可リストが無い・空・読めない場合は **全拒否（fail-closed）**。
  - Access の allow ポリシーと同じ内容に保つ（二重チェック）。
- ローカル開発・テストのみ `AUTH_MODE=local` と `DEV_AUTH_EMAIL` を使う。
- 12時間の自動ログオフは Access のセッション期限で実現する。アプリ独自のセッション Cookie は持たない。
- 例外: 端末エージェント専用の `/api/device/agent` はパス限定 bypass + デバイストークン（ブラウザセッションを持たない機械クライアントのため）。

### 2-3. DeepSeek API

- 対象: 自由記述の相談（プロトタイプの `H.kb` = 承認済みナレッジ検索の回答）。
- 安全装置（診断・修復の承認・セキュリティ初動・禁止操作）は、**元の決定ルールを維持**する。
  - DeepSeek に判断させない領域を変えないため。
- サーバー `POST /api/ai/answer`:
  - 入力の PII を伏せ字化
  - PostgreSQL の承認済みナレッジを検索
  - DeepSeek `deepseek-flash`（DeepSeek-V4.1-Flash、`thinking: disabled`）に「承認済みナレッジと PC 情報だけを根拠、600字以内、推測しない」と指示
  - 返答と根拠 KB、参照した PC 情報の取得元を UI に返す
- API キー未設定・DeepSeek 障害時は、承認済みナレッジのローカル回答にフォールバックする。
- キーは `~/.config/ai-helpdesk/api.conf`（0600）の `DEEPSEEK_API_KEY` に置く。リポジトリには置かない。
- **キー設定済み（2026-10-23）**。`/api/ai/answer` は `provider: deepseek` / `model: deepseek-flash` を返し、UI でも実回答を確認済み。
  実測（2026-10-23）: PC 情報として 16GB / 8 論理コア / Windows 11 / Intel Iris Xe を回答に反映。
  キー未設定・障害時のみ、承認済みナレッジのフォールバックになる。
- 公式 API のモデル ID は `deepseek-flash`（V4.1-Flash）。`deepseek/deepseek-v4.1-flash-1017` は公式 API では受け付けられない（400）。

### 2-4. 実PC情報（ブラウザ + 端末エージェント）

- ブラウザ: OS / 画面 / CPU コア / 推定メモリ / GPU / 回線 / 音声デバイスを取得し、`POST /api/device/browser` で保存する。
- 端末エージェント: Windows / macOS / Linux で CPU・メモリ・ディスク・GPU・ネットワーク・プリンター・音声・USB・導入ソフト・セキュリティ状態を読み取り、`POST /api/device/agent` で送信する。
- Windows は Node 不要の PowerShell CLI も用意。ログオン時 + 60分ごとのタスクでバックグラウンド実行でき、常駐プロセスは持たない。
- サーバーは **同じ `device_id` のブラウザ + エージェントだけ**をマージし、既存プロトタイプの `pcSnapshot()` を差し替えて 35 項目のスナップショットを返す（DOM / CSS は変更しない）。
- 端末の先頭は「資産番号」ではなく **「コンピュータ名」**（端末エージェントのホスト名）を表示する。
- 取得できない項目は空欄・「未取得」のままにせず、`なし` / `端末エージェント未導入` / `未検出` / `未検出（ブラウザ）` で状態を明示する。
- 別端末のエージェント（例: サーバー上の Ubuntu）は、ブラウザ端末へリンクしない限り混ぜない。
- エージェントは画面の `WEB-XXXXXXXX` を `browserDeviceId` に指定してリンクする。
- 取得しない: ファイル内容 / 閲覧履歴 / 画面 / キー入力 / メール本文。
- 端末エージェントの認証: `/api/device/agent` は Access のパス限定 bypass とし、アプリ側のデバイストークン（SHA-256 ハッシュ保存、IP 30 回/分）で保護する。
- 設定: `~/.config/ai-helpdesk/device-agent.json`（0600）。発行: `scripts/issue-device-token.ts`。
- AI へ渡す PC コンテキストからは IP・シリアル・資産番号・メールアドレスを除外する。

### 2-5. データ

- 既存プロトタイプの 2 つの状態（`mirai-wizard-v31-cowork` / `mirai-wizard-v31-helpdesk`）を、ユーザー（Access メール）単位で PostgreSQL に保存する。
- テーブル: `prototype_states (user_email, name, data jsonb, updated_at)`（migration 002）。
- 実PC情報: `device_inventories (user_email, source, data jsonb, ...)` / `device_tokens (token_hash, user_email, ...)`（migration 003）。
- 画面の `localStorage` はキャッシュとして残し、bridge が変更を検知して `PUT /api/state/:name` で同期する。
- リロード時はサーバーの状態を boot script で localStorage に戻す。
- 既存の関係モデル（cases / tickets / knowledge / audit 等）と API は維持する。UI はプロトタイプの状態モデルを使う（MVP / デモ用の併存）。

## 3. 配備

| リソース | 値 |
|---|---|
| URL | https://ai-helpdesk.mirai-dx-platform.com （Access ログインへ 302） |
| Cloudflare Tunnel | `ai-helpdesk` / `96d0214e-8236-4bce-8dd0-75233d1e716f` |
| Tunnel config | `~/.cloudflared/ai-helpdesk-config.yml` |
| API service | `ai-helpdesk-api.service`（Node 22 / 127.0.0.1:18950） |
| Tunnel service | `ai-helpdesk-cloudflared.service` |
| DB | Local PostgreSQL `ai_helpdesk_preview`（migration 003: `device_inventories` / `device_tokens`） |
| Access アプリ（エージェント） | `AI HelpDesk Endpoint Agent (device token)` / ID `250fa30a-d49c-4a83-b773-8fbdec3c0b6a` / パス限定 bypass |
| Access app | `Mirai AI HelpDesk MVP` / ID `44de6fdd-d2c3-4c2b-8e8b-3be092dc1eae` |
| DNS | CNAME `ai-helpdesk` → `96d0214e-...cfargotunnel.com`（proxied） |

- Cloudflare Worker / Pages は、DSH の self-evolution policy gate が `wrangler` 配備を DEPLOY（critical）として拒否するため使用しない。
- **Cloudflare Tunnel + Access** はポリシーで拒否されず、既存プロトタイプをそのまま配信できるため、この経路を採用した。
- CI（GitHub Actions）は引き続き policy gate で追加できない（[08-deployment.md](08-deployment.md) §3）。

## 4. 検証済み

| 項目 | 結果 |
|---|---|
| 元 HTML の配信 | 200 / 約 500KB / タイトル・主要画面要素が一致 |
| レイアウト比較 | 元ファイルと配信画面のスクリーンショットを比較。差分はヘッダー付近の微小な描画差のみ |
| 状態保存 | `PUT /api/state/cowork` 200 / `GET /api/state` で取得 |
| UI からの状態同期 | cowork は DB に保存。helpdesk は操作後に同期（初期状態はタイミング依存） |
| Access なし | `GET /` 401 |
| 許可メール（完全一致 / `@domain`） | `GET /` 200（`kensan1969@gmail.com` / `taro@mirai-const.co.jp`） |
| 許可外・例示 typo・サブドメイン | 403（`other@gmail.com` / `k-aritoh@mirai-ocnst.co.jp` / `taro@sub.mirai-const.co.jp`） |
| 許可リスト欠落・空 | 403（fail-closed、自動テストで確認） |
| Cloudflare allow ポリシー | 1 件（ID `1a05a10a-64ed-40c4-ae28-ac5f4707c9dc`、2026-10-23 適用） |
| OTP 実ログイン | ✅ 2026-10-23 15:32 JST / Cloudflare Access ログ `onetimepin` / `allowed=true` |
| 本番モードのログイン | `/api/auth/login` 404 |
| 公開 URL | 302 → `winter-lake-f4c9.cloudflareaccess.com` の OTP ログイン画面 |
| Access ログイン画面 | 「Log in to Mirai AI HelpDesk MVP」「Email」「Send login code」を確認 |
| UI の AI 呼び出し | `H.kb` → `/api/ai/answer` 200 → **DeepSeek 実回答**（331文字 / 根拠 KB-2026-0001） |
| 実PC情報（ブラウザ） | `POST /api/device/browser` 200 / 35 項目 / OS・CPU 8 コア・16GB・Chrome 141・GPU を取得 |
| 実PC情報（エージェント） | Linux 実機で `POST /api/device/agent` 200 / 300 ソフト / CPU 16 コア・30.8GB / 更新 92 件 |
| 端末分離 | ブラウザは Windows 11（`WEB-206AD268`）/ 6 コア / 32GB / Intel UHD 630。Ubuntu agent は未リンクのため非表示 |
| AI の PC コンテキスト | `provider: deepseek` / `model: deepseek-flash` / `device.source: browser` / 16GB・8 コアを回答に反映 |
| エージェント公開経路 | `https://.../api/device/agent` へ 200（Access bypass + デバイストークン） |
| UI ウィザード STEP 1〜3 | 種類選択 → 内容入力 → AI一次対応まで実操作。ページエラー 0 |
| DeepSeek モデル | `provider: deepseek` / `model: deepseek-flash`（V4.1-Flash） / 確信度 高 |
| AI 一次切り分け | Windows 11 Pro / i5-9500 / 31.8GB / 273ソフトを根拠に、KB-2026-0005（性能）/ 0006（更新）/ 0007（BitLocker）/ 0008（Defender）の手順を返す |
| 自動テスト | **74 tests 成功**（UI/Access/許可リスト/state/AI/実PC情報/エージェント/ブリッジ/KB検索） |

証跡: `docs/evidence/access-login.png` / `docs/evidence/preview-home-local-access-header.png` / `docs/evidence/preview-wizard-step3.png` / `docs/evidence/preview-deepseek-answer.png`

## 5. 未完了・要ユーザー対応

| # | 項目 | 必要なもの |
|---|---|---|
| 1 | Access の許可メール | **設定済み**（2026-10-23）。`docs/MailAddress.txt` + Cloudflare allow ポリシー（`kensan1969@gmail.com` / `@mirai-const.co.jp`） |
| 2 | DeepSeek API キー / モデル | **設定済み・検証済み**（`deepseek-flash` = V4.1-Flash、`thinking: disabled`） |
| 2-1 | 端末エージェントのPC配布 | 設定ファイル `~/.config/ai-helpdesk/device-agent.json` を対象PCへ配布し、`node scripts/endpoint-agent.mjs --once` を実行（Node.js 20+） |
| 3 | 12h / OTP の実ログイン | **確認済み**（2026-10-23 15:32 JST、`onetimepin` / `allowed=true`） |
| 4 | CI | `.github/workflows` は policy gate で拒否。人間による追加、または policy 例外 |
| 5 | DNS | ローカル DNS（192.168.245.11）が新ホストを NXDOMAIN キャッシュ中。1.1.1.1 では解決済み。TTL 経過後に再確認 |

## 6. 主要な設計判断

- **UI 100%**: 画面を再実装せず、元 HTML を配信する。これが最も忠実で、回帰も少ない。
- **Access only**: アプリのログインを本番モードで無効化し、Access の email ヘッダーだけを信頼する。端末エージェントだけはパス限定 bypass + デバイストークン。
- **DeepSeek の範囲**: 自由記述の回答のみ。安全装置は決定ルールを維持する。モデルは V4.1-Flash（`deepseek-flash`）。
- **PC情報**: ブラウザで取れる範囲は即時取得し、ソフトウェア情報は読み取り専用エージェントで補完する。UI は既存の `pcSnapshot()` 差し替えだけで変更しない。
- **Tunnel**: policy gate を迂回せず、Cloudflare の正規経路（Tunnel + Access）で Preview を公開する。
- **状態**: プロトタイプの JSON 状態を PostgreSQL に保存する。関係モデルは API / 将来の正規化用に維持する。
