# S5 UI クリック検証 — RSP AI支援パネル（2026-10-27 15:08〜15:12）

- 対象: RSP WebUI `https://rsp.mirai-remotetools.com/` → RSP API `:8130` → HelpDesk `:18950`（本番 **commit `ccd1244`**・`/api/health` 200・`db:ok`）
- RSP: HEAD `22966ad`（`rsp-api` active）
- 案件: **CASE-39192**（DirectCloudドライブの同期が止まりエラーが表示される／引継ぎ `claimed`／対象端末 `DESKTOP-TMQM61D`）
- 認証: RSP **ローカルログイン**（`/auth/local-login`）。操作者 `rspadmin`（`roles=["System Admin"]`）。RSP→HelpDesk は `X-Operator-Email` を `HELPDESK_OPERATOR_ALIASES` で読み替え、監査の `actorEmail` は `kensan1969@gmail.com`
- 手段: 実ブラウザ（Playwright / Firefox）で **UI をクリック**。`smoke-S5.md`（2026-10-27 11:11、API 契約の実測）に対する **UI 経路**の実測
- 秘密: 資格情報は本証跡に記載しない。検証後は **RSP ローカルパスワードのローテーション**を推奨

## 判定

| 観点 | 判定 | 根拠（実測） |
|---|---|---|
| RSP ログイン（UI） | **PASS** | `/auth/methods` = `{"local":true,"entra":true}`。`POST /auth/local-login` 200 → `/auth/me` 200（`preferred_username=rspadmin` / `email=rspadmin@local` / `roles=["System Admin"]` / `mfa=false`） |
| AI支援ビュー・案件読込 | **PASS** | `GET /api/v1/helpdesk/cases` 200（CASE-39192 の 1 件）。`GET /api/v1/helpdesk/context?caseId=CASE-39192` 200。PC情報 **35 項目**、引継ぎ `claimed`、claimedBy `kensan1969@gmail.com` |
| 同意→セッション開始 | **PASS** | `POST /api/v1/helpdesk/sessions` 200。session `ed34781e-2658-4543-a9b1-ec4d13fded1e`、TTL 30 分、`consent={screenShare:false, remoteControl:true}` |
| AI 提案 | **PASS** | `POST …/sessions/ed34781e…/steps` 200（1.6 秒）。step `0441454d-…`、`ai_command=hostname`、`risk=low`、`model=deepseek-flash`、purpose/verify/rollback 付き、warnings 0 |
| RSP 実行（キュー投入・出力取込） | **NOT ESTABLISHED** | 対象端末がオフライン。`POST /api/v1/devices/{id}/commands` は **0 件**（RSP ログ 15:08〜15:14）、端末の command_logs も **0 件** |
| 実行記録（手動フォールバック） | **PASS（失敗として記録）** | `output_source=manual` / `exit_status=failure` / **output 空** / sha256 `fdc6075a…` / 補足に理由。**虚偽の出力は入れていない** |
| セッション終了 | **PASS（中止）** | `POST …/close` 200。`reason=stopped`・**「解決」にしていない**・close_note に理由 |
| 報告書への反映 | **未実施（意図的）** | 中止セッションでも `kind=helpdesk_resolved` で作られるため（**SM-12**）。報告書への「RSP実行セッション」節の反映自体は `smoke-S5.md`（API 実測・20,901 bytes）で確認済み |

**結論**: S5 の **UI クリック経路（ログイン→案件読込→同意→開始→提案→実行試行→記録→終了）は実測完了**。RSP 実行の成立だけが端末オフラインで未達（アプリ不具合ではない）。

## 1. 実測（時系列・JST）

| 時刻 | 操作 | 実測 |
|---|---|---|
| 15:08:18 | ヘッダ「ログイン」→ ローカルログインダイアログ | `POST /auth/local-login` 200。ヘッダ表示が `rspadmin` に変化 |
| 15:08:30 | サイドメニュー「🤖 AI支援（HelpDesk案件）」 | ビューが `view-helpdesk` に切替。案件一覧に CASE-39192（`claimed` / `DESKTOP-TMQM61D`） |
| 15:09:13 | 案件選択 → 同意（**操作支援=必須**）ON → 「▶ セッションを開始（同意）」 | `POST /api/v1/helpdesk/sessions` 200。`ed34781e…` / `status=active` / TTL 30 分 |
| 15:09:37 | 目的入力「ホスト名を確認する読み取り専用のコマンドを提案してください」→「🤖 AIに次の一手」 | `POST …/steps` 200。提案 **`hostname`**（risk=low、目的・確認・戻し付き） |
| 15:10 頃 | 「▶️ RSPで実行して取り込む」 | **コマンド投入に至らず**（下記 §2）。出力欄は空のまま |
| 15:11:11 | 判定=❌失敗・補足記入 → 「実行記録を保存」 | `POST …/steps/0441454d…/record` 200。`output_source=manual` / `exit_status=failure` / output 空 |
| 15:12:00 | 終了理由の補足を記入 → 「⛔ 中止」→ 確認ダイアログ承諾 | `POST …/close` 200。`status=closed` / `reason=stopped` |

### 1-1. 終了後の画面（再読込して実測した描画内容）

