# Staging 全面 read-only 監査（Step2）実測記録 — 2026-11-06 JST

作業ディレクトリ: `/home/kensan/Projects/Mirai-Admin-Platform/AI-HelpDesk-Platform`
測定時 HEAD: `e7d7f6f`（branch `main`）
タイムゾーン: JST（`+09:00`）。health JSON 内の `time` は UTC。
担当: stg-auditor（共有タスク task-1 / Step2）

---

## 0. 結論（先に要点）

**総合判定: 部分合格。Staging は「API 稼働・DB 接続・release 配信物の一致」までは成立しているが、proxy（18951）が稼働せず、Staging 専用の監視／定期バックアップが未実装であり、受入完了・昇格 GO ではない。**

| # | 監査項目 | 結果 | 判定 |
|---|---|---|---|
| (a) | `/api/health` 18952 | T1（08:06:50）は `commit:""`（空）。**T2（08:08:39 以降）は `commit:"359cbd0…"`** | T1 不合格 → T2 合格（ただし後述の外部変更後） |
| (a) | `/api/health` 18951 | **接続不可（ECONNREFUSED / HTTP 502）** | **不合格** |
| (b) | `ai-helpdesk-stg-api` | active/running。T1 MainPID 798937 → T2 1701354 | 合格（稼働） |
| (b) | `ai-helpdesk-stg-postgres` | active/running、MainPID 781949、NRestarts 0 | 合格 |
| (b) | `ai-helpdesk-stg-proxy` | **inactive/dead、MainPID 0**（08:07:33〜08:08:08 に 15 回再起動ループ） | **不合格** |
| (c) | `current` 解決先 | `releases/20261106T063553-359cbd012274` | 合格 |
| (c) | `release.env` | 存在（130 bytes / mode 600）を観測。**本文は未確認**（読取が承認ポリシーで自動拒否） | **一部未確認** |
| (d) | dist-manifest 検証 | `DIST_MANIFEST_OK 082e815b…8481b`（exit 0、196 files / 98 js） | 合格（manifest↔dist 一致） |
| (e) | DB 5437 / ai_helpdesk_stg | migration 37 / public table 35 / users 6 / knowledge 9 / cases 3 | 合格（SELECT のみ） |
| (f) | 直近 24h journal のエラー語 | 3 unit とも **0 件** | 参考合格（ただし proxy は再起動ループを別途観測） |
| (g) | 監視 | 本番 timer のみ。**Staging 専用の監視なし** | **未実装（不合格）** |
| (g) | バックアップ | 本番 timer は稼働。Staging は dump 1 個と script はあるが **timer 未実装** | **未実装（不合格）** |
| (g) | 復元 | 自動復元 script なし（訓練は過去 docs の手動実施のみ） | **未実装** |
| (h) | 本番不変 | MainPID 2379216 / NRestarts 0 / health commit `a5e0a67…`（T1→T2 不変） | 合格（対象限定） |

**最重要の注意（方法論）:** 本監査の実施中に、**第三者（別セッション／別担当）が Staging を変更した**（08:07:22 の API 再起動、08:07:33〜08:08:08 の proxy 起動試行）。したがって本記録には **変更前（T1）と変更後（T2）の 2 スナップショット**を併記する。**私は systemctl の start/stop/restart を一切実行していない**（`show` / `cat` / `journalctl` のみ）。この外部変更により、`health` の `commit` は T1 で不合格、T2 で合格へ変化した。

---

## 1. 前提・境界・遵守事項

### 1-1 参照した文書

| 文書 | 実体 | 備考 |
|---|---|---|
| docs/77-staging-environment-design.md | 作業ツリー（558 行） | 設計。DB port 5440 / root `$HOME/apps/...` は実装値（5437 / `/home/kensan/ai-helpdesk-stg`）と差分あり |
| docs/78-staging-build-20261106.md | 作業ツリー（120 行） | 実装記録。S-1〜S-6 の残課題 |
| docs/81-staging-acceptance-evidence.md | 作業ツリー（393 行） | 前回の受入証拠。本監査の比較基準 |
| docs/76-followup-20261106.md | 作業ツリー（97 行） | PR #135 follow-up |
| **docs/82-promotion-runbook-20261106.md** | **作業ツリーに存在せず**。branch `docs/promotion-runbook-20261106` の commit `1019e1e` から `git show` で読取 | 手順書。§2-1 が「EnvironmentFile 追加 + daemon-reload + restart」「proxy 起動」を A 区分として定義 |

> docs/82 は main `e7d7f6f` に未マージである（`git ls-tree` で確認）。作業ツリーへの checkout・変更はしていない。

### 1-2 実行していないこと（禁止事項の遵守）

- `systemctl` の `start` / `stop` / `restart` / `enable` / `disable` / `daemon-reload` は**一切実行していない**。実行したのは `show` / `cat` / `list-unit-files` / `list-timers` のみ。
- DB への INSERT / UPDATE / DELETE / DDL / migration 再実行は**していない**。SELECT のみで、かつ `BEGIN READ ONLY;` で明示的に読み取り専用トランザクションにした。
- `npm run build` は**実行していない**（本番参照の `apps/api/dist` を上書きしないため）。
- `git commit` / `push` / `merge` / branch 操作は**していない**。
- Secret・パスワード・`DATABASE_URL` 全文・実メールアドレスは出力・記録していない（キー名と有無のみ）。
- 作成・変更したファイルは **`docs/evidence/stg-audit-20261106/` 配下のみ**（本ファイル）。

