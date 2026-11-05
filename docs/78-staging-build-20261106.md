# 78. Staging 環境の実装記録（Batch2 / 2026-11-06 JST）

## 0. 結論

**独立 Staging の「ローカル実体」は構築できた。ただし service 定義の更新と公開経路は未了で、deploymentReady ではない。**

- 専用 PostgreSQL 16 クラスタを新規作成（`127.0.0.1:5437`、`PGDATA=/home/kensan/ai-helpdesk-stg/pgdata`、role `aihd_stg`、DB `ai_helpdesk_stg`）。
- 不変 release を 1 世代作成（`/home/kensan/ai-helpdesk-stg/releases/20261106T063553-359cbd012274`、commit `359cbd012274fd23ed3ee99a5a497236b4ac7711`）。
- migration 37 本を適用し、seed を投入（users=6 / knowledge=9 / cases=3）。
- Staging API は `127.0.0.1:18952` で稼働し、`/api/health` は 200・`db:"ok"`・`env:"production"`。
- **未了**: `COMMIT_SHA` の release 束縛（unit へ `EnvironmentFile=.../current/release.env` を追加する変更が承認待ち）、proxy の起動、公開 tunnel/DNS/Access、認証後 UI 受入。

## 1. 実装したもの（リポジトリ）

| ファイル | 役割 |
|---|---|
| `scripts/deploy-release.sh` | commit から不変 release を生成し、`current` symlink を原子的に切替、`systemctl --user restart`、`/api/health` の commit 一致確認、失敗時は直前 release へ自動 rollback。`--dry-run` / `--migrate` / `--seed` / `--keep`。 |
| `scripts/install-staging.sh` | 専用 PG16 クラスタ・DB・role・systemd user unit・設定ファイルの冪等初期化。tunnel/DNS/Access は作らない。 |
| `ops/systemd/ai-helpdesk-stg-postgres.service` | Staging 専用 PostgreSQL（5437、loopback）。 |
| `ops/systemd/ai-helpdesk-stg-api.service` | Staging API（18952、`current` symlink 経由）。 |
| `ops/systemd/ai-helpdesk-stg-proxy.service` | Staging proxy（18951 → 18952）。 |

### 1-1. 実装値（設計 docs/77 との差分）

| 項目 | docs/77 の設計 | 実装 | 理由 |
|---|---|---|---|
| root | `$HOME/apps/ai-helpdesk-stg` | `/home/kensan/ai-helpdesk-stg` | 実装開始時に選んだ path。機能差なし。 |
| DB port | 5440 | **5437** | 5437 も空きで、実装開始時に確保済み。5440 へ移す価値は現時点でない。 |
| DB role | owner/app の 2 role | **単一 role `aihd_stg`** | 実装簡素化。**role 分離は未実装の残課題**（§5）。 |
| env | `~/.config/ai-helpdesk-stg/api.conf` | `~/.config/ai-helpdesk/stg-api.conf` | 既存ディレクトリ（0700）内。ファイルは 0600。 |
| release 名 | `<UTC>-<sha7>` | `<JST timestamp>-<sha12>` | 一意性は確保。表記差のみ。 |
| COMMIT_SHA | release.env から供給 | release.env を生成済み。**unit がまだ読んでいない** | 承認後に unit を更新する。 |

設計の本質（専用クラスタ・別ポート・別 unit・不変 release・rollback・loopback 限定）は満たしている。

## 2. 実測結果

| 検査 | 結果 |
|---|---|
| PG クラスタ | `initdb` 成功、`127.0.0.1:5437`、`ai_helpdesk_stg` 作成、SCRAM |
| migration | 37 本適用（初回）、2 回目は全 skip（冪等） |
| seed | `users=6, knowledge=9, cases=3` |
| API health | `200` / `{"ok":true,"service":"ai-helpdesk-api","db":"ok","env":"production"}` |
| release manifest | `082e815b9cac9ac490fadc5792c2cc157b1a6e19a0a174a12597d4be8878481b` |
| 本番不変 | 確認済み（§3） |

### 2-1. 初回 deploy で見つかった不具合と修正

1. `[ "$RELEASE_DIR/.../run-with-env-file.mjs" -f ]` の引数順誤り → `[ -f ... ]` に修正。
2. `npm prune --omit=dev` 後に `npx tsx`（devDependency）で migration を実行していた → migration/seed を prune より前に移した。
3. health の `commit` が空で rollback した → `release.env` に `COMMIT_SHA` を書き出す実装を追加（unit 側の取り込みが残課題）。

これは「health の commit を見る」検証が実際に効いていることの証拠でもある（空 commit を成功扱いしなかった）。

## 3. 本番不変の確認（実行前後）