- バナー: `⚫ セッション終了（中止）` / `終了日時: 2026/10/27 15:12:00` / `補足: S5 UI検証：対象端末がオフライン（last_seen 2026-10-26）でRSP実行が不成立のため中止`
- ステップ: `STEP 1` / `❌ 失敗` / `2026/10/27 15:09:37 / deepseek-flash`
- 実行記録: `実行コマンド hostname` / `判定 ❌ 失敗` / `記録日時 2026/10/27 15:11:11` / `SHA-256 fdc6075a…` / `出力は記録されていません。` / `取込方法: 手動貼り付け`
- 下部: `📄 報告書を作成` は **有効**（中止セッションでも押せる = SM-12）、`▶ 新しいセッションを開始（同意）` も有効

## 2. 実行が成立しなかった原因（実測・アプリ不具合ではない）

- `GET /api/v1/devices?hostname=DESKTOP-TMQM61D` → `device_id=c1e5ff27-…` / `mesh_node_id` あり / **`agent_status=offline`** / `last_seen=2026-10-26T11:39:35Z`
- UI は実行前に「対象端末が `agent_status=online` かつ `mesh_node_id` あり」を要求する（`webui/src/js/app.js` の `hdResolveRunDevice`）。満たさないため**キュー投入の手前で停止**する
- RSP ログ（15:08〜15:14）: `POST /api/v1/devices/…/commands` は **0 件**。`GET /api/v1/commands/queue`（executor のポーリング）のみ
- 同時刻にオンラインだったのは `202307036M` のみ。ケースの対象端末とは**別物**のため、PR #72 の検証（`RSP_DEVICE_MISMATCH`）により別端末のログ取込は **409 で拒否**される。迂回していない

## 3. 記録の内容（事実に忠実であることの確認）

| 列 | 値 |
|---|---|
| `ai_command` | `hostname` |
| `executed_command` | `hostname` |
| `output` | **空** |
| `output_source` | `manual` |
| `exit_status` | `failure` |
| `note` | `RSP実行は未成立。対象端末 DESKTOP-TMQM61D の agent_status=offline（last_seen 2026-10-26T11:39Z）のため出力を取得できず（2026-10-27 15:10 実測）` |
| `sha256` | `fdc6075aba4ece623872c44eb25583a2f59c2a802ae0b58793d352a5b70a72ab` |
| `rsp_command_log_id` | NULL（実行していないため相関 ID なし） |

- 実行していないコマンドの出力を捏造していない。判定は failure、終了は stopped（解決にしていない）。
- CASE-39192 の状態は変更なし（`claimed` のまま・`approved_by` なし）。

## 4. 監査（4 行・すべて `actorEmail` 付き）

| action | 時刻 (Z) | detail 抜粋 |
|---|---|---|
| `terminal.session.start` | 06:09:13 | `via=rsp` / `consent={screenShare:false, remoteControl:true}` / `ttlMinutes=30` / `handoverId=b7927ca7…` |
| `terminal.step.propose` | 06:09:37 | `seq=1` / `risk=low` / `model=deepseek-flash` / `commandHash=7063dece7cccf374` |
| `terminal.step.record` | 06:11:11 | `via=rsp` / `outputSource=manual` / `exitStatus=failure` / `rspVerified=false` / `rspCommandLogId=null` / `sha256=fdc6075a…` |
| `terminal.session.close` | 06:12:00 | `via=rsp` / `reason=stopped` |

## 5. DB 突合

`terminal_sessions`（`ed34781e-…`）: `status=closed` / `close_reason=stopped` / `report_id=NULL` / `rsp_session_id=NULL` / `operator_email=kensan1969@gmail.com` / `device=DESKTOP-TMQM61D` / `ai_model=deepseek-flash`。

`terminal_steps`（`0441454d-…`）: `seq=1` / `recorded_at` あり / `output_source=manual` / `exit_status=failure`。

`final_reports`（CASE-39192）: 既存の `a2e4f474…`（03:21Z・§9 の Phase 2 実測）のみで、今回の追加は **0 件**。

## 6. 所見（新規）

| ID | 内容 | 重大度 | 根拠 |
|---|---|---|---|
| SM-12 | **中止セッションでも報告書は `helpdesk_resolved` として作られる**。画面は中止で閉じても「📄 報告書を作成」を有効に出す（`closed` かつ記録 1 件以上で有効）。サーバは終了理由を見ずに `kind` を固定しているため、中止したセッションの報告書が「解決」と誤認される | Low | `webui/src/js/app.js` の `hdApplyDisabledStates`（report ボタン条件）／`apps/api/src/terminal/report.ts:207`（`kind: 'helpdesk_resolved' as const`）。本 UI 実測でも中止後にボタンが有効 |

- 対応案: `kind` を `close_reason` から決める（例: `stopped` → `helpdesk_stopped`）か、中止セッションでは画面側で確認を出す。今回は**誤った報告書を作らないため作成していない**。

## 7. 制約・後始末

- 端末でコマンドを実行していない（`hostname` すら未実行）。端末・システムへの変更なし。
- 「解決」にしていない（CASE-39192 は `claimed` のまま）。案件・ナレッジ・報告書の新規作成なし。
- 資格情報は本証跡・リポジトリに記載していない。**検証後はローテーションを推奨**。
- 本番 DB への書込みは本セッション分のみ（`terminal_sessions` 1 行・`terminal_steps` 1 行・`audit_log` 4 行）。