### 1-3 唯一の能動的診断（proxy の切り分け）

proxy の即時終了を切り分けるため、**systemd を介さず** `scripts/proxy-sidecar.mjs` を直接 2 回実行した（記録は §4-3）。いずれも**リスナーを残さない条件**で実行した（短い secret で即 exit 2 / 予備ポート 18953 で 3 秒 `timeout`）。DB・ファイル・systemd 状態は変更していない。この 1 点のみ「純粋な受動観測」ではないため明記する。

---

## 2. 測定タイムライン（外部変更の検出を含む）

| 時刻（JST） | 事象 | 出所 |
|---|---|---|
| 2026-11-06T08:06:50 | 18952 health 取得（**commit 空**） | 本監査 |
| 2026-11-06T08:06:50 | 18951 health 取得（**ECONNREFUSED**） | 本監査 |
| 2026-11-06T08:06:59 | Staging 3 unit の T1 スナップショット（api MainPID **798937**、`release.env` **未取込**） | 本監査 |
| 2026-11-06T08:07:10 | 本番 unit・待受ポート取得 | 本監査 |
| **2026-11-06T08:07:22** | **`ai-helpdesk-stg-api` が再起動（ExecMainStartTimestamp が 06:36:22 → 08:07:22、MainPID 798937 → 1701354）** | **本監査外の変更**（本監査は show のみ） |
| **2026-11-06T08:07:33** | **`ai-helpdesk-stg-proxy` 起動試行（本監査外）** | journal |
| 2026-11-06T08:07:36〜08:08:07 | proxy が **15 回**再起動ループ（各回 exit status 0） | journal |
| **2026-11-06T08:08:08** | **proxy 停止（本監査外）** | journal |
| 2026-11-06T08:08:39 | 18952 health 再取得（**commit 359cbd0…**）、unit 再取得 | 本監査 |
| 2026-11-06T08:08:05 / 08:10:11 | DB 件数（2 回、同値） | 本監査 |
| 2026-11-06T08:10:03 | 最終スナップショット（staging/prod unit・health・release） | 本監査 |

> **時系列の意味:** T1 の「commit 空」は、08:07:22 の API 再起動より**前**の状態である。T2 の「commit 束縛済み」は、`EnvironmentFiles` に `release.env` が追加され再起動された**後**の状態である。すなわち docs/78 S-1／docs/82 §2-1 A は、**本監査の実施中に別主体によって適用された**。私はこの変更を実行していないし、変更を止める権限も持たない。

---

## 3. (a) `/api/health` の実測

### 3-1 Staging API 18952

| 項目 | T1 | T2（最終） |
|---|---|---|
| URL | `http://127.0.0.1:18952/api/health` | 同左 |
| 測定時刻（JST） | **2026-11-06T08:06:50+09:00** | **2026-11-06T08:08:39+09:00** / 再確認 **08:10:03** |
| HTTP | 200 | 200 |
| `ok` | true | true |
| `db` | "ok" | "ok" |
| `env` | "production" | "production" |
| **`commit`** | **`""`（空文字）** | **`"359cbd012274fd23ed3ee99a5a497236b4ac7711"`** |
| `time_total` | 0.103548 s | — |

T1 の応答本文（実測そのまま）:

```json
{"ok":true,"service":"ai-helpdesk-api","version":"0.1.0","commit":"","db":"ok","time":"2026-11-05T23:06:50.709Z","env":"production"}
```

T2 の応答本文（実測そのまま）:

```json
{"ok":true,"service":"ai-helpdesk-api","version":"0.1.0","commit":"359cbd012274fd23ed3ee99a5a497236b4ac7711","db":"ok","time":"2026-11-05T23:10:03.183Z","env":"production"}
```

```bash
curl -sS -m5 -w '\nHTTP=%{http_code} time_total=%{time_total}s\n' http://127.0.0.1:18952/api/health
```

**判定:**

- `ok` / `db` / `env` は T1・T2 とも合格。
- **`commit` は T1（08:06:50）で空であり、これは不合格信号である。** 空文字を成功扱いしない。
- T2 では `commit` が `359cbd0…` に束縛され、release ID の末尾 `359cbd012274` と整合する。**T2 時点では health による release 束縛が成立している。**
- ただし T2 は**本監査外の変更後**の値であり、「監査開始時点の受け入れ状態」としては不合格である。両方を併記する。

### 3-2 18951（Staging proxy 経由）

| 項目 | 値 |
|---|---|
| URL | `http://127.0.0.1:18951/api/health` |
| 測定時刻（JST） | **2026-11-06T08:06:50+09:00** / **08:08:39** / **08:10:03** |
| curl の生エラー | `[network: upstream error] Error: connect ECONNREFUSED 127.0.0.1:18951` |
| HTTP | **502**（ハーネスのローカルポリシープロキシが上流拒否を 502 として返したもの） |
| 判定 | **不合格（未稼働）** |

