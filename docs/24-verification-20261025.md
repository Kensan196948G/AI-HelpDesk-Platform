# 全機能検証・修正・反映（2026-10-25）

対象: 「みらいAI窓口 × ヘルプデスク V3.1」デプロイ済みシステム
公開 URL: https://ai-helpdesk.mirai-dx-platform.com/
リポジトリ: `AI-HelpDesk-Platform`（main / 反映コミット `030027d`）
実施: 2026-10-25 09:44〜11:35 JST（Agent Team: API / UI / 基盤 / 品質の 4 検証 + 独立レビュー 2 回）

## 1. 結論

主要機能は稼働している。ただし検証で **Critical 2 件・High 4 件・Medium 3 件**を検出したため、
修正 3 PR（#31 / #32 / #33）を作成し、CI 緑・独立レビュー後に `main` へマージした。
さらに稼働サービス（旧コード・状態破損）へ反映し、反映後の再検証まで完了した。

- 反映後の公開 URL: **正常**（Access 302 / アプリ 200 / 5xx 0）
- 稼働コード: `030027d`（`/api/health` の `commit` で確認）
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

### 未対応（既知の課題）

| 重大度 | 内容 | 推奨 |
|---|---|---|
| High | 引継ぎメモの推定分野が誤り（印刷→セキュリティ）、担当者名が `MK1073（）` のまま | `KINDS.cat` と `CATS` の対応表、担当者は社員番号→氏名の解決 |
| High | 「デモ用の記入例」が案件種別と無関係で、承認ナレッジ・最終報告書まで汚染 | 記入例を案件種別に合わせる／汎用文言へ |
| Medium | チケット一覧の依頼者欄に内部 ID（`emp:MK...`）を表示 | 氏名表示へ |
| Medium | `ACCESS_JWT_MODE=off` / `REQUIRE_PROXY_SECRET=false`（公開は Access で遮断済みだが多層防御なし） | `ACCESS_JWT_MODE=report` → `enforce`、proxy secret の付与方法を設計 |
| Medium | preview DB のバックアップなし／disk 87% | `pg_dump` の日次タイマー、不要ファイル整理 |
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
| 6 | 反映後に再検証（下記） |

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

稼働中インスタンス（公開 URL のオリジン）:

| 項目 | 結果 |
|---|---|
| `/api/health` | `ok:true` / `db:ok` / `commit:030027d` |
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

1. 引継ぎメモの分野・担当者表示（High）と記入例（High）の修正。
2. `ACCESS_JWT_MODE=report` から段階的に JWT 検証を有効化し、proxy secret の付与方法を設計。
3. preview DB の日次バックアップと disk 使用率の整理。
4. 氏名マスクの方針決定（要件と設計の突合）。
5. Windows 実機での端末エージェント配布・定期実行の確認（未実施）。
