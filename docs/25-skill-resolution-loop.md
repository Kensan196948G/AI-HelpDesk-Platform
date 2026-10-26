# 解決ループ / Skills 設計（2026-10-25）

| 項目 | 値 |
|---|---|
| 版 | v0.1（設計） |
| 対象 | AI一次対応の拡張（Skill選択・承認・実端末実行・結果ループ） |
| 前提 | 現行 MVP（RAG回答 + 許可リスト1操作 + 画面側Y/N）を壊さず追加する |
| 実装 | **本ドキュメントでは実装しない**（Phase A） |

## 1. 目的とスコープ

### 1-1. 目的

相談文と PC 状態から、**承認済みの Skill（手順）** を AI が選び、
**人間の Y/N（実行前・結果後）** を挟みながら、解決または安全なエスカレーションまで繰り返す。

### 1-2. スコープ

- Skill カタログ（読み取り診断 / 可逆な修復）とバージョン管理
- AI による Skill 選択（**コマンド文字列は生成しない**）
- サーバ側のポリシー検証・承認ハッシュ・監査
- 端末エージェントによる許可済み PowerShell テンプレートの実行
- 結果の伏せ字・要約・AI 評価 → 次提案（解決ループ）
- 2 段階の Y/N（実行前 / 結果後）
- 緊急停止・上限・エスカレーション

### 1-3. 非スコープ

- AI が任意の PowerShell を生成して実行すること
- 端末の画面操作・キー入力・ファイル内容の取得
- 管理者権限の常時付与（昇格は別エージェント/別承認）
- 複数端末の一括実行（Phase D 以降）

> **2026-10-25 追記**
> 第 1 項（AI が任意の PowerShell を生成して実行すること）について、**読み取り専用のプリミティブに限定して探索を許可する改訂案**を [28-readonly-exploration-mode.md](28-readonly-exploration-mode.md) §5 に置いた。
> ただし **本節の契約は未変更**であり、改訂には人間の承認を要する。実測は [27-solution-gap-measurement.md](27-solution-gap-measurement.md)。

## 2. 現状（実装事実）とギャップ

| 項目 | 現状 | ギャップ |
|---|---|---|
| AI | `/api/ai/answer` が承認済み KB + PC 情報で**文章**を返す。ツール呼び出しなし | Skill 選択・構造化出力 |
| 修復提案 | 画面側 `OPS` の決定ルール。Y/N・管理者承認・ハッシュは**画面状態のみ** | サーバ側の承認・ハッシュ・状態 |
| 実端末実行 | `/api/device/command` + エージェント。**`SPOOLER_RESTART` のみ**。Windows 実機未検証 | 複数 Skill・端末バインド・結果正規化 |
| ループ | なし（単発提案） | セッション・ステップ・継続判断 |
| 監査 | 既存 `audit_log`（ハッシュチェーン） | 解決ループのイベント体系 |

## 3. 全体アーキテクチャ

```
[相談文 + PC基本情報 + 直近結果]
        │
        ▼
[AI: Skill選択]  ── 承認済みSkillカタログ（要約）だけを参照
        │  { skillId, params, rationale, confidence, stop, escalate }
        ▼
[サーバ: ポリシー検証]  Skill/版・パラメータ型・許可リスト・リスク・端末一致・上限
        │  step = proposed（承認待ち）
        ▼
[画面: 実行前Y/N]  「何を・なぜ・影響・戻し方」を表示
        │  Y → 承認ハッシュをサーバ保存
        ▼
[サーバ: 実行キュー]  device_commands に登録（op_id=skillId）
        │
        ▼
[端末エージェント]  許可済みテンプレートのみ実行（PowerShell）
        │  結果（正規化JSON + 出力）
        ▼
[サーバ]  伏せ字・要約・監査保存
        │
        ▼
[画面: 結果後Y/N]  「結果はこうでした。続けますか？」
        │  Y → 次の Skill を提案（AI）
        │  N → 停止 / エスカレーション
        ▼
[解決] 本人確認 or 検証Skill成功 / 上限・失敗時は担当者へ
```

