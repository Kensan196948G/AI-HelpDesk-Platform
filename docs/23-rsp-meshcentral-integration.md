# RSP / MeshCentral 連携と AI 運用アシスタント設計

| 項目 | 値 |
|---|---|
| 版 | v0.1 |
| 日付 | 2026-10-24 |
| 参照 | [Remote-Service-Platform-for-Linux](https://github.com/Kensan196948G/Remote-Service-Platform-for-Linux) / Mirai-Info / 本リポジトリ [docs/22](22-remote-assist-handover.md) |
| 結論 | **Mirai-Info はデータハブ、RSP は遠隔操作の実行面、AI HelpDesk は受付・同意・監査・報告の正本**。Mirai-Info に WinRM/MeshCentral を追加しない |

## 1. 先に結論

### 1-1. 「Mirai-Info で MeshCentral Agent を操作する」は推奨しない

Mirai-Info は、端末の母集団・住所・WinRM 導通・MeshAgent 未導入ギャップの**正本（データハブ）**です。
MeshCentral の画面転送・PowerShell ターミナル・セッション監査・コマンド実行は **RSP の責務**で、
すでに実装されています。

RSP の役割境界（`docs/meshagent-deploy-role-boundaries.md`）は次のとおりです。

| 項目 | 正 | 実行する者 | してはいけない者 |
|---|---|---|---|
| 母集団（現役） | Mirai-Info | Mirai-Info | RSP / PC-Ops が再計算 |
| 端末の住所 | Mirai-Info | Mirai-Info | RSP が独自導出 |
| WinRM 導通確認 | Mirai-Info | Mirai-Info | RSP（撤去済） / PC-Ops（表示用の自己観測のみ） |
| 展開対象の選定 | Mirai-Info（母集団） + RSP（実行キュー） | RSP | PC-Ops |
| **端末への MeshAgent 展開** | **RSP** | **RSP のみ** | **PC-Ops / Mirai-Info** |
| VPN 接続・切断 | Mirai-Info | Mirai-Info | RSP / PC-Ops |

したがって、Mirai-Info 側に WinRM 実行を足して MeshAgent を導入・操作するのではなく、

- **Mirai-Info**: 未導入の検出、対象の選定、住所・導通の供給（`/api/meshagent-gap`）
- **RSP**: WinRM による展開、MeshCentral への登録、画面/ターミナル/コマンド実行、監査
- **AI HelpDesk**: 相談・同意・引継ぎ・AI 一次対応・最終報告

に分けます。Mirai-Info から展開を起動したい場合も、**RSP の展開キュー/API を呼ぶ**（または RSP がハブのギャップを巡回する）のであって、Mirai-Info が WinRM を直接叩く形にはしません。

### 1-2. RSP には必要な機能がすでにある

RSP のコード/README で確認できた事実:

| 機能 | 実装 | 根拠 |
|---|---|---|
| MeshCentral デスクトップ | `MeshCentralAdapter.create_remote_session_url(view="desktop")` | `api/app/adapters/meshcentral.py` |
| MeshCentral ターミナル（PowerShell） | `view="terminal"` → `viewmode=12` | 同上 / `webui/src/js/app.js` `openInteractiveTerminal` |
| SSO 付きディープリンク | `MESHCENTRAL_LOGIN_COOKIE_KEY` があれば `&login=<token>` を付与 | `meshcentral.py` `generate_login_token` |
| セッション作成と監査 | `POST /api/v1/remote-sessions` → `RemoteSession` | `api/app/routers/sessions.py` / `session_service.py` |
| 未導入端末の導通確認→即時展開 | `POST /api/v1/devices/{id}/check-connectivity` | `api/app/routers/devices.py` |
| WinRM 経由の MeshAgent 展開 | `Deploy-MeshAgent.ps1` / RSP 巡回 | `docs/remote-access-architecture.md` / `meshagent-deploy-role-boundaries.md` |
| PowerShell/cmd のコマンドキュー | `POST /api/v1/devices/{id}/commands`、`command_logs`、危険コマンド承認 | `api/app/routers/devices.py` / `command_classifier.py` |
| サービス間コマンド API | `POST /api/v1/service/commands`（PC-Ops 用、サービスキー + IP 制限） | `docs/service-command-api.md` |
| Mirai-Info への証跡発行 | `rsp_writer` → `remote_agent_states` / `audit_events` / `meshagent_deploy_attempts` | `docs/mirai-info-evidence.md` |

> RSP の `docs/remote-access-architecture.md` は「コンソール接続はスタブ」と書いていますが、
> 現在のコードと README は MeshCentral 接続・SSO・ターミナル・コマンドキューまで実装済みです。
> **設計書の一部は古い**ため、連携仕様はコードと README を正にしてください。

### 1-3. AI HelpDesk の B さん画面に必要なのは「RSP への橋渡し」

B さんが GUI/PowerShell で操作する実体は RSP/MeshCentral です。AI HelpDesk が同じ機能を再実装するのではなく、
**症例（ケース）と RSP の端末・セッション・コマンドを結びつける**のが正しい分担です。

```
Aさん相談 → AI HelpDesk（受付・同意・報告）
                │  device mapping（hostname / asset）
                ▼
         RSP API / WebUI（Entra ID・RBAC・監査）
           ├─ MeshCentral Desktop（GUI）
           ├─ MeshCentral Terminal（PowerShell）
           └─ command queue（危険コマンド承認・command_logs）
                │
                ▼
         Mirai-Info（母集団・住所・ギャップ・証跡の正本）
```

## 2. 画面イメージ（B さんの STEP 5）

```
🛟 遠隔支援（同意した範囲）
  状態: 本人の同意済み（30分）
  [GUIで開く（MeshCentral）] [PowerShellを開く] [RSPで開く]

  AI 運用アシスタント
  意図: [印刷キューの状態を確認して、止まっているジョブを消す]
  [AIに手順を相談]
  ┌─────────────────────────────────────────────┐
  │ 状況: 印刷スプーラ停止の可能性（RSP: 端末オンライン） │
  │ GUI手順: 1. ... 2. ...                       │
  │ PowerShell案: Get-Service Spooler             │
  │   リスク: safe / 実行は RSP のコマンドキュー経由 │
  │ [コピー] [RSPで実行（Bさんが確認）]            │
  └─────────────────────────────────────────────┘
```

- **GUI**: MeshCentral のデスクトップを開く。AI は手順を案内する（AI が画面を直接クリックはしない）。
- **PowerShell**: MeshCentral の対話型ターミナル、または RSP のコマンドキュー（1 コマンドずつ監査に残る）。
- **AI**: 状況整理・手順案・PowerShell 案を出す。実行は B さんの確認後、RSP のリスク判定を通す。

## 3. AI 運用アシスタント（Claude Cowork 風）の設計

### 3-1. できること / できないこと

| 層 | AI の役割 | 実行主体 | 条件 |
|---|---|---|---|
| 状況整理 | ケース・共有PC情報・RSP 端末状態を要約 | AI | PII を伏せ字化 |
| GUI 案内 | MeshCentral の画面で何を確認するか手順化 | B さん | AI は画面を操作しない |
| PowerShell 案 | 読み取り中心のコマンドを提案・説明 | B さん | RSP のリスク分類、危険は承認 |
| コマンド実行 | 提案を RSP のコマンドキューへ投入 | RSP | **B さんの明示確認 + リスク判定** |
| GUI 自動操作 | UI Automation 用の PowerShell を提案 | B さん / RSP | 原則として AI に直接操作させない |

### 3-2. ツール（AI が呼べるもの）

AI HelpDesk サーバー側で、AI に渡すツールを限定します。

| ツール | 実体 | 実行 |
|---|---|---|
| `get_case_context` | AI HelpDesk のケース・共有PC情報 | 読取 |
| `get_rsp_device` | RSP `GET /api/v1/devices?hostname=...` / `GET /api/v1/devices/{id}/summary` | 読取 |
| `create_remote_session` | RSP `POST /api/v1/remote-sessions`（view=desktop/terminal） | B さん確認後 |
| `queue_command` | RSP `POST /api/v1/devices/{id}/commands` | B さん確認後、RSP が分類 |
| `get_command_result` | RSP `GET /api/v1/devices/{id}/commands/{log_id}` | 読取 |
| `record_to_report` | AI HelpDesk の最終報告書 | 書込（監査） |

- AI に MeshCentral の管理者資格情報や RSP のサービスキーを**渡さない**。
- AI は AI HelpDesk サーバーのツールだけを呼び、サーバーが RSP への認証・監査を担う。
- CLI/シェルを直接実行するツールは作らない。

### 3-3. 同意・監査

1. A さんの遠隔支援同意（既存 `c.remote`）と、RSP のセッション（attended）を対応付ける。
2. B さんの操作は RSP の Entra ID/RBAC で認可する。AI HelpDesk の Cloudflare Access とは別。
3. AI の提案、B さんの承認、RSP の `session_id` / `command_log_id`、結果を最終報告書に載せる。
4. 危険コマンドは RSP の `hold_dangerous_for_approval` に従う（AI 提案でも迂回しない）。
5. MeshCentral の画面録画・セッション記録の保持期間を決める。

## 4. 認証方式の選択肢

| 方式 | 長所 | 短所 | 推奨 |
|---|---|---|---|
| **A. ディープリンク + RSP ログイン** | 実装が小さい。Entra トークンを共有しない | B さんが RSP に別ログイン。端末選択の手間 | **Phase 1** |
| **B. RSP 統合 API（サービス間）** | ワンクリック。セッション ID を返せる | RSP 側に専用エンドポイントと信頼設計が必要 | **Phase 2 本命** |
| **C. RSP API トークン** | 既存の API トークンで呼べる | 監査上の操作者がトークン所有者になる（B さんでない） | 非推奨 |
| **D. MeshCentral を直接呼ぶ** | 最短 | RSP のセッション監査・承認を迂回。cookie key の共有が必要 | 非推奨 |

### 4-1. Phase 1（小さく始める）

- **AI HelpDesk の B さん画面に「MeshCentralを開く」「RSPで開く」を追加済み（2026-10-24）。**
  設定は `MESHCENTRAL_URL` / `RSP_BASE_URL`（既定は `https://mesh.mirai-remotetools.com/` / `https://rsp.mirai-remotetools.com/`）。
- AI HelpDesk に `RSP_BASE_URL`（例: `https://rsp.mirai-remotetools.com`）を設定。
- B さんの STEP 5 に「RSPで開く」を追加。RSP WebUI で端末を検索し、既存の
  「MeshAgent接続」「MeshAgentターミナル接続」を使う。
- RSP WebUI に `?hostname=<hostname>` のディープリンクを追加できれば、端末検索を省略できる
  （RSP 側の小さな改修）。
- AI は「GUI 手順 / PowerShell 案」を返すだけ。実行は B さんが RSP で行う。

### 4-2. Phase 2（RSP 統合 API）

RSP に次のような**専用の統合エンドポイント**を追加します（PC-Ops 用サービスキーの流用はしない）。

```
POST /api/v1/integrations/ai-helpdesk/remote-session
  X-AIHD-Service-Key: <AI HelpDesk 専用キー>
  body: { hostname, view: "desktop"|"terminal", operator_email, case_id, reason }
  → { session_id, remote_url, expires_at }
```

- RSP は `operator_email` が Remote Operator/Support Desk ロールであることを確認する
  （AI HelpDesk の Access メールと RSP の Entra ユーザーの対応表が必要）。
- RSP は `RemoteSession` を作成し、`remote_url`（SSO 付き）を返す。
- AI HelpDesk は `session_id` をケースに保存し、最終報告書に載せる。
- 失敗時は「RSP で手動ログイン」にフォールバックする。

### 4-3. Phase 3（AI 承認付きコマンド実行）

- AI が `queue_command` を提案 → B さんが内容・リスク・理由を確認 → AI HelpDesk が
  RSP `POST /api/v1/devices/{id}/commands` を呼ぶ。
- RSP の `command_classifier` が safe/caution/dangerous を判定。
  dangerous は RSP の承認フローへ。AI は承認を代行しない。
- 実行結果を AI HelpDesk に戻し、ケースと最終報告書へ。
- 最初は**読み取り専用の許可リスト**（`Get-Service`, `Get-Printer`, `Get-Process` など）に限定し、
  書き込み系は B さんの手動実行から始める。

## 5. 端末マッピング（最重要）

AI HelpDesk の PC 情報と RSP の端末を**推測で結ばない**。

| キー | AI HelpDesk | RSP | Mirai-Info |
|---|---|---|---|
| コンピュータ名 / 管理番号 | 端末エージェントの `hostname` | `devices.hostname` | `devices.asset_tag` |
| ブラウザ端末ID | `WEB-XXXXXXXX`（`device_inventories.device_id`） | 対応なし | 対応なし |
| 利用者 | プロフィール / 名簿 | `devices.user_name` | `owner_name` |

- **端末エージェントの `hostname`** を第一キーにする。ブラウザの `WEB-...` は RSP と対応しない。
- 完全一致（大文字小文字・前後空白の正規化）で 1 件に決まる場合だけ自動リンクする。
- 0 件・複数件は B さんに選択させる。A さんの氏名・端末名を画面に出して確認する。
- 一致しないまま「RSPで開く」を押させない（誤った端末の操作を防ぐ）。

Mirai-Info の `/api/meshagent-gap` は、対象端末が「未導入 / 展開待ち / 導入済み」かを
非 PII で返します。B さんの画面にこの状態を表示し、未導入なら RSP の導通確認→展開ウィザードへ
誘導するのが自然です。

## 6. Mirai-Info 側でやること / やらないこと

### やること

- 母集団・住所・WinRM 導通・未導入ギャップの正本を維持する。
- `/api/meshagent-gap` で RSP に作業キューを渡す（既存）。
- RSP からの展開証跡（`remote_agent_states` / `audit_events` / `meshagent_deploy_attempts`）を受け取る（既存）。
- AI HelpDesk に「この端末は MeshAgent 未導入」などの状態を非 PII で提供する（必要なら read API を追加）。

### やらないこと

- MeshCentral サーバー/エージェントの運用。
- WinRM による MeshAgent のインストール・再構成（RSP の唯一の実行責務）。
- 任意の PowerShell 実行・画面転送。
- RSP のセッション/コマンド監査の代替。

> もし「Mirai-Info から MeshAgent を入れたい」場合は、Mirai-Info が **RSP の展開 API を呼ぶ**
> （または RSP がハブのギャップを巡回する）形にしてください。Mirai-Info に 2 本目の WinRM
> 実行者を置くと、`devices.mesh_deploy_*` の writer が二重になり、役割境界が崩れます。

## 7. リスクと対策

| リスク | 内容 | 対策 |
|---|---|---|
| 誤った端末の操作 | 同名・IP 相違・資産タグの揺れ | hostname/asset の完全一致、0/複数件は手動選択、A さん名と端末名の同時表示 |
| AI の誤コマンド | 幻覚・危険な PowerShell | AI は提案のみ。RSP の分類/承認。読み取り許可リストから開始 |
| 権限の二重化 | AI HelpDesk と RSP のロール不一致 | B さんの Entra ロールを RSP で確認。AI HelpDesk は同意と監査に専念 |
| 監査の分断 | 2 システムのログ | `case_id` / `session_id` / `command_log_id` を相互参照。最終報告書に載せる |
| 画面録画の機密 | 録画に個人情報 | 保持期間・閲覧権限・暗号化を決定 |
| Mirai-Info の PII | 名簿・貸与者名 | AI へ送らない。件数・状態のみ。伏せ字化 |
| RSP の高価値標的 | MeshCentral/RSP 侵害 | Entra MFA、端末グループ、最小権限、閉域、パッチ、録画 |

## 8. 実装ロードマップ

| Phase | 内容 | 期間目安 | 前提 |
|---|---|---|---|
| 0 | 本書の合意、端末マッピングの決定、RSP の MeshCentral 稼働確認 | 1 日 | RSP の配備状況 |
| 1 | AI HelpDesk に `RSP_BASE_URL` と「RSPで開く」、AI の GUI/PowerShell 手順提案（実行なし） | 1〜2 日 | なし |
| 2 | RSP 統合 API + 端末マッピング + セッション作成（GUI/PowerShell） | 3〜5 日 | RSP の API 追加、Entra/AI HelpDesk の対応表 |
| 3 | AI 承認付きコマンド実行（RSP command queue）、最終報告書へ反映 | 3〜5 日 | RSP のコマンド API、許可リスト、承認フロー |
| 4 | 画面録画・保持・監査 SIEM 連携 | 運用次第 | 録画基盤 |

## 9. 決定が必要な事項

1. **RSP 連携の認証**: Phase 1 のディープリンクで始めるか、Phase 2 の統合 API を先に作るか。
2. **端末マッピング**: 端末エージェントの `hostname` を正とするか、Mirai-Info の `asset_tag` を正とするか
   （推奨: hostname を第一、asset_tag を確認用）。
3. **RSP のロール**: B さん（DX推進部）に Remote Operator を付与する範囲。全社一括にしない。
4. **AI の実行権限**: 読み取り専用の許可リストから始め、書き込み系は B さんの手動実行にするか。
5. **画面録画**: 必須にするか。保存先・保持期間・閲覧権限。
6. **AI に渡すデータ**: ケース本文・共有PC情報・RSP の端末状態までか。Mirai-Info の PII は渡さない。

## 10. 回答（要約）

- **Mirai-Info で MeshCentral Agent を操作するのではなく、RSP の既存機能を使ってください。**
  RSP には MeshCentral の GUI/ターミナル、SSO、セッション監査、WinRM 展開、コマンドキューが
  すでにあります。Mirai-Info は母集団・住所・ギャップの正本に徹するのが正しい分担です。
- **Mirai-Info 側に WinRM を追加して MeshAgent を入れるのは二重実行になり、非推奨**です。
  展開は RSP の唯一の責務（`meshagent-deploy-role-boundaries.md`）。Mirai-Info から起動したいなら
  RSP の展開 API/キューを呼んでください。
- **AI 画面（Claude Cowork 風）は実現可能**です。ただし AI に任意のシェルを渡さず、
  「AI が提案 → B さんが確認 → RSP が分類・実行・監査」の順にしてください。
  GUI は MeshCentral、PowerShell は RSP のターミナル/コマンドキュー、AI は手順とコマンドの提案、
  最終報告書は AI HelpDesk が束ねる、という分担が最も安全で実用的です。
