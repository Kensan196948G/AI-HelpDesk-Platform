# Phase 3 — D: 担当者対応（途中・2026-10-27 08:51 JST）

## F-01【High・要修正】引継ぎの受信箱と claim に権限チェックが無い
- 実測: 一般社員（MK0122）のセッションで `GET /api/case-handovers/inbox` が **DX 宛の引継ぎ2件を返し**、`POST /api/case-handovers/{id}/claim` が **HTTP 200 で引き受け成功**（宛先は MK0623 指名）。その後 B1（MK0623）の claim は 409 ALREADY_CLAIMED。
- コード: `apps/api/src/routes/case-handovers.ts` の inbox は `WHERE status IN ('pending','claimed')` のみ、claim は `claimed_by` と status のみ確認。**宛先・ロール（DX 推進部）の検証が無い**。
- 影響: 認証済みの任意の社員が、他者宛の引継ぎの内容（依頼者・件名）を閲覧し、横取りできる。
- 修正方針（Phase 6）: `authenticateUi` の後に「DX 推進部（staff）またはヘルプデスク/承認者ロール」を要求するガードを inbox・claim・approve に追加。名簿不能時は fail-closed。
- 証跡: 本ファイルの実測ログ、`case_handovers` の状態遷移（claim 後に pending へ戻して再現可能）。

## その他
- D-01（受信箱の分離）: **FAIL**（上記 F-01 により他担当にも表示・引き受け可能）。
- D-02（claim）: B1 では成功するが、F-01 のため「別担当が claim 済み → 409」の順序が逆転した（一般社員が先に claim）。

## 追記（09:00 JST）— D ケース実測
| ID | 検証内容 | 実測 | 判定 |
|---|---|---|---|
| D-02 | claim（B1） | 18957（DEV_AUTH_EMAIL=MK0623）で claim 200 → claimed / claimed_by=owner@*** | PASS |
| D-03 | 別担当が claim 済み | 一般社員から claim → 409 ALREADY_CLAIMED | PASS（ただし F-01 により順序は逆転可能） |
| D-05 | 引継ぎボード（3ペイン） | 左：引継ぎ待ち1/対応中4/解決3、未受領2。中：INC-1008 詳細＋次の一手＋担当者＋AIに聞く。右：AI引継ぎメモ＋RSP実行セッション | PASS |
| D-06 | B の AI 追加質問 | 案件コンテキストで回答（deepseek-flash・確信度低・根拠なし）。PC情報（エージェント未導入）を踏まえた補足あり | PASS |
| D-08 | 担当開始 | 「担当して対応開始」→ toast「担当を開始しました。」、INC-1008 が対応中・担当 ***、ボード件数が更新 | PASS |
| D-14 | 監査記録 | 引継ぎ claim は `prototype_states.helpdesk.audit` に記録。ただし **actor="system"** で、`audit_log` には新規行なし。claim が3回重複記録 | **FAIL（Medium）** |

## F-02【Medium】引継ぎ操作の監査がサーバ監査ログに出ず、actor が system
- claim・担当開始・AI追加質問は `prototype_states`（クライアント状態）の audit 配列にのみ記録され、サーバの `audit_log` には入らない。
- actor が "system" のため「誰が」が残らない（detail にメールはあるが、監査の主体としては不十分）。
- なお claim が同一操作で 3 行記録される（重複）。