- AI は **Skill ID と型付きパラメータだけ**を返す。コマンドはサーバが承認済みテンプレートから決定する。
- 実行は必ず `proposed → approved → executing → done/failed` の状態遷移を経る。
- すべての遷移を `audit_log` に記録する。

## 4. 解決ループの状態機械

### 4-1. セッション状態

| 状態 | 意味 | 遷移先 |
|---|---|---|
| `active` | 次提案を生成中 | `waiting_execute` / `resolved` / `escalated` |
| `waiting_execute` | 実行前 Y/N 待ち | `executing`（Y）/ `stopped`（N） |
| `executing` | 端末実行中 | `waiting_continue`（結果あり）/ `escalated`（失敗） |
| `waiting_continue` | 結果後の継続 Y/N 待ち | `active`（Y）/ `stopped`（N） |
| `resolved` | 解決（本人確認 or 検証成功） | 終端 |
| `escalated` | 担当者へ引継ぎ | 終端 |
| `stopped` | 本人が中止 / 緊急停止 | 終端 |
| `expired` | 期限切れ | 終端 |

### 4-2. ステップ状態

`proposed → approved → executing → done | failed`、例外として `rejected`（実行前N）、
`cancelled`（期限切れ/停止）、`skipped`（重複提案）。

### 4-3. 停止条件（すべてサーバで強制）

| 条件 | 既定値 |
|---|---|
| 最大ステップ数 | 6（設定可） |
| 最大経過時間 | 30 分 |
| 同一 Skill + 同一パラメータの再実行 | 拒否（別パラメータのみ許可） |
| 進捗なし | 2 回連続で状態変化なし → エスカレーション |
| 連続失敗 | 2 回 → エスカレーション |
| リスクレベル 4 以上 | IT管理者の承認必須（自己承認不可） |
| 緊急停止（estop） | ON で全セッション即停止・キュー無効化 |
| 端末オフライン | 2 分応答なしで `failed` → エスカレーション |
| AI 呼び出し上限 | 20 回/セッション |
| ユーザー N | 実行前N → 停止、結果後N → 停止/エスカレーション選択 |

### 4-4. 解決判定

- 本人が「解決した」を押した場合
- または、Skill の `verify` が成功し、サーバが解決と判定した場合
- どちらも監査に記録し、ナレッジ下書きの候補にする（自動公開はしない）

## 5. Y/N 二段階と承認ハッシュ

### 5-1. 二段階

1. **実行前 Y/N**（必須）
   - 画面に「Skill名 / 実行内容 / 対象端末 / 期待結果 / リスク / 戻し方」を表示
   - Y のとき、クライアントは `approvalHash` を送る（サーバが再計算して一致を確認）
2. **結果後 Y/N**（必須）
   - 結果サマリと次の提案を表示
   - Y → 次ステップへ、N → 停止またはエスカレーション

### 5-2. 承認ハッシュ

```json
{
  "sessionId": "uuid",
  "stepId": "uuid",
  "seq": 3,
  "skillId": "spooler.restart",
  "skillVersion": "1.2.0",
  "skillContentHash": "sha256:...",
  "params": { "service": "Spooler" },
  "deviceId": "WEB-AB12CD34",
  "userEmail": "user@mirai-const.co.jp",
  "riskLevel": 3,
  "nonce": "base64url-16bytes",
  "expiresAt": "2026-10-25T05:00:00Z"
}
```

- `stableStringify`（既存の監査と同じキー順非依存）で正規化し SHA-256。
- サーバは `resolution_steps.approval_hash` に保存し、実行直前に再計算して一致を確認。
- `nonce` は 1 回限り。`expiresAt` は 5 分。
- 承認後にパラメータ・Skill 版・端末が変わった場合は **無効化**（`invalidated`）。
- リスク 4 以上は `admin_approval_hash` を別途保存（承認者 != 申請者）。

## 6. Skill スキーマ

