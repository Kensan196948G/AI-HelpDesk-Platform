# PR #142 最終再レビュー（Step3b / v3・head 固定）

- 実施: 2026-11-06 10:20〜10:30 JST
- 対象: PR #142 head **`df31c3f9b04476707cfb73a3592fb64861f3d892`**（固定）/ `docs/82-promotion-runbook-20261106.md` **1143 行**
- anchor: `sha256=5461f36224d71b78307967b91b083b6f293e73716c09feb8bee504dfd5844697`
- PR 状態: `MERGEABLE` / CI `verify` **pass**（4m29s）/ changedFiles=1（docs/82 のみ）/ +1143-0
- 参照実装: `origin/main` = `2c0e7a9`（#143 `65caaa2` / #145 `711320b` / #144 `46261ea` / **#146 `e35f4cb`** / #147 `4465f8d` / #148 `2c0e7a9`）。#148 は docs のみで、`deploy-release.sh`・unit テンプレート・proxy-sidecar は `4465f8d` から不変（`git diff --name-only 4465f8d..origin/main` で確認）
- 制約: read-only（ファイル変更は当該 evidence のみ／git は読取のみ／`systemctl` は `show`/`is-enabled`/`list-timers` のみ／Secret 非出力）

## 0. 判定

**GO-WITH-LIMITS**

- 前回の High-1〜High-4 は **4 件すべて PASS**（実装との一致を `git show` と実測で確認）。
- M-a〜M-e / L-a〜L-d も反映を確認。**runbook は「承認後にそのまま実行できる」水準に到達**した。
- **実行前に必ず直す残件は 1 件**: R-C1 / R-C3 が `ai-helpdesk-api` を `enable` し直さないため、**§4-8 通過後に rollback した場合、再起動で本番 API が起動しない**（旧 unit は disabled のまま、新 unit は enabled だが `current` 不在）。2 行の追記で閉じられる。
- マージ自体は可（docs のみ・CI pass・実装と整合）。ただし**この残件を直さずに実行しない**こと。

## 1. head と delta の確認

| 検査 | 結果 |
|---|---|
| head | `df31c3f9b…`（remote tip 一致・固定） |
| 直近 commit | `6293012` → `f00796d`（A-4 restart 追加・+? 行）→ `df31c3f`（B 同一シェル明記・**1 行のみ**） |
| `f00796d..df31c3f` | `docs/82` の 1 行差し替え（B-3 の「B-3〜B-6」→「B-1〜B-6」） |
| レビュー済み範囲 | v3 の実質内容は `f00796d` で確定。`df31c3f` はその +1 行 |

### delta が新たな問題を作っていないか（Lead 指定の 2 点）

**A-4 の staging restart と A-5（本番不変）の矛盾 — なし（PASS）**
- A-4 は `systemctl --user restart ai-helpdesk-stg-api` と `enable --now ai-helpdesk-stg-proxy` のみ（staging 専用）。
- A-5 の `capture()` が取るのは `ai-helpdesk-api` / `ai-helpdesk-proxy` / `ai-helpdesk-cloudflared` の 3 unit、本番 health（18950）、本番 `~/.cloudflared/ai-helpdesk-config.yml` の sha256 **のみ**（最終版 L233-240 で確認）。staging unit は含まれないため、A-4 の restart で A-5 が誤って FAIL することはない。
- A-5 の合否は「実行時 before と after の一致」であり、絶対値固定ではない（本体が再起動しなければ動かない）。妥当。

