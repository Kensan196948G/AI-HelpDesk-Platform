# Ralph round 1 — Staging 受入 / 本番プレフライト 独立再測定

- 測定日時: 2026-11-06T08:32:19+09:00 〜 2026-11-06T08:34:58+09:00 (JST)
- 測定対象: /home/kensan/Projects/Mirai-Admin-Platform/AI-HelpDesk-Platform
- 測定者: Ralph worker round 1（前回ハンドオフなし・独立再測定）
- 方式: read-only。curl は `--noproxy '*'`、systemd は `show` / `is-enabled` / `is-active`、プロセス実体は `/proc/<pid>/cwd` と `ss` で確認。
- 遵守事項: `systemctl` の start/stop/restart/enable/disable/daemon-reload、DB への INSERT/UPDATE/DELETE/DDL、git commit/push/merge/branch 操作、`npm run build`、`apps/api/dist` への書き込み、秘密ファイル（`api.conf`・`*.env`）の読取、GitHub 操作は一切実施していない。作成したファイルは本ファイルのみ。書き込み拒否の実測は「拒否されること」の確認を目的とした試行で、全試行が EPERM・生成物なし（対象の mtime も不変）。
- 秘密ファイルの**内容は一切未読**。ディレクトリ一覧（`ls`/`find`）に mode・size が表示される範囲のメタデータのみ観測しており、意図的な `stat` 参照や `cat` は行っていない。

## 0. 前提確認（受入条件外・注記）

| 項目 | 実測値 | 測定時刻 (JST) |
|---|---|---|
| 作業ツリー HEAD | `b1ffb5208ec5120b6fa2185518925c54beadeaba`（docs: CTOバッチ1 の実測記録追加） | 2026-11-06T08:33:22+09:00 |
| origin/main | `46261ea1eb3152287457d0c25e42a80106bc2a58` | 2026-11-06T08:33:22+09:00 |
| origin/docs/cto-batch1-20261106（upstream） | `b1ffb5208ec5120b6fa2185518925c54beadeaba`（HEAD と一致） | 2026-11-06T08:33:22+09:00 |
| HEAD...origin/main（ahead/behind） | ahead 1 / behind 0（`git rev-list --left-right --count`） | 2026-11-06T08:33:22+09:00 |

**注記:** 目的文の前提「git HEAD は origin/main と同期済み」は厳密には成立しない。HEAD は origin/main より **docs 専用 1 コミット先行**（behind 0）であり、upstream（origin/docs/cto-batch1-20261106）とは一致している。一方、Staging release と Staging health の commit は `46261ea1…`（= origin/main）であり、デプロイ対象コードは origin/main と一致する。この前提差異は受入条件 (1)–(6) の判定には影響しないが、事実として記録する。

## 1. 判定サマリ

| # | 受入条件 | 判定 | 主要根拠 |
|---|---|---|---|
| (1) | Staging health 18952 / proxy health 18951 の HTTP status・ok・db・commit | **PASS** | 両方 HTTP 200 / `ok:true` / `db:"ok"` / commit `46261ea1…` |
| (2) | `/home/kensan/ai-helpdesk-stg/current` の解決先・mode・書き込み拒否 | **PASS** | → `releases/20261106T082716-46261ea1eb31`、dir `500`、配信ファイル `400`、書込4試行すべて EPERM |
| (3) | `systemctl --user` の 3 サービス状態 / 3 timer の is-enabled / 直近 Result・ExecMainStatus | **PASS** | 3 サービス active/running・NRestarts 0、3 timer enabled+active、直近 Result=success/ExecMainStatus=0 |
| (4) | 本番 `ai-helpdesk-api` の MainPID/NRestarts と health commit | **PASS** | MainPID 2379216 / NRestarts 0、18950 health commit `a5e0a671…` |
| (5) | `/home/kensan/ai-helpdesk-prod` の release 一覧・current の有無・`ai-helpdesk-prod-api.service` の有無 | **PASS**（記録完了） | release 1 件、current 無し、prod-api unit 無し（not-found） |
| (6) | 各行の測定時刻（JST）付与・未確認の明記 | **PASS** | 全表に測定時刻列を付与。未確認は §7 に明記（成功扱いしない） |