```json
{
  "id": "spooler.restart",
  "version": "1.2.0",
  "title": "印刷スプーラを再起動する",
  "summary": "印刷ジョブが処理されないとき、Spooler サービスを再起動します。",
  "symptoms": ["印刷できない", "印刷キューに残る"],
  "os": ["windows"],
  "riskLevel": 3,
  "requires": { "userConfirm": true, "adminApproval": false, "elevation": true },
  "params": {
    "type": "object",
    "additionalProperties": false,
    "required": ["service"],
    "properties": { "service": { "type": "string", "enum": ["Spooler"] } }
  },
  "script": "skills/windows/spooler-restart.ps1",
  "args": ["--service", "{{service}}"],
  "verify": { "script": "skills/windows/service-status.ps1", "args": ["--service", "{{service}}"] },
  "rollback": { "script": "skills/windows/service-start.ps1", "args": ["--service", "{{service}}"] },
  "timeoutSec": 60,
  "resultSchema": { "service": "string", "status": "string" },
  "outputPolicy": { "maxBytes": 8192, "fieldsToAi": ["service", "status"], "maskPii": true },
  "status": "approved",
  "contentHash": "sha256:...",
  "approvedBy": "approver@mirai-const.co.jp",
  "approvedAt": "2026-10-25T00:00:00Z"
}
```

- Skill は **コード（`.ps1`）をリポジトリで管理**し、レビュー + ハッシュ承認で `approved` にする。
- パラメータは JSON Schema で検証。テンプレートへの埋め込みは **引数配列**（シェル文字列連結をしない）。
- `verify` / `rollback` は任意。ロールバックも **別の Y/N** を必要とする。
- リスクレベル:
  - 1: 読み取りのみ
  - 2: 読み取り + 再取得
  - 3: 可逆な変更（サービス再起動等）
  - 4: 影響範囲が広い変更（管理者承認必須）
  - 5: 禁止（実行不可）

## 7. ポリシー検証（順序固定）

1. セッションが `active` で期限内か
2. 端末がセッションの `deviceId` と一致するか
3. Skill が `approved` かつ `os` が対象端末と一致するか
4. `params` が JSON Schema に適合するか
5. リスクレベルに応じた承認が揃っているか
6. 同一 Skill + 同一 params の再実行でないか
7. ステップ数・時間・失敗回数の上限内か
8. estop が OFF か
9. レート制限（提案 20/分、承認 10/分、実行 10/分）
10. 承認ハッシュが一致し、未使用・期限内か

不合格は **理由コード付き 4xx** で返し、実行しない。

## 8. AI 契約

### 8-1. 入力（サーバが構築）

- 相談文・件名・カテゴリ
- PC 基本情報の要約（PII 除外）
- 承認済み Skill の **要約一覧**（id / title / symptoms / risk / params schema の要約）
- これまでのステップと **正規化済み結果サマリ**（生ログは渡さない）
- 制約（最大 1 Skill、コマンド文字列禁止、根拠にない提案禁止）

### 8-2. 出力（厳格 JSON）

```json
{
  "skillId": "disk.space",
  "params": {},
  "rationale": "空き容量を確認するため",
  "confidence": "high",
  "stop": false,
  "escalate": false
}
```

- `skillId` はカタログ内のみ。存在しなければ **fallback**（ルールベース）へ。
- `params` はスキーマ検証。文字列に `;` `|` `$(` 等が現れてもコマンドとして解釈しない。
- `stop=true` / `escalate=true` は担当者へ。
- AI 出力は **保存前に PII 伏せ字**。プロンプトインジェクションは既存方針を維持。

### 8-3. 結果の AI への渡し方

- エージェントは `{ok, exitCode, normalized, stdoutSummary, stderrSummary}` を返す。
- サーバは `normalized` と **最大 2,000 字の要約**だけを AI に渡す。
- 生の stdout/stderr は伏せ字化して DB に保存（AI には渡さない）。
- 出力中の命令文はデータとして扱う（既存の注入対策を踏襲）。

## 9. データモデル（Migration 011）