**B-1〜B-6 の同一シェル前提が順序を壊さないか — 破壊なし（PASS、ただし Low 1 件）**
- 引き継ぎ対象 `TUNNEL_ID`（B-1→B-2）・`APP_ID`/`STG_AUD`（B-3→B-4）は同一シェルでしか成立しないため、明記は**必要かつ正しい**。
- 実行順序も破綻しない: B-1 tunnel 作成 → B-2 config/validate → B-3 Access 作成 → B-4 AUD/team/enforce 反映 + stg-api restart → B-5 tunnel unit 起動 → **最後に** B-6 DNS（fail-closed の順序）。
- `umask 077`（B-3）は後続の `install -m 644`（B-5）や `chmod 600` を妨げない。
- **Low（残件ではない）**: B-1 のブロックには `set -euo pipefail` が無い（付くのは B-3 から）。`cloudflared tunnel create` が失敗しても B-1 は止まらず、`TUNNEL_ID` が空のまま B-2 に進み得る（`ingress validate` は hostname/service のみ見るため通る可能性がある）。B-1 冒頭に `set -euo pipefail` を足すのが望ましい。
- なお B-3 のトークンは curl `--config`（0600）経由で argv に載らず、`export` も `CF_ACCOUNT_ID` のみ（トークンは export されない）。B-4〜B-6 の子プロセスへ漏れない。**M-b は適切に解消**。

## 2. High-1〜High-4 の PASS/FAIL

| # | 指摘 | 判定 | 根拠（実測） |
|---|---|---|---|
| High-1 | A-3 の `STG_REF` 固定 → #144 以降で確定的失敗 | **PASS** | `STG_REF=$(git -C "$MAIN" rev-parse origin/main)` + 40 hex 検査 + `cat-file -e` + `merge-base --is-ancestor 46261ea "$STG_REF"`（L138-142）。A-3 は `dist-manifest.json` の commit と比較し、一致時のみ skip（L174-190）。**昇格ケース（不一致）**では `deploy-release.sh --ref "$STG_REF"` が走り、ref は 40 hex・#144 以降・`--health-port 18952` で成立（前回失敗の原因だった 0400 manifest 再検証を通る）。**skip は build の省略のみ**で、A-1〜A-5 の受入は実行される（A-1 の期待行に「skip した場合も `commit == $STG_REF`」と明記）。検証省略には見えない |
| High-2 | C-3 が `401 PROXY_REQUIRED` で合格不能 | **PASS** | C-3 を **18949 proxy 経由**に変更（L928-935）。**実測**: `127.0.0.1:18949` の `/`・`/index.html`・`/api/state` はいずれも `401 {"code":"UNAUTHORIZED"}`＝**proxy が `X-Proxy-Secret` を付与して API に到達している**（`PROXY_REQUIRED` ではない）。`scripts/proxy-sidecar.mjs` の `injectProxySecret()` が利用者指定の同名ヘッダを捨てて上書きし、`Cf-Access-*` はそのまま転送する実装と一致。直接 18950 を叩く場合の `X-Proxy-Secret` 代替も明記。`/` は `apps/api/src/routes/prototype.ts` L334、`/api/state` は L354 に実在（=URL も正しい） |
| High-3 | §4-4 の unit が main のテンプレートと不一致 | **PASS** | `diff -u <(git show origin/main:ops/systemd/ai-helpdesk-prod-api.service) <(git show df31c3f:docs/82-… | sed -n '641,663p')` → **差分ゼロ（完全一致）**。`Restart=on-failure` / `RestartSec=3` / コメント 2 行 / `EnvironmentFile` の後置まで一致。`--unit-template` で配置する形に変更され、`--unit-template` の置換表（`__PROD_ROOT__`/`__ENV_FILE__`/`__NODE__`/`__NODE_DIR__`）も main の `sed` 実装と一致（L666-674） |
| High-4 | rollback 判定表が実装の結果値を扱っていない | **PASS** | main の `record_deploy` は 6 値: `dry-run` / `restart-failed` / `success` / `rolled-back` / `rollback-failed` / `failed-no-previous`（`git show origin/main:scripts/deploy-release.sh | grep "record_deploy '"`）。判定表（L962-970）は `RC=0`(success) / `rolled-back` / `rollback-failed` / `restart-failed`（previous あり＝#146 で `current` は自動で previous） / `restart-failed`（previous なし＝R-C1） / `failed-no-previous` / **state なし（switch 前の停止）** を網羅。`dry-run` のみ非該当だが、`dry-run` は §4-6 の経路に存在しない（§5 の事前検証で RC=0）。**漏れなし** |

