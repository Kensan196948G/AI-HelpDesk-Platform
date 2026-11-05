# PR #142 独立レビュー — 承認後 runbook（Staging 公開 / 本番昇格）

- レビュー実施: 2026-11-06 08:06〜08:16 JST
- レビュー対象: PR #142 / `docs/promotion-runbook-20261106` / head `1019e1e`（親 `e7d7f6f`）/ 追加ファイル `docs/82-promotion-runbook-20261106.md`（164 行、+164/-0）
- 作業ツリー: HEAD `e7d7f6f`（main）／PR ファイルは作業ツリー未取込（`git show 1019e1e:docs/82-...` で読解）
- CI: `gh pr checks 142` → `verify pass 4m23s`（成功）
- 制約: `systemctl` 操作は禁止のため未実施。`NRestarts`・unit の active 状態は OS から直接測定できていない（`/proc`・`ss`・ファイル系のみで代替）

## 0. 判定

**NO-GO**（このままマージし、承認後に実行してはならない）

- 区分 **A は概ね妥当**（本レビュー中に実環境で A-1/A-2 が成立したことを実測）。
- 区分 **B は docs/77 §6-2 より実行精度が落ちており、必須の設定手順（`ACCESS_AUD`/`ACCESS_TEAM_DOMAIN`）と秘密の保護が欠落**。
- 区分 **C は手順として成立しない（Critical C-1）**。承認後にこの手順を実行すると、本番 API を停止した状態で新 unit の起動に失敗し、確実に停止時間を発生させる。
- 「未実行の手順書」である点は理解するが、**承認後にそのまま実行される前提の文書**である以上、実行不能な C と観測不能な受入条件を含む状態でのマージは認められない。

判定を GO-WITH-LIMITS にしなかった理由: 制限付きで通してよいのは「A のみ先行」だが、A は §2 に閉じており PR 全体としては C の Critical が残る。A だけを別 PR に切り出せば GO 相当。

---

## 1. レビュー中に観測した環境変化（重要）

本レビュー開始時点（08:06）と終了時点（08:12）で **Staging の実状態が変化した**。他担当が runbook §2-1 相当を実施したとみられる。

| 時刻 | 事象 | 根拠 |
|---|---|---|
| 08:06 頃 | `~/.config/systemd/user/ai-helpdesk-stg-api.service` は 580 bytes・`release.env` 行なし（mtime 06:34） | 初回 `cat -n` |
| 08:07:20 | 同 unit が 758 bytes に更新（`EnvironmentFile=.../current/release.env` とコメント行が追加、mtime 08:07:20） | `stat -c '%y %s'` |
| 08:07:21 | `ai-helpdesk-stg-api` プロセス起動（PID 1701354） | `ps -o lstart` |
| 08:07:30 頃 | `GET 127.0.0.1:18952/api/health` の `commit` が `359cbd012274fd23ed3ee99a5a497236b4ac7711` に | 実測（下記 E-4） |

結果として **runbook §1「現状の実測値」の 2 行（health の `commit` が空）は既に事実と異なる**。docs/81 §3-1（07:05 測定）では `commit:""` だったので執筆時点では正しかったが、文書に測定時刻が無いため「現状」を主張する表としては不適切になった。

教訓として: **§1 の表には各行の測定時刻と取得コマンドを付けるべき**（docs/81 §2 の方式に合わせる）。

---

## 2. Critical

### C-1. 区分 C に「実際に配備する手順」が存在しない（`--dry-run` のみ。`current` symlink が作られない）

- 根拠（runbook）: `docs/82` L111-118 の deploy-release.sh 呼び出しには `--dry-run` が付いており、L118 のコメントも「build と manifest 検証だけ」。L120-127 で unit 新設 → L125-126 で `stop ai-helpdesk-api` → `start ai-helpdesk-prod-api`。**`--dry-run` を外した実行手順が文書中に 1 か所も無い。**
- 根拠（実装）: `scripts/deploy-release.sh` L211-215 — `--dry-run` は `record_deploy 'dry-run'` を書いて `exit 0` し、`switch_to`（L131-135）を呼ばない。したがって `<root>/current` は生成されない。
- 根拠（実環境・実測）: `/home/kensan/ai-helpdesk-prod/` は既に dry-run 実行済みで、
  - `releases/20261106T071603-e7d7f6f9dc94/` は存在（`dr-x------`、不変化済み）
  - `state/deploy-20261106T071603-e7d7f6f9dc94.json` = `{"ref":"e7d7f6f9dc945bff48419b020bab40696fe05e3f","previous":null,"result":"dry-run","healthPort":18950}`
  - **`current` は ABSENT**（`test -e` で確認）
  - **`~/.config/systemd/user/ai-helpdesk-prod-api.service` は ABSENT**
