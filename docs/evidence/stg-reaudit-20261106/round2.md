# Staging 是正後の独立再監査（Step8 / Round 2）— 2026-11-06 JST

作業ディレクトリ: `/home/kensan/Projects/Mirai-Admin-Platform/AI-HelpDesk-Platform`
測定時 HEAD: `46261ea1eb3152287457d0c25e42a80106bc2a58`（branch `main`）
タイムゾーン: JST（`+09:00`）。health JSON 内の `time` は UTC。
担当: stg-auditor（共有タスク task-5）
前回記録: `docs/evidence/stg-audit-20261106/audit.md`（Round 1 / HEAD `e7d7f6f`）

> **位置づけ:** 本記録は Round 1 の**不合格項目が実際に閉じたか**を、Lead の自己申告ではなく read-only の実測で独立検証したものである。Lead の申告（proxy 原因＝symlink と realpath の不一致）は、**旧コードを git から復元して再現**し、裏づけを取った（§9-1）。未確認は未確認と明記する。

---

## 0. 結論（PASS / FAIL）

| # | 検証項目 | 結果 | 判定 |
|---|---|---|---|
| 1 | 18952 health の `commit` が release と一致 | `46261ea1eb3152287457d0c25e42a80106bc2a58`（release ID 末尾 `46261ea1eb31`・manifest commit と一致） | **PASS** |
| 2 | 18951 proxy health 200・systemd 稼働 | HTTP **200**・同一 commit。`active/running`・MainPID **1945305**（>0）・NRestarts **0** | **PASS** |
| 3 | 3 timer が enabled・直近実行 success | 3 timer とも `enabled/active`。3 service とも `Result=success` / `ExecMainStatus=0`。healthcheck は **timer 起点の実行を実測**（08:33:02） | **PASS**（backup/restore の timer 起点実行は未観測・§5-3） |
| 4 | release の read-only 化と書込拒否 | ディレクトリ全て **500（dr-x）**、ファイル 4441 個が 400・41 個が 500。**dir/file とも書込拒否**を実測 | **PASS**（配信 HTML は 500 で 0400 ではない・§6-3） |
| 5 | dist-manifest `--verify` が read-only release で通る（**repo の script**） | **指定どおりの実行は FAIL**（`DIST_MANIFEST_FILES_MISMATCH` / exit 1）。原因は script が**自分の repo の dist** を検証する実装。release 自身の同一 script・repo lib を release に向けると **PASS** | **FAIL（指定コマンド）／PASS（対象を release に向けた場合）** |
| 6 | 本番不変 | MainPID **2379216** / NRestarts **0** / health commit **`a5e0a67…`**（前回と一致） | **PASS** |
| 7 | 前回未確認項目の今回確認 | proxy 原因を**独立再現で確定**、配信 HTML 実 bytes **893,003** を実測。`release.env` 本文は**依然未確認** | 一部 PASS（§9） |

**総合: Round 1 の主要な不合格（proxy 未稼働、監視・定期バックアップ・復元の未実装、release 不変化の未適用）は、実測上すべて閉じた。** ただし (5) は「repo の script で release を検証する」という**指定手段が成立しない**（script の設計上の制約）。これは release の欠陥ではなく、検証ツールの使い方の問題である（§7）。`release.env` 本文のみ未確認として残る。

---

## 1. 前提・境界・遵守事項

### 1-1 参照した文書

| 文書 | 実体 |
|---|---|
| `docs/evidence/stg-audit-20261106/audit.md` | Round 1（前回）の記録。本記録の比較基準 |
| `docs/78-staging-build-20261106.md` | 実装記録・S-1〜S-6 |
| `docs/81-staging-acceptance-evidence.md` | 前々回の受入証拠（配信 HTML 893,003 bytes の出所） |
| `docs/82-promotion-runbook-20261106.md` | main 未マージ（branch `docs/promotion-runbook-20261106` / `1019e1e`）から `git show` で読了 |

### 1-2 実行していないこと（禁止事項の遵守）

- `systemctl` の `start` / `stop` / `restart` / `enable` / `disable` / `daemon-reload` は**一切実行していない**。`show` / `cat` / `list-unit-files` / `list-timers` / `journalctl` のみ。
- DB への INSERT / UPDATE / DELETE / DDL / migration 再実行は**していない**。SELECT のみ（`BEGIN READ ONLY;`）。
- `npm run build` は**実行していない**。`git commit` / `push` / `merge` / branch 操作も**していない**。
- Secret・パスワード・`DATABASE_URL` 全文・実メールアドレスは出力・記録していない。
- 作成・変更したファイルは **`docs/evidence/stg-reaudit-20261106/` 配下のみ**（本ファイル + `probe/old-proxy-sidecar.mjs`）。