`ss -ltnp` でも 18951 に LISTEN は存在しない（08:07:10 時点）。18951 は proxy の待受ポートであり、proxy unit が inactive のため到達できない。**proxy 経由の smoke（docs/82 A-3）は未成立。**

---

## 4. (b) `systemctl --user show ai-helpdesk-stg-{api,postgres,proxy}`

実行は `show` のみ（start/stop/restart/daemon-reload は未実行）。

### 4-1 T1 スナップショット（2026-11-06T08:06:59+09:00）

| unit | ActiveState/SubState | MainPID | NRestarts | ExecMainStartTimestamp | WorkingDirectory | EnvironmentFiles |
|---|---|---|---|---|---|---|
| `ai-helpdesk-stg-api` | active / running | **798937** | 0 | Fri 2026-11-06 **06:36:22** JST | `/home/kensan/ai-helpdesk-stg/current` | `~/.config/ai-helpdesk/stg-api.conf` **のみ** |
| `ai-helpdesk-stg-postgres` | active / running | 781949 | 0 | Fri 2026-11-06 06:34:45 JST | `/home/kensan`（`!` 付き=未検証） | — |
| `ai-helpdesk-stg-proxy` | **inactive / dead** | **0** | 0 | （空） | `/home/kensan/ai-helpdesk-stg/current` | `~/.config/ai-helpdesk/stg-api.conf` |

**T1 の要点:** stg-api の `EnvironmentFiles` に **`release.env` が無い**。これが docs/78 S-1（health の commit が空）の直接原因であることを、unit 定義の側から実測で確認した。

### 4-2 T2 スナップショット（2026-11-06T08:08:39 / 最終 08:10:03）

| unit | ActiveState/SubState | MainPID | NRestarts | ExecMainStartTimestamp | EnvironmentFiles |
|---|---|---|---|---|---|
| `ai-helpdesk-stg-api` | active / running | **1701354**（T1 から変化） | 0 | Fri 2026-11-06 **08:07:22** JST | `stg-api.conf` **＋ `/home/kensan/ai-helpdesk-stg/current/release.env`** |
| `ai-helpdesk-stg-postgres` | active / running | 781949（不変） | 0 | 06:34:45 JST（不変） | — |
| `ai-helpdesk-stg-proxy` | **inactive / dead** | **0** | 0 | （空） | `stg-api.conf` |

**T2 の要点:**

- `EnvironmentFiles` に `release.env` が追加され、API が再起動されている（08:07:22）。**docs/78 S-1 は解消済み**（health の commit が実測で非空になったことと整合）。
- `ai-helpdesk-stg-proxy` は **依然 inactive/dead**。起動されても定着していない。

### 4-3 proxy の起動失敗（観測と切り分け）

journal には、本監査外の起動試行と再起動ループが残っている。

| 時刻（JST） | journal 事象 |
|---|---|
| 08:07:33 | `Started ai-helpdesk-stg-proxy.service …` |
| 08:07:36〜08:08:07 | `Scheduled restart job, restart counter is at 1..15` と `Started` の反復（**15 回**） |
| 08:08:08 | `Stopped ai-helpdesk-stg-proxy.service …` |

| 項目 | 値 | 測定時刻 |
|---|---|---|
| `Result` / `ExecMainCode` / `ExecMainStatus` | `success` / `0` / `0`（= 各回「正常終了」扱い） | 08:08:56 |
| アプリの stdout/stderr | **journal に 1 行も出ていない**（`-o cat` で確認） | 08:08:56 |
| `Restart` / `RestartSec` | `always` / 2 | 08:08:56 |
| `StartLimitIntervalUSec` / `StartLimitBurst` | 10s / 5 | 08:08:56 |

切り分けのため、systemd を介さず script を直接実行した（§1-3）:

| 診断 | 結果 | 意味 |
|---|---|---|
| 短い `PROXY_SECRET`（`x`）で直接実行 | **exit 2** + `[proxy] PROXY_SECRET が未設定または短すぎます（16 文字以上）。` | `isMain` 判定は成立している（symlink 経由でも main として動く）。**secret 未設定が原因ではない** |
| 32 文字のダミー secret・**予備ポート 18953**・3 秒 `timeout` | `[proxy] listening on http://127.0.0.1:18953 -> http://127.0.0.1:18952`、exit 124（timeout による停止）、**18953 にリスナー残留なし** | **script 自体は正常に listen する** |

**結論:** proxy の即時終了（exit 0・出力なし）の**原因は未特定**である。script 単体は正常、secret 未設定でもない。systemd 配下でのみ即時終了する理由（例: 起動と停止の競合、外部からの停止操作との相互作用）は、本 read-only 範囲では確定できない。**推測で原因を断定しない。** 確定には unit の `StandardOutput`/`StandardError` の再確認、または承認下での `systemctl --user start` と `journalctl -f` の同時観測が必要である。

**判定: (b) は「api/postgres 稼働」は合格、「proxy 未稼働・定着せず」は明確に不合格。**

---

## 5. (c) `/home/kensan/ai-helpdesk-stg/current` と `release.env`

