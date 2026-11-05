# PR #142 改訂版 再レビュー（Step3b）

- 再レビュー実施: 2026-11-06 08:29〜08:36 JST
- 対象: PR #142 / `docs/promotion-runbook-20261106` / `docs/82-promotion-runbook-20261106.md`
- 前回レビュー: `docs/evidence/review-20261106/pr142-review.md`（head `1019e1e` を対象、判定 NO-GO）

## 0. 結論

**NO-GO（改訂が未 push のため再レビュー不能）**

| 検査 | 値 | 判定 |
|---|---|---|
| PR #142 head | `1019e1e033ac207c3f49a5021398e027f6cfbf33` | **前回と同一** |
| remote branch tip | `1019e1e033ac207c3f49a5021398e027f6cfbf33` | 一致（push なし） |
| PR commits 数 | 1 件（`1019e1e03 2026-11-05T22:15:45Z`） | 追加 commit なし |
| PR updatedAt | `2026-11-05T22:15:54Z`（= 2026-11-06 07:15:54 JST） | 前回レビュー時と同一 |
| ファイル digest（anchor） | `sha256=c21292537a64451db33008c7ae57af72de1b34708202d3a124ed32f8d5fdae4a` / 164 行 | 前回と同一 |

`git show 1019e1e:docs/82-promotion-runbook-20261106.md` と `git ls-remote origin` の双方で同一 commit を確認した。**runbook の本文は 1 バイトも変わっていない。** したがって「改訂により指摘が解消されたか」を判定する材料が存在せず、前回の Critical 2 件・High 6 件・Medium 7 件・Low 6 件は**すべて未修正のまま**である。

推測で合格にすることはしない。以下 §3 の PASS/FAIL は「PR 側の解消度」であり、全件 FAIL（未修正）である。ただし §4 に、main 側の変化によって**指摘の根拠・前提が変わった箇所**を区別して記録する（次回改訂時に再確認すべき点）。

---

## 1. 前提の再実測（Lead 提示値の検証）

| Lead の提示 | 実測 | 一致 |
|---|---|---|
| systemctl --user が実行可能 | `show` / `is-enabled` / `list-timers` で応答あり | ○ |
| #143 / #145 / #144 が main | main = `46261ea`、`65caaa2 (#143)` / `711320b (#145)` / `46261ea (#144)` | ○ |
| Staging は main `46261ea` で稼働 | health `commit=46261ea1eb3152287457d0c25e42a80106bc2a58` | ○ |
| release `20261106T082716-46261ea1eb31` | `current` → 同ディレクトリ、dir `500` / `apps/api/dist/index.js` `400` | ○ |
| 18951 proxy 200 | `200` | ○ |
| 3 timer enabled | `is-enabled` = enabled ×3 | ○ |
| 本番 未変更 | MainPID `2379216` / NRestarts `0` / ActiveState active / commit `a5e0a67…` | ○ |
| 本番 dry-run release・current 無し・prod unit 無し | `releases/20261106T071603-e7d7f6f9dc94` のみ、`current` ABSENT、`ai-helpdesk-prod-api.service` ABSENT | ○ |
| `--unit-template` は未マージ | `scripts/deploy-release.sh` に `unit-template` の記述なし | ○ |