## 3. Medium / Low の反映確認

| # | 指摘 | 判定 | 根拠 |
|---|---|---|---|
| M-a | §1 の値が陳腐化 | **PASS** | §1-1 を 08:43〜08:55 に再測。staging `4465f8d` / release `20261106T083747-4465f8d8905c` / 18951=200 に更新。A-3 の PREVIOUS は「実行時取得」へ変更 |
| M-b | 秘密・PII が argv に載る | **PASS** | A-4 / C-3 / B-3 / B-4 すべて curl `--config`（`umask 077` + `chmod 600`）経由。トークンは非 export。C-4 の JWT は stdin で node へ |
| M-c | C-6 の 5xx 比較が異窓・弱い | **PASS** | `T0` を §4-8 で保存し、`T0±10min` の**同一長窓**で経路失敗（cloudflared/proxy）と API 5xx を比較。**10 分経過を必須化**（未経過は exit 1）。分母 `completed ≥ 1` を要求し、0 件は「信号なし＝未合格」と明記。`date -d "$T0 +10 min"` が本環境で解釈できることを実測 |
| M-d | B の承認単位混在 | **PASS** | §0 表の B 承認欄に「B-5 の本番 DB read-only 接続」を追加 |
| M-e | mask の限界 | **PASS** | proxy に failed dependency が残る／再レンダリングで解除されない／`is-enabled` で都度確認／解除は明示 `unmask`、を §4-8 に明記。mask 失敗時は unit を退避する分岐も追加 |
| L-a | 行番号引用のずれ | **PASS** | 行番号を関数名・メッセージ文字列（`DRY_RUN` 分岐、`restart failed for`、`prune_releases`）に置換 |
| L-b | `prev_hash_mismatch` の記述 | **PASS** | `mismatches[].kind` の値であると明記（C-4） |
| L-c | §1-3 に #146/#147 が無い | **PASS** | #146 `e35f4cb` / #147 `4465f8d` を追加。「未追加（予定）」→「main に存在」に修正 |
| L-d | R-C1 が unit を残す | **PASS（一部）** | 再試行しない場合の unit / drop-in / precheck の後始末と「enable しない」を追加。ただし **boot 状態の復元は未対応**（§5 の残件） |

## 4. Lead 指定の重点確認 (a)〜(d)

- **(a) A-3 の STG_REF 実行時取得 — PASS**。昇格（staging と異なる ref）でも 40 hex・#144 以降・`cat-file` の 3 段検査を通った ref で `deploy-release.sh` が走る。skip 時も受入 A-1〜A-5 は実行され、`commit == $STG_REF` を要求するため「検証省略」にならない。
- **(b) C-3 の 18949 proxy 経由 — PASS**。実測で proxy 経由は `UNAUTHORIZED`（proxy secret 済み）、直 18950 は `PROXY_REQUIRED`。実装（`injectProxySecret`）と一致。最終 200 は有効な Access セッションが要る（人間）。
- **(c) §4-4 のテンプレート一致 — PASS**。`git show origin/main:ops/systemd/ai-helpdesk-prod-api.service` と **バイト一致**（diff 空）。
- **(d) rollback 判定表の網羅 — PASS**。6 値のうち実行経路に出る 5 値＋「state なし」を網羅（`dry-run` は経路外）。

## 5. 実行前に必ず直す残件

### R-1（High）: R-C1 / R-C3 が `ai-helpdesk-api` を `enable` し直さない → rollback 後の再起動で本番が起動しない