- 帰結: runbook L121 の新 unit は `WorkingDirectory=<prod root>/current` を指すが、その実体が無い。`EnvironmentFile=`/`WorkingDirectory=` は存在しないと unit 起動が失敗する（`status=200/CHDIR`）。しかも L125 で旧 unit を先に停止するため、**本番 API が停止したまま新 unit が起動しない**。rollback（L130-131）で戻すまで全断。
- 重大度: **Critical**（承認後実行で本番停止が確定的。「秒〜十数秒の瞬断」という §0 の記述と一致しない）

### C-2. 受入 C-1（health の `commit` 一致）が、この手順では作れない

- runbook L138 は `commit` が配備 SHA と一致することを要求する。しかし新 unit の定義は L121 のコメント（`WorkingDirectory` と `PORT` のみ）で、**`COMMIT_SHA` の供給元が書かれていない**。
- 実測: 本番 health の `commit` は `api.conf` の `COMMIT_SHA` 由来（`sed -n 's/^COMMIT_SHA=//p' ~/.config/ai-helpdesk/api.conf` の値が `a5e0a6719699d4711fc1811bbdb79c74d9aab393` と一致）。health 実装は `apps/api/src/routes/health.ts` L15 `config.COMMIT_SHA ?? ''`。
- したがって新 unit が `api.conf` だけを読む構成（既存 unit の複製）だと、health は **`a5e0a67` のまま**＝C-1 不合格。逆に `api.conf` の `COMMIT_SHA` を書き換えて合格させるのは**自己申告**であり、docs/77 §4-4 周辺（L189/L242「`COMMIT_SHA` は env ファイルに手書きしない」）に反する。
- 一方、staging 側では §2-1 L33-37 が `release.env` の追記を明示しており、**同じ注意が本番側（C）にだけ欠落**している。認証情報の食い違いで別 SHA を自己申告する事故は、まさに docs/77 が避けようとしたもの。
- 重大度: **Critical**（受入条件が手順から導出できず、かつ「嘘の合格」経路が開いている）

---

## 3. High

### H-1. 本番 unit の enable/disable 交代が無く、再起動で旧コードへ静かに戻る

- runbook は `ai-helpdesk-prod-api` の新設（L120-122）と `start`（L126）だけを行い、**旧 `ai-helpdesk-api` の `disable` と unit ファイルの退避を行わない**。
- 実測: `~/.config/systemd/user/default.target.wants/` に `ai-helpdesk-api.service` の symlink が存在（enabled）。新 unit は enabled にされない。
- 帰結1: 次回ブート時は **enabled な旧 unit のみ起動** → checkout 直配備の `a5e0a67` 相当へ静かに巻き戻る（成功したように見えるが配備が失われる）。
- 帰結2: 両方 enabled にした場合は 18950 の二重バインドで片方が失敗し、起動順で結果が変わる（非決定的）。
- 追加リスク: `ai-helpdesk-proxy.service` は `Wants=ai-helpdesk-api.service`（実測 unit L3-4）。proxy が `Restart=always` で再起動すると systemd が**旧 unit を引き上げ**、18950 を奪い合う。
- 重大度: **High**（配備の永続性と再起動時の決定性が保証されない）

### H-2. 受入条件が「観測可能な信号」になっていない（C-3 / C-4 / C-6）

| # | runbook の記述 | 何が問題か |
|---|---|---|
| C-3 | 「認証後 UI の主要 3 画面が 200」（L140） | **どの 3 画面か（URL/パス）が未定義**。実行者の主観で変わり、再現も反証もできない |
| C-4 | 「想定外の増減・チェーン破断がない」（L141） | **コマンドも基準値も無い**。「想定外」の定義が無く、配備中の正常な監査増加と区別できない。`scripts/audit-find-breaks.ts` は存在するが runbook から参照が無い |
| C-6 | 「tunnel-watch が `ok`」（L143） | `scripts/tunnel-watch.mjs` は oneshot で、`ok` は**その回の journal 出力**（L116 `console.log('tunnel-watch: ok ...')`）にしか現れない。恒常状態を表す信号ではない。タイマー自体は enabled を確認（`timers.target.wants/ai-helpdesk-tunnel-watch.timer`）が、**「5xx が増えない」に至っては比較対象が無い** |