### 5-1 `current` の解決先（2026-11-06T08:07:17+09:00）

| 項目 | 値 |
|---|---|
| `readlink current` | `/home/kensan/ai-helpdesk-stg/releases/20261106T063553-359cbd012274` |
| `readlink -f current` | 同左（symlink が release 外を指していない） |
| release ID | `20261106T063553-359cbd012274`（JST timestamp + sha12） |
| release ディレクトリ mode | **700** |

```bash
readlink /home/kensan/ai-helpdesk-stg/current
readlink -f /home/kensan/ai-helpdesk-stg/current
```

**判定:** `current` → release の束縛は合格。release ディレクトリは 700 で、**書換可能**（docs/78 S-6 の `chmod -R a-w` は未適用。§6-3 も参照）。

### 5-2 `release.env`

| 項目 | 値 | 状態 |
|---|---|---|
| 存在 | あり（`-rw-------`、**130 bytes**、mode **600**） | 観測済み（`ls`/`stat` 相当） |
| 本文（`COMMIT_SHA` / `RELEASE_ID` / `RELEASE_BUILT_AT` 等の非秘密キー） | **未確認** | `*.env` の読取が承認ポリシーにより自動拒否された（`the user rejected tool "bash"` が 3 回。承認プロンプトは本セッションで無効） |
| `COMMIT_SHA` の**実効値** | **`359cbd012274fd23ed3ee99a5a497236b4ac7711`** | **間接観測**: T2 の `/api/health` の `commit` と、`dist-manifest.json` の `commit` が一致 |

**扱い:**

- 「release.env に `COMMIT_SHA` 行がある」ことは**直接確認していない**。ファイル本文は未確認である。
- 一方で、**`release.env` が `EnvironmentFiles` に取込まれ、その結果 health の `commit` が `359cbd0…` になった**ことは実測で確認した（§4-2 / §3-1）。ファイル本文の未確認と、実効値の観測は区別して扱う。
- 本文確認の代替手段（`read`/`grep` ツールへの切替）は、ポリシー拒否を別経路で回避することになるため**行っていない**。

---

## 6. (d) `dist-manifest` 検証

### 6-1 検証結果

| 項目 | 値 | 測定時刻（JST） |
|---|---|---|
| コマンド | `node scripts/dist-manifest.mjs --verify --manifest /home/kensan/ai-helpdesk-stg/current/dist-manifest.json --commit 359cbd012274fd23ed3ee99a5a497236b4ac7711` | 08:07:45 / 再確認 **08:10:10** |
| 出力 | `DIST_MANIFEST_OK 082e815b9cac9ac490fadc5792c2cc157b1a6e19a0a174a12597d4be8878481b` | 同上 |
| exit code | **0** | 同上 |
| manifest が主張する commit | `359cbd012274fd23ed3ee99a5a497236b4ac7711` | 08:07:39 |
| manifest の集約 sha256 | `082e815b9cac9ac490fadc5792c2cc157b1a6e19a0a174a12597d4be8878481b` | 08:07:39 |
| manifest 内 files 件数 | 196 | 08:07:39 |

> 注: `--manifest` に**相対パス**を渡すと `DIST_MANIFEST_PATH_INVALID` で失敗する（08:10:04 に実測）。絶対パス指定が必要。

### 6-2 成果物ハッシュ・件数（2026-11-06T08:07:46+09:00 / 再確認 08:10:03）

| 対象 | 値 |
|---|---|
| `apps/api/dist` の regular file 数 | **196** |
| うち `.js` | **98** |
| `db/migrations/*.sql` | **37** |
| `dist-manifest.json` の SHA-256 | **`277d0ae465d5f2400c2a10b407d207e3e663019ceb4fd8c51f84f0ebb70d3dd7`**（26917 bytes / mode 600） |
| ルート HTML の SHA-256 | **`78b4d23bae48589da380e2f5d8f4e4f357243e952673fc67363ac7571dbaec3d`**（**523,638 bytes** / mode **700**） |

前回 docs/81 の値（dist 集約 `082e815b…8481b` / manifest `277d0ae4…3dd7` / HTML `78b4d23b…ec3d`・523,638 bytes）と**一致**した。

### 6-3 限界（合格の範囲）

- manifest は**署名のない自己生成 JSON** である。commit は自己申告であり、build の再現性・配信 bytes の正しさ・改竄不能性は示さない。
- `--commit` を明示した検証は「manifest ↔ dist のハッシュ一致」を示すもので、**commit の真正性を独立に証明しない**。
- release ディレクトリは **700**、manifest は 600、HTML は 700 で、**書換可能**。docs/78 S-6 の不変化（`chmod -R a-w`）は**未適用**であり、「不変 release」は現時点では運用上の約束にすぎない。

**判定: (d) は合格（manifest↔dist 一致、exit 0）。ただし真正性・不変性の証明ではない。**

---

## 7. (e) DB `127.0.0.1:5437` / `ai_helpdesk_stg`

### 7-1 接続同一性と件数

