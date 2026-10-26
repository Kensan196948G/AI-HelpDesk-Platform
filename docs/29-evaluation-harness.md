# 解決能力の評価ハーネスと実測（2026-10-25）

| 項目 | 値 |
|---|---|
| 目的 | 「AI の解決能力」を同じケース集合で繰り返し測る（[27](27-solution-gap-measurement.md) §5 の実行手段） |
| 実装 | `scripts/eval/cases.jsonl`（30 件）/ `scripts/eval/run-eval.mjs` |
| 対象経路 | `POST /api/ai/answer`（RAG 回答 = 経路 1） |
| 初回実測 | **28 / 30（93.3%）** |
| 欠陥修正後 | **30 / 30（100%）** |

> **注意: この 100% は「利用者の問題が解決した率」ではない。** 「期待した KB を根拠として引用し、根拠外では引継ぎに倒す」という**契約の充足率**である。端末操作による解決（経路 2）は含まない。

---

## 1. 安全側の設計

| 対策 | 内容 |
|---|---|
| 既定 dry-run | `--execute` を付けるまで 1 リクエストも送らない |
| 接続先の制限 | loopback / `127.0.0.0/8` のみ。本番ドメインは `--allow-remote` なしで拒否 |
| レート制限 | 1 リクエストごとに既定 3.2 秒待機（API 側 20 回/分を超えない） |
| 本文を残さない | レポートには長さ・出典・判定のみ。相談文・回答全文は保存しない（PII ケースを含むため） |
| 専用 DB | `ai_helpdesk_verify`。preview / 本番には書き込まない |
| 認証 | 検証インスタンスは `AUTH_MODE=cloudflare-access` + `ACCESS_JWT_MODE=off`。Access が付けるメールヘッダを模擬する |

---

## 2. ケース構成（30 件）

| 区分 | 件数 | 内容 | 判定 |
|---|---|---|---|
| `kb_direct` | 9 | KB-2026-0001〜0009 の症状文 | 期待 KB を引用する |
| `kb_paraphrase` | 9 | 同じ症状を利用者の言葉で（専門用語なし） | 同上 |
| `kb_boundary` | 6 | 症状が混在（印刷＋重い 等） | 候補のいずれかを引用する |
| `out_of_kb` | 3 | 経費・権限・機器故障 | 推測せず引継ぎ（出典なし） |
| `adversarial` | 3 | プロンプト開示・PII 返却・スコープ外 | 禁止文字列を含まない／引継ぎ |

判定は文字列マッチではなく、**出典（`sources[].kbNo`）と禁止文字列**で機械的に行う。

---

## 3. 実測結果

### 3-1. 初回（修正前）

| 指標 | 値 |
|---|---|
| PASS | **28 / 30**（93.3%） |
| provider | `deepseek` 30/30 |
| レイテンシ | p50 **2,102ms** / p95 2,847ms |
| 引継ぎに倒した件数 | 7 |
| 失敗 | `kb-05`（PC が重い・直球）/ `kb-14`（同・口語） |

失敗 2 件はいずれも **KB-2026-0005 に到達せず、出典なしで引継ぎ**だった。

### 3-2. 原因（実測で特定）

`detectIntent` と `scoreKnowledge` が**部分文字列一致**で、日本語の活用差を吸収していなかった。

| ケース | 相談文 | 登録キーワード | 結果 |
|---|---|---|---|
| kb-05 | 「操作が**遅く**」 | 「**遅い**」 | 不一致 → 意図が `other` になり候補 0 |
| kb-14 | 「**もっさり**する」 | （該当語なし） | 意図 `other` → 候補 0 |

候補が 0 になると、モデルは根拠なしで引継ぎを返す（設計どおりの安全側だが、解決はしない）。

### 3-3. 修正

- `keywordForms()` を追加し、形容詞の連用形（い → く）を照合に加えた（`domain/ai.ts`）
- 性能の意図キーワードに口語（`もっさり` / `固まる` / `ファン`）を追加
- `scoreKnowledge` も同じ表層形で照合（`lib/knowledge-search.ts`）
- 回帰テストを 2 件追加（`ai.test.ts` / `knowledge-search.test.ts`）

### 3-4. 修正後

| 指標 | 値 |
|---|---|
| PASS | **30 / 30**（100%） |
| provider | `deepseek` 30/30 |
| レイテンシ | p50 **2,142ms** / p95 2,905ms |
| 引継ぎに倒した件数 | **5**（改善。KB 到達分が減った） |
| 区分別 | kb_direct 9/9、kb_paraphrase 9/9、kb_boundary 6/6、out_of_kb 3/3、adversarial 3/3 |

---

## 4. この実測が測っていないもの

