# Track H — 配備整合（H-01〜H-04）実測結果

- 実施: 2026-10-27 09:10〜09:20 JST（verify-h）
- 対象: `docs/38-full-verification-plan-20261026.md` §14-2 Track H
- リポジトリ: `/home/<user>/Projects/Mirai-Admin-Platform/AI-HelpDesk-Platform`（main `84bba83`）
- 専用環境: DB `ai_helpdesk_h`（新規作成）／ インスタンス `:18965`（`AUTH_MODE=local`）
- 制約の順守: 稼働中 `:18950/:18951/:18952/:18954/:18956/:18957` は停止・再起動していない。稼働 dist は上書きしていない。`ai_helpdesk_preview` へは書き込んでいない（読取のみ）。`~/.config/ai-helpdesk/api.conf` は変更していない。
- 秘密情報: DB 認証情報は既存プロセス（PID 2095152）の `/proc/PID/environ` から取得し、**値は証跡に記載していない**。

## サマリ

| ID | 検証内容 | 実測 | 判定 |
|---|---|---|---|
| H-01 | 稼働 dist と main HEAD `84bba83` クリーンビルドの一致 | 稼働 dist は `1bde379` ビルドと完全一致。`84bba83` ビルドとは **5ファイル＋5ソースマップ（10行）差分** | **FAIL** |
| H-02 | `migration 019` 適用済み・再実行冪等 | 新規DBで 019/020 適用 → 2回目 **0適用・20 skip**、正規化スキーマ **sha256 一致** | **PASS** |
| H-03 | `COMMIT_SHA` の是正 | health は `ac8085e`（誤）。正しい値は HEAD ビルド=`84bba83`／実稼働コード=`1bde379`。是正手順を特定・実証。適用は G5 待ち | **PASS（是正可・未適用）** |
| H-04 | ロールバック（dist 差替え＋再起動、DB追加のみ） | 新 dist→health 200、旧 dist へ戻して health 200。DB スキーマ不変・旧コード互換 | **PASS** |

> **H-01 は FAIL。** ただし FAIL の内容は「デプロイ候補（`/tmp/aihd-head`）が誤り」ではなく、**「稼働サービスが候補 dist を配信していない」**（1コミット前のビルドのまま）。候補 dist 自体は `84bba83` のクリーンビルドと完全一致しており、デプロイ（再ビルド＋再起動）で解消される性質の差分である。詳細と G5 への影響は §H-01 と §G5 を参照。

---

## 0. 前提の訂正（重要）

タスク前提「稼働 dist は `/tmp/aihd-head/apps/api/dist`（`84bba83` ビルド）」は**実測と一致しない**。

| 事実 | 実測値 | 証跡 |
|---|---|---|
| サービスの作業ディレクトリ | `WorkingDirectory=/home/<user>/Projects/Mirai-Admin-Platform/AI-HelpDesk-Platform`（リポジトリ本体） | `raw/H01-deployment-facts.txt` |
| 実行コマンド | `node apps/api/dist/index.js`（相対パス＝リポジトリ本体の dist） | 同上 |
| プロセスの cwd | `/proc/2095152/cwd` → リポジトリ本体 | 同上 |
| リポジトリ本体の dist | `1bde379` のクリーンビルドと **diff 0** | `raw/H01-running-is-1bde379.txt` |
| `/tmp/aihd-head` の dist | `84bba83` のクリーンビルドと **diff 0**（worktree HEAD=`84bba83`） | `raw/H01-diff-head.txt`, `raw/H01-deployment-facts.txt` |

**時系列（なぜこうなったか）**

1. `2026-10-26 17:36:44` — リポジトリ本体の `apps/api/dist` をビルド（当時の HEAD 相当）。
2. `2026-10-26 21:24:39` — `1bde379`（UI・Phase 3）マージ。API ソース変更なしのため dist と一致（後述）。
3. `2026-10-26 22:34:29` — `84bba83`（API・Phase 2: RSP 相関ID/出力取込）マージ。
4. `2026-10-26 22:41:15` — サービス再起動。**dist は再ビルドされていない**ため、22:34 の変更を含まないビルド（17:36 ビルド）のまま稼働。
5. `2026-10-27 07:44` — `/tmp/aihd-head`（`84bba83` worktree）で dist がビルドされた（デプロイ候補。サービスとは未接続）。

したがって `/tmp/aihd-head/apps/api/dist` は「正しい `84bba83` ビルドの候補」ではあるが、**稼働中ではない**。

