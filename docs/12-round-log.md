# Round Log（Goal 自動継続）

対象: Mirai AI HelpDesk Platform MVP / 2026-10-23

## Round 1 — 基盤・設計・実装

- 初動 Assessment、MVP Scope、Planning を文書化。
- OpenDesign プロジェクト作成・artifact v3（design board）作成、linter P0/P2 0。
- Local PostgreSQL（`ai_helpdesk_mvp` / `ai_helpdesk_test`）作成、Migration / Seed 実装。
- Fastify API 実装（認証・案件・AI・引継ぎ・担当・解決・ナレッジ・監査）。
- Unit 24 + Integration 3 = 27 tests 成功。
- PR #1 作成。Blocker Issue #2 作成。
- Debug: jsonb の文字列返却、監査検証の正規化、採番の切り詰め・再 Seed 衝突を修正。

## Round 2 — 追加検証

- 追加 Integration 5 件（AI 解決、差戻し→修正→再申請→承認、ログアウト、health/dashboard/権限、入力検証）。
- Worker プロキシのテスト 4 件（CSP、共有秘密、502、SPA fallback）。
- **36 tests 成功**（Unit 28 / Integration 8）。
- Fastify の非推奨オプション警告を解消。
- PR #1 を更新。

## Round 3 — 最終確認・Blocker 判定

- TypeCheck / Lint / Test / Build / Secret scan / npm audit を再実行し、すべて成功。
- Backup / Restore を実測（PG16 `pg_dump` → 新規 DB、件数一致）。
- WebUI は **Y/N 未回答のため未実装**。
- CI / Cloudflare Preview は **policy gate により未実施**。
- 同一 Blocker が 3 ラウンド継続したため、Goal を blocked として報告。

## Round 4 — ユーザー指示による UI/認証/配備の変更

- WebUI を既存プロトタイプ HTML の 100% 配信に変更。
- Cloudflare Access（OTP / 12h / 指定メール）を唯一のログインに変更。
- Cloudflare Tunnel + Access で `ai-helpdesk.mirai-dx-platform.com` を公開。
- DeepSeek API の自由記述回答、`prototype_states` への状態保存を追加。
- 41 tests 成功。Access ログイン画面・公開 URL 302 を確認。
- 残: Access 許可メール、DeepSeek API キー、全 STEP E2E、CI。

## Round 5 — アクセス制御のファイル化（2026-10-23）

- ユーザー提供の `docs/MailAddress.txt` を許可リストの正本にした。
  - `kensan1969@gmail.com`（完全一致）/ `@mirai-const.co.jp`（ドメイン）。
  - `例：` 以降の例示（`k-aritoh@mirai-ocnst.co.jp` の typo）は許可しない。
- Cloudflare Access アプリ `Mirai AI HelpDesk MVP` に allow ポリシーを適用（`kensan1969@gmail.com` / `@mirai-const.co.jp`）。
- Node API 側も同じ許可リストを照合（`ACCESS_ALLOWLIST_FILE`）。ファイルなし・空は全拒否（fail-closed）。
  `ACCESS_ALLOWED_EMAIL` は非推奨化。
- `AUTH_MODE=cloudflare-access` では `/api/health` 以外の全リクエストで許可リストを照合。
- **59 tests 成功**（許可リスト解析 11 / Access 認証 8 を含む）。
- OTP 実ログインを 2026-10-23 15:32 JST に確認（Cloudflare Access ログ: `onetimepin` / `allowed=true`）。
- 残: 全 STEP E2E、CI。

## Round 6 — 実PC情報・端末エージェント・DeepSeek V4.1（2026-10-23）

