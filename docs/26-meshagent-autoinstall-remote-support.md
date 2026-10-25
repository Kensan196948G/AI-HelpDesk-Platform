# MeshAgent 自動導入と同一 UI での遠隔対応（設計検討）

| 項目 | 値 |
|---|---|
| 版 | v0.1（検討中） |
| 日付 | 2026-10-25 |
| 状態 | **設計検討中。決定事項は「未決」**（§12） |
| 関連 | [docs/22](22-remote-assist-handover.md) / [docs/23](23-rsp-meshcentral-integration.md) / [docs/19](19-device-command-execution.md) / [docs/25](25-skill-resolution-loop.md) |
| 前提 | Mirai-Info = データハブ、RSP = 展開・遠隔操作の実行面、AI HelpDesk = 受付・同意・監査・報告（docs/23） |

## 1. 目的とスコープ

### 1-1. 目的

AI 一次対応で解決しなかった相談について、

1. 対象端末に **MeshAgent を自動導入**する（導入済みならスキップ）
2. **ヘルプデスク担当者が MeshCentral / MeshAgent で遠隔対応**する
3. 担当者も **AI HelpDesk と同じ UI** で対応を完結させる

### 1-2. スコープ

- エスカレーション時の MeshAgent 導入要求と状態表示
- 端末マッピング（AI HelpDesk の端末 ↔ RSP の端末）
- 担当者画面からの遠隔セッション起動・コマンド実行・監査連携
- 失敗時のフォールバック（電話・訪問）

### 1-3. 非スコープ

- AI が端末を直接操作すること（AI は提案のみ）
- AI HelpDesk への WinRM / MeshCentral 管理者資格情報の保持
- MeshCentral の全機能の再実装（画面転送・録画基盤そのもの）
- 251 台一括展開（RSP の既存運用に従う）

## 2. 用語

| 用語 | 意味 |
|---|---|
| MeshAgent | MeshCentral の端末エージェント。導入済みなら `mesh_node_id` を持つ |
| RSP | Remote-Service-Platform-for-Linux。MeshAgent 展開と遠隔操作の唯一の実行主体 |
| check-connectivity | RSP の API。WinRM 疎通確認後、未導入なら展開キューへ投入する |
| deployable | Mirai-Info が定める展開可能条件（現役・住所が internal/trusted） |
| 同一 UI | AI HelpDesk のケース画面から起動し、状態・結果・監査まで見えること |

## 3. 現状（実装事実）

| 資産 | 事実 | 根拠 |
|---|---|---|
| RSP `POST /api/v1/devices/{id}/check-connectivity` | WinRM 疎通確認し、`mesh_node_id` が無ければ展開キューへ即時投入（`triggered_deploy=true`）。導入済みなら投入しない | RSP `api/app/routers/devices.py` |
| RSP 展開ワーカー | **15 分毎・平日 08:40〜17:00**、バッチ 5 台・並列 4 | RSP `rsp-mesh-deploy.timer` / 運用整理資料 |
| fullinstall | 新規導入は `-fullinstall`。既定 **off**（`FULLINSTALL_ENABLED=false`）。EDR・サービス再作成を伴う | RSP 実装記録（2026-09-14） |
| msh-only | 既存エージェントの向き先変更。**未導入端末には効かない** | 同上 |
| RSP 遠隔セッション | `POST /api/v1/remote-sessions`（desktop / terminal）、SSO ディープリンク、監査 | docs/23 §1-2 |
| RSP コマンドキュー | `POST /api/v1/devices/{id}/commands`、危険コマンド承認、`command_logs` | docs/23 §1-2 |
| Mirai-Info `/api/meshagent-gap` | 母集団・未導入・`deployable`・直近試行を非 PII で返す | docs/23 §5 |
| AI HelpDesk | 解決ループ、`escalated`、同意 `c.remote`、監査チェーン、最終報告 | docs/25 |
| 端末 ID | AI HelpDesk は `WEB-XXXXXXXX`。RSP と対応しない | docs/23 §5 |

## 4. 要件

| ID | 要件 |
|---|---|
| R-1 | AI が解決できない場合、対象端末へ MeshAgent を自動導入する |
| R-2 | 既に導入済みの場合は何もしない（skip） |
| R-3 | 担当者は MeshCentral / MeshAgent で遠隔対応できる |
| R-4 | 担当者の操作は AI HelpDesk と同じ UI から開始でき、状態・結果・監査が見える |
| R-5 | 誤った端末への導入・操作をしない |
| R-6 | 導入・遠隔操作・コマンド実行が監査に残り、最終報告書へ紐付く |

## 5. 全体フロー

```
Aさん相談
  │
  ▼
AI 解決ループ（docs/25）
  │ 解決 / 本人が「担当者へ」/ NO_SKILL / NO_PROGRESS / 失敗 / タイムアウト
  ▼
escalated
  │
  ├─ 端末マッピング（§8）── 不一致なら担当者が選択
  │
  ├─ RSP check-connectivity
  │     ├─ mesh_node_id あり → skip（R-2）
  │     └─ なし → WinRM 疎通確認 → 展開キュー投入
  │
  ├─ 状態表示: 導入待ち / 実行中 / 完了 / 失敗
  │
  ├─ agent online → 遠隔セッション作成
  │
  ▼
担当者: GUI / ターミナル / コマンドキュー（実体は RSP）
  │
  ▼
完了 → 最終報告書・監査（case ↔ rsp session ↔ command log）
```

