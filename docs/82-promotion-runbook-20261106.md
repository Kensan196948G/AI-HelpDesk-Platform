# 82. 承認後に実行する手順 — Staging 公開 / 本番昇格（2026-11-06 / 改訂 v3）

## 0. この文書の位置づけ

**未実行の手順書である。** 本稿の作成時点（2026-11-06 08:43〜08:55 JST、v3 改訂）で、A/B/C のいずれも本稿の手順としては実行していない。§6 の実行記録は**空のまま**残す。実行したのは read-only の実測（ファイル読取・`ss`・`git`・`stat`・staging の health GET）だけである。

本稿は独立レビュー v1（`pr142-review.md`、NO-GO）の指摘を解消した v2 を、再レビュー2（`pr142-rereview2.md`、**GO-WITH-LIMITS**）の High 4 件に対応させた **v3** である。v2 の改訂の中心は次の 3 点。

1. **区分 C を「実行できる配備」に直した。** `--dry-run` は `current` も unit も作らない。実配備は `scripts/deploy-release.sh` を **`--dry-run` なしで**実行し、`current` の生成・unit の restart・health の commit 一致までを 1 本の流れにした（§4）。
2. **受入条件を「観測できる信号」に直した。** すべての受入にコマンドと期待値（status / JSON の値 / 件数）を付けた。設定ファイルの目視や自己申告値を合格条件にしない（§2-3 / §3-4 / §4-9）。
3. **rollback を「`current` symlink + restart」に統一した。** 旧 unit を起動するだけの rollback は、次回 deploy の `PREVIOUS` 基準を壊す（§4-10）。bootstrap（初回で previous が無い）だけは `current` を削除して旧 unit に戻す。

対象は 3 つ。**A と B は独立**で、A だけでも価値がある。C は本番の停止を伴う。

| 区分 | 内容 | 本番への影響 | 不可逆性 | 承認 |
|---|---|---|---|---|
| A | Staging の release 更新・unit 定義の再適用・proxy 起動 | なし | なし | 不要 |
| B | 公開 Staging（新規 tunnel / DNS / Access アプリ） | なし（既存 tunnel・既存 Access アプリを変更しない） | なし（削除で戻せる） | **要**（Cloudflare アカウント変更 + B-5 の本番 DB read-only 接続） |
| C | 本番を release 方式へ切替 + 新 main 配備 | **あり。初回は最終切替で数秒、再配備は build 中も稼働** | 中（unit の enable/mask・symlink の状態が変わる。DB schema は変えない） | **要** |

**v3（本改訂）で解消した High（再レビュー2）**:

- **High-1**: A-3 の `STG_REF` を固定 `65caaa2` から実行時の `origin/main` 取得へ変更。`#144` 以降であることを検査し、既に同じ ref なら deploy を省略する（ダウングレードと `DIST_MANIFEST_MODE_INVALID` の回避）。
- **High-2**: C-3 を **18949 proxy 経由**（または `X-Proxy-Secret` 付き）に変更。18950 直叩きの `401 PROXY_REQUIRED` を合格不能のまま残さない。
- **High-3**: §4-4 を main の `ops/systemd/ai-helpdesk-prod-api.service`（#146 `e35f4cb`）に一致させ、`--unit-template` を使う形へ変更。**テンプレートを正本**とする。
- **High-4**: `deploy-release.sh` の restart 失敗時 rollback（#146）に合わせ、判定表へ `restart-failed` / `rollback-failed` を追加。
- Medium/Low: §1 の現行値、argv への秘密露出、C-6 の比較方法、`mask` の限界、行番号参照、`prev_hash_mismatch` の表現、#146/#147、R-C1 の unit 残置を反映（§8-3）。

### 0-1. 読み方の約束

- コマンドはすべて**この環境で実際に使える形**で書く。`systemctl --user` は本セッションで実行可能であることを実測済み（Lead が 08:07 に daemon-reload / restart を実行）。ただし本稿の作成者は実行していない。
- **自己申告値を合格にしない。** health の `commit` だけでなく、`current` の実体・プロセスの cwd・`release.env` の `COMMIT_SHA` を突き合わせる（§4-7）。
- 実メールアドレス・Secret・パスワードは**書かない**。必要な値は `read -rsp` で対話取得し、標準出力・証跡・履歴・**argv（`ps` で見える）**に残さない。curl へは `--config` の 0600 ファイルで渡す（§2-3 A-4 / §3-3 B-3 / §4-9 C-3）。
- 不可逆・本番影響のある操作には、その場に「影響 / rollback / 承認」を書く。

### 0-2. この環境固有の注意（実測）

| 項目 | 実測 | 意味 |
|---|---|---|
| `HTTP_PROXY` / `HTTPS_PROXY` | 設定あり（値は非表示） | `NO_PROXY` が空のため、`curl http://127.0.0.1:...` が proxy に向かう。**deploy-release.sh の health 判定が誤る**ので、配備コマンドには `NO_PROXY=127.0.0.1,localhost` を必ず付ける（§4-6）。ローカル確認の `curl` には `--noproxy '*'` を付ける。 |
| OS ユーザー | `kensan`（本番・Staging 同一 UID） | OS 主体の分離はない。`systemctl --user` の操作ミスが本番に届く。 |
| ブランチ保護 | required check `verify`（`enforce_admins=true`、必須レビューなし） | 変更は PR 経由。本番操作はこの runbook の承認で行う。 |

## 1. 前提（現状の実測値と測定時刻）

「現状」を名乗るため、各行に**測定時刻**と**再取得コマンド**を付ける。値は測定時点のものであり、実行時には §1-2 で取り直す。

### 1-1. 実測値（2026-11-06 08:43〜08:55 JST。v2 の 08:17〜08:27 値を現行へ更新）

| # | 項目 | 値 | 測定時刻 | 根拠 / 再取得 |
|---|---|---|---|---|
| 1 | 文書の状態 | **未実行**（A/B/C とも） | 08:43 | 本稿 §6 |
| 2 | `origin/main` | `4465f8d`（#147。`e35f4cb` #146 / `46261ea` #144 / `711320b` #145 / `65caaa2` #143 を含む） | 08:43 | `git fetch origin && git log -1 --format=%H origin/main` |
| 3 | PR #142 の base / v2 head | `e7d7f6f9dc945bff48419b020bab40696fe05e3f` / `542f95f`（v2。再レビュー2 の対象） | 08:43 | `git log -1 --format='%H %P' 542f95f` |
| 4 | 本番稼働 commit（health） | `a5e0a6719699d4711fc1811bbdb79c74d9aab393` | 08:07（Lead 実測。docs/81 §6-1 は 07:05） | `curl -sS --noproxy '*' http://127.0.0.1:18950/api/health` |
| 5 | 本番 api unit | `ai-helpdesk-api` / `WorkingDirectory=/home/kensan/Projects/Mirai-Admin-Platform/AI-HelpDesk-Platform` / `ExecStart=<node> apps/api/dist/index.js` / `EnvironmentFile=%h/.config/ai-helpdesk/api.conf` のみ / drop-in `Restart=always` | 08:19 | `cat ~/.config/systemd/user/ai-helpdesk-api.service`（秘密なし） |
| 6 | 本番 proxy unit | `ai-helpdesk-proxy` / `SIDECAR_PORT=18949` / `API_PORT=18950` / **`Wants=ai-helpdesk-api.service`** | 08:19 | `cat ops/systemd/ai-helpdesk-proxy.service`（deployed と同型） |
| 7 | 本番待受 | `127.0.0.1:18950`（API）・`127.0.0.1:18949`（proxy） | 08:21 | `ss -ltn \| grep -E ':(18949\|18950\|18951\|18952\|5435\|5437)\b'` |
| 8 | 本番 release root | `/home/kensan/ai-helpdesk-prod/` に `releases/20261106T071603-e7d7f6f9dc94`（dry-run）と `state/deploy-*.json`（`result:"dry-run"`）だけ。**`current` は ABSENT** | 08:19 | `ls -la /home/kensan/ai-helpdesk-prod/; test -e /home/kensan/ai-helpdesk-prod/current \|\| echo ABSENT; cat .../state/deploy-*.json` |
| 9 | 本番用 unit | `~/.config/systemd/user/ai-helpdesk-prod-api.service` は **ABSENT** | 08:19 | `test -e ... \|\| echo ABSENT` |
| 10 | 本番 DB backup | `~/backups/ai-helpdesk/ai_helpdesk_preview-20261106-023218.dump`（266,586 B） | 07:12（docs/81 §10） | `ls -l ~/backups/ai-helpdesk/` |
| 11 | Staging API | `127.0.0.1:18952` 稼働・health `commit:"4465f8d8905c4f651df1e5f3f607d7b939b40280"` | 08:44（本稿で GET） | `curl -sS --noproxy '*' http://127.0.0.1:18952/api/health` |
| 12 | Staging proxy | `127.0.0.1:18951` は **listening / health 200**（PR #143 修正 + release 更新で解消） | 08:44 | `ss -ltn \| grep :18951`、`curl -sS --noproxy '*' http://127.0.0.1:18951/api/health` |
| 13 | Staging release | `/home/kensan/ai-helpdesk-stg/releases/20261106T083747-4465f8d8905c` | 08:37（Lead 実測。re-review2 §1） | `readlink -f /home/kensan/ai-helpdesk-stg/current` |
| 14 | Staging DB | `127.0.0.1:5437` / `ai_helpdesk_stg`（docs/77 の設計値 **5440 とは異なる**） | 08:21（待受）/ 07:05（docs/81 §5） | `ss -ltn`、`psql`（§3-4 B-5） |
| 15 | Staging api unit | 758 bytes / mtime 08:07:20 / `EnvironmentFile=.../current/release.env` を含む | 08:19 | `stat -c '%y %s' ~/.config/systemd/user/ai-helpdesk-stg-api.service` |
| 16 | node | `/home/kensan/.nvm/versions/node/v22.22.3/bin/node` | 08:19（unit / テンプレート記載） | `grep -h '^ExecStart' ops/systemd/*.service`、`cat ~/.config/systemd/user/ai-helpdesk-api.service` |
| 17 | 本番 tunnel | `96d0214e-8236-4bce-8dd0-75233d1e716f` / `~/.cloudflared/ai-helpdesk-config.yml` / ingress 1 本 → 18949 | 06:2x（docs/77 §1 の実測） | `cloudflared tunnel list`（config は read-only。値は秘密ではない） |
| 18 | Staging proxy 不具合の修正 | symlink 経由で `main()` が走らない不具合は PR #143（`65caaa2`）で修正済み。Staging は `4465f8d` へ更新され、**18951 は 200** | 08:44 | `git log -1 origin/main`、staging health |

### 1-2. 実行直前に取り直すコマンド（read-only）

```bash
set -u
MAIN=/home/kensan/Projects/Mirai-Admin-Platform/AI-HelpDesk-Platform
STG_ROOT=/home/kensan/ai-helpdesk-stg
PROD_ROOT=/home/kensan/ai-helpdesk-prod
date -Iseconds
git -C "$MAIN" fetch origin
git -C "$MAIN" log -1 --format='%H %ci %s' origin/main
curl -sS --noproxy '*' http://127.0.0.1:18950/api/health
curl -sS --noproxy '*' http://127.0.0.1:18952/api/health
ss -ltn | grep -E ':(18949|18950|18951|18952|5435|5437)\b'
readlink -f "$STG_ROOT/current" 2>/dev/null || echo 'stg current ABSENT'
{ [ -e "$PROD_ROOT/current" ] || [ -L "$PROD_ROOT/current" ]; } && echo 'prod current EXISTS' || echo 'prod current ABSENT'
test -e "$HOME/.config/systemd/user/ai-helpdesk-prod-api.service" && echo 'prod unit EXISTS' || echo 'prod unit ABSENT'
systemctl --user show ai-helpdesk-api ai-helpdesk-proxy ai-helpdesk-cloudflared \
  -p Id,ActiveState,SubState,MainPID,NRestarts,ActiveEnterTimestamp,InvocationID
```

