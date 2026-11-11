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
- 反映は**承認と同じトランザクション**で行う（外部 AI 呼び出しが無く DB 書き込みだけのため、途中失敗は承認ごとロールバックする方が整合的）。実装は §8-5。

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
| P7a | 切替機構＋パリティ表 | 設定のみ | `OPS_UI_PRIMARY` で切替可能。**切替は保留**（§8-8 の未接続項目） |
| P7b | 残機能の移植（端末系・フォルダ・サポート） | 既存APIの接続 | パリティ ✓ の後に `/` を切替 |

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

## 8-3. P3a の実装（③引継ぎ・④解決記録）

| ファイル | 内容 |
|---|---|
| `db/migrations/039_ops_ticket_resolution.sql` | `ops_tickets` に担当・原因・手順・所要・各時刻を追加 |
| `apps/api/src/routes/ops-tickets.ts` | `POST /api/ops/tickets/:id/claim`・`POST /api/ops/tickets/:id/resolve`、PATCH の引継ぎ時刻 |
| `Mirai_AIHelpdesk_OpsConsole_V1.0.html` | 引継ぎ・担当開始・解決記録をサーバ API へ（失敗時は画面を進めない） |
| `apps/api/src/routes/ops-tickets.test.ts` | 担当開始→解決記録→二重解決 409→監査 2 行の試験を追加（計 7 件） |

- **③ 引継ぎ**: ヘルプデスク相当のみ。`escalated` → `in_progress`、担当者名と開始時刻を保存。監査 `ops.ticket.claim`。
- **④ 解決記録**: 原因・手順（配列）・所要分・備考を保存し `resolved` へ。監査 `ops.ticket.resolve`。**二重解決は 409**。
- **失敗時**: サーバ保存に失敗したら画面を先へ進めない（ローカルだけ進む状態を作らない）。
- **検証（ローカル・実 DB）**: migration 039 適用後、`vitest` 7 件成功。
- **未接続**: ⑤ 下書き・⑥ 承認・⑦ KB・監査ログ画面（P3b）。

## 8-4. P3b の実装（⑤下書き・⑥承認・⑦KB・監査）

| ファイル | 内容 |
|---|---|
| `db/migrations/040_ops_knowledge.sql` | `knowledge` に `author_email` / `approver_email` / `category` を追加し、`author_id` を NULL 可に（旧 UI は従来どおり author_id を使う） |
| `apps/api/src/routes/ops-knowledge.ts` | `GET/POST /api/ops/knowledge`・`POST /api/ops/knowledge/:id/approve`・`GET /api/ops/audit` |
| `apps/api/src/routes/ops.ts` | 起動時に ⑦承認済み KB・⑤⑥下書き・監査を実 DB から渡す |
| `Mirai_AIHelpdesk_OpsConsole_V1.0.html` | 下書き作成（解決記録から）と承認をサーバ API へ。一覧は実 DB の値 |
| `apps/api/src/routes/ops-knowledge.test.ts` | 下書き作成・一覧・権限（非承認者 403／自己承認 403）・別の人なら承認・監査の 6 件 |

- **⑤ 下書き**: 解決記録から下書きを作ると `knowledge` に `pending` で保存（監査 `ops.knowledge.draft`）。`author_email` に Access の本人を記録。
- **⑥ 承認**: **approver ロールかつ申請者本人以外**のみ。`approved` にし `approver_email` と承認時刻を保存（監査 `ops.knowledge.approve`）。画面の承認はサーバ成功後にだけ進む。
- **⑦ KB**: `status='approved'` を実 DB から表示（AI の根拠検索と同じ表）。
- **監査**: `audit_log` の直近 50 件を表示（担当者・承認者・監査担当のみ）。
- **検証（ローカル・実 DB）**: migration 040 適用後、ops 系 **17 件成功**（ops 4・チケット 7・ナレッジ 6）。
- **残**: 差戻し（rejected）のサーバ接続、ナレッジの版管理・有効率、Skills 反映への連動（P4）。

## 8-5. P4 の実装（⑦ AI・Skills 反映）

| ファイル | 内容 |
|---|---|
| `db/migrations/041_ops_skills.sql` | **新規** `ops_skills`（カテゴリ単位の Skill 版）と `ops_reflect`（反映ログ）。7 カテゴリの初期行も投入 |
| `apps/api/src/routes/ops-knowledge.ts` | 承認トランザクション内で Skill の版を進め、`ops_reflect` に 1 行記録。`GET /api/ops/skills` を追加 |
| `apps/api/src/routes/ops.ts` | 起動時に Skill 版と反映ログを実 DB から渡す |
| `apps/api/src/routes/ops-knowledge.test.ts` | 承認→Skill 版 +1→反映ログ先頭が該当 KB、の試験を追加（計 7 件） |

