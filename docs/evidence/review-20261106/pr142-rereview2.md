# PR #142 改訂版 v2 再レビュー（Step3b / 2 回目）

- 実施: 2026-11-06 08:29〜08:45 JST
- 対象: PR #142 head **`542f95f`**（`1019e1e` → `8ba0e84` → `6d16be4` → `542f95f`）/ `docs/82-promotion-runbook-20261106.md` **993 行**（+993/-0、変更は docs/82 のみ）
- 本文 anchor: `sha256=1d9ca685481eedd7449a877b5fbd3cdcdb83347121e797c8243d9af2c02d36f8`
- 参照実装: **`origin/main` = `4465f8d`**（#143 `65caaa2` / #145 `711320b` / #144 `46261ea` / **#146 `e35f4cb`** / #147 `4465f8d`）
- 前回: `pr142-review.md`（NO-GO）→ `pr142-rereview.md`（未更新のため再レビュー不能）→ 本 doc
- 制約: read-only（ファイル変更は当該 evidence のみ、git は show/log/ls-tree 等の読取のみ、Secret 非出力）。`systemctl` は **read-only の `show`/`is-enabled`/`is-active`/`list-timers` のみ**使用し、start/stop/restart/enable/disable/mask は実行していない。

## 0. 判定

**GO-WITH-LIMITS（条件付き）**

- v1 の Critical 2 件（C-1 / C-2）は**実質的に解消**。C は「build → `current` 生成 → restart → health の commit 一致 → 18950 切替 → unit 交代 → rollback」まで 1 本の流れになり、**前回の「実行すると本番が落ちる」欠陥は解消**した。受入もコマンド＋期待値になり、自己申告値は明示的に禁止されている。
- ただし **High 4 件**が残る。いずれも小さな修正で閉じられるが、**未修正のまま実行すると A は必ず失敗し、C-3 は合格不能**になる。
- したがって: **「マージしてよいが、実行前に High-1〜High-4 を同一 PR で修正する」**のが条件。チームが「マージ＝実行可能」を求めるなら **NO-GO**（High-1 により A-3 が確定的に失敗するため）。

| 観点 | 結果 |
|---|---|
| 手順の再現性（コマンドがそのまま動くか） | △ A-3 が失敗（High-1）。他は概ね実行可能 |
| 受入条件の観測性（自己申告でないか） | ○ C-1/C-4/C-6/C-7 は観測可能。**C-3 のみ 401 で合格不能**（High-2） |
| rollback が戻せるか | ○ 手順は symlink + restart に統一され妥当（R-C1/C2/C3）。ただし実装挙動の記述が誤り（High-4） |
| 本番影響の記述 | ○ 停止位置・precheck port の設計は妥当。DB 不変の確認も明記 |
| 秘密の扱い | △ 値の直書きは無いが、秘密が argv に載る（M-b） |
| 未マージ依存 | 依存なし。ただし **#146 は既にマージ済み**で、runbook がその実装と乖離（High-3） |

---

## 1. Lead 提示値の検証（事実訂正を含む）

| 提示 | 実測 | 一致 |
|---|---|---|
| head が `542f95f` に更新 | `542f95ffe3b2b93187e2a9647406068075342e60`（remote tip 一致、commit 4 件、updatedAt 23:36:06Z） | ○ |
| 変更は docs/82 のみ | `changedFiles=1` / `files=[docs/82-promotion-runbook-20261106.md]` / +993-0 | ○ |
| 主改訂 `8ba0e84` / 記録修正 `6d16be4` / preflight 修正 `542f95f` | 3 commit すべて存在（22:34:52Z / 22:35:30Z / 22:36:03Z） | ○ |
| **#146 `--unit-template` は未マージ** | **誤り。`e35f4cb`（2026-11-06 08:36:47 JST）で main にマージ済み。**`--unit-template` と `ops/systemd/ai-helpdesk-prod-api.service` が main に存在 | ✗ **訂正** |
| #143/#144/#145 マージ済み | すべて main（`65caaa2`/`46261ea`/`711320b`） | ○ |
| Staging は `46261ea` | **既に前進**: health `commit=4465f8d8905c4f651df1e5f3f607d7b939b40280` / `current → releases/20261106T083747-4465f8d8905c` / 18951=**200** | 前進 |
| 本番 未変更 | MainPID `2379216` / NRestarts `0` / InvocationID `4f8d29d238904882a9dd8c6bab20939a` / commit `a5e0a67…` / `current` ABSENT / prod unit ABSENT | ○ |

