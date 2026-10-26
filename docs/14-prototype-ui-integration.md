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

#### 2-1-1. 保存状態の欠落キー補完（2026-10-25 追加）

- 画面の `load()` は `v===31` の保存値をそのまま採用するため、一部キーだけを持つ状態を
  読み込むと `S.stats` / `S.faqCandidates` 参照画面が TypeError で白画面になる
  （2026-10-23 の検証用スクリプトが実在アカウントの状態を上書きした事例で発生）。
- `prototype.ts` の `patchStateLoad()` が `load()` の該当行に**欠落キーだけ**を補う処理を差し込む。
  既存の値は上書きしない。既定値に `freshState()` は使わず（サンプル案件・FAQ・監査ログを
  生成してしまうため）、キーごとの空の既定値と `seedDevices()`（端末）を使う。
- DOM / CSS / 画面遷移は変更しない。元 HTML の当該 1 行に文字列置換で追記するだけ。
- 状態を書き込む検証スクリプトは、`GET /api/state` が返す**正規化後メール**を正本にしてバックアップ・復元し、
  復元後の内容一致を検証すること。API と DB の一致確認、preview の既定拒否、復元のトランザクション化も行う
  （`scripts/e2e/two-account-handover.mjs`）。

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
  - PostgreSQL の承認済みナレッジ（`knowledge.status = approved`）と、**本人が画面で承認・公開したナレッジ**
    （`prototype_states` の helpdesk 状態 `kb[]` のうち `status = active`）を合わせて検索（2026-10-23 追加。Flow C の「公開ナレッジが次の AI 回答の根拠になる」を UI 上で成立させる）
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

### 2-5. ログイン情報と「相談する人」

- ログインは Cloudflare Access（メール）。氏名・所属はプロフィールとして保持し、ホームの挨拶と「相談する人」の両方で同じ値を使う。
- ヘッダーの「プロフィール」で氏名（入力）・所属（組織マスタ `DEPTS` から選択）を変更できる。ログイン（メール）は表示のみ。
- 相談する人は自由入力にしない。PC基本情報・端末・監査がログインユーザーに紐づくため、別人を入力できると情報が取り違わる。代理受付（電話・メール）の依頼者は自由入力のまま（当面）。
- ログインは Cloudflare Access（メール）のまま。EntraID への IdP 移行は行わず、氏名・所属はプロフィール（入力・組織マスタ選択）を正とする。

### 2-6. データ

- 既存プロトタイプの 2 つの状態（`mirai-wizard-v31-cowork` / `mirai-wizard-v31-helpdesk`）を、ユーザー（Access メール）単位で PostgreSQL に保存する。
- テーブル: `prototype_states (user_email, name, data jsonb, updated_at)`（migration 002）。
- 実PC情報: `device_inventories (user_email, source, data jsonb, ...)` / `device_tokens (token_hash, user_email, ...)`（migration 003）。
- 画面の `localStorage` はキャッシュとして残し、bridge が変更を検知して `PUT /api/state/:name` で同期する。
- リロード時はサーバーの状態を boot script で localStorage に戻す。
- 既存の関係モデル（cases / tickets / knowledge / audit 等）と API は維持する。UI はプロトタイプの状態モデルを使う（MVP / デモ用の併存）。

### 2-7. 最終報告書 / 遠隔支援（2026-10-23 追加・ユーザー指示）

ユーザーから、STEP 3（AIで解決）と STEP 5（担当者対応で解決）の双方で最終報告書を Standalone HTML / PDF で出力したい、STEP 5 の引継ぎで担当者（Bさん）が AI と一緒に対応できる UI がほしい、との指示を受けた。

- **試作 HTML は変更しない。** `apps/api/src/prototype/assist-bridge.js` を新規に追加し、既存のブリッジと同じく `</body>` 直前に注入する。
- 追加する画面要素は、ウィザードのペイン下部の 2 つのカードだけ。
  - 「📄 最終報告書」: 完了時のみ。Standalone HTML / PDF のボタン。
  - 「🛟 遠隔支援（同意した範囲）」: STEP 5 の引継ぎ後のみ。依頼・承認・拒否・終了、共有 PC 情報、AI 下書き、案内送信、実施結果。
  - A さんのホームに「遠隔支援の依頼が届いています」の通知。