---

## H-01: 稼働 dist と HEAD `84bba83` クリーンビルドの一致 — **FAIL**

### 手法

専用の一時ディレクトリに worktree を切り、リポジトリの `node_modules` をシンボリックリンクしてビルドした。稼働中インスタンスの dist（リポジトリ本体 `/tmp/aihd-head`）へは書き込んでいない。

```bash
REPO=/home/<user>/Projects/Mirai-Admin-Platform/AI-HelpDesk-Platform
rm -rf /tmp/aihd-h-build
git -C "$REPO" worktree add --detach /tmp/aihd-h-build 84bba83
ln -s "$REPO/node_modules" /tmp/aihd-h-build/node_modules
cd /tmp/aihd-h-build
PATH=/home/<user>/.nvm/versions/node/v22.22.3/bin:$PATH npm run build   # tsc -p apps/api/tsconfig.json
```

ビルド環境: node `v22.22.3` / npm `10.9.8` / tsc `5.9.3`（`raw/H01-build-log.txt`）。

### 結果

| 比較 | コマンド | 差分 |
|---|---|---|
| クリーンビルド(`84bba83`) vs `/tmp/aihd-head` dist | `diff -rq` | **0行**（128/128 一致） |
| クリーンビルド(`84bba83`) vs 稼働 dist（リポジトリ本体） | `diff -rq` | **10行**（5 JS + 5 `.js.map`） |
| クリーンビルド(`1bde379`=親) vs 稼働 dist | `diff -rq` | **0行** |
| dist ツリー digest（`84bba83` 候補 / `/tmp/aihd-head`） | 下記コマンド | 両方 `f77351e8…f83113` |
| dist ツリー digest（稼働 dist / 退避コピー） | 同上 | 両方 `6edeb593…c6537d` |

dist ツリー digest の算出（相対パスで整列した各ファイル sha256 の集約）:

```bash
digest() { (cd "$1" && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1); }
digest /tmp/aihd-h-build/apps/api/dist   # f77351e81c0fdc68b9dd68882928a04b031607d9e634586c9f99920329f83113
digest "$REPO/apps/api/dist"             # 6edeb5936aedf6319500e9a82a248d41a5f7aa7d928c4abd24e05332abc6537d
```

### 差分の内容（`raw/H01-diff-running.txt`, `raw/H01-differing-file-hashes.txt`）

| ファイル | `84bba83` にあり稼働 dist に無い機能 |
|---|---|
| `routes/terminal.js` | `rspCommandLogId` / `rspSessionId` の受理・応答 DTO |
| `terminal/session.js` | 相関IDの `COALESCE` 保存（`rsp_session_id` / `rsp_command_log_id` を SQL で参照） |
| `terminal/capture.js` | `outputSource='rsp_command'` の受理経路 |
| `terminal/report.js` | 実行記録への相関ID反映 |
| `domain/final-report.js`（＋ `.js.map` 各1） | 報告書 schema / HTML の相関ID表示 |

トークン出現回数（`raw/H01-feature-tokens.txt`）: `rspCommandLogId` は `84bba83` ビルドで 7回（terminal.js 2 + session.js 5）、稼働 dist で **0回**。`rspSessionId` は 6回（terminal.js 3 + session.js 2 + final-report.js 1）、稼働 dist で **0回**。

### 許容差の検討

`.js.map` も含めて **0行一致**が得られた。worktree のパス（`/tmp/aihd-h-build` vs `/tmp/aihd-head`）が異なってもバイト一致したため、ソースマップは相対パスのみを埋め込み、ビルド時刻・絶対パス・乱数に依存しない。よって「0行」は許容差なしで判定に使える（マップを除いた比較に緩める必要はない）。

> 注: 「稼働 dist」を `/tmp/aihd-head` とみなす前提で読むと H-01 は 0行=PASS になる。しかしサービスが配信しているのはリポジトリ本体の dist であり、そちらは `1bde379` ビルドである。H-01 の趣旨（検証対象＝配備対象の一致）に照らし、**FAIL** と判定する。

---

## H-02: `migration 019` の適用済み・再実行冪等 — **PASS**（＋ `020` 未適用を G5 必須事項として記録）

### 対象ファイルとハッシュ

| ファイル | sha256 |
|---|---|
| `db/migrations/019_terminal_sessions.sql` | `27dad4f286c689c7c994d7058396f13eabc9fc0425e2a6e40bfc2b31872efeae` |
| `db/migrations/020_add_rsp_correlation.sql` | `451a94aa8f6db8127746d7e97c22945573e6dc6e3e5bff9f30f227bc0d9765e6` |

