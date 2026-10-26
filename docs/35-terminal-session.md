# RSP実行セッション（AI提案 → 担当者がRSPで実行 → 報告書・ナレッジ下書き）

| 項目 | 値 |
|---|---|
| 版 | v0.1（実装） |
| 決定日 | 2026-10-26 |
| 対象 | 引継ぎワークスペース（3ペイン） |
| 決定 | 出力取り込みは**両方（自動優先・手動フォールバック）**、ナレッジは**下書き＋承認** |
| 関連 | [34-operator-skill-rsp-session.md](34-operator-skill-rsp-session.md) / [33-handover-workspace.md](33-handover-workspace.md) / [21-final-report-export.md](21-final-report-export.md) / [36-rsp-integration.md](36-rsp-integration.md) |

## 1. 目的と原則

担当者（引継ぎを claim した DX 推進部）が、AI の提案した PowerShell を**自分の目で確認し、
RSP のターミナルで実行**して、その実行記録から報告書とナレッジ下書きを作れるようにする。

- **サーバはコマンドを実行しない。** 実行主体は常に担当者。
- AI の提案は記録であって証拠ではない。**実際に実行したコマンド**を担当者が記録し、
  その内容をハッシュで固定する。
- 出力は自動取込を優先し、**取込口が無い場合は手動貼り付け**に落とす（黙って欠落させない）。
- ナレッジは自動公開しない。**下書き＋別承認者**（既存の `knowledge` 承認フロー）。
- 画面（`Mirai_AIHelpdesk_Cowork_StepWizard_V3.1_PCinfo_Offline.html`）の
  レイアウト・CSS は変更しない。拡張はブリッジ JS（`handover-workspace-bridge.js`）に閉じる。

## 2. 状態

| 状態 | 意味 | 遷移 |
|---|---|---|
| （なし） | セッション未作成 | → `active`（担当者が同意して開始） |
| `active` | 実行セッション中。AI 提案・記録が可能 | → `closed`（解決 / 中止 / TTL） |
| `closed` | 終了。報告書・ナレッジ下書きを作成可能 | — |

- 1 引継ぎにつき **同時に 1 セッション**だけ（別セッションが `active` なら 409）。
- TTL は 30 分（既定、最大 120 分）。**遅延評価**で期限切れを `closed`/`expired` にする。
- 上限: **20 ステップ**、1 出力 **20,000 文字**、1 コマンド **8,000 文字**。
- セッションを作れるのは **claim 済みの担当者本人**のみ（`case_handovers.claimed_by`）。

## 3. データ（additive migration `019_terminal_sessions.sql`）

`terminal_sessions`

| 列 | 内容 |
|---|---|
| `id` | uuid |
| `case_id` | text（プロトタイプの案件 ID。既存の `case_handovers.case_id` と同じ型） |
| `handover_id` | uuid → `case_handovers(id)` |
| `device` | 対象端末（スナップショットの `case.device`。無ければ `unknown`） |
| `operator_email` | 実行する担当者（claim 済み本人） |
| `requester_email` | 端末・案件の所有者（引継ぎの `owner_email`） |
| `status` | `active` / `closed` |
| `close_reason` | `resolved` / `stopped` / `escalated` / `expired` / NULL |
| `close_note` | 終了理由の補足（1000 文字） |
| `started_at` / `expires_at` / `closed_at` | timestamptz |
| `consent_screen_share` / `consent_remote_control` | boolean（同意の記録） |
| `ai_model` | 提案に使ったモデル |
| `knowledge_id` | uuid → `knowledge(id)`（作成済みなら再作成しない） |
| `report_sha256` | 作成した最終報告書のハッシュ（表示用） |

`terminal_steps`

| 列 | 内容 |
|---|---|
| `id` | uuid |
| `session_id` | uuid → `terminal_sessions(id)` ON DELETE CASCADE |
| `seq` | 1〜20（`UNIQUE(session_id, seq)`） |
| `operator_email` | 記録した担当者 |
| `ai_command` / `ai_purpose` / `ai_risk` / `ai_verify` / `ai_rollback` / `ai_warnings` / `ai_model` | AI 提案 |
| `executed_command` | **実際に実行した**コマンド（提案と異なってよい） |
| `output` / `output_source` | 出力（PII マスク済み）と `auto` / `manual` |
| `exit_status` | `success` / `failure` / `unknown` |
| `note` | 補足（1000 文字） |
| `sha256` | 実行記録のハッシュ（下記） |
| `recorded_at` | timestamptz |

ハッシュ対象（`stableStringify` でキー順を固定）:

