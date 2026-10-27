# 本番デプロイ後スモーク S3 / S4 / S5（実ブラウザ）

- 実施: 2026-10-27 10:27〜10:52 JST（deploy-smoke）
- 対象: `https://ai-helpdesk.mirai-dx-platform.com/`（Cloudflare Access 認証済み・本番 systemd `ai-helpdesk-api` :18950 / proxy :18949）
- デプロイ commit: `804295c`（PR #64）／DB: `ai_helpdesk_preview`
- 手段: Playwright MCP（Chromium・実ブラウザ）。HTTP コードは実測（画面の Network / 同一オリジン fetch）で取得。
- 秘密情報: 実名・実メール・実 IP は本証跡に記載しない（社員番号とロールのみ）。本文中の合成値は未使用（実在 PII を入力しないため、連絡先等は入力していない）。

## 判定サマリ

| # | 項目 | 判定 | 要点 |
|---|---|---|---|
| S3 | STEP1〜3 一気通貫（件名【検証20261027】） | **PASS（注記あり）** | 相談作成→AI一次対応→出典・確信度の表示まで確認。**実 DeepSeek は STEP3 の自由記述質問で確認**（`provider=deepseek`）。初回の構造化回答は画面内ルールベース（模擬）で、これは設計どおり（`bridge.js` が自由記述のみ `/api/ai/answer` へ委譲） |
| S4 | 引継ぎ→claim→担当開始→STEP6 承認（チェックリスト ON）→STEP7 完了→報告書 HTML 200 | **PASS（注記あり）** | 引継ぎ・解決記録・承認・ナレッジ化・完了・報告書 200 まで到達。ただし本番は **Cloudflare Access のログインが 1 アイデンティティ**のため、依頼者と DX が同一アカウントになる。inbox は本人案件を除外する実装（`AUTH_MODE !== 'local'`）のため **UI の受信箱から claim できず**、claim は UI ボタンと同一の API `POST /api/case-handovers/:id/claim` を実ブラウザから実行した。承認は `self_approved=true` になった |
| S5 | RSP 実行セッション（AI支援パネル）が開けるか | **BLOCKED（RSP ログイン情報が無い）** | アプリ内「RSP実行セッション」パネルと RSP WebUI の「AI支援（HelpDesk案件）」画面は**表示できる**。RSP は **未ログイン**（Entra アプリログインが必要）で、RSP のログイン情報が無いため認証後の操作（案件読込・セッション実行・取込）へは進めていない。無理に進めていない |

作成した本番案件は **1 件のみ**（CASE-39194）。終了状態は「完了（STEP7・ナレッジ化済み）」。既存案件は未変更（末尾「既存データ」）。

## 0. 前提・環境の実測

- `/api/me` → **従業員番号 MK0623（管理本部DX推進部）**。社員名簿 `mirai-info.employee_directory` 由来。
- ヘッダー「操作する人」は切替可能（`SWITCH_MODE` は self 固定ではない）。ロール違い（一般社員／ヘルプデスク担当／ナレッジ承認者）で同一人物を切り替えて検証した。
- **サーバ側の利用者識別は Access ログイン（メール）のみ**。画面の「操作する人」は表示・ロールの切替であり、`prototype_states.user_email` や `case_handovers.owner_email/claimed_by` は Access ログインで記録される（実測: `claimedByName` / `approvedBy` に Access ログインのメール。値は伏せ字）。
- サーバ側ナレッジ（RAG の「承認済みナレッジ」）は空ではなく、`/api/ai/answer` のプロンプトに **KB-2026-0001 / 0006 / 0009** が渡ること、回答の `sources` に **KB-2026-0006** が返ることを実測（F 領域の「サーバ knowledge 0 行」は、少なくとも本番の AI 回答経路では該当しない＝読取専用ナレッジが別経路で供給されている）。

### 実施上の割込み（共有ブラウザ）

- 10:35 頃、共有ブラウザの既存タブが別作業で `http://127.0.0.1:18183/`（CWMP Console）へ遷移した。アプリ状態はサーバ保存（`prototype_states`）のため、**新規タブでアプリを開き直して CASE-39194 の STEP4 から継続**した。他者のタブは閉じていない（タブ追加のみ）。
- 以後、追加タブ: アプリ再開用タブ、RSP WebUI 確認用タブ。

## S3: STEP1〜3（CASE-39194）