（`raw/H02-migrations-sha.txt`）

### 手順（専用DB `ai_helpdesk_h` を新規作成して実施）

認証情報は `/proc/2095152/environ` の `DATABASE_URL` から取得し、DB 名のみ `ai_helpdesk_h` に差し替えた（値は非表示）。

```bash
createdb ai_helpdesk_h
# NODE_ENV=production では .env.local を読まず（.env は override なしで読む）ため、env の DATABASE_URL が優先される
DATABASE_URL="$TARGET" NODE_ENV=production npx tsx scripts/migrate.ts   # 1回目
DATABASE_URL="$TARGET" NODE_ENV=production npx tsx scripts/migrate.ts   # 2回目
```

### 結果

| 実行 | 適用 | skip | 出力 |
|---|---|---|---|
| 1回目 | **20**（001〜020。019 と 020 を含む） | 0 | `raw/H02-migrate-run1.txt` |
| 2回目 | **0** | **20**（019/020 とも `skip`） | `raw/H02-migrate-run2.txt` |

- `schema_migrations` に `019_terminal_sessions.sql` / `020_add_rsp_correlation.sql` が登録され、`terminal_sessions` / `terminal_steps` が存在（`raw/H02-migrations-019-020.txt`, `raw/H02-terminal_sessions-schema.txt`, `raw/H02-terminal-columns.txt`）。`rsp_session_id` / `rsp_command_log_id` 列も存在。
- スキーマ一致: 1回目後と2回目後の `pg_dump --schema-only` は、pg_dump 18 が毎回ランダム生成する `\restrict` / `\unrestrict` の2行を除いて **完全一致**（正規化後 sha256 が両方 `dd4eea0fb477e0b26ee66968548024e52c8fa730db9996a9faf9e9d5c881dfd4`、`diff` 0行）。`raw/H02-schema-diff-normalized.txt`, `raw/H02-schema-run1.sql`, `raw/H02-schema-run2.sql`。

### 本番DBの状態（読取のみ・書き込みなし）

| 項目 | 実測 |
|---|---|
| `019_terminal_sessions.sql` | 適用済み（`applied_at = 2026-10-26 08:24:26.89889+00` = 17:24 JST。§14-1 の記録と一致） |
| `020_add_rsp_correlation.sql` | **未適用**（`schema_migrations` に行なし） |
| `terminal_sessions.rsp_session_id` / `terminal_steps.rsp_command_log_id` | **存在しない** |

### G5 への含意（重要）

`84bba83` のコードは `rsp_session_id` / `rsp_command_log_id` を SQL で参照する（`raw/H01-H02-020-requirement.txt`: `84bba83` ビルドで `rsp_session_id` 3回・`rsp_command_log_id` 2回、稼働 dist では 0回）。したがって **`020` を適用せずに `84bba83` を起動すると、RSP 実行記録の保存経路（`POST /api/terminal/steps/:id/record` の `rsp_command` 受理・相関ID保存）が列不存在で失敗する**。デプロイ手順に `npx tsx scripts/migrate.ts`（020 適用）を必須として追加する必要がある。019/020 はともに追加のみ（`CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` / CHECK の張り替えは既存値 `auto`/`manual`/`NULL` を許容）で、旧コードとの互換性は H-04 で実測済み。

---

## H-03: `COMMIT_SHA` の是正 — **PASS（是正可・未適用）**

### 実測

`GET http://127.0.0.1:18950/api/health` → **HTTP 200**（`raw/H03-health-18950.json`, `raw/H03-health-18950.headers`）:

```json
{"ok":true,"service":"ai-helpdesk-api","version":"0.1.0","commit":"ac8085e","db":"ok","time":"2026-10-27T00:12:08.400Z","env":"production"}
```

- 現状の `commit` は `ac8085e`。**ビルド元コミットではない固定値**。
- 正しい値:
  - HEAD（`84bba83`）をビルドして配備する場合 → **`84bba83`**
  - **現に稼働しているコード**（`1bde379` ビルド）に合わせる場合 → `1bde379`（H-01 のとおり）
- plan §14-2 の期待値 `9e7d776` は当時の HEAD。現在の HEAD は `84bba83` のため、デプロイ後の是正値は `84bba83`。

### 仕組み（なぜ設定だけでは不十分か）