## 6. 自動導入の設計

### 6-1. トリガ（未決 D1）

| 案 | 内容 | 長所 | 短所 |
|---|---|---|---|
| A | `escalated` になった時点で即時 enqueue | 速い | 放置・誤操作でも端末にソフトが入る |
| B | 担当者がケースを受諾した時点で enqueue（推奨） | 統制向き | 受諾まで導入されない |

### 6-2. 前提条件（すべてサーバ側で判定）

- 端末マッピングが一意（§8）
- Mirai-Info の `deployable` を満たす（現役・住所 internal/trusted）
- estop が OFF
- 同一 case × device の導入要求が未完了でない
- 導入同意が得られている（未決 D2）
- `FULLINSTALL_ENABLED` が有効（未決 D3）

### 6-3. 冪等性

- RSP 側: `mesh_node_id` / `agent_status` / `mesh_deploy_status` を正とする
- AI HelpDesk 側: `mesh_install_requests` を case × device で一意制約
- `check-connectivity` は導入済みなら `triggered_deploy=false` を返すため、二重導入しない

### 6-4. 実行主体と連携方式（未決 D4）

- 実行は **RSP のみ**。AI HelpDesk は RSP の資格情報を持たない。
- 方式候補:
  - **push**: AI HelpDesk → RSP サービス API（サービスキー + IP 制限）
  - **pull**: RSP ワーカーが AI HelpDesk の依頼キューを取得して実行
- pull の方が AI HelpDesk に RSP 資格情報を持たせずに済む。RSP 側の追加実装要否は Phase 0 で確認する。

### 6-5. 状態モデル

`requested → queued → deploying → installed | failed | skipped`

- `queued`: RSP の展開キュー投入済み
- `deploying`: RSP が実行中（`mesh_deploy_status=deploying`）
- `installed`: `mesh_node_id` あり / `agent_status=online`
- `skipped`: 既に導入済み
- `failed`: WinRM 不可・EDR・オフライン・住所不明など（理由を保持）

### 6-6. UX と失敗時

- 展開は最大 15 分間隔・平日日中のみ。**即時導入はできない**ことを画面に明記する
- 失敗理由ごとにフォールバック（再試行 / 電話 / 訪問）を提示する
- 導入完了の検知はポーリング（まず 30 秒間隔）とし、将来 Webhook 化を検討する

## 7. 同一 UI の設計

### 7-1. 担当者画面（ケース内）

```
🛟 遠隔対応
端末: 202001001M（利用者: 山田 太郎）  状態: MeshAgent 導入待ち（キュー）
[導入状況を見る] [RSPで開く] [ターミナル] [コマンド実行]

AI 運用アシスタント
意図: [印刷キューの状態を確認して、止まっているジョブを消す]
[AIに手順を相談]
  状況 / GUI手順 / PowerShell案（リスク: safe）
  [コピー] [RSPで実行（担当者確認）]
```

### 7-2. MeshCentral 接続方式（未決 D5）

| 方式 | 長所 | 短所 | 位置づけ |
|---|---|---|---|
| A. SSO ディープリンク（別タブ） | 実装小。RSP の認証・録画をそのまま利用 | UI 一体感が弱い | Phase 1 |
| B. iframe 埋め込み | 同一画面 | RSP 側の CSP / X-Frame-Options / Cookie 対応が必要 | Phase 2 |
| C. 独自リモート操作 | 完全一体 | 高コスト・高リスク・監査分断 | 非推奨 |

### 7-3. ターミナル・コマンド

- iframe ではなく **RSP コマンドキュー API** を使い、`command_log_id` をケースに紐付ける
- AI は提案のみ。実行は担当者の確認 + RSP のリスク分類を通す（危険コマンドは RSP の承認フロー）
- AI にシェル実行ツールを渡さない

### 7-4. AI の役割

- 状況整理・GUI 手順・PowerShell 案の提示まで
- 画面操作・コマンド実行は行わない
- Mirai-Info の PII（名簿・貸与者名）は AI に渡さない

## 8. 端末マッピング（最重要）

| キー | AI HelpDesk | RSP | Mirai-Info |
|---|---|---|---|
| コンピュータ名 / 管理番号 | 端末エージェントの `hostname` | `devices.hostname` | `devices.asset_tag` |
| ブラウザ端末 ID | `WEB-XXXXXXXX` | 対応なし | 対応なし |
| 利用者 | プロフィール | `devices.user_name` | `owner_name` |

- 第一キーは **hostname の完全一致**（正規化後）
- ブラウザ取得では hostname が「未検出」になり得るため、**利用者 → Mirai-Info の現役貸与端末** で候補を出す
- 0 件・複数件は担当者に選択させる。**推測でリンクしない**
- マッピング未確定のまま「導入」「遠隔操作」を実行させない