**時刻関係（重要）**: runbook の最終 commit は `542f95f` 08:36:03、#146 のマージは 08:36:47。**44 秒差**であり、著者が #146 を参照できなかったこと自体は責められない。ただし本 PR は未マージで、**マージ時点の main は #146 を含む**ため、runbook は「マージ直後から実装と食い違う文書」になる。これが High-3/High-4 の本質。

---

## 2. 前回 §5 チェックリストの PASS/FAIL

### 1. C の実配備 step（dry-run でない実行・`current` 生成）— **PASS**
`§4-6` が `--dry-run` なしで `deploy-release.sh` を実行し、`RC` を捕捉して §4-7 で 4 点確認、§4-8 で 18950 切替という流れになっている。`deploy-release.sh`（`4465f8d`）の実挙動と一致:
- dry-run は `L215 if [ "$DRY_RUN" = 1 ]` で `switch_to` を呼ばず exit（runbook の「dry-run は current を作らない」は正しい）
- 非 dry-run は `L239 switch_to` → `L241 restart` → health 待ち（45 秒）
- `--ref "$DEPLOY_REF"`（`origin/main` を実行時取得）なので #144/#146 を含む ref が使われる

### 2. 新 unit の全文・`COMMIT_SHA` の供給元 — **FAIL（High-3）**
内容面では要求を満たす: `EnvironmentFile=%h/.config/ai-helpdesk/api.conf` の**後**に `EnvironmentFile=<root>/current/release.env`、`ExecStart=<node> <root>/current/apps/api/dist/index.js`、`WorkingDirectory=<root>/current`。§4-4 は「`api.conf` の `COMMIT_SHA` を書き換えない（自己申告禁止）」と明記し、§4-11 で「削除は別承認」と分離している。これは妥当。

しかし **main にマージされた `ops/systemd/ai-helpdesk-prod-api.service` と一致しない**:

| 項目 | runbook §4-4 | main のテンプレート（#146） |
|---|---|---|
| `Restart=` | `always` | **`on-failure`** |
| `RestartSec=` | `2` | **`3`** |
| コメント行 | 1 行 | 2 行（「config の自己申告値ではなく…」） |
| それ以外 | 一致 | 一致 |

runbook は「テンプレートが追加済みなら **diff して差異が無いことを確認してから使う**」と指示しているため、**この diff は必ず差が出て停止する**（＝安全側だが、手順は前進しない）。runbook は `--unit-template` の存在に触れておらず、`Restart=always` の根拠（旧 unit の drop-in を引き継ぐ）も、テンプレートが `on-failure` を選んだ理由との突合がされていない。

### 3. unit 交代（disable/mask/enable）— **PASS**
§4-8 が `stop ai-helpdesk-api` → `disable` → `mask` → `enable ai-helpdesk-prod-api` を明記。C-7 で `is-enabled` の期待値（新 `enabled` / 旧 `masked`）を固定。再起動後の挙動としても妥当（旧 unit は masked のため default.target から起動せず、proxy の `Wants=` も引き上げに失敗するだけ）。
mask の意味も正しく書かれている: **依存関係の記述は変えない**ため `systemctl status ai-helpdesk-proxy` には failed dependency が残り、恒久対策は proxy unit の `Wants=`/`After=` 変更（別 PR・保守ウィンドウ）であると §4-8 と §8-2 の両方に「未実施」と明記。**この点は要求どおり。**