`health` の `commit` は `config.COMMIT_SHA` をそのまま返すだけ（`apps/api/src/routes/health.ts:15,26`）。値の出所は `~/.config/ai-helpdesk/api.conf:32` の `COMMIT_SHA=ac8085e` で、systemd の `EnvironmentFile` として**起動時に読み込まれる**（`raw/H03-commit-sha-wiring.txt`）。ビルド成果物と結び付いていない。

:18965 で実証（`raw/H03-mislabel-demo-health.json`）: **旧 dist（`1bde379` ビルド）のまま `COMMIT_SHA=84bba83` を渡すと health は `commit:"84bba83"` を返す**（200・db ok）。つまり設定変更だけでは「コードと commit の一致」を保証できず、かえって誤表示になり得る。

### 是正手順（G5 承認後に Lead が実施。今回は未実施）

```bash
REPO=/home/<user>/Projects/Mirai-Admin-Platform/AI-HelpDesk-Platform
# 1) ビルド元コミットを確定（配備する dist を作った commit）
git -C "$REPO" rev-parse HEAD            # => 84bba838...（short: 84bba83）

# 2) 設定をバックアップして COMMIT_SHA を更新
cp -p ~/.config/ai-helpdesk/api.conf ~/.config/ai-helpdesk/api.conf.bak-$(date +%Y%m%d-%H%M%S)
sed -i 's/^COMMIT_SHA=.*/COMMIT_SHA=84bba83/' ~/.config/ai-helpdesk/api.conf

# 3) 再起動（EnvironmentFile は起動時に読まれる）
systemctl --user restart ai-helpdesk-api

# 4) 確認（commit と db、そして dist が候補と一致していること）
curl -s http://127.0.0.1:18950/api/health
diff -rq "$REPO/apps/api/dist" /tmp/aihd-head/apps/api/dist   # 0行が前提
```

**順序の要件**: 先に dist を `84bba83` に更新（ビルド＋配置）し、同じメンテナンス窓で `COMMIT_SHA` を更新して再起動する。dist が旧のまま `COMMIT_SHA` だけ更新すると、health が実態と異なる値を返す（上記 mislabel 実証）。

### 恒久化の提案（ビルド時自動設定）

**案A（推奨）: ビルド時に dist へ commit を埋め込む**

- `apps/api` の build を `node scripts/write-build-info.mjs && tsc -p tsconfig.json` に変更し、`apps/api/dist/build-info.json` へ `{ "commit": "<short sha>", "dirty": <bool>, "builtAt": "<ISO>" }` を出力（`dirty` は `git status --porcelain --untracked-files=no` で判定）。
- `config.ts` で `COMMIT_SHA`（env）→ 無ければ `dist/build-info.json` の `commit` → 無ければ空、の順に解決。
- 利点: ラベルが**ビルド成果物に固定**され、`api.conf` の手修正が不要。`dirty` で未コミット混入も検出できる。
- 受入: デプロイ後スモーク S1 に「`health.commit == git rev-parse --short=7 HEAD`」かつ「dist ツリー digest が候補と一致」を追加する。

**案B（コード変更なし・暫定）: systemd ExecStart で包む**

```
ExecStart=/bin/sh -c 'exec env COMMIT_SHA=$(git -C /home/<user>/Projects/Mirai-Admin-Platform/AI-HelpDesk-Platform rev-parse --short=7 HEAD) /home/<user>/.nvm/versions/node/v22.22.3/bin/node apps/api/dist/index.js'
```

- 利点: unit 1行で済む。欠点: 実行時 HEAD と dist の対応は保証されない（再ビルドしない再起動で再び不整合）。恒久策は案A。

---

## H-04: ロールバック実証 — **PASS**

### 手順（再実行可能。:18965 で実測）