### 1-3. 関連 PR（実行時の前提）

| PR | 内容 | 本 runbook への影響 |
|---|---|---|
| #143（`65caaa2`） | symlink 経由で `main()` が走らない不具合の修正 | A-3 の前提（既に main）。 |
| #145（`711320b`） | staging の backup / restore-drill / healthcheck timer を追加 | A/B/C の必須前提ではない。staging の運用 timer として確認。 |
| #144（`46261ea`） | `dist-manifest` の mode 判定が 0400（read-only release）対応。build が dist を掃除する | **A/C の build の必須前提**。`STG_REF` / `DEPLOY_REF` が #144 以降であることを §2-2 / §4-1 で検査する。 |
| #146（`e35f4cb`） | 本番 unit テンプレート `ops/systemd/ai-helpdesk-prod-api.service` と `deploy-release.sh --unit-template`、restart 失敗時の rollback を追加 | **§4-4 の正本**。`--unit-template` で unit を配置する。`restart-failed` を §4-10 に反映。 |
| #147（`4465f8d`） | CTO バッチ1 の実測・検証記録 | 本 runbook の前提値（origin/main）に含まれる。 |

### 1-4. 設計（docs/77 §4-6）と実装の乖離 — 本 runbook はどちらに従うか（H-5）

`docs/77` §4-6 の fail-closed 契約と `scripts/deploy-release.sh` の実装は一致していない。**本 runbook は「実装」に従い、設計の意図を手動の preflight で代替する**（理由: 原子切替・health 束縛・自動 rollback が実装済みで、設計側の `deploy-staging.sh` は未実装。C はこの実装を本番に使う）。

| docs/77 §4-6 の停止条件 | 実装の状態（`deploy-release.sh`） | C での扱い |
|---|---|---|
| 1. 実行 cwd / path が本番 checkout または配下 → 停止 | 未実装（`case "$ROOT"` の禁止ディレクトリ検査のみ） | **例外**。`--repo` は本番 checkout。代わりに §4-1 の手動 preflight で `--root` を固定し、ref が `origin/main` の祖先であることを確認する。 |
| 2. unit 名に `-stg-` が無い / 既存本番 unit 名 → 停止 | 未実装（unit 名は文字種のみ検査） | **例外**。`ai-helpdesk-prod-api` は `-stg-` を含まない。代わりに既存 4 unit 名（`ai-helpdesk-api` / `-proxy` / `-cloudflared` / `-backup`）と**一致しないこと**を手動で確認する。 |
| 3. DB が `127.0.0.1:5440` / `ai_helpdesk_stg` 以外 → 停止 | 実装は `--migrate` / `--seed` を渡した時だけ DB へ接続 | C は `--migrate` / `--seed` を**渡さない**（DB schema を変えない）。DB を読むのは §4-9 C-4 の read-only 監査だけ。 |
| 4. `PORT`/`SIDECAR_PORT` が 18949/18950 → 停止 | 未実装（health port は数値形式のみ検査） | **例外**。本番 API の 18950 を使う。初回は §4-6 の一時 precheck port 18953 で health を通してから 18950 へ切り替える。 |
| 5. `current` の realpath が `releases/` の外 / `previous` 無しでの `switch` → 停止 | 未実装（`readlink -f current` を `PREVIOUS` に使うだけ） | 初回（bootstrap）は previous 無しでの switch を**意図的に**行う。§4-1 で `current` の有無と unit の有無の矛盾を検査し、切替前の `current` を `rollback-target.txt` に保存する（§4-6）。 |
| 6. 空きディスク 50G 未満 / PG の `staging.marker` 不一致 → 停止 | 未実装（ディスク検査なし）。marker は DB 操作時のみ関係 | 空きは §4-1 の `df` で手動確認。C は DB に接続しない（`--migrate`/`--seed` なし）ため marker は対象外。 |
| 7. 別の配備がロック中 → 停止 | 実装済み（`$ROOT/.deploy.lock` + `flock -n`） | そのまま使う。 |
| 8. `git merge-base --is-ancestor <sha> origin/main` が偽 → 停止 | 未実装 | 手動 preflight で確認する（§4-1）。 |

**未解消:** 上記 1/2/4/8 のガードは実装されていない。**別 PR で `deploy-release.sh` にガードを追加するまで、H-5 は「文書化 + 手動代替」に留まる**（§8）。また、docs/77 §3-5 の staging DB は設計 `5440` / `$HOME/apps/...`、実装は `5437` / `/home/kensan/ai-helpdesk-stg` である（docs/81 §1-2）。本稿は**実測値**に従う。

## 2. A: Staging の service 定義更新と proxy 起動（本番影響なし）

### 2-1. 目的と現状

- Staging は **`4465f8d`**（release `20261106T083747-4465f8d8905c`）で稼働中。health の `commit` は `4465f8d…`、proxy（18951）も **200**（PR #143 修正 + release 更新で解消済み）。
- したがって A の主目的は「現行 main への更新」ではなく、**unit 定義のテンプレート一致確認・`enable`・proxy の永続化・受入の再確認**である。A-3 は「`current` の commit が `origin/main` と違う場合だけ配備」とし、同じなら build しない（無駄な release とダウングレードを避ける）。
- deployed unit は `scripts/install-staging.sh` が `ops/systemd/*.service` を `sed` 展開した**生成物**である。手編集ではなく、テンプレートの再レンダリングで更新する（M-2）。

### 2-2. 手順（承認不要・本番影響なし）

以下のコードブロックは**同一シェルで上から順に**実行する（変数を引き継ぐ）。変数を固定する（すべて実測済みの絶対パス）。

```bash
set -euo pipefail
MAIN=/home/kensan/Projects/Mirai-Admin-Platform/AI-HelpDesk-Platform
STG_ROOT=/home/kensan/ai-helpdesk-stg
STG_CONF=/home/kensan/.config/ai-helpdesk/stg-api.conf
NODE_BIN=/home/kensan/.nvm/versions/node/v22.22.3/bin/node
UNIT_DIR=$HOME/.config/systemd/user
# 固定値を使わない。実行時の origin/main を取得する（#143 の proxy 修正・#144 の 0400 対応を含む）
STG_REF=$(git -C "$MAIN" rev-parse origin/main)
[[ "$STG_REF" =~ ^[a-f0-9]{40}$ ]] || { echo 'STG_REF が 40 hex でない'; exit 1; }
git -C "$MAIN" cat-file -e "${STG_REF}^{commit}"
# #144（46261ea）以降であること（read-only release の manifest 再検証を通すため）
git -C "$MAIN" merge-base --is-ancestor 46261ea "$STG_REF" || { echo 'STG_REF が #144 より前: 中止'; exit 1; }
echo "STG_REF=$STG_REF"
```

#### A-1. unit の再レンダリング（手編集しない）

```bash
sed -e "s|__STG_ROOT__|$STG_ROOT|g" \
    -e "s|__STG_CONF__|$STG_CONF|g" \
    -e "s|__NODE__|$NODE_BIN|g" \
    "$MAIN/ops/systemd/ai-helpdesk-stg-api.service" > /tmp/ai-helpdesk-stg-api.service
# 既存 deployed と差分が無いことを先に確認する（差分があれば内容を確認してから進む）
diff -u "$UNIT_DIR/ai-helpdesk-stg-api.service" /tmp/ai-helpdesk-stg-api.service || true
install -m 644 /tmp/ai-helpdesk-stg-api.service "$UNIT_DIR/ai-helpdesk-stg-api.service"
```

期待: `diff` が空（テンプレートと deployed が一致）。差分が出た場合は、どちらが正しいかを人が判断してから進める。

#### A-2. 設定の前提確認（秘密は表示しない）

```bash
stat -c '%a %U %s' "$STG_CONF"          # 期待: 600 kensan
test -f "$STG_ROOT/current/release.env" && echo release.env_OK
cat "$STG_ROOT/current/release.env"      # COMMIT_SHA / RELEASE_ID / RELEASE_BUILT_AT のみ（秘密なし）
```

#### A-3. Staging release を `origin/main` に合わせる（必要な場合だけ）

`deploy-release.sh` は build 中も現行 release で稼働を続け、最後に symlink を切り替えて restart する。`HTTP_PROXY` 対策として `NO_PROXY` を付ける（§0-2）。**既に `STG_REF` と同じ commit なら deploy しない**（同じ ref の再 build と release 増加を避ける）。

```bash
cd "$MAIN"
STG_CUR=$(readlink -f "$STG_ROOT/current")
STG_CUR_REF=$(node -p 'require(process.argv[1]+"/dist-manifest.json").commit' "$STG_CUR")
STG_PREV=$STG_CUR
echo "staging current=$STG_CUR_REF target=$STG_REF"
if [ "$STG_CUR_REF" = "$STG_REF" ]; then
  echo 'A-3 skip: staging は既に STG_REF。deploy しない（受入は §2-3 で再確認）'
else
  NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost \
    scripts/deploy-release.sh \
    --repo "$MAIN" \
    --ref "$STG_REF" \
    --root "$STG_ROOT" \
    --env-file "$STG_CONF" \
    --unit ai-helpdesk-stg-api \
    --health-port 18952
fi
```

期待: `A-3 skip` の場合は出力どおり。deploy した場合は `deploy: OK <release-id> (commit=$STG_REF)`、終了コード 0。**`PREVIOUS` は固定値ではなく `$STG_PREV`（実行時の直前 release）**。C-5 の訓練（§2-4）はこの値を使う。

#### A-4. 起動の永続化（M-2）

```bash
systemctl --user daemon-reload
systemctl --user enable ai-helpdesk-stg-api.service
systemctl --user enable --now ai-helpdesk-stg-proxy.service
```

期待: `is-enabled` が両方 `enabled`。`enable --now` で proxy が 18951 を listen する（PR #143 修正後は symlink 経由でも `main()` が走る）。

#### A-5. 受入（§2-3）を実行

### 2-3. 受入条件（A）

| # | 検査 | コマンド | 期待値 |
|---|---|---|---|
| A-1 | health の commit が配備 release と一致 | `curl -sS --noproxy '*' http://127.0.0.1:18952/api/health` | `ok:true` / `db:"ok"` / `env:"production"` / `commit` == `$STG_REF`（40 hex）。**空文字は不合格**（A-3 を skip した場合も `commit` が `$STG_REF` であること） |
| A-2 | release の実体と一致 | `readlink -f "$STG_ROOT/current"` と `cat "$STG_ROOT/current/release.env"` | `readlink` が `$STG_ROOT/releases/<新 release-id>`、`COMMIT_SHA` が `$STG_REF` |
| A-3 | proxy 経由の health | `curl -sS --noproxy '*' -w '\nHTTP=%{http_code}\n' http://127.0.0.1:18951/api/health` | HTTP 200 / `ok:true` / `commit` が `$STG_REF` |
| A-4 | 401 の理由が「proxy secret 未付与」と「Access 未認証」で区別できる（L-6） | 下記 2 本 | 1 本目は `401` + `"code":"PROXY_REQUIRED"`、2 本目は `401` + `"code":"UNAUTHORIZED"` |
| A-5 | 本番不変 | §2-3 の before/after を diff | 旧 3 unit の `ActiveState/SubState/MainPID/NRestarts/ActiveEnterTimestamp/InvocationID` と本番 health が**完全一致** |

A-4 の具体コマンド（値は表示しない）:

```bash
PS=$(sed -n 's/^PROXY_SECRET=//p' "$STG_CONF" | tail -n 1); [ -n "$PS" ] || exit 1
echo '--- no proxy secret (期待: PROXY_REQUIRED)'
curl -sS --noproxy '*' -w '\nHTTP=%{http_code}\n' http://127.0.0.1:18952/api/me
echo '--- with proxy secret, no Access JWT (期待: UNAUTHORIZED)'
umask 077; CFG=$(mktemp); chmod 600 "$CFG"
printf 'header = "X-Proxy-Secret: %s"\n' "$PS" > "$CFG"   # argv に秘密を載せない
curl --config "$CFG" -sS --noproxy '*' -w '\nHTTP=%{http_code}\n' http://127.0.0.1:18952/api/me
rm -f "$CFG"; unset PS
```