- 承認すると `ops_skills.minor` が 1 進み、`ops_reflect` に「KB番号・版・Skill名・Skill版・索引件数・新規/改訂・承認者」を記録する。
- **AI の根拠**は従来どおり `knowledge.status='approved'`（同じ表）なので、承認した瞬間から検索対象になる。
- 画面の ⑦AI・Skills 反映は `state.skills`（カテゴリ→版）と `state.reflect`（反映履歴）を実 DB の値で表示する。
- **検証（ローカル・実 DB）**: migration 041 適用後、ops 系 **18 件成功**（ops 4・チケット 7・ナレッジ 7）。

## 8-6. P5 の実装（DevOps・SecOps）

| ファイル | 内容 |
|---|---|
| `db/migrations/042_ops_estop.sql` | **新規** `ops_estop`（1 行）。緊急停止をサーバ保存に移す |
| `apps/api/src/routes/ops-status.ts` | `GET /api/ops/status`（緊急停止・DevOps 実測・監査鎖検証）／`POST /api/ops/estop` |
| `apps/api/src/routes/ops.ts` | 起動時に緊急停止の状態と DevOps 実測値を渡す |
| `Mirai_AIHelpdesk_OpsConsole_V1.0.html` | 緊急停止をサーバ保存へ。DevOps に「サーバ実測」カードを追加。疑似/localStorage 表記を実態へ修正 |
| `apps/api/src/routes/ops-status.test.ts` | 権限 403・有効化/解除・監査 2 行・DevOps 実測値の 3 件 |

- **緊急停止**: `ops_estop` の 1 行が正本。**承認者・監査担当のみ**操作でき、`ops.estop.on` / `ops.estop.off` を監査に記録。画面はサーバ成功後にだけ状態を変える。
- **監査鎖の検証**: 既存の `verifyAuditChain`（正本）を呼び、`ok` / `rows` を返す（推測値を出さない）。
- **DevOps**: サーバが実測できる値だけ（commit / release / 稼働時間 / Node / `db.ok` / ナレッジ・チケット・引継ぎ・監査の件数）。**unit 名・CI の詳細・パス・秘密は返さない**。
- 画面の「ブラウザ内（疑似AI）」「localStorage」等の表記を実態（サーバ AI・PostgreSQL）へ修正。
- **検証（ローカル・実 DB）**: migration 042 適用後、ops 系 **21 件成功**（ops 4・チケット 7・ナレッジ 7・status 3）。
- **残**: unit/CI/backup の実状態表示（シェル実行を伴うため別段で安全策と一緒に）、システム設定（P6）。

## 8-7. P6 の実装（システム設定）

| ファイル | 内容 |
|---|---|
| `db/migrations/043_ops_settings.sql` | **新規** `ops_settings`（key='ui' の 1 行。秘密値は置かない） |
| `apps/api/src/routes/ops-settings.ts` | `GET/PUT /api/ops/settings`（承認者のみ変更・監査 `ops.settings.update`） |
| `apps/api/src/routes/ops.ts` | 起動時に設定を実 DB から渡す |
| `Mirai_AIHelpdesk_OpsConsole_V1.0.html` | 設定の保存をサーバへ（失敗時はサーバ値へ戻す） |
| `apps/api/src/routes/ops-settings.test.ts` | 既定値・非承認者 403・保存＋監査・順序違反 400 の 4 件 |

- 設定項目: 一致度しきい値（手順提示・候補下限・ほか手順下限）、SLA（P1〜P4）、社内指定版（FortiClient / DirectCloud）、PC情報・リモート・アニメーションの有効化。
- 変更は**承認者のみ**。しきい値と SLA の順序はサーバでも検証する（画面の検証だけに頼らない）。
- 保存に失敗したら**サーバの値へ戻す**（画面とサーバが食い違ったまま進まない）。
- **検証（ローカル・実 DB）**: migration 043 適用後、ops 系 **25 件成功**（ops 4・チケット 7・ナレッジ 7・status 3・settings 4）。

## 8-8. P7a の実装（切替機構）と機能パリティ表

### 切替機構

