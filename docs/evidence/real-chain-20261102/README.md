# 実機の後に入れた修正の確認（2026-11-02、`90cba01`）

前回（`ae9bcce`、[real-chain-20261101](../real-chain-20261101/)）の後に入れた修正を、同じ Windows 実機で確かめた。結果の読み方は [docs/65 §0-1](../../65-readme-dataflow-map.md)。

- `result.json`: 段ごとの結果と ID。トークン、キー、トンネルの URL は含まない。
- 実 AI、実エージェント、PowerShell 5.1、非昇格。認証は `AUTH_MODE=local`、ブラウザはサーバ上のヘッドレス、Y は条件付きの事前承認（`spooler.status`、引数なし、読み取りのみを機械照合）。KB の公開承認は本文を提示した番号選択で、同じ人物の別アカウント（`shared_identity`）。**別人物の承認、Access、本人と Windows ユーザーの照合の確認にはならない。**

| 修正 | 方法 | 結果 |
|---|---|---|
| `ConfigPath` の既定値 | 設定を既定の場所へ置き、`-ConfigPath` なしで起動 | 接続し、Skill を実行した |
| 結果の取り込み | Y の直後に画面を離れた（`CASE-0003`） | 60 秒以内にコマンド `done`、結果が取り込まれ、タイムアウトにならない |
| 報告の分離 | 結果の報告だけ 503 にした（`CASE-0004`） | 報告は 1 回で止まり、コマンドは 1 件のまま `delivered`。30 秒後もエージェントは通信を続けた。2 分後に `RESULT_TIMEOUT`。**実行の結果が届かないので、この相談は失敗として閉じる** |
| 同一性の試験 | `script-identity-windows.ps1` | 17 件成功、失敗 0、SKIP 0、非昇格 |
| 一本通し | 相談から次の相談まで（`CASE-0002`、KB `KB-2026-0101` v2） | ID がすべて一致（`matchesRun=true`）。Spooler は別経路でも `Running`。次の相談の実 AI は KB を根拠に挙げた |

**確認できなかったこと:** エージェントのログの `report error` 行は読めなかった（エージェントがファイルを開いていて `ReadAllLines` が失敗し、続く後片付けで削除された）。報告の分離の判定はサーバ側の記録による。

**試験の注意:** `result.json` の `reportsAfterUnblock` は止めている間の数だけを数えるので、常に 0 で判定に使えない。再実行が無いことの根拠は `commandsAdded=1` と `commandStatus=delivered` である。

検証 DB、トンネル、端末のタスク、エージェント、トークン入りの設定は実行の後に削除した（端末で `task`、`agentDir`、`config`、`verifyDir` がすべて無いことを確認）。RSP の `command_logs` には導入コマンドが残る。デバイストークンは含まない。

実端末の識別子と実ユーザー名はこの文書と証跡に書かない。
