# 本番デプロイ後スモーク S5 — RSP 実行セッション（2026-10-27）

- 実施: 11:11〜11:15 JST
- 対象: RSP `https://rsp.mirai-remotetools.com/`（API :8130）→ HelpDesk `:18949`/`:18950`（本番・commit 804295c）
- 案件: **CASE-39194**（【検証20261027】VPNに接続できない（スモーク）／引継ぎ `6529a1a5…`）
- 認証: RSP の**ローカルログイン**（非対話）で 8h セッションを取得。Access ログインではない。
- 手段: RSP の AI支援 API（`/api/v1/helpdesk/*`）を実サーバに対して実行。**UI パネルが呼ぶのと同じ経路**（RSP は本文をそのまま HelpDesk `/api/terminal/*` へ中継する）。
- 秘密: 資格情報は実行後に削除。パスワード・トークンは本証跡に記載しない。

## 判定: **PASS**

| 観点 | 実測 |
|---|---|
| セッション開始 | `POST /api/v1/helpdesk/sessions` → **200**。`session 689cce06…` / `status=active` / `operatorEmail=owner@***`（正規化済み）/ TTL 15 分 |
| AI 提案 | `POST /sessions/{id}/steps` → **200**。`step 64371d3a…`、`aiModel=deepseek-flash`、提案コマンド `Get-VpnConnection \| Select-Object Name, ServerAddress, ConnectionStatus, TunnelType, AuthenticationMethod \| Format-Table -AutoSize`（risk=low・purpose/verify/rollback/warnings 付き） |
| 実行記録 | `POST /steps/{id}/record` → **200**。`exitStatus=success` / `outputSource=manual` / `sha256=fcd7f855…` / `recordedAt` 記録 |
| セッション終了 | `POST /sessions/{id}/close`（reason=resolved） → **200**。`status=closed` |
| 報告書作成 | `POST /sessions/{id}/report` → **200**（warnings 0）。`final_reports` に `id=3b9770ef… / kind=helpdesk_resolved / sha256=f435c7b4…`（session.report.sha256 と一致） |
| 報告書 HTML（RSP 経由） | `GET /api/v1/helpdesk/reports/3b9770ef…/html` → **200 text/html 20,901 bytes**。**「RSP実行セッション」2 箇所・提案コマンド 3 箇所・実行結果 `Disconnected` 3 箇所・「実行記録」1 箇所** を確認＝**報告書へ反映** |
| DB 突合 | `terminal_sessions`: `status=closed` / `operator_email` / `report_id=3b9770ef…`。`terminal_steps`: `seq=1` / `recorded_at` あり / `output_source=manual` / `exit_status=success` |
| 監査 | `audit_log` に `terminal.session.start` / `terminal.step.propose` / `terminal.step.record` / `terminal.session.close` / `terminal.report.build` が各1行、`detail.actorEmail` = 操作者（owner） |

## 参考: 失敗した試行と所見

1. **1回目**: intent を「VPN エラー691 の切り分け手順」にしたところ、AI は「対象 PC の情報が足りないため安全に実行できる単一コマンドを特定できない」と**妥当に拒否**。しかし HelpDesk はこれを **502 `AI_UNAVAILABLE`** として返し、拒否理由の全文をエラーメッセージに埋め込んだ（UI ではエラー表示になる）。→ **SM-06（Medium）**: 「AI が提案を辞退した」と「AI 障害」を区別できない。
2. **2回目**: セッションを開始し、記録なしで close → report は **409 `NO_RECORDED_STEPS`**（設計どおり）。ただしパネル側で close 前に警告しない。→ **SM-07（Low）**。
3. `rsp_command` の相関（`rspCommandLogId`）は、実コマンドキューを実行していないため未使用（`outputSource=manual`）。**Phase 2 の自動取込は未検証**（RSP のコマンドキューに実ジョブを流す必要がある）。
4. `session.rspSessionId` は null（この経路では RSP の remote_session を作らないため）。相互参照を埋めるには RSP 側で MeshCentral セッションを開始して ID を渡す実装・運用が必要。

## UI について（正直な範囲）

- AI支援パネル自体は前回スモーク（`smoke-S3-S4.md`）で**描画と画面遷移を実ブラウザで確認済み**。
- 今回のブラウザは headless（画面なし）で対話サインインができないため、**UI のクリック操作ではなく API 契約**で S5 を実測した。パネルはこの API をそのまま呼ぶため機能経路は同一だが、「UI の見た目・トースト」は今回の範囲外。

## 後始末

- RSP の資格情報ファイル（`~/.config/rsp/local-login.*`）と一時トークンは**削除済み**。リポジトリへの混入なし（`git status` clean）。
- CASE-39194 の引継ぎは S5 のため一時 `resolved` に戻し、**完了後に `completed` へ復元**した（実測）。
- 追加の本番案件・ナレッジは作成していない（報告書 `3b9770ef…` のみ追加、テスト案件に紐づく）。