- ブラウザから実PC情報（OS / 画面 / CPU コア / 推定メモリ / GPU / 回線 / 音声）を取得し、`device_inventories` に保存。
- 読み取り専用エージェント（Windows / macOS / Linux）を追加。ハードウェア・導入ソフト・セキュリティ状態を `POST /api/device/agent` で送信。
- 既存プロトタイプの `pcSnapshot()` を差し替え、35 項目の実スナップショットを表示（DOM / CSS は変更なし）。
- AI コンテキストに PC 情報を追加。IP・シリアル・資産番号・メールは除外。
- DeepSeek を `deepseek-flash`（DeepSeek-V4.1-Flash、`thinking: disabled`）へ更新。
- 端末エージェント用に `/api/device/agent` のパス限定 Access bypass + デバイストークン（SHA-256 / 0600 / IP 30回/分）を実装。
- 実測: ブラウザ 35 項目 / エージェント 300 ソフト / AI が 16GB・8 コアを回答に反映 / 公開エージェント経路 200。
- **74 tests 成功**（17 files）。端末は `device_id` 単位で分離し、未リンク agent はブラウザを上書きしない。
- Windows 向けに Node 不要の PowerShell CLI + ログオン/60分タスク（常駐なし）を追加。構文・`-DryRun`・API送信（35項目）を Linux pwsh で検証。
- AI用の承認済みKBを5件追加（PC性能 / Windows Update / BitLocker / Defender / ソフト導入）。KB検索は専門キーワード一致を優先するよう修正。
- 実測: Windows 11 Pro / i5-9500 / 31.8GB / 273ソフトの実PC情報を根拠に、KB-2026-0005/0006/0007/0008 の一次切り分け手順をAIが返す。
- 実測: Windows実機で CIM / Defender / 273ソフトを取得。BitLocker はタスク実行ユーザー権限で未検出のため、`-Elevated` 再登録を残対応とする。
- 残: 全 STEP E2E、BitLockerの`-Elevated`再登録、GPO/Intune 配布、CI。

## Round 7 — PC基本情報の表示（2026-10-23）

- 指摘: 「PC基本情報（事前取得）」に未記載（空欄・「未取得」）を残さない。資産番号は「コンピュータ名」に置き換える。
- 端末グループの先頭を `資産番号` から `コンピュータ名` に変更（値は端末エージェントの `hostname`。未導入時は `未検出（ブラウザ）`）。
- 取得できない値は「未取得」で止めず、`なし` / `端末エージェント未導入` / `未検出` / `未検出（ブラウザ）` で表示し、note も状態に合わせて分岐する。
- ブラウザのみのローカル取得（device-bridge）も同じ表記に統一。
- 保存済みの旧スナップショット（「資産番号」行・「未取得」を含む）は、次回ロード時に現在の端末情報へ移行する（差分は「前回から変わった点」に残す）。
- 引継ぎメモの「対象の機器」もコンピュータ名を使う（旧 `asset_no` は読み取り互換を維持）。
- **75 tests 成功**（+1: 表示に空欄・「未取得」を残さない）。

## 現在の Evidence

| 項目 | 結果 |
|---|---|
| Tests | 75 passed（17 files） |
| TypeCheck | 成功 |
| Lint | 成功（warning 27 / error 0） |
| Build | 成功 |
| Secret scan | 検出なし |
| npm audit（runtime） | 0 vulnerabilities |
| DB | migrate / seed / 再実行 / Read-Write / Backup-Restore |
| API | 主要 3 Flow、セキュリティ、権限、監査 |
| Access | allow ポリシー + アプリ許可リスト（fail-closed）+ OTP 実ログイン + エージェント用 bypass |
| PC情報 | ブラウザ 35 項目 / エージェント 300 ソフト / 端末単位マージ / コンピュータ名表示・未記載なし |
| AI | `deepseek-flash`（V4.1-Flash）/ PC 情報を回答に反映 |
| PR | #1 OPEN（mergeable、Required Checks なし） |
| OpenDesign | artifact v3 / linter P0 0 |

## 未達（理由）

1. UI の全 STEP E2E、Preview API/DB の公開経路での直接確認が未実施。
2. 端末エージェントの対象PCへの配布・定期実行の設定が未実施（Node.js 20+ が必要）。
3. `.github/workflows/`・Cloudflare Worker 設定・配備コマンドが
   `self-evolution policy gate: DEPLOY is critical risk` で拒否される。

詳細: [13-blocked-report.md](13-blocked-report.md)
