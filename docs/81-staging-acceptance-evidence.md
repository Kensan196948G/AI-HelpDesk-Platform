# 81. Staging 受入証拠（read-only 実測 / 2026-11-06 JST）

## 0. 結論（先に要点）

**本 doc は Staging の受入証拠を read-only 実測で拡充した記録であり、受入完了・配備 GO・`deploymentReady: true` を意味しない。**

| # | 要求 | 本 doc の結果 | 状態 |
|---|---|---|---|
| 1 | Staging API `http://127.0.0.1:18952/api/health` の ok/db/commit/env | `ok:true` / `db:"ok"` / `env:"production"` / **`commit:""`（空）** | 実測済み。commit 未束縛を明示 |
| 2 | Staging release の `apps/api/dist`・`dist-manifest.json` の SHA-256、ルート HTML の SHA-256 とサイズ | dist 集約 `082e815b…8481b` / manifest ファイル `277d0ae4…3dd7` / HTML `78b4d23b…ec3d`・523,638 bytes | 実測済み |
| 3 | Staging DB（`127.0.0.1:5437` / `ai_helpdesk_stg`）の migration・public table・users/knowledge/cases | migration **37** / public table **35** / users **6** / knowledge **9** / cases **3** | 実測済み |
| 4 | 本番不変: `ai-helpdesk-api` の MainPID・NRestarts、`18950` health の commit | MainPID **2379216** / NRestarts **0** / commit **`a5e0a67…`** | 実測済み（対象限定） |
| 5 | 実施できなかった項目と理由 | §7 に列挙 | 未実施を完了扱いにしない |

**最重要の未達:** Staging の health `commit` は空である。`/api/health` は 200 で `ok:true` / `db:"ok"` / `env:"production"` を返すが、**release と稼働 artifact の束縛は health では成立していない**（docs/78 S-1 の継続）。したがって本 doc は「Staging がローカルで起動し、DB に接続し、release の配信物を持つ」ことの証拠ではあるが、「配備が release に束縛された」ことの証拠ではない。

## 1. 前提と境界

### 1-1 作業環境

| 項目 | 値 |
|---|---|
| 作業ディレクトリ | `/home/kensan/Projects/Mirai-Admin-Platform/AI-HelpDesk-Platform` |
| 測定時の HEAD | `359cbd012274fd23ed3ee99a5a497236b4ac7711`（2026-11-06 06:25:44 +0900） |
| タイムゾーン | JST（`+09:00`）。health JSON 内の `time` は UTC |
| OS ユーザー | `kensan`（本番・Staging とも同一 UID。OS 主体の分離はない） |

### 1-2 docs/78・docs/80 の前提確認

要求どおり docs/78 と docs/80 を読んだ。ただし**両ファイルは本作業ツリー（main / `359cbd0`）には存在しない**ため、ローカル branch `docs/round1-record-20261106` の commit `11fb112` から `git show` で読んだ（作業ツリーへの checkout・変更はしていない）。

| 文書 | 読んだ実体 | 本 doc が引き継ぐ前提 |
|---|---|---|
| docs/78 | `11fb112:docs/78-staging-build-20261106.md` | 専用 PG16 `127.0.0.1:5437` / `ai_helpdesk_stg`、単一 role `aihd_stg`、release `20261106T063553-359cbd012274`、unit `ai-helpdesk-stg-{postgres,api,proxy}`、health 18952。S-1（`release.env` 未取込・commit 空）、S-2（proxy 未起動）、S-3（公開未構築）、S-6（release 不変化未実装）が残課題。 |
| docs/80 | `11fb112:docs/80-round1-record-20261106.md` | Round 1 の本番不変値（api PID 2379216 / NRestarts 0 / health commit `a5e0a67…`）と、承認プロンプト無効のため systemd 変更が自動拒否される Blocker（R-1〜R-4）。 |
| docs/77 | 作業ツリーの `docs/77-staging-environment-design.md`（未追跡） | 設計のみ。実装値は 5437 / `/home/kensan/ai-helpdesk-stg` で設計（5440 / `$HOME/apps/...`）と差分あり。 |