- 同種の弱さ（Medium 相当だが運用影響が大きいので併記）: B-4「staging の JWT が本番 AUD と一致しない（設定値の照合）」は設定ファイルの目視＝自己申告。B-5 も「件数・最終更新の前後比較」でコマンド・基準値が無い。
- 重大度: **High**（文書の中心的な約束が「受入条件の固定」であるのに、その 3 項目が検証不能）

### H-3. 区分 B が docs/77 §6-2 より劣化している（必須設定と禁止事項の欠落）

`docs/77` L386-424（B の設計手順）と runbook L67-81 を比較した結果、runbook で**落ちているもの**:

1. 事前確認（`cloudflared tunnel list` で同名が無いこと、`dig +short` で既存レコードが無いこと、本番 config の `sha256sum` 基準値）
2. config の実体（heredoc）と **`chmod 600`**、`cloudflared tunnel ingress validate`
3. `systemctl --user daemon-reload` と **`enable --now ai-helpdesk-stg-cloudflared.service`**（runbook L76 は unit を「新規」と書くだけで作成内容・reload・enable が無い）
4. 禁止事項（`--overwrite-dns` を使わない／本番 config を編集しない／`restart ai-helpdesk-cloudflared` をしない）
5. 資格情報 JSON の **0600** 指定（runbook L72 は `<新 json>` のみ。docs/77 L396 は `（0600）` を明記）

- 特に 5 は秘密の保護そのもの。`~/.cloudflared/*.json` の実測パーミッションは `600`/`400`（例: `-rw-------`）であり、**指示が無ければ 644 で作られ得る**。
- また runbook L63（§3-1）は「enforce/secure に**先に**変更してから公開」と書くが、L78（§3-2 step 6）では Access アプリ作成**後**に再起動しており、順序の記述が矛盾している。
- 重大度: **High**（実行不能ではないが、設計で固めた安全弁を落としている）

### H-4. 区分 B に `ACCESS_AUD` / `ACCESS_TEAM_DOMAIN` の設定手順が無く、B-4 を満たせない

- runbook §3-1 が変更を指示するのは `ACCESS_JWT_MODE` / `COOKIE_SECURE` / `ALLOWED_ORIGINS` の 3 つだけ。
- 実測: `~/.config/ai-helpdesk/stg-api.conf` のキー一覧に **`ACCESS_AUD` と `ACCESS_TEAM_DOMAIN` は存在しない**（キー名のみ確認。値は参照していない）。
- docs/77 L236 は「`ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` = 同一 team / **staging 専用 AUD**」「本番 AUD を流用すると本番アプリの JWT が staging で通る」と要求している。
- 帰結: 新規 Access アプリの AUD を staging 設定へ入れる step が無いため、B-4（本番と別 AUD）は**手順から満たせない**。enforce にした際の JWT 検証も team domain / AUD 未設定のままとなり、期待動作にならない。
- 重大度: **High**

### H-5. 区分 C は docs/77 §4-6 の fail-closed 契約に違反する（が、その契約は実装されていない）

- docs/77 L316-340（配備スクリプトの契約）の停止条件:
  1. 実行 cwd/対象 path が本番 checkout またはその配下 → runbook L113 の `--repo` はまさに本番 checkout
  2. 対象 unit 名に `-stg-` が無い、または `ai-helpdesk-{api,proxy,cloudflared,backup}` に一致 → runbook L117 の `--unit ai-helpdesk-prod-api` は `-stg-` 無し
  4. `PORT`/`SIDECAR_PORT` が 18949/18950 → runbook L118 の `--health-port 18950` は該当
- 実装の `scripts/deploy-release.sh` にはこれらのガードが**存在しない**（L45-64 の検証は引数形式・env ファイル権限・root の禁止ディレクトリのみ）。つまり「設計では禁止、実装では素通り」の状態で、runbook は後者に乗っている。
- runbook はこの不整合に一切触れておらず、本番用ツールとして deploy-release.sh を無条件に採用している。
- 重大度: **High**（本番操作の安全弁が文書上も実装上も無い）

