# 77. 独立 Staging 環境の設計（Batch1-10 / 2026-11-06）

## 0. この文書の位置づけ

**本書は設計のみである。実装・配備・サービス変更・DB 作成・tunnel/DNS/Access 変更は一切行っていない。** 記録した数値は、稼働環境に対する read-only の実測と、リポジトリ内のソース読取に限られる。`deploymentReady: false` を維持し、第2組 11（immutable release）と 12（独立 Staging）の**設計入力**であって完了報告ではない。

要求（Batch1-10 の 9 項目）との対応:

| # | 要求 | 本書の節 |
|---|---|---|
| 1 | 目標アーキテクチャ（checkout / port / DB / hostname / unit / release / symlink / rollback） | §3 |
| 2 | 推奨ポート・DB 名・unit 名・ディレクトリ構成の具体案 | §3-3〜§3-6 |
| 3 | 配備フロー（build → release → smoke → 切替 → health → rollback） | §4 |
| 4 | 本番への影響ゼロの証明方法 | §5 |
| 5 | tunnel ingress 追加手順・ロールバック・承認境界 | §6 |
| 6 | smoke 項目（health/sha/未認証/DB/migration/主要フロー） | §7 |
| 7 | 段階的ロールアウト計画（Batch2 の順序・依存） | §8 |
| 8 | リスクと未解決点（同一ホストの限界） | §9 |
| 9 | 承認が必要な操作の切り分け | §6-4 |

## 1. 現状の実測（read-only、2026-11-06 06:2x JST）

| 項目 | 実測値 | 取得方法 |
|---|---|---|
| リポジトリ main | 作業開始時 `2deffab`、執筆時 `359cbd01`（11/6 06:25 に #136 が進行） | `git log -1` |
| 稼働 API | systemd user `ai-helpdesk-api.service`、`WorkingDirectory=/home/kensan/Projects/Mirai-Admin-Platform/AI-HelpDesk-Platform`、`ExecStart=node apps/api/dist/index.js`、`EnvironmentFile=%h/.config/ai-helpdesk/api.conf`、drop-in で `Restart=always` | unit ファイル読取 |
| 稼働 proxy | `ai-helpdesk-proxy.service`、`SIDECAR_PORT=18949` / `API_PORT=18950` を **unit に固定** | unit ファイル読取 |
| 待受 | `127.0.0.1:18950`（node）、`127.0.0.1:18949`（node）、`127.0.0.1:5435`（cgroup=docker.service） | `ss -ltnp` |
| health（proxy 経由） | `ok:true` / `commit:"a5e0a6719699d4711fc1811bbdb79c74d9aab393"` / `env:"production"` / `db:"ok"` | `curl 127.0.0.1:18949/api/health` |
| dist の鮮度 | `apps/api/dist` 最終書込 11/4 09:54（`index.js` 11/4 10:04）。**11/5 以降に更新された `.js` は 0 件** | `find -newermt` / `stat` |
| DB 実体 | `127.0.0.1:5435` は Docker コンテナ `deepseek-harness-postgres`（host 5435 → container 5432）。`pg_lsclusters` 管理外 | `ss -ltnpe`（cgroup）、`docker ps` |
| DB 名 / role | `ai_helpdesk_preview`。接続 role は `deepseek_harness` | `ps` の postgres セッション表示 |
| tunnel | user unit `ai-helpdesk-cloudflared.service`、`--config %h/.cloudflared/ai-helpdesk-config.yml`、tunnel `96d0214e-8236-4bce-8dd0-75233d1e716f`、ingress は hostname 1 本 → `http://127.0.0.1:18949` + `http_status:404` | unit / config 読取 |
| 資源 | `/` 85% 使用（空き 139G）、Mem 空き 17G、PG16 バイナリ（`initdb`/`pg_ctl`/`pg_dump`/`psql`）あり | `df`、`free`、`ls` |
| 候補ポート | 18951 / 18952 / 18953 / 18962 は空き。**5436 は使用中**（5440〜5443 は空き） | `ss -ltn` |
| 配信物 | ルート HTML 1 本、`apps/api/src/prototype/*.js` 11 本、`scripts/skills/windows/*.ps1` 21 本（catalog 実体 20 + 検証用 `diag-sleep`） | `ls` |

基準 digest（本番側の不変量比較に使う。秘密値は含めない）:

| 対象 | SHA-256 |
|---|---|
| `~/.cloudflared/ai-helpdesk-config.yml`（0600, 254 bytes） | `d51927da44c6b778c61f84743b3a79be530f713150e43b2552a7f1f69fa35d5b` |
| `~/.config/systemd/user/ai-helpdesk-api.service` | `78cb196e1f54079ab77a2699226a5f67874a9cf7537e4b30b8026968ba5278ff` |
| 同 drop-in `restart-always.conf` | `2dc58c285168f086b2dd5bd1e1ee52cddc756235f35deb2e13a1af45028756d9` |
| `ai-helpdesk-proxy.service` | `3f57b612f4ce0fb716f76e427622899897c1c3b027a9a64c3e97f423b44a118a` |
| `ai-helpdesk-cloudflared.service` | `995ea2795293814ae0f54c2062566db4cdc78396048461e864f324f49575c0eb` |
| dist 内 `.js` 全 98 本の sorted sha256 の sha256 | `0b537e7c58900b2fb0be255340cd9a9879a2ed3d03e1498401536ccb6bde7ea2` |
| ルート HTML | `78b4d23bae48589da380e2f5d8f4e4f357243e952673fc67363ac7571dbaec3d` |

`~/.config/ai-helpdesk/api.conf`（0600, 秘密を含む）は**内容を読まず**、bytes 同一性の基準（`sha256sum` と `stat`）だけを §5 の手順で前後比較する。

### 1-1 この実測が示す最大のギャップ

- **checkout と稼働 artifact が一致していない。** main は 11/6 に 2 件進んでいるが、dist は 11/4 以降再生成されていない。health の `commit` は「設定の自己申告」であり artifact の出自証明ではない（[70](70-cto-staging-production-readiness.md) と同じ留保）。
- **配備 = checkout の git 更新 + dist 再生成 + 再起動**であり、release の単位も rollback の単位も存在しない。
- 配信 HTML と bridge は `repoRoot` 相対で読まれる（`apps/api/src/routes/prototype.ts` が `path.join(repoRoot, ...)`、`config.ts` の `repoRoot = path.resolve(dist, '../../..')`）。したがって**稼働中 checkout の更新自体が配備**になり得る。
- DB は harness と同居する Docker クラスタ内の 1 DB で、物理・権限の分離がない。
- 独立環境がないため、R2/R3 を開く検証も、「壊して戻す」訓練も本番でしかできない。これが [70](70-cto-staging-production-readiness.md) の項目 12 の未達理由である。