### 4. rollback が symlink を戻すか — **PASS（手順）/ FAIL（実装挙動の記述 = High-4）**
手順は `current` を差し替える方式に統一され、旧 unit を start するだけの rollback を明示的に否定している（R-C2 の注意書き）。R-C1 は bootstrap で `current` を削除、R-C3 は最終手段として `unmask` → `start` → `current` 削除（順序明記）。妥当。

一方 **§4-10 の判定表 4 行目「`deploy-release.sh` L219-221 は symlink を戻さない」は main で誤り**。#146 により restart 失敗時も rollback する:
```
origin/main:scripts/deploy-release.sh
L241-243  if ! systemctl --user restart "$UNIT"; then
L244        printf 'ERROR: restart failed for %s; rolling back current\n' ...
L245-248    if [ -n "$PREVIOUS" ] && [ -d "$PREVIOUS" ]; then switch_to "$PREVIOUS"; restart; fi
L250      record_deploy 'restart-failed'
```
したがって (a) 再配備時の restart 失敗では `current` は PREVIOUS に戻る、(b) state の `result` は **`restart-failed`** になる。runbook の判定表は `rolled-back` / `failed-no-previous` / 「state が更新されていない」の 3 分岐しか持たず、**`restart-failed` は未定義**。演算子は表に無い状態を現場で解釈することになる（bootstrap では `PREVIOUS` 空のため戻らず、表の記述どおり R-C1 で正しい）。

### 5. 受入条件の観測性 — **PASS 4 / FAIL 1（High-2）**
- **C-1 PASS**: health の commit 単独で合格にせず、`current` の実体・`release.env` の `COMMIT_SHA`・`MainPID` の cwd と cmdline の 4 点を要求（§4-7）。**自己申告値に戻っていない**（Lead の追加確認 (4) は PASS）。
- **C-3 FAIL**: 下記 High-2。
- **C-4 PASS**: `audit-find-breaks.ts` を実行し `mismatchCount==2` / `ids=={10010,10013}` / `kinds==["hash_mismatch"]`、前後で機械比較。基準値は docs/81 §10 の実測と一致。
- **C-6 PASS（弱）**: tunnel-watch の読み方（oneshot の単回出力であり恒常状態ではない）を明記し、5xx と併記。ただし比較の妥当性は M-c。
- **C-7 PASS（新設）**: unit 交代の永続性を観測可能にした点は良い。

### 6. B の 5 項目 + AUD — **PASS**
事前確認（`cert.pem` / `tunnel list` / `dig` / 本番 config の sha256 / `df`）、config heredoc + `chmod 600` + `ingress validate`、Access アプリ作成 → AUD 取得 → `ACCESS_AUD` / `ACCESS_TEAM_DOMAIN` 反映 → `enforce` → 最後に DNS/unit、`daemon-reload` + `enable --now`、禁止事項、資格情報の 0600 と rollback 時の削除まで、**docs/77 §6-2 の要求を満たし H-3/H-4 は解消**。
実測裏付け: 本番 config の sha256 は **`d51927da44c6b778…`** で runbook の基準値 `d51927da…` と一致。公開 URL は **302 → Access**（B-2/C-2 の期待どおり）。AUD 反映は `grep -v` + 追記 + `install -m 600` で、秘密を表示しない。

### 7. 未マージ依存の明記 — **PASS（依存なし）/ ただし前提が変化**
runbook は `--unit-template` に依存していない（§4-4 で unit を自前設置）。したがって「未マージ PR に依存しているのに明記が無い」という問題は**発生しない**。ただし #146 は**既にマージ済み**で、依存の向きが逆（runbook が実装に追随していない = High-3/High-4）。

