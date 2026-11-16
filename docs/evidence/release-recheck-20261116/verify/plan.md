# 独立検証計画（受入指摘 3 件の再確認と修正レビュー）

> **実施結果は [review.md](review.md) にある。** 本書のマトリクスは計画時点のもので、実測・判定・重大度付き指摘は review.md を正とする。

- タスク: task-2「独立検証: 受入指摘修正のレビューとローカルUI実測」
- 検証者: verifier（Reviewer/QA）。製品コードは編集しない。
- repo: `/home/kensan/Projects/Mirai-Admin-Platform/AI-HelpDesk-Platform`
- branch: `fix/ops-acceptance-findings-20261116`
- 検証開始時の基準: `HEAD = origin/main = 0af394c9e040d13eff5c9bce40b9432d2d6bdbb7`（差分ゼロの状態から開始）
- 文書の親: [docs/102](../../../102-release-prep-20261113.md) §6-3 / [docs/101](../../../101-ops-ui-cutover.md) §7

## 0. 判定の書き方

- **PASS**: 期待どおりであることを、この文書に書いたコマンド出力・ファイル:行・ブラウザ観測のいずれかで示せた。
- **FAIL**: 期待と異なることを実測で示せた。
- **NOT RUN**: 実施していない。**未実施を PASS と書かない。** ソースを読んだだけの事項は「静的確認」と明記し、実行結果とは区別する。
- 実測値には取得手段（コマンド / `file:line` / ブラウザ network など）を必ず添える。

## 1. Phase 1: 指摘の再確認（読み取りのみ・コード上の事実）

docs/102 §6-3 の 3 指摘が、修正前のコードで成立しているかを確認した。
**この節はすべて静的確認（ソース読解）であり、画面操作の実測ではない。**

### F1. システム設定の「既定値から変更されています」が設定オブジェクトの有無で決まる

| 確認点 | 根拠（file:line） | 読み取れた事実 | 判定 |
|---|---|---|---|
| 注記の条件 | `Mirai_AIHelpdesk_OpsConsole_V1.0.html:1746` | `${state.settings ? '既定値から変更されています' : 'すべて既定値です'}`。**値ではなく `state.settings` の真偽**で分岐する | 指摘成立 |
| 既定値の合成 | 同 `:1616` `getSettings()` | `DEF_SET` に `state.settings` を重ね、`sla` / `std` はネストも合成する。したがって「値は既定値と同じ」状態を作れる | 指摘成立 |
| boot での代入 | 同 `:2198` | `__b.state.settings` が object なら `state.settings` に入れる。サーバは保存行が無くても既定値を返す（`apps/api/src/routes/ops-settings.ts` の `loadSettings` / `DEFAULT_SETTINGS`、`apps/api/src/routes/ops.ts:172-180` が常に `settings` を含む） | 指摘成立（常に「変更されています」側になる） |
| 保存時の扱い | 同 `:2319` | `if(!state.settings || JSON.stringify(cur)===before) return;` 保存後は `state.settings` が入る | 指摘成立 |
| リセット時の文言 | 同 `:1969` | `if(!state.settings){toast('すでに既定値です');return}`。**有無判定**であり、値が既定値でも「戻しました」と言い得る | 指摘成立（同根因） |

### F2. 移行バナーが P2 時点の文言のまま

| 確認点 | 根拠（file:line） | 読み取れた事実 | 判定 |
|---|---|---|---|
| バナー定数 | `apps/api/src/routes/ops.ts:43-45` | `'移行中：…①受付と②AI一次対応は実データに接続済み。その他の画面は順次接続します（未接続の画面のデータはサンプルです）。'` | 指摘成立 |
| 実データ接続の実測（親文書） | `docs/102-release-prep-20261113.md` §6-1 | ダッシュボード・チケット・KB 9 行・Skills 7 本・監査 50 行・設定・端末台帳 862 台・DevOps の commit 表示・緊急停止 `active=false` を実データとして観測。§6-1 の表で「疑似」と明記されたのは資産管理DB連携／リモート接続／端末状態 | 指摘成立（バナーは ① ② 以外を「未接続」と書いており実測と食い違う） |
| 残る旧 UI 専用機能（親文書） | `docs/101-ops-ui-cutover.md` §7 | `/legacy` でのみ可能: リモート対応の端末特定・RSP 接続・強制切断、フォルダアクセス・サポートセッション。未実装: 端末診断・修復の自動化。緊急停止は新 UI がサーバ保存で正 | バナー修正の根拠として使用 |