## 2. 設計原則

1. **本番のファイル・unit・port・DB・tunnel に一度も書き込まない。** staging 側の操作は staging の名前空間（`-stg-`、`ai-helpdesk-stg`、`ai_helpdesk_stg`、18951/18952、5440）だけに閉じる。
2. **配備は「不変 release の生成」と「symlink の切替」に分ける。** build は release 外の作業領域で行い、release は生成後に書き換えない。
3. **rollback は「直前 release へ戻す」だけで完結させる。** DB の巻き戻しは通常 rollback に混ぜない（[70](70-cto-staging-production-readiness.md) 項目 13 の制約）。DB 復元は別承認の訓練として新規 DB 名に対してのみ行う。
4. **失敗は閉じる。** 対象 DB 名・port・unit 名・checkout path を実行前に照合し、1 つでも違えば停止する。名前の自己申告だけを根拠にしない。
5. **本番影響ゼロは「実行しない」と「不変量の前後一致」の二重で示す。** どちらも単独では証明にならない（§5-3）。

## 3. 目標アーキテクチャ

### 3-1 分離マトリクス

| 層 | 本番相当（現状・不変） | Staging（新規・本書の設計） | 共有するもの |
|---|---|---|---|
| git checkout | `/home/kensan/Projects/Mirai-Admin-Platform/AI-HelpDesk-Platform`（main） | build 時のみ `$HOME/apps/ai-helpdesk-stg/build/<sha>`（detached worktree、release 後削除） | 同一 git オブジェクト DB（read-only 参照） |
| release | なし（checkout 直配備） | `$HOME/apps/ai-helpdesk-stg/releases/<UTC>-<sha7>/` + `current` symlink | なし |
| 実行ユーザー | `kensan`（systemd user） | `kensan`（同一。**OS 主体の分離はしない**＝§9 の限界） | 同一 UID |
| API port | `127.0.0.1:18950` | `127.0.0.1:18952` | なし（port 単位で分離） |
| proxy port | `127.0.0.1:18949` | `127.0.0.1:18951` | なし |
| DB | `127.0.0.1:5435` / `ai_helpdesk_preview`（docker `deepseek-harness-postgres`） | `127.0.0.1:5440` / `ai_helpdesk_stg`（専用 PG16 クラスタ、§3-5） | ホストの CPU/メモリ/ディスクのみ |
| systemd unit | `ai-helpdesk-api` / `-proxy` / `-cloudflared` / `-backup` / `-tunnel-watch` | `ai-helpdesk-stg-db` / `-stg-api` / `-stg-proxy` / `-stg-cloudflared`（承認後） | user manager（同一 `systemctl --user`） |
| env | `~/.config/ai-helpdesk/api.conf`（0600） | `~/.config/ai-helpdesk-stg/api.conf`（0700 dir / 0600 file、**値は複製しない**） | なし |
| Access allowlist | `docs/MailAddress.txt`（実アドレスを含み得る、Git 追跡） | `~/.config/ai-helpdesk-stg/allowlist.txt`（絶対 path 指定、合成または試験担当のみ） | なし |
| 承認 manifest | `scripts/skills/approved.json`（実承認者情報を含み得る、Git 追跡） | release 内に**空 manifest**または合成 manifest | なし |
| hostname | `ai-helpdesk.mirai-dx-platform.com` | `ai-helpdesk-stg.mirai-dx-platform.com` | 同一ゾーン |
| tunnel | `96d0214e…`（既存・不変） | 新規 tunnel + 専用 config/unit（§6-2） | Cloudflare アカウント |
| Access app / AUD | 既存 | 新規 app（staging 用 AUD、テスター限定） | 同一 team domain |
| backup | timer `ai-helpdesk-backup`、`$HOME/backups/ai-helpdesk` | staging 専用 dump を `…/shared/backup`（保持 7 日） | なし |

### 3-2 ディレクトリ構成

```
$HOME/apps/ai-helpdesk-stg/                 0700
├── build/<sha>/                            # 一時。detached worktree + npm ci + tsc。release 後に削除
├── releases/<UTC>-<sha7>/                  # 不変。生成後 chmod -R a-w（= 0555/0444）
│   ├── Mirai_AIHelpdesk_Cowork_StepWizard_V3.1_PCinfo_Offline.html
│   ├── apps/api/dist/**                    # 98 JS（maps は含めない）
│   ├── apps/api/src/prototype/*.js         # 配信 bridge 11 本
│   ├── scripts/skills/windows/*.ps1        # catalog 実体 20 本（diag-sleep は含めない）
│   ├── scripts/skills/approved.json        # 空 or 合成 manifest（実承認者を含めない）
│   ├── package.json / apps/api/package.json / package-lock.json
│   ├── node_modules/                       # prod-only 導入（55 packages 相当）
│   ├── release.env                         # COMMIT_SHA / RELEASE_ID / RELEASE_BUILT_AT
│   └── release.json                        # ファイル数・総 bytes・集約 SHA-256・build 環境
├── current -> releases/<UTC>-<sha7>        # 切替点（原子的に差し替え）
├── previous -> releases/<旧ID>             # rollback 用
├── pg/{data,postgresql.conf,staging.marker}  # 専用 PG16 クラスタ（§3-5）
├── shared/{evidence,logs,backup,locks}/     # 0700。release 外の可変領域
└── tmp/                                    # TMPDIR（compile cache 無効化時の受け皿）
```

`current` は `releases/` の外を指してはならない（配備スクリプトが `realpath` で検査）。`pg/` と `shared/` は release に含めない（不変化の対象外）。

### 3-3 具体値

| 項目 | 値 | 備考 |
|---|---|---|
| API port | **18952** | `ss` で空きを確認済み（11/6）。本番 18950 と重複させない |
| proxy port | **18951** | 本番 18949 と重複させない |
| 予備 | 18953 / 18962 | 次の検証スロット用に空けておく |
| DB port | **5440** | 5435（本番相当）、5436（使用中）、5432/55438（システムクラスタ）と重複させない |
| DB 名 | **ai_helpdesk_stg** | test の `ai_helpdesk_test` とも別名。固定名にする（動的名にしない） |
| DB owner role | `aihd_stg_owner` | migration 実行用。ログインは `initdb -U` で作成 |
| DB app role | `aihd_stg_app` | 起動時用。`CONNECT` + schema USAGE + 必要 DML のみ |
| systemd unit | `ai-helpdesk-stg-db.service` / `ai-helpdesk-stg-api.service` / `ai-helpdesk-stg-proxy.service` / `ai-helpdesk-stg-cloudflared.service` | 1 つでも `-stg-` を欠いたら配備スクリプトは停止 |
| hostname | `ai-helpdesk-stg.mirai-dx-platform.com` | 既存ゾーン。DNS レコードは承認後に作成 |
| tunnel 名 | `ai-helpdesk-stg` | 既存 `96d0214e…` とは別 |
| Access AUD | staging 専用 app の AUD | 本番 AUD を流用しない |
| env ファイル | `~/.config/ai-helpdesk-stg/api.conf` | 本番ファイルを copy しない（§3-6） |
| release 保持 | 5 世代 + `previous` | 空き 50G を割る前に prune（§9 R2） |
| 最小空きディスク | 50G（配備/DB 初期化の前提条件） | 85% 使用の現状では必須ゲート |

