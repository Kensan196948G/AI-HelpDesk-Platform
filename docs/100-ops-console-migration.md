# 100. 運用統合 WebUI への段階移行（添付 `ai-helpdesk-ops.html` を正とする）

## 0. 結論

AI-HelpDesk の WebUI を、添付の**運用統合 UI（14 画面）**へ**段階的に**移行する。

- 新 UI は **`/ops`** で配信する。旧 UI（`/`）はそのまま動かし、機能パリティに到達した時点で `/` を新 UI に切り替え、旧 UI を `/legacy` に残す（§6）。
- 添付は**オフラインで完結するデモ**（API 呼び出し 0・localStorage・疑似 AI）である。これをそのまま本番に置くと受付・引継ぎ・承認・監査が実データで動かなくなるため、**画面ごとに実 API へ接続**して置き換える。
- DevOps／SecOps／⑦ AI・Skills 反映／システム設定 は**バックエンドを新規実装**する（§4）。

## 1. 添付の実測（移行前の事実）

| 項目 | 実測値 |
|---|---|
| 規模 | 2,185 行 / 258,844 B、`<script>` は 1 本（約 1,550 行の IIFE） |
| 画面 | 14 メニュー（ダッシュボード／①受付／②AI一次対応／③引継ぎ・④解決記録／⑤ナレッジ下書き／⑥人間の承認／⑦ナレッジDB／⑦AI・Skills反映／DevOps／SecOps／監査ログ／システム設定） |
| 永続化 | `localStorage`（`save()`/`load()`）。seed データ（KB-101〜、チケット、Skills、監査） |
| AI | 文字バイグラムのコサイン類似度（オフライン疑似 AI）。原本コメントにも「実運用では Claude / OpenAI API に置き換える想定」 |
| 通信 | `fetch` / `/api/` の呼び出し **0 件**。ログインはモック（`#login`）、操作者はプルダウン |
| 業務ルール | 職務分掌（申請者本人は承認不可）・SLA・監査ログ・エスカレーションは UI 内に実装済み（保存先は localStorage） |

## 2. 画面の棚卸しと接続先（既存 API の有無）

| # | 画面 | 実装済みのサーバ API | 移行での作業 |
|---|---|---|---|
| 1 | ダッシュボード | あり（cases / case_handovers / knowledge / audit_log を集計） | 集計 API を追加して実数へ |
| 2 | ① 受付 | あり（`POST /api/intake/preview`、状態保存、`POST /api/case-handovers`） | 受付〜引継ぎ作成を接続 |
| 3 | ② AI 一次対応 | あり（`POST /api/ai/answer` / `answer-case`、`/api/resolve/knowledge-guide`） | 候補提示・会話を実 AI へ |
| 4 | ③ 引継ぎ・④ 解決記録 | あり（`/api/case-handovers` 一式、`/api/terminal`、`/api/reports/final`） | 受信箱・claim・resolve・承認へ |
| 5 | ⑤ ナレッジ下書き | あり（`POST /api/knowledge/inspect`、`/api/knowledge/ui-sync`） | 下書き作成・検査へ |
| 6 | ⑥ 人間の承認 | あり（`/api/knowledge/pending`、`/api/knowledge/:id/review`、職務分離） | 承認・差戻しへ |
| 7 | ⑦ ナレッジDB | あり（`GET /api/knowledge`、承認済み参照） | 一覧・版・検索へ |
| 8 | ⑦ AI・Skills 反映 | **なし** | **新規**（§4-1） |
| 9 | DevOps | **なし** | **新規**（§4-2） |
| 10 | SecOps | 一部（`/api/audit/verify`、緊急停止は UI ローカル） | **新規**＋既存監査へ接続（§4-3） |
| 11 | 監査ログ | あり（`audit_log`・ハッシュ鎖・`/api/audit/verify`） | 画面を実監査へ |
| 12 | システム設定 | **なし**（SLA・通知・承認ルールは設定ファイル/コード） | **新規**（§4-4） |

## 3. 移行アーキテクチャ

### 3-1. 配信

| パス | 内容 |
|---|---|
| `/` | **旧 UI**（現行のステップ受付。移行中はそのまま） |
| `/ops` | **新 UI**（今回の P1 で配信開始） |
| `/legacy` | パリティ後の旧 UI（P7 で移設） |

- 新 UI は `apps/api/src/routes/ops.ts` が配信する。HTML はリポジトリ直下の `Mirai_AIHelpdesk_OpsConsole_V1.0.html`。
- CSP は旧画面と同じ（外部通信禁止・同一オリジンのみ）。`Cache-Control: no-store`。
- 操作者は **Cloudflare Access の本人**（`/api/me` と同じ解決）。モックのログイン画面は使わない。