- 件名: `【検証20261027】VPNに接続できない（スモーク）`／種類: PC・周辺機器・ネットワーク／急ぎ: 通常／ペルソナ: MK0623・**一般社員**ロール
- 本文（合成・実在 PII なし）: 「今朝から社内ネットワークのVPNに接続できません。認証画面のあとで止まり、エラーコード 691 が表示されます。端末はWindows 11の社給PCで、自宅のWi-Fiから接続しています。PCの再起動とパスワードの再設定は試しましたが改善しません。」

| 時刻 (JST) | 出来事 | 実測 |
|---|---|---|
| 10:30:49 | CASE-39194 作成（`POST /api/state/cowork` ほか） | 200。`counters.case` 39194 |
| 10:31:48 | STEP2→STEP3（`AIに相談する`） | chat 生成、`POST /api/device/browser` 200（PC基本情報 35 項目・WEB-4C0D6457） |
| 10:31:49 | STEP3 初回回答（構造化） | model 表示 `DeepSeek-V4.1-Flash` / **確信度 高** / **出典 KB-017**。ただし画面内ルールベース（模擬）で、この時点で AI API 呼び出しは無し |
| 10:33:11 | 「VPNのエラー691…」→ ヒアリング確認 → 回答 | 確認カード（はい/いいえ）→ 10:33:23 回答（KB-002 / KB-019・確信度 中）。ローカル診断経路 |
| 10:34:30 → 10:34:33 | 自由記述「経費精算の締め日と提出先は？」 | **`POST /api/ai/answer` 200**。応答 `provider=deepseek` / `model=deepseek-flash` / 確信度 **低** / `sources=[]` / 本文末尾「根拠: 該当なし」 |
| 10:35:03 → 10:35:06 | 自由記述「Windows Update の通知が消えず再起動を求められる」 | **`POST /api/ai/answer` 200**。`provider=deepseek` / 確信度 **高** / **`sources=[KB-2026-0006]`** / 本文末尾「**根拠: KB-2026-0006**」・画面に **📚 KB-2026-0006** 表示 |

**判定: PASS（注記あり）**
- 「実 DeepSeek」は `provider=deepseek` の応答で確認（10:34:33 / 10:35:06）。出典（KB番号）と確信度（高/低）が画面に表示された。
- STEP3 の**初回の定型回答はルールベース（模擬）**であり、DeepSeek は自由記述のみに委譲する設計（`apps/api/src/prototype/bridge.js:114-160`）。「一次対応＝必ず DeepSeek」ではない点は仕様として明記しておく。
- PC基本情報はブラウザ取得のため **OS=Linux / Firefox**（コンテナ上の Chromium）で、本文の「Windows 11」と不一致。DeepSeek はこれを推測で埋めず「Windows端末としての情報は確認できませんでした」と明示した（好ましい挙動）。

## S4: 引継ぎ → DX claim → 担当開始 → 承認 → 完了 → 報告書

| 時刻 (JST) | 操作 | 実測 |
|---|---|---|
| 10:35:58 | STEP3「解決しない → 担当者へ」→ STEP4 同意 | ローカルで `TKT-2026-0003` / `INC-1008` を発番（受付番号 TKT-2026-0003、ヘルプデスク INC-1008） |
| 10:36:16 | 宛先選択（DX 1 名: **MK0623**）→「この宛先で引き継ぐ」 | **`POST /api/case-handovers` 200**。toast「**（指名した DX 担当者＝MK0623）さんへ引き継ぎました（受信箱に届きます）**」。handover id `6529a1a5-0fef-4137-91de-1ee4eada71a0` |
| 10:37 | DX ペルソナへ切替（MK0623・**ヘルプデスク担当**ロール）→「引継ぎワークスペース」→ INC-1008「担当して対応開始」 | 画面は対応中へ。ただし **`GET /api/case-handovers/inbox` 200・items 0**（`owner_email = 自分` を除外する本番仕様のため受信箱に出ない）。UI からの claim は不可 → **claim は UI と同一エンドポイントの `POST /api/case-handovers/{id}/claim` を実ブラウザから実行**し **200**（`status=claimed`） |
| 10:38 | 解決記録（原因・手順 3 行・所要 15 分）→「解決を記録」 | toast「解決を記録し、ナレッジ下書きを作成しました。」／`DR-003`（draft）・TKT 状態「解決」 |
| 10:38 | ナレッジ下書き →「承認申請」 | `DR-003` status `review`、toast「承認申請しました」 |
| 10:39 | **チェックリスト 4 項目をすべて ON** → 承認者ロール（プロトタイプ内ユーザー a1）で「承認してDB保存・本棚に反映」 | `DR-003` status `approved`、**KB-112 v1.0**、handover `status=completed`（`approvedAt=2026-10-27T01:39:42Z`）。画面は **STEP7「この案件は完了しました」**（KB-112 v1.0 として承認） |
| 10:39:42 | （サーバ）`POST /api/case-handovers/{id}/approve` | **200**。`approvedBy = Access ログイン（伏せ字）`、**`selfApproved = true`** |
| 10:39:56 | STEP7「📄 最終報告書」→ Standalone HTML | **`POST /api/reports/final` 200**（report id `2e16b00a-aad7-4bde-9164-84ba21e7a046`）→ **`GET /api/reports/final/{id}/html` 200** `content-type: text/html; charset=utf-8`（約 25KB・17,358 文字）。toast「Standalone HTML を出力しました（単体で開けます）」 |