### 3-4 systemd unit 設計（案）

```ini
# ~/.config/systemd/user/ai-helpdesk-stg-api.service
[Unit]
Description=AI HelpDesk Staging API (127.0.0.1:18952)
After=network-online.target ai-helpdesk-stg-db.service
Wants=ai-helpdesk-stg-db.service

[Service]
Type=simple
WorkingDirectory=%h/apps/ai-helpdesk-stg/current
EnvironmentFile=%h/.config/ai-helpdesk-stg/api.conf
EnvironmentFile=%h/apps/ai-helpdesk-stg/current/release.env
ExecStart=/home/kensan/.nvm/versions/node/v22.22.3/bin/node apps/api/dist/index.js
Restart=always
RestartSec=2
TimeoutStopSec=10
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full

[Install]
WantedBy=default.target
```

```ini
# ~/.config/systemd/user/ai-helpdesk-stg-proxy.service
[Service]
WorkingDirectory=%h/apps/ai-helpdesk-stg/current
EnvironmentFile=%h/.config/ai-helpdesk-stg/api.conf
Environment=SIDECAR_PORT=18951
Environment=API_PORT=18952
ExecStart=/home/kensan/.nvm/versions/node/v22.22.3/bin/node scripts/proxy-sidecar.mjs
Restart=always
RestartSec=2
```

```ini
# ~/.config/systemd/user/ai-helpdesk-stg-db.service
[Unit]
Description=AI HelpDesk Staging PostgreSQL 16 (127.0.0.1:5440)

[Service]
Type=notify
ExecStart=/usr/lib/postgresql/16/bin/postgres -D %h/apps/ai-helpdesk-stg/pg/data \
  -c config_file=%h/apps/ai-helpdesk-stg/pg/postgresql.conf
ExecReload=/bin/kill -HUP $MAINPID
ExecStop=/usr/lib/postgresql/16/bin/pg_ctl -D %h/apps/ai-helpdesk-stg/pg/data -m fast stop
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
```

設計判断と注意:

- **`COMMIT_SHA` は env ファイルに手書きしない。** release 内の `release.env` から読む。これで「切替 symlink」と「health の commit」が同じ release に束縛され、env の取り違えで別 SHA を自己申告する事故を減らせる。ただし health の commit は依然として自己申告なので、artifact の同一性は `release.json` の集約 digest で別に示す（§5）。
- **`ExecStart` は `current` symlink 経由**。symlink を差し替えて `restart` すれば新しい release が起動する。systemd は起動時に解決するため、切替には必ず restart が要る（hot reload は無い）。
- `ProtectHome=read-only` などの追加硬化は、`EnvironmentFile` と `TemporaryDirectory` の挙動を T5 で実測してから採る。設計時点で入れて「動くはず」と主張しない。
- staging の起動は **本番と同じ `NODE_ENV=production`**。test 用の検証フラグ（`RESOLVE_PATH_MODE` 等）は本番同様 off のまま起動し、機能の有効化は staging の受入項目として別に扱う。

### 3-5 DB 分離設計（2 案）

| 案 | 構成 | 分離の強さ | 欠点 | 位置づけ |
|---|---|---|---|---|
| **B（推奨）専用クラスタ** | `initdb` で `$HOME/apps/ai-helpdesk-stg/pg/data` を作成、`127.0.0.1:5440`、SCRAM、role 2 つ | 物理・権限・故障域・バックアップが別。本番 DB の superuser から staging が見えない（逆も） | もう 1 インスタンス分のメモリ/ディスクを使う。Debian のクラスタ管理外なので運用手順を自作 | Batch2 T2 |
| A（代替）論理分離 | 既存 5435 クラスタ内に `ai_helpdesk_stg` DB + `aihd_stg_*` role、`REVOKE CONNECT ... FROM PUBLIC` と明示 GRANT | 論理のみ。superuser（`deepseek_harness`）は全 DB を読める。harness と故障域・バックアップ対象を共有 | 本番 DB と同じクラスタで、`pg_dump`/`DROP` の取り違えが 1 コマンドで届く | 承認時のみ・期限付き |

推奨 B の初期化（設計案・未実行）:

```bash
# 1) initdb（owner は aihd_stg_owner。パスワードは stdin から渡し argv/log に出さない）
umask 077
/usr/lib/postgresql/16/bin/initdb -D "$HOME/apps/ai-helpdesk-stg/pg/data" \
  -U aihd_stg_owner --pwfile=<(printf '%s\n' "$STG_DB_PASSWORD") \
  --auth-local=scram-sha-256 --auth-host=scram-sha-256 --encoding=UTF8 --locale=C.UTF-8
# 2) postgresql.conf: listen_addresses='127.0.0.1', port=5440,
#    unix_socket_directories=$HOME/apps/ai-helpdesk-stg/pg/sock, log_destination=stderr
# 3) クラスタ識別マーカー（破壊操作の前提条件）
printf 'ai-helpdesk-stg\n' > "$HOME/apps/ai-helpdesk-stg/pg/staging.marker"   # 0600
```

- **locale / encoding は本番と揃えるのが原則。** 本番クラスタの `encoding`/`collate`/`ctype` は未確認（`pg_lsclusters` 管理外の Docker コンテナなので、read-only で `SHOW` を取る別手順が要る）。揃えない場合、照合順・索引挙動が本番と変わり得る点を §9 の未解決に残す。
- `ai_helpdesk_stg` は `aihd_stg_owner` が所有し、`aihd_stg_app` には `CONNECT`・`USAGE`・必要テーブルの DML だけを与える。migration は owner で実行する。
- **破壊操作のガード:** `dropdb` / `pg_restore --clean` の前に、(a) `current_database()` が `ai_helpdesk_stg`、(b) 接続先が `127.0.0.1:5440`、(c) `pg/staging.marker` の内容が `ai-helpdesk-stg`、(d) data directory が `…/pg/data`、の 4 点を照合する。1 つでも欠ければ停止する。名前だけの一致を根拠にしない。
- staging の dump は `…/shared/backup/` に 0600 で置き、**本番 backup ディレクトリと混ぜない**。保持 7 日。