A-5 の before/after:

```bash
capture() { # $1 = 出力ファイル
  systemctl --user show ai-helpdesk-api ai-helpdesk-proxy ai-helpdesk-cloudflared \
    -p Id,ActiveState,SubState,MainPID,NRestarts,ActiveEnterTimestamp,InvocationID > "$1"
  curl -sS --noproxy '*' http://127.0.0.1:18950/api/health \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(JSON.stringify({ok:j.ok,db:j.db,env:j.env,commit:j.commit}))})' >> "$1"
  echo >> "$1"
  sha256sum "$HOME/.cloudflared/ai-helpdesk-config.yml" >> "$1"
}
capture /tmp/inv-before-A.txt
# A-1〜A-4 を実行した後に:
capture /tmp/inv-after-A.txt
diff -u /tmp/inv-before-A.txt /tmp/inv-after-A.txt && echo 'A-5 OK: 本番不変'
```

基準値（履歴）: docs/81 §6-1 の 07:05 実測 = MainPID `2379216` / NRestarts `0` / InvocationID `4f8d29d238904882a9dd8c6bab20939a` / commit `a5e0a67…`。ただし **A-5 の合格は「実行時 before と after の一致」**であり、絶対値の一致ではない（本体の再起動が無ければ値は動かない）。

### 2-4. C-5（rollback 訓練）を Staging で実施する

C の前に、rollback を staging で実際に往復させる。**本番では訓練しない。**

```bash
set -euo pipefail
STG_ROOT=/home/kensan/ai-helpdesk-stg
: "${STG_PREV:?A-3 で保存した STG_PREV が無い。A-3 と同じシェルで実行する}"
NEW=$(readlink -f "$STG_ROOT/current")
PREV=$STG_PREV
if [ -z "$PREV" ] || [ "$PREV" = "$NEW" ]; then
  # A-3 を skip した場合: 現行 release の state から previous を取る
  PREV=$(node -e '
    const fs = require("fs"), path = require("path");
    const root = process.argv[1];
    const rel = path.basename(fs.realpathSync(root + "/current"));
    const f = path.join(root, "state", "deploy-" + rel + ".json");
    process.stdout.write(JSON.parse(fs.readFileSync(f, "utf8")).previous || "");
  ' "$STG_ROOT" 2>/dev/null || true)
fi
[ -n "$PREV" ] && [ -d "$PREV" ] || { echo 'previous が無い: 訓練中止（§6 に未実施と記録）'; exit 1; }
PREV_REF=$(node -p 'require(process.argv[1]+"/dist-manifest.json").commit' "$PREV")

# 1) 戻す（symlink + restart。旧 unit を start しない）
ln -sfn "$PREV" "$STG_ROOT/.current.new"
mv -Tf "$STG_ROOT/.current.new" "$STG_ROOT/current"
systemctl --user restart ai-helpdesk-stg-api
curl -sS --noproxy '*' http://127.0.0.1:18952/api/health    # 期待: commit == $PREV_REF

# 2) 前進（symlink + restart。再 build しない）
ln -sfn "$NEW" "$STG_ROOT/.current.new"
mv -Tf "$STG_ROOT/.current.new" "$STG_ROOT/current"
systemctl --user restart ai-helpdesk-stg-api
curl -sS --noproxy '*' http://127.0.0.1:18952/api/health    # 期待: commit == $STG_REF
```

合格: 1) で旧 commit（`$PREV_REF`）、2) で新 commit（`$STG_REF`）に戻り、`current` が最終的に新 release を指す。**この訓練が C-5 の根拠**（本番と同じ「symlink + restart」で戻せることの実証）。所要は秒単位。

`previous` が取れず訓練を省略した場合は、**C-5 を合格にせず §6 に「未実施」と記録**する（本番切替前に staging で往復できる状態を先に作る）。

### 2-5. A の rollback

```bash
set -euo pipefail
STG_ROOT=/home/kensan/ai-helpdesk-stg
: "${STG_PREV:?A-3 で保存した STG_PREV が無い}"
ln -sfn "$STG_PREV" "$STG_ROOT/.current.new" && mv -Tf "$STG_ROOT/.current.new" "$STG_ROOT/current"
systemctl --user restart ai-helpdesk-stg-api
curl -sS --noproxy '*' http://127.0.0.1:18952/api/health
```

A-3 を skip した場合、`STG_PREV` は `current` と同じためこの rollback は no-op になる（その旨を §6 に記す）。unit 定義を戻す場合も、手編集ではなく `ops/systemd` のテンプレートを再レンダリングする。Staging DB・本番には触れない。

## 3. B: 公開 Staging（新規 tunnel / DNS / Access）

### 3-1. 原則

- **既存 tunnel `96d0214e…` と既存 Access アプリを変更しない。** 変更すると本番 tunnel の再起動・認証境界の変更になる。
- 新規 tunnel `ai-helpdesk-stg`・新規 Access アプリ（**staging 専用 AUD**）を作る。
- **fail-closed の順序**: (1) tunnel 作成 → (2) config 作成/validate → (3) Access アプリ作成（ポリシーは「拒否が既定」で作る）→ (4) `ACCESS_AUD` / `ACCESS_TEAM_DOMAIN` を staging 設定へ反映 → (5) `ACCESS_JWT_MODE=enforce` 等へ変更して staging API を restart → (6) **最後に** DNS レコードと tunnel unit を有効化。**「先に enforce にしてから公開」ではなく「公開前に enforce と AUD を揃える」**（H-4 の順序矛盾を修正）。
- 本番 config は read-only。`--overwrite-dns` は使わない。

### 3-2. 事前確認（read-only）

```bash
set -u
ls -l "$HOME/.cloudflared/cert.pem"                 # 期待: 600/400（cloudflared tunnel login 済みの証明）
cloudflared tunnel list                              # 期待: ai-helpdesk-stg が無い
dig +short ai-helpdesk-stg.mirai-dx-platform.com     # 期待: 出力なし（既存レコード無し）
sha256sum "$HOME/.cloudflared/ai-helpdesk-config.yml" # 本番 config の基準値（docs/77 §1: d51927da…。前後比較に使う）
df -h /home | tail -1                                # 空き 50G 以上
```

`cert.pem` が無い場合は **`cloudflared tunnel login` を人が実行**してから始める（L-2）。本番 config の sha256 は控える（値は証跡に残してよい。秘密ではない）。

### 3-3. 手順（承認対象に「承認」を明記）

#### B-1. 新規 tunnel と資格情報（承認要: Cloudflare アカウントに資格情報が増える）

```bash
cloudflared tunnel create ai-helpdesk-stg
cloudflared tunnel list --output json \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=JSON.parse(s).find(x=>x.name==="ai-helpdesk-stg");if(!t)process.exit(1);console.log(t.id)})' \
  > /tmp/stg-tunnel-id
TUNNEL_ID=$(cat /tmp/stg-tunnel-id)
CRED="$HOME/.cloudflared/$TUNNEL_ID.json"
chmod 600 "$CRED"
stat -c '%a %n' "$CRED"          # 期待: 600
```

`cloudflared tunnel list --output json` が使えない版では、`cloudflared tunnel list` の表示から UUID を控えて `TUNNEL_ID` に設定する（以降のコマンドは同じ）。

#### B-2. 専用 config（本番ファイルを編集しない）

```bash
cat > "$HOME/.cloudflared/ai-helpdesk-stg-config.yml" <<YAML
tunnel: $TUNNEL_ID
credentials-file: $HOME/.cloudflared/$TUNNEL_ID.json
ingress:
  - hostname: ai-helpdesk-stg.mirai-dx-platform.com
    service: http://127.0.0.1:18951
  - service: http_status:404
YAML
chmod 600 "$HOME/.cloudflared/ai-helpdesk-stg-config.yml"
cloudflared tunnel ingress validate --config "$HOME/.cloudflared/ai-helpdesk-stg-config.yml"
```

期待: `Validating rules... OK`。

#### B-3. Access アプリ（承認要）と AUD の取得

アカウント ID と API トークンは**対話取得**し、履歴・標準出力に残さない。許可ポリシーは実メールを書かず、既存の Access グループ ID を使う（PII を文書・証跡に残さない）。**B-3〜B-6 は同一シェルで実行する。**

```bash
set -euo pipefail
read -rp  'CF_ACCOUNT_ID: ' CF_ACCOUNT_ID
read -rsp 'CF_API_TOKEN: ' CF_API_TOKEN; echo
read -rp  'Access group id (staging testers): ' STG_TESTER_GROUP_ID
export CF_ACCOUNT_ID
umask 077; CFG=$(mktemp); chmod 600 "$CFG"
printf 'header = "Authorization: Bearer %s"\n' "$CF_API_TOKEN" > "$CFG"   # argv にトークンを載せない

APP_JSON=$(curl --config "$CFG" -sS -X POST \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/access/apps" \
  -H 'Content-Type: application/json' \
  --data '{"name":"ai-helpdesk-stg","domain":"ai-helpdesk-stg.mirai-dx-platform.com","type":"self_hosted","session_duration":"8h"}')
APP_ID=$(printf '%s' "$APP_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(!j.success)process.exit(1);console.log(j.result.id)})')
STG_AUD=$(printf '%s' "$APP_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.result.aud)})')

# 許可ポリシー（staging 試験担当の既存グループのみ allow。それ以外は拒否）
curl --config "$CFG" -sS -X POST \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/access/apps/$APP_ID/policies" \
  -H 'Content-Type: application/json' \
  --data '{"name":"staging-testers","decision":"allow","include":[{"group":{"id":"'"$STG_TESTER_GROUP_ID"'"}}]}' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.exit(j.success?0:1)})'
rm -f "$CFG"
```

`STG_TESTER_GROUP_ID` は B-3 で対話取得済み（実メールを書かない）。AUD は秘密ではないが、**本番 AUD と同一でないこと**を §3-4 B-4 で検査する。

#### B-4. staging 設定へ AUD / team domain / enforce を反映（H-4）

team domain は本番と同一 team（docs/77 §3-6）。本番設定から**値だけ**を取り、staging 設定を安全に更新する（パスワードは表示しない）。

```bash
set -euo pipefail
# B-3 と同じシェルで実行する（STG_AUD / APP_ID を引き継ぐ）。
STG_CONF=$HOME/.config/ai-helpdesk/stg-api.conf
PROD_CONF=$HOME/.config/ai-helpdesk/api.conf
STG_TEAM_DOMAIN=$(sed -n 's/^ACCESS_TEAM_DOMAIN=//p' "$PROD_CONF" | tail -n 1)
[ -n "$STG_TEAM_DOMAIN" ] || { echo 'team domain が本番設定に無い: 中止'; exit 1; }
[ -n "$STG_AUD" ] || { echo 'staging AUD が無い: 中止'; exit 1; }

umask 077
TMP=$(mktemp)
grep -v -E '^(AUTH_MODE|ACCESS_JWT_MODE|ACCESS_TEAM_DOMAIN|ACCESS_AUD|COOKIE_SECURE|ALLOWED_ORIGINS)=' "$STG_CONF" > "$TMP"
cat >> "$TMP" <<EOF
AUTH_MODE=cloudflare-access
ACCESS_JWT_MODE=enforce
ACCESS_TEAM_DOMAIN=$STG_TEAM_DOMAIN
ACCESS_AUD=$STG_AUD
COOKIE_SECURE=true
ALLOWED_ORIGINS=https://ai-helpdesk-stg.mirai-dx-platform.com
EOF
install -m 600 "$TMP" "$STG_CONF"
rm -f "$TMP"
stat -c '%a %U' "$STG_CONF"      # 期待: 600 kensan
systemctl --user restart ai-helpdesk-stg-api

# B-4 の設定値検査（AUD は秘密ではない）
PROD_AUD=$(sed -n 's/^ACCESS_AUD=//p' "$PROD_CONF" | tail -n 1)
CONF_AUD=$(sed -n 's/^ACCESS_AUD=//p' "$STG_CONF" | tail -n 1)
[ -n "$PROD_AUD" ] && [ -n "$CONF_AUD" ] && [ "$PROD_AUD" != "$CONF_AUD" ] && echo 'B-4(設定): AUD は本番と別'
```