### 1-3 唯一の能動的診断

proxy 原因の独立確認のため、**systemd を介さず** proxy script を予備ポート **18994** で実行した（§9-1）。リスナーは残していない（毎回 `timeout` で停止、実行後に `ss` で 0 件を確認）。旧コードは git から `docs/evidence/stg-reaudit-20261106/probe/` に展開して実行した（release も repo も変更していない）。

---

## 2. 測定スナップショット

| 測定 | 時刻（JST） |
|---|---|
| health（18952 / 18951 / 18950） | 2026-11-06T08:29:47〜08:29:48 |
| Staging 3 unit・本番 API | 2026-11-06T08:29:54 |
| timer 一覧・timer show | 2026-11-06T08:29:55〜08:29:56 |
| 3 service の Result/ExecMainStatus | 2026-11-06T08:30:04 |
| state/*.log・journal | 2026-11-06T08:30:05 |
| release 権限・書込拒否 | 2026-11-06T08:30:23 / 08:31:16 |
| dist-manifest 検証（repo script / repo lib / release script） | 2026-11-06T08:30:23 / 08:31:15 / 08:30:33 |
| proxy 原因の再現（18994） | 2026-11-06T08:31:43〜08:31:58 |
| DB 件数 | 2026-11-06T08:32:09 |
| 本番 proxy/cloudflared・配信 HTML | 2026-11-06T08:32:10 |
| timer 起点の healthcheck 実行 | 2026-11-06T08:33:02（観測 08:33:14） |

---

## 3. (1) 18952 health と release の一致 — **PASS**

| 項目 | 値 | 測定時刻（JST） |
|---|---|---|
| URL | `http://127.0.0.1:18952/api/health` | — |
| HTTP / `time_total` | **200** / 0.171220 s | 08:29:47 |
| `ok` / `db` / `env` | true / "ok" / "production" | 08:29:47 |
| **`commit`** | **`46261ea1eb3152287457d0c25e42a80106bc2a58`** | 08:29:47 |
| `current` symlink | `/home/kensan/ai-helpdesk-stg/releases/20261106T082716-46261ea1eb31` | 08:29:41 |
| manifest の主張 commit | `46261ea1eb3152287457d0c25e42a80106bc2a58` | 08:30:33 |
| 作業ツリー HEAD | `46261ea`（一致） | 08:29:41 |

応答本文（実測そのまま）:

```json
{"ok":true,"service":"ai-helpdesk-api","version":"0.1.0","commit":"46261ea1eb3152287457d0c25e42a80106bc2a58","db":"ok","time":"2026-11-05T23:29:47.669Z","env":"production"}
```

**判定: PASS。** 前回（Round 1）T1 で空だった `commit` は、release ID `20261106T082716-46261ea1eb31`・manifest `commit`・作業ツリー HEAD の三者と一致した。health による release 束縛は成立している。

> 注意: `current` は symlink であり、health の commit は `release.env` 経由の**自己申告**である。artifact の同一性は §7 の manifest 一致で別途示す。

---

## 4. (2) 18951 proxy の health と systemd 状態 — **PASS**

### 4-1 health

| 項目 | 値 | 測定時刻（JST） |
|---|---|---|
| URL | `http://127.0.0.1:18951/api/health` | — |
| HTTP / `time_total` | **200** / 0.342989 s | 08:29:47 |
| `commit` | `46261ea1eb3152287457d0c25e42a80106bc2a58` | 08:29:47 |
| `ok` / `db` / `env` | true / "ok" / "production" | 08:29:47 |

前回は **ECONNREFUSED / HTTP 502** だった 18951 が、200 で staging API と同一 commit を返している。

### 4-2 systemd 状態

| 項目 | 値 | 測定時刻（JST） |
|---|---|---|
| `Id` | `ai-helpdesk-stg-proxy.service` | 08:29:54 |
| ActiveState / SubState | **active / running** | 08:29:54 |
| **MainPID** | **1945305**（>0） | 08:29:54 |
| **NRestarts** | **0** | 08:29:54 |
| ExecMainStartTimestamp | Fri 2026-11-06 **08:27:43** JST | 08:29:54 |
| EnvironmentFiles | `~/.config/ai-helpdesk/stg-api.conf` | 08:29:54 |
| UnitFileState | **enabled** | 08:29:55 |

前回の「15 回再起動ループ → 停止」は再発していない。08:27:43 の起動以降、NRestarts 0 で継続稼働している（約 5 分時点の観測）。

**判定: PASS。** ただし継続稼働の観測は「08:27:43〜08:33 の約 5 分」に限られる。長期安定性は本監査の範囲外（§10）。

---

## 5. (3) 3 timer の enabled と直近実行 — **PASS（一部未観測）**

### 5-1 timer の登録状態（2026-11-06T08:29:55+09:00）

| timer | UnitFileState | ActiveState | LastTriggerUSec | NextElapseUSecRealtime |
|---|---|---|---|---|
| `ai-helpdesk-stg-backup.timer` | **enabled** | active | （空） | Sat 2026-11-07 03:10:43 JST |
| `ai-helpdesk-stg-restore-drill.timer` | **enabled** | active | （空） | Sun 2026-11-08 04:37:01 JST |
| `ai-helpdesk-stg-healthcheck.timer` | **enabled** | active | Fri 2026-11-06 08:27:55 JST | （08:33:02 に更新） |

3 timer とも `enabled` / `active` で、`NextElapseUSecRealtime` が設定されている（= スケジュール登録済み）。

### 5-2 直近実行の Result / ExecMainStatus（2026-11-06T08:30:04+09:00）

| service | Result | ExecMainStatus | ExecMainCode | 実行時刻（JST） |
|---|---|---|---|---|
| `ai-helpdesk-stg-backup.service` | **success** | **0** | 1 | 08:28:04（開始=終了） |
| `ai-helpdesk-stg-restore-drill.service` | **success** | **0** | 1 | 08:28:07〜08:28:09 |
| `ai-helpdesk-stg-healthcheck.service` | **success** | **0** | 1 | 08:28:01〜08:28:02（以降も反復） |

### 5-3 `state/*.log` による実体確認（2026-11-06T08:30:05+09:00）

```text
healthcheck.log:
2026-11-06T08:15:51+09:00 OK ok=true db=ok env=production commit=359cbd012274fd23ed3ee99a5a497236b4ac7711 release_bound=1
2026-11-06T08:15:51+09:00 FAIL reason=release_binding_mismatch actual=359cbd012274fd23ed3ee99a5a497236b4ac7711 expected=e7d7f6f9dc945bff48419b020bab40696fe05e3f
2026-11-06T08:27:55+09:00 OK ok=true db=ok env=production commit=46261ea1eb3152287457d0c25e42a80106bc2a58 release_bound=1
2026-11-06T08:28:02+09:00 OK ok=true db=ok env=production commit=46261ea1eb3152287457d0c25e42a80106bc2a58 release_bound=1
2026-11-06T08:33:02+09:00 OK ok=true db=ok env=production commit=46261ea1eb3152287457d0c25e42a80106bc2a58 release_bound=1

restore-drill.log:
2026-11-06T08:14:56+09:00 OK tables=35 rows_match=1 migrations=37 bytes=133011 sha256=178c25c9… dump=ai_helpdesk_stg-20261106-081049.dump
2026-11-06T08:28:09+09:00 OK tables=35 rows_match=1 migrations=37 bytes=133004 sha256=8591eb4b… dump=ai_helpdesk_stg-20261106-082804.dump
```

backup の実体（journal 08:28:04）:

```text
backup ok: ai_helpdesk_stg-20261106-082804.dump (133004 bytes, sha256 8591eb4b655af3348fd7f723b84e5df4717d147bd1a455c1bf2860d359ed30bd)
```

### 5-4 timer 起点の実行を実測（healthcheck）

08:33:01 のスケジュールを待って観測した結果:

| 項目 | 値 |
|---|---|
| `LastTriggerUSec` | **Fri 2026-11-06 08:33:02 JST**（08:27:55 から更新） |
| journal | `08:33:02 Starting …` → `healthcheck ok: commit=46261ea1eb3152287457d0c25e42a80106bc2a58` → `Finished` |
| `healthcheck.log` | `2026-11-06T08:33:02+09:00 OK … release_bound=1` |

**判定: PASS。** 3 timer は enabled/active で、3 service の直近実行はすべて `success` / `ExecMainStatus=0`。実体（dump 133,004 bytes、restore drill tables=35 rows_match=1、health OK）もログで確認した。**healthcheck は timer 起点の実行まで実測**した。

**未観測（重要）:** `ai-helpdesk-stg-backup.timer` と `ai-helpdesk-stg-restore-drill.timer` は `LastTriggerUSec` が空であり、**timer 起点の発火はまだ観測していない**（08:28 の実行は Lead による手動起動と解釈できる）。次回予定は backup **11-07 03:10:43**、restore-drill **11-08 04:37:01**。発火実績の確認は次回以降に必要。**「timer がある」ことと「timer が発火した」ことを混同しない。**

> 補足: `healthcheck.log` の 08:15:51 の **FAIL** は、当時の main HEAD（`e7d7f6f`）と release（`359cbd0`）の不一致を検出した**過去の記録**であり、その後の OK で解消している。これは healthcheck が**空振りでない**（不一致を実際に検出する）ことの証拠でもある。現在の状態は FAIL ではない。

---

## 6. (4) release の read-only 化 — **PASS（ただし 0400 でないファイルあり）**

### 6-1 権限（2026-11-06T08:30:23 / 08:31:36）

| 対象 | mode |
|---|---|
| release ルート（`current` の実体） | **500（dr-x------）** |
| `apps/api/dist` | 500（dr-x） |
| `dist-manifest.json` | **400**（-r--------） |
| `apps/api/dist/index.js` | **400** |
| ルート HTML（配信ファイル） | **500**（-r-x------） |

mode 分布（`find -L current`、08:31:36）:

| 種別 | mode | 件数 |
|---|---|---|
| ディレクトリ | 500 | **552**（全て） |
| ファイル | 400 | **4441** |
| ファイル | 500 | **41** |

`u+w` または `o+w` を持つファイルは **0 件**。

### 6-2 書込拒否の実測（2026-11-06T08:31:16）

| 試行 | 結果 |
|---|---|
| ディレクトリへの新規ファイル作成（`touch`） | **WRITE_REFUSED（dir）** / 残骸なし |
| 既存ファイルへの 0 byte 追記（`dist-manifest.json`） | **WRITE_REFUSED（file）**（stderr: `Permission denied`） |
| 書込試行後の manifest SHA-256 | `b473b447d41fde74ea22da18022345570f1c3d4bf54503df6af637e9d3501992`（**試行前後で不変**） |

### 6-3 判定と留保

**判定: PASS。** ディレクトリは dr-x、ファイルは原則 0400、書込はカーネルに拒否され、試行後も内容は不変。

**留保:** task の期待値「配信ファイル 0400」に対し、**ルート HTML と 41 ファイルは 500（r-x）** である。これは元 mode 700 から write のみを落とした結果（0700 → 0500）で、**書込は同様に不可**。ただし「0400 に統一」という表現としては**厳密には一致しない**。実行ビットは残っている（配信 HTML を実行する意図はなく、実害は無いと考えるが、規約上 0400 を求めるなら要調整）。

---

## 7. (5) dist-manifest `--verify` と read-only release — **指定コマンドは FAIL**

### 7-1 事実（3 通りを同一条件で実行）

| # | 実行 | 結果 | exit | 測定時刻（JST） |
|---|---|---|---|---|
| A | repo の script を repo から: `node scripts/dist-manifest.mjs --verify --manifest <release>/dist-manifest.json --commit 46261ea…` | **`DIST_MANIFEST_FILES_MISMATCH`** | **1（FAIL）** | 08:30:23 |
| B | release 自身の script（repo と**同一バイト**）を release から | **`DIST_MANIFEST_OK ca8a7a34…c11b`** | **0（PASS）** | 08:30:33 |
| C | repo の **lib** に `repoRoot=/home/kensan/ai-helpdesk-stg/current` を明示 | **`LIB_VERIFY_OK sha256=ca8a7a34… files=196`** | **0（PASS）** | 08:31:15 |

### 7-2 原因（実測で特定）

`scripts/dist-manifest.mjs` は次の 1 行で検証対象を決めている。

```js
const root = path.resolve(import.meta.dirname, '..');
...
await verifyManifestAgainstDist(manifest, { repoRoot: root });
```

つまり **`--verify` は「script が置かれている repo の `apps/api/dist`」を検証する**。`--manifest` は「読む manifest」を指定するだけで、**検証対象の dist は指定できない**。したがって A は「release の manifest」と「repo の dist」を突き合わせ、両者が違うため FAIL する。

実測した差分:

| 比較 | 結果 |
|---|---|
| 両 script の SHA-256 | CLI・lib とも**完全一致**（`9a33719c…` / `efdcc225…`） |
| repo dist と release dist のファイル数 | 196 / 196（同数） |
| 内容が異なるファイル数 | **22**（例: `apps/api/dist/config.js` は repo `064f0ffe…` と release `dac86dc2…` で不一致） |
| repo `apps/api/dist` の git 管理 | 0 ファイル（未追跡＝build 産物） |

**つまり A の FAIL は release の欠陥ではなく、repo の dist が release と別物（古い build）であることによる。** 同じコードでも、実行場所（＝script の位置）が検証対象を決めてしまう。

### 7-3 判定

- **指定された手段（repo の script で release を検証）は FAIL。** これは「read-only release でも検証が通る」ことの証明にはならない。
- **release の整合性そのものは PASS**（B・C: `DIST_MANIFEST_OK ca8a7a34…`、196 files）。release の manifest は release の dist と一致している。
- read-only 化が検証を妨げていないことも B・C で確認（書込を伴わない検証が成功）。

**提案:** `--verify` に `--dist-root`（または `--release-root`）を追加し、検証対象を明示できるようにする。現状は「release を repo の script で検証する」手段が CLI に無い。

---

## 8. (6) 本番不変 — **PASS**

| 項目 | 値 | 測定時刻（JST） |
|---|---|---|
| unit | `ai-helpdesk-api.service` | 08:29:54 |
| ActiveState / SubState | active / running | 08:29:54 |
| **MainPID** | **2379216** | 08:29:54 |
| **NRestarts** | **0** | 08:29:54 |
| ExecMainStartTimestamp | Wed 2026-11-04 10:04:02 JST | 08:29:54 |
| InvocationID | `4f8d29d238904882a9dd8c6bab20939a` | 08:29:54 |
| **health 18950 `commit`** | **`a5e0a6719699d4711fc1811bbdb79c74d9aab393`** | 08:29:48 |
| health 18950 `ok`/`db`/`env` | true / "ok" / "production" | 08:29:48 |

参考（前回と一致）:

| unit | MainPID | NRestarts | ActiveState | 測定時刻（JST） |
|---|---|---|---|---|
| `ai-helpdesk-proxy` | 863034 | 0 | active | 08:32:10 |
| `ai-helpdesk-cloudflared` | 2274303 | 0 | active | 08:32:10 |

**判定: PASS。** Round 1 と同一の MainPID / NRestarts / health commit。ただし範囲はこの 3 信号（+ 参考 2 unit の PID）に限定され、本番 DB・tunnel・dist 全量は再測していない。

---

## 9. (7) 前回未確認項目の今回確認

### 9-1 proxy 即時終了の原因 — **独立再現で確定（PASS）**

Lead の申告「`current` symlink 経由だと `import.meta.url`（実パス）と `process.argv[1]`（symlink パス）が一致せず main() が走らない」を、**旧コードを git から復元して再現**した。

| # | 実行対象 | 起動経路 | 結果 | exit |
|---|---|---|---|---|
| 1 | **旧コード**（`359cbd0:scripts/proxy-sidecar.mjs`） | **実パス** | `[proxy] listening on http://127.0.0.1:18994 -> …18952` | 124（timeout=稼働） |
| 2 | **旧コード**（同一ファイル） | **symlink 経由** | **出力なし・即終了** | **0** |
| 3 | **新コード**（現 release） | **`current` symlink 経由** | `[proxy] listening … 18994 …` | 124（稼働） |
| 4 | **新コード**（現 release） | **実パス** | `[proxy] listening … 18994 …` | 124（稼働） |

- 旧コードの該当行（復元して確認）: `const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;`
- 新コードの該当行（現 release で確認）: `const isMain = isMainModule(import.meta.url, process.argv[1]);`（`scripts/lib/is-main.mjs` の `isMainModule` が realpath を解決して比較）
- main の commit: `65caaa2 fix(scripts): symlink 経由の起動で main() が黙って実行されない問題を直す (#143)`

**再現結果は Round 1 の観測（各回 exit status 0・無出力・即時終了）と完全に一致する。** 「script 単体は正常 listen」という Round 1 の切り分けも、単体＝実パス起動だったため当然の結果であり、矛盾しない。**原因は確定と判断してよい。**

補足: 予備ポート 18994 は実行前後とも LISTEN 0 件、リスナーは残留していない。

### 9-2 配信 HTML の実 bytes — **確認（PASS）**

| 項目 | 値 | 測定時刻（JST） |
|---|---|---|
| 経路 | `http://127.0.0.1:18951/`（proxy 経由）+ 合成ヘッダ `Cf-Access-Authenticated-User-Email: synthetic-staging@example.invalid` | 08:32:10 |
| HTTP | **200** | 08:32:10 |
| **配信 bytes** | **893,003** | 08:32:10 |
| release 内 HTML ファイル | 523,638 bytes（§7・Round 1 と同じ） | 08:30:23 |

**解釈:** 配信 bytes（893,003）は release 内ファイル（523,638）と異なる。これは配信時にプロトタイプ用の patch/injection が行われるためで、docs/78 §7-2 の **893,003 bytes と一致**した。Round 1 の U-5（未再測）はこれで**確認済み**。

> 限界: 合成ヘッダによるローカル経路の確認であり、実 Cloudflare Access / 実ユーザーの受入ではない。`ACCESS_JWT_MODE=off` の間はローカルプロセスがヘッダを偽装し得る（docs/78 §6）。

### 9-3 `release.env` 本文 — **依然未確認**

| 項目 | 状態 |
|---|---|
| 存在・mode | 観測済み（Round 1: 130 bytes / 600） |
| 本文（`COMMIT_SHA` 行等） | **未確認**。`*.env` の読取は承認ポリシーで拒否される（本ラウンドでも試行していない） |
| `COMMIT_SHA` の実効値 | **間接確認**: health・manifest・release ID・HEAD の 4 者が `46261ea…` で一致（§3） |

「ファイル本文を読んだ」わけではない。**未確認は未確認のまま残す。**

### 9-4 その他の前回未確認項目

| Round 1 の項目 | 今回 |
|---|---|
| U-4 認証後 UI / 実 Access / OTP | **未実施**（人間のログインが必要） |
| U-7 復元訓練の再実行 | **実装は確認**（restore-drill timer + 08:28:09 の実行ログ tables=35 rows_match=1）。**手動での再実行はしていない** |
| U-8 rollback 訓練 | **未実施**（systemctl 変更禁止）。ただし deploy state に `previous` が記録され、`result: "success"`（§11） |
| U-9 監査ハッシュ鎖 | **未実施**（対象外） |
| U-10 DB role 分離 | **未実施**（変更なし。単一 role `aihd_stg` のまま） |
| U-12 release 不変化 | **解消**（§6・PASS） |
| U-14 T2 の安定性 | **部分的に解消**: API は 08:28:34 起動以降、proxy は 08:27:43 起動以降 NRestarts 0（約 5 分） |

---

## 10. 観測と未確認の分離

### 10-1 観測済み

| # | 項目 | 値 |
|---|---|---|
| O-1 | 18952 health | 200 / commit `46261ea1…` / db ok / env production |
| O-2 | 18951 health | 200 / 同一 commit |
| O-3 | stg-proxy unit | active/running、MainPID 1945305、NRestarts 0 |
| O-4 | stg-api / stg-postgres | active/running（PID 1958657 / 781949） |
| O-5 | 3 timer | すべて enabled / active、NextElapse 設定済み |
| O-6 | 3 service | すべて Result=success / ExecMainStatus=0 |
| O-7 | healthcheck の timer 起点実行 | 08:33:02 に発火・OK |
| O-8 | release 権限 | dir 552 個すべて 500、file 4441 個 400・41 個 500、writable 0 |
| O-9 | 書込拒否 | dir/file とも拒否、書込試行後もハッシュ不変 |
| O-10 | manifest 整合（release 自身 / repo lib） | `DIST_MANIFEST_OK ca8a7a34…`、196 files |
| O-11 | 指定コマンド（repo script） | `DIST_MANIFEST_FILES_MISMATCH` / exit 1 |
| O-12 | repo dist と release dist の差 | 22 ファイル不一致 |
| O-13 | 旧コードの symlink 起動 | exit 0・無出力（バグ再現） |
| O-14 | 新コードの symlink 起動 | listen 成功（修正確認） |
| O-15 | 配信 HTML | 200 / 893,003 bytes |
| O-16 | 本番不変 | PID 2379216 / NRestarts 0 / commit `a5e0a67…` |
| O-17 | DB | migration 37 / public 35 / users 6 / knowledge 9 / cases 3（前回同値） |
| O-18 | journal（stg 3 unit, 2h） | エラー系語 0 |
| O-19 | deploy state | `result: "success"`、`previous` あり、`at 2026-11-05T23:27:35.798Z` |
| O-20 | 過去の healthcheck FAIL | 08:15:51 に `release_binding_mismatch`（現在は解消） |

### 10-2 未確認・未実施

| # | 未確認・未実施 | 理由 |
|---|---|---|
| U-1 | `release.env` 本文 | `*.env` 読取が承認ポリシーで拒否。迂回しない |
| U-2 | backup / restore-drill の **timer 起点発火** | 次回 11-07 03:10:43 / 11-08 04:37:01。未到来 |
| U-3 | proxy の長期安定性 | 観測は約 5 分（08:27:43〜08:33） |
| U-4 | 認証後 UI・実 Access / OTP | 人間のログインが必要 |
| U-5 | rollback の実効性（戻して復旧するか） | systemctl 変更が禁止。机上のみ |
| U-6 | 復元訓練の再実行 | 新規 DB 作成を伴うため read-only 範囲外 |
| U-7 | 本番の全不変量（DB / tunnel / dist / timer） | 対象外 |
| U-8 | DB role 分離 | 未実装（単一 role） |
| U-9 | 監査ハッシュ鎖の再計算 | 対象外 |
| U-10 | ルート HTML 以外の 41 ファイルが 500 である理由の妥当性 | 仕様判断。0400 統一を求めるなら要調整 |

---

## 11. 新たに観察した点（申し送り）

| # | 観察 | 影響 |
|---|---|---|
| N-1 | **`ai-helpdesk-stg-api.service` の UnitFileState が `disabled`** | 再起動・再ログイン後に自動起動しない。stg-proxy / stg-postgres は `enabled`。Staging を常用するなら `enable` を検討（要承認） |
| N-2 | deploy state が `result: "success"`、`previous` あり | Round 1 の `failed-no-previous`（rollback 不能）は解消。rollback 先が存在する |
| N-3 | repo の `apps/api/dist` は release と 22 ファイル不一致 | 本番 api は repo の dist で稼働中（commit `a5e0a67`）。release 方式との二重管理が続いている |
| N-4 | `--verify` に検証対象 root の指定が無い | §7 の FAIL の原因。CLI 拡張を提案 |
| N-5 | 配信 bytes 893,003 ≠ release ファイル 523,638 | 配信時 patch のため。**ハッシュだけでは配信 bytes を検証できない**（docs/81 U-8 と同じ留保） |
| N-6 | deploy state の `at` が UTC（`2026-11-05T23:27:35.798Z` = JST 08:27:35） | 表示の一貫性のみ。機能影響なし |

---

## 12. 判定

1. **(1) health/release 一致: PASS。** `commit` は release ID・manifest commit・HEAD と一致。
2. **(2) proxy: PASS。** 18951 は 200、MainPID 1945305、NRestarts 0、active/running。
3. **(3) timer: PASS（一部未観測）。** 3 timer enabled/active、3 service success。healthcheck は timer 起点発火を実測。backup/restore の timer 起点発火は未到来。
4. **(4) read-only: PASS。** dir 500、file 400（一部 500）、書込拒否、内容不変。ただし「0400 統一」は未達（41 ファイルが 500）。
5. **(5) manifest 検証: 指定コマンドは FAIL。** repo の script は自分の repo dist を検証するため release を検証できない。release 自身／repo lib を release に向ければ PASS（`ca8a7a34…`、196 files）。**release の欠陥ではなくツールの制約。**
6. **(6) 本番不変: PASS。** PID 2379216 / NRestarts 0 / commit `a5e0a67…`。
7. **(7) 前回未確認: proxy 原因は再現で確定、配信 HTML は 893,003 bytes を確認。`release.env` 本文は未確認のまま。**

**総合: Round 1 の主要な不合格は実測上すべて閉じた。** 残る論点は (a) `release.env` 本文の未確認、(b) backup/restore-drill の timer 起点発火の未観測、(c) manifest 検証 CLI の対象指定不能、(d) 一部ファイルが 0400 でないこと、(e) stg-api が disabled であること。いずれも「受入を止める」ものではないが、**未確認・未達として明記する**。

---

## 13. 再実行用コマンド（read-only）

```bash
# 0) 時刻・HEAD・current
date -Iseconds; git rev-parse HEAD; readlink /home/kensan/ai-helpdesk-stg/current

# 1) health（18952 / 18951 / 18950）
for p in 18952 18951 18950; do
  curl -sS -m5 -w " HTTP=%{http_code}\n" "http://127.0.0.1:$p/api/health"; done

# 2) unit / timer（show のみ）
systemctl --user show ai-helpdesk-stg-api ai-helpdesk-stg-postgres ai-helpdesk-stg-proxy \
  -p Id,ActiveState,SubState,MainPID,NRestarts,ExecMainStartTimestamp,EnvironmentFiles
for u in ai-helpdesk-stg-backup ai-helpdesk-stg-restore-drill ai-helpdesk-stg-healthcheck; do
  systemctl --user show "$u.timer" -p Id,ActiveState,UnitFileState,NextElapseUSecRealtime,LastTriggerUSec
  systemctl --user show "$u.service" -p Id,ActiveState,Result,ExecMainStatus,ExecMainStartTimestamp
done
tail -n 5 /home/kensan/ai-helpdesk-stg/state/healthcheck.log
tail -n 5 /home/kensan/ai-helpdesk-stg/state/restore-drill.log

# 3) release 権限と書込拒否（新規作成が失敗することを確認）
stat -c '%n mode=%a' /home/kensan/ai-helpdesk-stg/current
find -L /home/kensan/ai-helpdesk-stg/current -type f -printf '%m\n' | sort | uniq -c
PROBE=/home/kensan/ai-helpdesk-stg/current/.audit-write-probe-$$
touch "$PROBE" 2>/dev/null && { echo UNEXPECTED_WRITABLE; rm -f "$PROBE"; } || echo WRITE_REFUSED

# 4) manifest（release 自身／repo lib を release に向ける）
cd /home/kensan/ai-helpdesk-stg/current
node scripts/dist-manifest.mjs --verify \
  --manifest /home/kensan/ai-helpdesk-stg/current/dist-manifest.json \
  --commit 46261ea1eb3152287457d0c25e42a80106bc2a58
# repo の lib を release に向ける場合
node --input-type=module -e "
import { readManifestFile, verifyManifestAgainstDist } from '<repo>/scripts/lib/dist-manifest.mjs';
const m = await readManifestFile('/home/kensan/ai-helpdesk-stg/current/dist-manifest.json', { expectedCommit: '46261ea1eb3152287457d0c25e42a80106bc2a58' });
const r = await verifyManifestAgainstDist(m, { repoRoot: '/home/kensan/ai-helpdesk-stg/current' });
console.log('LIB_VERIFY_OK '+m.sha256+' files='+r.files);"

# 5) proxy 原因の再現（予備ポート。リスナーは残さない）
SEC=0123456789abcdef0123456789abcdef
env -i PATH=/usr/bin:/bin PROXY_SECRET=$SEC SIDECAR_PORT=18994 API_PORT=18952 \
  timeout 3 node <script-path>     # symlink 経由 / 実パス経由を比較
ss -ltn | grep -E ':18994\b' || echo "no listener"

# 6) 配信 HTML の実 bytes（合成ヘッダ。実 Access ではない）
curl -sS -m10 -o /dev/null -w 'HTTP=%{http_code} bytes=%{size_download}\n' \
  -H 'Cf-Access-Authenticated-User-Email: synthetic-staging@example.invalid' \
  http://127.0.0.1:18951/

# 7) DB（SELECT のみ）
CONF="$HOME/.config/ai-helpdesk/stg-api.conf"
# DATABASE_URL をシェル内で読み、password は PGPASSWORD にのみ渡す（表示しない）
# SELECT current_database(), inet_server_port(), current_user,
#   (SELECT count(*) FROM schema_migrations), ... users / knowledge / cases
```

---

## 14. 追記: 監査中の main 前進（2026-11-06T08:34:27+09:00 観測）

本監査の測定中に main が `46261ea` → `b1ffb52` へ進んだ（他担当による docs のみの commit）。

| 項目 | 値 |
|---|---|
| 新しい HEAD | `b1ffb52 docs: CTOバッチ1（10ステップ）の実測記録と独立検証の証跡を追加する` |
| `current` symlink | `releases/20261106T082716-46261ea1eb31`（**不変**） |
| health 18952 の `commit` | `46261ea1eb3152287457d0c25e42a80106bc2a58`（**不変**） |
| 本記録の測定時 HEAD | `46261ea`（§2 のスナップショット） |

**健康監視への影響は無い（実装を読んで確認）:** `scripts/stg-healthcheck.sh` の期待値 `EXPECTED` は **`current/dist-manifest.json` の `commit`** から取得しており、main の HEAD ではない。したがって docs-only commit で main が進んでも、release が据え置かれている限り `release_binding_mismatch` にはならない。

> 参考: `healthcheck.log` の 08:15:51 の FAIL（`actual=359cbd0… expected=e7d7f6f…`）は、当時 main が `e7d7f6f` で release が `359cbd0` だったことによる**過去の**不一致であり、現在の比較ロジック（release manifest 基準）とは別時点の記録である。

**含意:** 「main が進んだ」ことと「release が古い」ことは別問題であり、本監査の PASS 判定（release `46261ea` に対するもの）を変更しない。ただし main と release の差は運用上の追跡対象である（deploy は自動追従しない）。

---

## 15. 本監査の限界

- **単一時点（08:29〜08:33）の観測**である。proxy の継続稼働は約 5 分、timer 起点発火は healthcheck の 1 回のみを確認した。
- 「health 200」「Result=success」「manifest OK」はそれぞれ**局所的な信号**であり、Staging 受入の完了を意味しない。
- 復元・rollback・認証後 UI・実 Access は未実施。**推測は推測と明記し、未実施を成功扱いにしていない。**
- 本記録の (5) の FAIL は、release の不整合ではなく**検証コマンドの対象指定の問題**である。この区別を潰さずに残した。
