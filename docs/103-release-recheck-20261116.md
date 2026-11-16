# 103. リリース準備の再点検と受入指摘の修正（2026-11-16）

## 0. 結論

本番と Staging は `62ee854` で稼働していた。2026-11-13 の認証後受入で残った 3 件と、2026-11-16 のホスト再起動で実測した起動順序の不足を **PR #194** で修正し、
Staging へ `ba8d092` として配備して受入を確認した。**本番への配備は未実施**で、[AGENTS.md](../AGENTS.md) §6 と Super-Agent 共通規約により承認待ちとする。
品質ゲートは偽装せず、未検証事項を §7 に残す。

| 区分 | 状態（2026-11-16 時点） |
|---|---|
| 本番 | `62ee854`（health ok / db ok / migrations 45）・**未変更** |
| Staging | `ba8d092`（release `20261116T192926-ba8d092ce5e6`、health 一致、readiness exit 0） |
| main | `ba8d092`（PR #194 squash merge） |
| 修正の独立レビュー | P0=0 / P1=0（別セッション・別 DB・実ブラウザ実測） |
| 本番配備 | **未実施（承認待ち）** |
| QA Workbench の release 門禁 | 現行 commit では未申請（§8） |

## 1. 実測（2026-11-16 18:49〜19:00 JST・読み取りのみ）

- 本番 `/api/health`（127.0.0.1:18950）: `ok=true` / `commit=62ee854` / `db=ok` / `env=production`
- Staging `/api/health`（127.0.0.1:18952・配備前）: 同上（Staging も `NODE_ENV=production` で起動する設計。[docs/77](77-staging-environment-design.md)）
- `scripts/ops-readiness.mjs`: 本番・Staging とも exit 0（health 一致、未認証 401、公開 URL は Access へ 302）
- 本番 DB（読み取り専用・`PGOPTIONS=-c default_transaction_read_only=on`）: migrations **45**、ops テーブル **6**、`ops_settings` 0 行、`ops_estop` active 0、承認済み knowledge 9、audit_log 83
- 公開 URL（未認証）: 本番・Staging とも **302** → Cloudflare Access
- 常駐 unit: prod/stg API・proxy・cloudflared・stg-postgres すべて `active` / `NRestarts=0`
- ディスク: 936G 中 142G 空き（85% 使用）
- 証跡: `docs/evidence/release-recheck-20261116/lead/`（readiness / DB / 監視 / 起動順序 / 公開 URL / Staging 配備）

### 1-1. ホスト再起動時の起動順序（新たに判明した事実）

2026-11-16 12:36 にホストが再起動した（カーネル 7.0.0-43）。本番 API は 12:37:09 に起動し、12:37:18 に `ensureSkillCatalog()` で
`ECONNREFUSED 127.0.0.1:5435` を 1 回記録した（PostgreSQL は Docker 側にあり、API より後に接続を受け付け始めた）。
サーバ自体は起動して health も `db=ok` になるが、**次回再起動まで Skill カタログが同期されない**状態だった。
ログには引継ぎ通知メールの失敗（level=40）も同時刻に 1 件記録されている（同じ接続拒否が原因）。

`retryWhileStarting()`（最大 5 回・250/500/1000/2000ms、既知の DB 起動待ちコードのみ）を追加して解消した。
恒久的な失敗（認証・権限・SQL）は再試行せず、従来どおり 1 回でエラーにする。

## 2. 修正内容（PR #194 / `1239e2a` → `ba8d092`）

| # | 対象 | 内容 |
|---|---|---|
| 1 | `Mirai_AIHelpdesk_OpsConsole_V1.0.html` | システム設定の「既定値から変更されています」を `state.settings` の有無ではなく既知キーの値比較へ（`settingsKey` / `isDefaultSettings`）。「既定値に戻す」は `PUT /api/ops/settings` で永続化し、通信失敗時はサーバ値へ戻す |
| 2 | `apps/api/src/routes/ops.ts` + 同 HTML | 移行バナーを現状へ更新（主要画面は実データ／`/legacy` 残置／未実装・「疑似」）。`position:fixed` をやめ flex 下端の要素にし、主要ボタンを覆わない |
| 3 | `apps/api/src/routes/prototype.ts` | `/legacy?ro=1` の読み取り専用モード（ブリッジの PUT/POST を止める検証補助。権限制御ではない） |
| 4 | `apps/api/src/server.ts` + `lib/startup-retry.ts` | 起動時の DB 待ち再試行（§1-1） |
| 5 | テスト | ops 1 件 / prototype 2 件 / startup-retry 4 件を追加 |

## 3. 検証

| 検証 | 結果 |
|---|---|
| `npx vitest run`（新規 DB `aihd_test_lead_20261116`） | **122 files / 2219 tests passed**（exit 0） |
| 対象テスト（ops / ops-settings / prototype / startup-retry） | 38 tests passed |
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0（error 0 / warning 371 / info 198） |
| HTML inline script の構文 parse | 1 script / 0 errors |
| 独立レビュー（別セッション・別 DB・Playwright + system Chrome） | **P0=0 / P1=0** |

独立レビューの実測（AUTH_MODE=local・専用ポート・専用 DB）:

- バナーと主要ボタンの交差面積 **0**、ボタン中心は BUTTON、trial click 可（1280×720 / 1366×768 / 1920×1080、pageerror 0）。
- システム設定: 保存行 0 で「すべて既定値です」。0.5 を保存すると「変更されています」、リセットで **PUT 1 回**、再読込後も「すべて既定値です」。
- `/legacy?ro=1` 9 秒: **non-GET 0**・GET 8・pageerror 0。`/legacy`（ro なし）は PUT × 8・POST × 1 で従来どおり。
- P3-5（通信失敗経路）修正後も P0/P1 なし。