### 3-6 env 分離（本番 api.conf を流用しない）

`~/.config/ai-helpdesk-stg/api.conf`（0600、`~/.config/ai-helpdesk-stg/` は 0700）に置く項目と方針:

| 変数 | staging の値 / 方針 | 理由 |
|---|---|---|
| `NODE_ENV` | `production` | 本番と同じ起動条件で受入するため。test 用の緩和を staging の既定にしない |
| `PORT` / `HOST` | `18952` / `127.0.0.1` | 本番と別 port。公開は tunnel 経由のみ |
| `DATABASE_URL` | `postgres://aihd_stg_app@127.0.0.1:5440/ai_helpdesk_stg`（パスワードは同ファイル内） | 本番 DSN と構造から別。配備時に host/port/DB 名を照合 |
| `MIRAI_INFO_DATABASE_URL` | **必須で staging DB を指す** | 未設定だと `apps/api/src/lib/mirai-info.ts` が `/var/run/postgresql` の `mirai_info`（実名簿）へ fallback する。staging から実 PII を読ませない |
| `SESSION_SECRET` | 新規生成（32 文字以上） | 本番と共有しない |
| `PROXY_SECRET` | 新規生成 | 共有すると staging 側の漏洩が本番 proxy ヘッダ偽装に使える |
| `REQUIRE_PROXY_SECRET` | `true` | 本番と同じ境界 |
| `COOKIE_SECURE` | `true` | 公開時は HTTPS のみ |
| `ALLOWED_ORIGINS` | `https://ai-helpdesk-stg.mirai-dx-platform.com` | 本番 origin を入れない |
| `AUTH_MODE` / `ACCESS_JWT_MODE` | `cloudflare-access` / `enforce` | staging でも認証を弱めない。`off` で公開しない |
| `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` | 同一 team / **staging 専用 AUD** | AUD は秘密ではないが、本番 AUD を流用すると本番アプリの JWT が staging で通る |
| `ACCESS_ALLOWLIST_FILE` | `~/.config/ai-helpdesk-stg/allowlist.txt`（絶対 path） | `apps/api/src/auth/allowlist.ts` は絶対 path をそのまま使う。実名簿ファイルを release に含めない |
| `MAIL_TRANSPORT` | `disabled` | staging から実宛先へ通知しない。配送試験は専用 SMTP sink を別途 |
| `NOTIFY_BASE_URL` | staging hostname | 通知本文のリンクが本番 URL を指さないようにする |
| `DEEPSEEK_*` | 専用キー（quota 付き）または無効化を選択（§10-5） | 本番キーの共有は費用・データ境界の双方で不可 |
| `AUDIT_KNOWN_BREAKS` | 空（新規 DB には既知破断が無い）または staging 実測値 | 既定値は本番 DB で実測した ID 2 件。staging では成立しない |
| `COMMIT_SHA` | **置かない**（release.env から供給） | 手書きの自己申告を避ける |

DSN は 2 本を使い分ける（どちらも §4-6 の照合対象）:

- **アプリ用**: `aihd_stg_app`。`api.conf` の `DATABASE_URL`。DML のみ。
- **migration 用**: `aihd_stg_owner`。配備スクリプトが一時的に環境変数で渡し、argv・ログ・証跡に出さない（`scripts/run-with-env-file.mjs` と同じ「シェルで source しない」流儀）。migration 以外の用途に使わない。

## 4. 配備フロー

### 4-1 全体像（設計案・未実行）

```
[0] preflight     本番不変量スナップショット + 空き資源 + port/DB/unit 名の照合
      │  失敗 → 何も作らない
[1] build         git worktree add --detach <sha>（main の祖先であること）
                  npm ci（lock 厳守）→ tsc（NODE_DISABLE_COMPILE_CACHE=1, TMPDIR=…/tmp）
                  → 出力の欠落/余剰 0 を確認
[2] release       bundle を releases/<UTC>-<sha7>/ に組み立て（§4-3）
                  release.json（集約 SHA-256）→ chmod -R a-w → build 領域削除
[3] db            対象 DB の同一性確認（§3-5 の 4 点）→ 事前 dump 取得
                  → migration 適用 → 適用本数と再実行 0 を確認
[4] switch        current.new → current を rename で原子的に差し替え
                  → ai-helpdesk-stg-db/api/proxy のみ restart
[5] health        /api/health が ok / db:ok / env:production / commit==<sha> になるまで待つ（30 秒）
[6] smoke         §7 の S-01〜S-12 を実行（公開系は承認後）
[7] evidence      preflight と同一の不変量を再取得し、差分 0 を確認して保存
[8] 失敗時        current を previous へ戻し restart → health で旧 release を確認
                  （DB は戻さない。§4-5）
```

### 4-2 各段階の失敗時の扱い

| 段階 | 失敗の例 | 扱い |
|---|---|---|
| preflight | 本番不変量が取得できない / 空き 50G 未満 / port 使用中 | 即停止。release を作らない |
| build | lock 不一致 / tsc 失敗 / 出力欠落 | 即停止。build 領域を破棄。release を作らない |
| release | 必須 asset 欠落（HTML/bridge/skill/manifest） | 即停止。**部分 release を作らない**（無音で HTML を配信しないため） |
| db | DB 名/port/マーカー不一致 / migration 失敗 | 即停止。切替しない。`current` は旧のまま |
| switch | symlink 更新失敗 | 即停止。旧 `current` のまま |
| health | 30 秒で条件不一致 | **自動 rollback**（previous へ）+ 失敗証跡 |
| smoke | 1 項目でも不合格 | 自動 rollback + 不合格項目を記録。公開切替は行わない |

### 4-3 release bundle の内容（重要）

`repoRoot` が **release ディレクトリ**になるため、release は「リポジトリ root の鏡」でなければならない。漏れると無音で壊れる（HTML が無ければ配信が失敗し、bridge が無ければ UI の一部だけ動かない）。

| 必須 | 内容 | 欠落時の症状 |
|---|---|---|
| `apps/api/dist/**` | 98 JS（source map は含めない） | 起動失敗 |
| ルート HTML 1 本 | 配信 UI の正本 | `/` が失敗（500/空） |
| `apps/api/src/prototype/*.js` | 配信 bridge 11 本 | UI の一部機能だけ無音で欠落 |
| `scripts/skills/windows/*.ps1` | catalog 実体 20 本 | 起動時 catalog sync で approved→draft 化 |
| `scripts/skills/approved.json` | 空 `{version:1,skills:[]}` または合成 | 実承認者の PII 混入、または承認状態の取り違え |
| `package.json` / `apps/api/package.json` / `package-lock.json` | 同一 commit の 3 点 | 依存解決の再現性喪失 |
| `node_modules/` | prod-only 導入（`npm ci --omit=dev --ignore-scripts`） | 起動失敗 |
| `release.env` / `release.json` | `COMMIT_SHA`、集約 digest | artifact 同一性の証明不能 |