### F3. `/legacy` は開くだけで書き込みを送る

| 確認点 | 根拠（file:line） | 読み取れた事実 | 判定 |
|---|---|---|---|
| 状態同期 | `apps/api/src/prototype/bridge.js:95-119` | `sync(true)` を 400ms / 1200ms / 5000ms / `load` で実行し、`setInterval(sync, 500)`・click/input/visibilitychange でも実行。`sync` は `putState` → `sendState` が `PUT /api/state/<name>`（同 `:46-53`、対象は `cowork` と `helpdesk` の 2 キー） | 指摘成立 |
| 端末情報送信 | `apps/api/src/prototype/device-bridge.js:372-385` | `ensureSnapshot` が `POST /api/device/browser` を送る | 指摘成立 |
| 起動時の発火 | 同 `:474-475` | `ensureSnapshot(false)` を初期化時に実行し、以後 10 分ごとに `ensureSnapshot(true)` | 指摘成立 |
| 他のブリッジの自動 POST | `intake-preview-bridge.js:174-190`、`knowledge-review-bridge.js:310-317` ほか | 起動時 sync はパネル生成のみで、POST は入力・クリック時（`/api/intake/preview`・`/api/knowledge/inspect`）。**起動時の自動書き込みは上記 2 系統**という読み | 参考（Phase 2 で network 実測して確定する） |

## 2. Phase 2: 修正レビューと実測のマトリクス

Lead から「修正完了」の連絡後に実施する。実測欄は実施時に追記する（現時点はすべて NOT RUN）。

| ID | 項目 | 期待 | 実測（手段） | 判定 |
|---|---|---|---|---|
| V01 | 設定注記が値比較になっている | `state.settings` の有無ではなく `getSettings()` と `DEF_SET` の値比較で「すべて既定値です」／「既定値から変更されています」を出す。ネスト（`sla` / `std`）も比較対象 | NOT RUN | NOT RUN |
| V02 | 一部だけ既定値と違う場合 | 1 項目でも違えば「変更されています」。ネストの 1 キー（例 `sla.P3`）だけ違う場合も「変更されています」 | NOT RUN | NOT RUN |
| V03 | リセット時の文言が値比較 | 値が既定値なら「すでに既定値です」、違えば確認後に戻す。有無判定が残っていない | NOT RUN | NOT RUN |
| V04 | サーバ保存行なしの `/ops` 表示 | 専用 DB に `ops_settings` 行が無い状態で `/ops` のシステム設定が「すべて既定値です」 | NOT RUN | NOT RUN |
| V05 | 保存→再読込の一貫性 | 既定値と同じ値を保存しても「変更されています」に化けない／本当に変えたら化ける | NOT RUN | NOT RUN |
| V06 | バナー文言が実測と一致 | バナーが docs/102 §6-1 の実データ接続範囲と docs/101 §7 の残機能を正しく述べる。**未実装を実装済みと書かない**。①受付・②AI一次対応だけを「接続済み」と限定していない | NOT RUN | NOT RUN |
| V07 | バナーの「疑似」整合 | 資産管理DB連携・リモート接続・端末状態など「疑似」のものを実データ扱いしていない。旧 UI 専用機能を新 UI で可能と書いていない | NOT RUN | NOT RUN |
| V08 | バナーの配信 | `GET /ops` の HTML に新バナーが入り、`ops.test.ts` の期待が新文言と一致 | NOT RUN | NOT RUN |
| V09 | `?ro=1` のガード挿入 | `GET /legacy?ro=1` にだけ `data-aihd-readonly-guard="1"` と注記が入り、`GET /legacy` には入らない | NOT RUN | NOT RUN |
| V10 | ガードの対象メソッド | POST/PUT/PATCH/DELETE を拒否し、GET/HEAD は素通しする。GET が壊れない | NOT RUN | NOT RUN |
| V11 | `?ro=1` で PUT/POST が出ない | ブラウザで `/legacy?ro=1` を開き、`PUT /api/state/*` と `POST /api/device/browser` が **network に出ない**。GET は通る | NOT RUN | NOT RUN |
| V12 | `?ro=1` の画面表示 | 旧 UI が従来どおり描画される（白画面・JS 例外で止まらない）。注記が見える | NOT RUN | NOT RUN |
| V13 | ro なし `/legacy` の従来挙動 | `?ro` なしでは従来どおり自動同期（PUT/POST）が走る＝通常表示の退行なし（専用 DB で 1 回だけ確認） | NOT RUN | NOT RUN |
| V14 | 権限制御と誤解されない明記 | ソース・docs・注記のいずれかで「検証補助であり権限制御ではない」と読める。サーバ側認可・CSRF・監査は不変 | NOT RUN | NOT RUN |
| V15 | 製品コードの差分範囲 | 変更が `Mirai_AIHelpdesk_OpsConsole_V1.0.html` / `apps/api/src/routes/ops.ts` / テスト / `prototype.ts`（ro ガード）に限定。無関係ファイル・DOM/CSS の無断変更なし | NOT RUN | NOT RUN |
| V16 | 秘密・PII の混入 | 差分に秘密値・実在個人の PII が無い（`\b\d{3,4}-\d{4}\b` 等の電話、メール、トークン様文字列を差分で確認） | NOT RUN | NOT RUN |
| V17 | テストの削除・skip・期待値緩和 | 既存アサーションの削除・`skip`/`todo` 追加・無根拠な期待値緩和が無い | NOT RUN | NOT RUN |
| V18 | ops 系テスト | 専用 DB `aihd_test_verify_20261116` で `ops.test.ts` / `ops-settings.test.ts` / `prototype.test.ts` が全 pass | NOT RUN | NOT RUN |
| V19 | 型・lint | `npm run typecheck`・`npm run lint` が成功（Lead 実施ぶんを確認、必要なら再実行） | NOT RUN | NOT RUN |
| V20 | 既存受入への回帰 | `/ops` の 12 画面・`/legacy` の boot・`/api/state` 往復・CSP 期待が従来どおり | NOT RUN | NOT RUN |