### 1-3 本 doc の境界（実行していないこと）

本 doc の作成中に実行したのは **read-only の参照・HTTP GET・SELECT・SHA-256 計算・manifest 検証・`systemctl show`** のみである。以下は**一切実行していない**。

- `systemctl` による `start` / `stop` / `restart` / `enable` / `disable` / `daemon-reload`
- サービスの作成・変更・再起動、unit ファイルの変更
- DB への `INSERT` / `UPDATE` / `DELETE` / DDL / `DROP` / migration の再実行
- デプロイ、release の生成・切替、`current` symlink の変更
- `git commit` / `push` / `merge` / branch 操作
- 秘密値・実メールアドレスの出力
- `docs/81` 以外のファイル変更

これは「本セッションで実行したコマンドの自己申告」であり、第三者的な操作証明ではない。§8 に実行コマンドを残す。

## 2. 測定スナップショット

| 測定 | 時刻（JST） |
|---|---|
| 受入スナップショット（health / unit） | 2026-11-06T07:05:31+09:00 |
| DB 件数 | 2026-11-06T07:05:25+09:00 |
| release / deploy state | 2026-11-06T07:05:16+09:00 |
| dist manifest 検証 | 2026-11-06T07:04:57+09:00 |
| artifact ハッシュ | 2026-11-06T07:04:47+09:00 |
| 補助（認証境界 / プロセス cwd / stg DB unit） | 2026-11-06T07:07:40+09:00 |
| release の migration ファイル数 | 2026-11-06T07:08:41+09:00 |

補助として 07:03:30〜07:03:31 にも同じ health / unit を取得し、値が同一であることを確認した。

## 3. (1) Staging API `/api/health` の実測

### 3-1 実測値

| 項目 | 値 |
|---|---|
| URL | `http://127.0.0.1:18952/api/health` |
| 測定時刻 | **2026-11-06T07:05:31+09:00** |
| HTTP | **200** |
| `ok` | **true** |
| `db` | **"ok"** |
| `commit` | **""（空文字）** |
| `env` | **"production"** |
| `service` / `version` | `"ai-helpdesk-api"` / `"0.1.0"` |
| `time`（応答内、UTC） | `2026-11-05T22:05:31.610Z` |
| `time_total` | 0.005993 s |

応答本文（実測そのまま）:

```json
{"ok":true,"service":"ai-helpdesk-api","version":"0.1.0","commit":"","db":"ok","time":"2026-11-05T22:05:31.610Z","env":"production"}
```

実行コマンド:

```bash
curl -sS -m5 -w '\nHTTP=%{http_code} time_total=%{time_total}s\n' \
  http://127.0.0.1:18952/api/health
```

### 3-2 応答の帰属（どのプロセスが返したか）

| 確認 | 値 |
|---|---|
| `18952` の待受 PID | `798937`（`node`） |
| `ai-helpdesk-stg-api` の MainPID | `798937`（一致） |
| ActiveState / SubState | `active` / `running` |
| ExecMainStartTimestamp | `Fri 2026-11-06 06:36:22 JST` |
| WorkingDirectory | `/home/kensan/ai-helpdesk-stg/current` |

```bash
ss -ltnp | grep -E ':18952\b'
systemctl --user show ai-helpdesk-stg-api \
  -p Id,ActiveState,SubState,MainPID,NRestarts,ExecMainStartTimestamp,WorkingDirectory
```

**判定:** `ok` / `db` / `env` は合格。**`commit` は空であり、health による release 束縛は不合格（未成立）**として扱う。空文字を成功扱いしない。

### 3-3 補助実測（認証境界とプロセスの cwd）

| 項目 | 値 | 測定時刻 |
|---|---|---|
| プロセス `798937` の cwd（`readlink /proc/798937/cwd`） | `/home/kensan/ai-helpdesk-stg/releases/20261106T063553-359cbd012274` | 2026-11-06T07:07:40+09:00 |
| `GET /`（未認証） | **401** | 2026-11-06T07:07:40+09:00 |
| `GET /api/me`（未認証） | **401** | 2026-11-06T07:07:40+09:00 |