**起動時の副作用に注意:** `buildServer` は起動時にカタログ同期（DB upsert）を行い、manifest と PS が一致しなければ approved→draft、承認者/日時が null になり得る（[72](72-runtime-dependencies-and-git-boundary.md) §3-A）。release に空 manifest を同梱すると staging DB は全 Skill draft になる。これは**安全側**であり、staging では許容する。実承認の再現が必要になったら、合成承認者だけを持つ staging 用 manifest を別途用意する（本番 manifest を copy しない）。

### 4-4 切替と rollback の単位

| 層 | 切替 | rollback |
|---|---|---|
| アプリ（dist/HTML/bridge/skill） | `current` symlink の原子的差し替え + staging restart | `previous` symlink へ戻す + staging restart（秒単位） |
| 設定（api.conf） | release に含めない。変更は別操作として記録 | 変更前の値へ戻す（値は証跡に残さない） |
| DB schema | migration を前進適用 | **原則戻さない。** 旧アプリが新 schema で動くことを T5 で確認する。復元は新規 DB 名への訓練のみ |
| tunnel / DNS / Access | 承認後に別手順（§6） | §6-3。ローカル release の rollback とは独立 |

### 4-5 DB rollback を通常手順にしない理由

- migration は前進のみで、down migration を持たない（`db/migrations` は追加型）。
- 本番相当では「復元で rollback」が事故のもとになる（[70](70-cto-staging-production-readiness.md) 項目 13 の制約）。
- したがって staging でも、**DB を含む rollback は「新規 DB 名への復元訓練」として別承認・別証跡**にする。通常の rollback は symlink + restart だけで完結させる。

### 4-6 配備スクリプトの契約（Batch2 実装）

CLI 案: `scripts/deploy-staging.sh <subcommand>`

| subcommand | 役割 |
|---|---|
| `preflight` | 本番不変量の取得、資源/port/名前の照合、ロック取得 |
| `build <sha>` | detached worktree + `npm ci` + tsc + 出力集合の照合 |
| `release` | bundle 組み立て、`release.json`、不変化 |
| `migrate` | DB 同一性 4 点の照合 → 事前 dump → migration → 本数照合（再実行 0） |
| `switch` | symlink 差し替え + staging restart + health 待ち |
| `smoke` | §7 のローカル項目 |
| `rollback` | `previous` へ戻す + restart + health |
| `evidence` | 不変量の再取得と差分 0 の確認、証跡保存 |

fail-closed 条件（1 つでも該当したら停止し、対象を表示しない）:

1. 実行 cwd / 対象 path が本番 checkout（`/home/kensan/Projects/Mirai-Admin-Platform/AI-HelpDesk-Platform`）またはその配下。
2. 操作対象の unit 名に `-stg-` が無い、または `ai-helpdesk-{api,proxy,cloudflared,backup}` に一致する。
3. `DATABASE_URL` の host≠`127.0.0.1`、port≠`5440`、dbname≠`ai_helpdesk_stg`。
4. `PORT`/`SIDECAR_PORT` が 18949/18950、または 18952/18951 以外。
5. `current` の `realpath` が `releases/` の外、または `previous` が存在しない状態での `switch`。
6. 空きディスク 50G 未満、PG の `staging.marker` 不一致。
7. 別の配備がロック中（`shared/locks/deploy.lock`、`flock -n`）。
8. `git merge-base --is-ancestor <sha> origin/main` が偽（未マージの commit を配備しない）。

## 5. 本番への影響ゼロの証明方法

### 5-1 不変量（前後で完全一致を要求する）

| # | 不変量 | 取得（read-only） | 合格条件 |
|---|---|---|---|
| P-1 | 本番 3 unit の実行同一性 | `systemctl --user show ai-helpdesk-api ai-helpdesk-proxy ai-helpdesk-cloudflared -p ActiveState,SubState,ExecMainPID,NRestarts,ActiveEnterTimestamp,InvocationID` | **全項目一致**（再起動が無いことの最強の signal） |
| P-2 | 本番 health | `curl -sS -m5 http://127.0.0.1:18949/api/health` | `ok/commit/env/db` が一致（`time` の差のみ許容） |
| P-3 | tunnel ingress 設定 | `sha256sum ~/.cloudflared/ai-helpdesk-config.yml` | 一致（§1 の基準値） |
| P-4 | 本番 unit 定義 | 4 ファイルの `sha256sum` | 一致（§1 の基準値） |
| P-5 | 本番 env の bytes | `sha256sum` + `stat -c '%a %U %s %Y'`（**内容は表示しない**） | 一致 |
| P-6 | 本番 artifact | dist 内 `.js` の sorted sha256 の sha256 | 一致（§1 の基準値） |
| P-7 | 待受の帰属 | `ss -ltnp` の 18949/18950 の PID、`5435` の cgroup | PID 集合と cgroup が一致 |
| P-8 | 本番 DB プロセス | `docker inspect -f '{{.State.StartedAt}}' deepseek-harness-postgres` | 一致（コンテナ再起動なし） |
| P-9 | タイマー | `systemctl --user list-timers ai-helpdesk-backup.timer ai-helpdesk-tunnel-watch.timer` の NEXT/LAST | 変更なし（staging は別 timer） |
| P-10 | staging の追加待受 | `ss -ltn` で 18951/18952/5440 のみ増加 | 他の port が増えていない |

取得手順は「staging 作業の直前」と「直後」の 2 回、同じコマンド列で行い、`shared/evidence/invariants-before.json` / `-after.json` に保存して差分を機械比較する。

### 5-2 構造的ガード（実行しないことの証明）

- §4-6 の 8 条件で、本番 path・本番 unit・本番 port・本番 DB 名を**引数として受け取っても停止**する。
- 本番 unit の `FragmentPath` を読み、`start/stop/restart/daemon-reload` の対象が `-stg-` を含む unit だけであることを実行前に検査する。
- `systemctl --user daemon-reload` は新 unit の登録に必要だが、**既存 unit は再起動しない**。この操作の前後でも P-1 を取得し、`ActiveEnterTimestamp` が不変であることを示す（daemon-reload 自体を「影響ゼロ」の例外にしない）。
- 本番 DB には**接続しない**（本番 DSN を読まない）。したがって P-8 は「コンテナが再起動していない」ことだけを示し、DB 行の不変は示さない（§5-3）。

