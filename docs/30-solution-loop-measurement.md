# 解決ループ（経路2）の実測（2026-10-25）

| 項目 | 値 |
|---|---|
| 目的 | 修復 Skill 承認後に、AI が実際に「解決」へ到達できるかを測る |
| 対象 | `/api/resolve/*`（経路2）。検証 DB `ai_helpdesk_verify`、検証インスタンス（loopback・別ポート） |
| 前提 | 修復7件は人間承認済み。`GET /api/resolve/skills` が **12 件**を返すことを実測 |
| 端末 | **Windows 実機なし**。`endpoint-command-agent.mjs --mock` の fixture で実行を代用（＝実行成功は模擬） |
| Y/N | ハーネスが**代行**（評価のため）。本人確認を要する `resolved` は代行しない |
| ケース | [cases.jsonl](../scripts/eval/cases.jsonl) の 30 件 |
| ハーネス | [run-loop-eval.mjs](../scripts/eval/run-loop-eval.mjs) |

---

## 1. 結果（実測）

| 指標 | 値 |
|---|---|
| 実行セッション | 30 |
| 最終状態が `escalated` | **30 / 30（100%）** |
| 最終状態が `resolved` | **0 / 30** |
| 停止理由 | `no_skill` **27** / `step_limit` **3** |
| ステップ合計 | 82（平均 2.73 / セッション） |
| 実行成功 | 82 / 82（**すべて mock**） |
| うち変更系（修復） | 23 ステップ（23 成功＝模擬） |
| 対処到達（変更系が成功したケース） | **15 / 30（50%）** |
| 診断止まり（読み取りのみで終了） | **15 / 30（50%）** |
| 誤選択 | **0**（判定対象 18 件すべて期待どおり、精度 1.00） |
| 提案の出所 | AI 66 / fallback 16 |
| HTTP エラー | 0 |
| レイテンシ（1 ケース） | p50 **7.7s** / p95 44.5s / max 48.3s |

### モード内訳

| モード | 件数 | 意味 |
|---|---|---|
| A（手順が無い） | 12 | 最初の提案で `no_skill`（KB 外・スコープ外・要人間手続き） |
| B（選べない） | 0 | 誤選択なし |
| C（直らない） | 0 | mock のため実行失敗は発生せず |
| D（引継ぎ） | 18 | 途中まで進んだが最後は引継ぎ |

---

## 2. 決定的な発見：**修復が成功しても「解決」にならない**

`kb-03`（印刷ジョブ）の実際の流れ:

```
1. spooler.status      (読取) done
2. spooler.restart     (修復) done  ← 直っているはず
3. spooler.queue.purge (修復) done  ← 直っているはず
4. os.info             (読取) done  ← まだ続ける
5. service.status      (読取) done  ← まだ続ける
6. disk.space          (読取) done  ← 上限
→ escalated (step_limit)
```

**問題は直っているのに、AI は「直った」と言えない。** だから診断を続け、上限に達して引継ぎになる。15 件の「対処到達」も、最終状態はすべて `escalated` である。

### 原因（コードで確認済み）

| 層 | 事実 |
|---|---|
| AI の出力契約 | `Proposal` は `{ skillId, params, rationale, source }` のみ。**設計 §8 の `stop` / `escalate` / `confidence` が未実装** |
| サーバ | `skills.verify` は保存・返却されるが、**一度も評価されていない**（`grep verify routes.ts` は SELECT と DTO のみ） |
| 結果 | 「成功したか」を判定する主体が存在しない → `no_skill` か `step_limit` まで進む → 必ず `escalated` |

これは**モデルの性能問題でも、ハーネスの問題でもない**。ループに終了条件が実装されていないのだ。

---

## 3. これが「AI の解決能力が低い」の正体

利用者から見ると、AI はこう振る舞う。

1. 症状を聞く
2. 端末を診断する（当たっている）
3. 修復を実行する（当たっている）
4. **「では担当者に引き継ぎます」と言う**

つまり **「調べて、直して、最後に『担当者へ』と言う」**。能力が低いのではなく、**成功を認識して終わる機能が無い**。前回の実測（[27](27-solution-gap-measurement.md)）で「変更 Skill が 0 件」だった穴を塞いだ結果、次の穴が露出した形である。