```bash
readlink /proc/798937/cwd
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18952/
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18952/api/me
```

**意味と限界:** 稼働プロセスの cwd が `current` の実体 release を指すことを確認した。また未認証の `/` と `/api/me` は 401 で、匿名アクセスは拒否される。ただしこれは**認証境界の最小確認**であり、認証後 UI・合成 JWT・実 Access ログインの受入ではない（§7 U-4）。

## 4. (2) Staging release の artifact SHA-256

### 4-1 release の同一性

| 項目 | 値 |
|---|---|
| `current` symlink | `/home/kensan/ai-helpdesk-stg/releases/20261106T063553-359cbd012274` |
| release ID | `20261106T063553-359cbd012274` |
| manifest が主張する commit | `359cbd012274fd23ed3ee99a5a497236b4ac7711` |
| deploy state | `result: "failed-no-previous"`（`previous` が無く rollback 不能）、記録時刻 `2026-11-05T21:37:07.301Z` |

deploy state は `failed-no-previous`（`previous` が無く rollback 不能）である。docs/78 §2-1 は初回 deploy が health の commit 空で rollback したと記録しており、本 state と整合する。release は存在し API は起動しているが、**配備記録は成功ではない**。

### 4-2 SHA-256 とサイズ

| 対象 | SHA-256 | 補足 |
|---|---|---|
| `apps/api/dist` の canonical manifest 集約 | **`082e815b9cac9ac490fadc5792c2cc157b1a6e19a0a174a12597d4be8878481b`** | `dist-manifest.json` の `sha256` と一致。196 regular files |
| `dist-manifest.json` ファイル自体 | **`277d0ae465d5f2400c2a10b407d207e3e663019ceb4fd8c51f84f0ebb70d3dd7`** | 26,917 bytes / mode 600 |
| `apps/api/dist` 内の `.js` 98 本の sorted aggregate（docs/77 方式の参考値） | `2ee99de9369fae69616e7eda03161943f580ce0795bfa4eb437592159ef417e0` | `.js` を path 順に列挙し、各 file の sha256 をさらに sha256 した値 |
| ルート HTML | **`78b4d23bae48589da380e2f5d8f4e4f357243e952673fc67363ac7571dbaec3d`** | **523,638 bytes** / mode 700 |

ルート HTML のファイル名: `Mirai_AIHelpdesk_Cowork_StepWizard_V3.1_PCinfo_Offline.html`

### 4-3 manifest 検証

`dist-manifest.json` は 196 ファイル（`.js` 98 本を含む）の repo 相対 path・bytes・sha256 を持ち、`apps/api/dist` の実体と照合して **exit 0** で一致した。

```text
$ cd /home/kensan/ai-helpdesk-stg/current
$ node scripts/dist-manifest.mjs --verify \
    --manifest /home/kensan/ai-helpdesk-stg/current/dist-manifest.json \
    --commit 359cbd012274fd23ed3ee99a5a497236b4ac7711
DIST_MANIFEST_OK 082e815b9cac9ac490fadc5792c2cc157b1a6e19a0a174a12597d4be8878481b
exit=0
```

**注意（検証の限界）:**

- release は git checkout ではなく `.git` を持たないため、`--commit` を明示しない `--verify` は `DIST_MANIFEST_COMMIT_INVALID` で失敗する。上記は manifest が主張する commit を明示して**manifest ↔ dist のハッシュ一致**を確認したものであり、commit の真正性を独立に証明するものではない。
- manifest は署名のない自己生成 JSON である。`commit` は自己申告であり、build の再現性・配信 bytes の正しさ・改竄不能性は示さない。
- release はディレクトリ 700、ファイルは 600〜700（実測例: `dist-manifest.json` は 600、ルート HTML は 700）で、docs/78 S-6 の `chmod -R a-w` は未適用である。**「不変 release」は現時点で運用上の約束であり、ファイルシステムで強制されていない。** 本 doc のハッシュは 2026-11-06T07:04:47 時点の値である。