総合: **受入条件 (1)–(5) はすべて PASS**。未確認項目は §7 のとおりで、成功扱いにはしていない。

## 2. 受入条件 (1) — Staging / proxy health

コマンド: `curl -sS --noproxy '*' -m 5 -w '\nHTTP_STATUS:%{http_code}' http://127.0.0.1:<port>/api/health`

| エンドポイント | HTTP status | ok | db | commit | レスポンス時刻 (UTC) | 測定時刻 (JST) |
|---|---|---|---|---|---|---|
| Staging API `http://127.0.0.1:18952/api/health` | 200 | true | ok | `46261ea1eb3152287457d0c25e42a80106bc2a58` | 2026-11-05T23:33:56.236Z | 2026-11-06T08:33:56+09:00 |
| Staging proxy `http://127.0.0.1:18951/api/health` | 200 | true | ok | `46261ea1eb3152287457d0c25e42a80106bc2a58` | 2026-11-05T23:33:56.253Z | 2026-11-06T08:33:56+09:00 |
| （参考）本番 `http://127.0.0.1:18950/api/health` | 200 | true | ok | `a5e0a6719699d4711fc1811bbdb79c74d9aab393` | 2026-11-05T23:33:56.287Z | 2026-11-06T08:33:56+09:00 |

補足（同一性・安定性の確認）:
- 先行測定（2026-11-06T08:32:19+09:00）でも 18952/18951 は同一 commit・`ok:true`・`db:"ok"`・HTTP 200 で、再測定と一致した。
- リスニング実体（`ss -ltnp`、測定時刻 2026-11-06T08:34:58+09:00）: 18952 → pid 1958657、18951 → pid 1945305、18950 → pid 2379216。いずれも `127.0.0.1` バインド。
- プロセス cwd（`/proc/<pid>/cwd`、測定時刻 2026-11-06T08:34:58+09:00）: 1958657 と 1945305 は `/home/kensan/ai-helpdesk-stg/releases/20261106T082716-46261ea1eb31`、2379216 はリポジトリ作業ディレクトリ。
- レスポンス JSON の `env` は 3 エンドポイントとも `"production"`。これは観測値として記録する（判定対象外）。

**判定: PASS**（両エンドポイントとも HTTP 200 / ok / db / commit を記録）。

## 3. 受入条件 (2) — `/home/kensan/ai-helpdesk-stg/current`

| 項目 | 実測値 | 測定時刻 (JST) |
|---|---|---|
| `current` シンボリックリンク | `lrwxrwxrwx kensan:kensan` → `/home/kensan/ai-helpdesk-stg/releases/20261106T082716-46261ea1eb31`（`readlink -f` も同値） | 2026-11-06T08:33:56+09:00 |
| 解決先ディレクトリ mode | ディレクトリ `500`（`dr-x------`）uid=1000 gid=1000 | 2026-11-06T08:33:56+09:00 |
| 配信ファイル mode（API エントリ） | `apps/api/dist/index.js` `400`（`-r--------`, 1585 bytes） | 2026-11-06T08:33:56+09:00 |
| 配信ファイル mode（manifest） | `dist-manifest.json` `400`（`-r--------`, 26917 bytes） | 2026-11-06T08:33:56+09:00 |
| 配信ファイル mode（package.json） | `apps/api/package.json` `400`（`-r--------`, 588 bytes） | 2026-11-06T08:33:56+09:00 |
| 書き込み拒否・試行1: ディレクトリ作成 | `mkdir …/.ralph-probe3-dir` → exit 1, `Permission denied` | 2026-11-06T08:34:41+09:00 |
| 書き込み拒否・試行2: ファイル作成 | `: > …/.ralph-probe3-file` → exit 1, `Permission denied` | 2026-11-06T08:34:41+09:00 |
| 書き込み拒否・試行3: 既存ファイル追記 | `printf x >> …/dist-manifest.json` → exit 1, `Permission denied` | 2026-11-06T08:34:41+09:00 |
| 書き込み拒否・試行4: `touch` | `touch …/scripts/.ralph-probe3` → exit 1, `Permission denied` | 2026-11-06T08:34:41+09:00 |
| 事後確認: 生成物の不存在 | probe 3 点すべて absent（YES） | 2026-11-06T08:34:41+09:00 |
| 事後確認: mtime 不変 | ディレクトリ `2026-11-06 08:27:32.272023654 +0900`、`dist-manifest.json` `2026-11-06 08:27:32.066012370 +0900`（測定開始前から不変） | 2026-11-06T08:34:41+09:00 |
| `test -w`（参考） | `DIR_WRITABLE=NO` | 2026-11-06T08:33:56+09:00 |
| release 一覧 | `20261106T082610-ba2137057c5c`、`20261106T082716-46261ea1eb31`（current の解決先は後者） | 2026-11-06T08:33:22+09:00 |