| 対象 | 実行前 | 実行後 |
|---|---|---|
| `ai-helpdesk-api` | PID 2379216 / NRestarts 0 / active 2026-11-04 10:04:02 | 同左 |
| `ai-helpdesk-proxy` | PID 863034 / NRestarts 0 / active 2026-10-31 18:30:51 | 同左 |
| `ai-helpdesk-cloudflared` | PID 2274303 / NRestarts 0 / active 2026-11-04 09:51:46 | 同左 |
| 本番 health | commit `a5e0a67…` / production / db ok | 同左 |
| `~/.cloudflared/ai-helpdesk-config.yml` | `d51927da44c6b778…` | 同左 |
| `~/.config/ai-helpdesk/api.conf` | `933c96c8435687d0…` | 同左（staging は別ファイル） |
| 本番 dist | 98 JS files | 同左 |

## 4. Staging 設定（秘密は記載しない）

- `NODE_ENV=production` / `AUTH_MODE=cloudflare-access` / `ACCESS_JWT_MODE=off`（公開前の暫定） / `REQUIRE_PROXY_SECRET=true`
- `DATABASE_URL` は staging クラスタのみ。`MIRAI_INFO_DATABASE_URL` も staging DB（実名簿への fallback を防ぐ）。
- `DEEPSEEK_BASE_URL=http://127.0.0.1:1`、`RSP_BASE_URL=http://127.0.0.1:1`、`MAIL_TRANSPORT=disabled`（外部サービスへ接続しない）。
- `COOKIE_SECURE=false` は loopback HTTP の暫定。公開時に `true` へ変更する。
- allowlist は `~/.config/ai-helpdesk/stg-access-allowlist.txt`（合成 1 件）。

## 5. 残課題（優先順）

| # | 課題 | 影響 | 必要な操作 |
|---|---|---|---|
| S-1 | unit に `EnvironmentFile=.../current/release.env` を追加し `daemon-reload` + restart | health の commit が空のまま＝release 束縛が未成立 | systemd 変更（承認待ち） |
| S-2 | staging proxy（18951）の起動 | proxy 経由 smoke が未実施 | systemd start（承認待ち） |
| S-3 | 公開 staging（tunnel + DNS + Access アプリ） | 認証後 UI・主要フローの受入が不可 | Cloudflare 追加（承認待ち） |
| S-4 | DB role 分離（owner/app） | 影響半径の縮小が未達 | 設計判断 |
| S-5 | staging backup（専用 dump / 7 日保持） | 復元訓練が未実施 | 実装 + 承認 |
| S-6 | release の `chmod -R a-w` による不変化 | 事後の書換防止が未実装 | 実装 |

## 6. 制約（必ず併記する）

- 同一ホスト・同一 UID・同一 systemd user manager のため、OS 主体としての分離はない。本番とリソース（CPU/メモリ/ディスク）を共有する。
- Staging の health 成功は、認証後 UI・実社員・貸与端末・別人物承認・復元の受入ではない。
- `ACCESS_JWT_MODE=off` の間は、loopback へ到達できるローカルプロセスが `Cf-Access-Authenticated-User-Email` を偽装し得る。公開経路を作る前に `enforce` へ切り替える。
- 本番の「配備」は依然として main checkout 直配備であり、本記録はその方式を置き換えていない。本番へ release 方式を適用するには別承認が必要。

## 7. 追記（2026-11-06 / 追加実測）

### 7-1. backup からの復元訓練（staging クラスタ内の使い捨て DB）

| 項目 | 結果 |
|---|---|
| 入力 dump | `~/backups/ai-helpdesk/ai_helpdesk_preview-20261106-023218.dump`（266,586B、custom format、35 TABLE DATA、pg_dump 16.15） |
| 復元先 | staging クラスタ（`127.0.0.1:5437`）内の `aihd_restore_drill_20261106`（本番 DB・本番クラスタには触れない） |
| 実行 | `pg_restore --no-owner --no-privileges --exit-on-error` |
| 結果 | **35/35 テーブル復元、全表の行数が本番と完全一致**、`schema_migrations` 37 行 |
| 後処理 | 同 DB を削除（接頭辞 `aihd_restore_drill_` を検証してから drop。PII の残留コピーを作らない） |
| 未検証 | 監査ハッシュ鎖の再計算、role/ACL/所有権の一致（`--no-owner` のため）、RTO 計測 |

### 7-2. Staging の機能実測（合成ユーザー）

| 経路 | 結果 |
|---|---|
| `GET /`（未認証） | 401 |
| `GET /`（`Cf-Access-Authenticated-User-Email: synthetic-staging@example.invalid` + proxy secret） | **200 / 893,003 bytes**（プロトタイプ HTML が release から配信されている） |
| `GET /api/me`（同ユーザー） | 200（`source: mirai-info.employee_directory`、`employee: null`） |
| DB | users=6 / knowledge=9 / cases=3（seed 済み） |

これは「release の HTML 同梱」「アプリの起動」「DB 接続」「認証ゲート」が同時に成立していることの実測である。実 Access ログイン・実社員・貸与端末・主要業務フローの受入ではない。

### 7-3. 未了のまま残るもの

上記 §5 の S-1〜S-6 は変わらない。特に **S-1（`release.env` の unit 取り込み）が未了のため、Staging の health は `commit` が空**である。release と稼働 artifact の対応は `dist-manifest.json`（`082e815b…8481b`）で別途示せるが、health による束縛は成立していない。