```bash
REPO=/home/<user>/Projects/Mirai-Admin-Platform/AI-HelpDesk-Platform
RUN=/tmp/aihd-h-run

# 起動用レイアウト（リポジトリの node_modules を共有）
mkdir -p "$RUN/apps/api"
ln -sfn "$REPO/node_modules" "$RUN/node_modules"

# デプロイ前 dist の退避（今回は稼働 dist = 1bde379 ビルド）
cp -a "$REPO/apps/api/dist" "$RUN/dist-old"

# 新 dist（84bba83 候補）で起動
cp -a /tmp/aihd-h-build/apps/api/dist "$RUN/apps/api/dist"
cd "$RUN"
setsid env NODE_ENV=development HOST=127.0.0.1 PORT=18965 AUTH_MODE=local \
  DEV_AUTH_EMAIL=owner@*** SESSION_SECRET=$(openssl rand -hex 32) \
  MAIL_TRANSPORT=disabled DATABASE_URL="$TARGET" COMMIT_SHA=84bba83 \
  ACCESS_JWT_MODE=off node apps/api/dist/index.js > run-new.log 2>&1 &
curl -s -o new-health.json -w '%{http_code}\n' http://127.0.0.1:18965/api/health

# ロールバック: 停止 → dist 差替え → 同一コマンドで再起動（COMMIT_SHA は旧値）
PID=$(ss -ltnp | grep 18965 | grep -oP 'pid=\K[0-9]+'); kill -TERM "$PID"; sleep 2
rm -rf "$RUN/apps/api/dist" && cp -a "$RUN/dist-old" "$RUN/apps/api/dist"
# COMMIT_SHA=1bde379 で再起動し health を確認
```

`TARGET` は `/proc/2095152/environ` の `DATABASE_URL` の DB 名を `ai_helpdesk_h` にしたもの（値は非表示）。

> `NODE_ENV=production` は `AUTH_MODE=local` を起動拒否する（`apps/api/src/config.ts:126`）ため、検証用 :18965 は `development` で起動した。`/api/health` と DB 接続の確認には影響しない。`MAIL_TRANSPORT=disabled` で実メール送信を止めている。

### 実測

| 段階 | dist | `COMMIT_SHA` | health | その他 |
|---|---|---|---|---|
| 新 dist 起動 | `84bba83`（`f77351e8…`） | `84bba83` | **200** `{"ok":true,"commit":"84bba83","db":"ok","env":"development"}`（`raw/H04-new-health-84bba83.json`） | `GET /api/terminal/cases` **200** `{"ok":true,"items":[]}` |
| **ロールバック** | `1bde379`（`6edeb593…`） | `1bde379` | **200** `{"ok":true,"commit":"1bde379","db":"ok"}`（`raw/H04-rollback-health-1bde379.json`） | `GET /api/terminal/cases` **200** |
| 参考（mislabel 実証） | `1bde379` | `84bba83` | 200 だが commit 表示は `84bba83`（H-03 参照） | — |

ログ: `raw/H04-run-new.log`, `raw/H04-run-rollback.log`。

### DB 追加のみで戻せることの確認

- ロールバック前後で `pg_dump --schema-only` の正規化 sha256 は **`dd4eea0f…` のまま不変**（`raw/H04-schema-after-rollback.sql`, `raw/H04-tables-after-rollback.txt`）。`terminal_sessions` / `terminal_steps` も保持。
- 019/020 適用済み（`rsp_*` 列あり）の DB に対して **旧コード（`1bde379`）が health 200・db ok で稼働**した。追加列は旧コードの SELECT/INSERT に影響せず、**DB のロールバック（列削除・dump 復元）は不要**。
- 復元が必要になるのは破損時のみ。§14-6 の「DB は追加のみ・破損時のみ dump から復元」と整合。

### デプロイ時に推奨する退避（G5 手順への追記）

```bash
STAMP=$(date +%Y%m%d-%H%M%S)
tar -czf "/tmp/aihd-api-dist-$STAMP.tar.gz" -C "$REPO" apps/api/dist
digest() { (cd "$1" && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1); }
digest "$REPO/apps/api/dist" | tee "/tmp/aihd-api-dist-$STAMP.sha256"
```

ロールバック完了条件（§14-6）は「health の commit が是正値になり 200」。今回は旧 dist に対して `commit=1bde379`・200 を実測し、手順が成立することを確認した。

---

## G5 判断に必要な事実（Lead 向け）

