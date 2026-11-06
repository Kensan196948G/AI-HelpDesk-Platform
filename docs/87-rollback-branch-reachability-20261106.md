# 87. rollback 分岐の到達検証（2026-11-06 JST）

## 0. 結論

`deploy-release.sh` の **`restart-failed` 分岐を実地で到達させ、`current` が直前 release へ戻ることを確認**した。staging のみで実施し、本番には触れていない。稼働中の staging は無傷（health 200 / NRestarts 0）。

| 分岐 | 到達方法 | 結果 |
|---|---|---|
| health 不合格 → rollback | ExecStart を存在しないパスへ差し替え（docs/86） | `rollback-failed` を記録、symlink 復元 OK |
| **`restart-failed` → rollback** | **存在しない unit 名を `--unit` に渡す**（本記録） | **`restart-failed` を記録、symlink 復元 OK** |
| `success` | 通常配備 | 記録済み（docs/85・86） |

## 1. 試行 1: unit を mask しても `restart` は失敗しない

```
$ systemctl --user mask ai-helpdesk-stg-api
$ systemctl --user restart ai-helpdesk-stg-api
restart RC=0
```

**mask は「以後のロード」を止めるが、既にロード済みの unit の `restart` は成功する。** したがって mask では `restart-failed` 分岐に到達できない。この試行では deploy が成功し、staging は main の release へ進んだ（意図しないが無害。以降の基準になった）。

## 2. 試行 2: 存在しない unit 名で `restart` を失敗させる

```
$ systemctl --user restart ai-helpdesk-stg-nonexistent-drill
Failed to restart ...: Unit ai-helpdesk-stg-nonexistent-drill.service not found.
restart RC=5
```

この条件で `deploy-release.sh --unit ai-helpdesk-stg-nonexistent-drill` を実行:

| 事象 | 結果 |
|---|---|
| deploy 出力 | `ERROR: restart failed for ai-helpdesk-stg-nonexistent-drill; rolling back current` |
| deploy RC | **1** |
| **current** | **直前 release（`20261106T123305-0dbb1b7bb704`）へ復元** |
| deploy state | **`result: "restart-failed"`**、`previous` は直前 release |
| staging 本体 | health 200 / unit active / MainPID 173518 / NRestarts 0（**無傷**） |

`--unit` が別名なので、稼働中の `ai-helpdesk-stg-api` には一切触れていない。

## 3. 何が確認できたか

1. `systemctl restart` の失敗（= unit が存在しない／ロードできない）を検知すると、**`current` を直前 release へ戻す**（#146 の修正が効いている）。
2. その状態を **`restart-failed`** として記録する。`success` とも `rolled-back` とも混同しない。
3. 稼働中の別 unit には影響しない（`--unit` の取り違えは配備先を壊し得るが、symlink は戻るため被害は局所）。

## 4. runbook への反映

`docs/82` §4-10 の判定表に「`restart-failed` の到達条件」を追記した。

- **到達する**: `--unit` の unit が存在しない／ロードできない（`systemctl restart` が非 0）。
- **到達しない**: `ExecStart` の実行ファイルが無いだけ（`Type=simple` は started とみなす）、unit を mask しただけ（ロード済みなら restart は成功）。
- したがって実運用で `restart-failed` が出たら、まず **unit 名・unit ファイルの存在**を疑う。

## 5. 限界

- 本検証は **staging** で行った。本番での `restart-failed` は未発生。
- `--unit` の取り違えを **事前に検出するガードは未実装**（`deploy-release.sh` は unit 名の形式しか検証しない）。実配備では `--unit` を固定値で渡しているが、将来の事故防止には「unit ファイルの存在確認」を追加するのが望ましい（別 PR 候補）。
- 試行 1 で staging が意図せず main へ進んだ。訓練は「稼働中の unit を止めない」設計にすべきで、本記録の試行 2 がその形である。