**判定: PASS**（読み取り専用 release として解決・mode 500/400・書き込み 4 試行すべて拒否を実測）。

## 4. 受入条件 (3) — `systemctl --user`（Staging services / timers）

### 4.1 Staging サービス 3 基

| ユニット | ActiveState / SubState | MainPID | NRestarts | Result | ExecMainStatus | UnitFileState | 測定時刻 (JST) |
|---|---|---|---|---|---|---|---|
| `ai-helpdesk-stg-postgres` | active / running | 781949 | 0 | success | 0 | enabled | 2026-11-06T08:33:22+09:00 |
| `ai-helpdesk-stg-api` | active / running | 1958657 | 0 | success | 0 | enabled | 2026-11-06T08:33:22+09:00 |
| `ai-helpdesk-stg-proxy` | active / running | 1945305 | 0 | success | 0 | enabled | 2026-11-06T08:33:22+09:00 |

### 4.2 timer 3 基（is-enabled）

| タイマー | is-enabled | is-active | 測定時刻 (JST) |
|---|---|---|---|
| `ai-helpdesk-stg-backup.timer` | enabled | active | 2026-11-06T08:33:22+09:00 |
| `ai-helpdesk-stg-restore-drill.timer` | enabled | active | 2026-11-06T08:33:22+09:00 |
| `ai-helpdesk-stg-healthcheck.timer` | enabled | active | 2026-11-06T08:33:22+09:00 |

### 4.3 timer が起動するサービスの直近 Result / ExecMainStatus

| サービス | ActiveState | Result | ExecMainStatus | 直近 ExecMainExitTimestamp | 測定時刻 (JST) |
|---|---|---|---|---|---|
| `ai-helpdesk-stg-backup.service` | inactive / dead | success | 0 | Fri 2026-11-06 08:28:04 JST | 2026-11-06T08:33:22+09:00 |
| `ai-helpdesk-stg-restore-drill.service` | inactive / dead | success | 0 | Fri 2026-11-06 08:28:09 JST | 2026-11-06T08:33:22+09:00 |
| `ai-helpdesk-stg-healthcheck.service` | inactive / dead | success | 0 | Fri 2026-11-06 08:33:02 JST | 2026-11-06T08:33:22+09:00 |

補足: healthcheck サービスの直近終了は 08:28:02 → 08:33:02 に更新されており（先行測定 08:32:31 と本測定 08:33:22 の比較）、5 分周期の timer が実際に発火していることを裏付ける。timer サービスは oneshot のため inactive/dead が正常。

補足（実体確認）: `ai-helpdesk-stg-api` の ExecStart は `node /home/kensan/ai-helpdesk-stg/current/apps/api/dist/index.js`、`ai-helpdesk-stg-proxy` は `node /home/kensan/ai-helpdesk-stg/current/scripts/proxy-sidecar.mjs`（WorkingDirectory も `/home/kensan/ai-helpdesk-stg/current`）。pid 1958657/1945305 の cwd は解決先 release と一致。

**判定: PASS**（3 サービス active・NRestarts 0、3 timer enabled+active、直近 Result=success / ExecMainStatus=0）。

## 5. 受入条件 (4) — 本番 `ai-helpdesk-api`