| テーブル | 主な列 |
|---|---|
| `skills` | `id`, `version`, `title`, `summary`, `symptoms jsonb`, `os text[]`, `risk_level`, `requires jsonb`, `params_schema jsonb`, `script_path`, `args jsonb`, `verify jsonb`, `rollback jsonb`, `timeout_sec`, `result_schema jsonb`, `output_policy jsonb`, `status`, `content_hash`, `approved_by`, `approved_at`, `created_at` |
| `resolution_sessions` | `id uuid`, `user_email`, `case_id`, `device_id`, `status`, `step_count`, `max_steps`, `started_at`, `expires_at`, `last_summary`, `updated_at` |
| `resolution_steps` | `id uuid`, `session_id`, `seq`, `skill_id`, `skill_version`, `skill_content_hash`, `params jsonb`, `rationale`, `risk_level`, `status`, `nonce`, `approval_hash`, `admin_approval_hash`, `approved_by`, `approved_at`, `command_id`, `result_summary jsonb`, `result_full jsonb`, `error`, `created_at`, `executed_at` |
| `device_tokens`（拡張） | `device_id text` を追加（端末バインド） |
| `device_commands`（拡張） | `skill_id` / `skill_version` / `session_id` / `step_id` を追加（既存 `op_id` と併用） |

- 既存 `audit_log` に `resolution.session_started` / `resolution.proposed` / `resolution.approved` /
  `resolution.executed` / `resolution.result` / `resolution.resolved` / `resolution.escalated` を追記。
- 個人情報は保存前に伏せ字。出力全文は保持期間（例 30 日）後に削除。

## 10. API 設計

| Method | Path | 権限 | 説明 |
|---|---|---|---|
| GET | `/api/resolve/skills` | Access 認証 | 承認済み Skill の一覧（要約のみ） |
| POST | `/api/resolve/sessions` | 案件の本人 | `{caseId, deviceId}` → セッション開始 + 初回提案 |
| GET | `/api/resolve/sessions/:id` | 本人/共有先 | 状態・ステップ・結果サマリ |
| POST | `/api/resolve/sessions/:id/propose` | 本人 | 次の提案を生成（AI/fallback） |
| POST | `/api/resolve/steps/:id/approve` | 本人（+管理者） | `{decision:'Y'|'N', approvalHash, adminApprovalHash?}` |
| POST | `/api/resolve/steps/:id/continue` | 本人 | `{decision:'Y'|'N'}` 結果後の継続判断 |
| POST | `/api/resolve/sessions/:id/stop` | 本人 | 中止 |
| GET | `/api/resolve/steps/:id` | 本人 | 実行状態・結果 |

- 既存の `/api/device/command` は内部利用（セッションから登録）に限定し、UI 直叩きは廃止または非推奨。
- エラーコード: `SESSION_EXPIRED` / `STEP_NOT_APPROVABLE` / `APPROVAL_MISMATCH` / `SKILL_NOT_ALLOWED` /
  `PARAM_INVALID` / `DEVICE_MISMATCH` / `STEP_LIMIT` / `ESTOP_ACTIVE` / `NO_SKILL` / `RESULT_TIMEOUT`。

## 11. UI 設計

- 既存プロトタイプ HTML は変更せず、`resolve-bridge.js` を追加注入する（assist-bridge と同方式）。
- 案件チャットの下に「解決ループ」カードを追加:
  - 現在のステップ、Skill 名、実行内容、リスク、期待結果、戻し方
  - **実行前 Y/N** ボタン
  - 実行中インジケータ、結果サマリ
  - **結果後 Y/N**（続ける / やめる）
  - 常時「中止」「担当者へ」ボタン
- コマンド文字列は表示するが、**編集不可**。AI の rationale と根拠を併記。
- 高リスクは「IT管理者の承認待ち」を表示し、承認者以外は Y を押せない。
- 画面の DOM/CSS は既存を維持し、カードのスタイルは bridge 内で最小限に追加。

## 12. 端末エージェント

