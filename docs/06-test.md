# Test / 検証結果

## 1. 実行環境

| 項目 | 値 |
|---|---|
| Node.js | v22.22.3 |
| Test runner | vitest 3.2.4 |
| DB（unit/integration） | Local PostgreSQL 16（`127.0.0.1:5435` / `ai_helpdesk_test`） |
| API test | `buildServer()` + `app.inject`（実 HTTP なし） |
| 日付 | 2026-10-23 |

## 2. コマンド

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run build
```

### 2-1. テスト DB の準備

`vitest.config.ts` の `globalSetup` が以下を実行する（`NODE_ENV=test`）。

```bash
npx tsx scripts/migrate.ts   # .env.test.local を読む
npx tsx scripts/seed.ts
```

`ai_helpdesk_test` は専用 DB。開発 DB `ai_helpdesk_mvp` には触れない。

## 3. 結果（2026-10-23 16:15 JST）

| チェック | 結果 | 備考 |
|---|---|---|
| TypeCheck（API） | ✅ 成功 | `tsc --noEmit` |
| Lint / Format | ✅ 成功 | Biome。warning 27（non-null assertion 等）、error 0 |
| Unit test | ✅ 63 件成功 | PII / signal / audit / PC / AI / password / Worker / Access / 許可リスト / 実PC情報 / 端末エージェント / ブリッジ |
| Integration test | ✅ 11 件成功 | 主要 3 Flow、セキュリティ、権限、UI 配信、state、AI |
| API Build | ✅ 成功 | `apps/api/dist` を生成 |
| Dependency audit（runtime） | ✅ 0 vulnerabilities | `npm audit --omit=dev --audit-level=high` |
| Secret pattern scan | ✅ 検出なし | `scripts/scan-secrets.sh`（CI 用） |
| Backup / Restore | ✅ 成功 | PG16 `pg_dump` → 新規 DB へ plain 復元 |
| UI 配信 | ✅ 200 | 元 HTML のタイトル・主要画面・約 500KB |
| Access 認証 | ✅ | ヘッダーなし 401 / 許可 200 / 不一致 403 / 本番 login 404 |
| Access 許可リスト | ✅ | `docs/MailAddress.txt` から 2 件（完全一致 1 / ドメイン 1）。例示 typo は拒否、欠落・空は 403（fail-closed） |
| 実PC情報（ブラウザ） | ✅ | `POST /api/device/browser` 200 / 35 項目 / OS・CPU 8 コア・16GB・Chrome 141・GPU |
| 実PC情報（エージェント） | ✅ | Linux 実機で `POST /api/device/agent` 200 / 300 ソフト / 16 コア・30.8GB / 更新 92 件 |
| 端末エージェント（PowerShell） | ✅ | Linux pwsh で構文・`-DryRun`・API送信。Windows実機で Windows 11 Pro / i5-9500 / 32GB / 273ソフト / Defender を取得。BitLocker はタスク実行ユーザー権限で未検出（`-Elevated` で対応） |
| 端末分離 | ✅ | ブラウザ Windows 11 と別端末 Ubuntu agent を分離。未リンク agent はブラウザを上書きしない（自動テスト） |
| AI の PC コンテキスト | ✅ | `provider: deepseek` / `model: deepseek-flash` / `device.source: agent` / Windows 11 Pro・i5-9500・31.8GB・273ソフトを回答に反映 |
| AI 一次切り分け（PC性能） | ✅ | KB-2026-0005 を根拠に、タスクマネージャー・空き容量・再起動・引継ぎの手順を返す |
| AI 一次切り分け（BitLocker / Defender / 更新） | ✅ | KB-2026-0007 / 0008 / 0006 を根拠に、読み取り確認とエスカレーション手順を返す |
| KB検索の専門語優先 | ✅ | 「手順」等の一般語より「BitLocker」等の専門語一致を優先（knowledge-search.test.ts 2件） |
| エージェント公開経路 | ✅ | `https://.../api/device/agent` へ 200（Access bypass + デバイストークン） |
| OTP 実ログイン | ✅ | 2026-10-23 15:32 JST / Access ログ `Mirai AI HelpDesk MVP` / `onetimepin` / `allowed=true` |
| 公開 URL | ✅ | 302 → Cloudflare Access OTP ログイン画面 |
| DeepSeek 実回答 | ✅ | `provider: deepseek` / `model: deepseek-flash`（V4.1-Flash）/ 331文字 / KB-2026-0001 |
| UI ウィザード STEP 1〜3 | ✅ | 種類選択 → 内容 → AI一次対応。ページエラー 0 |
| E2E（UI） | ⏸ 一部 | UI 配信・状態・H.kb を Playwright で確認。全 STEP の E2E は未実施 |