### 報告書 HTML の中身（`GET /html` 実測 200）

- `<title>`: 「最終報告書 CASE-39194 - 担当者の対応で解決」
- 見出し（h2）: 概要／相談内容／対応の経過／PC基本情報（読み取りのみ）／AIの一次対応／**担当者への引継ぎ**／**担当者の対応・解決記録**／ナレッジ化（8 節）
- 表示メタ: 出力者=**管理本部／DX推進部・ナレッジ承認者ロール**（画面ペルソナ）／出力日時 `2026-10-27T01:39:56.879Z`／案件番号 CASE-39194／報告書ID `2e16b00a-…`／自己申告 SHA-256 `8e7146641f21ff0f40b805c20ff3d474e8499a424fb3df90e10ecb91229b6ed2`
- PII: 実在メール・電話・IP の実値は 0 件（出現チェックで `example.com` / `090-` / `10.20.30.40` いずれも不一致）。

**判定: PASS（注記あり）**

注記（S4）:
1. **UI からの claim は本番の単一 Access ログインでは成立しない**。`GET /case-handovers/inbox` は `AUTH_MODE !== 'local'` のとき `owner_email <> 自分` に限定する実装（`apps/api/src/routes/case-handovers.ts:410-425`）で、依頼者＝DX が同一アカウントのため 0 件。複数人で Access ログインできる本番運用なら成立するが、本環境では API 直叩きで代替した（UI と同一エンドポイント・同一セッション）。
2. **承認が自己承認として記録された**（`self_approved=true`、toast「自分の対応した案件を自己承認しました（DX 推進部の別の担当者が承認することが望ましい）」）。画面ロールを承認者（a1）へ切り替えても、サーバの `claimed_by` と一致するため自己承認になる。
3. 引継ぎメモ／ナレッジ下書きの「概要・症状」が**最後のチャット発言**（Windows Update）になり、案件の件名（VPN）と不一致。報告書の「担当者への引継ぎ」節にも同じ内容が載る（画面の案件カードの件名は正しい）。
4. 報告書の**出力者**は画面ペルソナ（承認者ロール）で記録され、サーバ側の実行者（Access ログイン）と一致しない。F-08（監査欠落）と同根の「実行者識別の二重管理」。

## S5: RSP 実行セッション（AI支援パネル）

| 確認 | 実測 | 判定 |
|---|---|---|
| アプリ内「RSP実行セッション」パネル（引継ぎワークスペース右ペイン） | 見出し・同意欄（画面共有／**操作支援**）・「セッションを開始」・端末/共有情報・関連ナレッジ KB-112 を表示。操作支援の同意 ON でボタンが有効化 | **表示 PASS** |
| 同上でセッション開始（CASE-39194） | `GET /api/terminal/sessions?caseId=CASE-39194` → **404 NOT_FOUND「この案件の引継ぎが見つかりません。」**（`apps/api/src/routes/terminal.ts:227`）。原因: `latestHandoverForCase` は `status IN ('pending','claimed','resolved')` のみ対象で、本案件は承認済み `completed` のため引けない。**完了後の案件では RSP セッションを開始できない**（順序は claim〜完了前である必要） | **FAIL（Low・順序/表示）** |
| RSP WebUI「AI支援（HelpDesk案件）」 | `https://rsp.mirai-remotetools.com/` で「AI支援（HelpDesk案件）」へ遷移でき、画面（案件ID入力・AI提案・実行記録・同意欄）は描画される。ただし **「未ログイン」**で、RSP のアプリログイン（Entra）が無い | **BLOCKED（RSP ログイン情報が無い）** |