| 項目 | 内容 |
|---|---|
| 設定 | `OPS_UI_PRIMARY`（既定 `false`） |
| `false`（既定） | `/` = 旧 UI、`/ops` = 新 UI、`/legacy` = 旧 UI |
| `true` | `/` = 新 UI、`/legacy` = 旧 UI（`/ops` も維持） |
| 実装 | `apps/api/src/routes/prototype.ts`（`legacyOnly`）／`apps/api/src/routes/ops.ts`（`primary`）／`apps/api/src/server.ts` |
| 戻し方 | 環境変数を `false` に戻して再起動（1 設定・1 再起動で戻る） |

- 切替は**未実施**（`OPS_UI_PRIMARY=false` のまま）。理由は下のパリティ表。
- 試験: `/legacy` が旧 UI、既定の `/` が旧 UI、`/ops` が新 UI を返すことを実 DB で確認（ops 6 件）。

### 機能パリティ表（旧 UI との比較）

| 機能 | 新 UI | 状態 |
|---|---|---|
| 相談の受付〜AI一次対応 | ①受付・②AI | ✅ 接続済み |
| 引継ぎ・解決記録 | ③④ | ✅ 接続済み |
| ナレッジ下書き・承認・KB閲覧 | ⑤⑥⑦ | ✅ 接続済み（**差戻しは未接続**） |
| 監査ログ・監査鎖の検証 | 監査・SecOps | ✅ 接続済み |
| AI・Skills 反映 | ⑦AI・Skills | ✅ 新規実装 |
| システム設定 | 設定 | ✅ 接続済み |
| DevOps（commit/稼働/DB件数） | DevOps | ✅ 実測値のみ |
| DevOps（unit / CI / backup の状態） | DevOps | ⬜ 未実装（シェル実行の安全策と一緒に） |
| PC基本情報の事前取得（ブラウザ実測） | ①受付 | ✅ 接続済み（`/api/device/browser` へ保存し AI の切り分けに使用。§8-10） |
| 端末診断・修復の実行 | — | ⬜ 未接続 |
| リモート対応（RSP 連携） | ③④ | 🟡 セッション作成まで実装（§8-16）。端末特定・RSP 接続・強制切断は旧UI |
| フォルダアクセス | — | ⬜ 未接続 |
| サポートセッション | — | ⬜ 未接続 |
| 会話ログの全量表示 | ②AI | ✅ 接続済み（§8-9） |
| 資産管理DB（Mirai-Info）からの端末情報 | SecOps 端末・受付の「資産管理DBから取得」 | ✅ 接続済み（§8-11 / §8-14） |

**判断**: 主要な業務フロー（受付→AI→引継ぎ→解決→下書き→承認→KB→反映→監査→設定）は新 UI で実データ動作する。一方、**端末系（PC情報・診断・リモート）とフォルダアクセス/サポートセッション**は未接続のため、`/` の切替は保留する。これらを移植するか、新 UI から外す（受容する）かを決めた時点で `OPS_UI_PRIMARY=true` にする。

## 8-9. P8a の実装（会話ログ全量）

| ファイル | 内容 |
|---|---|
| `db/migrations/044_ops_ticket_messages.sql` | **新規** `ops_ticket_messages`（チケットごとの発話 1 行） |
| `apps/api/src/routes/ops-tickets.ts` | 受付・AI回答・引継ぎ・担当開始・解決のたびに 1 行記録し、一覧/初期表示で `aiLog` として返す |
| `Mirai_AIHelpdesk_OpsConsole_V1.0.html` | 受付直後の `aiLog` をサーバの値から消さないよう修正 |
| `apps/api/src/routes/ops-tickets.test.ts` | 受付→AI→再取得でも会話が消えない試験を追加（計 8 件） |

- 記録する role: `sys`（受付・引継ぎ・担当開始・解決）／`user`（相談内容）／`ai`（回答。provider と出所を meta に保存）。
- 再読み込みしても会話が復元される（これまでは最新回答 1 件だけだった）。
- 相談者からの**追加質問**も実 AI へ接続済み（§8-13）。

## 8-10. P8b の実装（PC基本情報）

| ファイル | 内容 |
|---|---|
| `db/migrations/045_ops_ticket_pc.sql` | `ops_tickets.pc_info`（受付時に取得した PC 情報） |
| `apps/api/src/routes/ops-tickets.ts` | 受付で `pc` を受け取り保存し、画面へ返す |
| `Mirai_AIHelpdesk_OpsConsole_V1.0.html` | 「このPCのブラウザから取得」を**サーバ（`/api/device/browser`）へも保存**し、受付ペイロードに `pc` を添付 |
| `apps/api/src/routes/ops-tickets.test.ts` | PC情報つき受付の保存・返却、`/api/device/browser` 取り込みの 2 件を追加（計 10 件） |