注意: `ACCESS_JWT_MODE=enforce` は **AUD/team を入れた後**に再起動する。順序を逆にすると JWT 検証が成立せず 401 になる（fail-closed なので安全側だが、受入は通らない）。

#### B-5. tunnel unit（staging 専用）

```bash
cat > /tmp/ai-helpdesk-stg-cloudflared.service <<'UNIT'
[Unit]
Description=Cloudflare Tunnel for ai-helpdesk-stg.mirai-dx-platform.com (staging)
After=network-online.target ai-helpdesk-stg-api.service
Wants=network-online.target ai-helpdesk-stg-api.service

[Service]
Type=simple
ExecStart=/usr/local/bin/cloudflared --no-autoupdate --config %h/.cloudflared/ai-helpdesk-stg-config.yml tunnel run
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
UNIT
install -m 644 /tmp/ai-helpdesk-stg-cloudflared.service "$HOME/.config/systemd/user/ai-helpdesk-stg-cloudflared.service"
systemctl --user daemon-reload
systemctl --user enable --now ai-helpdesk-stg-cloudflared.service
```

#### B-6. DNS（承認要・最後に実行）

```bash
cloudflared tunnel route dns --config "$HOME/.cloudflared/ai-helpdesk-stg-config.yml" \
  ai-helpdesk-stg ai-helpdesk-stg.mirai-dx-platform.com
```

DNS 作成は staging hostname のみ。**`--overwrite-dns` を使わない。既存レコードがあれば停止して人間に返す。**

### 3-4. 受入条件（B）

| # | 検査 | コマンド | 期待値 |
|---|---|---|---|
| B-1 | 本番不変 | 下記の before/after を diff | 本番 cloudflared/api/proxy の `MainPID/NRestarts/InvocationID` と本番 config の sha256 が一致（docs/77 §1 の基準値 `d51927da…` とも照合）。新規 staging tunnel の増加は想定内なので、本番 tunnel は `cloudflared tunnel list | grep 96d0214e` で別途確認する |
| B-2 | 未認証は Access へ | `curl -sS -o /dev/null -D - https://ai-helpdesk-stg.mirai-dx-platform.com/ \| grep -iE '^HTTP/\|^location:'` | `302` + `location:` が `https://<team>.cloudflareaccess.com/cdn-cgi/access/login/...` |
| B-3 | 認証後 UI（人間） | ブラウザで Access ログイン → `https://ai-helpdesk-stg.mirai-dx-platform.com/` | `200`。試験担当のみ許可、他は拒否 |
| B-4 | 本番と別 AUD | 設定値の比較（§3-3 B-4）+ ログイン後の `CF_Authorization` の `aud` を decode | `staging の ACCESS_AUD` == JWT の `aud`、かつ **本番 AUD と不一致** |
| B-5 | DB 隔離（構造 + 件数） | 下記 | staging DSN が `127.0.0.1:5437/ai_helpdesk_stg`、本番 DSN が別（`5435` 系）。**本番 audit の `checked` / `mismatchCount` が B の前後で不変** |

B-1 の before/after:

```bash
captureB() {
  systemctl --user show ai-helpdesk-api ai-helpdesk-proxy ai-helpdesk-cloudflared \
    -p Id,ActiveState,SubState,MainPID,NRestarts,ActiveEnterTimestamp,InvocationID > "$1"
  sha256sum "$HOME/.cloudflared/ai-helpdesk-config.yml" >> "$1"
}
captureB /tmp/inv-before-B.txt
# B の作業後:
captureB /tmp/inv-after-B.txt
diff -u /tmp/inv-before-B.txt /tmp/inv-after-B.txt && echo 'B-1 OK: 本番不変'
```

B-4 の JWT 検査（JWT は表示しない。`aud` は単一値・配列の両方を扱う）:

```bash
read -rsp 'CF_Authorization (JWT): ' CF_JWT; echo
PROD_AUD=$(sed -n 's/^ACCESS_AUD=//p' "$HOME/.config/ai-helpdesk/api.conf" | tail -n 1)
STG_AUD_CONF=$(sed -n 's/^ACCESS_AUD=//p' "$HOME/.config/ai-helpdesk/stg-api.conf" | tail -n 1)
JWT_OK=$(printf '%s' "$CF_JWT" | node -e '
  let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
    const p = s.split(".")[1];
    const aud = [].concat(JSON.parse(Buffer.from(p, "base64url")).aud || []);
    process.stdout.write(aud.includes(process.argv[1]) && !aud.includes(process.argv[2]) ? "yes" : "no");
  });
' "$STG_AUD_CONF" "$PROD_AUD")
unset CF_JWT
[ "$JWT_OK" = yes ] && echo 'B-4 OK: staging JWT は staging AUD（本番 AUD を含まない）'
```

B-5 の構造的根拠と件数（**本番 DB への read-only 接続を伴うため承認要**。`audit-find-breaks.ts` は `default_transaction_read_only=on` を強制する）:

```bash
echo '--- staging DSN の向き先（パスワードは出さない）'
sed -n 's|^DATABASE_URL=[a-z]*://[^@]*@|STG_TARGET=|p' "$HOME/.config/ai-helpdesk/stg-api.conf"
echo '--- 本番 DSN の向き先'
sed -n 's|^DATABASE_URL=[a-z]*://[^@]*@|PROD_TARGET=|p' "$HOME/.config/ai-helpdesk/api.conf"
# staging 側の同一性（SELECT のみ）
psql -h 127.0.0.1 -p 5437 -U aihd_stg -d ai_helpdesk_stg -At -F '|' -c \
  "SELECT current_database(), inet_server_port();"     # 期待: ai_helpdesk_stg|5437
```

本番 audit の前後比較（read-only。`default_transaction_read_only=on`）:

```bash
cd /home/kensan/Projects/Mirai-Admin-Platform/AI-HelpDesk-Platform
audit() {
  node scripts/run-with-env-file.mjs "$HOME/.config/ai-helpdesk/api.conf" -- \
    ./node_modules/.bin/tsx scripts/audit-find-breaks.ts > "$1"
  node -e 'const j=require(process.argv[1]);console.log(JSON.stringify({db:j.database,checked:j.checked,mismatchCount:j.mismatchCount,ids:j.mismatches.map(m=>m.id)}))' "$1"
}
audit /tmp/prod-audit-before-B.json
# B の smoke（staging の UI 操作）後:
audit /tmp/prod-audit-after-B.json
diff -u <(node -e 'const j=require(process.argv[1]);console.log(JSON.stringify({c:j.checked,n:j.mismatchCount,ids:j.mismatches.map(m=>m.id)}))' /tmp/prod-audit-before-B.json) \
        <(node -e 'const j=require(process.argv[1]);console.log(JSON.stringify({c:j.checked,n:j.mismatchCount,ids:j.mismatches.map(m=>m.id)}))' /tmp/prod-audit-after-B.json) \
  && echo 'B-5 OK: 本番の監査行に staging 操作の痕跡なし'
```

**注意:** 本番に無関係な書き込み（端末エージェント等）があると `checked` が動く。差分が出た場合は `mismatches` の id/action を確認し、staging 由来でないことを示す（差を無条件に合格にしない）。

### 3-5. 禁止事項（手順に埋め込む）

- `--overwrite-dns` を使わない。既存レコードがあれば停止して人間に返す。
- 本番 config（`ai-helpdesk-config.yml`）を編集・rename しない。`--config` の指定を切り替えない。
- `systemctl --user restart ai-helpdesk-cloudflared` を実行しない（本番 tunnel の再起動）。
- 本番 `api.conf` を読んで値を表示しない。staging 設定に本番の DSN・key を入れない。
- 実メールアドレスを runbook・証跡・git に書かない（Access の許可はグループ ID で指定）。

### 3-6. B の rollback（M-6: 資格情報の残置まで）

| 順 | 操作 | コマンド | 本番影響 |
|---|---|---|---|
| 1 | staging tunnel 停止 | `systemctl --user disable --now ai-helpdesk-stg-cloudflared.service` | なし |
| 2 | DNS 削除 | Cloudflare API/Dashboard で staging の CNAME を削除（**承認操作**） | なし（staging hostname のみ） |
| 3 | tunnel 削除 | `cloudflared tunnel cleanup ai-helpdesk-stg` → `cloudflared tunnel delete ai-helpdesk-stg` | なし |
| 4 | **資格情報の削除** | `rm -f "$HOME/.cloudflared/$TUNNEL_ID.json"`、`rm -f "$HOME/.cloudflared/ai-helpdesk-stg-config.yml"` | なし（残すと同名再作成時の取り違え源） |
| 5 | Access アプリ削除 | `DELETE /accounts/{id}/access/apps/{app_id}`（**承認操作**） | なし。AUD を消すと staging の JWT 検証は 401 になる（意図どおり fail-closed） |
| 6 | 確認 | `cloudflared tunnel list`、`dig +short ai-helpdesk-stg…`、`ls ~/.cloudflared/*.json` | 残存 0 を確認 |

## 4. C: 本番の release 方式への切替と配備

### 4-0. 影響・停止見込み・承認

| 項目 | 内容 |
|---|---|
| 変更 | 本番 API の起動元を checkout 直参照から immutable release（`current` symlink）へ変える。port・tunnel・DB・設定値は変えない |
| 停止 | **初回**: 最終の 18950 切替で数秒（旧 unit stop → 新 unit が 18950 を listen するまで）。build は旧 unit 稼働中に済ませる（§4-6 の precheck port）。**再配備**: build 中も稼働、切替で数秒 |
| DB | schema は変更しない。`--migrate` / `--seed` は渡さない。起動時のカタログ同期（upsert）は起こり得る（docs/77 §4-3） |
| 不可逆性 | unit の enable/mask・`current` symlink の状態が変わる。release は read-only で残る |
| 承認 | **要**（本番 unit の追加・切替・旧 unit の disable/mask）。承認者・時刻・対象 ref を §6 に記録する |
| rollback | §4-10。bootstrap は `current` 削除 + 旧 unit 起動、以降は `previous` symlink + restart |

**§4 のコードブロックは同一シェルで上から順に実行する**（`DEPLOY_REF` / `PREV_BEFORE` / `RC` を引き継ぐ）。各操作の承認は §4-0 の「承認: 要」に従う。

### 4-1. 事前 preflight（read-only。1 つでも違えば中止）

