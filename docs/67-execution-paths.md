# 67. 端末操作の 3 経路の責任範囲

相談から端末の操作へ進む経路は 3 つあり、**同等ではない**。この文書は、コードの事実と、それぞれに任せてよい範囲を記録する。

- 作成: 2026-11-01。対象は `verify/dataflow-assist-integration`（検証用の統合。#127 の検証統合に #120 と #117 を merge）。
- **実機の確認範囲は、この統合では増えていない。** 統合の後に実機は流していない。下の表の実機欄は、統合前の各ブランチの記録の引用である（docs/65 §0、docs/66 §5-1、docs/63 §14）。未確認を成功に数えない。
- 根拠は、特に書かない限りコードの読解である。受入の結果は [docs/evidence/assist-integration-20261101/](evidence/assist-integration-20261101/)。

## 1. 比較

| 項目 | ① 元ウィザード | ② resolve ループ | ③ 支援セッションの本人ヘルパー（#120） |
|---|---|---|---|
| 入口 | 原本 HTML の STEP と決定ルール（`H.*`）、提案カード | `resolve-bridge.js` のカード、`/api/resolve/*`。印刷の相談から誘導（#126） | 引継ぎを引き受けた担当者が `POST /api/support-sessions` で開始。**ウィザードからは入らない** |
| 対象の確定 | しない（デモの端末）。例外の `ACT.realExec` は本人の端末在庫 | `deviceId` が本人の `device_inventories` にあること（`ownsDevice`）。ブラウザの端末 ID と、デバイストークンの `x-device-id` の一致 | 貸与情報（Mirai-Info）と RSP で端末を確定し、MachineGuid をヘルパーの申告と照合（docs/62 §4）。候補 0 件、複数、競合、古い情報は留まる |
| 本人認証 | Access（または `AUTH_MODE=local`） | 画面は Access。案件の所有者を `findOwnedCase` で確認。端末側は**デバイストークンだけ** | 画面は Access + 案件の `owner_email`。端末側は導入コード + ペアリングコード + ヘルパートークン |
| Windows ユーザーの照合 | なし | **なし。** トークンの持ち主のメールと相談者は一致を見るが、実行している Windows ユーザーが相談者かは見ない。`command-agent.ps1` は SYSTEM などを拒否するだけ | あり。ヘルパーが本人セッションの SID を取得し、本人が Access の画面でペアリングコードを入力して `(device, SID, sessionId)` と結び付ける。`/start` と結果の `actorSid` を照合（不一致は `SID_MISMATCH`） |
| 同意 | 画面の状態のみ | 操作ごとの Y/N のみ。範囲の同意、AI 入力の同意は無い | フォルダ同意、操作範囲の同意、AI 入力の同意、操作ごとの Y/N を分離（docs/63 §2） |
| 承認の束縛 | サーバで検証しない（「実行前検証」は表示）。`ACT.realExec` は固定の op だけ | 12 キー: セッション、ステップ、順番、Skill の ID・版・contentHash、params、deviceId、userEmail、riskLevel、nonce、期限。**SID、同意、端末実体、scriptHash を含まない** | ②の項目に加えて SID、Windows セッション、MachineGuid、helperId、各同意の ID・版・期限、担当者、scriptHash、確認操作の定義（docs/63 §5）。保存値を信じず毎回組み立てる |
| 承認の期限 | - | 5 分。セッションは 30 分、6 提案。リスク 4 以上は IT 管理者の承認（別ハッシュ）。リスク 5 は実行しない | 5 分。セッションは 30 分、6 提案。nonce は 2 段（Y と `/start`）。高リスクは**カタログから除外**（管理者承認は未実装） |
| 実行器 | 模擬。例外は `ACT.realExec` → `POST /api/device/command`（`SPOOLER_RESTART`） | `device_commands` + `endpoint-command-agent.mjs` または `command-agent.ps1`。実行直前に `approved.json` の id@version、contentHash、scriptHash を照合 | `folder-helper.ps1` のみ。`device_commands` と RSP へ配送しない。Job Object で停止。実行記録を CreateNew で書き、再実行しない |
| 出所の記録 | 「実行しました（模擬）」の表示 | `executionSource`（`endpoint_agent` / `mock` / `unknown`）。本番相当は `mock` を拒否（Access の認証でも本番相当とみなす） | `execution_mode`（real / mock / manual）、`result_source`、`phase`、`verification`。`real` は報告の出所で、実行の有無を示さない。本番は `real` 以外を拒否 |
| 停止 | 画面の緊急停止（`estop`） | N、`/stop`、`estop`、期限切れで未配送を取消。**実行中の子プロセスを止める指示は無い**（タイムアウト 60 秒まで） | N、取消、中止、期限切れ、担当変更、ログオフ、SID・セッション変更を全経路へ伝搬。実行中は `stop_requested` と `stopped` / `stop_failed` を分けて記録（docs/63 §10）。`ASSIST_SESSION_MODE` の off / drain |
| 対象の Skill | 定義済みの操作（模擬）と `SPOOLER_RESTART` | `SKILL_CATALOG` の承認済み。`command-agent.ps1` は standard の 8 件（docs/66 §1） | 専用カタログ。`folder.summary`、`disk.space`。`user.marker.*` は検証用 manifest のみ |
| 症状の判定 | 原本の決定ルール | `detectIntent` と Skill の `symptoms`。**#120 の否定・解消の写像（`case-facts.ts`）を通らない** | `case-facts.ts`（否定、解消、過去形、複数症状）。AI へ渡すのは固定の語彙だけ |
| AI の解決の断定 | 使わない | `aiRationale` は伏せ字と長さの制限だけ。**`acceptAiExplanation` を通らない** | `acceptAiExplanation` で拒否（`AI_EXPLANATION_REJECTED`） |
| KB の参照 | デモの固定データ。自由記述の `/api/ai/answer` は DB の KB | `findApprovedKnowledge`（別人の承認、承認後の更新なし）。本文の要約を AI へ渡す | 固定の症状タグと ID だけを AI へ渡す。この統合で ②と同じ条件へ揃えた（§3） |
| 既定のフラグ | なし（常に配信） | **なし。** API も画面も常に有効。カードの表示条件は `agentConnected` だけ | `FOLDER_ACCESS_ENABLED=false`、`ASSIST_SESSION_ENABLED=false`（無効の間は全 API が 404、画面の導線なし） |
| main での状態 | あり | API と `resolve-bridge.js` はあり。印刷の相談からの誘導（#126）は未マージ | 無し（Draft） |
| 実機の確認範囲（統合前の記録） | `SPOOLER_RESTART` の実機の記録は見つからない（docs/65 §3） | Windows PowerShell 5.1 の検証端末 1 台で `spooler.status` のみ。`AUTH_MODE=local`、ヘッドレス画面、合成の名簿、合成の相談文。変更系は未実行（docs/65 §0、docs/66 §5-1） | 検証端末 1 台。ヘッダ注入で実画面ではない。`folder.summary`、`disk.space`、`user.marker.set` / `clear`。`FOLDER_ACCESS_ALLOW_UNVERIFIED_LEASE=true`。**貸与照合から端末操作までの 1 本通し、ログオフ時の停止、ローカル保持期限の自己消去、`drain` と `off` の切替、実ブラウザは未確認**（docs/63 §13、§14-2） |

