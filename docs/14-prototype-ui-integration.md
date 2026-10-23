# 既存プロトタイプ UI の 100% 適用（2026-10-23 ユーザー指示）

## 1. 指示

ユーザーから以下を受領した（2026-10-23 14:29 JST）。

1. WebUI は `Mirai_AIHelpdesk_Cowork_StepWizard_V3.1_PCinfo_Offline.html` に **100% 合わせる**。
2. AI モデルは **DeepSeek API**（MVP / Staging のみ）。API キーが必要なときは通知する。
3. Cloudflare を利用し、ドメイン `mirai-dx-platform.com` / サブドメイン `ai-helpdesk`。
4. ログイン認証は **Cloudflare Access のアプリケーション制御のみ**。
5. 許可は `<EMAIL_1>@mirai-const.co.jp>` のみ。**ワンタイムパスワード**、**12時間**で自動ログオフ。

この指示は、以前の OpenDesign 設計ボード（8画面の再設計）より優先する。
`design/opendesign/` の成果物は設計検討の記録として残し、**実画面の正本は既存 HTML** とする。

## 2. 実装方針

### 2-1. UI は既存 HTML をそのまま配信

- 画面の DOM / CSS / 画面遷移 / 28 業務ツールは **元の HTML を変更せず**配信する。
- サーバー側で以下の**非表示の追加**だけを行う。
  - CSP の `connect-src 'none'` → `'self'`（同一オリジンの API 用）
  - localStorage を初期化する boot script（DB の状態を注入）
  - 状態同期と DeepSeek 連携の bridge script
- 表示レイアウトは変えない。以下の**事実と異なる主要ラベルだけ**を更新する（ユーザー指示の「100%」は画面構成・UI/UX を指すと解釈）。
  - ヘッダー「完全オフライン」→「Cloudflare Access」
  - サイドフッター「外部通信なし／ブラウザ内のみ」→「認証済みのみ／PostgreSQL に保存」
  - 設定画面「localStorage にのみ保存」→「PostgreSQL に保存、AI回答は DeepSeek API」
  - 統合版の説明「完全オフライン／すべて模擬」→「検証環境／自由記述は DeepSeek API」
  - AI モデル名「社内ローカルLLM（模擬）」等 →「DeepSeek API（MVP）」
- 変更点は `apps/api/src/routes/prototype.ts` の文字列置換と `apps/api/src/prototype/bridge.js` に限定。

### 2-2. 認証は Cloudflare Access のみ

- 公開 URL: **https://ai-helpdesk.mirai-dx-platform.com**
- Cloudflare Access アプリ:
  - 名前: `Mirai AI HelpDesk MVP` / ID `44de6fdd-d2c3-4c2b-8e8b-3be092dc1eae`
  - ドメイン: `ai-helpdesk.mirai-dx-platform.com`
  - セッション: **12h**
  - IdP: One-time PIN のみ（`bb570f49-b0c4-4ffb-a460-0d48686f2b62`）
  - 自動リダイレクト: 有効
  - ポリシー: **未作成（deny-all）**。許可メールの確定後に「そのメールだけ allow」を追加する。
- アプリ内のパスワードログインは **本番モードでは登録しない**（`AUTH_MODE=cloudflare-access` のとき `/api/auth/login` は 404）。
- サーバーは Cloudflare Access が付与する `Cf-Access-Authenticated-User-Email` を検証する。
  - `ACCESS_ALLOWED_EMAIL` が設定されていれば完全一致のみ許可。
  - ヘッダーがないリクエストは 401。
- ローカル開発・テストのみ `AUTH_MODE=local` と `DEV_AUTH_EMAIL` を使う。
- 12時間の自動ログオフは Access のセッション期限で実現する。アプリ独自のセッション Cookie は持たない。

### 2-3. DeepSeek API

- 対象: 自由記述の相談（プロトタイプの `H.kb` = 承認済みナレッジ検索の回答）。
- 安全装置（診断・修復の承認・セキュリティ初動・禁止操作）は、**元の決定ルールを維持**する。
  - DeepSeek に判断させない領域を変えないため。
- サーバー `POST /api/ai/answer`:
  - 入力の PII を伏せ字化
  - PostgreSQL の承認済みナレッジを検索
  - DeepSeek `deepseek-chat` に「承認済みナレッジだけを根拠、600字以内、推測しない」と指示
  - 返答と根拠 KB を UI に返す
- API キー未設定・DeepSeek 障害時は、承認済みナレッジのローカル回答にフォールバックする。
- キーは `~/.config/ai-helpdesk/api.conf`（0600）の `DEEPSEEK_API_KEY` に置く。リポジトリには置かない。
- **現在キー未設定**のため、UI には「DeepSeek API 未設定」の注記付きフォールバックが出る。

### 2-4. データ

- 既存プロトタイプの 2 つの状態（`mirai-wizard-v31-cowork` / `mirai-wizard-v31-helpdesk`）を、ユーザー（Access メール）単位で PostgreSQL に保存する。
- テーブル: `prototype_states (user_email, name, data jsonb, updated_at)`（migration 002）。
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
| DB | Local PostgreSQL `ai_helpdesk_preview` |
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
| 許可ヘッダー | `GET /` 200 |
| 不一致メール | 403 |
| 本番モードのログイン | `/api/auth/login` 404 |
| 公開 URL | 302 → `winter-lake-f4c9.cloudflareaccess.com` の OTP ログイン画面 |
| Access ログイン画面 | 「Log in to Mirai AI HelpDesk MVP」「Email」「Send login code」を確認 |
| UI の AI 呼び出し | `H.kb` → `/api/ai/answer` 200 → 承認済みナレッジのフォールバックを表示 |
| 自動テスト | 41 tests 成功（UI/Access/state/AI を含む） |

証跡: `docs/evidence/access-login.png` / `docs/evidence/preview-home-local-access-header.png`

## 5. 未完了・要ユーザー対応

| # | 項目 | 必要なもの |
|---|---|---|
| 1 | Access の許可メール | `<EMAIL_1>` の実際のローカル部（例: `taro`）。確定後に allow ポリシーを追加する |
| 2 | DeepSeek API キー | `~/.config/ai-helpdesk/api.conf` の `DEEPSEEK_API_KEY` に設定（チャットへ貼らない）。設定後に再起動・実回答を検証 |
| 3 | 12h / OTP の実ログイン | 許可メールの受信箱に届く OTP コード。ユーザーによるログイン確認が必要 |
| 4 | CI | `.github/workflows` は policy gate で拒否。人間による追加、または policy 例外 |
| 5 | DNS | ローカル DNS（192.168.245.11）が新ホストを NXDOMAIN キャッシュ中。1.1.1.1 では解決済み。TTL 経過後に再確認 |

## 6. 主要な設計判断

- **UI 100%**: 画面を再実装せず、元 HTML を配信する。これが最も忠実で、回帰も少ない。
- **Access only**: アプリのログインを本番モードで無効化し、Access の email ヘッダーだけを信頼する。
- **DeepSeek の範囲**: 自由記述の回答のみ。安全装置は決定ルールを維持する。
- **Tunnel**: policy gate を迂回せず、Cloudflare の正規経路（Tunnel + Access）で Preview を公開する。
- **状態**: プロトタイプの JSON 状態を PostgreSQL に保存する。関係モデルは API / 将来の正規化用に維持する。