| 項目 | 実測値 | 測定時刻 (JST) |
|---|---|---|
| ActiveState / SubState | active / running | 2026-11-06T08:33:22+09:00 |
| MainPID | 2379216 | 2026-11-06T08:33:22+09:00 |
| NRestarts | 0 | 2026-11-06T08:33:22+09:00 |
| Result / ExecMainStatus | success / 0 | 2026-11-06T08:33:22+09:00 |
| UnitFileState | enabled | 2026-11-06T08:33:22+09:00 |
| ExecMainStartTimestamp | Wed 2026-11-04 10:04:02 JST | 2026-11-06T08:33:22+09:00 |
| health `http://127.0.0.1:18950/api/health` | HTTP 200 / `ok:true` / `db:"ok"` / commit `a5e0a6719699d4711fc1811bbdb79c74d9aab393` | 2026-11-06T08:33:56+09:00 |
| プロセス cwd | `/home/kensan/Projects/Mirai-Admin-Platform/AI-HelpDesk-Platform`（リポジトリ作業ディレクトリ） | 2026-11-06T08:34:58+09:00 |

**判定: PASS**（MainPID・NRestarts・health commit を記録）。

## 6. 受入条件 (5) — `/home/kensan/ai-helpdesk-prod`

| 項目 | 実測値 | 測定時刻 (JST) |
|---|---|---|
| release 一覧 | 1 件: `20261106T071603-e7d7f6f9dc94`（ディレクトリ mode `500`） | 2026-11-06T08:33:22+09:00 |
| `current` の有無 | **無し**（`ls` は ENOENT / `test -e` = NO） | 2026-11-06T08:33:22+09:00 |
| `ai-helpdesk-prod-api.service` の有無 | **無し**（`LoadState=not-found`, `ActiveState=inactive`、unit ファイルも不存在） | 2026-11-06T08:33:22+09:00 |
| preflight 記録 `state/deploy-20261106T071603-e7d7f6f9dc94.json` | `result: "dry-run"`, `ref: "e7d7f6f9dc945bff48419b020bab40696fe05e3f"`, `previous: null`, `healthPort: 18950`, `at: "2026-11-05T22:16:19.052Z"` | 2026-11-06T08:33:22+09:00 |
| `shared/` の有無 | 無し（ENOENT） | 2026-11-06T08:33:22+09:00 |

**判定: PASS（記録完了）**。観測値は「release 1 件・current 無し・prod-api unit 無し」。

**注記（重要な整合性）:** 本番で稼働中のユニットは `ai-helpdesk-prod-api.service` ではなく `ai-helpdesk-api.service`（受入条件 (4) と整合）であり、その稼働 commit は `a5e0a671…`、cwd はリポジトリ作業ディレクトリ。一方、prod に配置済みの release の ref は `e7d7f6f9…` で、deploy 記録は `dry-run`。したがって本番は **staged release へ未切替（current 未作成）** の状態であり、稼働 commit と staged release の ref は一致しない。これは「本番プレフライト（dry-run）段階」の観測事実であり、上記記録は成功扱いの捏造ではなく実測値である。切替の成否は本 round の受入対象外（変更禁止）。

## 7. 未確認（成功扱いにしない）

1. **秘密ファイルの実値**: `/home/kensan/.config/ai-helpdesk/stg-api.conf`、`release.env`、`api.conf`、`.env.example` は読取禁止のため**内容未読**。環境変数の実値・接続文字列は **未確認**（ディレクトリ一覧に現れる mode/size のみ観測、内容は不可視）。
2. **DB の実データ内容**: 変更禁止のため書込検証は行わず、テーブル内容・件数も本受入では未取得 → **未確認**（health の `db:"ok"` のみ確認）。
3. **release 内容の全件照合**: `dist-manifest.json` と配信ファイル全件のハッシュ照合は未実施 → **未確認**（manifest の存在・mode のみ確認）。
4. **prod staged release と git ref の一致照合**: `20261106T071603-e7d7f6f9dc94` の内容が `e7d7f6f9…` と一致するかの git 照合は未実施 → **未確認**（ディレクトリ名と deploy 記録のみ）。
5. **`systemctl --user` のユニットファイル内容**: `FragmentPath` の存在は確認したが、ユニットファイル本文（ExecStart 以外の詳細）は未確認 → **未確認**（`show` の公開プロパティのみ）。