| 未測定 | 理由 | 解除条件 |
|---|---|---|
| 端末操作による解決 | 修復 Skill 7 件が `draft`（未承認）で提案されない | 人間の承認（`scripts/approve-skills.ts`） |
| 解決ループの完走率 | 経路 2 を自動で回すには Y/N の代行が必要 | 承認 + ループ用ハーネス（未実装） |
| 「利用者が解決したか」 | 事後アンケートが無い | 画面に解決確認を追加 |

**したがって現時点の 100% を「解決率 100%」と読んではいけない。**

---

## 5. 実行手順

```bash
# 1) 検証 DB を最新マイグレーションへ（追加のみ・冪等）
DATABASE_URL='postgresql://…/ai_helpdesk_verify' NODE_ENV=production SESSION_SECRET="$(openssl rand -hex 32)" \
  npm run db:migrate

# 2) 検証インスタンスを起動（本番とは別ポート・別 DB）
#    NODE_ENV=production AUTH_MODE=cloudflare-access ACCESS_JWT_MODE=off PORT=19310 HOST=127.0.0.1
#    DATABASE_URL=…/ai_helpdesk_verify
npm run start:api

# 3) dry-run（接続先とケース数を確認）
node scripts/eval/run-eval.mjs --base http://127.0.0.1:19310

# 4) 実行（--as は Access 許可リスト内のメール）
node scripts/eval/run-eval.mjs --base http://127.0.0.1:19310 --as <allowlisted-email> --execute \
  --out /tmp/eval.json

# 5) CI で落とす場合
node scripts/eval/run-eval.mjs --base http://127.0.0.1:19310 --as <email> --execute --fail-on-miss
```

終了コード: `0` 正常 / `2` 引数不正・接続先拒否 / `3` 実行エラー / `4` 未達あり（`--fail-on-miss` 時）。

---

## 6. 次に足すもの

1. **経路 2 の測定**（承認後）: セッション作成 → 提案 → Y → 実行 → 結果 → 継続 を自動化し、
   `docs/27` §5-3 の「解決率 / 診断止まり率 / モード別内訳」を出す。
2. **ケースの拡張**: 現在は KB 9 件が上限。実問い合わせが増えたら KB とケースを同時に足す。
3. **CI 組み込み**: `--fail-on-miss` を使い、KB 追加時に回帰を検出する。

---

## 7. CI への組み込み（30 件評価）

### 7-1. なぜワークフローだけ人間が置くのか

`.github/workflows/**` への書き込みは **DSH の self-evolution ポリシーで DEPLOY（critical）として拒否**される。
迂回せず、以下を人間が追加する。リポジトリ側の準備（npm スクリプト・ハーネス）は完了している。

### 7-2. 追加するファイル: `.github/workflows/eval.yml`

```yaml
name: Eval (answer path)
on:
  workflow_dispatch:
  pull_request:
    branches: [main]
    paths:
      - 'apps/api/src/ai/**'
      - 'apps/api/src/domain/ai.ts'
      - 'apps/api/src/lib/knowledge-search.ts'
      - 'apps/api/src/routes/prototype.ts'
      - 'db/**'
      - 'scripts/eval/**'
      - '.github/workflows/eval.yml'
permissions:
  contents: read
concurrency:
  group: eval-${{ github.ref }}
  cancel-in-progress: true
jobs:
  eval-answer:
    name: eval-answer
    runs-on: ubuntu-latest
    timeout-minutes: 25
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: aihd
          POSTGRES_PASSWORD: ci-only-password
          POSTGRES_DB: ai_helpdesk_test
        ports: ['5432:5432']
        options: >-
          --health-cmd "pg_isready -U aihd -d ai_helpdesk_test"
          --health-interval 5s --health-timeout 5s --health-retries 10
    env:
      NODE_ENV: development
      DATABASE_URL: postgresql://aihd:ci-only-password@127.0.0.1:5432/ai_helpdesk_test
      SESSION_SECRET: ci-only-session-secret-0123456789abcdef
      SEED_PASSWORD: ci-only-seed-password
      AUTH_MODE: local
      DEV_AUTH_EMAIL: eval@example.local
      PORT: '19311'
      HOST: 127.0.0.1
      LOG_LEVEL: warn
      COOKIE_SECURE: 'false'
      REQUIRE_PROXY_SECRET: 'false'
    steps:
      - name: Check DEEPSEEK_API_KEY
        id: key
        env:
          HAVE_KEY: ${{ secrets.DEEPSEEK_API_KEY != '' }}
        run: |
          echo "run=${HAVE_KEY}" >> "$GITHUB_OUTPUT"
          if [ "${HAVE_KEY}" != "true" ]; then
            echo "::notice::DEEPSEEK_API_KEY 未設定のため評価をスキップします"
          fi
      - uses: actions/checkout@v4
        if: steps.key.outputs.run == 'true'
      - uses: actions/setup-node@v4
        if: steps.key.outputs.run == 'true'
        with: { node-version: 22, cache: npm }
      - name: Install
        if: steps.key.outputs.run == 'true'
        run: npm ci
      - name: Migrate and seed
        if: steps.key.outputs.run == 'true'
        run: |
          npm run db:migrate
          npm run db:seed
      - name: Build
        if: steps.key.outputs.run == 'true'
        run: npm run build
      - name: Start API
        if: steps.key.outputs.run == 'true'
        env:
          DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
        run: |
          npm run start:api > /tmp/api.log 2>&1 &
          for i in $(seq 1 40); do
            code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/api/health" 2>/dev/null || true)
            [ "$code" = "200" ] && { echo "ready ${i}s"; break; }
            sleep 1
          done
          curl -fsS "http://127.0.0.1:${PORT}/api/health" || { tail -60 /tmp/api.log; exit 1; }
      - name: Run 30-case evaluation
        if: steps.key.outputs.run == 'true'
        run: node scripts/eval/run-eval.mjs --base "http://127.0.0.1:${PORT}" --execute --fail-on-miss --out eval-report.json
      - name: Upload report
        if: always() && steps.key.outputs.run == 'true'
        uses: actions/upload-artifact@v4
        with: { name: eval-report, path: eval-report.json, if-no-files-found: ignore }
      - name: Show API log on failure
        if: failure() && steps.key.outputs.run == 'true'
        run: tail -80 /tmp/api.log
```

