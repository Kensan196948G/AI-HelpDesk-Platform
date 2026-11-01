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
  - AI モデル選択欄の名前「社内ローカルLLM（模擬）」等 →「DeepSeek-V4.1-Flash（自由記述のみ）」（2026-11-01 に範囲を明記。個々の回答の表示は §2-11）
- 変更点は `apps/api/src/routes/prototype.ts` の文字列置換と `apps/api/src/prototype/bridge.js` / `device-bridge.js` に限定（§2-11 の文言変更は `honest-labels-bridge.js`）。

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

### 2-10. RSP WebUI との連携（2026-10-26 追加・ユーザー指示）

- RSP の WebUI に「AI支援」パネルを追加し、HelpDesk の案件・PC情報・AI提案・実行記録・
  解決後処理を RSP 側の1画面で扱えるようにした（RSP リポジトリ側の実装）。
- HelpDesk 側は `/api/terminal/*` にサーバ間認証（サービスキー + 操作者メール + loopback）を追加し、
  `GET /api/terminal/context` / `GET /api/terminal/cases` を公開した。
- 契約・セキュリティ・フェーズは [36-rsp-integration.md](36-rsp-integration.md)。

### 2-11. 実 AI とルール・デモデータの表示の分離（2026-11-01 追加・ユーザー指示）

**理由（AGENTS.md §7 の「やむを得ず文言を変える場合」）**: 相談者ウィザードの診断・修復は HTML 内の決定ルールと
固定データ（`S.devices`）で動き、`/api/ai` も `/api/resolve` も呼ばない（ブラウザの通信記録で確認）。それでも
全メッセージのモデル欄が「DeepSeek-V4.1-Flash」だったため、印刷の相談で固定の「見積書_第3版.pdf が詰まっている」
「PCエージェント オンライン」「サーバ側の実行前検証 ✅」が実 AI の実端末調査に見えていた。AGENTS.md §5
「未実装機能を実装済みに見せない」に反するため、ユーザーの全権委譲に基づき応急措置として文言を変える。
本来の修正（実 AI・実端末の診断への接続）は別途の課題であり、この変更では実施しない。

実装は `apps/api/src/prototype/honest-labels-bridge.js`。原本 HTML は変更せず、元の関数が返す文字列の文言と、
引継ぎへ渡す値だけを差し替える（DOM / CSS / 画面遷移は変えない）。保存済みの会話にも効くよう描画時に判定する。

| 対象 | 変更前 | 変更後 |
|---|---|---|
| 実 AI の回答（`provider=deepseek`） | DeepSeek-V4.1-Flash・確信度 | 変更なし |
| 担当者の追加質問（`/api/ai/answer-case`） | API の model 値・確信度 | `provider` を保存し、上と下の同じ判定で表示（案件へ追記する回答にも保存する） |
| フォールバック（`provider=fallback`） | DeepSeek-V4.1-Flash・確信度 | 承認済みナレッジ検索（DeepSeek 未使用）・確信度なし |
| ルールの回答・社内資料カード | DeepSeek-V4.1-Flash・確信度 高/中 | ルールベース（デモデータ）・確信度なし |
| 端末エージェントの実行結果（`ACT.realExec`） | DeepSeek-V4.1-Flash | 端末エージェント（実端末） |
| 診断カード | 端末 MRK-…／「取得するのは…」 | 【デモデータ】・デモ端末／デモデータ（実端末の結果ではありません） |
| ヒアリング確認カード | 対象端末／端末の現状 | 対象端末（デモ）／端末の現状（デモ）と注記 |
| 修復の提案 | 修復・作業の提案／対象 | 修復・作業の提案【デモデータ】／対象（デモ） |
| 実行結果 | サーバ側の実行前検証／PCエージェントの作業 | 実行前検証（デモ：サーバでは検証していません）／PCエージェントの作業（デモ：実端末は変更していません）。端末エージェントへ実行を送った相談では「このカードは模擬です。実端末での実行は下のメッセージを確認してください」 |
| STEP 3 の説明・信号の理由 | AIが社内資料と端末の状態から… | 定型の相談はルールベース（デモデータ）、それ以外の自由記述だけ DeepSeek |