```bash
set -euo pipefail
MAIN=/home/kensan/Projects/Mirai-Admin-Platform/AI-HelpDesk-Platform
PROD_ROOT=/home/kensan/ai-helpdesk-prod
UNIT=ai-helpdesk-prod-api
DEPLOY_REF=$(git -C "$MAIN" rev-parse origin/main)   # 40 hex。実行時の main を記録する
ENV_FILE=$HOME/.config/ai-helpdesk/api.conf

# 1) ref は main の祖先・40 hex
[[ "$DEPLOY_REF" =~ ^[a-f0-9]{40}$ ]] || { echo 'ref が 40 hex でない'; exit 1; }
git -C "$MAIN" merge-base --is-ancestor "$DEPLOY_REF" origin/main

# 2) root / unit / env の固定（docs/77 §4-6 の手動代替。H-5）
[ "$PROD_ROOT" = /home/kensan/ai-helpdesk-prod ] || { echo 'root が想定外'; exit 1; }
case "$UNIT" in ai-helpdesk-api|ai-helpdesk-proxy|ai-helpdesk-cloudflared|ai-helpdesk-backup) echo '既存 unit 名は不可'; exit 1;; esac
[ -f "$ENV_FILE" ] || { echo 'env file が無い'; exit 1; }
[ -O "$ENV_FILE" ] || { echo 'env file の所有者が違う'; exit 1; }
case "$(stat -c %a "$ENV_FILE")" in 600|400) ;; *) echo 'env の mode が 600/400 でない'; exit 1;; esac
[ "$(realpath "$MAIN")" = /home/kensan/Projects/Mirai-Admin-Platform/AI-HelpDesk-Platform ] || { echo 'repo が本番 checkout でない'; exit 1; }

# 3) ref は #146（unit テンプレート / restart rollback）以降
git -C "$MAIN" merge-base --is-ancestor e35f4cb "$DEPLOY_REF" || { echo 'DEPLOY_REF が #146 より前: 中止'; exit 1; }
# 4) DB 差分が無い（migration を伴わない）こと
[ "$(git -C "$MAIN" diff --name-only a5e0a6719699d4711fc1811bbdb79c74d9aab393.."$DEPLOY_REF" -- db/ | wc -l)" -eq 0 ] || { echo 'db/ に差分がある: 別承認が必要'; exit 1; }

# 5) unit テンプレートが main に存在
UNIT_TEMPLATE=/home/kensan/Projects/Mirai-Admin-Platform/AI-HelpDesk-Platform/ops/systemd/ai-helpdesk-prod-api.service
[ -f "$UNIT_TEMPLATE" ] || { echo 'unit テンプレートが無い: 中止'; exit 1; }

# 6) 資源・状態（MODE と unit の有無が矛盾したら中止）
df -h /home | tail -1
if [ -e "$PROD_ROOT/current" ] || [ -L "$PROD_ROOT/current" ]; then
  echo 'MODE=subsequent（既存 current あり）'
  test -e "$HOME/.config/systemd/user/$UNIT.service" || { echo 'current はあるが unit が無い: 中止'; exit 1; }
  [ "$(systemctl --user is-active ai-helpdesk-prod-api)" = active ] || { echo '本番 unit が active でない: 中止'; exit 1; }
else
  echo 'MODE=bootstrap（current なし）'
  if [ -e "$HOME/.config/systemd/user/$UNIT.service" ]; then echo 'current は無いが unit がある: 状態を確認して中止'; exit 1; fi
  [ "$(systemctl --user is-active ai-helpdesk-api)" = active ] || { echo '旧 unit が active でない: 中止'; exit 1; }
  if ss -ltn | grep -q ':18953\b'; then echo '18953 が使用中: 中止（precheck port を変える）'; exit 1; fi
fi
```

### 4-2. 事前バックアップ（read-only の dump。DB は変更しない）

```bash
cd "$MAIN"
bash scripts/backup-db.sh
ls -lt "$HOME/backups/ai-helpdesk/" | head -3     # 新しい dump が増えていること
# dump が読めること（復元はしない。復元訓練は docs/81 §10 で実施済み）
NEW_DUMP=$(ls -t "$HOME/backups/ai-helpdesk"/ai_helpdesk_preview-*.dump | head -1)
/usr/lib/postgresql/16/bin/pg_restore --list "$NEW_DUMP" | wc -l    # 期待: 1 以上
```

既存の基準 backup: `ai_helpdesk_preview-20261106-023218.dump`（266,586 B）。**この dump への復元は本番 DB に行わない。**

### 4-3. 停止位置の方針（M-4 の解消）

`deploy-release.sh` の `--health-port` は **restart 後にその port を照合**する。旧 unit が 18950 で稼働したまま非 dry-run を実行すると、health は**旧プロセス**を読む。`api.conf` の `COMMIT_SHA` がたまたま新 ref と一致していれば**誤って合格**し、一致しなければ rollback 分岐に入る。どちらも事故になる。

そこで**初回だけ**、新 unit に一時的な `PORT=18953` を読ませて health を通し、その後に 18950 へ切り替える。これにより build 中も旧 unit が本番を serving し、停止は 18950 の切替の数秒だけになる。18953 は 08:21 時点で未使用（`ss -ltn`。§4-1 で再確認する）。

**簡略版（precheck port を使わない）**: 旧 unit を stop してから非 dry-run を実行し、build を含む停止（数分）を許容する。`EnvironmentFiles` の順序が §4-4 で確認できない場合、または 18953 が使えない場合はこちらを選ぶ（health は 18950。`--health-port 18950`）。

### 4-4. 新 unit は main のテンプレートを正本とする（C-2 / High-3）

**承認: 要**（本番 unit の配置）。影響: unit ファイルを置くだけでは起動しない（起動は §4-6 の deploy-release）。rollback: unit を削除するか、旧 unit を unmask/start（§4-10）。

`ops/systemd/ai-helpdesk-prod-api.service` は **main（#146 `e35f4cb`）に存在する**。**テンプレートを正本**とし、runbook は `deploy-release.sh --unit-template` にレンダリング・配置を任せる。runbook 側に別の unit 全文を持たない（乖離の原因になる）。

#### テンプレート全文（`origin/main:ops/systemd/ai-helpdesk-prod-api.service`）

```ini
[Unit]
Description=AI HelpDesk Production API (127.0.0.1:18950, immutable release)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=__PROD_ROOT__/current
# 通常の設定（秘密を含む）は従来どおり api.conf から読む。
EnvironmentFile=__ENV_FILE__
# COMMIT_SHA / RELEASE_ID は release から供給する。config の自己申告値ではなく、
# 「どの release を起動しているか」を health で観測できるようにするため後置する。
EnvironmentFile=__PROD_ROOT__/current/release.env
ExecStart=__NODE__ __PROD_ROOT__/current/apps/api/dist/index.js
Restart=on-failure
RestartSec=3
TimeoutStopSec=10
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full

[Install]
WantedBy=default.target
```

`deploy-release.sh --unit-template` が行う置換（main の実装）:

| プレースホルダ | 置換後（本番） |
|---|---|
| `__PROD_ROOT__`（`__ROOT__` / `__STG_ROOT__` も同じ値） | `/home/kensan/ai-helpdesk-prod` |
| `__ENV_FILE__`（`__STG_CONF__` も同じ値） | `/home/kensan/.config/ai-helpdesk/api.conf` |
| `__NODE__` | `command -v node` の絶対パス（本環境 `/home/kensan/.nvm/versions/node/v22.22.3/bin/node`） |
| `__NODE_DIR__` | 上記の dirname |

- **`COMMIT_SHA` の供給元は `current/release.env`**。`EnvironmentFile` は後に書いたものが勝つため、`api.conf` → `release.env` の順で release の SHA が有効になる。`api.conf` の `COMMIT_SHA` は**書き換えない**（自己申告になるため禁止）。
- **`Restart=on-failure` / `RestartSec=3` はテンプレートの選択**であり、旧 `ai-helpdesk-api` の drop-in `Restart=always` / `RestartSec=2` は新 unit に引き継がれない。`on-failure` は異常終了・シグナル・タイムアウトで再起動し、正常終了（exit 0）では再起動しない。`always` が必要なら**テンプレートを変更する別 PR**で行う（本 runbook は配備済み unit を手編集しない）。
- `PORT` / `HOST` は unit に書かず `api.conf` から供給する（`PORT=18950`）。precheck 時だけ drop-in の追加 `EnvironmentFile` で `PORT=18953` を後勝ちさせる（§4-6）。

#### 事前確認（テンプレートの存在とレンダリング結果）

```bash
set -euo pipefail
MAIN=/home/kensan/Projects/Mirai-Admin-Platform/AI-HelpDesk-Platform
PROD_ROOT=/home/kensan/ai-helpdesk-prod
ENV_FILE=$HOME/.config/ai-helpdesk/api.conf
TEMPLATE="$MAIN/ops/systemd/ai-helpdesk-prod-api.service"
NODE_BIN=$(command -v node)
[ -f "$TEMPLATE" ] || { echo 'テンプレートが無い: 中止'; exit 1; }
[ -n "$NODE_BIN" ] || { echo "node が PATH に無い: 中止"; exit 1; }
[ "$NODE_BIN" = /home/kensan/.nvm/versions/node/v22.22.3/bin/node ] || echo "警告: node が想定と違う: $NODE_BIN"

# deploy-release と同じ sed で「配置される内容」を作り、既存 deployed と比較する（参考。正本はテンプレート）
sed -e "s|__ROOT__|$PROD_ROOT|g" -e "s|__STG_ROOT__|$PROD_ROOT|g" -e "s|__PROD_ROOT__|$PROD_ROOT|g" \
    -e "s|__ENV_FILE__|$ENV_FILE|g" -e "s|__STG_CONF__|$ENV_FILE|g" \
    -e "s|__NODE__|$NODE_BIN|g" -e "s|__NODE_DIR__|$(dirname -- "$NODE_BIN")|g" \
    "$TEMPLATE" > /tmp/ai-helpdesk-prod-api.expected
if [ -e "$HOME/.config/systemd/user/ai-helpdesk-prod-api.service" ]; then
  diff -u "$HOME/.config/systemd/user/ai-helpdesk-prod-api.service" /tmp/ai-helpdesk-prod-api.expected || true
  echo '差分が出てもテンプレートが正本。deploy-release が上書きする（手編集しない）'
fi
```

#### 初回のみ: 一時 precheck port 18953（build 中も本番を止めないため）

```bash
mkdir -p "$HOME/.config/systemd/user/ai-helpdesk-prod-api.service.d"
umask 077
printf 'PORT=18953\n' > /home/kensan/ai-helpdesk-prod/state/precheck.env
chmod 600 /home/kensan/ai-helpdesk-prod/state/precheck.env
cat > "$HOME/.config/systemd/user/ai-helpdesk-prod-api.service.d/precheck-port.conf" <<'CONF'
[Service]
EnvironmentFile=/home/kensan/ai-helpdesk-prod/state/precheck.env
CONF
chmod 644 "$HOME/.config/systemd/user/ai-helpdesk-prod-api.service.d/precheck-port.conf"
```

`EnvironmentFile` の解決順は、unit 配置後に `systemctl --user show ... -p EnvironmentFiles` で確認する（期待: `api.conf` → `current/release.env` → `state/precheck.env`。§4-6 の直後に確認）。

### 4-5. daemon-reload（既存 unit は再起動しない）

```bash
systemctl --user daemon-reload
systemctl --user show ai-helpdesk-api -p InvocationID,MainPID   # 期待: 4-1 の before と不変
```

`daemon-reload` は既存 unit を再起動しない。ここで `ai-helpdesk-api` の `InvocationID` が変わったら**中止**する。なお `deploy-release.sh --unit-template` は **unit 配置後に自身で `daemon-reload` する**（§4-6）。この手動 reload は precheck drop-in を先に読ませるためのもの。

### 4-6. 初回の実配備（`--dry-run` なし）

**影響:** `current` の切替と新 unit の起動（旧 unit は稼働継続）。**承認: 要**。**rollback:** `RC≠0` は §4-10。

**順序**: テンプレート検証と precheck drop-in の設置（§4-4）→ 非 dry-run。`deploy-release.sh --unit-template` は **build 後に unit を配置して `daemon-reload` し、`current` を原子的に差し替え、`--unit` を restart**、`--health-port` の health が `commit == ref` になるまで 45 秒待つ。失敗時は `previous` があれば自動で戻す（初回は previous が無いので §4-10 R-C1 で戻す）。