**1 点だけ訂正**: 「3 timer enabled/**実行 success**」のうち、**実行実績が観測できたのは stg-healthcheck のみ**（LAST `08:27:55`）。`tunnel-watch` は稼働中（LAST `08:26:48`）。一方 **`ai-helpdesk-stg-backup.timer` と `ai-helpdesk-stg-restore-drill.timer` は enabled だが LAST が `-`（未実行）**で、次回がそれぞれ 11-07 03:10 / 11-08 04:37。したがって backup / restore-drill の「success」は現時点では未観測である（enabled であることは確認）。

---

## 2. runbook が新ツールに依存しているか（Lead 指示の確認）

`docs/82` 全文を `grep` した結果、**`unit-template` / `stg-healthcheck` / `restore-drill` / `--keep` / `46261ea` のいずれも出現しない**。

- したがって「未マージの `--unit-template` に依存している」という問題は**現時点では発生していない**。
- ただし **改訂で C-1 を `--unit-template` で解決する方針を採るなら、その PR が未マージである間は runbook が実行不能になる**。改訂時は「依存する未マージ PR 番号」を runbook 内に明記し、マージ順序を固定すること。

---

## 3. 前回指摘の PASS/FAIL（PR 側の解消度）

判定基準: PASS = runbook 本文に解消が確認できる／FAIL = 本文が同一のため未解消。

### Critical

| # | 指摘 | 判定 | 再実測による補足 |
|---|---|---|---|
| C-1 | 区分 C に実配備手順が無い（`--dry-run` のみ、`current` 未生成） | **FAIL** | main `46261ea` の `deploy-release.sh` でも **L214-218 の dry-run 早期 exit → L220 で `switch_to`** の構造は不変。`/home/kensan/ai-helpdesk-prod/current` は現在も ABSENT。runbook L111-118 は依然 dry-run のみ |
| C-2 | 受入 C-1 の `commit` 供給元が未記載（本番は `api.conf` の `COMMIT_SHA` 由来） | **FAIL** | 本番 health は依然 `a5e0a67…`（`api.conf` の値と一致）。runbook L121 の新 unit 定義は `WorkingDirectory`/`PORT` のみで `release.env` を読む記述なし |

### High

| # | 指摘 | 判定 | 再実測による補足 |
|---|---|---|---|
| H-1 | 旧 unit の disable と proxy `Wants=` の二次リスク | **FAIL** | `ai-helpdesk-api` は enabled のまま、`ai-helpdesk-prod-api` は ABSENT。proxy unit の `Wants=ai-helpdesk-api.service` も不変 |
| H-2 | C-3 / C-4 / C-6 が観測不能 | **FAIL** | 本文 unchanged。（観測手段は §4-2 のとおり新規に存在するが未使用） |
| H-3 | B が docs/77 §6-2 より劣化（事前確認・0600・validate・daemon-reload・enable・禁止事項） | **FAIL** | 本文 unchanged |
| H-4 | `ACCESS_AUD` / `ACCESS_TEAM_DOMAIN` の設定 step が無い（B-4 を満たせない） | **FAIL** | 本文 unchanged。stg-api.conf にも当該キーは無いまま |
| H-5 | C が docs/77 §4-6 の fail-closed 条件に違反／実装にガードが無い | **FAIL** | `deploy-release.sh` の差分は #144 の manifest 再検証追加のみで、**ガードは依然未実装**（`--repo` 本番 checkout・`-stg-` 無し unit・port 18950 を拒否しない） |
| H-6 | rollback が symlink を戻さない（docs/77 §4-4 と不一致） | **FAIL** | `deploy-release.sh` L220 `switch_to` 直後 L223 が `fail "restart failed for $UNIT"` で**即終了し symlink を戻さない**構造は不変。runbook L129-131 も `current` に触れないまま |

### Medium / Low

| # | 指摘 | 判定 | 補足 |
|---|---|---|---|
| M-1 | §1「現状の実測値」が時刻を持たず陳腐化 | **FAIL（悪化）** | §1 の前提（main `e7d7f6f`、release `20261106T063553-359cbd…`、health commit 空、proxy 未起動）は**すべて現在の実測と不一致**。main は `46261ea`、release は `20261106T082716-46261ea1eb31`、commit 一致、proxy 200。改訂では表の全面的な更新が必要 |
| M-2 | A が生成物を手編集／stg-api を enable しない | **FAIL（実害を実測）** | `systemctl --user is-enabled ai-helpdesk-stg-api` = **`disabled`**（proxy は `enabled`）。runbook の A 完了後も再起動で staging API は起動しない |
| M-3 | `--dry-run` は unit 不在を検出できず §5-1 が誤った安心 | **FAIL** | dry-run が `systemctl` を呼ばない構造は不変。本番 dry-run release は `e7d7f6f` 時点のままで、`46261ea` では未取得 |
| M-4 | `--unit`/`--health-port` が dry-run で無効／二重の流儀 | **FAIL** | 本文 unchanged |
| M-5 | C の本番影響記述が過小（DB 不変の記述自体は正しい） | **FAIL** | DB 差分ゼロ（`db/migrations` 037 まで）は再確認済みで記述は妥当。unit/enable の過小評価のみ未修正 |
| M-6 | B の rollback に tunnel delete・資格情報削除が無い | **FAIL** | 本文 unchanged |
| M-7 | B-5 が構造ではなく計数のみ | **FAIL** | 本文 unchanged |
| L-1 | `--ref` は 40 hex 固定の明記なし | **FAIL** | 本文 unchanged |
| L-2 | `cloudflared tunnel login` 前提の記載なし | **FAIL** | 本文 unchanged |
| L-3 | bundle 同梱の引用先が docs/78 §1（正しくは docs/77 §4-3） | **FAIL** | 本文 unchanged |
| L-4 | A-5 の基準値が docs/81 §6-1 を参照していない | **FAIL** | 本文 unchanged |
| L-5 | dry-run release が prune されない | **FAIL** | `prune_releases` は成功分岐（L229）のみ。不変 |
| L-6 | A-4 の 401 の理由が曖昧 | **FAIL** | 本文 unchanged |

**集計: PASS 0 / FAIL 21（Critical 2, High 6, Medium 7, Low 6）。**

---

## 4. main 側の変化が各指摘に与えた影響

### 4-1. 根拠を再確認したもの（指摘は維持）

- C-1 / H-6 / M-3 / M-4 / L-5: `deploy-release.sh` の該当箇所（L214-218 dry-run exit、L220-223 switch 後 fail、L229 prune）は `46261ea` でも同一。**前回の行番号・挙動の記述は現在も有効**。
- H-5: #144 は「read-only 後の manifest 再検証」を追加しただけで、docs/77 §4-6 のガードは追加されていない。
- M-5: `db/migrations` は 037 のままで、C の「DB は変更しない」は妥当。過小評価は unit/enable 側のみ。

### 4-2. 修正の難易度が下がったもの（ただし runbook 未反映）

1. **H-2（C-6 の観測不能）**: #145 で `scripts/stg-healthcheck.sh` が追加され、**health の `commit` を current release の `dist-manifest.json` の commit と突き合わせ、不一致なら exit 1** する実装になっている（L34-68）。C-6 は「tunnel-watch が `ok`」ではなく、この healthcheck の `systemctl --user show -p Result` / log で受入を書ける。runbook は未参照。
2. **H-2（C-4 の監査）**: `scripts/audit-find-breaks.ts` は従前から存在。加えて #145 の restore-drill により復元手順が自動化され、Lead が実測した「fresh dump 復元・35 table 行数一致・migration 37」という基準値も揃った。受入条件に具体的な数値とコマンドを書ける材料が揃っている。
3. **M-1（§1 の陳腐化）**: A は既に実環境で完了しており、A-1〜A-5 の実測値がそのまま「実施済み証跡」として §6 に転記できる状態にある（下記 4-3）。

### 4-3. 新規指摘（今回追加）

#### M-8. §6「実行記録」が実態と乖離し、区分 A の証跡帰属が不明

- runbook §6（L160-164）は「— / 未実行 / —」のまま。しかし実環境では A の受入項目が成立している:
  - A-1: `commit = 46261ea1eb31…`（`359cbd…` から前進し、release と一致）
  - A-2: `ok:true` / `db:"ok"` / `env:"production"`
  - A-3: `GET 127.0.0.1:18951/api/health` = **200**
  - A-4: `GET 127.0.0.1:18952/api/me` = **401**
  - A-5: 本番 MainPID `2379216` / NRestarts `0` / commit `a5e0a67…` で不変
- つまり **A は実行済み**だが、runbook は「未実行」と主張し続けている。実施者・実施時刻・対象 release の記録が無いため、誰の作業がどの受入を通したのか追跡できない。
- 併せて、A の完了条件に **`ai-helpdesk-stg-api` が `disabled`** である事実が反映されていない（M-2）。「Staging を整えた」と読める状態ではない。

#### L-7. §1 の Staging release パスが 1 世代古い

- §1 L26 は `releases/20261106T063553-359cbd012274` を指すが、`current` は `20261106T082716-46261ea1eb31`。runbook 内の唯一の具体パスが現行と異なるため、コマンド例に流用されると事故になる。

---

## 5. 改訂時に見るべきチェックリスト（次回レビューの判定基準）

head が変わったら、以下を上から順に確認する。

1. **C の実配備 step**: `--dry-run` を外した実行が明記され、`current` が作られることが読み取れるか。`deploy-release.sh` の実挙動（dry-run は切替なし）と矛盾しないか。
2. **新 unit の全文**: `ExecStart` の絶対 node パス、`EnvironmentFile=<root>/current/release.env` が **`api.conf` の後**、`WorkingDirectory`、`PORT`。加えて `api.conf` の `COMMIT_SHA` の扱い（削除 or release 由来へ一本化）が書かれているか。
3. **unit 交代**: `disable ai-helpdesk-api` / `enable ai-helpdesk-prod-api` と、proxy の `Wants=` への言及。
4. **rollback**: `current` を previous へ戻す（symlink 操作）ことが明記されているか。`restart` 失敗時に symlink が戻らない実装穴への対処。
5. **受入の観測性**: C-3 は画面 URL 3 本、C-4 は `audit-find-breaks.ts` のコマンドと基準値、C-6 は `stg-healthcheck` / tunnel-watch の読み方と比較対象。
6. **B**: docs/77 §6-2 の 5 項目（事前確認・heredoc・`chmod 600`・`ingress validate`・`daemon-reload`+`enable`+禁止事項）と `ACCESS_AUD`/`ACCESS_TEAM_DOMAIN` の設定 step。
7. **未マージ依存**: `--unit-template` 等に依存するなら PR 番号とマージ順を明記。未マージなら実行不可と書く。
8. **§1 / §6 の更新**: 測定時刻と取得コマンド付きの現状値、A の実施記録。

---

## 6. 再現コマンド（read-only）

```bash
# 改訂の有無（最初にこれを見る）
gh pr view 142 --json headRefOid,updatedAt,commits
git ls-remote origin 'refs/heads/docs/promotion-runbook-20261106'
git show 1019e1e:docs/82-promotion-runbook-20261106.md | sha256sum   # 期待: c2129253…

# 実装側の不変点
grep -n "DRY_RUN\|switch_to\|restart failed\|prune_releases\|unit-template" scripts/deploy-release.sh
sed -n '210,235p' scripts/deploy-release.sh

# 本番
test -e /home/kensan/ai-helpdesk-prod/current && echo EXISTS || echo ABSENT
test -f ~/.config/systemd/user/ai-helpdesk-prod-api.service && echo EXISTS || echo ABSENT
ls -1 /home/kensan/ai-helpdesk-prod/releases/
systemctl --user show ai-helpdesk-api -p MainPID -p NRestarts -p ActiveState

# Staging 受入
curl -sS -m4 --noproxy '*' http://127.0.0.1:18952/api/health
curl -sS -m4 --noproxy '*' -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18951/api/health
curl -sS -m4 --noproxy '*' -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18952/api/me
readlink -f /home/kensan/ai-helpdesk-stg/current
stat -c '%a %n' /home/kensan/ai-helpdesk-stg/current/apps/api/dist/index.js
for u in ai-helpdesk-stg-api ai-helpdesk-stg-proxy ai-helpdesk-stg-backup.timer \
         ai-helpdesk-stg-restore-drill.timer ai-helpdesk-stg-healthcheck.timer; do
  printf '%s: ' "$u"; systemctl --user is-enabled "$u"; done
systemctl --user list-timers --all | grep -Ei 'helpdesk'
```

## 7. 限界

- task-6 の禁止事項は `systemctl` を含むが、Lead の指示で前提が更新されたため、**read-only の `show` / `is-enabled` / `list-timers` のみ**を使用した。`start` / `stop` / `restart` / `enable` / `disable` は一切実行していない。
- 本番 unit の切替は未実行。C-1 の不成立は「実装読解＋`current` 不在の実測」による判定であり、実際に起動して確認したものではない。
- PR が未更新のため、**改訂内容そのものに対するレビューは行っていない**。本 doc は「未更新の確認」と「改訂時に検証すべき基準の固定」である。