### H-6. 区分 C の rollback が docs/77 §4-4 の「切替単位」と食い違い、状態が中途半端に残る

- docs/77 L301-308: rollback は `previous` symlink へ戻す + restart（秒単位）。release と設定と DB と tunnel を層ごとに分離。
- runbook L129-131: `stop ai-helpdesk-prod-api` → `start ai-helpdesk-api`。**`current` symlink には触れない**。
- 帰結: rollback 後、`<prod root>/current` は新 release を指したまま（作られていれば）、稼働は旧 checkout。次回以降の deploy で `PREVIOUS` が「戻っていない新 release」になり、deploy-release.sh の自動 rollback（L232-242）が誤った基準へ戻す。
- 加えて `deploy-release.sh` L219-221 は `restart` 失敗時に `fail` で即終了し、`switch_to` した symlink を戻さない（自動 rollback は health 失敗時のみ L230-）。この穴も runbook は踏む。
- 重大度: **High**

---

## 4. Medium

### M-1. §1「現状の実測値」が測定時刻を持たず、既に陳腐化している

- 08:07 の実測で staging の `commit` は `359cbd0…` になり、§1 L27「health の `commit` が空」は現在は偽（§1 参照）。
- `proxy 未起動` は現在も真（`ss -ltnp` に 18951 が無い／`curl --noproxy` は connection refused）。
- 「現状」を名乗る表には測定時刻と再取得コマンドを付与すべき（docs/81 §8 が再実行用コマンドを備えているのと対照的）。

### M-2. A-1 の修正を「生成物の手編集」で指示している

- `~/.config/systemd/user/ai-helpdesk-stg-api.service` は `scripts/install-staging.sh` L130-141 が `ops/systemd/*.service` を `sed` 展開して生成する**生成物**。
- 実測: 現時点で deployed unit は**テンプレート展開結果と完全一致**（`diff` 差分なし）。つまり repo 側 `ops/systemd/ai-helpdesk-stg-api.service` L10-11 に既に同じ行があり、**冪等な `install-staging.sh` 再実行で足りた**。
- runbook は repo テンプレートに触れず、`~/.config` を直接編集させる。テンプレートが将来変わった場合に静かに乖離する。
- 併せて: **A は `ai-helpdesk-stg-api` を enable しない**（`install-staging.sh` も enable するのは postgres のみ L145）。実測で `default.target.wants` に stg-api の symlink は無い。A 完了後も再起動で staging は落ちる。「Staging を整えた」と読める受入条件としては不足。

### M-3. `--dry-run` は「unit が存在するか」を検証できない（§5-1 の先実施検証が誤った安心を与える）

- runbook §5-1 は「`--dry-run` で本番相当 release を生成し、manifest・HTML 同梱を検証する」を承認不要の事前検証と位置づける。
- しかし `--dry-run` は L211-215 で `systemctl` を一切呼ばないため、**`--unit ai-helpdesk-prod-api` が存在しないこと**（実測: ABSENT）を検出できない。
- 実測: `/home/kensan/ai-helpdesk-prod/` には 07:16 の dry-run 成果物（release と state 記録）が既にある。**§5-1 は既に実行済みで「成功」しているが、C の実行可能性は 1 ミリも検証されていない。** この構図は文書に明記すべき。

### M-4. `--unit` / `--health-port` が dry-run では無効で、切替の予行演習になっていない

- runbook L118 の `--health-port 18950` は 18950＝現行本番のポート。dry-run では health 照合が走らないため無害だが、**本番で非 dry-run 実行した場合は「稼働中の旧 process」を照合対象にし得る**。旧 process の応答 `commit` が REF と一致しないため、`health_ok` 失敗 → rollback 分岐に入る（L230-）。既存値を `COMMIT_SHA` に入れていた場合は**逆に誤って合格**する（C-2 と同根）。
- runbook は「build は deploy-release.sh、切替は手動 systemctl」という**二重の流儀**を混ぜており、結果として deploy-release.sh の原子的切替・自動 rollback・health 束縛（実装の中心価値）をすべて使っていない。