```bash
set -euo pipefail
cd /home/kensan/Projects/Mirai-Admin-Platform/AI-HelpDesk-Platform
# rollback の基準を先に保存する（R-C2 が使う。旧 unit を start するだけの rollback を防ぐ）
PREV_BEFORE=$(readlink -f /home/kensan/ai-helpdesk-prod/current 2>/dev/null || true)
if [ -n "$PREV_BEFORE" ]; then
  printf '%s\n' "$PREV_BEFORE" > /home/kensan/ai-helpdesk-prod/state/rollback-target.txt
  chmod 600 /home/kensan/ai-helpdesk-prod/state/rollback-target.txt
fi

# C-4 の基準を保存（本番 DB の read-only 監査は承認要）
node scripts/run-with-env-file.mjs "$HOME/.config/ai-helpdesk/api.conf" -- \
  ./node_modules/.bin/tsx scripts/audit-find-breaks.ts > /tmp/prod-audit-before-C.json

# 初回は precheck port 18953、再配備は 18950
HEALTH_PORT=18953; [ -e /home/kensan/ai-helpdesk-prod/state/precheck.env ] || HEALTH_PORT=18950
UNIT_TEMPLATE=/home/kensan/Projects/Mirai-Admin-Platform/AI-HelpDesk-Platform/ops/systemd/ai-helpdesk-prod-api.service
set +e
NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost \
  scripts/deploy-release.sh \
  --repo /home/kensan/Projects/Mirai-Admin-Platform/AI-HelpDesk-Platform \
  --ref "$DEPLOY_REF" \
  --root /home/kensan/ai-helpdesk-prod \
  --env-file "$HOME/.config/ai-helpdesk/api.conf" \
  --unit ai-helpdesk-prod-api \
  --unit-template "$UNIT_TEMPLATE" \
  --health-port "$HEALTH_PORT"
RC=$?
set -e
echo "deploy RC=$RC"
# 再配備（precheck なし）は deploy 完了時点が切替時刻。C-6 の比較基準を保存する
if [ ! -e /home/kensan/ai-helpdesk-prod/state/precheck.env ]; then
  T0=$(date -Is); printf '%s\n' "$T0" > /tmp/cutover-t0; echo "cutover T0=$T0"
fi
```

期待: `RC=0`、`deploy: OK <release-id> (commit=$DEPLOY_REF)`。この時点で **`current` が生成され**、unit はテンプレートから配置され、新 unit は **18953** で稼働、旧 unit は **18950 で稼働継続**（本番は止まっていない）。deploy ログに `unit installed from template` が出ることも確認する。

`RC≠0` のときは §4-10 の判定表に従う（**その場で受け入れ判断をしない**）。

**再配備（MODE=subsequent）の場合**: 新 unit は既に 18950 で稼働しているため、precheck port も drop-in も不要。`--health-port 18950` で同じコマンドを実行し（build 中は旧 release で稼働、最後に restart して数秒停止）、**§4-8 は実行しない**（旧 unit は既に masked、新 unit は enabled）。§4-7 の確認 port は 18950 に読み替え、§4-9 へ進む。

### 4-7. health の commit 一致と「配備の出自」の確認（C-2）

```bash
set -euo pipefail
# unit がテンプレートどおり配置され、EnvironmentFile が後置されていることを先に確認
systemctl --user show ai-helpdesk-prod-api -p EnvironmentFiles
systemctl --user cat ai-helpdesk-prod-api | grep -n '^EnvironmentFile='
# bootstrap は 18953（precheck port）、subsequent は 18950
HEALTH_PORT=18953; [ -e /home/kensan/ai-helpdesk-prod/state/precheck.env ] || HEALTH_PORT=18950
curl -sS --noproxy '*' "http://127.0.0.1:$HEALTH_PORT/api/health"
CUR=$(readlink -f /home/kensan/ai-helpdesk-prod/current)
echo "current=$CUR"
cat /home/kensan/ai-helpdesk-prod/current/release.env
MAINPID=$(systemctl --user show -p MainPID --value ai-helpdesk-prod-api)
[ -n "$MAINPID" ] && [ "$MAINPID" -gt 0 ] || { echo 'MainPID が取れない: 中止'; exit 1; }
[ "$(readlink -f "/proc/$MAINPID/cwd")" = "$CUR" ] || { echo 'cwd が current と不一致: 中止'; exit 1; }
tr '\0' ' ' < "/proc/$MAINPID/cmdline" | grep -F "$CUR/apps/api/dist/index.js"
ls -t /home/kensan/ai-helpdesk-prod/state/deploy-*.json | head -1 | xargs cat
```

期待:
- health: `ok:true` / `db:"ok"` / `env:"production"` / `commit == $DEPLOY_REF`。
- `current` の実体 == `releases/<新 release-id>`、`release.env` の `COMMIT_SHA` == `$DEPLOY_REF`。
- プロセスの cwd と `cmdline` が `current` 配下。
- state の `result` が `success`（`healthPort` は bootstrap で `18953`、subsequent で `18950`）。

この 4 点で「配備の出自」を確認する（precheck port 上）。**§4-8 の後に 18950 で同じ 4 点を再確認して C-1 を確定する**。health の `commit` 単独では合格にしない（自己申告のため）。

### 4-8. 18950 への切替と unit 交代（H-1）

ここから**数秒の停止**が始まる。旧 unit を stop し、precheck を外し、新 unit を 18950 で起動する。**影響:** 18950 が数秒応答しない（502/接続失敗）。**承認: 要**（§4-0）。**rollback:** health が通らなければ R-C1 / R-C2。

```bash
# 0) C-6 の比較用に切替時刻を保存（10 分窓の基準）
T0=$(date -Is); printf '%s\n' "$T0" > /tmp/cutover-t0; echo "cutover T0=$T0"

# 1) 旧 unit を停止（停止開始。18950 が空く）
systemctl --user stop ai-helpdesk-api

# 2) 一時 precheck を除去して 18950 に戻す
rm -f "$HOME/.config/systemd/user/ai-helpdesk-prod-api.service.d/precheck-port.conf"
rm -f /home/kensan/ai-helpdesk-prod/state/precheck.env
systemctl --user daemon-reload
systemctl --user restart ai-helpdesk-prod-api

# 3) 18950 で health と commit を確認（最大 30 秒待つ。commit が違うまま旧 unit を disable しない）
OK=0
for i in $(seq 1 30); do
  if body=$(curl -fsS --noproxy '*' http://127.0.0.1:18950/api/health 2>/dev/null); then
    if printf '%s' "$body" | node -e '
      let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
        const j = JSON.parse(s);
        process.exit(j.ok === true && j.db === "ok" && j.commit === process.argv[1] ? 0 : 1);
      });' "$DEPLOY_REF"; then OK=1; break; fi
  fi
  sleep 1
done
if [ "$OK" -ne 1 ]; then
  echo '18950 が healthy にならない: 旧 unit は停止中。R-C1（bootstrap）または R-C2（previous あり）で戻す'
  exit 1
fi
# 3b) 18950 でも「配備の出自」を確認してから旧 unit を disable する
CUR=$(readlink -f /home/kensan/ai-helpdesk-prod/current)
MAINPID=$(systemctl --user show -p MainPID --value ai-helpdesk-prod-api)
[ -n "$MAINPID" ] && [ "$(readlink -f "/proc/$MAINPID/cwd")" = "$CUR" ] || { echo 'cwd 不一致: 中止'; exit 1; }
tr '\0' ' ' < "/proc/$MAINPID/cmdline" | grep -F "$CUR/apps/api/dist/index.js"

# 4) 旧 unit を disable + mask（Wants による引き上げを止める）、新 unit を enable
#    mask が unit ファイルを置換する実装に備え、定義を退避してから行う
cp -p "$HOME/.config/systemd/user/ai-helpdesk-api.service" \
  /home/kensan/ai-helpdesk-prod/state/ai-helpdesk-api.service.bak 2>/dev/null || true
systemctl --user disable ai-helpdesk-api
systemctl --user mask ai-helpdesk-api || true
if [ "$(systemctl --user is-enabled ai-helpdesk-api 2>/dev/null || true)" != masked ]; then
  echo 'mask できなかった: unit ファイルを退避して daemon-reload'
  mv "$HOME/.config/systemd/user/ai-helpdesk-api.service" \
    /home/kensan/ai-helpdesk-prod/state/ai-helpdesk-api.service.disabled
  systemctl --user daemon-reload
fi
systemctl --user enable ai-helpdesk-prod-api
systemctl --user is-enabled ai-helpdesk-prod-api    # 期待: enabled
systemctl --user is-enabled ai-helpdesk-api 2>/dev/null || true   # 期待: masked（退避時は not-found）
ss -ltn | grep -E ':1895[03]\b'                     # 期待: 18950 のみ（18953 は消える）
```

**`ai-helpdesk-proxy` の二次リスク（H-1）**: proxy は `Wants=ai-helpdesk-api.service` を持つため、`disable` だけでは proxy の再起動時に systemd が**旧 unit を引き上げ**、18950 を奪い合う。`mask` はこれを止めるための措置である。ただし **恒久対策は proxy unit の `Wants=` / `After=` を `ai-helpdesk-prod-api` に変えること**で、これは別 PR（`ops/systemd/ai-helpdesk-proxy.service` の変更 → 再レンダリング → `daemon-reload` → 保守ウィンドウで proxy restart）。それまでは旧 unit を **masked のまま**維持する。旧 unit へ戻すときは必ず `unmask` してから `start` する（§4-10）。

**mask の限界（M-e）**: `mask` は unit の起動を止めるが、**依存関係の記述は変えない**ため、`systemctl --user status ai-helpdesk-proxy` には `ai-helpdesk-api.service` の failed dependency が残り続ける（proxy 自体の起動は妨げない）。`mask` の実装は環境により unit ファイルを symlink で置換し得るため、§4-8 では**定義を `state/ai-helpdesk-api.service.bak` に退避**し、`is-enabled` で `masked` を確認する。`mask` が効かない場合は unit ファイルを `state/ai-helpdesk-api.service.disabled` へ退避する。再レンダリングで mask が外れる/外れないは環境依存なので、`is-enabled` で都度確認する。解除は明示的な `unmask`（必要なら退避から復元）のみ。

### 4-9. 受入条件（C）

C-3 / C-4 / C-6 はレビューで「観測不能」とされた項目。すべてコマンドと期待値を持つ。

| # | 検査 | コマンド | 期待値 |
|---|---|---|---|
| C-1 | health の commit が配備 release と一致 | `curl -sS --noproxy '*' http://127.0.0.1:18950/api/health` + §4-8 で 18950 の cwd / cmdline / `release.env` を再確認 | `ok:true` / `db:"ok"` / `env:"production"` / `commit == $DEPLOY_REF` / `current`・cwd・`release.env` が一致 |
| C-2 | 公開経路 | `curl -sS -o /dev/null -w '%{http_code}\n' https://ai-helpdesk.mirai-dx-platform.com/` と `curl -fsS --noproxy '*' http://127.0.0.1:18950/api/health` | 公開は `302`（Access）、ローカル health は `200` |
| C-3 | 主要画面 3 URL（実 Access ログインは人間） | 下記（**18949 proxy 経由**） | `/` = `200`、`/index.html` = `200`、`/api/state` = `200`（JSON）。18950 直叩きは `401 PROXY_REQUIRED` なので使わない |
| C-4 | 監査 | 下記の `audit-find-breaks.ts` | `mismatchCount == 2`、id が `{10010,10013}`、`kind=prev_hash_mismatch` が 0 件、かつ deploy 前後で不変 |
| C-5 | rollback 実効性 | §2-4 の staging 訓練（本番では訓練しない） | 旧 commit → 新 commit の往復が symlink + restart で成立 |
| C-6 | 監視 | 下記の 10 分窓比較 + tunnel-watch | 経路失敗 after=0（または after ≤ before）、新 unit の `5xx == 0`（分母 `completed` ≥ 1）、`tunnel-watch: ok (failures=<3) window=10min` |
| C-7 | unit 交代の永続性 | `systemctl --user is-enabled ai-helpdesk-prod-api` と `systemctl --user is-enabled ai-helpdesk-api 2>/dev/null \|\| true` | 前者 `enabled`、後者 `masked`（mask 不能で unit を退避した場合は `not-found`。§4-8 の分岐参照）。`ss -ltnp \| grep ':18950'` の PID が新 unit の MainPID のみ |

C-3 の具体コマンド（**18949 proxy 経由**。secret/JWT/email は argv に載せず curl config ファイルで渡す。M-b）:

