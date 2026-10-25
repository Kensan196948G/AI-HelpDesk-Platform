# 全機能検証・修正・反映（2026-10-25）

対象: 「みらいAI窓口 × ヘルプデスク V3.1」デプロイ済みシステム
公開 URL: https://ai-helpdesk.mirai-dx-platform.com/
リポジトリ: `AI-HelpDesk-Platform`（main / 反映コミット `030027d`）
実施: 2026-10-25 09:44〜11:35 JST（Agent Team: API / UI / 基盤 / 品質の 4 検証 + 独立レビュー 2 回）

## 1. 結論

主要機能は稼働している。ただし検証で **Critical 2 件・High 4 件・Medium 3 件**を検出したため、
修正 5 PR（#31 / #32 / #33 / #35 / #37）と運用 PR #38 を作成し、CI 緑・独立レビュー後に `main` へマージした。
さらに稼働サービス（旧コード・状態破損）へ反映し、反映後の再検証まで完了した。

- 反映後の公開 URL: **正常**（Access 302 / アプリ 200 / 5xx 0）
- 稼働コード: `754a757`（`/api/health` の `commit` で確認）
- 画面状態: 欠落キーを補完し、検証用の残骸（E2E）を削除済み

## 2. 検証結果（反映前）

| 領域 | 結果 |
|---|---|
| API | エンドポイント **47/47 到達**、237 チェック中 **232 PASS**。主要フロー（案件→AI→引継ぎ→解決→ナレッジ→監査、引継ぎ、PC情報/端末コマンド、報告書 HTML/PDF、遠隔支援案内、名簿/persona、状態保存、検索、dashboard、device token）は **全 PASS** |
| AI | 実 DeepSeek `deepseek-flash`。レート制限 21 並列で 20 受理 + 1×429、注入 3 ケース拒否、PII（メール/電話/IP/カード/資産/シリアル）マスク PASS |
| UI | 34 画面を実ブラウザ巡回。**27 PASS / 7 FAIL**（修正前）。PC系・使い方質問系のフローは引継ぎ→承認→完了→報告書まで完走 |
| 公開経路 | Access 302→OTP、allow ポリシー、12h、Tunnel healthy（4 接続）、TLS1.3、DNS CNAME proxied、24h 5xx **0** |
| 品質 | **201 tests PASS**（35 files）、typecheck / lint / build / secret scan / audit / migrate 冪等 / seed 再実行 / CI 緑 |

証跡: `docs/evidence/verify-20261025/`（API / UI / 基盤 / 品質 / レビュー。スクリーンショットは実名を含むためリポジトリには追加しない）。

## 3. 検出した不具合と対応

| 重大度 | 内容 | 対応 |
|---|---|---|
| Critical | 保存状態のキー欠落で「統合の流れ」「ナレッジ検索」「AI窓口の利用状況」が白画面、STEP3 で AI 回答が停止。原因は 2026-10-23 の検証スクリプトが `EMAIL_ALIASES` の別名経由で実アカウントの状態を上書きし、復元に失敗していたこと | **PR #31**: 画面 `load()` に欠落キー補完を追加。E2E スクリプトは正規化メールを API から取得し、DB 一致確認・preview 拒否・トランザクション復元・内容一致検証を追加 |
| Critical | 依頼者以外の「操作する人」で案件を開くと `asideHtml` の TypeError で本文が空 | **PR #32**: 案件の依頼者を社員名簿から解決（`emp:MK...` / `emp:role:MK...` 両対応）、所属・端末のフォールバック表示 |
| High | 引継ぎ状態の PATCH が対象未特定時に別案件の `handoverId` へフォールバックし、404/取り違え | **PR #32**: 対象を特定できない場合は更新しない |
| High | AI・状態保存の通信断が利用者に伝わらない | **PR #32**: トースト通知（30 秒に 1 回） |
| Medium | JSONB 列が JSON 文字列で保存（`->>`/GIN が効かない二重エンコード） | **PR #32**: `sql.json()` で正しく保存。`010_jsonb_objects.sql` で既存行を変換 |
| Medium | 実在社員の「AI相談」で `TIPS[u.id].map()` が TypeError | **PR #33**: TIPS 未定義時は空リスト |
| High | 引継ぎメモの推定分野が誤り（印刷→セキュリティ）、担当者名が `MK1073（）` | **PR #35**: 旧カテゴリ名を CATS キーへ対応付け、社員番号を名簿から氏名へ解決 |
| High | 「デモ用の記入例」が案件種別と無関係で、承認ナレッジ・最終報告書まで汚染 | **PR #35**: 印刷・プリンタ・複合機・プリントを優先判定（件名または category=device のとき） |
| Medium | チケット一覧で依頼者が内部 ID（`emp:MK...`）表示 | **PR #37**: 社員名簿から「部署 氏名」へ解決（名簿外は社員番号） |
| Medium | preview DB のバックアップなし | **PR #38**: 日次バックアップ（PG16 dump・検証・14 日保持・systemd timer） |
| Medium | Access JWT を検証していない（`ACCESS_JWT_MODE=off`） | **2026-10-25 設定変更**: `report` で実 JWT の検証成功を確認後、**`enforce` へ移行**（ローカル偽ヘッダーは 401） |
| Medium | `REQUIRE_PROXY_SECRET=false`（proxy secret 未導入） | **PR #41 + 設定**: Tunnel と API の間にローカル・プロキシ（18949）を置き、秘密のない直接アクセスを **401 `PROXY_REQUIRED`** に |
| Medium | `~/.cache/uv` 9.9GB（常駐プロセスがロック） | **2026-10-25 整理**: 稼働中プロセスの archive だけ残し、未使用 1,795 件を削除（**9.9GB → 488MB**、停止不要） |
| Medium | disk 使用率 87% | **2026-10-25 整理**: npm/npx/pip/trivy/pnpm のキャッシュを削除し **82%**（約 43GB 解放） |