| 項目 | 値 | 測定時刻（JST） |
|---|---|---|
| host / port | `127.0.0.1` / **5437** | 08:08:05 |
| database / user | `ai_helpdesk_stg` / `aihd_stg` | 08:08:05 |
| server version | `16.15 (Ubuntu 16.15-1.pgdg24.04+2)` | 08:08:05 |
| `current_database()` / `inet_server_port()` | 一致（`ai_helpdesk_stg` / 5437） | 08:08:05 |
| **migration 件数** | **37** | 08:08:05 / 08:10:11 |
| **public BASE TABLE 数** | **35** | 08:08:05 / 08:10:11 |
| **users** | **6** | 08:08:05 / 08:10:11 |
| **knowledge** | **9** | 08:08:05 / 08:10:11 |
| **cases** | **3** | 08:08:05 / 08:10:11 |
| psql クライアント | 18.6（サーバは 16.15） | 08:07:57 |

実測行（2 回同値）:

```text
ai_helpdesk_stg|5437|aihd_stg|16.15 (Ubuntu 16.15-1.pgdg24.04+2)|37|35|6|9|3
```

（`default_transaction_read_only` は `off` だったが、クエリは `BEGIN READ ONLY;` で明示的に読み取り専用トランザクション内で実行した。）

### 7-2 実行方法（秘密を出力しない）

`stg-api.conf` の `DATABASE_URL` をシェル内でのみ読み、`python3 urllib.parse` で分解して password を `PGPASSWORD` に渡した。URL・password は標準出力に一切出していない。

```bash
CONF="$HOME/.config/ai-helpdesk/stg-api.conf"
DBURL=$(awk -F= '/^DATABASE_URL=/{sub(/^DATABASE_URL=/,""); print; exit}' "$CONF")
# DBURL を python3 で分解し、password は PGPASSWORD にのみ渡す（表示しない）
PGPASSWORD="$PW" psql -w -v ON_ERROR_STOP=1 -h "$H" -p "$P" -U "$U" -d "$DB" -At -F'|' -c "
  BEGIN READ ONLY;
  SELECT current_database(), inet_server_port(), current_user, current_setting('server_version'),
    (SELECT count(*) FROM schema_migrations),
    (SELECT count(*) FROM information_schema.tables
      WHERE table_schema='public' AND table_type='BASE TABLE'),
    (SELECT count(*) FROM users), (SELECT count(*) FROM knowledge), (SELECT count(*) FROM cases);
  COMMIT;"
```

### 7-3 限界

- 実行したのは `SELECT` のみ。migration の再適用・seed 再投入・書込・DDL は行っていない。
- 「migration 37」は `schema_migrations` の行数による観測であり、適用処理を本監査で再実行した結果ではない。
- 件数は 08:08:05〜08:10:11 の観測値で、以後の書込は追跡していない。
- 本番 DB（5435）には接続・照会していない。

**判定: (e) は合格（docs/81 の値と一致）。ただし read-only の観測に限る。**

---

## 8. (f) 直近 journal のエラー語

対象: `--since '24 hours ago'`、3 unit。

| unit | 総行数 | エラー系語（`error|fatal|exception|failed|refused|panic|EADDRINUSE|unhandled`） | 測定時刻（JST） |
|---|---|---|---|
| `ai-helpdesk-stg-api` | 90 | **0** | 08:08:13 |
| `ai-helpdesk-stg-postgres` | 4 | **0** | 08:08:13 |
| `ai-helpdesk-stg-proxy` | 32 | **0** | 08:08:13 |

**解釈と限界:**

- API/PG の直近 24h にエラー語は無い。
- proxy の 32 行は**すべて systemd の起動/再起動/停止メッセージ**で、アプリ自身のエラー出力は無い（§4-3）。したがって「エラー語 0」は**proxy が正常だったことを意味しない**。むしろ再起動ループという異常を含む。
- エラー語検索は語彙ベースであり、無言の異常（本件の proxy の exit 0 等）を検出できない。**この指標単独で健全性を判断しない。**

**判定: (f) は「エラー語なし」だが、proxy の異常を別途観測しているため、参考扱い。**

---

## 9. (g) 監視 / バックアップ / 復元の実装有無

### 9-1 監視

| 対象 | 実装 | 状態（測定時刻 JST） |
|---|---|---|
| 本番 tunnel 監視 | `ai-helpdesk-tunnel-watch.timer`（enabled）→ `.service`（read-only、失敗反復でメール） | 稼働。最終実行 08:06:47 JST、`tunnel-watch: ok (failures=0 window=10min)`、`Result=success`（08:08:56 観測） |
| **Staging 専用の監視** | **該当 unit なし**（`list-unit-files \| grep ai-helpdesk` に `-stg-` の監視/timer が存在しない） | **未実装** |
| Staging proxy の監視 | なし（proxy 死亡を検知・通知する仕組みが無い） | **未実装** |

> `list-timers` には他プロジェクト（cwmp / dd / mirai-sf / codip 等）の timer が多数あるが、`ai-helpdesk-stg` 用の監視 timer は**存在しない**。

### 9-2 バックアップ