### M-5. C の本番影響記述が実測と整合しない

- §0 の表 L13 は C を「低リスク（release/unit を戻せば復旧。DB は変更しない）」とする。
- DB について: `git diff --name-only a5e0a67..main` に `db/` 配下の変更は無く（migration は `db/migrations/037` まで、差分ゼロ）、**C が DB schema を変えないという記述は正しい**。これは肯定的に評価できる。
- 一方 unit については H-1/H-6 のとおり「戻せば復旧」が成立しない（enable 状態・symlink が不整合のまま残る）。「低」は過小評価。

### M-6. B の rollback が「停止 → 削除」の順序で、資格情報の残置に触れていない

- runbook L95: `stop/disable` → DNS 削除 → Access アプリ削除。docs/77 §6-3 は `cloudflared tunnel cleanup` → `tunnel delete` → **資格情報ファイルの削除**まで規定。
- 資格情報 JSON を残すと、後日に同名 tunnel を作り直した際の取り違え源になる。B の rollback は「なし（削除で戻せる）」とだけ書かれ、delete 手順が無い。

### M-7. B-5（DB 隔離）が構造ではなく計数に依存している

- staging は別クラスタ（127.0.0.1:5437 / `ai_helpdesk_stg`）で構造的に分離済み（docs/81 §5 が同一性を実測）。
- それでも B-5 は「件数・最終更新の前後比較」という弱い信号のみで、コマンド・基準値が無い。構造的根拠（別ポート・別クラスタ・`DATABASE_URL` の指し先）を併記すれば反証可能になる。

---

## 5. Low

- **L-1**: `--ref <main SHA>`（L114）。`deploy-release.sh` L48 は 40 hex 固定（`^[a-f0-9]{40}$`）。短縮 SHA を貼ると `ref must be a full 40-hex commit` で停止する（失敗側に倒れるので実害は小さいが、記載は 40 hex と明記すべき）。
- **L-2**: `cloudflared tunnel login`（origin cert）の前提に触れていない。実測で `~/.cloudflared/cert.pem` は存在するが、手順として前提を書くべき。
- **L-3**: §4-4 の緩和列が「release に HTML/bridge/skills を同梱済み（docs/78 §1）」と引用するが、同梱要件の正本は **docs/77 §4-3**。docs/78 §1 は実装一覧であり、要求仕様ではない。引用先の取り違え。
- **L-4**: A-5 の基準値（MainPID / NRestarts / health commit）が docs/81 §6-1・§9 に実測済みで存在するのに参照が無い。基準値を文書内に固定しないと「不変」の比較対象が実行者依存になる。
- **L-5**: `deploy-release.sh` の `prune_releases` は成功時のみ（L226）。dry-run を繰り返すと release が無制限に溜まる（`--keep` 既定 3 は成功パスのみ）。runbook §5-1 を「繰り返し実行してよい」と読める記述になっている。
- **L-6**: A-4 の 401 は「proxy secret 未付与」による 401 と「認証境界」による 401 の区別がつかない（`REQUIRE_PROXY_SECRET=true` 実測）。A-4 を認証境界の証拠と呼ぶなら、proxy secret 付きで 401 になることも示す必要がある。

---

## 6. 受入条件の観測可能性マトリクス

| # | 観測可能か | 補足 |
|---|---|---|
| A-1 | ○ | 実測で達成済み（`359cbd012274fd23ed3ee99a5a497236b4ac7711`） |
| A-2 | ○ | `ok:true` / `db:"ok"` / `env:"production"` を実測（staging config の `NODE_ENV=production`） |
| A-3 | ○（現在は不合格） | 18951 は待受なし＝接続拒否。`--noproxy` 指定が必要（環境に `HTTP_PROXY` が設定されている） |
| A-4 | △ | 401 の理由が曖昧（L-6） |
| A-5 | ○（基準値の引用が無い） | docs/81 §6-1 に MainPID 2379216 / NRestarts 0 の実測あり |
| B-1 | △ | 「ingress digest」が未定義。コマンド無し |
| B-2 | ○ | 302 → Access は観測可能 |
| B-3 | △ | 人が必要（明記はされている） |
| B-4 | × | 設定値の目視のみ。AUD 設定 step 自体が無い（H-4） |
| B-5 | × | コマンド・基準値なし（M-7） |
| C-1 | × | 手順から生成不能（C-2） |
| C-2 | ○ | ローカル 200 は自明。トンネル経由の end-to-end は未規定 |
| C-3 | × | 対象画面が未定義（H-2） |
| C-4 | × | コマンド・基準値・「想定」の定義が無い（H-2） |
| C-5 | △ | 「訓練で確認」とあるが rollback 自体が不整合（H-6） |
| C-6 | × | oneshot の単回出力のみ。「5xx が増えない」は比較対象なし（H-2） |