### 8. §1 / §6 の更新 — **PASS（形式）/ 値は既に陳腐化（M-a）**
§1-1 は全 18 行に測定時刻と再取得コマンドを付けており、要求（時刻＋再取得）は満たす。§6 は空のままで正しい（未実行）。
ただし測定時刻 08:17〜08:27 の値が既に実態と異なる: §1-1 #11/#13 は staging を `359cbd0` / `releases/20261106T063553-359cbd012274` とするが、実測は `4465f8d` / `20261106T083747-4465f8d8905c`。§1-1 #12「18951 は NOT listening」も現在は 200。**A-3 の「期待 PREVIOUS は 20261106T063553…」も不一致**。時刻付きなので虚偽ではないが、実行前確認（§1-2）を飛ばすと確実に混乱する。

---

## 3. High

### High-1. A-3 の `STG_REF=65caaa2…` は、#144 以降の `deploy-release.sh` では**確定的に失敗**する（かつ現在より古い）

- runbook §2-2 は `STG_REF=65caaa2f4c0532b7b5b33bd1f33afa04b541541f` を既定値として埋め込み、A-3 で `--ref "$STG_REF"` を渡す。コメントには「実行時に取り直して 40 hex を記録する」とあるが、**この値を `origin/main` と一致させる検査が無い**（`merge-base --is-ancestor` は「祖先である」ことしか見ないため、古い ref でも通過する）。
- 失敗の機序（コード上の確定）:
  1. `origin/main:scripts/deploy-release.sh` L128 `chmod -R a-w -- "$RELEASE_DIR"` → manifest は `0400` になる
  2. L130-131 が **release 内の**（＝ビルド対象 ref の）`scripts/dist-manifest.mjs --verify` を実行
  3. `65caaa2:scripts/lib/dist-manifest.mjs` L266 は `(metadata.mode & 0o777) !== 0o600` で `DIST_MANIFEST_MODE_INVALID`
  → `set -euo pipefail` により build_release が失敗し、**switch 前に中止**（fail-closed。本番・staging の稼働状態は壊れない）
- #144（`46261ea`）がこの不整合を修正しており（mode を「owner 可読・group/other 不可」へ緩和、0400/0500 を許可）、`65caaa2` は**その修正より前**の ref。runbook 自身が §1-3 で「#144 は A/C の build 前提」と書いているのに、`STG_REF` は #144 より古い。
- 併せて、staging は既に `4465f8d` で稼働中（実測）。`65caaa2` を配備すると**ダウングレード**になる。
- 影響: 「承認不要で先に実行できる」はずの A が実行不能。被害は出ないが、runbook の入口が機能しない。
- 修正: `STG_REF=$(git -C "$MAIN" rev-parse origin/main)` にして、`STG_REF == origin/main` を検査する。

### High-2. C-3 の受入コマンドは `401 PROXY_REQUIRED` になり、200 を観測できない

- §4-9 C-3 は `http://127.0.0.1:18950/`・`/index.html`・`/api/state` に `Cf-Access-Jwt-Assertion` と `Cf-Access-Authenticated-User-Email` を付けて **200** を期待する。しかし `X-Proxy-Secret` を付けていない。
- 実装: `apps/api/src/server.ts` L107-127 が `REQUIRE_PROXY_SECRET` のとき `/api/health`・`/api/device/agent`・`/api/device/command`・RSP 連携以外に proxy secret を要求し、無ければ `ApiError(401, 'PROXY_REQUIRED')`。本番 `api.conf` は `REQUIRE_PROXY_SECRET=true`（実測）。`/index.html`(`apps/api/src/routes/prototype.ts` L344) と `/api/state`(L354) は除外対象外。
- **実測（read-only）**: `18950` の `/`・`/index.html`・`/api/state` はいずれも **HTTP 401**、body は `{"error":{"code":"PROXY_REQUIRED",...}}`。
- したがって C-3 は、新 unit でも同じ api.conf を使うため **必ず 401**。演算子は「C-3 不合格」と判断するか、最悪 `REQUIRE_PROXY_SECRET` を触って「直す」方向に動き得る（これは危険）。
- 修正: 18949（proxy）経由で叩く、または `-H "X-Proxy-Secret: $PS"` を付ける（A-4 では既にそうしている）。
- 参考: `PROXY_REQUIRED` と `UNAUTHORIZED` の 2 コードは実在（`server.ts` L126 / `apps/api/src/errors.ts` L18）し、A-4 の期待は正しい。`requireCloudflareAccess`（`apps/api/src/auth/ui.ts` L79-92）は email ヘッダー欠落で `UNAUTHORIZED` を返すため、A-4 の 2 本目も成立する。