### 3-2. 状態

| 段階 | 状態の持ち方 |
|---|---|
| P1（今回） | 画面側のサンプル（localStorage）。**実データではないことをバナーで明示** |
| P2 以降 | サーバが初期状態を渡す（`boot.state`）→ 以降は画面ごとに実 API の応答へ置換 |
| 完了時 | 画面の状態はサーバ API の写像だけにする（画面側の永続化を廃止） |

- 画面側の `save()`/`load()` は残すが、**実データ接続した画面から順にサーバ API へ移す**。
- 二重管理（localStorage と DB）が残っている間は、**画面に「サンプル」表示がある場合だけ**ローカル保存を許す。

### 3-3. データモデルの対応

| 新 UI | 実データ | 備考 |
|---|---|---|
| `state.tickets` | `case_handovers`（＋案件スナップショット） | 状態: new/ai/escalated/in_progress/resolved |
| `state.drafts` | `knowledge`（status=draft/pending/review） | 承認・差戻しは `knowledge_reviews` |
| `state.kb` | `knowledge`（status=approved） | 版・有効率は `helpful/notHelpful` 相当を新設 |
| `state.audit` | `audit_log`（ハッシュ鎖） | 追記のみ。画面から直接書き込まない |
| `state.skills` | **新規** `ops_skills` | §4-1 |
| `state.actor` | Access の本人＋`user_roles` | スタッフ切替はデモ専用（本番は本人固定） |

## 4. 新規バックエンド

### 4-1. AI・Skills 反映（`/api/ops/skills`）

- 目的: 承認済みナレッジを **AI の検索対象（索引）とスキル定義**へ反映し、反映状態を画面で見せる。
- テーブル: `ops_skills`（id, key, title, category, version, status, source_kb_id, updated_at）／`ops_reflect`（kb_id, skill_key, reflected_at, result）。
- 反映は**承認イベント起点**（承認 API のトランザクション内で outbox に行を積み、反映処理が拾う）。
- 失敗しても承認は成立させる（outbox 方式。[docs/05](05-api.md) の状態遷移と同じ考え方）。

### 4-2. DevOps（`/api/ops/devops`）

- 目的: 配備・CI・バックアップ・タイマーの**実状態**を 1 画面に集約する（推測値を出さない）。
- 情報源: `systemctl --user`（unit/timer）、`gh run list`（CI）、バックアップディレクトリ（最終 dump と sha256）、`/api/health`。
- 実装: 読み取り専用 API。ホスト情報は**サーバ側で取得**し、画面には要約だけ返す（秘密値・フルパスは返さない）。

### 4-3. SecOps（`/api/ops/secops`）

- 目的: 監査鎖の検証・緊急停止・重大インシデントの状態を 1 画面に集約する。
- 情報源: `audit_log` のハッシュ鎖検証（既存 `/api/audit/verify`）、`resolution_sessions` の期限切れ、緊急停止フラグ。
- 緊急停止は**サーバ保存**にする（現在は UI ローカル）。操作は承認者/監査担当に限定し、監査に 1 行残す。

### 4-4. システム設定（`/api/ops/settings`）

- 目的: SLA・通知・承認ルールを画面から変更できるようにする（現状はコード/設定ファイル）。
- テーブル: `ops_settings`（key, value, updated_by, updated_at）。**秘密値は置かない**（通知先メール等はマスクして表示）。
- 変更は監査に記録し、変更前後の値を残す。

## 5. 段階計画と受入

| 段階 | 対象 | サーバ | 受入（実測） |
|---|---|---|---|
| **P1（今回）** | 配信の土台・実身元・移行中バナー | `GET /ops` | 200・CSP・boot・バナー・操作者が本人・`state=null`（サンプル明示） |
| P2 | ① 受付・② AI 一次対応 | 既存 API の接続、集計 API | 受付→AI 回答→引継ぎ作成が DB に残る |
| P3 | ③④ 引継ぎ・解決 | 既存 API | 受信箱・claim・resolve・承認が画面から可能 |
| P4 | ⑤⑥⑦ 下書き・承認・KB・監査 | 既存 API | 職務分離（自己承認 403）を含めて実測 |
| P5 | ⑦ AI・Skills 反映 | **新規** | 承認→索引/スキル反映→画面表示、失敗時も承認は成立 |
| P6 | DevOps・SecOps | **新規** | 実状態（unit/CI/backup/監査鎖）と一致、緊急停止がサーバ保存 |
| P7 | 設定＋切替 | **新規** | `/` を新 UI へ、旧 UI を `/legacy` へ。ロールバックは 1 コミット |