**引継ぎ（担当者が実情報と誤認しない）**

- 「端末」: デモ端末（`MRK-…`）を渡さず、案件に記録された実取得（`WEB-…`／ホスト名と OS）を渡す。無ければ「未取得（実端末の情報はありません）」。閲覧中のブラウザの端末（`pcSnapshot()`）は使わない。事前取得を断った案件・別 PC・非所有者の閲覧で、別の端末を依頼者の端末として渡してしまうため。送信時に再計算せず、本人が同意カードで見た値を共有する。
- 「AIの診断結果」: 各行に【デモデータ】を付け、デモ端末 ID を伏せる。共有の選択肢は残す。
- 「対応案（未実行・失敗）」: 固定のジョブ名・デモ端末を含む「対象」を除き、デモの提案の記録と明記する。
- PC スナップショットが固定データ由来（PCエージェント欄が「模擬」）のときは、引継ぎ・報告書・AI の文脈（`buildPcContext`）へ渡さない。
- 最終報告書: モデル欄は実際に使ったものを書く（実 AI → DeepSeek、フォールバックのみ → ナレッジ検索、どちらも無い → ルールベース）。診断・提案に【デモデータ】を付ける。担当者画面の会話の発言者も分ける。事故の初動・禁止操作・専用窓口の案内（`kind=block`）は実際の手順なので「定型の案内」とし、デモと表示しない。
- 名簿に無い利用者（`PERSONA_LOCKED`）は、画面既定のデモ利用者の氏名を依頼者として渡さない。

**デモ端末の割り当て（コードと再現で確認。本番の DB は参照していない）**

| 利用者 | 割り当て |
|---|---|
| 名簿に一致（本番の self モード） | `MRK-<社員番号>` の仮想端末を自動生成。OS・VPN・プリンタ等はすべて固定値（`baseDevice`）で「異常なし」になる |
| 名簿に不一致、または `/api/me` が取れない | `lockPersona` で画面既定の `u1`（山田 太郎・`MRK-NB-1024`・見積書_第3版.pdf のエラー）のまま固定 |
| 名簿 DB の障害 | `findEmployeeByEmail` が null を返すため、上と同じく `u1` に固定される |
| `PERSONA_SWITCH_ALLOWLIST` のアカウント | any モード。デモ利用者を選べる |

つまり本番でも、実端末を調べた診断は 1 件も無く、全員に固定データが割り当たる。

**残課題**: この変更より前に作成済みのチケット・引継ぎメモ・`coworkShared` は DB を変更しないため修正されない（新規のみ）。
監査ログ `diag_run` には従来どおりデモ端末 ID が残る。名簿未登録の利用者の画面上の氏名は `u1` のまま。provider 欄の追加（2026-10-24）より前の実 AI 回答はルールベース表示になる。担当者の追加質問のうち、サーバが案件へ追記した `provider` の無い回答（`case-ai-*`）は実 AI かフォールバックかを判別できないため、フォールバックだったものも DeepSeek 表示のまま残る。

### 2-12. 印刷の相談の実診断経路（2026-11-01 追加・ユーザー指示）

相談者ウィザードの診断は固定データ（§2-11）で、`/api/resolve` を呼ばなかった。読み取り診断 1 シナリオ（印刷の相談 + `spooler.status`）だけ、次の 1 本の経路にした。原本 HTML は変更せず、`resolve-bridge.js` で差し替える。設計は [25-skill-resolution-loop.md](25-skill-resolution-loop.md) §20。

```
相談（STEP 2）→ 接続確認 → 解決ループのカードへ誘導（STEP 3）→ 本人 Y → 結果の確認 → 次の提案は別の Y → 担当者へ（STEP 4）/ 解決した（STEP 7）
```

**導線の差し替え（理由: 固定データの診断を実診断に見せないため。§7 の例外。ユーザー指示）**

