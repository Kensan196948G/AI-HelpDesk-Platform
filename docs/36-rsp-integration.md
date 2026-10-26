# RSP ⇄ HelpDesk 連携（AI支援コンソール）設計・API契約

| 項目 | 値 |
|---|---|
| 版 | v0.1（2026-10-26 合意） |
| 目的 | RSP WebUI に「AI支援」パネルを追加し、案件・PC情報・AI提案・実行記録・解決後処理を1画面で行う |
| 決定 | RSP＝実行・端末・監査、HelpDesk＝案件・AI・引継ぎ・報告書・ナレッジ。サーバ間は localhost で接続 |
| 禁止 | サーバが勝手にコマンドを実行しない（人間承認が前提）。秘密・出力本文をログに出さない |

## 1. 全体構成

```
[担当者ブラウザ]
  ├─ RSP WebUI (rsp.mirai-remotetools.com)  ← AI支援パネル（新設）
  │     └─ 同一オリジン → RSP API /api/v1/helpdesk/*（新設プロキシ）
  │            └─ loopback + サービストークン → HelpDesk API /api/terminal/*
  └─ HelpDesk (ai-helpdesk.mirai-dx-platform.com) ← 案件・AI・報告書・ナレッジ
```

- RSP API `127.0.0.1:8130` / HelpDesk API `127.0.0.1:18950` / MeshCentral `127.0.0.1:4430` は同一ホスト。
- ブラウザから HelpDesk を直接呼ばない（CORS・Access Cookie の越境を避ける）。RSP の同一オリジン API のみ使う。

## 2. 認証（HelpDesk 側）

### 2-1. 統合リクエストの条件（すべて満たす）

1. 送信元ソケットが loopback（`127.0.0.1` / `::1` / `::ffff:127.0.0.1`）
2. `X-Helpdesk-Service-Key` が `RSP_INTEGRATION_KEY`（32文字以上）と一致（constant-time）
3. `X-Operator-Email` がメール形式
4. `AUTH_MODE=cloudflare-access` のとき、`X-Operator-Email` が `docs/MailAddress.txt` の許可リストに一致

- `RSP_INTEGRATION_KEY` 未設定・32文字未満のときは統合経路を**無効**（統合ヘッダー付きは 401）。
- 統合ヘッダーが無いリクエストは従来の `authenticateUi`（Access）にフォールバックする。
- 統合ヘッダーが**あるのに不正**な場合はフォールバックせず 401/403（曖昧にしない）。

### 2-2. 適用範囲

- **`/api/terminal/*` のみ**。他の API は従来どおり Access 認証。
- 成功時: `request.uiEmail = canonicalEmail(operator)`、`request.loginEmail = operator`、`request.integration = 'rsp'`。
- 監査: `terminal.*` の detail に `via: 'rsp'` と `operatorEmail` を残す。

### 2-3. 環境変数

| 変数 | 内容 |
|---|---|
| `RSP_INTEGRATION_KEY` | RSP からの統合用キー（32文字以上）。未設定なら統合経路は無効（401）。短い値は起動時に拒否 |

- 送信元は **loopback 固定**（CIDR の追加指定は未実装）。RSP と HelpDesk は同一ホストで動かす前提。

## 3. HelpDesk 側の API（`/api/terminal/*`）

既存のセッション API をそのまま使う（契約は [35-terminal-session.md](35-terminal-session.md) §4）。

| Method | Path | 内容 |
|---|---|---|
| GET | `/api/terminal/context?caseId=` | 案件・依頼者・引継ぎ・PC情報・最新セッション（新設） |
| GET | `/api/terminal/cases?hostname=&limit=` | 担当者が claim した案件の一覧（新設。RSP の端末から案件を探す用） |
| GET | `/api/terminal/sessions?caseId=` | 最新セッション＋ステップ（既存） |
| POST | `/api/terminal/sessions` | セッション作成（既存） |
| GET | `/api/terminal/sessions/:id` | セッション取得（既存） |
| POST | `/api/terminal/sessions/:id/steps` | AI提案（既存） |
| POST | `/api/terminal/steps/:id/record` | 実行記録（既存） |
| POST | `/api/terminal/sessions/:id/close` | 終了（既存） |
| POST | `/api/terminal/sessions/:id/report` | 報告書作成（既存） |
| POST | `/api/terminal/sessions/:id/knowledge-draft` | ナレッジ下書き（既存） |
| GET | `/api/reports/final/:id/html` | 報告書HTML（`authenticateTerminal`。作成者本人のみ） |
| GET | `/api/reports/final/:id/pdf` | 報告書PDF（同上） |