### 未対応（既知の課題）

| 重大度 | 内容 | 推奨 |
|---|---|---|
| Low | proxy secret の限界: 同一ユーザー権限で `api.conf` を読めるプロセスは秘密も読める | 専用ユーザー/権限分離、または Cloudflare Worker + Secret への移行 |
| Low | Playwright の旧ブラウザ・他プロジェクトのキャッシュ・/tmp に大きめの残骸 | 利用状況を確認して個別に整理（誤削除防止のため今回は未実施） |
| Low | 氏名は保存前マスクの対象外（設計は「名宛てとして保持」） | 要件と設計のどちらを正とするか決定 |
| Medium | 本番モードで MVP リレーショナル API はログイン経路がなく到達不能（設計の不一致） | 内部専用と明記、または Access 連携セッションを実装 |

## 4. 反映（デプロイ）記録

| 手順 | 実施内容 |
|---|---|
| 1 | preview DB をバックアップ: `/tmp/aihd-deploy/preview-before-deploy-20261025-112625.dump` |
| 2 | `npm run build`（main `9fee887` → 後に `030027d`） |
| 3 | `ai-helpdesk-api.service` を再起動（11:26 / 11:33、各数秒） |
| 4 | `npx tsx scripts/migrate.ts` で `010_jsonb_objects.sql` を適用（12 列を object 化） |
| 5 | 状態修復: 欠落 6 キー（`stats` / `faqCandidates` / `faqs` / `devices` / `estop` / `failNext`）を補完し、E2E 残骸（`CASE-E2E-039186` / `chat-e2e` / `TKT-E2E-1`）を削除 |
| 6 | H1/H3 修正（PR #35）を再反映（12:06、build → restart。DB 変更なし） |
| 7 | 依頼者 ID 表示の修正（PR #37）を反映（12:47、build → restart） |
| 8 | `ACCESS_JWT_MODE=report` / `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` を設定（12:47、再起動） |
| 9 | DB 日次バックアップを登録（PR #38、12:49 に手動実行 → timer 有効化） |
| 10 | `ACCESS_JWT_MODE=enforce` へ移行（12:56、再起動） |
| 11 | キャッシュ整理（npm / npx / pip / trivy / pnpm）で disk 87% → 82% |
| 12 | `PROXY_SECRET` を api.conf に設定し、`ai-helpdesk-proxy.service` を起動（13:20） |
| 13 | Tunnel ingress を `127.0.0.1:18949` へ変更し cloudflared 再起動（13:20） |
| 14 | `REQUIRE_PROXY_SECRET=true` で API 再起動（13:20） |
| 15 | 未使用の uv キャッシュを削除（chroma-mcp は停止せず、使用中 archive のみ保持。13:22） |
| 16 | 反映後に再検証（下記） |