```
Test Files  17 passed (17)
Tests       74 passed (74)
```

## 4. Integration test が見ているもの

`apps/api/src/routes/integration.test.ts`

1. **主要 3 Flow**
   - 相談作成（PII 伏せ字・PC 31 項目・承認済みナレッジの根拠）
   - 共有前は担当者に PC 情報が見えない → 引継ぎ同意後に見える
   - ボードキュー、担当割当、解決記録、ナレッジ下書き、申請
   - ヘルプデスクによる承認は 403（職務分離）
   - 承認者による承認 → 案件 completed / step 7
   - 監査ハッシュチェーン `ok: true`
2. **セキュリティ**
   - 赤信号、AI 解決不可（409）、引継ぎ推奨
3. **権限**
   - 他人の案件は 404
   - 相談者は `/desk/queue` に 403

## 5. 手動 API 検証（開発 DB）

`TKT-2026-0101`〜`0103` を作成し、以下を実測。

| 項目 | 結果 |
|---|---|
| ログイン（3 ロール） | 200 / Cookie 発行 |
| 相談作成 + AI | 200 / 根拠 `KB-2026-0001` / signal blue |
| PII 伏せ字 | メール・電話が `[メールアドレス]` / `[電話番号]` |
| PC 共有前 | 担当者 `visible:false` |
| 引継ぎ | TKT/INC 発行 / signal amber / step 5 |
| 担当割当・解決 | 200 / step 6 / `knowledge_pending` |
| ナレッジ下書き・申請 | `KB-2026-0101` / draft → pending |
| 承認者承認 | approved / completed / step 7 |
| 監査検証 | `{ok:true, checked:27}` |
| セキュリティ案件 | red / resolve 409 |
| クロスユーザー | 404 |

> 手動検証で作成した案件は開発 DB に残っている。Preview 用には Seed 済みの別 DB を用意するか、対象を限定した DELETE で整理する（破壊的操作のため承認後に実施）。

## 6. 受入状態（UI）

| 状態 | API / 設計 | UI 実装 |
|---|---|---|
| 正常 | ✅ | 承認待ち |
| 空 | ✅（0 件クエリ） | 承認待ち |
| 読込中 | — | 承認待ち |
| 入力エラー | ✅（zod 400） | 承認待ち |
| 通信エラー | — | 承認待ち |
| 権限なし | ✅（403/404） | 承認待ち |
| 赤信号 | ✅ | 承認待ち |
| 改ざん検知 | ✅（verify） | 承認待ち |

## 7. CI

`.github/workflows/ci.yml`（GitHub Actions / job `verify`）を 2026-10-23 に追加した。
以前のセッションでは self-evolution policy gate により作成を拒否されていたが、現在の環境では作成できることを確認した。

| Step | 内容 |
|---|---|
| Install | `npm ci`（Node 22） |
| Secret scan | `bash scripts/scan-secrets.sh` |
| Audit | `npm audit --omit=dev --audit-level=high` |
| Typecheck / Lint | `npm run typecheck` / `npm run lint` |
| Migrate | 空 DB へ `npm run db:migrate` を 2 回（冪等性の確認） |
| Test | `npm test`（PostgreSQL 16 service。global-setup が migrate + seed） |
| Build | `npm run build` |

- CI の DB 資格情報はジョブ内の使い捨て service コンテナ専用の固定値で、実環境の秘密ではない。
- `pull_request`（main 向け）/ `push`（main）/ 手動実行で起動する。

## 8. 未実施・未検証

- WebUI の E2E（Y/N 承認後）
- Cloudflare Preview 上の実操作（policy gate により Blocker）
- 負荷試験・長時間運用・バックアップ復元の実地試験

## 9. 2026-10-25 再検証（全機能）

| チェック | 結果 |
|---|---|
| TypeCheck | ✅ 成功 |
| Lint | ✅ error 0（warnings 113 / infos 33） |
| Test | ✅ **35 files / 201 tests passed**（3 回連続で同一結果・flaky なし） |
| Build | ✅ 成功 |
| Secret scan | ✅ 検出 0 |
| Dependency audit（runtime） | ✅ 0 vulnerabilities |
| Migration | ✅ 2 回目 no-op（冪等）。`010_jsonb_objects.sql` を追加 |
| Seed 再実行 | ✅ 行数増加なし |
| CI（main） | ✅ `verify` 成功 |

追加したテスト: 状態の欠落キー補完（4）、JSONB 保存形式（1）、案件依頼者の名簿解決（1）。
詳細: [24-verification-20261025.md](24-verification-20261025.md)