### 3-1. `GET /api/terminal/context`

```json
{
  "ok": true,
  "case": {
    "id": "CASE-UI-TERM-3",
    "subject": "プリンタで印刷できない",
    "body": "印刷キューが止まっています。",
    "category": "device",
    "categoryLabel": "PC・周辺機器",
    "urgency": "urgent",
    "createdAt": "2026-10-26T00:00:00.000Z"
  },
  "requester": { "email": "requester@example.com", "name": "山田 太郎" },
  "handover": {
    "id": "uuid",
    "status": "claimed",
    "claimedBy": "helpdesk@example.com",
    "ownerEmail": "requester@example.com",
    "device": "MRK-NB-1000"
  },
  "pc": {
    "available": true,
    "device": "MRK-NB-1000",
    "collectedAt": "2026-10-26T00:10:00.000Z",
    "itemCount": 35,
    "flags": [{ "grp": "周辺機器", "k": "印刷スプーラ", "v": "停止", "lv": "ng", "note": "", "rel": false }],
    "items": [{ "grp": "端末", "k": "機種", "v": "標準機", "lv": "ok" }]
  },
  "session": { "...": "SessionDTO（[35] §3）または null" }
}
```

- `caseId` は cowork の案件IDのほか、スナップショットの `inc.id` / `ticket.id`
  （画面に出る `INC-xxxx` / `TKT-xxxx`）でも引ける。
- PC情報の IP・シリアル・資産番号は **マスク**して返す（項目名で判定）。
- `session` は最新の RSP 実行セッション（無ければ null）。

### 3-2. `GET /api/terminal/cases?hostname=&limit=`

```json
{
  "ok": true,
  "items": [
    {
      "caseId": "CASE-UI-TERM-3",
      "subject": "プリンタで印刷できない",
      "requesterEmail": "requester@example.com",
      "device": "MRK-NB-1000",
      "handoverId": "uuid",
      "handoverStatus": "claimed",
      "claimedBy": "helpdesk@example.com",
      "updatedAt": "2026-10-26T01:00:00.000Z",
      "session": { "id": "uuid", "status": "active" }
    }
  ]
}
```

- 対象: `claimed_by = operator` かつ status が `claimed` / `resolved` の引継ぎ。
- `hostname` 指定時はスナップショットの `case.pc.snap.device`（大文字小文字無視）で絞る。
- 並び: 更新の新しい順。`limit` 既定 20・最大 50。

## 4. RSP 側の API（`/api/v1/helpdesk/*`）

すべて `require_operator`（RSP の JWT ロール）。以下のパスを HelpDesk へ中継する。

| Method | RSP パス | 転送先 |
|---|---|---|
| GET | `/api/v1/helpdesk/context?caseId=` | `/api/terminal/context` |
| GET | `/api/v1/helpdesk/cases?hostname=` | `/api/terminal/cases` |
| GET | `/api/v1/helpdesk/sessions?caseId=` | `/api/terminal/sessions` |
| POST | `/api/v1/helpdesk/sessions` | `/api/terminal/sessions` |
| GET | `/api/v1/helpdesk/sessions/{id}` | `/api/terminal/sessions/{id}` |
| POST | `/api/v1/helpdesk/sessions/{id}/steps` | 同名 |
| POST | `/api/v1/helpdesk/steps/{id}/record` | 同名 |
| POST | `/api/v1/helpdesk/sessions/{id}/close` | 同名 |
| POST | `/api/v1/helpdesk/sessions/{id}/report` | 同名 |
| POST | `/api/v1/helpdesk/sessions/{id}/knowledge-draft` | 同名 |