```json
{"sessionId":"…","stepId":"…","seq":1,"command":"…","output":"…","outputSource":"manual","exitStatus":"success"}
```

出力は保存前に `redactPII` で伏せ字化する（パスワード・トークン・個人情報）。
ハッシュは**マスク後の値**で計算し、保存値と検証手段を一致させる。

## 4. API（すべて `/api` 配下・`authenticateUi`）

権限:
- **operator**: `case_handovers.claimed_by == uiEmail`。作成・提案・記録・終了・報告書・ナレッジ。
- **read**: operator、引継ぎの `owner_email`、または DX 推進部（`requireHelpdesk` と同等）。
- それ以外は 403（UI の非表示に頼らない）。

### 4-1. セッションの取得・作成

`GET /api/terminal/sessions?caseId=<案件ID>`
→ `{ ok, session: SessionDTO | null, steps: StepDTO[] }`（その案件の最新セッション。無ければ null）

`POST /api/terminal/sessions`

```json
{ "caseId": "HD-2026-0001", "consent": { "screenShare": true, "remoteControl": true }, "ttlMinutes": 30 }
```

- `caseId` は**案件ID（text）**。サーバが `case_handovers` からその案件の最新引継ぎを引き、
  `claimed_by` を検証する（handover の uuid を UI に要求しない）。

- `remoteControl: true` が無いと 400（ターミナル操作は「操作支援」に含める）。
- claim 済みでない 403 `NOT_CLAIMED_OPERATOR`。active が既にあれば 409 `SESSION_ACTIVE`。
- → `{ ok, session, steps: [] }`

### 4-2. AI 提案

`POST /api/terminal/sessions/:id/steps`

```json
{ "intent": "印刷スプーラが止まっている原因を確認したい", "lastOutput": "（直近の実行結果。任意）" }
```

- 文脈 = 引継ぎスナップショット（件名・本文・PC情報・チャット）＋実行済みステップの要約。
- サーバが `proposePowerShell`（DeepSeek）で 1 コマンドを提案し、`terminal_steps` に保存する。
- → `{ ok, step, session }` / 502 `AI_UNAVAILABLE`（API 未設定・障害）/ 409 `STEP_LIMIT`

### 4-3. 実行の記録

`POST /api/terminal/steps/:id/record`

```json
{
  "command": "Get-Service Spooler | Select-Object Status,Name",
  "output": "Status Name\nRunning Spooler",
  "outputSource": "manual",
  "exitStatus": "success",
  "note": "変化なし"
}
```

- 記録できるのは 1 ステップ 1 回（再記録は 409 `STEP_RECORDED`）。
- `outputSource: "auto"` は取込口が有効なときだけ受理。無効なら 400 `CAPTURE_UNAVAILABLE`。
- → `{ ok, step, session }`

### 4-4. 出力の自動取込（能力の申告）

`GET /api/terminal/sessions/:id/capture`
→ `{ ok, supported: false, reason: "RSPのターミナルログAPIが未提供のため、手動貼り付けを使用します。" }`

- 実装の差し替え点は `apps/api/src/terminal/capture.ts` の 1 箇所。
- RSP 側のログ/API が利用可能になったら `supported: true` と取り込み結果を返す。
  **現時点で対応していないことを `false` で明示する**（自動取込が動いているように見せない）。

### 4-5. 終了

`POST /api/terminal/sessions/:id/close`

```json
{ "reason": "resolved", "note": "スプーラ再起動で復旧" }
```

- `reason`: `resolved` / `stopped` / `escalated`。→ `{ ok, session }`

### 4-6. 報告書

`POST /api/terminal/sessions/:id/report`

- 終了済みセッションから、既存 `FinalReportSchema` に適合する報告書を**サーバ側で組み立て、
  そのまま保存する**（画面が報告書 JSON を組み立てない。改竄余地を減らす）。
- 引継ぎメモ・実行コマンド・出力・判定・実行者・時刻・ハッシュを含む `terminal` セクションを追加。
- 既存の `final_reports` と同じ保存形式（PII マスク後の HTML・SHA-256・24時間 50 件上限）。
- → `{ ok, warnings: string[], report: { id, sha256, kind, caseId, createdAt, files: { html, pdf } } }`
  - `files.html.url` はダウンロード用（`Content-Disposition: attachment`）
  - `files.html.previewUrl`（`?inline=1`）はブラウザ内表示用。UI は**こちら**を新しいタブで開く
  - UI は保存済み DTO を再利用し、`/api/reports/final` へ再送しない（二重作成しない）

### 4-7. ナレッジ下書き