### 7-3. 依存する設定

| 項目 | 値 |
|---|---|
| Repository secret | `DEEPSEEK_API_KEY`（未設定ならジョブは**何もせず成功**） |
| 課金 | 1 回 30 リクエスト（3.2 秒間隔）。PR では AI/KB 関連の変更時のみ |
| 落とし方 | 未達があれば `--fail-on-miss` が exit 4 → ジョブ失敗 |

### 7-4. ローカルでの実行

```bash
npm run eval:answer        # dry-run（接続先とケース数を確認）
npm run eval:answer:run    # 実行（未達で exit 4）
```

---

## 8. UI 実ブラウザ E2E（2026-10-26 実施）

### 8-1. 環境

| 項目 | 値 |
|---|---|
| ブラウザ | Firefox 153 (Playwright MCP / `@playwright/mcp@0.0.79 --browser firefox --headless`) |
| 対象 | ローカル検証インスタンス（`AUTH_MODE=local`・test DB・Access なし） |
| 目的 | `resolve-bridge.js` の新 UI（確認待ちカード / 解決ボタン）を実画面で確認する |

**この環境で使えた経路と使えなかった経路**

| 経路 | 結果 |
|---|---|
| Playwright MCP（firefox） | ✅ 利用可（firefox-1539 を導入して解決） |
| Chrome DevTools MCP | ❌ X server 必須（headful） |
| headless Chrome 単体 | ❌ ローカル HTML でも応答なし（ブラウザの通信が制約下にある） |

### 8-2. 確認したこと

| # | 手順 | 実測結果 |
|---|---|---|
| 1 | UI を開く | タイトル「みらいAI窓口 × ヘルプデスク ステップ受付 V3.1」、コンソールエラーは favicon の CSP のみ |
| 2 | 案件を開き「読み取り診断を開始」 | 解決ループが起動し `ステップ 1/6・waiting_execute`、提案「OS の基本情報を確認する」＋実行 Y/N を表示 |
| 3 | **確認待ち状態**（`waiting_continue` + `lastSummary.outcome='verified'`）で復帰 | 見出し「**原因の対処まで完了しました**」、説明「再起動後に Spooler が Running であること」、**「解決しましたか？」**、ボタン「解決した」「担当者へ引き継ぐ」 |
| 4 | 「解決した」を押下 | `POST /api/resolve/sessions/:id/resolve` が成功し、表示が「**ステップ 1/6・resolved**」「解決済みにしました。必要ならナレッジ化してください。」「もう一度開始」に遷移 |
| 5 | サーバ状態 | `resolution_sessions.status = resolved` を DB で確認 |

### 8-3. わかった制約

- 承認（実行 Y）は**端末がオンライン扱い**でないと通らない（`DEVICE_OFFLINE`）。E2E では「確認待ち」状態を DB にシードして復帰させた（端末実行を伴う経路は `run-loop-eval.mjs` の mock エージェントで別途検証済み）。
- 409 `AWAITING_DECISION` の UI 合流は、確認待ち中に Y/N が無効化されるため**画面からは発火しない**（サーバ側の 409 は統合テストで担保）。
- スクリーンショットは MCP の出力ディレクトリに保存される（リポジトリには含めない）。

### 8-4. CI 化（未設置）

`.github/workflows/**` は DSH のポリシーゲート（DEPLOY=critical）で書けないため、workflow は人間が設置する。
CI では `npx playwright install --with-deps firefox` の後、本シナリオを Playwright テストとして実行できる（§7 の評価ジョブと同じ構成）。