### High-3. §4-4 の unit 全文が main のテンプレートと不一致（#146 マージ済み）

§2 の表のとおり `Restart=always` / `RestartSec=2` 対 `on-failure` / `3`。runbook 自身の「diff して差異が無いことを確認」で停止する。`--unit-template` の存在にも言及が無く、`ops/systemd/ai-helpdesk-prod-api.service` を「未追加（予定）」と書いている（§1-3 / §4-4 / §8-2）が、**既に追加済み**。
- 修正方針の候補: (a) テンプレートに合わせる（`on-failure`/`3`）、(b) runbook の意図をテンプレート側へ反映する（別 PR）、(c) 少なくとも `--unit-template ops/systemd/ai-helpdesk-prod-api.service` を使う形へ寄せる。いずれの場合も「どちらが正本か」を 1 行で明記する必要がある。

### High-4. §4-10 の `deploy-release.sh` 挙動記述が誤り（`restart-failed` が判定表に無い）

§2-4 のとおり。runbook の記述は v1 時点（`1019e1e` が参照した 08:18 の main=`65caaa2`）では正しかったが、#146 で rollback が強化された。bootstrap の結論（R-C1）は正しいが、**再配備時の restart 失敗**では `current` は自動で戻り、state は `restart-failed` になる。判定表にその行を追加し、「`current` は previous を指している。health を確認し、必要なら R-C2」と書くべき。

---

## 4. Medium

### M-a. §1-1 の staging 値と A-3 の期待 PREVIOUS が既に実態と不一致
文書: `359cbd0` / `releases/20261106T063553…` / 18951 NOT listening。実測（08:42）: `4465f8d` / `releases/20261106T083747-4465f8d8905c` / 18951=200。A-3 の「`PREVIOUS` は `20261106T063553…`」も不一致。§1-2 の再取得を必須手順として明示するか、期待値を「実行時取得」に変えるべき。

### M-b. 秘密・PII が argv に載る（`/proc/<pid>/cmdline` から見える）
`curl -H "X-Proxy-Secret: $PS"`（A-4）、`-H "Authorization: Bearer $CF_API_TOKEN"`（B-3）、`-H "Cf-Access-Jwt-Assertion: $CF_JWT"` と `Cf-Access-Authenticated-User-Email: $ACCESS_EMAIL`（C-3 / B-4）は、展開後の値が**プロセスの引数**として `ps` / `/proc` に露出する。§0-1「標準出力・証跡・履歴に残さない」とは不整合。`curl -H @<(printf ...)`／`--config` でファイル渡しにするか、この露出を許容する旨を明記すべき。なお `read -rsp` の使い方自体は正しい。

### M-c. C-6 の 5xx 比較が「異なる unit × 異なる時間窓」の比較になっている
before は旧 unit（`ai-helpdesk-api`）の直近 10 分、after は新 unit（`ai-helpdesk-prod-api`）の直近 10 分。新 unit は起動直後でログが数分しかないため **after=0 がほぼ自明**に出る。signal として弱い。同一の経路（tunnel/proxy ログ）または同一時間帯の比較にすべき。

### M-d. B の承認単位が混在している
`§0` 表は B の承認を「Cloudflare アカウント変更」と定義するが、B-5 は**本番 DB への read-only 接続**（`audit-find-breaks.ts`）を含む。本文には「承認要」と注記があるが、§0 の承認欄と一致していない。承認を分けるか、§0 に追記すべき。