## 9. データモデル・API（案）

### 9-1. テーブル

| テーブル | 主な列 |
|---|---|
| `device_mesh_links` | `user_email, device_id(WEB), hostname, asset_tag, rsp_device_id, mesh_node_id, mapping_status, verified_by, verified_at` |
| `mesh_install_requests` | `id, case_id, session_id, rsp_device_id, status, attempt, last_error, requested_by, requested_at, updated_at` |
| `remote_support_sessions` | `id, case_id, rsp_session_id, view(desktop/terminal), opened_by, started_at, ended_at, recording_ref` |

### 9-2. API（AI HelpDesk 側）

- `POST /api/cases/:id/mesh/ensure` — 導入要求（未決 D1/D4）
- `GET /api/cases/:id/mesh/status` — 導入・agent 状態
- `POST /api/cases/:id/remote-sessions` — RSP セッション作成（view）
- `POST /api/cases/:id/commands` — RSP コマンドキュー投入（担当者確認後）
- `GET /api/cases/:id/remote-events` — セッション・コマンド結果

### 9-3. 監査

- `case_id` ↔ `rsp_session_id` ↔ `command_log_id` を相互参照
- 導入要求・結果・失敗理由、遠隔セッション開始/終了、コマンド実行を AI HelpDesk の監査チェーンへ追記
- 最終報告書に対応経路（AI / 遠隔 / 電話）を記載

## 10. セキュリティ・同意・監査

- MeshAgent 導入は「端末へのソフトウェア導入」。遠隔支援同意（`c.remote`）とは別に **導入同意**が必要か決定する（D2）
- 遠隔操作は attended を原則とし、端末側にインジケータを出す（MeshCentral の機能）
- 最小権限: 担当者の RSP ロールを限定。全社一括にしない
- 画面録画・保持期間・閲覧権限を決定する（D6）
- 誤端末操作の防止: マッピング確認画面・操作前の端末名/利用者表示
- AI へ RSP 資格情報・WinRM 資格情報を渡さない

## 11. 段階計画

| Phase | 内容 | 前提 |
|---|---|---|
| 0 | 決定事項の合意、1 台でマッピングと `check-connectivity` を実測、RSP API 追加要否の確認 | なし |
| 1 | ケース画面に端末状態・「RSPで開く」・手動「導入を依頼」 | RSP 稼働 |
| 2 | 担当者受諾時の自動 enqueue、状態ポーリング、冪等テーブル | RSP 連携方式の決定 |
| 3 | RSP 統合 API でセッション作成・コマンドキュー連携、監査紐付け | RSP 側 API |
| 4 | iframe 埋め込み・画面録画・保持期間 | RSP 側許可 |

### Phase 0 の受入

- 対象 1 台（canary）で端末マッピングが一意に決まる
- `check-connectivity` が「未導入 → `triggered_deploy=true`」「導入済み → `false`」を返すことを実測
- RSP API の追加要否（pull / push）を判断できる材料が揃う
- 誤端末を防ぐ確認フローが定義されている

## 12. 決定事項（未決）

| ID | 決定事項 | 選択肢 | 推奨 | 状態 |
|---|---|---|---|---|
| D1 | 自動導入のトリガ | 即時 / 担当者受諾時 | 担当者受諾時 | **未決** |
| D2 | 導入同意 | 都度同意 / 包括同意 | 都度同意（初回のみ記憶） | **未決** |
| D3 | `FULLINSTALL_ENABLED` | 有効化 / 現状維持 | Phase 0 の実測後に判断 | **未決** |
| D4 | RSP 連携方式 | push / pull | pull（資格情報を持たせない） | **未決** |
| D5 | 同一 UI の深さ | ディープリンク / iframe | Phase 1 はディープリンク | **未決** |
| D6 | 遠隔操作の範囲・録画 | 閲覧のみ / 操作可、録画要否 | 操作可・録画必須（要運用合意） | **未決** |
| D7 | マッピングの正 | hostname / asset_tag / 利用者→貸与端末 | hostname 第一、利用者→貸与端末を補完 | **未決** |
| D8 | 導入失敗時の担当者アクション | 再試行 / 電話 / 訪問 | 失敗理由別に提示 | **未決** |

## 13. リスク

| リスク | 対策 |
|---|---|
| 誤端末への導入・操作 | hostname 完全一致、0/複数件は手動、操作前確認 |
| 即時対応できない（15 分間隔・日中のみ） | 画面に明記、電話・訪問フォールバック |
| fullinstall の EDR 影響 | canary 1 台で実測、段階拡大 |
| 権限の二重化 | RSP のロールを正、AI HelpDesk は同意・監査 |
| 監査の分断 | case / session / command log の相互参照 |
| 画面録画の機密 | 保持期間・閲覧権限・暗号化を決定 |

## 14. 次のアクション

1. 本設計のレビューと §12 の決定
2. Phase 0: 1 台で `check-connectivity` を実測（RSP の認証経路を含む）
3. RSP 側 API 追加要否の確認（pull 方式の実装コスト）
4. Phase 1 の画面設計（ケース内の遠隔対応パネル）