| 対象 | 変更前 | 変更後 |
|---|---|---|
| 印刷の確認カード（`confirmHearing`） | デモ端末・デモのスプーラ状態を表示 | 出さない（`CONFIRM_INTENTS.print` を外す） |
| 印刷の診断（`H.print`） | 固定データの診断と提案 | 接続あり: 解決ループへ誘導。未接続: 「端末エージェントが未接続のため実診断はできません。担当者へ引き継げます。」 |
| STEP 3 の説明・信号の理由（印刷の案件） | 定型の相談はルールベース… | 端末の読み取り結果をもとに本人が確認している旨 |
| 解決ループのカード | 常に開始ボタン | 本人の送信済み案件かつ接続ありのときだけ開始ボタン。未接続は上の文言と端末 ID、担当者へ |
| 提案のラベル | 常に「読み取りのみ」 | リスク 1 かつ戻し方の定義なしだけ「読み取りのみ」。他は「端末を変更します」 |
| 確認待ちカードの見出し | 原因の対処まで完了しました | 対処後の確認が通りました（本人の確認前に断定しない） |
| カードの「担当者へ」「解決した」 | サーバのセッションだけ閉じる | 続けて STEP 4 の同意画面／STEP 7 へ進む |

他の相談（VPN・音声など）の診断は変えていない（§2-11 のデモ表示のまま）。

**結果の出所の表示**

| 出所（`executionSource`） | 表示 |
|---|---|
| `endpoint_agent` | 端末エージェント（実端末） |
| `mock` | 模擬（実端末の結果ではありません） |
| 申告なし・不正 | 実行元を確認できません（実端末の結果と確認できていません） |

結果のカードには「読み取りの結果です。まだ解決とは判定していません。」を出す。

**引継ぎ・報告書・AI へ渡す内容**

- 結果は会話へ出所付きで 1 件ずつ残す（`resolveResult`）。担当者の AI 文脈（`buildCaseContext`）と報告書はここを読む。要点は `fieldsToAi` 適用後の項目だけ。
- 引継ぎは固定データの「AIの診断結果」とは別の「実診断の結果」として渡す。STEP 4 と同意カードに選択肢を出し、外せば渡さない。各行に出所と実行 ID（コマンド ID）を付ける。
- この経路では `kind=diag` の会話を作らないので、デモの診断は引継ぎに入らない。

**制限**: 会話の `resolveResult` は利用者の状態（prototype_states）にあり、サーバの結果と照合していない。正本はサーバの `resolution_steps` / `device_commands`。再読み込みで実行中のセッションへは復帰しない（確認待ちだけ復帰する）。

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

## 7. UI ロジックの変更履歴（表示文言・DOM は変えない範囲）

| 日付 | 変更 | 理由 | 正本との関係 |
|---|---|---|---|
| 2026-10-27 | 引継ぎ時の「相談内容（要約）」を**最後のユーザー発言**から**案件の件名**へ（`consentCard` の `ctx.summary`） | SM-03: 引継ぎメモ・チケット概要が最後のチャット発言になり、案件の件名と不一致になっていた（実測: CASE-39194 のメモ概要が「Windows Update…」、件名は「VPNに接続できない」） | DOM / CSS / 画面遷移は変更しない（値の生成元のみ）。HTML は引き続きUIの正本 |
| 2026-11-01 | 実 AI の回答だけ DeepSeek と表示し、ルール・固定データはデモと明記。引継ぎへデモ端末を渡さない（§2-11） | ルール応答が実 AI・実端末の結果に見えていた（AGENTS.md §5） | **表示文言を変更**（§7 の例外。ユーザーの全権委譲による）。DOM / CSS / 画面遷移は変更しない |
| 2026-11-01 | 印刷の相談を固定データの診断から解決ループへ差し替え、未接続を明示。結果の出所を表示（§2-12） | 実端末を調べていない結果で相談が閉じていた（AGENTS.md §5） | **導線・表示文言を変更**（ユーザー指示）。原本 HTML は変更しない。STEP 4・同意カードに「実診断の結果」の選択肢を追加し、カードの「担当者へ」「解決した」から STEP 4 / 7 へ進める |