- 既存 `endpoint-command-agent.mjs` を拡張:
  - `skillId` / `skillVersion` を受け取り、**リポジトリ内の許可済みスクリプト**を実行（`spawn` 引数配列）。
  - `os` 不一致・未承認・ハッシュ不一致は実行しない。
  - 実行前に `deviceId` をヘッダ/結果に含め、サーバと照合。
  - `stdout` / `stderr` は最大 64KB で打ち切り、UTF-8。タイムアウト 60 秒（Skill ごと）。
  - 終了コード・所要時間・正規化結果を返す。
  - 昇格が必要な Skill は **別の管理者エージェント**（別トークン・別サービス）で実行。

### 12-1. 管理者エージェント経路（privilege 分離 / 実装済み 2026-10-25）

昇格必須 5 件（`spooler.restart` / `spooler.queue.purge` / `service.start` /
`bitlocker.status` / `defender.quickscan`）を実行可能にするための経路。
**分離はサーバ側で強制する**。エージェント側の制限は二重防御であり、単独では信頼しない。

| 層 | standard（既定） | admin |
|---|---|---|
| トークン | `device_tokens.privilege = 'standard'` | `device_tokens.privilege = 'admin'` |
| 配信（`GET /api/device/command`） | 昇格必須でないコマンドのみ | 昇格必須のコマンドのみ |
| 結果送信（`POST /api/device/command/:id/result`） | 昇格必須コマンドは **403 `PRIVILEGE_MISMATCH`** | 昇格不要コマンドは **403 `PRIVILEGE_MISMATCH`** |
| エージェント設定 | `deviceToken`（従来どおり） | `adminDeviceToken`（standard と別トークン。無ければ起動拒否） |
| エージェントの許可リスト | `SKILL_SCRIPTS` 全件（従来どおり） | 昇格必須 5 件のみ（それ以外は未知 Skill として拒否） |
| 最後の砦 | — | `.ps1` が非昇格なら `exit 3` |

- 判定は `device_commands.skill_id` + `skill_version` から `skills.requires->>'elevation'` を
  EXISTS で参照する。`skill_id IS NULL` の既存経路（`SPOOLER_RESTART`）は昇格不要として standard に配信する。
- `requires.elevation` は JSON の boolean `true` も文字列 `"true"` も `'true'` になる。
  値が無い/NULL の場合は「昇格不要」（fail-closed で標準側）。jsonb の二重エンコードで
  `elevation` が失われた場合も標準側に倒れる。
- 権限不一致の結果送信は 403、他ユーザーのコマンドは従来どおり 404（存在を漏らさない）。
- 既存行は Migration 016 の `DEFAULT 'standard'` で standard になり、標準エージェントの挙動は変わらない。

#### 運用手順

1. **管理者トークンの発行**（standard とは別の値。値は秘密として扱い、コミットしない）:

   ```sql
   -- 監査のため発行理由を label に残す。token_hash は SHA-256(hex)。
   INSERT INTO device_tokens (token_hash, user_email, label, privilege)
   VALUES ('<sha256(hex) of admin token>', '<user_email>', 'endpoint-agent-admin', 'admin');
   ```

   32 バイト以上のランダム文字列を作り、その SHA-256 hex を `token_hash` に、
   生値は端末の設定ファイルにだけ置く。

2. **端末の設定ファイル**（`~/.config/ai-helpdesk/device-agent.json`）に `adminDeviceToken` を追加する。
   `deviceToken` と同一値は起動時に拒否される（同一だとサーバが standard と判定し、
   admin コマンドが 1 件も配信されないため）。

3. **サービス登録**（別サービスとして動かす。standard エージェントと同居させない）:
   - 環境変数 `AIHD_AGENT_PRIVILEGE=admin` を付けて `endpoint-command-agent.mjs` を起動する。
   - Windows は **管理者として実行**するサービス／タスク（LocalSystem 等）に登録し、
     非昇格の標準エージェント（ユーザーセッション）とは別プロセスにする。
   - 例（登録方針）: `sc.exe create AIHelpDeskAdminAgent binPath= "<node.exe> <repo>\scripts\endpoint-command-agent.mjs --config <path>" start= auto`、
     `AIHD_AGENT_PRIVILEGE` はサービス環境変数（`reg add` 等）またはラッパースクリプトで設定する。
   - 実機のサービス登録・実行検証は Windows 実機が必要なため未実施（静的・統合テストまで）。