| 対象 | 実装 | 状態（測定時刻 JST） |
|---|---|---|
| 本番（preview DB） | `ai-helpdesk-backup.timer`（enabled, 日次）→ `/bin/bash scripts/backup-db.sh` | 稼働。最終 2026-11-06 02:32:18 JST、`backup ok: …ai_helpdesk_preview-20261106-023218.dump (266586 bytes, sha256 315b77bc…)`、`Result=success` / `ExecMainStatus=0`（08:08:27 観測）。次回 11-07 02:30:38 |
| **Staging 専用** | `scripts/backup-staging.sh` は**実装済み**（staging の `DATABASE_URL` のみ使用、DB 名/port 照合、`shared/backup` 0700、保持 7 日）。**ただし timer が無い** | **定期実行は未実装** |
| Staging dump の実績 | `/home/kensan/ai-helpdesk-stg/shared/backup/ai_helpdesk_stg-20261106-065756.dump`（**133,032 bytes**）。`backup.log`: `2026-11-06T06:57:57+09:00 OK db=ai_helpdesk_stg … sha256=58a9e05f20b8a2d15c87757a907e2d9d1a30604d0b4dfbe7f88bf53ed01f2b70 keep=7d` | 手動/単発で 1 個取得済み（08:08:27 観測） |

**判定: Staging の定期バックアップは未実装（不合格）。** docs/78 S-5 は未解消。dump が 1 個あることは「定期運用されている」ことを意味しない。

### 9-3 復元

| 項目 | 状態 |
|---|---|
| 自動復元スクリプト | **なし**（`pg_restore` は backup script 内の `--list` 健全性検査にのみ使用。`scripts/backup-db.sh:111-116` / `scripts/backup-staging.sh:53`） |
| 復元手順書 | docs/78 §7-1、docs/81 §10 に記録あり（過去の手動訓練） |
| 本監査での復元訓練 | **未実施**（復元は新規 DB 作成を伴い、read-only 範囲外） |

**判定: 復元は「実装なし・手動訓練の記録のみ」。自動化されていない。**

---

## 10. (h) 本番不変値

| 項目 | 値 | 測定時刻（JST） |
|---|---|---|
| unit | `ai-helpdesk-api.service` | 08:07:10 / 08:10:03 |
| ActiveState / SubState | active / running | 同上 |
| **MainPID** | **2379216** | 同上（**T1→T2 で不変**） |
| **NRestarts** | **0** | 同上 |
| ExecMainStartTimestamp | Wed 2026-11-04 10:04:02 JST | 同上 |
| InvocationID | `4f8d29d238904882a9dd8c6bab20939a` | 08:07:10 |
| WorkingDirectory | `/home/kensan/Projects/Mirai-Admin-Platform/AI-HelpDesk-Platform` | 08:07:10 |
| **health 18950 の `commit`** | **`a5e0a6719699d4711fc1811bbdb79c74d9aab393`** | 08:06:51 / 08:10:03 |
| health 18950 の `ok` / `db` / `env` | true / "ok" / "production" | 同上 |

参考（本番側の他 unit。docs/78 §3 の記録値と一致）:

| unit | MainPID | NRestarts | ActiveState | 測定時刻（JST） |
|---|---|---|---|---|
| `ai-helpdesk-proxy` | 863034 | 0 | active | 08:07:10 |
| `ai-helpdesk-cloudflared` | 2274303 | 0 | active | 08:07:10 |

待受ポート（08:07:10）:

| port | プロセス |
|---|---|
| 18950 | node pid **2379216**（= 本番 api MainPID と一致） |
| 18949 | node pid 863034（= 本番 proxy） |
| 18952 | node pid **798937**（= T1 の staging api MainPID） |
| 5437 | postgres pid 781949（= staging postgres） |
| 5435 | （`ss` にプロセス情報なし。本番 DB 相当） |

**判定: (h) は合格。ただし本記録が示す「本番不変」は、`ai-helpdesk-api` の MainPID/NRestarts/ExecMainStartTimestamp/InvocationID と health commit、および参考として proxy/cloudflared の PID に限定される。** 本番 DB・tunnel config・dist・timer 全量・cloudflared ingress digest は再測していない。**「本番全体が不変」とは主張しない。**

---

## 11. 観測と未確認の分離（必須）

### 11-1 観測済み（実測値がある）

