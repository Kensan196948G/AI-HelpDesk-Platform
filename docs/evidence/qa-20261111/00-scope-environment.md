# QA スコープ・実行環境の宣言（2026-11-11 JST）

- 作成: 2026-11-11T04:25:08+09:00
- 対象 commit: `7573784`（`git rev-parse --short HEAD` で確認）
- 作業ブランチ: `qa/qa-workbench-20261111`（`main` から作成。既定ブランチへ直接書かない）
- 指示: QA Workbench 実行指示（2026-11-11）§1〜§7

## 1. 対象（A〜D）

| 区分 | 内容 | 主な出典 |
|---|---|---|
| A | 受入 32 項目（特に現況 ⏸ の #2/#5/#6/#7/#8/#9/#17/#20/#21） | `docs/11-acceptance.md`（2026-11-10 追記が現況） |
| B | 直近変更の回帰（PR #156 / #157 / #158）: `dist-manifest --verify --root`、proxy unit の `Wants=` 削除、`set-smtp-password` の再起動対象、`install-proxy-service.sh` の health ゲート | `docs/89` §3、`docs/91` |
| C | 証拠が無い 3 項目の取得: 受入 #6 Empty / #7 Loading / #8 Input Error（UI） | `docs/11` 2026-11-10 追記 |
| D | 高リスク領域: 認証・権限（サーバ側判定）、PII 伏せ字、監査ハッシュ鎖、解決ループ（`/api/resolve/*`） | `docs/01` §4/§8、`docs/05` §6-4、`docs/07` §3/§4/§6、`docs/25` |

## 2. 除外（NOT-RUN / BLOCKED として記録する）

| 除外 | 理由 | 必要な人間の操作 |
|---|---|---|
| 実 Cloudflare Access の OTP ログイン後の画面・API 確認（docs/85 C-3 / U-1） | 人間の OTP が必要。自動化不可 | ブラウザで OTP ログインし、主要画面と認証後 API を確認 |
| 実 Windows 端末・実貸与・実社員・別人物承認（Issue #121） | 実機・実人が必要 | 実機・実人での受入 |
| 本番 DB への書込み、本番/staging への配備 | 破壊的・環境変更 | 人間の承認と実施 |
| systemd の start/stop/restart/daemon-reload/enable/mask | 指示で禁止 | 人間が保守ウィンドウで実施 |
| Cloudflare の変更、課金・契約 | 指示で禁止 | — |
| 本番公開 URL への操作（Access 保護） | 自動化不可 | 人間が実施 |

## 3. 実行環境（計画）

| 項目 | 値 |
|---|---|
| commit | `7573784` |
| 認証モード | `AUTH_MODE=local`（合成データ） |
| テスト DB | `aihd_test_qa_20261111`（新規作成。既存 `ai_helpdesk_test` は使わない） |
| E2E DB | `aihd_test_qa_20261111_e2e`（`_e2e` 終端） |
| アプリ port | 既存 18950/18951/18952 と衝突させない（検証用に別 port を確保） |
| E2E port | 19401〜19408 固定（並列実行しない） |
| 出力 | `docs/evidence/qa-20261111/`、QA artifactRoot にも控え |
| 認証情報 | `.env*` の値はログ・ケース・証跡へ書かない |

## 4. 証跡ルール

- 命名: `<phase>-<ID>-<YYYYMMDDTHHMMSS>.<ext>`
- 各証跡: 実行コマンド、exit code、出力の要点、環境（commit / DB 名 / port / `AUTH_MODE`）、実行時刻（JST）
- PII・Secret は伏せ字。実名入りスクリーンショットはリポジトリへ追加しない
- 書込みは `docs/evidence/` と QA レポートのみ（製品コード・設定・migration・`.env`・unit ファイルは変更しない）

## 5. 未確定事項（実行前に確認）

| # | 事項 | 状態 |
|---|---|---|
| U1 | 検証用 PostgreSQL への接続資格情報と DB 作成手段 | 未確認（値を記録しない） |
| U2 | `playwright-core` の解決パス（package.json 未宣言） | 未確認（`PLAYWRIGHT_CORE_PATH` 候補を探索） |
| U3 | 検証用 API の空き port | 未確定（衝突確認後に決定） |