### 5-3 この証明が示さないもの（過大主張の禁止）

1. **共有ホスト資源の分離。** CPU・メモリ・ディスク・inode・カーネル・同一 `systemctl --user` manager は本番と共有。staging の暴走は本番の性能に影響し得る。P-1〜P-10 は「本番側の設定・プロセス・待受が変わっていない」ことを示すだけで、干渉が無かったことを示さない。
2. **本番 DB 行の SQL レベル不変。** 本番 DSN を読まない設計なので、行・schema の checksum 比較は行わない。必要なら別承認で read-only の checksum を取る。
3. **Cloudflare アカウント全体の不変。** ローカル config の digest（P-3）はアカウント側の Access/DNS 設定の不変を示さない。§6 の変更時は、変更前後に対象レコード/Access app を read-only で列挙し、**本番 hostname のレコードと app が不変**であることを別途記録する。
4. **env の意味的不変。** P-5 は bytes の一致のみ。稼働プロセスが読んだ値の同一性は、再起動が無い（P-1）ことで補強するが、証明ではない。
5. **health の commit の出自。** 自己申告である。artifact 同一性は `release.json` の集約 digest と配信 bytes の照合（S-02）で別に示す。
6. **「一度も触っていない」ことの網羅性。** ガードは既知の経路を塞ぐが、シェル履歴や人手の操作までは証明しない。実行ログ（`shared/logs/`）と §6-4 の承認記録で補う。

## 6. tunnel / DNS / Access と承認境界

### 6-1 2 案の比較

| 案 | 変更内容 | 本番への影響 | 判定 |
|---|---|---|---|
| **A: 既存 tunnel に ingress 追加** | `~/.cloudflared/ai-helpdesk-config.yml` に `ai-helpdesk-stg` の ingress を追加し、`ai-helpdesk-cloudflared` を restart | **あり。** cloudflared は config を hot reload しないため restart が必要で、その間（数秒）本番 hostname が 502 になり得る。設定誤りは本番 ingress を壊す | 原則不可。承認 + 保守ウィンドウ時のみ |
| **B: 新規 tunnel（推奨）** | `cloudflared tunnel create ai-helpdesk-stg` → 専用 config `~/.cloudflared/ai-helpdesk-stg-config.yml` + 専用 unit。DNS は staging hostname のみ | **本番 tunnel のファイル・unit・接続に触れない。** DNS レコード追加のみアカウント変更 | Batch2 T7（承認後） |

### 6-2 推奨手順（B、設計案・未実行）

```bash
# 0) 事前確認（read-only）
cloudflared tunnel list                       # 同名が無いこと
dig +short ai-helpdesk-stg.mirai-dx-platform.com   # 既存レコードが無いこと
sha256sum ~/.cloudflared/ai-helpdesk-config.yml    # 本番 config の基準値（P-3）

# 1) tunnel 作成（新規資格情報が増えるだけ。本番 tunnel は不変）
cloudflared tunnel create ai-helpdesk-stg
# → ~/.cloudflared/<新UUID>.json（0600）

# 2) 専用 config（本番ファイルを編集しない）
cat > ~/.cloudflared/ai-helpdesk-stg-config.yml <<'YAML'
tunnel: <新UUID>
credentials-file: /home/kensan/.cloudflared/<新UUID>.json
ingress:
  - hostname: ai-helpdesk-stg.mirai-dx-platform.com
    service: http://127.0.0.1:18951
  - service: http_status:404
YAML
chmod 600 ~/.cloudflared/ai-helpdesk-stg-config.yml
cloudflared tunnel ingress validate --config ~/.cloudflared/ai-helpdesk-stg-config.yml

# 3) DNS（**承認対象**。staging hostname のみ。本番レコードを上書きしない）
cloudflared tunnel route dns ai-helpdesk-stg ai-helpdesk-stg.mirai-dx-platform.com

# 4) unit 起動（staging のみ）
systemctl --user daemon-reload
systemctl --user enable --now ai-helpdesk-stg-cloudflared.service
```

禁止事項（手順に埋め込む）:

- `--overwrite-dns` を使わない。既存レコードがある場合は**停止して人間に返す**。
- 本番 config（`ai-helpdesk-config.yml`）を編集しない・rename しない・`--config` の指定を切り替えない。
- `systemctl --user restart ai-helpdesk-cloudflared` を実行しない（本番 tunnel の再起動）。

### 6-3 ロールバック

| 対象 | 手順 | 本番影響 |
|---|---|---|
| staging tunnel 停止 | `systemctl --user disable --now ai-helpdesk-stg-cloudflared.service` | なし（staging のみ停止） |
| staging DNS 削除 | Cloudflare API/Dashboard で対象 CNAME を削除（**承認操作**） | なし（staging hostname のみ）。ただし削除は不可逆ではなく再作成可能 |
| tunnel 削除 | 停止後に `cloudflared tunnel cleanup ai-helpdesk-stg` → `cloudflared tunnel delete ai-helpdesk-stg` | なし。資格情報ファイルは別途削除 |
| Access app | app を無効化/削除（承認操作） | なし。AUD を消すと staging の JWT 検証が失敗し 401 になる（意図どおり fail-closed） |
| 誤って本番 ingress を変更した場合 | 直ちに `ai-helpdesk-config.yml` を §1 の digest に戻し、`cloudflared tunnel ingress validate` → 本番 unit を restart（**インシデント扱い・承認不要の復旧**）。P-1/P-3 を再取得 | あり。復旧までの間、本番が 502 |

### 6-4 承認が必要な操作の切り分け

| 操作 | 対象 | 本番影響 | 承認 |
|---|---|---|---|
| `$HOME/apps/ai-helpdesk-stg/` の作成、build worktree、`npm ci`、tsc | ローカル | なし（ディスク/CPU のみ） | 不要 |
| release 生成・`chmod -R a-w`・prune | ローカル | なし | 不要 |
| staging 用 PG16 クラスタ作成（5440）・role・migration | ローカル | なし（資源消費のみ） | 不要 |
| staging env ファイル・allowlist 作成 | ローカル | なし | 不要 |
| staging unit（db/api/proxy）の作成・`daemon-reload`・`enable/start/restart` | ローカル | なし（P-1 で不変を確認） | 不要 |
| ローカル smoke（127.0.0.1:18951/18952） | ローカル | なし | 不要 |
| **`cloudflared tunnel create`**（アカウントに資格情報追加） | Cloudflare | なし（additive） | **要**（アカウント変更） |
| **`cloudflared tunnel route dns`**（DNS レコード作成） | DNS | なし（ただし誤操作は本番レコードを壊し得る） | **要** |
| **Access アプリ作成 / AUD 発行 / ポリシー変更** | Cloudflare Access | なし（staging 専用 app） | **要** |
| **既存 tunnel の ingress 編集 / 本番 cloudflared restart** | 本番 | **あり** | **要（原則不可。保守ウィンドウ + 復旧手順の事前合意）** |
| 本番 unit / 本番 env / 本番 DB への変更 | 本番 | **あり** | **禁止**（本書の対象外） |
| 本番 DSN の read（DB checksum 等） | 本番 | なし（read-only）だが秘密の取扱い | **要**（§5-3-2） |