`POST /api/terminal/sessions/:id/knowledge-draft`

```json
{ "title": "（任意）", "cause": "（任意。既定は最終ステップの note）" }
```

- `knowledge` に **status `draft`** で作成（`author_id` は担当者）。
  Access 認証の担当者が `users` に居ない場合は、**パスワードではログインできない行**
  （`password_hash` が scrypt 形式でない）を作って作成者にする（別の人にすり替えない）。
- 2 回目以降は既存の下書きを返す（重複作成しない）。
- 公開は既存の `POST /knowledge/:id/review`（承認者ロール）で行う。**自動公開しない**。
  グループ承認（`POST /case-handovers/:id/approve`）は引継ぎ自体の承認であり、
  ナレッジの `status` は変えない（画面にその旨を表示する）。
- → `{ ok, knowledge: { id, kbNo, title, status, version } }`

## 5. 報告書への追加（`FinalReportSchema` の additive 拡張）

```json
"terminal": {
  "sessionId": "…",
  "device": "MRK-NB-1024",
  "operator": "…",
  "requester": "…",
  "startedAt": "…",
  "closedAt": "…",
  "closeReason": "resolved",
  "captureSupported": false,
  "steps": [{
    "seq": 1,
    "at": "…",
    "intent": "…",
    "proposal": { "command": "…", "purpose": "…", "risk": "low", "verify": "…", "rollback": "…", "warnings": [] },
    "executed": { "command": "…", "output": "…", "outputSource": "manual", "exitStatus": "success", "note": "…" },
    "sha256": "…"
  }],
  "unrecorded": ["ステップ2の出力は未記録"]
}
```

- `unrecorded` は**記録できなかったもの**を正直に列挙する（空配列でも可）。

## 6. UI（3ペイン）

- 案件を選ぶと `GET /api/case-handovers/:id/terminal/sessions` で復元する。
- 右ペインに「RSP実行セッション」を追加:
  - 未作成: 同意（画面共有・操作支援）→「セッションを開始」
  - 作成済み: 残り時間、目的入力＋「AIに次の一手を提案」、ステップ一覧、
    提案コマンドのコピー、実行コマンド＋出力の記録、判定
  - 終了後: 「報告書を作成」「ナレッジ下書きを作成」、報告書 HTML（inline）を開く
  - 再読み込み時は SessionDTO の `knowledge.kbNo` / `report.id` から作成済みを復元する
- `capture.supported === false` のときは「自動取込は利用できません」と明示し、
  手動貼り付け欄を出す（黙って自動扱いにしない）。

## 6-2. RSP WebUI からの利用

RSP の「AI支援」パネルは、RSP のバックエンド経由で本 API を呼ぶ（[36-rsp-integration.md](36-rsp-integration.md)）。
`/api/terminal/*` と報告書 GET だけが、統合ヘッダー（サービストークン + 操作者メール）と
loopback 送信元で認証される。画面からの Access 認証は従来どおり。

## 7. セキュリティ・監査

- サーバはコマンドを実行しない。RSP の資格情報・セッション ID は保存しない。
- 出力は `redactPII` でマスクし、長さ上限を超えた分は切り詰めて「切り詰め」を明示する。
- 監査（`audit_log`）: `terminal.session.start` / `terminal.step.propose` /
  `terminal.step.record` / `terminal.session.close` / `terminal.session.expire` /
  `terminal.report.build` / `terminal.knowledge.draft`。`actorEmail` と案件 ID を detail に残す。
- ナレッジ作成者の自動登録は「下書き作成」に限る。登録される行はログイン不能
  （`password_hash` が scrypt 形式でない）で、権限は `helpdesk`。
- レート制限: 提案 10 回/分、記録 30 回/分（利用者単位）。

## 8. フェーズ

| フェーズ | 内容 | 状態 |
|---|---|---|
| 1 | セッション API・AI 提案・記録・終了・監査 | 実装 |
| 2 | 報告書（引継ぎメモ＋全ステップ） | 実装 |
| 3 | ナレッジ下書き＋承認 | 実装（承認は既存フロー） |
| 4 | RSP ログ/API の自動取込 | 未（`capture.ts` の差し替え） |

## 9. 未決事項

1. RSP ターミナルのログ/API 仕様（提供可否・取得単位・保持期間）。
2. 依頼者本人の同意をセッション開始時に取るか（現状は担当者の同意のみ）。
3. 出力の保存期間と閲覧範囲（監査目的の保持）。
4. リスク `high` の提案を担当者だけで実行してよい範囲（現状は警告表示のみ）。