### M-e. `mask` の限界が「恒久対策は proxy 変更」以外に書かれていない
本文の説明は正しい（mask は起動を止めるが、依存記述は変わらない／復帰には `unmask` が必須）。加えて、mask 中は `systemctl status ai-helpdesk-proxy` に failed dependency が残り続けること、`mask` は unit ファイルの再設置（再レンダリング）で上書きされないこと（symlink のため）を 1 行足すと事故が減る。

---

## 5. Low

- **L-a**: `deploy-release.sh` の行番号引用が main でずれている。`L211-215`（dry-run）→ 実際 **L215**、`L219-221`（restart）→ 実際 **L241-252**、`L226`（prune）→ 実際 **L256**。L49/L50/L62-64/L70-72/L79-81 は ±1〜2 で概ね一致。行番号より**関数名・メッセージ文字列**で引く方が安定する。
- **L-b**: 「`prev_hash_mismatch` が出たら不合格」とあるが、これは top-level フィールドではなく `mismatches[].kind` の値（`scripts/audit-find-breaks.ts` L39/L99）。C-4 の `kinds` 出力でカバーされるが、文言は `kind=prev_hash_mismatch` と書くべき。
- **L-c**: §1-3「関連 PR」に #146/#147 が無い（既にマージ済み）。前提表が実装に追随していない。
- **L-d**: R-C1（bootstrap 失敗）は unit ファイルを残す。`current` 不在のまま `ai-helpdesk-prod-api.service` が存在する状態になるため、将来 `enable` されると起動失敗する。§4-11 の後始末に「失敗時は unit も削除」を加えるのが安全。

---

## 6. 前回指摘の解消状況（サマリ）

| 前回 | 判定 | 根拠 |
|---|---|---|
| C-1 実配備が無い | **解消** | §4-6 が非 dry-run、`current` 生成・restart・health 一致まで 1 本化 |
| C-2 COMMIT_SHA が自己申告 | **解消** | §4-4 後置 `release.env`、書換禁止、§4-7 の 4 点証拠 |
| H-1 unit 交代なし | **解消** | §4-8 stop→disable→mask→enable、C-7 で観測、恒久対策を未実施と明記 |
| H-2 C-3/C-4/C-6 観測不能 | **部分解消** | C-4/C-6 PASS、**C-3 は 401 で合格不能（High-2）** |
| H-3 B が docs/77 §6-2 より劣化 | **解消** | §3-2〜§3-6 が 5 項目＋秘密保護を満たす |
| H-4 AUD/team domain 無し | **解消** | §3-3 B-3/B-4、順序も fail-closed に修正 |
| H-5 設計と実装の乖離 | **解消（文書化）** | §1-4 で決定と残課題を明示。実装ガードは未追加と正しく記載 |
| H-6 rollback が symlink を戻さない | **手順は解消 / 記述は誤り** | R-C1/C2/C3 は妥当。§4-10 の実装説明が main と不一致（High-4） |
| M-1〜M-7 / L-1〜L-6 | 概ね解消 | 測定時刻・再取得コマンド・enable・dry-run の限界・precheck port・影響「中」・tunnel delete・DSN 構造・40hex・cert.pem・docs/77 §4-3・基準値・prune・2 コード区別 |
| L-7（§1 の release パス） | **未解消** | 依然 `063553`（M-a） |

---

## 7. 確認したが問題が無かった点（誤指摘の回避）