承認の記録は「誰が・いつ・何を・どの digest に対して」を `shared/evidence/approvals.jsonl` に残し、実行ログと対応づける。

## 7. smoke 項目

`--base-url http://127.0.0.1:18951`（proxy 経由）を基本にする。公開系（S-03 の外部側）は T7 以降。

| ID | 検査 | 方法 | 合格条件 | 証明しないこと |
|---|---|---|---|---|
| S-01 | health | `GET /api/health` | `ok:true` / `db:"ok"` / `env:"production"` / `commit==<release sha>` | artifact の出自（自己申告） |
| S-02 | artifact 束縛 | (a) `release.json` の集約 digest が release 実体と一致、(b) 配信 `/` に release 内の bridge 11 本の実 bytes がすべて含まれる、(c) 同一 release の `/` の SHA-256 が再取得でも一致、(d) 稼働プロセスの dist 実 path が `current` 配下 | すべて一致 | 描画結果の正しさ。**配信 HTML は source そのままではなく patch 適用後**（`prototype.ts`）なので、配信 bytes と release 内 HTML の直接一致は要求しない |
| S-03 | 未認証境界 | `GET /api/me`（ローカル）/ 公開 URL 未ログイン | ローカル 401、公開は 302 → Access | 認証後の UI 受入 |
| S-04 | 偽ヘッダ | `Cf-Access-Authenticated-User-Email` を付けて `GET /api/me` | 401（JWT 無しで通らない） | 正規 JWT の検証網羅 |
| S-05 | DB 同一性 | `SELECT current_database()`、`SHOW port`、接続 host | `ai_helpdesk_stg` / `5440` / `127.0.0.1` | 本番 DB を触っていないこと（別手段 §5） |
| S-06 | migration | 適用本数、2 回目実行 | release の migration 集合と一致、再実行 0 | schema の意味的正しさ |
| S-07 | 主要フロー | state の PUT→GET、case 作成→参照、KB 一覧、Skill catalog が全 draft | 200 と値の一致、draft 件数が想定どおり | 実業務の全 workflow |
| S-08 | 閉鎖機能 | R2/R3 の入口、無効 helper の register | 404 と固定文言 | 将来の有効化時の安全性 |
| S-09 | 環境越境の否定 | staging env の `MIRAI_INFO_DATABASE_URL` が staging DB、`MAIL_TRANSPORT=disabled`、通知 0 件 | 条件一致 | PII の非存在（読取網羅ではない） |
| S-10 | rollback 訓練 | `previous` へ戻して restart → health が旧 sha | 旧 release で health 正常、再度前進できる | DB の巻き戻し |
| S-11 | ログの秘密 | staging ログに対し合成 secret の substring 検査 | 一致 0 | 全秘密検出の網羅性 |
| S-12 | 資源ゲート | 空きディスク、staging プロセスの RSS | 空き ≥50G、想定内 | 本番性能への非干渉 |

補助: `scripts/ops-readiness.mjs --base-url http://127.0.0.1:18951 --expected-commit <sha>` を S-01/S-03/S-04 の一部として再利用する（正/誤 SHA の対照を含む）。

## 8. 段階的ロールアウト（Batch2）

| 段階 | 内容 | 依存 | 承認 | 完了条件 |
|---|---|---|---|---|
| T0 | §10 の決定（DB 案・tunnel 案・Access 方針・manifest 方針・キー方針） | — | 人間 | 数字で回答済み |
| T1 | release bundle builder（[70](70-cto-staging-production-readiness.md) 項目 11）: 必須 asset 集合、`release.json`、不変化、lint/test | T0 | 不要 | 空 outdir への 2 回 build 一致、asset 欠落の負対照 |
| T2 | staging DB（専用クラスタ 5440、role 2 つ、migration、マーカー、dump） | T0 | 不要 | migration 全本適用（11/5 時点で 37 本）・再実行 0、ガード 4 点の負対照 |
| T3 | staging env + unit（db/api/proxy）、`release.env`、`current` 骨格 | T1, T2 | 不要 | ローカル 18952 で health 正常、本番不変量 P-1〜P-10 一致 |
| T4 | `scripts/deploy-staging.sh`（preflight/build/release/migrate/switch/smoke/rollback/evidence） | T1, T2, T3 | 不要 | 8 条件の fail-closed 負対照、1 回の実配備と rollback |
| T5 | ローカル E2E（S-01〜S-12）+ rollback 訓練 + 不変量証跡 | T4 | 不要 | 全項目合格、差分 0 の保存 |
| T6 | 独立 read-only レビュー（SRE/Security）と指摘修正 | T5 | 不要 | 新規未修正 Critical/High 0 |
| T7 | staging tunnel + DNS + Access app（公開） | T5, T6 | **要** | ingress validate、DNS 1 件のみ追加、本番不変量一致 |
| T8 | 公開 smoke（S-03 外部）+ 受入記録 + 運用引継ぎ | T7 | 不要 | 未認証 302、approved テスターのログイン確認 |

依存の要点:

- **T1 と T2 は並列可**（互いに独立）。T3 は両方に依存（env が DB を指すため）。
- **T7 を T5/T6 より前にしない。** 公開経路は rollback の実測が終わってから開く。
- T1 が未完了のまま T3 を進めない（bundle 漏れのまま unit を立てると「動いているように見える staging」ができる）。
- 本番 check アウトを使う作業は T0〜T8 のどこにも無い。T1 の build は detached worktree で行う。

## 9. リスクと未解決点