1. **配備対象の一致（H-01）**: 稼働 `:18950` は `1bde379` ビルドを配信しており、`84bba83` の変更（RSP 相関ID・出力取込の Phase 2）は稼働していない。`/tmp/aihd-head` は `84bba83` のクリーンビルドと完全一致（128ファイル・digest `f77351e8…`）しており、**デプロイ候補としては正しい**。G5 の「H 4/4」は現状未達で、解消には「ビルド＋配置＋再起動」が必要（＝デプロイそのもの）。
2. **migration（H-02）**: `019` は本番 `ai_helpdesk_preview` に適用済み（10/26 17:24 JST）。再実行は冪等（新規DBで 2回目 0適用・スキーマ一致）。**ただし `020` は本番DBに未適用**で、`84bba83` は `020` の列を参照する。**デプロイ手順に migrate（020）の実行を必須で追加**すること。追加のみのため旧コード互換（H-04 実測）。
3. **`COMMIT_SHA` 是正（H-03）**: `api.conf` の1行（`COMMIT_SHA=ac8085e` → `84bba83`）＋再起動で是正可能。ただし設定はビルドと無関係なラベルであり、**dist 更新と同時に行う**必要がある（設定単独では誤表示になることを実証）。恒久策はビルド時埋め込み（案A）を推奨。
4. **ロールバック（H-04）**: dist を退避して差し替え＋再起動で health 200 に戻せる。DB は追加のみで旧コード互換のため、DB ロールバック不要。所要は「停止→dist 差替え→起動→health 確認」。
5. **本番操作は未実施**: サービス再起動・`api.conf` 変更・`ai_helpdesk_preview` への migrate は行っていない（指示どおり G5 判断待ち）。`ai_helpdesk_preview` へは読取のみ。

---

## 付録: 証跡ファイル（`docs/evidence/verify-20261027/deploy/raw/`）

| ファイル | 内容 |
|---|---|
| `H01-build-log.txt` | クリーンビルドの環境・コマンド・出力 |
| `H01-deployment-facts.txt` | systemd unit・PID/cwd/cmdline・HEAD・dist ビルド時刻 |
| `H01-diff-head.txt` | `84bba83` ビルド vs `/tmp/aihd-head`（0行） |
| `H01-diff-running.txt` | `84bba83` ビルド vs 稼働 dist（10行） |
| `H01-running-is-1bde379.txt` | `1bde379` ビルド vs 稼働 dist（0行） |
| `H01-dist-digests.txt` | 4つの dist ツリー digest とファイル数 |
| `H01-differing-file-hashes.txt` | 差分5ファイル＋map の個別 sha256 |
| `H01-feature-tokens.txt` | `rspCommandLogId`/`rspSessionId` の出現回数比較 |
| `H01-H02-020-requirement.txt` | 020 列をコードが参照している証跡 |
| `H02-migrate-run1.txt` / `H02-migrate-run2.txt` | 1回目 20適用 / 2回目 0適用・20 skip |
| `H02-migrations-019-020.txt` | `schema_migrations` の 019/020 行 |
| `H02-migrations-sha.txt` | 019/020 のファイル sha256 |
| `H02-schema-run1.sql` / `H02-schema-run2.sql` | 冪等前後のスキーマダンプ |
| `H02-schema-diff-normalized.txt` | 正規化後スキーマの一致（sha256 同一・diff 0） |
| `H02-terminal_sessions-schema.txt` / `H02-terminal-columns.txt` | テーブル定義・列一覧 |
| `H03-health-18950.json` / `.headers` | 本番 health の実レスポンス（raw） |
| `H03-commit-sha-wiring.txt` | health/config のコード、`api.conf` 該当行、EnvironmentFile |
| `H03-mislabel-demo-health.json` / `H03-mislabel-demo.log` | 設定だけ変えた場合の誤表示実証 |
| `H04-new-health-84bba83.json` / `H04-rollback-health-1bde379.json` | 新 dist / 旧 dist の health |
| `H04-new-cases.json` / `H04-rollback-cases.json` | DB 参照エンドポイントの 200 応答 |
| `H04-run-new.log` / `H04-run-rollback.log` | 起動ログ（接続先 DB・port・commit） |
| `H04-schema-after-rollback.sql` / `H04-tables-after-rollback.txt` | ロールバック後の DB スキーマ（不変） |

## 未実施・制約

- 本番サービスの再起動、`~/.config/ai-helpdesk/api.conf` の変更、`ai_helpdesk_preview` への書き込み（migrate）は**未実施**（G5 判断待ち）。本番DBへは `schema_migrations` 等の読取のみ。
- ロールバックの実証は :18965 の手動プロセスで行った。**systemd 経由の本番切替**（`systemctl --user restart`）は未実測（G5 後に S1〜S7 で確認）。
- `:18965` は `NODE_ENV=development`（`production` は `AUTH_MODE=local` を拒否するため）。本番は `cloudflare-access` であり、認証経路の差は H-01〜H-04 の判定に影響しない。
- 検証用に作成した `/tmp/aihd-h-build`（worktree, `84bba83`）, `/tmp/aihd-h-run`（起動用レイアウト・退避 dist コピー）は証跡再現用に残置。DB `ai_helpdesk_h` も残置。