## 8. 総合判定

- 受入条件 (1) Staging health / proxy health: **PASS**
- 受入条件 (2) `current` 解決・mode・書込拒否: **PASS**
- 受入条件 (3) systemd サービス 3 基 / timer 3 基 / 直近 Result: **PASS**
- 受入条件 (4) 本番 `ai-helpdesk-api` MainPID/NRestarts/health commit: **PASS**
- 受入条件 (5) prod release 一覧・current 有無・prod-api unit 有無: **PASS（記録完了）**
- 受入条件 (6) 測定時刻（JST）付与・未確認明記: **PASS**

**結論: 受入条件 (1)–(6) を満たす。未確認項目（§7）は存在するが、いずれも禁止事項（秘密ファイル読取・DB 変更・git 変更）または本受入の範囲外に起因し、PASS 判定には算入していない。**

## 9. 証跡（実行コマンド）

```bash
# (1) health（--noproxy '*' 必須）
curl -sS --noproxy '*' -m 5 -w 'HTTP_STATUS:%{http_code}' http://127.0.0.1:18952/api/health
curl -sS --noproxy '*' -m 5 -w 'HTTP_STATUS:%{http_code}' http://127.0.0.1:18951/api/health
curl -sS --noproxy '*' -m 5 -w 'HTTP_STATUS:%{http_code}' http://127.0.0.1:18950/api/health

# (2) symlink / mode / 書込拒否
ls -ld /home/kensan/ai-helpdesk-stg/current
readlink -f /home/kensan/ai-helpdesk-stg/current
stat -c '%n mode=%a(%A) uid=%u gid=%g' "$(readlink -f /home/kensan/ai-helpdesk-stg/current)"
stat -c '%n mode=%a(%A) size=%s' .../apps/api/dist/index.js .../dist-manifest.json .../apps/api/package.json
mkdir  "$REL/.ralph-probe3-dir"; : > "$REL/.ralph-probe3-file"
printf 'x' >> "$REL/dist-manifest.json"; touch "$REL/scripts/.ralph-probe3"   # 全試行 EPERM

# (3)(4) systemd
systemctl --user show ai-helpdesk-stg-postgres -p ActiveState -p SubState -p MainPID -p NRestarts -p Result -p ExecMainStatus -p UnitFileState
systemctl --user show ai-helpdesk-stg-api      -p ActiveState -p SubState -p MainPID -p NRestarts -p Result -p ExecMainStatus -p UnitFileState
systemctl --user show ai-helpdesk-stg-proxy    -p ActiveState -p SubState -p MainPID -p NRestarts -p Result -p ExecMainStatus -p UnitFileState
systemctl --user is-enabled ai-helpdesk-stg-{backup,restore-drill,healthcheck}.timer
systemctl --user show ai-helpdesk-stg-{backup,restore-drill,healthcheck}.service -p ActiveState -p Result -p ExecMainStatus -p ExecMainExitTimestamp
systemctl --user show ai-helpdesk-api -p ActiveState -p SubState -p MainPID -p NRestarts -p Result -p ExecMainStatus -p UnitFileState -p ExecMainStartTimestamp

# (5) prod ツリー / unit 有無
ls -la /home/kensan/ai-helpdesk-prod/ /home/kensan/ai-helpdesk-prod/releases/
ls -ld /home/kensan/ai-helpdesk-prod/current           # ENOENT
systemctl --user show ai-helpdesk-prod-api.service -p LoadState -p ActiveState   # not-found

# 実体確認
ss -ltnp | grep -E '127\.0\.0\.1:(18950|18951|18952)'
readlink /proc/1958657/cwd; readlink /proc/1945305/cwd; readlink /proc/2379216/cwd
```

- 測定は単一セッション内で完結。生成物は本ファイル `docs/evidence/ralph-verify-20261106/round1.md` のみ。
- 生の curl レスポンス・stat 値は本文 §2–§6 に転記済み。