**判定: BLOCKED（RSP ログイン情報が無い）**
- RSP のログイン情報が提供されていないため、認証後の「案件読込→セッション開始→RSPで実行して取込」は実施していない（無理に進めていない）。
- 連携前提の不整合を 1 点記録: docs/37 は「RSP のログインメールと HelpDesk の `claimed_by` が異なる場合は統合認証が通らない」としている。本環境の `claimed_by` は Access ログインのメールで、RSP 側 Entra と同じかは未確認（ログインできないため）。

## 残存データ（本番 DB `ai_helpdesk_preview`）

| 種別 | ID | 状態 |
|---|---|---|
| 案件 | **CASE-39194**（件名 `【検証20261027】VPNに接続できない（スモーク）`） | **完了**（step7・依頼者 MK0623・`closed` 未設定＝AI解決ではなく担当者解決） |
| 受付 | TKT-2026-0003 | 解決 |
| ヘルプデスク案件 | INC-1008 | resolved |
| 引継ぎ | `6529a1a5-0fef-4137-91de-1ee4eada71a0` | **completed**（claim/approve 済み・`self_approved=true`） |
| 解決記録 | DR-003 | approved（KB-112 v1.0 に反映） |
| ナレッジ | **KB-112 v1.0** | 承認・反映済み（新規） |
| 最終報告書 | `2e16b00a-aad7-4bde-9164-84ba21e7a046` | 作成済み（HTML 200・自己申告 SHA-256 `8e7146…`） |
| 端末セッション | なし | 作成していない（S5 の 404） |

- 取消した案件: なし（作成 1 件を完了させた）。
- 既存データ: CASE-39188〜CASE-39193（既存 6 件・他ペルソナの入力中/途中）は**開始時と同一の step・件名**で未変更。INC-1002〜INC-1007 も未変更（参照のみ）。

## 制約の順守

- 作成した案件は 1 件（上限 2 件）。件名に【検証20261027】を含む。
- 実在 PII を入力していない（本文に氏名・メール・電話・IP を書いていない）。証跡にも実名・実メールを書いていない（Access ログインのメールは伏せ字）。
- サービス再起動・設定変更・migration・git 操作は行っていない。
- 既存の本番案件は変更していない。他者のブラウザタブは閉じていない（追加のみ）。

## 新規の指摘（本案のスモークで観測）

| # | 重要度 | 内容 | 根拠 |
|---|---|---|---|
| SM-01 | Medium | 単一 Access ログイン運用では DX が受信箱から引継ぎを claim できない（`inbox` が本人案件を除外）。UI だけで S4 を完遂できない | `GET /case-handovers/inbox` 200・items 0 / `apps/api/src/routes/case-handovers.ts:410-425` |
| SM-02 | Medium | 同一ログインでの引継ぎは承認が自己承認になる（`self_approved=true`）。画面ロール切替では職務分離にならない | `POST /case-handovers/{id}/approve` 200・toast |
| SM-03 | Low | 引継ぎメモ／ナレッジ下書きの概要が最後のチャット発言になり、案件件名と不一致（報告書にも波及） | 画面表示（INC-1008 の引継ぎメモ・DR-003 の症状） |
| SM-04 | Low | 完了案件の RSP セッション開始が 404 NOT_FOUND（画面は開始ボタンを出す）。「完了済みのため開始できません」等の案内が望ましい | `GET /api/terminal/sessions?caseId=CASE-39194` 404 |
| SM-05 | 参考 | 報告書 HTML は Cloudflare Web Analytics の beacon（`static.cloudflareinsights.com`）が応答時に注入され、保存 HTML（自己申告 SHA-256）と応答バイトが一致しない。アプリではなくエッジの注入（`Accept: text/html` のとき +367 bytes） | 同一 URL の 2 回取得比較 |

## 未実施

- RSP 認証後の通し（案件読込→セッション開始→コマンド実行→出力取込→報告書への実行記録反映）: **RSP ログイン情報が無いため BLOCKED**。
- PDF 出力: 本スモークの対象外（HTML のみ確認）。