## 2. 方針の案と、コードの事実との矛盾

依頼時の案は次のとおりである。

- 読取診断の最小経路は ②。デバイストークンのみで相談者と Windows ユーザーを照合しないので検証専用。本番の相談者へは出さない。
- 本人照合が要る正式経路は ③。
- ① は実行に使わない。

### 2-1. 矛盾する点

| 案 | コードの事実 | 判定 |
|---|---|---|
| ② は検証専用で、本番の相談者へ出さない | ②には機能フラグが無い。#126 の誘導は、印刷の相談で `agentConnected` が真なら相談者にカードを出す（`resolve-bridge.js` の `printGuideHtml`）。`/api/resolve/*` は `authenticateUi` だけで開く。**本番の印刷の相談から誘導されないのは #126 が未マージだからで、フラグが止めているのではない。** `agentConnected` は本人とこの端末 ID の standard トークンの `last_used_at` が 120 秒以内かで決まる。コマンドエージェントのトークンに限らないので、端末情報の収集タスクのトークンでも真になりうる（本番のトークンの状況は見ていない） | **案のままでは守れない**。#126 を main へ入れると、条件を満たす相談者に出る |
| ③ が本人照合の正式経路 | 照合の仕組みはあるが、実機は `FOLDER_ACCESS_ALLOW_UNVERIFIED_LEASE=true` でしか通していない。貸与照合から端末操作までの 1 本は未確認（`RSP_AGENT_OFFLINE` で停止した記録まで） | 設計は案のとおり。**正式経路と呼べるのは実機の確認の後** |
| ③ が相談者の読取診断を担う | ③ は担当者が引継ぎを引き受けてから始まる。セッションごとにヘルパーの再導入が要る。ウィザードの相談から直接は入らない | ②の置き換えにならない。**相談の直後の自己解決には使えない** |
| ① は実行に使わない | 原本の `ACT.realExec` が残り、提案カードから `POST /api/device/command` へ届く。この統合では印刷の提案カードが出ないので入口が無いが、API は残る（docs/65 §3） | 画面の入口は無いが、API は閉じていない |

### 2-2. 代案（未実装、判断が必要）

1. **②にフラグを足してから #126 を main へ入れる。** 例: 既定無効の `RESOLVE_REQUESTER_ENABLED`。無効の間は印刷の相談で `no-agent` と同じ案内を出し、`POST /api/resolve/sessions` を 404 にする。この PR では実装しない（#126 の範囲で、検証の結果を変えるため）。
2. **②を残すなら、ペアリングを足す。** ③の導入コードとペアリングの部品を流用し、`device_tokens` に SID を束縛する。**案のうち「照合しないから検証専用」の理由が無くなるが、作業量が大きい。**
3. **ウィザードから ③ へ入る導線は、実機の確認の後に別途決める。** ヘルパーの導入の手間が相談者に残るので、自己解決の経路としてよいかは人の判断である。

**推奨:** 1 を main へ入れる前の必須条件とし、当面の方針は「②は検証環境のみ（フラグで強制）」「③は開発中で、実機の確認まで正式経路と呼ばない」「①は実行に使わず、`ACT.realExec` は別途閉じるか判断する」とする。

## 3. この統合で ② と ③ の間に足したもの

- **③ の KB の参照の条件を ② に揃えた。** #120 の入力は `status='approved'` だけで選んでいたので、自己承認や承認後に更新された行の ID とタグが AI へ渡っていた。`findApprovedKnowledge` と同じ条件（承認者あり、別人、承認後の更新なし）にした。
- **固定症状タグを KB の承認の指紋に含めた**（docs/64 §11）。

それ以外の ③ の対策は ② へ移していない。**統合しても ② の性質は変わらない。** 否定の写像、AI の断定の拒否、`phase` / `verification`、`ASSIST_SESSION_MODE`、ローカル保持期限の `folder-helper.ps1` は、② の経路に効かない（受入表の「未接続」）。② 側のローカル保持期限は `command-agent.ps1` の別実装である（docs/66 §7）。

## 4. 記録しないこと

実端末の識別子、実ユーザー名、秘密の値はこの文書と証跡に書かない。