4. **無効化**: 当該トークン行の `revoked_at` を現在時刻に更新する（以後 401）。端末側のサービスも停止する。

- Windows 実機検証:
  - 対象 PC に Node 20+ または PowerShell エージェントを配布
  - 署名/ハッシュ検証、実行ポリシー、ログオン時タスク
  - `SPOOLER_RESTART` を最初の実機対象にする

## 13. 監査・観測

- すべての状態遷移を `audit_log` に追記（ハッシュチェーン）。
- セッション/ステップの承認ハッシュ・結果ハッシュを保存。
- メトリクス: 提案数、承認率、実行成功率、平均ステップ数、エスカレーション率、AI 失敗率。
- ログに相談本文・出力全文・秘密を出さない（既存方針）。

## 14. 脅威モデルと対策

| 脅威 | 対策 |
|---|---|
| AI が危険なコマンドを生成 | AI は Skill ID + params のみ。テンプレートは承認済み |
| プロンプトインジェクション（相談文/PC情報/KB/出力） | 命令として扱わない。Skill カタログ外は拒否 |
| 承認後の改ざん | 承認ハッシュ（stableStringify + SHA-256）をサーバ保存・実行直前再検証 |
| リプレイ | nonce 1 回限り、5 分期限、使用済みフラグ |
| 端末の取り違え | deviceId バインド、トークンと端末の照合 |
| 権限昇格 | 昇格は別エージェント・別承認。通常はユーザー権限 |
| 出力経由の情報漏えい | 伏せ字・最大長・AI へは要約のみ |
| 無限ループ/高額請求 | ステップ/時間/失敗/AI 呼び出しの上限 |
| 緊急時の停止 | estop で全セッション停止・キュー無効化 |
| 承認の代行 | リスク4以上は申請者と別の管理者。自己承認は 403 |

## 15. 実装フェーズと受入条件

### Phase B: 読み取り専用ループ PoC

- Skill: `os.info` / `disk.space` / `spooler.status` / `service.status` / `network.adapters`
- 実行は読み取りのみ（変更なし）。**結果の度に Y/N**。
- 受入:
  - AI/fallback が Skill を選び、画面に実行前カードが出る
  - Y で実行、結果が画面に出る
  - 結果後 Y で次提案、N で停止
  - 上限・停止・監査・PII 伏せ字
  - 実測: 3 シナリオ（印刷/容量/ネットワーク）でループが回る
  - テスト: 新規 15 件以上、既存 206 件を維持

### Phase C: 限定実行ループ PoC

- `SPOOLER_RESTART`（リスク3）をサーバ承認ハッシュ付きで実行。
- 実行前 Y/N、結果後 Y/N、失敗時エスカレーション。
- Windows 実機（対象PC）で 1 回実行し、結果とロールバックを確認。
- 受入: 承認改ざん・リプレイ・端末不一致・estop をすべて拒否。

### Phase D: 本格実装

- Skill 管理画面（下書き・レビュー・承認・無効化）、複数 Skill、ロールバック、Windows 配布（GPO/Intune）。
- 受入: 運用者が Skill を追加でき、レビューと承認が分離され、監査で追跡できる。

## 16. 決定事項と残課題

### 決定（本設計で確定）

- AI は実行時コード生成をしない（Skill 選択のみ）。
- 承認はサーバ側でハッシュ保存。2 段階 Y/N。
- 実行は許可済みスクリプトの引数配列のみ（シェル文字列連結なし）。
- リスク 4 以上は管理者承認必須・自己承認不可。
- 上限・estop・端末バインドをサーバで強制。

### 残課題（Phase B 着手前に詰める）

- Skill スクリプトの配布方法（リポジトリ同梱 / 署名付き zip）
- 出力全文の保持期間と削除
- 既存 `device_commands` との互換（移行 or 併存）
- 高リスク Skill の承認者ロール定義（既存 `itadmin` を利用）
- 画面の配置（案件チャット下 / 別ツール）の最終確認

