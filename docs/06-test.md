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

## 3. 結果（2026-10-23 14:02 JST）

| チェック | 結果 | 備考 |
|---|---|---|
| TypeCheck（API） | ✅ 成功 | `tsc --noEmit` |
| Lint / Format | ✅ 成功 | Biome。warning 9（non-null assertion 等）、error 0 |
| Unit test | ✅ 30 件成功 | PII / signal / audit / PC / AI / password / Worker / Access |
| Integration test | ✅ 11 件成功 | 主要 3 Flow、セキュリティ、権限、UI 配信、state、AI |
| API Build | ✅ 成功 | `apps/api/dist` を生成 |
| Dependency audit（runtime） | ✅ 0 vulnerabilities | `npm audit --omit=dev --audit-level=high` |
| Secret pattern scan | ✅ 検出なし | `scripts/scan-secrets.sh`（CI 用） |
| Backup / Restore | ✅ 成功 | PG16 `pg_dump` → 新規 DB へ plain 復元 |
| UI 配信 | ✅ 200 | 元 HTML のタイトル・主要画面・約 500KB |
| Access 認証 | ✅ | ヘッダーなし 401 / 許可 200 / 不一致 403 / 本番 login 404 |
| 公開 URL | ✅ | 302 → Cloudflare Access OTP ログイン画面 |
| DeepSeek フォールバック | ✅ | `/api/ai/answer` 200 / 承認済みナレッジの根拠 |
| E2E（UI） | ⏸ 一部 | UI 配信・状態・H.kb を Playwright で確認。全 STEP の E2E は未実施 |

```
Test Files  11 passed (11)
Tests       41 passed (41)
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

`.github/workflows/ci.yml` を用意しようとしたが、**self-evolution policy gate が `.github/workflows/` を DEPLOY（critical）と分類し拒否**した。
CI 定義は [docs/08-deployment.md](08-deployment.md) に「人間が追加する用」として記載する。
ローカルでは TypeCheck / Lint / Test / Build / Audit / Secret scan をすべて実行済み。

## 8. 未実施・未検証

- WebUI の E2E（Y/N 承認後）
- Cloudflare Preview 上の実操作（policy gate により Blocker）
- 負荷試験・長時間運用・バックアップ復元の実地試験