| # | 観測項目 | 値 / 状態 |
|---|---|---|
| O-1 | Staging health 18952（T1） | 200 / ok true / db ok / env production / **commit 空** |
| O-2 | Staging health 18952（T2） | 200 / commit `359cbd0…` |
| O-3 | Staging 18951 | **到達不可（ECONNREFUSED / 502）** |
| O-4 | stg-api unit | T1 PID 798937・release.env 未取込 → T2 PID 1701354・release.env 取込 |
| O-5 | stg-postgres unit | active/running、PID 781949、NRestarts 0 |
| O-6 | stg-proxy unit | **inactive/dead、MainPID 0**、08:07:33〜08:08:08 に 15 回再起動 |
| O-7 | proxy の即時終了 | 各回 exit status 0・アプリ出力なし |
| O-8 | proxy script 単体 | 正常に listen（予備ポート 18953 で確認）、secret 未設定でもない |
| O-9 | current → release | `releases/20261106T063553-359cbd012274` |
| O-10 | release.env メタデータ | 存在、130 bytes、mode 600 |
| O-11 | dist-manifest 検証 | `DIST_MANIFEST_OK 082e815b…`、exit 0、196 files / 98 js |
| O-12 | release 成果物ハッシュ | manifest `277d0ae4…` / HTML `78b4d23b…`・523,638 bytes |
| O-13 | release 権限 | dir 700 / manifest 600 / HTML 700（**不変化未適用**） |
| O-14 | DB 件数 | migration 37 / public 35 / users 6 / knowledge 9 / cases 3（2 回同値） |
| O-15 | journal 24h | 3 unit ともエラー系語 0 |
| O-16 | 本番 timer | backup（日次、最終 02:32:18 成功）/ tunnel-watch（3 分間隔、最終 08:06:47 ok） |
| O-17 | Staging 定期 backup | **timer 不在**、dump 1 個（06:57:56、133,032 bytes） |
| O-18 | 自動復元 script | **不在** |
| O-19 | 本番不変 | API PID 2379216 / NRestarts 0 / commit `a5e0a67…`（T1→T2 不変） |
| O-20 | 監査中の外部変更 | 08:07:22 api 再起動、08:07:33–08:08:08 proxy 起動/停止 |

### 11-2 未確認・未実施（成功扱いにしない）

| # | 未確認・未実施 | 理由 / 必要な操作 |
|---|---|---|
| U-1 | `release.env` の**本文**（`COMMIT_SHA` 等の行） | `*.env` の読取が承認ポリシーで自動拒否。`read`/`grep` への切替は拒否の迂回になるため未実施 |
| U-2 | **proxy が即時終了する原因** | read-only 範囲で未特定（script 単体は正常）。承認下での start + ログ同時観測が必要 |
| U-3 | proxy 経由 smoke（docs/82 A-3） | proxy 未稼働のため未成立 |
| U-4 | 認証後 UI・実 Cloudflare Access / OTP | 人間のログイン・実ユーザーが必要。自動化不可 |
| U-5 | 配信 HTML の実 bytes（docs/78 §7-2 の 893,003 bytes） | proxy 経由の合成リクエストが必要。本監査は**release 内ファイル**のハッシュのみ |
| U-6 | Staging の監視・定期バックアップ | **実装が存在しない**（未確認ではなく「無い」ことの観測）。実装には unit/timer 追加＝承認が必要 |
| U-7 | 復元訓練の再実行 | 新規 DB 作成を伴い read-only 範囲外 |
| U-8 | rollback 訓練（release 切替・unit 戻し） | systemctl 変更が禁止 |
| U-9 | 監査ハッシュ鎖（audit_log）の再計算 | 本監査の対象外（過去 docs/81 §10 の記録あり） |
| U-10 | DB role 分離（owner/app） | 未実装（docs/78 S-4） |
| U-11 | 本番の全不変量（DB / tunnel / dist / timer / ingress digest） | 対象外。参照値は再測していない |
| U-12 | release の不変化（`chmod -R a-w`） | **未適用**（mode 700/600 を観測） |
| U-13 | docs/82 の main への統合 | main `e7d7f6f` に存在せず、branch `1019e1e` から読んだ |
| U-14 | Staging API の T2 状態の安定性 | 監査中に再起動されたため、T2 は「変更直後の値」であり継続稼働は未確認 |

**明示:** U-1〜U-14 は未確認・未実施である。本記録をもって Staging 受入完了・本番昇格 GO・`deploymentReady: true` とはしない。

---

## 12. 判定

1. **(a) health:** 18952 は `ok`/`db`/`env` 合格。**T1（08:06:50）の `commit` は空で不合格**、T2（08:08:39 以降）は `359cbd0…` で合格（外部変更後）。18951 は**不合格（未稼働）**。
2. **(b) unit:** stg-api / stg-postgres は稼働（合格）。**stg-proxy は inactive/dead で不合格**。T1 で `release.env` 未取込だったことが commit 空の直接原因と確認。
3. **(c) current / release.env:** `current` の release 束縛は合格。`release.env` は存在・mode 600 を観測したが**本文は未確認**。COMMIT_SHA の実効値は health と manifest で `359cbd0…` を観測。
4. **(d) dist-manifest:** `DIST_MANIFEST_OK` / exit 0、196 files・98 js。**合格**。ただし無署名・自己申告・release 書換可能。
5. **(e) DB:** 5437 / `ai_helpdesk_stg` / `aihd_stg`、migration 37 / public 35 / users 6 / knowledge 9 / cases 3。SELECT のみ。**合格（観測範囲）**。
6. **(f) journal:** エラー語 0。ただし proxy の無言の再起動ループを検出しており、**参考扱い**。
7. **(g) 監視/バックアップ/復元:** 本番 timer は稼働。**Staging は監視・定期バックアップ・自動復元がいずれも未実装 → 不合格**。
8. **(h) 本番不変:** MainPID 2379216 / NRestarts 0 / commit `a5e0a67…` が T1→T2 で不変。**合格（対象限定）**。

**総合: 部分合格。** 前進点は「`release.env` 取込により health の commit 束縛が成立したこと」（ただし本監査外の変更）。未達は「**proxy が稼働しない**」「**Staging の監視・定期バックアップ・復元自動化が無い**」。次に必要な操作は §13 の順で、いずれも承認を要する。