## 17. 実装状況（2026-10-25 / Phase B）

| 項目 | 状態 |
|---|---|
| DB | `011_resolution_loop.sql`（skills / resolution_sessions / resolution_steps、device_commands・device_tokens 拡張） |
| API | `/api/resolve/*` 7 本。承認ハッシュ・Y/N 二段階・状態機械 |
| Skill | 読み取り専用 5 件（os.info / disk.space / spooler.status / service.status / network.adapters）。起動時に `.ps1` の SHA-256 を計算して upsert |
| 端末 | `endpoint-command-agent.mjs` が許可済み `.ps1` を引数配列で実行。`--mock`/非 Windows は fixture |
| UI | `resolve-bridge.js`（案件ウィザード下にカード）。実行前 Y/N → 結果 → 継続 Y/N → 停止 |
| テスト | 新規 46 件（resolve）+ device 13 件、全体 **253 件**。UI E2E で 2 ステップのループを実測 |
| 未実施 | Windows 実機の PowerShell 実行、estop 連携、端末オフライン検知、承認期限切れ後の再提案 |

### 17-2. Phase 2（修復 Skill・2026-10-25）

| 項目 | 状態 |
|---|---|
| カタログ | **12 件**（Phase B 読み取り 5 + Phase 2 修復 7） |
| 修復 7 件 | `spooler.restart`(2) / `spooler.queue.purge`(3) / `service.start`(2) / `temp.cleanup`(2) / `dns.flush`(1) / `bitlocker.status`(1) / `defender.quickscan`(1) |
| 承認 | **7 件は `draft`**。`scripts/approve-skills.ts` を人間が実行するまで端末エージェントは拒否する（fail-closed） |
| 実行可能性 | 非昇格エージェント（standard）で実行できるのは `temp.cleanup` / `dns.flush` の **2 件**。残り 5 件は昇格必須で、`admin` トークンの管理者エージェントにだけ配信される（§12-1） |
| 権限分離 | **実装済み**。`016_agent_privilege.sql` で `device_tokens.privilege`（standard / admin・既定 standard）を追加。`GET /api/device/command` は `skills.requires->>'elevation'` で配信を分離し、`POST /api/device/command/:id/result` は権限不一致を 403 `PRIVILEGE_MISMATCH` で拒否する（サーバ側で強制）。エージェントは `AIHD_AGENT_PRIVILEGE`（既定 standard）と `adminDeviceToken` で二重防御 |
| 検証 | typecheck / lint（自変更ファイル）/ test **327 件 PASS**（2 回連続実行）。`.ps1` 12 件の Parser 構文 OK、PSScriptAnalyzer Error 0。**Windows 実機の実行検証は未実施**（静的契約まで） |
| 残り（人間の Gate） | 修復 7 件の承認（`scripts/approve-skills.ts` を人間が実行）、管理者トークンの発行、Windows 実機でのサービス登録（管理者権限）と実行検証 |
| 既知の制約 | ~~UTF-8 BOM なし~~ → **2026-10-26 実機で構文エラーを確認し、全12件に BOM を付与**（PS 5.1 は BOM なし UTF-8 を ANSI として解釈するため） |

Phase B の実測（隔離 DB + mock エージェント）:
- `network.adapters` 提案 → Y → `done` → 結果表示 → 継続 Y → `os.info` 提案 → Y → `done` → 継続 N → `stopped`
- 画面の pageerror / HTTP 4xx は 0。

## 18. ハードニング（独立レビュー H-1/H-2/H-3 対応 / 2026-10-25）

Phase B の独立レビューで指摘された High 3 件を、Phase C 着手前に修正した。