| # | リスク / 未解決 | 影響 | 現時点の扱い |
|---|---|---|---|
| R1 | **同一ホスト・同一 UID・同一 systemd user manager**。staging の暴走（メモリ・CPU・ディスク）は本番に届く。`daemon-reload` や unit 名の取り違えは本番に届く | 本番の性能/可用性 | 分離は論理のみ。ガード（§4-6）+ 資源ゲート + 監視で緩和。**根本解決は別ホスト**で、本書の範囲外 |
| R2 | **ディスク 85%**。release 5 世代 + PG クラスタ + dump で圧迫すると、本番 DB の書込み失敗に直結する | 本番の書込み | 空き 50G ゲート、release 5 世代、dump 7 日、prune を配備手順に含める。**実測で 50G を割ったら staging を止める**運用を事前合意 |
| R3 | DB を案 A（既存 5435 内の別 DB）にすると、superuser が全 DB を読める。harness と故障域・バックアップ対象を共有 | 分離の弱さ | 推奨は案 B。案 A は承認時のみ・期限付き |
| R4 | **実名簿 fallback**。`MIRAI_INFO_DATABASE_URL` 未設定だと `/var/run/postgresql` の `mirai_info` を読み得る（`apps/api/src/lib/mirai-info.ts`） | 実 PII が staging に流入 | staging env で必須設定 + S-09 で照合。コード側の fail-closed 化は別タスク（未解決） |
| R5 | **起動時カタログ同期の副作用**（approved→draft、承認者 null 化） | 承認状態の破壊 | staging DB を本番と分離し、空/合成 manifest を使う。本番 manifest を copy しない |
| R6 | **release への PII 混入**。`scripts/skills/approved.json` と `docs/MailAddress.txt` は Git 追跡で、実データを含み得る | 不変 release に PII が残る | release には空/合成 manifest を置き、allowlist は絶対 path で外部化。追跡ファイル自体の扱いは別途方針が必要（未解決） |
| R7 | **Access の実ログインは人間と OTP が要る** | 認証後 UI の受入が自動化できない | 合成 JWT harness（[74](74-portable-runtime-synthetic-acceptance.md)）でアプリ境界まで、実 Access は T8 で人間が確認 |
| R8 | **Cloudflare アカウント操作の誤り**（DNS 上書き、本番 ingress 編集） | 本番の公開断 | 案 B + `--overwrite-dns` 禁止 + 事前 `dig` + 承認記録。誤操作時は §6-3 の復旧 |
| R9 | **health の commit は自己申告** | 配備取り違えの見逃し | `release.env` 由来 + `release.json` の digest 照合（S-02）を併用 |
| R10 | **migration は前進のみ** | DB を含む rollback ができない | 通常 rollback はアプリ層のみ。DB は新規 DB 名への復元訓練として別承認 |
| R11 | **同一 git オブジェクト DB の共有**。build worktree は本番 repo の `.git` を共有する | 誤った branch 操作が本番作業ツリーに影響し得る | `git worktree add --detach <sha>` のみ使用、build 後に `worktree remove`。本番 checkout では `git` を実行しない |
| R12 | **本番相当 DB の encoding/collation 未確認**（Docker 管理外） | 照合順・索引挙動の差 | 案 B の initdb 前に read-only で `SHOW` を取り、揃える。揃わない場合は差分を記録して受入条件から外す |
| R13 | **Git/CI 境界が未解消**（[72](72-runtime-dependencies-and-git-boundary.md)） | 未マージ commit を release にできてしまう | §4-6-8 の `merge-base --is-ancestor` ガード。正規 commit/CI の確立は別タスク |
| R14 | `systemd --user` の linger 設定に依存 | ログアウトで staging が止まる（本番同様の制約） | 既存本番と同じ前提を維持。`loginctl show-user kensan -p Linger` を T3 で確認 |
| R15 | DeepSeek キー共有によるコスト/データ境界 | 費用・情報流出 | `DEEPSEEK_*` は staging 専用キーまたは無効化を T0 で決定 |

## 10. 人間の決定が必要な事項（数字選択）

1. **staging DB**: (1) 専用 PG16 クラスタ 5440（推奨・分離強） / (2) 既存 5435 内の別 DB（最小・分離弱）
2. **公開経路**: (1) 新規 tunnel（推奨・本番無影響） / (2) 既存 tunnel に ingress 追加（本番 restart 必要）
3. **staging の認証**: (1) 実 Access app（別 AUD）+ 承認テスター / (2) 合成 JWT harness のみで非公開
4. **承認 manifest**: (1) 空 manifest（全 Skill draft・安全側） / (2) 合成承認者の staging manifest
5. **`DEEPSEEK_*`**: (1) staging 専用キー / (2) staging では AI 機能を無効
6. **保持**: release 5 世代 / dump 7 日 / 最小空き 50G で良いか

## 11. 付録: 本書で使った read-only 実測コマンド

```bash
git log -1 --format='%H %ci %s'
systemctl --user show ai-helpdesk-api ai-helpdesk-proxy ai-helpdesk-cloudflared \
  -p Id,ActiveState,SubState,ExecMainPID,NRestarts,ActiveEnterTimestamp,InvocationID
curl -sS -m5 http://127.0.0.1:18949/api/health
ss -ltnp | grep -E ':(18949|18950|5435)\b'
ss -ltn  'sport = :18951'; ss -ltn 'sport = :18952'; ss -ltn 'sport = :5440'
pg_lsclusters; docker ps --format '{{.Names}}\t{{.Ports}}'
docker inspect -f '{{.State.StartedAt}}' deepseek-harness-postgres
sha256sum ~/.cloudflared/ai-helpdesk-config.yml
sha256sum ~/.config/systemd/user/ai-helpdesk-{api,proxy,cloudflared}.service
(cd apps/api/dist && find . -name '*.js' -print0 | sort -z | xargs -0 sha256sum | sha256sum)
df -h /home; free -g
```

本書の記述は「設計案」であり、上記以外のコマンドは実行していない。Batch2 の実装（T1〜T8）は別タスク・別承認で行う。

---

## 11. 実装追記（2026-11-06 / Batch2）

設計の一部は実装時に確定値へ置き換わった。**実装の正本は [78-staging-build-20261106](78-staging-build-20261106.md)** とし、本書との差分は次のとおり。

| 項目 | 本書（設計） | 実装 |
|---|---|---|
| root | `$HOME/apps/ai-helpdesk-stg` | `/home/kensan/ai-helpdesk-stg` |
| DB port | 5440 | 5437 |
| DB role | owner / app の 2 role | 単一 role `aihd_stg`（分離は残課題） |
| env | `~/.config/ai-helpdesk-stg/api.conf` | `~/.config/ai-helpdesk/stg-api.conf`（0600） |
| release 名 | `<UTC>-<sha7>` | `<JST timestamp>-<sha12>` |

実装済み: 専用 PG16 クラスタ、不変 release 生成、`current` symlink 切替、失敗時 rollback、`--migrate` / `--seed`、health の commit 照合。
未了（承認待ちを含む）: release.env の unit 取り込み、staging proxy 起動、公開 tunnel/DNS/Access、DB role 分離、staging backup、release の read-only 化。