### 4-4 ルート HTML と commit の対応（補強）

release のルート HTML は、作業ツリー HEAD `359cbd0` の同ファイル blob と **SHA-256 が完全一致**し、作業ツリー側も未変更だった。

```bash
cd /home/kensan/Projects/Mirai-Admin-Platform/AI-HelpDesk-Platform
git cat-file -p HEAD:Mirai_AIHelpdesk_Cowork_StepWizard_V3.1_PCinfo_Offline.html | sha256sum
sha256sum Mirai_AIHelpdesk_Cowork_StepWizard_V3.1_PCinfo_Offline.html
git status --porcelain -- Mirai_AIHelpdesk_Cowork_StepWizard_V3.1_PCinfo_Offline.html
```

結果: 2 つの SHA-256 はともに `78b4d23b…ec3d`、サイズ 523,638 bytes、`git status` は空（未変更）。これは「release の HTML が commit `359cbd0` の HTML と同一 bytes」であることの証拠である。ただし dist 全体の再現 build 一致を示すものではない。

## 5. (3) Staging DB の実測

### 5-1 接続同一性

| 項目 | 値 |
|---|---|
| host / port | `127.0.0.1` / **5437** |
| database | **`ai_helpdesk_stg`** |
| role | `aihd_stg`（単一 role。owner/app 分離は未実装） |
| server | PostgreSQL **16.15**（Ubuntu 16.15-1.pgdg24.04+2） |
| 接続確認 | `current_database()=ai_helpdesk_stg` / `inet_server_port()=5437` |
| 待受 PID | `781949`（`postgres`） |
| unit | `ai-helpdesk-stg-postgres.service`（MainPID `781949` / NRestarts `0` / active since `Fri 2026-11-06 06:34:45 JST`） |

### 5-2 件数（2026-11-06T07:05:25+09:00 時点）

| 指標 | 値 | 取得元 |
|---|---|---|
| migration 件数 | **37** | `SELECT count(*) FROM schema_migrations` |
| release の migration ファイル数 | **37** | `/home/kensan/ai-helpdesk-stg/current/db/migrations/*.sql`（035〜037 を含む） |
| public の BASE TABLE 数 | **35** | `information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'` |
| users | **6** | `SELECT count(*) FROM users` |
| knowledge | **9** | `SELECT count(*) FROM knowledge` |
| cases | **3** | `SELECT count(*) FROM cases` |

1 回の SELECT で取得した実測行:

```text
ai_helpdesk_stg|5437|aihd_stg|16.15 (Ubuntu 16.15-1.pgdg24.04+2)|37|35|6|9|3
```

適用済み migration 37 行と release の `*.sql` 37 本は一致した（実行したのは SELECT とファイル列挙のみ）。

### 5-3 実行方法（秘密を表示しない）

`stg-api.conf` の `DATABASE_URL` をシェル内で読み、パスワードを `PGPASSWORD` に渡して `psql` を実行した。URL・パスワードは標準出力に出していない。

```bash
CONF=~/.config/ai-helpdesk/stg-api.conf
DBURL=$(awk -F= '/^DATABASE_URL=/{sub(/^DATABASE_URL=/,""); print; exit}' "$CONF")
# DBURL から host/port/user/db を取り出し、password は PGPASSWORD にのみ渡す（表示しない）
psql -h 127.0.0.1 -p 5437 -U aihd_stg -d ai_helpdesk_stg -At -F '|' -c "
  SELECT current_database(), inet_server_port(), current_user,
         current_setting('server_version'),
         (SELECT count(*) FROM schema_migrations),
         (SELECT count(*) FROM information_schema.tables
           WHERE table_schema='public' AND table_type='BASE TABLE'),
         (SELECT count(*) FROM users),
         (SELECT count(*) FROM knowledge),
         (SELECT count(*) FROM cases);"
```

**限界:** 実行したのは `SELECT` のみで、migration の再適用・seed の再投入・書込・DDL は行っていない。「migration 37 本適用済み」は `schema_migrations` の行数による観測であり、適用処理を本 doc で再実行した結果ではない。件数は 2026-11-06T07:05:25 時点の値で、以後の書込は追跡していない。