---

## 7. 確認したが問題が無かった点（誤指摘を避けるため記録）

1. **deploy-release.sh のオプション名は runbook と一致**（`--repo` / `--ref` / `--root` / `--env-file` / `--unit` / `--health-port` / `--dry-run` すべて L28-43 に実在）。
2. **`--dry-run` の説明は正確**（build と manifest 検証のみ、切替・restart なし）。
3. **本番 unit は checkout 直配備で、runbook §1 L21 の記載どおり**（`WorkingDirectory=/home/kensan/Projects/Mirai-Admin-Platform/AI-HelpDesk-Platform`、PID 2379216 の cwd が一致）。runbook の「checkout 直参照から immutable release へ」という問題設定は正しい。
4. **本番 proxy unit のポート記載も正確**（SIDECAR_PORT=18949 / API_PORT=18950）。
5. **tunnel ID と ingress も正確**（`~/.cloudflared/ai-helpdesk-config.yml` = tunnel `96d0214e-8236-4bce-8dd0-75233d1e716f`、ingress 1 本 → 18949）。既存 tunnel を触らない方針も妥当。
6. **A の EnvironmentFile 追記位置（既存の後ろ）は正しい**。systemd は後勝ちなので `COMMIT_SHA` を release から供給できる（テンプレート L9-11 と同型）。
7. **staging の `AUTH_MODE=cloudflare-access` / `ACCESS_JWT_MODE=off` / `COOKIE_SECURE=false` / `ALLOWED_ORIGINS=http://127.0.0.1:18951`** という §3-1 の前提記述は実測と一致。
8. **`/api/health` は proxy secret と Access JWT の除外対象**（`apps/api/src/server.ts` L98 `isHealth`、L131 コメント）。したがって B で enforce に切り替えても A-3 の health 監視は壊れない。
9. **DB は変更されない**（`a5e0a67..main` に `db/migrations` の差分なし、最新は 037）。C の「DB は変更しない／migration は別承認」は妥当。
10. **release bundle の必須物は欠けていない**（実測: `apps/api/dist/index.js` / `node_modules` / `dist-manifest.json` / root HTML 1 本 / `apps/api/src/prototype/*.js` 11 本 / `scripts/skills/approved.json` / `scripts/skills/windows` すべて存在）。
11. **release 内の docs は HTTP 配信されない**（`@fastify/static` 不使用、`apps/api/src/routes/prototype.ts` L15/L344 は固定ファイル名のみ）。release に `docs/MailAddress.txt` 等が同梱される点は docs/79 の既知課題であり、本 PR の新規リスクではない。
12. **staging の `approved.json` が本番と同一**（8377 bytes / 完全一致）で、docs/77 §4-3 は staging に空または合成 manifest を求めている。厳密には逸脱だが、実測では固有アドレスの重複は 0 件で、UI 上の承認状態が本番と同型になる「状態の取り違え」に留まる（Medium 未満として Low 相当・A/B の阻害要因ではない）。
13. **CI `verify` は成功**（`gh pr checks 142` → pass）。ドキュメントのみの PR としてのマージ条件は形式的には満たしている。

---

## 8. 修正要求（マージ前に最低限必要なもの）

1. **C を書き直す**（Critical C-1/C-2）:
   - `--dry-run` を外した実配備 step を明記し、`current` symlink の生成を手順に含める（deploy-release.sh に一本化するのが最短）。
   - 新 unit の**全文**（`ExecStart` の絶対 node パス、`EnvironmentFile=api.conf` の**後ろ**に `EnvironmentFile=<root>/current/release.env`、`WorkingDirectory`、`PORT`）をコードブロックで固定する。
   - `api.conf` の `COMMIT_SHA` を release 由来へ移す（または削除する）方針を明記する。