## 4. GitHub

| 項目 | 値 |
|---|---|
| Branch | `fix/ops-acceptance-findings-20261116` |
| Commit / head | `1239e2a84132af540c4c2672e57259c2328d03b0` |
| PR | [#194](https://github.com/Kensan196948G/AI-HelpDesk-Platform/pull/194) |
| PR CI | run `43848432127` / `verify` **pass**（4m45s、head `1239e2a`） |
| Merge | **MERGED**（squash、`--match-head-commit 1239e2a`、2026-11-16T10:29:03Z） |
| Merge commit (main) | `ba8d092ce5e65838e3b0568c6b2eaedbebf52ed4` |
| main push CI | run `43849251086`（§4-1） |
| マージ後確認 | この文書の PR で main の差分と CI を確認する |

### 4-1. main push CI

run `43849251086`（head `ba8d092`、event=push）= **success**（2026-11-16 19:35 JST 完了）。

## 5. Staging 配備と受入

`scripts/deploy-release.sh` で `ba8d092` を配備した（2026-11-16 19:29 JST、`--migrate` は全 45 件 skip でスキーマ変更なし）。

| 確認 | 結果 |
|---|---|
| release | `20261116T192926-ba8d092ce5e6`（`current` の実体） |
| `/api/health` | `commit=ba8d092…` / `db=ok` / 200 |
| 配備物の内容 | 新バナー CSS・`data-aihd-readonly-guard`・`retryWhileStarting`・`isDefaultSettings` を release ツリーで確認 |
| `ops-readiness.mjs` | exit 0（commit 一致、未認証 401） |
| Staging healthcheck | `Result=success` / exit 0 |
| 起動後の API journal | level=50 **0 件**（19:29 以降） |

- 認証後の画面操作（Access ログイン）は Staging でも未実施（所有者の OTP が必要）。§7-2 に残す。
- 旧 release（`1e2607c`）は prune された（`20261111T200910` は本番側に残る）。

## 6. 監視・復旧

| 項目 | 実測 |
|---|---|
| 本番バックアップ | 2026-11-16 02:32 `OK`（283,835 B、sha256 `60bb1230…`、14 日保持） |
| Staging 復元訓練 | 2026-11-15 04:32 success（週次、次回 11-22） |
| Staging healthcheck / tunnel-watch | 5 分毎に success（19:05 時点） |
| 復旧手順 | [docs/09](09-operations.md) / [docs/08](08-deployment.md) §8 / [docs/101](101-ops-ui-cutover.md) §5 |

本番のロールバックは従来どおり、設定 1 行（`OPS_UI_PRIMARY`）と release の symlink 切替＋restart で行う。DB は 038〜045 適用済みのままで問題ない（新規テーブルと列追加のみ）。

## 7. 残リスク・未検証

| # | 項目 | 状態 | 扱い |
|---|---|---|---|
| 1 | 本番 DB への書き込みを伴う受入（受付・引継ぎ・承認・設定保存・緊急停止） | 未検証 | 本番配備後、承認済みの範囲で 1 件ずつ確認する |
| 2 | 旧 UI（`/legacy`）の主要操作 | 未検証 | `?ro=1` で表示のみ確認可能。操作は Staging で確認する |
| 3 | 新 UI の見た目（レイアウト・配色） | DOM のみ確認 | 所有者の実ブラウザ確認が必要 |
| 4 | Access JWT の検証経路 | 未検証 | 既存の Access 設定に依存。変更なし |
| 5 | 本番のロールバック訓練（現行 release → 直前） | 未実施 | 次回メンテナンスで実施 |
| 6 | 901px 未満のバナー位置 | 初期表示外（本文は覆わない） | 受容（§7-1） |
| 7 | `?ro=1` は読み取り目的の POST も拒否 | 仕様（安全側） | 受容（§7-1） |
| 8 | QA Workbench の release 門禁（現行 commit） | 未申請 | 所有者の判定が必要（§8） |

### 7-1. 受容した事項

- **901px 未満のバナー**: body が `display:block` になるため flex 下端の指定が効かず、バナーはページ末尾に表示される（本文を覆わない）。操作コンソールの主対象は 1280×720 以上のデスクトップであり、モバイル最適化は対象外とする。
- **`?ro=1` の POST 拒否**: intake preview / knowledge inspect は読み取り目的だが POST のため拒否される。検証補助は「書き込みを一切送らない」ことを優先する。

## 8. リリース判定

- **本番配備は未実施**。AGENTS.md §6 と Super-Agent 共通規約により、本番 deploy は人間の承認を要する。
- QA Workbench（`~/.dsh/dsh-qa`）の「運用統合UI切替 2026-11-11（P0）」は、要件・テストケースの門禁が承認済み、報告書は draft、release 門禁は未申請。
- 既知の minor 欠陥「P0 報告/テストケースの本番 commit 期待値 `1e2607c` が現行本番 `62ee854` と不一致」は未クローズ。本修正の配備後に報告書を現行 commit へ更新する必要がある。
- 本番配備の可否は、§7 の未検証事項（特に本番書き込みを伴う受入）をどう扱うかと合わせて所有者が判断する。

## 9. 参照

- 前回の記録: [docs/102](102-release-prep-20261113.md)
- 切替・ロールバック: [docs/101](101-ops-ui-cutover.md)
- 移行計画: [docs/100](100-ops-console-migration.md)
- 証跡: `docs/evidence/release-recheck-20261116/`