### 5-4 public table 一覧（35 件）

```text
ai_input_consents, assist_executions, assist_proposals, audit_log,
case_handover_notifications, case_handovers, case_messages, cases,
device_commands, device_inventories, device_mesh_links, device_tokens,
final_reports, folder_access_helpers, folder_access_ops,
folder_access_requests, folder_access_results, knowledge,
knowledge_reviews, mesh_install_requests, operation_consents, pc_snapshots,
prototype_states, resolution_sessions, resolution_steps, resolutions,
schema_migrations, sessions, skills, support_sessions, terminal_sessions,
terminal_steps, tickets, user_roles, users
```

## 6. (4) 本番の不変確認（対象を限定した実測）

### 6-1 実測値

| 項目 | 値 |
|---|---|
| unit | `ai-helpdesk-api.service` |
| ActiveState / SubState | `active` / `running` |
| **MainPID** | **2379216** |
| **NRestarts** | **0** |
| ExecMainStartTimestamp | `Wed 2026-11-04 10:04:02 JST` |
| InvocationID | `4f8d29d238904882a9dd8c6bab20939a` |
| `18950` の待受 PID | `2379216`（MainPID と一致） |
| 本番 health | HTTP **200** / `ok:true` / `db:"ok"` / `env:"production"` / **`commit:"a5e0a6719699d4711fc1811bbdb79c74d9aab393"`** |
| 本番 health 測定時刻 | 2026-11-06T07:05:31+09:00 |

応答本文:

```json
{"ok":true,"service":"ai-helpdesk-api","version":"0.1.0","commit":"a5e0a6719699d4711fc1811bbdb79c74d9aab393","db":"ok","time":"2026-11-05T22:05:31.628Z","env":"production"}
```

実行コマンド:

```bash
curl -sS -m5 -w '\nHTTP=%{http_code} time_total=%{time_total}s\n' \
  http://127.0.0.1:18950/api/health
systemctl --user show ai-helpdesk-api \
  -p Id,ActiveState,SubState,MainPID,NRestarts,ExecMainStartTimestamp,InvocationID
ss -ltnp | grep -E ':18950\b'
```

### 6-2 判定と範囲

- 本番 API は **MainPID 2379216 / NRestarts 0** で、docs/78 §3 および docs/80 の記録値と一致した。
- 本番 health の commit は **`a5e0a67…`** で、docs/78/80 の記録と一致した。
- **本 doc が示す「本番不変」は、この 2 信号（api unit と health commit）に限定される。** proxy / cloudflared / 本番 DB / tunnel config / 本番 dist / timer は本ラウンドで再測していない。したがって「本番全体が不変」とは主張しない。

## 7. (5) 実施できなかった項目と理由（未実施を完了扱いにしない）