```bash
set -euo pipefail
read -rsp 'CF_Authorization (JWT): ' CF_JWT; echo
read -rp  'Access authenticated email: ' ACCESS_EMAIL
umask 077
CFG=$(mktemp)
printf 'header = "Cf-Access-Jwt-Assertion: %s"\nheader = "Cf-Access-Authenticated-User-Email: %s"\n' \
  "$CF_JWT" "$ACCESS_EMAIL" > "$CFG"
chmod 600 "$CFG"
for p in / /index.html /api/state; do
  curl --config "$CFG" -sS --noproxy '*' -o /dev/null -w "$p %{http_code}\n" \
    "http://127.0.0.1:18949$p"
done
rm -f "$CFG"
unset CF_JWT ACCESS_EMAIL
```

期待: ` 200` / `/index.html 200` / `/api/state 200`。メールは PII のため証跡に残さない。ブラウザでは SPA の view（`h.dash` / `h.queue` / `h.approve`）が描画されることを人が確認し、§6 に「どの 3 画面を確認したか」を記録する（この build は URL で画面を分けないため）。

代替（直接 18950 を叩く場合）: `X-Proxy-Secret` を同じ curl config ファイルに `header = "X-Proxy-Secret: ..."` として入れれば 200 になる。ただし本番経路は 18949 proxy なので、受入は 18949 を正とする。

C-4 の具体コマンド（**本番 DB への read-only 接続を伴うため承認要**。`default_transaction_read_only=on` を強制し、書き込みはしない）:

```bash
cd /home/kensan/Projects/Mirai-Admin-Platform/AI-HelpDesk-Platform
node scripts/run-with-env-file.mjs "$HOME/.config/ai-helpdesk/api.conf" -- \
  ./node_modules/.bin/tsx scripts/audit-find-breaks.ts > /tmp/prod-audit-after-C.json
node -e 'const j=require("/tmp/prod-audit-after-C.json");console.log(JSON.stringify({db:j.database,readOnly:j.readOnly,checked:j.checked,mismatchCount:j.mismatchCount,ids:j.mismatches.map(m=>m.id),kinds:[...new Set(j.mismatches.map(m=>m.kind))]}))'
```

期待: `database` が本番 DB（`5435` 系 / `ai_helpdesk_preview`）、`readOnly:true`、`mismatchCount:2`、`ids:[10010,10013]`、`kinds:["hash_mismatch"]`。`mismatches[].kind` に `prev_hash_mismatch` が 1 件でも出たら**不合格**（鎖の欠損・分岐であり、既知破断では吸収しない）。deploy 前後で不変であることを機械比較する:

```bash
node -e '
  const a = require("/tmp/prod-audit-before-C.json");
  const b = require("/tmp/prod-audit-after-C.json");
  const sig = (j) => JSON.stringify({ n: j.mismatchCount, ids: j.mismatches.map(m => m.id) });
  if (sig(a) !== sig(b)) { console.error("既知破断が変化: " + sig(a) + " -> " + sig(b)); process.exit(1); }
  console.log("C-4 OK: 既知破断が不変（checked " + a.checked + " -> " + b.checked + "）");
'
```

**注意:** 本番の通常利用で `audit_log` が増えると `checked` が動く。`ids` に新しい破断が加わっていなければ C-4 は合格（増加自体は不合格理由にしない）。

C-6 の具体コマンド（**切替から 10 分経過後に実行**。前後を同じ長さの窓で比較する。`T0` は §4-8 で保存）:

```bash
set -euo pipefail
T0=$(cat /tmp/cutover-t0)
[ "$(date +%s)" -ge "$(date -d "$T0 +10 min" +%s)" ] || { echo '切替から10分経過後に実行する'; exit 1; }
B_START=$(date -d "$T0 -10 min" -Is); A_END=$(date -d "$T0 +10 min" -Is)

count() { journalctl --user -u "$1" --since "$2" --until "$3" --no-pager -o cat | grep -cE "$4" || true; }
# (a) 同一経路（cloudflared / proxy）の失敗。ユニットは切替前後で同じ
for u in ai-helpdesk-cloudflared ai-helpdesk-proxy; do
  echo "$u route-fail before=$(count "$u" "$B_START" "$T0" 'ERR Request failed|\[proxy\] upstream error') after=$(count "$u" "$T0" "$A_END" 'ERR Request failed|\[proxy\] upstream error')"
done
# (b) API の 5xx 率（旧 unit の直前 10 分 vs 新 unit の直後 10 分。分母も取る）
for u in ai-helpdesk-api ai-helpdesk-prod-api; do
  n5=$(count "$u" "$B_START" "$T0" '"statusCode":5')
  na=$(count "$u" "$B_START" "$T0" '"msg":"request completed"')
  echo "$u 5xx=$n5 completed=$na"
done
n5=$(count ai-helpdesk-prod-api "$T0" "$A_END" '"statusCode":5')
na=$(count ai-helpdesk-prod-api "$T0" "$A_END" '"msg":"request completed"')
echo "new 5xx=$n5 completed=$na"
# (c) tunnel-watch（oneshot。ok はその回の出力。恒常状態ではない）
systemctl --user start ai-helpdesk-tunnel-watch.service
journalctl --user -u ai-helpdesk-tunnel-watch --since '-2min' --no-pager -o cat | tail -1
systemctl --user list-timers ai-helpdesk-tunnel-watch.timer --no-pager | head -3
```

期待:
- 経路失敗（cloudflared / proxy）が **after=0**、または after ≤ before。
- 新 unit の `5xx` が **0**（before に 5xx があった場合は率 `5xx/completed` で after ≤ before）。分母 `completed` が 1 以上あること（0 件なら「信号なし」として未合格）。
- tunnel-watch の最終行が `tunnel-watch: ok (failures=<n> window=10min)` で `n < 3`（閾値未満）。**`ok` は「その回の判定」であり「恒常的に正常」ではない**ため、経路失敗と 5xx 率に併記して初めて C-6 の証拠になる。

### 4-10. rollback（H-6）

#### 判定表（§4-6 の `RC` と state）

| 状態 | 意味 | 対応 |
|---|---|---|
| `RC=0` | success | §4-7〜§4-9 へ |
| `RC≠0` かつ `result=rolled-back` | health 失敗 → `previous` に自動で戻った（再配備時） | `current` は previous。`systemctl --user restart ai-helpdesk-prod-api` して health を確認。旧 unit は masked/停止のまま |
| `RC≠0` かつ `result=rollback-failed` | health 失敗 → previous へ戻したが previous も health 不通過 | **R-C3**（旧 unit へ戻す）を検討。`current` は previous。手動調査 |
| `RC≠0` かつ `result=restart-failed`（previous あり） | restart 失敗 → **#146 により `current` は自動で `previous` へ戻る** | `current` を確認し `systemctl --user restart ai-helpdesk-prod-api`。health が通らなければ R-C3 |
| `RC≠0` かつ `result=restart-failed`（previous なし / bootstrap） | restart 失敗。戻す先が無いので `current` は新 release のまま | **R-C1** |
| `RC≠0` かつ `result=failed-no-previous` | 初回で health 失敗。`current` は新 release のまま | **R-C1** |
| `RC≠0` かつ state が無い | build / 入力検証で停止（switch 前）。`current` は変わっていない | 原因を直して再実行（rollback 不要） |

#### R-C1. bootstrap の rollback（previous が無い初回）

`current` を**削除**して旧 checkout 稼働に戻す。これを残すと次回 deploy の `PREVIOUS` が「失敗した新 release」になり、自動 rollback の基準が壊れる。

```bash
systemctl --user stop ai-helpdesk-prod-api || true
rm -f /home/kensan/ai-helpdesk-prod/current
# 初回の precheck 残骸を必ず除去（次回 deploy が 18953 に誤バインドしないため）
rm -f "$HOME/.config/systemd/user/ai-helpdesk-prod-api.service.d/precheck-port.conf"
rm -f /home/kensan/ai-helpdesk-prod/state/precheck.env
systemctl --user daemon-reload
systemctl --user unmask ai-helpdesk-api || true
# mask が unit ファイルを置換していた場合に備え、退避から戻す
if [ ! -f "$HOME/.config/systemd/user/ai-helpdesk-api.service" ] && \
   [ -f /home/kensan/ai-helpdesk-prod/state/ai-helpdesk-api.service.bak ]; then
  install -m 600 /home/kensan/ai-helpdesk-prod/state/ai-helpdesk-api.service.bak \
    "$HOME/.config/systemd/user/ai-helpdesk-api.service"
  systemctl --user daemon-reload
fi
systemctl --user start ai-helpdesk-api
curl -sS --noproxy '*' http://127.0.0.1:18950/api/health   # 期待: a5e0a67…（旧 checkout）
```

（`current` は symlink なので `rm -f` で消える。release ディレクトリは証跡として残す。）

**再試行しない場合の後始末（L-d）**: `current` が無いのに `ai-helpdesk-prod-api.service` が残ると、将来 `enable` した時に `WorkingDirectory`/`EnvironmentFile` 不在で起動失敗する。再試行しないなら次を実行する。

```bash
rm -f "$HOME/.config/systemd/user/ai-helpdesk-prod-api.service"
rm -f "$HOME/.config/systemd/user/ai-helpdesk-prod-api.service.d/precheck-port.conf"
rm -f /home/kensan/ai-helpdesk-prod/state/precheck.env
systemctl --user daemon-reload
systemctl --user is-enabled ai-helpdesk-prod-api 2>/dev/null || true   # enabled でないこと
```

unit を残して再試行する場合は **enable しない**（`current` ができるまで起動しない）。

#### R-C2. 通常の rollback（`previous` がある）

**旧 unit を start するだけでは不十分**。`current` が新 release を指したままだと、次回 deploy の `PREVIOUS` が「戻っていない新 release」になり、`deploy-release.sh` の自動 rollback が誤った基準へ戻す。必ず **symlink + restart** で戻す（docs/77 §4-4）。

```bash
set -euo pipefail
ROOT=/home/kensan/ai-helpdesk-prod
# §4-6 の preflight で保存した「切替前の current」を使う（state の previous は 1 世代前を指すため使わない）
PREV=$(cat "$ROOT/state/rollback-target.txt")
[ -d "$PREV" ] || { echo 'rollback-target が release でない: 手動調査'; exit 1; }
PREV_REF=$(node -p 'require(process.argv[1]+"/dist-manifest.json").commit' "$PREV")
ln -sfn "$PREV" "$ROOT/.current.new"
mv -Tf "$ROOT/.current.new" "$ROOT/current"
systemctl --user restart ai-helpdesk-prod-api
curl -sS --noproxy '*' http://127.0.0.1:18950/api/health
# 期待: commit == $PREV_REF
```

#### R-C3. 旧 unit へ戻す最終手段

`current` の整合を取ったうえで行う。**順序を守る**。

```bash
systemctl --user stop ai-helpdesk-prod-api
systemctl --user unmask ai-helpdesk-api || true
if [ ! -f "$HOME/.config/systemd/user/ai-helpdesk-api.service" ] && \
   [ -f /home/kensan/ai-helpdesk-prod/state/ai-helpdesk-api.service.bak ]; then
  install -m 600 /home/kensan/ai-helpdesk-prod/state/ai-helpdesk-api.service.bak \
    "$HOME/.config/systemd/user/ai-helpdesk-api.service"
  systemctl --user daemon-reload
fi
systemctl --user start ai-helpdesk-api
rm -f /home/kensan/ai-helpdesk-prod/current     # 旧 checkout 稼働時は current を残さない
curl -sS --noproxy '*' http://127.0.0.1:18950/api/health
```

`current` を残すと次回 deploy の `PREVIOUS` が壊れる（H-6）。`rm` の前に `readlink -f` で対象を確認する。

### 4-11. 事後（別承認でよい）