---

## 13. 次に必要な操作（優先順）

| # | 操作 | 種別 | 根拠 |
|---|---|---|---|
| 1 | proxy 即時終了の原因確定（exit 0・出力なし） | 調査（承認下で start + journal 同時観測、または `StandardOutput` 明示） | §4-3 / U-2 |
| 2 | `ai-helpdesk-stg-proxy` を稼働させ、`18951/api/health` 200 と proxy 経由 smoke を再測 | systemctl start（承認必須） | docs/82 A-3 |
| 3 | `ai-helpdesk-stg-backup` の timer 化（`scripts/backup-staging.sh` は実装済み） | unit/timer 追加（承認必須） | §9-2 / docs/78 S-5 |
| 4 | Staging 専用の health / proxy 監視 timer の追加 | unit/timer 追加（承認必須） | §9-1 |
| 5 | release の不変化（`chmod -R a-w`）適用と再ハッシュ | 実装（書換を伴う） | §6-3 / docs/78 S-6 |
| 6 | `release.env` の非秘密キーの確認（監査ログに値を残さない方法で） | 読取許可の調整 | U-1 |
| 7 | DB role 分離・復元訓練・認証後 UI 受入 | 設計/人間/承認 | U-4, U-7, U-10 |

---

## 14. 再実行用コマンド（read-only）

```bash
# 0) 時刻・HEAD
date -Iseconds; git rev-parse --short HEAD; git branch --show-current

# 1) health（18952 / 18951 / 18950）
curl -sS -m5 -w '\nHTTP=%{http_code} time_total=%{time_total}s\n' http://127.0.0.1:18952/api/health
curl -sS -m5 -o /dev/null -w 'HTTP=%{http_code}\n' http://127.0.0.1:18951/api/health
curl -sS -m5 -w '\nHTTP=%{http_code} time_total=%{time_total}s\n' http://127.0.0.1:18950/api/health

# 2) unit（show のみ。start/stop/restart/daemon-reload はしない）
systemctl --user show ai-helpdesk-stg-api ai-helpdesk-stg-postgres ai-helpdesk-stg-proxy \
  -p Id,ActiveState,SubState,MainPID,NRestarts,ExecMainStartTimestamp,EnvironmentFiles
systemctl --user show ai-helpdesk-api \
  -p Id,ActiveState,SubState,MainPID,NRestarts,ExecMainStartTimestamp,InvocationID
systemctl --user list-timers --all --no-pager | grep -i ai-helpdesk
systemctl --user list-unit-files --no-pager | grep -i ai-helpdesk

# 3) release / artifact
readlink /home/kensan/ai-helpdesk-stg/current
cd /home/kensan/ai-helpdesk-stg/current
sha256sum dist-manifest.json Mirai_AIHelpdesk_Cowork_StepWizard_V3.1_PCinfo_Offline.html
stat -c '%n size=%s mode=%a' dist-manifest.json Mirai_AIHelpdesk_Cowork_StepWizard_V3.1_PCinfo_Offline.html
node scripts/dist-manifest.mjs --verify \
  --manifest /home/kensan/ai-helpdesk-stg/current/dist-manifest.json \
  --commit 359cbd012274fd23ed3ee99a5a497236b4ac7711

# 4) DB（SELECT のみ。DATABASE_URL / password は表示しない）
CONF="$HOME/.config/ai-helpdesk/stg-api.conf"
DBURL=$(awk -F= '/^DATABASE_URL=/{sub(/^DATABASE_URL=/,""); print; exit}' "$CONF")
# DBURL を分解し password は PGPASSWORD にのみ渡す
PGPASSWORD="$PW" psql -w -v ON_ERROR_STOP=1 -h "$H" -p "$P" -U "$U" -d "$DB" -At -F'|' -c "
  BEGIN READ ONLY;
  SELECT current_database(), inet_server_port(), current_user, current_setting('server_version'),
    (SELECT count(*) FROM schema_migrations),
    (SELECT count(*) FROM information_schema.tables
      WHERE table_schema='public' AND table_type='BASE TABLE'),
    (SELECT count(*) FROM users), (SELECT count(*) FROM knowledge), (SELECT count(*) FROM cases);
  COMMIT;"

# 5) journal
for u in ai-helpdesk-stg-api ai-helpdesk-stg-postgres ai-helpdesk-stg-proxy; do
  echo "== $u =="
  journalctl --user -u "$u" --since '24 hours ago' --no-pager -q | tail -20
done

# 6) 待受の帰属
ss -ltnp | grep -E ':(18949|18950|18951|18952|5437)\b'
```

---

## 15. 付記: 本監査の限界

- 本記録は**単一時点の read-only 観測**である。監査中に環境が変更されたため、T1 と T2 の 2 スナップショットを併記したが、**連続した稼働の証明ではない**。
- 「エラー語 0」「health 200」「manifest 一致」は、それぞれ**局所的な信号**であり、Staging の受入完了を意味しない。
- 復元・rollback・認証後 UI・実 Access は未実施である。**推測は「推測」と明記し、未実施を成功扱いにしていない。**
