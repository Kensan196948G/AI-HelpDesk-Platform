# 90. マージ後検証（2026-11-10 JST）

## 0. 結論

PR #156（[docs/89](89-round-20261110.md)）のマージ後、**既定ブランチの CI（push）**と**隔離 E2E（`verify:isolated`）**を実行し、どちらも成功した。本番・staging・本番 DB には触れていない。

| 検証 | 対象 | 結果 |
|---|---|---|
| 既定ブランチの CI（push） | `726cc64`（run 42838130093） | **success** |
| 隔離 E2E（新規 PG16 クラスタ） | `726cc64` | **exit 0 / 9 steps すべて PASS**、cleanup 済み |
| 証跡 | — | private `/tmp/aihd-verify.AdxP1nzv`（0700。リポジトリには含めない） |

## 1. 隔離 E2E の手順（実測）

```bash
# 検証対象の commit から専用 worktree を作り、依存を入れる
git worktree add /tmp/aihd-verify-wt -b fix/cto-followup-20261110 726cc64
cd /tmp/aihd-verify-wt && npm ci          # 0 vulnerabilities
bash scripts/verify-isolated.sh --ack-isolated-worktree
```

| 事象 | 実測 |
|---|---|
| 実行区間 | 2026-11-10 23:50:42 → 23:56:53（約 6 分 11 秒） |
| steps | `pure` / `migrate-first` / `migrate-second` / `typecheck` / `lint` / `test` / `build` / `dist-manifest` / `staging-smoke` の**9/9 PASS** |
| 隔離 | 新規 PG16 クラスタ（使い捨て）。既存の `.env`・DB・サービス・公開設定は読まない/変更しない |
| cleanup | `isolated PostgreSQL stopped; owned port closed` |
| 終了コード | 0 |
| 終了メッセージ | `PASS: isolated verification completed (not authenticated Staging acceptance)` |

後処理として **worktree と branch を削除**した（ローカルのみ。リモートへは push していない）。

## 2. 意味と限界

- **意味**: マージ後の commit に対して、migrate の冪等性・型・lint・全テスト・build・dist manifest・staging smoke が**隔離環境**で通ることを確認した。`dist-manifest` の step は新しい `--root` の実装を含む CLI で実行されている。
- **限界**:
  - 認証付き Staging の受入ではない（スクリプト自身が `not authenticated Staging acceptance` と表示する）。
  - 実 Access OTP・実機・本番配備は未実施。
  - 証跡ディレクトリは private `/tmp` であり、リポジトリには追加していない（実名を含み得るため）。
  - [docs/76](76-followup-20261106.md) の「clean tree 再実行の記録枠」は当時の commit に対する枠であり、本記録は `726cc64` に対する**別の記録**である。当時の枠を遡って埋めてはいない。

## 3. 参照

- PR: [#156](https://github.com/Kensan196948G/AI-HelpDesk-Platform/pull/156)（Squash Merge `726cc64`、2026-11-10T14:50:06Z）
- ラウンド記録: [docs/89](89-round-20261110.md)
- 本番切替と未実施項目: [docs/85](85-production-cutover-20261106.md) §6