- リクエストヘッダー: `X-Helpdesk-Service-Key`、`X-Operator-Email`。
- 報告書の返却 URL は HelpDesk 相対のため、RSP プロキシが
  `/api/v1/helpdesk/reports/{id}/html|pdf` に**書き換えて**返す。
  同エンドポイントが HelpDesk の `/api/reports/final/{id}/html|pdf` を中継する
  （作成者本人の報告書だけ。`Content-Disposition` はそのまま通す）。
- ボディは JSON をそのまま転送。2xx はそのまま返す。エラーは `{detail:{code,message}}` に正規化して同じ HTTP ステータスで返す。
- タイムアウト 15 秒。POST は再試行しない。GET は 1 回だけ再試行可。
- ログ: `caseId`・ステータス・所要時間のみ。**キー・コマンド・出力はログに書かない**。

### 4-1. 設定（RSP）

| 変数 | 既定 | 内容 |
|---|---|---|
| `HELPDESK_BASE_URL` | `http://127.0.0.1:18950` | HelpDesk API |
| `HELPDESK_SERVICE_KEY` | 空 | 未設定なら AI支援パネルは「未設定」表示（fail-closed） |
| `HELPDESK_OPERATOR_ALIASES` | 空 | `entra@example.com=access@example.com` 形式（カンマ区切り）。RSP の operator と HelpDesk の email が異なる場合に使う |

## 5. RSP WebUI（追加のみ）

- 左ナビに「AI支援」を追加（`data-view="helpdesk"`）。**既存ビューのDOM/CSSは変更しない**。
- 画面構成:
  - 上部: 案件ID入力＋「読み込み」。`?helpdeskCase=...&hostname=...` のディープリンクで自動読込。
  - 左: 案件概要・依頼者・対象端末・引継ぎ状態。
  - 中央: 目的入力→「AIに次の一手」→提案（コマンド・risk・確認・戻し・警告）＋コピー。
    実行記録フォーム（実行コマンド・出力・判定・補足）→記録。ステップ一覧。
  - 右: 対象PC情報（読み取り専用・マスク済み）。「RSPコンソールを開く」。
  - 下部: セッション開始（同意）／解決として終了／中止／報告書／ナレッジ下書き。
- 実行は Phase 0 では**手動**（MeshCentral ターミナルへ貼り付け、出力を記録）。
  Phase 2 で既存の W23 コマンド実行（出力自動取込）を接続する。
- HelpDesk 側の `?helpdeskCase=` ディープリンクは 3ペインの「RSPで支援」ボタンから開く（Phase 3）。

## 6. セキュリティ・監査

- 統合キーは RSP のサーバ側だけが保持する（ブラウザに返さない）。`.env` は 600。
- RSP の operator 身元は JWT から取得し、`X-Operator-Email` にマッピングして送る。
  HelpDesk は `claimed_by` と照合するため、**他人の案件は操作できない**。
- 二重監査: RSP（セッション・コマンド）と HelpDesk（AI提案・実行記録・報告書）の両方に残す。
  相関ID: HelpDesk の `terminal_sessions.id` と RSP の `remote_sessions.id` を相互参照（Phase 2）。
- AI 提案の実行は人間の確認が必須。サーバはコマンドを実行しない。
  将来の自動実行は RSP のリスク判定・承認・監査を通す。

## 7. フェーズ

| Phase | 内容 | 状態 |
|---|---|---|
| 0 | HelpDesk 統合API（context/cases）＋ RSP プロキシ ＋ RSP WebUI 読み取りパネル（案件・PC情報） | 実装中 |
| 1 | AI提案・実行記録・終了・報告書・ナレッジ下書き（手動実行） | Phase 0 の直後 |
| 2 | RSP のコマンド実行（W23）と接続し、出力を自動取込 | Phase 1 の後 |
| 3 | HelpDesk 3ペインからのディープリンク、監査相関、ロール調整 | Phase 2 の後 |
| 4 | （任意）MeshCentral のターミナルログ取得 | 法務・同意次第 |