| ID | 未実施・未確認の項目 | 状態 | 理由 / 必要な操作 |
|---|---|---|---|
| U-1 | Staging health の `commit` を release に束縛する | **未成立（commit 空）** | unit が `current/release.env` を `EnvironmentFile` として読んでいない（docs/78 S-1）。修正には unit 変更 + `daemon-reload` + restart が必要で、本セッションでは systemd 変更が禁止・承認プロンプト無効のため実行不可。 |
| U-2 | Staging proxy（`127.0.0.1:18951`）の起動と proxy 経由 smoke | **未実施** | `ss` で 18951 は **not listening**。`ai-helpdesk-stg-proxy.service` は `inactive` / `dead`（MainPID 0）。起動は `systemctl start` が必要で禁止。 |
| U-3 | 公開 Staging（新規 tunnel / DNS / Access アプリ） | **未実施** | Cloudflare アカウント変更（tunnel 作成・DNS 追加・Access app/AUD）が必要。read-only の範囲外で、承認も要る。 |
| U-4 | 認証後 UI・実 Access ログイン・実社員/貸与端末/別人物承認 | **未実施** | 人間の OTP・実ユーザー・実端末が必要。自動化不可。 |
| U-5 | restart / 自動 rollback / 復旧訓練の再実測 | **未実施** | `systemctl restart` 等が禁止。本 doc は稼働中プロセスの観測のみ。 |
| U-6 | migration の再適用・seed 再投入・DB 書込の検証 | **未実施（意図的）** | DB への書込・DDL・migration 再実行は禁止。件数は read-only の SELECT のみ。 |
| U-7 | 本番の全不変量（proxy / cloudflared / DB / tunnel / dist / timer） | **未実施** | 本ラウンドの要求は api の MainPID・NRestarts と health commit であり、それ以外は再測していない。過去 doc の値は再検証していない。 |
| U-8 | 配信ルート HTML の bytes / SHA-256 | **未再測** | 配信 `/` は認証境界の内側で、proxy secret を伴う合成リクエストが必要。本 doc の HTML ハッシュは **release 内ファイル**の値であり、配信時 bytes（patch 適用後）とは別物。docs/78 §7-2 の 893,003 bytes は再測定していない。 |
| U-9 | release の不変化（`chmod -R a-w`） | **未実装・未確認** | 実測 mode はディレクトリ 700、ファイル 600〜700（例: manifest 600、HTML 700）で、書換可能。docs/78 S-6 の残課題。 |
| U-10 | artifact の署名・正規 build 来歴 | **未確認** | `dist-manifest.json` は署名のない自己生成 JSON。commit は自己申告で、独立の署名・CI artifact 照合はない。 |
| U-11 | DB role 分離（owner/app）・staging backup | **未実施** | docs/78 S-4 / S-5 の残課題。本 doc の範囲外。 |
| U-12 | docs/78・docs/80 の main ツリー存在 | **不在** | main `359cbd0` には存在せず、branch `docs/round1-record-20261106`（`11fb112`）から読んだ。main への merge は本 doc の範囲外。 |

**明示:** 上記 U-1〜U-12 は「未実施」であり、本 doc をもって完了・合格とはしない。特に U-1 により、Staging の health は依然として release を指し示していない。

## 8. 再実行用コマンド（read-only）

```bash
# 0) 時刻・HEAD
date -Iseconds
git log -1 --format='%H %ci %s'

# 1) Staging / 本番 health
curl -sS -m5 -w '\nHTTP=%{http_code} time_total=%{time_total}s\n' http://127.0.0.1:18952/api/health
curl -sS -m5 -w '\nHTTP=%{http_code} time_total=%{time_total}s\n' http://127.0.0.1:18950/api/health

# 2) unit（read-only show。start/stop/restart はしない）
systemctl --user show ai-helpdesk-stg-api \
  -p Id,ActiveState,SubState,MainPID,NRestarts,ExecMainStartTimestamp,WorkingDirectory
systemctl --user show ai-helpdesk-api \
  -p Id,ActiveState,SubState,MainPID,NRestarts,ExecMainStartTimestamp,InvocationID
systemctl --user show ai-helpdesk-stg-postgres ai-helpdesk-stg-proxy \
  -p Id,ActiveState,SubState,MainPID,NRestarts,ExecMainStartTimestamp

# 2b) Staging の認証境界とプロセス cwd
readlink /proc/798937/cwd
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18952/
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18952/api/me

# 3) release / artifact
readlink -f /home/kensan/ai-helpdesk-stg/current
cd /home/kensan/ai-helpdesk-stg/current
find apps/api/dist -type f | wc -l
find apps/api/dist -type f -name '*.js' | wc -l
sha256sum dist-manifest.json
sha256sum Mirai_AIHelpdesk_Cowork_StepWizard_V3.1_PCinfo_Offline.html
stat -c '%n size=%s mode=%a' Mirai_AIHelpdesk_Cowork_StepWizard_V3.1_PCinfo_Offline.html
node scripts/dist-manifest.mjs --verify \
  --manifest /home/kensan/ai-helpdesk-stg/current/dist-manifest.json \
  --commit 359cbd012274fd23ed3ee99a5a497236b4ac7711

# 4) DB（SELECT のみ。DATABASE_URL / password は表示しない）
find /home/kensan/ai-helpdesk-stg/current/db/migrations -maxdepth 1 -type f -name '*.sql' | wc -l
CONF=~/.config/ai-helpdesk/stg-api.conf
DBURL=$(awk -F= '/^DATABASE_URL=/{sub(/^DATABASE_URL=/,""); print; exit}' "$CONF")
# DBURL から host/port/user/db を取り出し、password は PGPASSWORD に渡す
psql -h 127.0.0.1 -p 5437 -U aihd_stg -d ai_helpdesk_stg -At -F '|' -c "
  SELECT current_database(), inet_server_port(), current_user,
         current_setting('server_version'),
         (SELECT count(*) FROM schema_migrations),
         (SELECT count(*) FROM information_schema.tables
           WHERE table_schema='public' AND table_type='BASE TABLE'),
         (SELECT count(*) FROM users),
         (SELECT count(*) FROM knowledge),
         (SELECT count(*) FROM cases);"

# 5) 待受の帰属
ss -ltnp | grep -E ':(18950|18952|5437)\b'
```