- §4-8 step 4 が `systemctl --user disable ai-helpdesk-api` を実行する（L847）。以後 `enable ai-helpdesk-api` は文書中に**1 か所も無い**（`grep 'enable ai-helpdesk-api'` で 0 件）。
- R-C1（L972-1008）と R-C3（L1027-1045）は `unmask` → （必要なら `.bak` から復元）→ `start ai-helpdesk-api` までで、**`enable` が無い**。
- 実測: 現行の `ai-helpdesk-api` は `is-enabled = enabled`。§4-8 で disable された後、R-C1/R-C3 で戻しても **disabled のまま**。
- 帰結（サイレント）: その状態で再起動すると、旧 unit は起動せず、新 unit（`ai-helpdesk-prod-api`）は
  - bootstrap 経路: `current` を削除済み＋未 enable → 何も 18950 を listen しない
  - subsequent 経路: enabled のままだが `current` 不在で `WorkingDirectory`/`EnvironmentFile` が解決できず起動失敗
  → **本番 API が起動しない**（直前の health 確認は通っているのに、再起動で落ちる）。
- 要求: R-C1 と R-C3 に `systemctl --user enable ai-helpdesk-api` を追加し、`is-enabled` の期待値（`enabled`）を明記。R-C3 で `current` を消す場合は `ai-helpdesk-prod-api` を `disable` する（起動不能な enabled unit を残さない）。検証コマンドも 1 行入れる。

### R-2（Low・推奨）: B-1 に `set -euo pipefail` を追加

同一シェル化で B-1 が先頭ブロックになったが、`set -e` は B-3 まで付かない。`cloudflared tunnel create` 失敗時に `TUNNEL_ID` が空のまま進み得る。B-1 冒頭に追加するのが安全（fail-closed の徹底）。

## 6. 確認したが問題が無かった点

1. §4-4 の unit 全文が `origin/main` のテンプレートと**完全一致**（High-3 の核心）。
2. `--unit-template` は dry-run では実行されない（`deploy-release.sh` の `DRY_RUN` 分岐が unit 配置より前）ため、§5-1/§5-3 の dry-run 事前検証が `~/.config/systemd/user` を汚さない。
3. `--unit-template` は `switch_to` より前に unit を配置し `daemon-reload` する（L222-236 → L239）。`current` は配置時ではなく起動時に必要で、起動（L241）時には `switch_to` 済み。順序は整合。
4. `/` と `/api/state` は実在（`routes/prototype.ts` L334 / L354）。
5. `18949` 経由の実測で `UNAUTHORIZED`（=proxy secret は付与済み）。C-3 の経路選定は正しい。
6. A-5 の capture は本番 3 unit＋本番 health＋本番 config sha のみ。A-4 の staging restart と矛盾しない。
7. §2-4 の A-3 skip 時フォールバック（`state/deploy-<release>.json` の `previous`）は実際に機能する: staging の state に `deploy-20261106T083747-4465f8d8905c.json` 等が存在。取れない場合は「C-5 未実施」として §6 に記録する（偽の合格をしない）。
8. §4-1 preflight は #146 の祖先検査・unit 名衝突検査・`db/` 差分検査・テンプレート存在・MODE と 18953 使用中の整合まで含む（H-5 の手動代替として妥当）。
9. `date -d "$T0 +10 min"` は本環境の GNU date で解釈可能（実測）。
10. 本番は未変更（MainPID `2379216` / NRestarts `0` / InvocationID `4f8d29d2…` / commit `a5e0a67…` / `current` ABSENT / prod unit ABSENT）。Staging は `4465f8d` で稼働継続。
11. CI `verify` は SUCCESS、PR は MERGEABLE。

## 7. 限界

- `systemctl` は read-only のみ。`mask`/`unmask`/`disable`/`enable` の実挙動は実行していない（§4-8 の分岐は「環境依存」と本文が明記しており、`is-enabled` で都度確認する設計になっている）。
- C の本番切替は未実行。R-1 は「§4-8 で disable 済みの状態から R-C1/R-C3 を実行し、その後に再起動する」という思考実験に基づく判定であり、実際に再起動して確かめたものではない。ただし `disabled` の unit が boot で起動しないのは systemd の仕様であり、推定の幅は小さい。
- staging の受入（A）は未実行。本文も「未実行」と明記しており、本レビューも実行していない。