- 状態修復前: cowork 8 キー / 案件 4（E2E 1 含む）/ チャット 5（E2E 1）/ チケット 1（E2E）/ devices 0
- 状態修復後: cowork 14 キー / 案件 3 / チャット 4 / チケット 0 / devices 11 / E2E 文字列なし
- 参考: 画面の `commit` 表示のため `~/.config/ai-helpdesk/api.conf` に `COMMIT_SHA` を追加（秘密値の変更なし）

## 5. 反映後の再検証

隔離インスタンス（`127.0.0.1:18951` / 最新 dist / 修復済み状態の DB コピー）で実ブラウザ検証:

| 画面・機能 | 結果 |
|---|---|
| 統合の流れ | 9,482 文字描画・例外 0 |
| ナレッジ検索 | 11,418 文字描画・例外 0 |
| AI窓口の利用状況 | 8,119 文字描画・例外 0 |
| AI相談 | 8,665 文字描画・例外 0 |
| 一覧 | 3 件表示・例外 0 |
| 依頼者以外の操作で案件を開く | STEP1〜7 の枠組み表示・例外 0 |
| AI 回答 API | `provider=deepseek` / `model=deepseek-flash` / 根拠 `KB-2026-0001` |
| 引継ぎメモの分野・担当（H1） | `cat('IT端末')` → PC・周辺機器 / `staff('MK1073')` → 佐藤 奨太（ヘルプデスク担当）/ `staff(undefined)` → （未定） |
| 記入例（H3） | 印刷+共有 → 印刷スプーラの例 / 共有のみ → 共有フォルダの例 / 共有本文に偶発「印刷」→ 共有の例 |
| 依頼者表示（M3） | `personLabel('emp:MK0200')` → DX推進部 加藤 里美 / 名簿外 → 社員番号 / 通常の氏名は変化なし |
| Access JWT（report） | 起動ログ `mode:report`、JWT なしリクエストは警告を出して 200（公開は Access 302） |
| DB バックアップ | `ai_helpdesk_preview-20261025-124925.dump` 85,289 bytes / systemd 実行 `Result=success` / 次回 2026-10-26 02:32 JST |
| Access JWT（enforce） | 公開 Access 経由 `POST /api/device/browser` 200 / ローカル email ヘッダーのみ **401** / 公開未認証 302 / ログ `mode:enforce`（成功・失敗） |
| proxy secret | 直接 18950 → **401 `PROXY_REQUIRED`** / プロキシ経由 18949（JWT なし）→ 401 `UNAUTHORIZED` / 両方の `/api/health` 200 / 公開 302 |
| 公開経路（bypass） | `POST https://.../api/device/agent` がオリジンまで到達し、API の 401（デバイストークン）を返す＝Tunnel → プロキシ → API の経路を実測 |
| disk | **87% → 81%**（772GB → 722GB 使用 / 空き 125GB → 176GB、約 50GB 解放。uv は 9.9GB → 488MB） |

稼働中インスタンス（公開 URL のオリジン）:

| 項目 | 結果 |
|---|---|
| `/api/health` | `ok:true` / `db:ok` / `commit:754a757` |
| `/api/state` | 14 キー・案件 3・チャット 4・チケット 0・E2E なし |
| `GET /`（Access ヘッダー付き） | 200 / 7xx KB / 修正マーカー入り |
| 公開 URL | 302 → Cloudflare Access ログイン |
| 再起動後のログ | 18 リクエストすべて 200 / 5xx・エラー 0 |
| サービス | active / 起動 11:33:21 |

## 6. ロールバック

- コード: PR #31 / #32 / #33 の revert（`main`）。
- DB: migration 010 はデータ変換のみ。バックアップからは
  `pg_restore -d ai_helpdesk_preview /tmp/aihd-deploy/preview-before-deploy-20261025-112625.dump`
  で戻せる（サービス停止後に実施）。
- 状態のみ: 修復前の状態は `/tmp/aihd-deploy/state-before.json` に保存済み。

## 7. 次にやるべきこと

1. 認証済みの実ブラウザ要求をログで確認（プロキシ切替後の初回）。
2. proxy secret の限界を踏まえた権限分離、または Cloudflare Worker + Secret への移行検討。
3. disk の追加整理（Playwright 旧版・他プロジェクトのキャッシュは利用確認後）。
4. 氏名マスクの方針決定（要件と設計の突合）。
5. Windows 実機での端末エージェント配布・定期実行の確認（未実施）。