## 9. 判定

1. **(1) Staging health:** `ok:true` / `db:"ok"` / `env:"production"` を実測。未認証 `/` と `/api/me` は 401（§3-3）。ただし `commit:""` のため **release 束縛は未成立**。合格扱いにしない。
2. **(2) release artifact:** dist 集約 `082e815b…8481b`、manifest ファイル `277d0ae4…3dd7`、HTML `78b4d23b…ec3d`（523,638 bytes）を実測。manifest ↔ dist のハッシュ一致は確認。ただし manifest は無署名・自己申告で、release は書換可能（不変化未実装）。
3. **(3) DB:** `127.0.0.1:5437` / `ai_helpdesk_stg` / `aihd_stg` を同一性確認。migration 37、public table 35、users 6、knowledge 9、cases 3。SELECT のみ。
4. **(4) 本番:** `ai-helpdesk-api` MainPID 2379216 / NRestarts 0 / health commit `a5e0a67…` を実測。範囲はこの 2 信号に限定。
5. **(5) 未実施:** §7 の U-1〜U-12 を未実施として明記。**完了扱いにしていない。**

**総合:** 本 doc は Staging のローカル read-only 受入証拠の拡充であり、**Staging 受入の完了・本番昇格・`deploymentReady` の変更を意味しない。** 次の実質的な前進は、承認後に U-1（unit への `release.env` 取込 + restart）を実施し、health の `commit` が `359cbd0…` になることを再実測することである。

## 10. 追加実測: 復元 DB 上の監査ハッシュ鎖（2026-11-06 07:12 JST / Lead）

Ralph の完了後、Lead が R-6（復元後の監査鎖検証）を追加実施した。

| 項目 | 結果 |
|---|---|
| 入力 | 最新 backup `ai_helpdesk_preview-20261106-023218.dump` |
| 復元先 | `127.0.0.1:5437` / `aihd_restore_drill_20261106b`（staging クラスタ内の使い捨て DB。本番 DB・本番クラスタには触れない） |
| 復元結果 | 成功（`pg_restore --no-owner --no-privileges --exit-on-error`） |
| 検査 | `NODE_ENV=production AUDIT_SCAN_DATABASE_URL=<drill>` で `npx tsx scripts/audit-find-breaks.ts` |
| `readOnly` | `true`（`default_transaction_read_only=on`） |
| 検査行数 | **80 行** |
| 検出 | **2 件（id 10010 / 10013、種別 `hash_mismatch`）** — いずれも本番が `AUDIT_KNOWN_BREAKS` に設定している既知破断と一致 |
| `prev_hash_mismatch` | **0 件**（鎖の欠損・分岐なし） |
| 後処理 | drill DB を削除（接頭辞を検証） |

**意味**: バックアップから復元した DB の監査鎖は、本番が既知破断として扱っている 2 点以外に破断・欠損が無い。これは「復元しても監査鎖が壊れていない」ことの実測であり、監査チェーンの暗号学的な真正性や改ざん不能性の証明ではない。