- 各段階は 1 PR。CI（typecheck / lint / test / build）と、受入は**実測値**で記録する。
- 切替（P7）は**機能パリティ表**で全項目 ✓ になったときだけ行う。

## 6. リスクと対策

| リスク | 対策 |
|---|---|
| サンプルデータを実データと誤認 | 接続前の画面は**バナーとラベル**で明示（P1 は画面下部に常時表示）。P2 以降も未接続画面には印を残す |
| 二重管理（localStorage と DB） | 実データ接続した画面から順にローカル保存を停止。残存中は「サンプル」表示がある画面だけ許可 |
| 権限の画面側判定 | 権限は**サーバが正本**。画面は表示の出し分けのみ（既存の職務分離 API をそのまま使う） |
| PII の画面出力 | 名簿は氏名・所属のみ。メール・端末情報は既存の伏せ字規則を通す |
| 新 UI の回帰 | 旧 UI を `/` に残し、切替は 1 コミットで戻せるようにする |

## 7. 未決事項（次段で決める）

1. `state.tickets` を `case_handovers` に写すか、新しい `ops_tickets` を作るか（§3-3 は前者で設計中）。
2. 「有効率（helpful/notHelpful）」を新設するか、既存の評価に寄せるか。
3. DevOps の情報源のうち、**本番で見せてよい範囲**（unit 名・CI 結果は可、パス・秘密は不可）。
4. 緊急停止の権限（承認者／監査担当のどちらか、両方か）。

## 8. P1 の実装（今回）

| ファイル | 内容 |
|---|---|
| `Mirai_AIHelpdesk_OpsConsole_V1.0.html` | 配信する新 UI（原本 + 起動時のブート差し込み 1 箇所） |
| `apps/api/src/routes/ops.ts` | `GET /ops`（CSP・boot・操作者の解決・移行中バナー） |
| `apps/api/src/routes/ops.test.ts` | 配信・操作者・`state=null`・肩書きの試験 4 件 |
| `apps/api/src/server.ts` | ルート登録 |

**P1 でまだ実データではないもの**: 画面内のチケット・下書き・KB・監査・Skills は**サンプル**（画面下部に「移行中」を常時表示）。P2 以降で上から順に実データへ置き換える。

## 8-2. P2 の実装（①受付・②AI一次対応）

| ファイル | 内容 |
|---|---|
| `db/migrations/038_ops_tickets.sql` | **新規** `ops_tickets`（受付チケット）と採番 sequence |
| `apps/api/src/routes/ops-tickets.ts` | `GET/POST /api/ops/tickets`・`POST /api/ops/tickets/:id/ai`・`PATCH /api/ops/tickets/:id` |
| `apps/api/src/routes/ops.ts` | 起動時に**実 DB の受付済みチケット**を `boot.state` へ載せる |
| `Mirai_AIHelpdesk_OpsConsole_V1.0.html` | 受付の送信と AI 一次対応をサーバ API へ（疑似 AI は未接続時のフォールバックに降格） |
| `apps/api/src/routes/ops-tickets.test.ts` | 受付・一覧・状態更新・AI 回答・404/400・画面写像の 6 件 |

- **受付**: 送信すると `ops_tickets` に 1 行作成（番号は `OPS-####`）。作成は監査 `ops.ticket.create` に残る。
- **AI 一次対応**: サーバの**承認済みナレッジだけ**を根拠にした回答（`answerWithDeepSeek`）をチケットへ保存。鍵が無い環境ではフォールバック回答になり、その場合も記録は残る。
- **権限**: 本人は自分のチケットのみ。ヘルプデスク相当は全件。本人が変更できるのは「引継ぎ（escalated）」までで、それ以降は担当者のみ。
- **検証（ローカル・実 DB）**: 使い捨て DB に migration 038 を適用し、`vitest` で 6 件成功（AI は鍵なしのフォールバック経路）。
- **未接続**: 引継ぎ（`case_handovers`）との接続、③以降の画面。P3 で行う。

## 9. 参照

- 旧 UI の配信とブリッジ: [docs/14](14-prototype-ui-integration.md)
- 受付・引継ぎ・承認の仕様: [docs/14](14-prototype-ui-integration.md) / [docs/93](93-right-panel-tabs.md) / [docs/94](94-knowledge-trial-and-review.md) / [docs/95](95-right-panel-footer-and-reflect.md)
- 配備: [docs/82](82-promotion-runbook-20261106.md) / [docs/98](98-deploy-webui-20261111.md)