---

## 4. 修正の方向（未実装・設計判断が必要）

| # | 施策 | 内容 | 注意 |
|---|---|---|---|
| 1 | `verify` の評価 | 実行後にサーバが `verify` 条件を評価し、成功ならセッションを `waiting_continue` ではなく「解決候補」にする | 判定ロジックをサーバに置く（AI に任せない） |
| 2 | AI の終了宣言 | `Proposal` に `stop` / `escalate` を追加し、AI が「これ以上ない」と言えるようにする | 設計 §8 の実装。スキーマ変更 |
| 3 | `resolved` への遷移 | verify 成功 + 利用者の確認で `resolved` | **利用者の確認は必須**（自己申告で解決扱いにしない） |
| 4 | 重複提案の抑制 | 同一セッションで同じ診断を繰り返さない（今回 82 ステップのうち読み取り 59） | 既存の履歴による重複拒否を強化 |

1 と 2 は独立に実装できる。3 は業務定義（誰が「解決」を決めるか）の決定が必要。

---

## 5. この実測の限界（重要）

| 限界 | 内容 |
|---|---|
| 実行は模擬 | 端末は mock。`exit 3`（昇格）や PowerShell の実挙動は未検証 |
| Y/N は代行 | 人間の判断をハーネスが置き換えている |
| `resolved` を測っていない | 本人確認を要するため意図的に代行していない。したがって「解決率 0%」は**製品の解決率ではない** |
| ケースの偏り | KB 9 件由来。実問い合わせ分布とは異なる |
| レイテンシ | 1 セッション = 複数 AI 呼び出し。p95 44.5s は体感に直結する |

---

## 6. 次に測るべきこと

1. 施策 1・2 を実装した後、**同じ 30 ケース**で「対処到達かつ `resolved` に到達した率」を測る（比較可能な形で固定済み）
2. Windows 実機 1 台で `spooler.restart` の実実行と `exit 3` の挙動を確認
3. 管理者エージェント（privilege=admin）のサービス登録と疎通

---

## 7. Phase 5 実装後の再実測（2026-10-26）

### 7-1. 実装したもの

| # | 施策 | 実装 |
|---|---|---|
| 1 | `verify` の評価 | `evaluateVerify`（新規）。`{resultField,equals\|minimum}` のみ評価し、`{script,args,expect}` は `requires_followup` として**成功と見なさない**。結果は `resolution_steps.verify_result` に保存 |
| 2 | 終了条件 | 変更系ステップで `verify.ok=true` なら **AI を呼ばずに停止**し `awaitingResolution` を返す。再開は 409 `AWAITING_DECISION`。AI の `decision`（stop / escalate）も受理。**`resolved` への自動遷移はしない** |

### 7-2. 途中で見つけた誤分類（重要）

最初の実測では「解決候補」が 16 件と出たが、**12 件は誤り**だった。

- 判定が「rollback 定義あり」だけだったため、読み取り専用の `bitlocker.status`（rollback に「取消不要」の説明だけを持つ）が**変更系と誤認**された
- 「状態を読んだだけ」で解決候補に数えられていた

修正: **リスク 2 以上 かつ rollback 定義あり**を変更系とする（`isChangeSkillRow`）。回帰テスト 5 件を追加。
この結果、`dns.flush` / `defender.quickscan`（リスク 1）も解決トリガーから外れた。状態は変えるが、**問題の解決を意味しない**ため。

### 7-3. before / after（同一 30 ケース）

| 指標 | before | after | 変化 |
|---|---|---|---|
| 解決候補（verify 成功・判断待ち） | **0 / 30** | **4 / 30（13.3%）** | +4 |
| 引継ぎ（escalated） | 30 | 26 | −4 |
| ステップ合計 | 82 | **46** | **−44%** |
| 診断止まり | 15（50%） | **7（23.3%）** | −8 |
| 選択精度（どこかで一致） | 100%（18 件） | 100%（12 件） | — |
| 初手一致 | 未計測 | 75% | — |
| レイテンシ p50（1 ケース） | 7.7s | **4.0s** | −48% |
| 実行成功（mock） | 82/82 | 46/46 | — |

解決候補に到達した 4 件:

| ケース | 実行された Skill |
|---|---|
| kb-03（印刷） | spooler.status → spooler.restart → service.status → **spooler.queue.purge** |
| kb-12（印刷・口語） | 同上 |
| kb-14（PC が重い・口語） | os.info → disk.space → **temp.cleanup** |
| kb-22（更新＋重い） | os.info → disk.space → defender.quickscan → **temp.cleanup** |

### 7-4. 残っている最大のレバー

| 残課題 | 影響 | 対応 |
|---|---|---|
| **`script` 形態の verify が評価できない** | `spooler.restart` / `service.start` は成功しても停止できない（kb-19 / kb-24 が該当） | 確認用スクリプトの**追撃実行**（Phase D） |
| `temp.cleanup` の verify が弱い（`freedBytes >= 0` は常に真） | 解決候補が過大になり得る | Skill 定義の見直し（人間の承認が必要） |
| AI が修復に到達しないことがある | kb-05 は「PC が重い」で defender.quickscan を選び、temp.cleanup に至らなかった | 提案プロンプト／fallback ルールの改善 |
| UI が `awaitingResolution` 未対応 | `step:null` を受けて「escalated」と表示する（サーバ状態は waiting_continue） | `resolve-bridge.js` の改修（別タスク） |

### 7-5. 結論

「直ったことを認識して止まる」機能は**動作した**。ただし対象は verify を結果から評価できる 4 件に限られ、**13.3%** にとどまる。次の伸び幅はほぼ「`script` 形態 verify の追撃実行」にある。

---

## 8. Phase 6 実装後の最終実測（2026-10-26）

### 8-1. 実装したもの

| # | 施策 | 実装 |
|---|---|---|
| 1 | `script` 形態 verify の追撃実行 | 親（変更系）の verify が `requires_followup` のとき、`verify.script` と一致する **approved / risk_level=1** の Skill を**自動承認**で追撃ステップとして積み、端末で実行。結果を親の `verify_result` に反映（Migration 018）。自動承認は risk 1 のみ、追撃の追撃は禁止 |
| 2 | UI の `awaitingResolution` 対応 | 「原因の対処まで完了しました／解決しましたか？」カード。`解決した` / `担当者へ引き継ぐ` の2ボタン。409 `AWAITING_DECISION` も同カードに合流。XSS 対策（`textContent`）、二重送信防止、再読み込み復帰 |
| 3 | `temp.cleanup` の verify 強化 | `freedBytes >= 0`（常に真）→ **`deletedBytes >= 1`**（実際に削除できたか）。Skill 再承認済み |

### 8-2. 途中で見つけた結合ギャップ（Lead が修正）

追撃を入れた直後の実測で、**セッションが `executing` のまま固まる**事象を 1 ケースで再現した。

- 追撃コマンドの結果は、そのステップを**読んだとき**に反映される設計だった
- しかしクライアントは**親ステップ**をポーリングしており、追撃ステップの存在を知らない
- 結果、追撃コマンドが実行されても結果が反映されず、`continue` が 409 `STEP_NOT_CONTINUABLE` になる

修正: 親ステップの `GET /api/resolve/steps/:id` で**セッション実行中のステップも同期**し、応答に `activeStep` を追加。ハーネスと UI の双方が追従できるようにした。

### 8-3. before / after（同一 30 ケース）

| 指標 | 初期 | Phase 5 | **Phase 6** |
|---|---|---|---|
| 解決候補（verify 成功・判断待ち） | 0 / 30 | 4 / 30（13.3%） | **5 / 30（16.7%）** |
| 引継ぎ（escalated） | 30 | 26 | **25** |
| ステップ合計 | 82 | 46 | **41** |
| 診断止まり | 15（50%） | 7（23.3%） | 7（23.3%） |
| 追撃実行（verify follow-up） | — | — | **3 回** |
| レイテンシ p50（1 ケース） | 7.7s | 4.0s | **2.8s** |
| 選択精度（どこかで一致） | 100% | 100% | 100% |

解決候補に到達した 5 件:

| ケース | 実行された Skill |
|---|---|
| kb-03（印刷） | spooler.status → **spooler.restart** →（追撃 service.status） |
| kb-12（印刷・口語） | 同上 |
| kb-14（PC が重い・口語） | os.info → disk.space → **temp.cleanup** |
| kb-19（更新＋重い） | spooler.status → disk.space → service.status → **spooler.restart** →（追撃 service.status） |
| kb-22（更新＋重い） | os.info → disk.space → **temp.cleanup** |

kb-03 / kb-12 は追撃で `spooler.restart` の成功を確認できたため、`spooler.queue.purge`（取消不可）まで進まずに停止している。**危険度の高い操作をせずに解決候補へ到達**できた点は、安全設計上も意味がある。

### 8-4. 残課題

| 残課題 | 内容 |
|---|---|
| 16 件が依然として引継ぎ | 内訳は「AI が次の手を打てない」（no_next_step 16 件）。修復 Skill の不足（VPN 再接続、アプリ個別対応など）と、AI が修復に至らないケース（kb-05 は defender.quickscan を選択） |
| 実機検証なし | すべて mock。`exit 3`（昇格）・PowerShell の実挙動は未検証 |
| 管理者エージェント未配備 | privilege=admin のトークン発行とサービス登録が未実施（Windows 実機） |
| UI の実ブラウザ確認 | 静的・等価性検証のみ。実ブラウザでの目視は未実施 |
| 追撃評価が AI に渡らない | mismatch 時に AI が親の評価を材料にできない（次タスク） |

### 8-5. 到達点

初期（修復 Skill 0 件・終了条件なし）から、**「診断 → 修復 → 確認 → 解決したかの確認」までがプロダクトとして閉じた**。
数値は 5/30（16.7%）。残る 25 件の大半は「AI が次の手を持っていない」ことであり、モデルやハーネスの交換ではなく、**修復 Skill の追加と提案の改善**が次の伸び幅である。

---

## 9. Phase 7（修復Skill追加）と AI 提案改善の実測（2026-10-26）

### 9-1. 変更

| 変更 | 内容 |
|---|---|
| 修復 Skill 4 件追加 | `service.restart` / `network.adapter.restart` / `defender.update` / `recyclebin.clear`（カタログ 12 → 16） |
| AI カタログに `kind` を追加 | `repair`（risk>=2 かつ rollback あり）と `diagnose` を明示。AI が「診断」と「修復」を区別できず、診断 1〜2 回で引き継いでいた |
| プロンプト改善 | 「症状が repair で解消し得るなら、診断の後で必ず repair を 1 つ試す」「repair を試す前に escalate しない」 |

### 9-2. 実測（同一 30 ケース）

| 指標 | 初期 | Phase 5 | Phase 6 | Phase 7 | **+ AI 改善** |
|---|---|---|---|---|---|
| 解決候補（verify 成功・判断待ち） | 0 | 4 | 5 | 7 | **11 / 30（36.7%）** |
| 引継ぎ（escalated） | 30 | 26 | 25 | 23 | **19** |
| ステップ合計 | 82 | 46 | 41 | 43 | **38** |
| 診断止まり | 15 | 7 | 7 | 8 | 7 |
| レイテンシ p50 | 7.7s | 4.0s | 2.8s | 2.8s | **3.4s** |

改善したケース: `kb-04` `kb-13` `kb-20`（`network.adapter.restart` を選択）、`kb-05` `kb-14` `kb-21` `kb-22`（`temp.cleanup`）、`kb-19` `kb-24`（`spooler.restart`）。

### 9-3. 残る 19 件

| 分類 | 件数 | 内容 |
|---|---|---|
| 情報取得のみで完結（仕様） | 4 | `bitlocker.status` / `defender.quickscan`（risk 1 は解決トリガーにしない設計） |
| 修復 Skill が存在しない | 2 | Windows Update 再起動待ち（再起動は不可逆・影響大） |
| 診断後に修復へ進まない | 3 | `kb-01` `kb-10`（ネットワーク）ほか |
| 誤選択 | 1 | `kb-08` で `defender.update` を選択（`defender.quickscan` が期待） |
| KB 外・敵対 | 9 | 仕様どおり引継ぎ |

**「情報取得のみで完結する相談」を解決として扱うか**は業務判断（現在は risk 2 以上の変更のみを解決トリガーにしている）。