- ブラウザ実測（OS・ブラウザ・CPU・メモリ・画面・回線）は**実データ**で、これまでは画面ローカルに留まっていた。今回から**サーバに保存**され、`answerWithDeepSeek` が端末情報として参照する（AI の切り分けに使われる）。
- チケットに `pc_info` として残るため、再読み込みでも受付時の端末情報が消えない。
- **未接続**: 「資産管理DBから取得」（SKYSEA/AD/Entra 連携）。画面には未接続である旨を出す方針で、P8c 以降に Mirai-Info の端末台帳と接続する。

## 8-11. P8c の実装（端末台帳連携）

| ファイル | 内容 |
|---|---|
| `apps/api/src/lib/mirai-info.ts` | `findDevices()`（資産番号・ホスト名・利用者名で検索）と `deviceStatus()`（件数・鮮度・到達性） |
| `apps/api/src/routes/ops-status.ts` | `GET /api/ops/assets?q=`（担当者のみ・**IP/シリアルは返さない**）／`/api/ops/status` の `devops.assets` に台帳サマリ |
| `Mirai_AIHelpdesk_OpsConsole_V1.0.html` | SecOps の先頭に**実台帳の件数**（全台数・7日以内・オンライン／オフライン・最終確認）を表示。受付の「資産管理DBから取得」は**疑似検索を止め**、準備中であることを明示 |
| `apps/api/src/routes/ops-status.test.ts` | 検索API（500にしない・2文字未満は照会しない）と台帳サマリの 3 件を追加（計 6 件） |

- 実測（本番台帳・読み取りのみ）: **861 台**／7日以内に確認 **112 台**／オンライン **83 台**／オフライン **252 台**／最終確認 2026-11-11。
- 到達性の値は `online` / `offline` / `icmp_only` / null のため、集計は実データの語彙に合わせた（`unreachable` という推測語は使わない）。
- **未接続**: 受付画面から台帳を検索して PC 情報として使う導線（疑似データでの誤った診断を避けるため、今回は**ボタンを止めて準備中と表示**）。次段で `pc_info` と台帳の対応づけを行う。

## 8-12. 統合スモーク（ローカル・実DB）と整合修正（P8d）

ローカルの API（`buildServer` を 19311 で起動）＋実 DB（使い捨て `ai_helpdesk_test`）＋ Playwright で、**新 UI を通しで操作**した。

| 確認 | 結果 |
|---|---|
| `/ops` 表示 | 12 メニュー、バナー表示、`pageerror` 0（コンソールは favicon の CSP のみ） |
| 全 12 画面の遷移 | **JS エラー 0** |
| 初期状態 | 実 DB の値（KB 9 件、Skills 7 カテゴリ、設定 0.42、監査・下書き・チケット） |
| 受付 → AI | チケット `OPS-1025/1026` を作成、会話 `sys/user/ai` が保存され、AI 回答もサーバに残る |
| ③ 担当開始 → ④ 解決記録 | `assignee` と `resolution`（原因・手順）が実 DB に保存され `resolved` に |
| `/legacy` | 旧 UI が 200 で配信 |

スモークで見つけて直した点:

1. **引継ぎの二重記録**: 画面の引継ぎ処理と AI 側の自動引継ぎが両方サーバへ送っていた → 引継ぎ処理側に一本化。
2. **根拠不足の判定**: API キーが無いフォールバックを一律「根拠不足」にしていた → 回答文が「担当者へ引き継ぎ」と言った場合だけ自動引継ぎ。
3. **架空の担当者名**: 担当者選択が画面内のデモ名簿のままだった → 起動時に**実名簿（DX 推進部）**から作る。名簿が引けない環境は本人だけ（架空の名前を出さない）。
4. **古い表記**: 「サンプル（完全オフライン）」「データはこのブラウザ内」→ 実態（サーバ保存・Cloudflare Access）へ修正。

## 8-13. P9 の実装（② 追加質問）

| ファイル | 内容 |
|---|---|
| `apps/api/src/routes/ops-tickets.ts` | `POST /api/ops/tickets/:id/ask`（チケット文脈＋追加質問を実 AI へ。会話に user/ai を 1 往復保存） |
| `Mirai_AIHelpdesk_OpsConsole_V1.0.html` | 追加情報の送信をサーバ API へ（疑似検索をやめる） |
| `apps/api/src/routes/ops-tickets.test.ts` | 追加質問の回答と会話への記録（計 11 件） |