## 3. 実行予定コマンド（秘密値は表示しない）

テスト DB 名は `apps/api/src/lib/test-database.ts` の許可規則
（`^(?:ai_helpdesk_test|aihd_test_[a-z0-9_]+)$`）に合わせて **`aihd_test_verify_20261116`** を使う。

```bash
cd /home/kensan/Projects/Mirai-Admin-Platform/AI-HelpDesk-Platform
set -a; . ./.env.test.local; set +a
export NODE_ENV=test
export AIHD_TEST_DATABASE_NAME=aihd_test_verify_20261116
export DATABASE_URL="$(node -e 'const u=new URL(process.env.DATABASE_URL);u.pathname="/aihd_test_verify_20261116";console.log(u.toString())')"
PGURL="$(node -e 'const u=new URL(process.env.DATABASE_URL);u.pathname="/postgres";console.log(u.toString())')"
psql "$PGURL" -c 'CREATE DATABASE "aihd_test_verify_20261116"' 2>/dev/null || true
npx vitest run apps/api/src/routes/ops.test.ts apps/api/src/routes/ops-settings.test.ts apps/api/src/routes/prototype.test.ts
```

UI 実測（可能な場合）: `AUTH_MODE=local`・専用ポート 18960・専用 DB で API を起動し、`dsh_browser` で
`/ops`（設定表示）と `/legacy?ro=1`（network に PUT/POST が無いこと、GET は通ること）を確認する。
起動したサーバーは必ず停止し、ポートを残さない。ブラウザが使えない場合は HTTP とソース確認で代替し、**未実施と明記**する。

## 4. 証跡

- このディレクトリ: `docs/evidence/release-recheck-20261116/verify/`
  - `plan.md`（本書）
  - `review.md`（Phase 2 の判定・根拠・残リスク・重大度付き指摘）
  - 生ログを残す場合は `raw/` 配下（秘密値を含めない）