- 画面のレイアウト・CSS・既存の DOM は変更しない。新しい CSS は `#ahd-assist-style` に閉じ込め、既存の `u-*` / `w-*` クラスを再利用する。
- 追加した API / DB は [21-final-report-export.md](21-final-report-export.md) / [22-remote-assist-handover.md](22-remote-assist-handover.md) を参照。
- この追加は「画面構成を変えない」という従来方針の例外ではなく、**ユーザー指示による新機能の追加**として扱う。既存の 28 業務ツール・STEP 1〜7 の流れは変えない。

### 2-8. 引継ぎワークスペース（3ペイン・2026-10-26 追加・ユーザー指示）

- ユーザー指示「新画面として追加（ポップアップでもOK）」により、ヘルプデスク担当者向けの
  3ペイン画面を**追加**した。既存画面の DOM / CSS / 画面遷移は変更しない。
- 実装は `apps/api/src/prototype/handover-workspace-bridge.js`。他のブリッジと同じく
  `</body>` 直前に注入する。左ナビ（`#uxRail`）の「引継ぎ」と、ヘルプデスク画面の
  右下起動ボタンから、既存の右側コンテンツ（`.ux-content`）内に表示する（別ウィンドウではない）。
  左ナビとヘッダーは残り、閉じる・別ナビへの移動で元の画面に戻る。
  中央ペインには既存の `/api/ai/answer-case` / `/api/ai/answer` を使う「AI に聞く」入力を追加し、
  AI窓口由来は共有情報、直接受付は承認済みナレッジを根拠にする。API は実際に渡した
  プロンプト（システム指示＋ユーザープロンプト）も返し、画面で表示・コピーできる。
  `.ux-content` が無い場合だけ全画面オーバーレイにフォールバックする。
  左ナビ項目は一般社員には表示しない。
- 左=引継ぎボード、中=引継ぎメモ・会話・タイムライン・次の一手、右=案件情報・共有情報・
  承認記録・監査。データは既存の localStorage 状態（helpdesk / cowork）を読み、
  デモデータは使わない。
- 担当開始・解決記録は既存の `App.startWork` / `App.resolve` を呼び、業務ロジックを
  二重実装しない。承認者・監査担当は閲覧のみ（権限分離）。
- 解決ループ（Skill / verify / 新しい承認ハッシュ）は未接続。既存の引継ぎフローの範囲を
  表示し、存在しないデータを偽って表示しない。
- 詳細・制約・検証・ロールバックは [33-handover-workspace.md](33-handover-workspace.md)。

### 2-9. RSP実行セッション（3ペイン右・2026-10-26 追加・ユーザー指示）

- ユーザー指示「AIが生成したPowerShellをコピーし担当者がRSPターミナルでペーストして実行する。
  解決されるまで続け、全コマンド・全出力を引継ぎ書とマージした報告書にし、ナレッジ化してDBに残す」に
  対して、決定「出力取り込みは両方（自動優先・手動フォールバック）」「ナレッジは下書き＋承認」で実装した。
- 実装は `apps/api/src/prototype/handover-workspace-bridge.js` の右ペイン。既存の DOM / CSS /
  画面遷移は変更せず、`hw-*` クラスの範囲で追加する。既存 `#hw-ev` の下に
  「RSP実行セッション」を置く。
- 流れ: 同意（画面共有・操作支援）→ セッション開始 → 目的を入力して AI に次の一手を提案させる
  → 提案をコピーして RSP で実行 → 実行コマンド・出力・判定を記録 → 次の一手 …
  → 「解決として終了」→ 報告書を作成（サーバが保存した HTML を開く）→ ナレッジ下書きを作成。
- サーバはコマンドを実行しない。提案（AI）と実行（担当者）を別々に保存し、実行記録には SHA-256 を付ける。
  出力は伏せ字化・長さ上限つき。
- 出力の自動取込は RSP のターミナルログ API が未提供のため **未対応**。画面に
  「自動取込は利用できません（手動で貼り付けてください）」を明示する（自動扱いにしない）。
- ナレッジは `status='draft'` で作成し、自動公開しない。承認は既存のナレッジ承認フロー
  （承認者ロール）で行う。引継ぎのグループ承認（`POST /case-handovers/:id/approve`）は
  引継ぎ自体の承認であり、ナレッジの状態は変えない。
- 詳細・API・上限・未決事項は [35-terminal-session.md](35-terminal-session.md)。

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