2. **unit 交代を明記**（H-1）: `systemctl --user disable ai-helpdesk-api`、旧 unit の退避、`enable ai-helpdesk-prod-api`、proxy の `Wants=` 見直し。
3. **C-3/C-4/C-6 を観測可能にする**（H-2）: 画面 URL 3 本、`audit-find-breaks.ts` の実行コマンドと基準値（既知破断 2 件）、`journalctl --user -u ai-helpdesk-tunnel-watch` の読み方と 5xx の比較方法。
4. **B を docs/77 §6-2 と同等以上に戻す**（H-3/H-4）: 事前確認、config heredoc、`chmod 600`、`ingress validate`、`daemon-reload`/`enable --now`、禁止事項、`ACCESS_AUD`/`ACCESS_TEAM_DOMAIN` の設定 step。
5. **§1 に測定時刻と取得コマンドを付け、現状値を更新する**（M-1）。
6. **rollback を docs/77 §4-4 の単位に合わせる**（H-6）: symlink + restart で戻し、中途半端な状態を残さない。
7. docs/77 §4-6 の fail-closed 契約と実装の乖離を扱う（H-5）: 本番で deploy-release.sh を使うなら、契約を更新するか例外を明記する。

---

## 9. 再現コマンド（read-only / 本レビューで実際に使用）

```bash
# PR 差分
gh pr view 142 --json title,headRefOid,files,body
gh pr diff 142
git show 1019e1e:docs/82-promotion-runbook-20261106.md | cat -n
git log -1 --format='%H %P' 1019e1e     # 親 e7d7f6f

# 本番 / staging の実状態（秘密は表示しない）
curl -sS -m4 --noproxy '*' http://127.0.0.1:18950/api/health
curl -sS -m4 --noproxy '*' http://127.0.0.1:18952/api/health
curl -sS -m4 --noproxy '*' -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18950/api/me
ss -ltnp | grep -E ':(18949|18950|18951|18952|5437)\b'
tr '\0' ' ' < /proc/1701354/cmdline ; readlink /proc/1701354/cwd ; cat /proc/1701354/cgroup

# unit 定義（repo テンプレートと deployed の比較）
cat -n ops/systemd/ai-helpdesk-stg-api.service
cat -n ~/.config/systemd/user/ai-helpdesk-stg-api.service
diff -u <(sed -e 's|__STG_ROOT__|/home/kensan/ai-helpdesk-stg|g' \
             -e 's|__STG_CONF__|/home/kensan/.config/ai-helpdesk/stg-api.conf|g' \
             -e 's|__NODE__|/home/kensan/.nvm/versions/node/v22.22.3/bin/node|g' \
             ops/systemd/ai-helpdesk-stg-api.service) \
          ~/.config/systemd/user/ai-helpdesk-stg-api.service
ls -la ~/.config/systemd/user/default.target.wants/ | grep helpdesk

# 本番 release root の実測（Critical C-1 の根拠）
ls -la /home/kensan/ai-helpdesk-prod/ /home/kensan/ai-helpdesk-prod/releases/
test -e /home/kensan/ai-helpdesk-prod/current && echo EXISTS || echo ABSENT
cat /home/kensan/ai-helpdesk-prod/state/deploy-*.json

# 秘密を出さないキー確認
sed -n 's/^[[:space:]]*\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' ~/.config/ai-helpdesk/stg-api.conf | sort
grep -E '^(ACCESS_JWT_MODE|COOKIE_SECURE|ALLOWED_ORIGINS)=' ~/.config/ai-helpdesk/stg-api.conf

# DB 差分の有無
git diff --name-only a5e0a67..main | grep -Ei 'sql|migrat|schema|^db/'
```

## 10. 本レビューの限界

- `systemctl` 操作禁止のため、`NRestarts`・unit の active/enabled 状態は **symlink と `/proc` による間接確認**にとどまる（`is-enabled` は未実行）。
- 本番 unit の切替・rollback は当然未実行。C の不成立は「実装読解＋ファイルシステム状態（`current` 不在）」による**強い推定**であり、実際に start して確かめたものではない。ただし `WorkingDirectory` 不在で unit が起動しないのは systemd の仕様であり、推定の幅は小さい。
- レビュー中に他担当が staging unit を更新したため、A の受入状態は時刻依存である（§1 に時刻を記録）。