- `api.conf` の `COMMIT_SHA` 行の**削除**（書換ではない）。削除後も health の `commit` が `release.env` 由来で一致することを確認する。削除後は last-resort で旧 unit に戻した時の `commit` が空になるため、旧 unit を戻す可能性を残す間は削除を保留してよい（削除は値の書換ではないが、自己申告源を消す恒久対策）。
- `ops/systemd/ai-helpdesk-proxy.service` の `Wants=` / `After=` を `ai-helpdesk-prod-api` に変更（H-1 の恒久対策）。変更 → 再レンダリング → `daemon-reload` → 保守ウィンドウで proxy restart。
- 初回の dry-run release（`20261106T071603-e7d7f6f9dc94`）と precheck 用の残骸（`state/precheck.env`）の削除。**release は read-only のため `chmod -R u+w` してから、対象パスを `realpath` で確認して削除**する。
- `docs/77` §3-5 / §4-6 を実装に合わせて更新（5440→5437、`deploy-release.sh` のガード追加）。**本稿では docs/77 を変更していない。**

## 5. 事前に実施できる検証（承認不要）と、その限界（M-3 / L-5）

1. **`--dry-run` の意味を誤解しない。** `--dry-run` は build と manifest 検証だけを行い、`current` を作らず、`systemctl` を呼ばず、health も見ない（`deploy-release.sh` の `if [ "$DRY_RUN" = 1 ]` 分岐）。したがって **`--unit ai-helpdesk-prod-api` が存在しないことを検出できない**。07:16 の dry-run が「成功」していることは、C の実行可能性の証拠では**ない**（M-3）。
2. **`--dry-run` の繰り返しは release を増やす。** `RELEASE_ID` は実行時刻を含むため、同じ ref でも別 release になる。`prune_releases` は success 時のみ呼ばれるので、dry-run だけでは溜まる（L-5）。事前検証は**同じ ref で 1 回**に留め、実行後に件数を確認する: `ls -1 /home/kensan/ai-helpdesk-prod/releases | wc -l`。
3. **build の予行は scratch root で行える（prod root を汚さない）**:
   ```bash
   MAIN=/home/kensan/Projects/Mirai-Admin-Platform/AI-HelpDesk-Platform
   DEPLOY_REF=$(git -C "$MAIN" rev-parse origin/main)
   SCRATCH=/home/kensan/ai-helpdesk-prod-buildcheck
   NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost \
     scripts/deploy-release.sh --repo "$MAIN" --ref "$DEPLOY_REF" --root "$SCRATCH" \
     --env-file "$HOME/.config/ai-helpdesk/api.conf" --unit ai-helpdesk-prod-api \
     --health-port 18953 --dry-run
   # 所要時間を記録（初回の停止見込みの根拠）。終了後:
   [ "$(realpath "$SCRATCH")" = /home/kensan/ai-helpdesk-prod-buildcheck ] || exit 1
   chmod -R u+w "$SCRATCH" && rm -rf "$SCRATCH"
   ```
   `--dry-run` は unit を起動しないため、unit が無くても成功する（= C の実行可能性は検証しない）。
4. **当日の rollback 訓練は本番で行わない。** §2-4 の staging 往復で代替する。

## 6. 実行記録（承認後に追記。現時点は空）

| 日時 | 区分 | 実行者 | 承認者 | 対象 ref / release | 結果 | 証跡 |
|---|---|---|---|---|---|---|
| — | — | — | — | — | 未実行 | — |

## 7. 参照

- `docs/77-staging-environment-design.md` §4（配備フロー・§4-3 同梱要件・§4-4 rollback・§4-6 契約）、§6（tunnel/DNS/Access）
- `docs/81-staging-acceptance-evidence.md` §5（staging DB）、§6（本番不変の基準値）、§10（復元 DB の監査鎖）
- `scripts/deploy-release.sh`（build / switch / health / record / prune）
- `scripts/audit-find-breaks.ts`（監査鎖の破断検出。read-only）
- `scripts/tunnel-watch.mjs`（oneshot。`ok` はその回の判定）
- `ops/systemd/ai-helpdesk-stg-api.service`、`ops/systemd/ai-helpdesk-proxy.service`、`ops/systemd/ai-helpdesk-prod-api.service`（#146 のテンプレート）
- `docs/evidence/review-20261106/pr142-review.md`（v1）、`pr142-rereview2.md`（v3 の対象再レビュー）

## 8. 改訂で解消した指摘 / 未解消の指摘

### 8-1. 解消した指摘

| 指摘 ID | 対応箇所 | 対応内容 |
|---|---|---|
| C-1 | §4-3〜§4-8 | `--dry-run` を外した実配備を明記。`current` の生成・unit restart・health の commit 一致までを 1 本の流れにし、初回は precheck port 18953 で build 中も本番を止めない。停止は 18950 切替の数秒 |
| C-2 | §4-4 / §4-7 | main のテンプレートを正本とし、`--unit-template` で配置。`EnvironmentFile=api.conf` の**後**に `current/release.env`。`api.conf` の `COMMIT_SHA` 書換は禁止。health・`current`・`release.env`・cwd の 4 点で出自を確認 |
| H-1 | §4-8 / §4-10 R-C3 | 旧 unit の stop → disable → **mask**、新 unit の enable を明記。proxy の `Wants=ai-helpdesk-api` による引き上げリスクと、恒久対策（proxy unit の変更）を明記 |
| H-2 | §4-9 C-3/C-4/C-6 | C-3 は 18949 proxy 経由の 3 URL と期待 status（直叩きの `PROXY_REQUIRED` を回避）、C-4 は `audit-find-breaks.ts` の基準（2 件・id 10010/10013・`kind=prev_hash_mismatch` 0）、C-6 は同一時間窓の経路失敗 + 5xx 率 + tunnel-watch |
| H-3 | §3-2〜§3-6 | 事前確認、config heredoc、`chmod 600`、`ingress validate`、`daemon-reload` / `enable --now`、禁止事項、資格情報 JSON の 0600、rollback の資格情報削除まで復元 |
| H-4 | §3-3 B-3/B-4 | Access アプリ作成 → AUD 取得 → `ACCESS_AUD` / `ACCESS_TEAM_DOMAIN` を設定 → enforce → 最後に DNS/unit の順序に修正。「先に enforce」の矛盾を解消 |
| H-5 | §1-4 / §4-1 | docs/77 §4-6 と実装の乖離を表にし、「C は実装に従い、設計の意図は手動 preflight で代替」と決定。1/2/4/8 のガード未実装を残課題として明記 |
| H-6 | §4-10 R-C1/R-C2/R-C3 | rollback を symlink + restart に統一。旧 unit 起動だけでは `PREVIOUS` が壊れることを明記。bootstrap は `current` 削除。#146 の `restart-failed` / `rollback-failed` を判定表に追加 |
| M-1 | §1-1 / §1-2 | 全行に測定時刻と再取得コマンド。staging を `4465f8d` / release `083747` / 18951=200 に更新 |
| M-2 | §2-2 A-1 / A-4 | unit は `ops/systemd` テンプレートの再レンダリングで更新。`enable` も実施 |
| M-3 | §5-1 / §5-3 | `--dry-run` が unit 不在を検出できないこと、07:16 の成功が C の実行可能性の証拠でないことを明記 |
| M-4 | §4-3 / §4-6 | `--health-port` が稼働中の旧プロセスを読む問題を明記し、precheck port で回避。二重流儀を避けて `deploy-release.sh` に一本化 |
| M-5 | §0 表 / §4-0 | C の影響を「中」に修正。DB schema 不変は `git diff -- db/` で確認。unit 状態が変わることを明記 |
| M-6 | §3-6 | `tunnel cleanup` → `tunnel delete` → 資格情報削除まで規定 |
| M-7 | §3-4 B-5 | DSN の向き先・`current_database()` / `inet_server_port()` の構造的根拠 + 本番 audit の `checked` / `mismatchCount` 前後比較 |
| L-1 | §4-1 / 各所 | `--ref` は 40 hex 固定であることを明記（正規表現で検査） |
| L-2 | §3-2 | `cloudflared tunnel login`（`cert.pem`）の前提を明記 |
| L-3 | §4-4 | 同梱要件の参照先を docs/77 §4-3 に修正 |
| L-4 | §2-3 A-5 | docs/81 §6-1 の基準値を引用し、before/after の一致で判定 |
| L-5 | §5-2 | dry-run の繰返しで release が増えること、prune が成功時のみであることを明記 |
| L-6 | §2-3 A-4 | `PROXY_REQUIRED` と `UNAUTHORIZED` を body の code で区別 |

### 8-2. 未解消の指摘（残課題）

| 指摘 ID | 残っている内容 | 理由 / 次の action |
|---|---|---|
| H-5（一部） | `deploy-release.sh` に docs/77 §4-6 のガード（本番 path / unit 名 / port / main 祖先）が**実装されていない** | 本稿は手動 preflight で代替。実装ガードは `deploy-release.sh` を変更する別 PR が必要（本 PR は docs/82 のみ） |
| H-1（一部） | `ai-helpdesk-proxy.service` の `Wants=ai-helpdesk-api` が残る | 本稿は旧 unit の `mask` で暫定回避。恒久対策は proxy unit の変更（別 PR・保守ウィンドウ）。`mask` 中は旧 unit への復帰に `unmask` が必要 |
| レビュー §7-12 | staging の `approved.json` が本番と同一（固有アドレス重複 0 件） | 本 PR の対象外。staging 用の合成 manifest の検討は別課題 |
| docs/77 の更新 | §3-5 の DB port（5440→5437）、§4-6 の契約と実装の乖離 | 本稿は docs/77 を変更しない。設計文書の更新は別 PR |

### 8-3. 再レビュー2（GO-WITH-LIMITS）対応

| 指摘 ID | 対応箇所 | 対応内容 |
|---|---|---|
| High-1 | §2-2 / §2-3 A-3 | `STG_REF` を `git rev-parse origin/main` に変更。`#144` 以降を検査。`current` の commit と一致する場合は deploy を skip（ダウングレード・mode 不整合を回避） |
| High-2 | §4-9 C-3 | **18949 proxy 経由**に変更（proxy が `X-Proxy-Secret` を付与）。直接叩く場合の `X-Proxy-Secret` 代替も明記。期待 200 |
| High-3 | §4-4 / §1-3 / §8-2 | main のテンプレート（#146）を正本とし、全文をテンプレートと一致（`on-failure`/`3`）。`--unit-template` と「main に存在」を明記。`always` の根拠はテンプレート変更の別 PR に分離 |
| High-4 | §4-10 | `restart-failed`（previous あり→current は自動で previous）と `rollback-failed` を判定表に追加。旧実装の行番号前提の記述を削除 |
| M-a | §1-1 / §1-3 / §2-1 / §2-3 | main `4465f8d` / staging `4465f8d` / release `20261106T083747-4465f8d8905c` / 18951=200 に更新。A-3 の PREVIOUS は実行時取得に変更 |
| M-b | §2-3 A-4 / §3-3 B-3/B-4 / §4-9 C-3 | secret/JWT/email を curl config ファイル（0600）で渡し、argv に載せない。JWT は stdin で node に渡す |
| M-c | §4-9 C-6 | 切替時刻 `T0` を保存し、同一長の前後 10 分窓で「cloudflared/proxy の経路失敗」と「API 5xx 率（分母付き）」を比較。10 分経過を必須化 |
| M-d | §0 表 | B の承認欄に「B-5 の本番 DB read-only 接続」を追加 |
| M-e | §4-8 | `mask` は依存記述を変えないため proxy に failed dependency が残ること、unit 再レンダリングでは解除されないことを明記 |
| L-a | §1-4 / §4-10 / §5 | 行番号引用を関数名・メッセージ文字列（`DRY_RUN` 分岐、`restart failed for`、`prune_releases`）に変更 |
| L-b | §4-9 C-4 | `prev_hash_mismatch` は `mismatches[].kind` の値であると明記 |
| L-c | §1-3 | #146 `e35f4cb` / #147 `4465f8d` を追加し、テンプレートを「未追加（予定）」から「main に存在」へ修正 |
| L-d | §4-10 R-C1 | 再試行しない場合の unit / drop-in / precheck の後始末と、`enable` しないことを追加 |