1. `PROXY_REQUIRED` / `UNAUTHORIZED` の 2 コードは実在（`server.ts` L126 / `errors.ts` L18 / `auth/ui.ts` L79-92）→ A-4 の期待は正しい。
2. `/api/state` は実在（`routes/prototype.ts` L354）。
3. `systemctl --user show -p EnvironmentFiles` は有効で、順序も `stg-api.conf → current/release.env` と期待どおりに表示される（実測）。drop-in の追加 `EnvironmentFile` も後置されるため `PORT=18953` は成立する。
4. 本番 `InvocationID` は docs/81 §6-1 の基準値 `4f8d29d238904882a9dd8c6bab20939a` と**一致**（L-4 の引用は正確）。
5. 本番 DSN の port は **5435**（B-5 の「5435 系」は正確）。本番 config の sha256 は `d51927da…`（B-1 の基準値は正確）。
6. 公開 URL は **302 → Access**（C-2 / B-2 の期待どおり）。
7. `--dry-run` が `current` を作らない／unit を起動しないという記述は main でも正しい（L215-219）。
8. precheck port 併走中（旧 18950 + 新 18953）の二重ワーカーは、通知が `FOR UPDATE SKIP LOCKED`（`apps/api/src/lib/handover-notify.ts` L155-166）で排他されるため**二重送信は起きない**。この点は指摘しない（runbook が併走時間に触れていないことだけ M 相当の改善余地）。
9. `api.conf` の `COMMIT_SHA` は書き換えない方針が明記され、C-1 の合格に自己申告値を使わない構造になっている（Lead 追加確認 (4) は PASS）。
10. 旧 unit を `mask` する判断は、`Wants=` が弱依存であるため proxy の起動を妨げず、かつ 18950 の奪い合いを止める。再起動後も維持される（新 unit は enable、旧 unit は masked）。

---

## 8. 実行前に必要な修正（この 4 件で GO にできる）

1. **High-1**: `STG_REF` を実行時 `origin/main` 取得にし、`== origin/main` を検査する（`65caaa2` の直書きを廃止）。
2. **High-2**: C-3 に `X-Proxy-Secret`（または 18949 経由）を追加し、期待 200 を実際に観測できるようにする。
3. **High-3**: §4-4 の unit 全文を main のテンプレートと一致させる（`Restart`/`RestartSec`）か、差異の理由と正本を明記。`--unit-template` と `ops/systemd/ai-helpdesk-prod-api.service` の存在を反映。
4. **High-4**: §4-10 の判定表に `restart-failed`（`current` は previous へ自動で戻る）を追加し、実装記述を main に合わせる。

上記に加えて M-a（staging 現状値）を実行時に更新すれば、A/B/C をそのまま実行できる水準になる。

## 9. 再現コマンド（read-only）

```bash
# 版の確認
gh pr view 142 --json headRefOid,commits,changedFiles
git ls-remote origin 'refs/heads/docs/promotion-runbook-20261106'
git show 542f95f:docs/82-promotion-runbook-20261106.md | sha256sum   # 1d9ca685…
git -C . rev-parse origin/main                                       # 4465f8d

# High-1 の根拠
git show origin/main:scripts/deploy-release.sh | sed -n '126,132p'    # chmod a-w → 再検証
git show 65caaa2:scripts/lib/dist-manifest.mjs | grep -n "0o600"      # 0400 を拒否
git show origin/main:scripts/deploy-release.sh | grep -n 'DRY_RUN" = 1\|switch_to "\$RELEASE_DIR"\|restart failed\|prune_releases'

# High-2 の根拠（実測）
for p in / /index.html /api/state; do curl -sS --noproxy '*' -o /dev/null -w "$p %{http_code}\n" "http://127.0.0.1:18950$p"; done
curl -sS --noproxy '*' http://127.0.0.1:18950/api/me   # {"error":{"code":"PROXY_REQUIRED"}}

# High-3 の根拠
git show origin/main:ops/systemd/ai-helpdesk-prod-api.service
git show origin/main:scripts/deploy-release.sh | grep -n 'unit-template'

# 受入の前提確認
systemctl --user show ai-helpdesk-stg-api -p EnvironmentFiles
systemctl --user show ai-helpdesk-api -p MainPID -p NRestarts -p InvocationID
curl -sS --noproxy '*' http://127.0.0.1:18952/api/health
curl -sS -o /dev/null -w '%{http_code}\n' https://ai-helpdesk.mirai-dx-platform.com/
sha256sum "$HOME/.cloudflared/ai-helpdesk-config.yml" | cut -c1-16      # d51927da44c6b778
```