- 権限: 本人またはヘルプデスク相当。レート制限 30 回/分。
- 応答は provider・sources・confidence を会話の meta に保存（後から根拠を確認できる）。
- **統合スモーク（実DB＋実ブラウザ）**: 受付 `OPS-1034` → 追加質問「エラーは『アクセスが拒否されました』です。」→ 会話 `sys,user,ai,user,ai`、**JS エラー 0**。

## 8-14. P10 の実装（受付の台帳検索）

| ファイル | 内容 |
|---|---|
| `Mirai_AIHelpdesk_OpsConsole_V1.0.html` | 「資産管理DBから取得」を `GET /api/ops/assets` へ接続。取得した台帳情報は**診断せず事実だけ**表示 |
| `apps/api/src/routes/ops-tickets.ts` | 受付の `pc` に台帳情報（`ledger`）も含めて保存 |

- 台帳に無い項目（ウイルス対策・更新状況・MFA・証明書）は**診断しない**。画面にもその旨を明記（推測で「異常」を出さない）。
- IPアドレス・シリアルは台帳APIが返さず、画面にも出さない。
- 同意チェックと「システム設定のPC情報取得」が無い場合は取得しない（従来の統制を維持）。
- **統合スモーク（ローカル）**: 台帳が引けない環境では API が `items: []` と理由を返し、画面は「該当する端末が見つかりません」と表示（**JS エラーなし**）。実台帳（本番）での表示は配備後に確認する。

## 8-15. P11 の実装（SecOps のリモート支援セッション）

| ファイル | 内容 |
|---|---|
| `apps/api/src/routes/ops-status.ts` | `loadRemoteSessions()`（`resolution_sessions` の有効な escalated のみ）を `/api/ops/status` に追加 |
| `apps/api/src/routes/ops.ts` | 起動状態に `remote` を追加 |
| `Mirai_AIHelpdesk_OpsConsole_V1.0.html` | SecOps の「接続中のリモート接続」を**実セッション**で表示。強制切断は**未実装であることを明示**し旧UIへ誘導 |
| `apps/api/src/routes/ops-status.test.ts` / `ops.test.ts` | セッション配列の型・メールのマスク・起動状態への包含を追加（計 13 件） |

- 正本は `resolution_sessions`（有効: `status='escalated'` かつ `expires_at > now()`）。
- 画面に出す利用者は**マスクしたメール**（`ke***@domain`）だけ。生のメールは返さない。
- 強制切断は新UIでは未実装のため、ボタンは**押しても何も起きないのではなく、理由を表示して旧UIへ誘導**する。
- **未接続**: 新規リモートセッションの作成（RSP の ensure/link は旧UIの案件モデル前提のため、新UIのチケットモデルとの対応づけが次段の課題）。

## 8-16. P12 の実装（リモート対応セッションの作成）

| ファイル | 内容 |
|---|---|
| `apps/api/src/routes/ops-tickets.ts` | `POST /api/ops/tickets/:id/remote-session`（引継ぎ済みチケットに `resolution_sessions` を 1 行作る・冪等） |
| `Mirai_AIHelpdesk_OpsConsole_V1.0.html` | ③ の担当割り当て／解決記録の画面に「リモート対応の準備」ボタンを追加 |
| `apps/api/src/routes/ops-tickets.test.ts` | 引継ぎ前 409・作成・再実行で再利用（計 12 件） |

- 端末は、チケットに保存した**ブラウザ端末 ID** を優先し、無ければ最新の端末情報（無い場合は `unknown`）。
- セッションは `escalated`・30 分・最大 6 ステップ（既存の解決ループと同じ上限）。監査 `remote_support.session_created`。
- **意図的に旧UIへ残す**: 端末（RSP デバイス）の特定・選択、MeshAgent 導入確認、強制切断。ホスト名の候補から**担当者が選ぶ**操作であり、新UIのチケットだけでは決められないため、勝手にリンクしない。
- 画面のボタンは**サーバ成功後にだけ**トーストを出し、旧UIでの続きを案内する。

## 9. 参照

- **配備・切替・ロールバックの手順**: [docs/101](101-ops-ui-cutover.md)（未実施。実施時に実測値を追記）


- 旧 UI の配信とブリッジ: [docs/14](14-prototype-ui-integration.md)
- 受付・引継ぎ・承認の仕様: [docs/14](14-prototype-ui-integration.md) / [docs/93](93-right-panel-tabs.md) / [docs/94](94-knowledge-trial-and-review.md) / [docs/95](95-right-panel-footer-and-reflect.md)
- 配備: [docs/82](82-promotion-runbook-20261106.md) / [docs/98](98-deploy-webui-20261111.md)
