# 86. 再配備と rollback 訓練の記録（2026-11-06 JST）

## 0. 結論

| 実施 | 結果 |
|---|---|
| staging での restart 失敗 rollback 訓練 | **実施**。`current` は直前 release に戻り、`rollback-failed` を正しく記録。drop-in 除去後に復旧 |
| 本番の subsequent（再配備）モード | **成功**。release `20261106T121453-9a4eaccca62e` / commit `9a4eacc`。停止は **約 1 秒** |
| staging の再配備 | 成功。`9a4eacc` に一致 |
| C-3（実 Access ログイン後の UI） | **未実施**（人間のログインが必要。Access ログに ai-helpdesk の記録なし） |

## 1. staging の restart 失敗 rollback 訓練

### 1-1. 方法

staging の `ai-helpdesk-stg-api` に、**存在しない `ExecStart`** を指す drop-in を仕込み、`deploy-release.sh` に新 release を作らせて切替を試みた。本番には触れていない。終了時に drop-in を除去して復旧する `trap` を置いた。

```ini
[Service]
ExecStart=
ExecStart=/nonexistent/aihd-restart-failure-drill
```

### 1-2. 実測

| 事象 | 結果 |
|---|---|
| 訓練前の current | `releases/20261106T083747-4465f8d8905c`（commit `4465f8d`） |
| deploy RC | **1**（想定どおり失敗） |
| deploy の出力 | `ERROR: health check failed after switch; rolling back` → `ERROR: rollback release did not pass health either; manual action required` |
| **訓練後の current** | **`releases/20261106T083747-4465f8d8905c`（元に戻っている）** |
| deploy state | `result: "rollback-failed"`、`previous` は元の release |
| drop-in 除去後 | health 200 / commit `4465f8d` に復旧 |

### 1-3. 判明したこと（重要）

1. **`systemctl restart` は「起動しない ExecStart」でも 0 を返す。** `Type=simple` では systemd がプロセス起動直後に「started」とみなすため、`ExecStart` 先が存在しなくても restart 自体は成功扱いになる。したがって **`restart-failed` 分岐はこの方法では到達しない**。実際に踏むのは「restart は成功したが health が通らない」経路である。
2. **その経路でも `current` は正しく直前 release へ戻る。** 訓練後の `current` が元の release を指していることを実測した（H-6 の修正が効いている）。
3. **`rollback-failed` は「戻したが health も通らない」ことを正しく記録する。** drop-in が残っている間は旧 release も起動できないため、この状態は妥当。虚偽の成功を記録していない。
4. `restart-failed` 分岐は**未実行のまま**である（到達させるには unit 名の不在など別の条件が要る）。**未検証として残す。**

## 2. 本番の subsequent（再配備）

### 2-1. 実行

`current` が存在する状態での再配備。precheck port は使わず `--health-port 18950`。

```
deploy: OK 20261106T121453-9a4eaccca62e (commit=9a4eaccca62efdbbabc5d58126c2f772b3e4830d)
RC=0
```

### 2-2. 停止時間（実測）

| 事象 | 時刻 |
|---|---|
| `Stopping ai-helpdesk-prod-api` / `Stopped` | 12:15:09 |
| `Started` | 12:15:09 |
| 新プロセスが 18950 で listen | 12:15:10 |

**停止は約 1 秒。** §1 の bootstrap（1〜2 秒）と同水準。

### 2-3. 状態

| 項目 | 値 |
|---|---|
| release | `releases/20261106T121453-9a4eaccca62e` |
| commit | `9a4eaccca62efdbbabc5d58126c2f772b3e4830d` |
| previous（rollback 候補） | `releases/20261106T114603-625c3bec6aa3`（**保持されている**） |
| deploy state | `result: "success"`、`healthPort: 18950` |
| unit | active / enabled / MainPID 18626 / NRestarts 0 |

**subsequent では `previous` が残るため、`current` を戻して restart するだけで前 release へ復帰できる**（R-C2 の経路）。今回は訓練していない。

## 3. staging の再配備

`9a4eacc` へ更新（release `20261106T121523-9a4eaccca62e`）。訓練で作られた未使用 release と古い release は `prune_releases` が削除した。**staging の稼働 commit は main と一致**。

## 4. C-3（実 Access ログイン後の UI）— 未実施

- Cloudflare Access のアクセスログ（直近 300 件）に **`ai-helpdesk.mirai-dx-platform.com` の記録が 0 件**。本番アプリへの人間のログインは、少なくともこの期間には行われていない。
- したがって C-3（`/`・`/index.html`・`/api/state` が 200、主要 3 画面の描画）は**未実施のまま**である。**合格扱いにしない。**
- 完了させるには、人が `https://ai-helpdesk.mirai-dx-platform.com` に Access でログインし、3 画面を確認する必要がある。ログイン後は Access ログに `login / allowed=true` が残るため、実施の有無を第三者的に確認できる。

## 5. 学び（runbook / 実装への反映候補）

| # | 学び | 反映先 |
|---|---|---|
| L-1 | `systemctl restart` の成否では「サービスが立ち上がったか」を判定できない。health を正とする | docs/82 §4-8（既に health 判定が主） |
| L-2 | `restart-failed` 分岐は実環境で到達しにくい。**未検証**と明記する | 本記録 §1-3 |
| L-3 | rollback 訓練は「戻した先も壊れている」ケース（`rollback-failed`）まで見る必要がある | 本記録 §1-2 |
| L-4 | 訓練で作った release は `current` に切り替わらない場合があるため、prune の対象になることを確認する | 本記録 §3 |