| ID | 指摘 | 対応 |
|---|---|---|
| H-1 | Skill が起動時に自動 approved。content_hash が .ps1 のみ。agent が version/hash を検証しない | `scripts/skills/approved.json` に**人間レビュー済みの定義ハッシュ**を保存。スクリプト・引数・リスク・paramsSchema・verify/rollback・出力ポリシーをすべて含む `contentHash` とし、manifest と一致する Skill だけを approved にする。変更があれば自動的に draft。agent も manifest とローカル `sha256` を照合し、不一致は実行しない |
| H-2 | 端末バインドが無い（deviceId 任意、x-device-id 無視、同一ユーザーの別端末で実行可能） | セッション開始時に `device_inventories` で本人の端末か確認。デバイストークンに `device_id` を TOFU バインドし、以後の `x-device-id` と一致しない場合は 403。GET /device/command は端末一致のコマンドだけ配信。結果報告も端末一致を検証 |
| H-3 | 承認後の停止が実行キューを止めない | stop / expire で `proposed/approved/executing` の step を `cancelled`、`queued` の device_command を `expired` に更新。agent は停止済みセッションのコマンドを取得できない。停止後に結果が届いても session/step を進めない |

追加:
- estop（画面の緊急停止）が ON の間はセッション開始・承認を 409 `ESTOP_ACTIVE` で拒否。
- `escalate` 用の状態は `failed` 時に設定（手動 resolve は Phase C で追加）。
- テスト: 65 件（resolve + device）に増加。全体 **261 件**。

残り（Phase C で対応）:
- Windows 実機での PowerShell 実行
- 端末オフライン/結果タイムアウトの自動失敗
- リスク 4 以上の IT 管理者承認 UI
- 手動「解決した」「担当者へ」操作
- 出力ポリシー（fieldsToAi）の厳密適用（現状は PII 伏せ字 + サイズ制限）


## 19. 実装状況（2026-10-25 / Phase C 部分）

§18 の「残り」のうち、Windows 実機を除く 4 項目を実装した。

| 項目 | 状態 | 実体 |
|---|---|---|
| 端末オフライン / 結果タイムアウト | 実装 | 承認時に `RESOLVE_DEVICE_OFFLINE_SEC`（既定 120 秒）で `DEVICE_OFFLINE`。承認時に `timeout_sec` / `deadline_at` を確定し、`sweepResolveTimeouts()` が期限超過を `failed`（`RESULT_TIMEOUT`）→ セッション `escalated`。期限後の結果は状態を進めない |
| リスク 4 以上の IT 管理者承認 | 実装 | `RESOLVE_ADMIN_ALLOWLIST`（既定空・fail-closed）。`GET /api/resolve/admin/pending` と `POST /api/resolve/steps/:id/admin-approve`。payload は利用者側と別の 13 キー。自己承認・改ざん・期限切れ（5 分・依頼者側と同一）を拒否。UI に承認待ちと注意表示 |
| 手動「解決した」「担当者へ」 | 実装 | `POST /api/resolve/sessions/:id/resolve` / `escalate`。監査に `by: manual` と理由。UI に両ボタン |
| fieldsToAi の厳密適用 | 実装 | 結果取り込み時に `result_ai`（宣言フィールドのみ・既定拒否）を保存し、次提案は `result_ai` だけを使う。画面用 `last_summary` は従来どおり |

- migration: `013_resolution_phase_c.sql`（additive。CHECK 制約は 011 のままで足りる）
- テスト: **278 件**（+17）。`npm run typecheck` / `npm run lint` 緑
- 独立レビュー対応: AI 要約の fieldsToAi 迂回、期限後コマンド配信、リスク 5 の実行、
  session/step のロック順逆転（デッドロック）、複数管理者の上書き、手動理由の PII、
  既存データの期限 backfill（migration 014）を修正。
- 2026-10-25 人間承認: 上記の実出力キー不一致を解消した。`os.info` は osName/version/
  buildNumber/architecture、`disk.space` は volumes、`spooler.status`/`service.status` は
  name/status/startType を `fieldsToAi` とし、`approved.json` を再生成した（kensan1969@gmail.com）。
- 未実施: Windows 実機での PowerShell 実行とロールバック確認、管理画面（別画面）への承認導線統合、
  fieldsToAi のドット記法拡張
- 注記: 本ブランチは `feat/resolve-loop-poc`（Phase B）から分岐。`main` は設計書（572ecb3）のみで、
  Phase B の実装 2 コミットはまだ main にマージされていない。
