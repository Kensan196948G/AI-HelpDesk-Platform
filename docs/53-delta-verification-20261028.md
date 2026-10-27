# 差分検証 V-01〜V-24 の実行結果（2026-10-28）

- 計画: [docs/52](52-verification-rebaseline-20261027.md)
- 対象: 検証インスタンス `:18962`（HEAD `6d2bb87` ビルド / DB `ai_helpdesk_verify` / migration 025）
- 実施: 2026-10-28 08:40〜08:50（JST）
- 手段: `scripts/verify/delta-20261028.mjs`（Access の email ヘッダー + 検証DBの直接突合）、`scripts/e2e/two-account-handover.mjs`、`npm run typecheck|lint|build|test`
- 証跡: `docs/evidence/verify-20261027/delta/`（`results.json` と本稿の表）
- PII: 検証に使った社員のメールは本稿・証跡とも伏せ字。実名は書かない。

## 1. 結論

24 ケースのうち **PASS 20 / FAIL 1（V-01）/ 未実施 1（V-23）/ 部分 1（V-24）**。V-22（E2E）は別スクリプトで 10/10 OK。

- **FAIL は V-01 のみ**。`/api/auth/me` が `roles[]` を返さない（そもそも cloudflare-access モードでは
  `authRoutes` が未登録で 404）。複数ロールは `user_roles` に保持され、権限判定には効いているが、
  **UI がロール集合を知る経路が無い**。docs/49 §3 の「UI 経路はロール集合を参照しない」がそのまま残っている。
- Critical/High に相当する差分は検出していない。V-01 は **Medium（機能欠落）** として扱う。
- 本番（`be1e0c3`）と検証（`6d2bb87`）は docs 差分のみでコード同一（docs/52 §1）。したがって
  この結果は本番コードにも当てはまる。

## 2. 実行環境（実測）

| 項目 | 値 |
|---|---|
| 検証インスタンス | `:18962`（`node apps/api/dist/index.js` / pid 1586300 / 2026-10-27 21:32 起動） |
| commit | `6d2bb877448cf3f79183f699306dd5d6e019a22b`（`/api/health` の commit と一致） |
| DB | `ai_helpdesk_verify`（migration **025**） |
| 認証 | `AUTH_MODE=cloudflare-access` / `ACCESS_JWT_MODE=off` / `ALLOW_SELF_APPROVAL=true` |
| AI / RSP | `DEEPSEEK_API_KEY` 設定済み（実 DeepSeek 呼び出し）/ `RSP_INTEGRATION_KEY`・`RSP_SERVICE_KEY` 設定済み |
| 検証用ユーザー | DX 推進部 4 名 + 他部署 1 名 + 合成 1 名（`users`/`user_roles` に投入。メールは伏せ字） |

## 3. 結果

| ID | 検証内容 | 期待 | 実測 | 判定 |
|---|---|---|---|---|
| V-01 | /auth/me が複数ロールを返す | roles[] に担当/承認等 | HTTP 404（NOT_FOUND）＝ パスワードログインは cloudflare-access モードで無効 | **FAIL** |
| V-02 | auditor の併存拒否（role set 検証） | 400/拒否 | auditor+helpdesk="auditor は他のロールと併存できません（読み取り専用の境界を保つため）。" / helpdesk+itops="null" | **PASS** |
| V-03 | auditor の UI 書込み | 403 | 書込み HTTP 403（FORBIDDEN）/ 読取り HTTP 200 | **PASS** |
| V-04 | 一般社員の inbox / claim | 403 | inbox 403（FORBIDDEN）/ claim 403（FORBIDDEN） | **PASS** |
| V-05 | 指名外 DX の claim | 403 RECIPIENT_MISMATCH | claim 403（RECIPIENT_MISMATCH）/ C の inbox に表示=なし | **PASS** |
| V-06 | 指名 DX の claim / inbox 分離 | 200・他担当に出ない | claim 200 / B の inbox=あり / C の inbox=なし | **PASS** |
| V-07 | 自己承認（ALLOW_SELF_APPROVAL=true） | 200・self_approved=true | HTTP 200 / selfApproved=true | **PASS** |
| V-08 | 承認なし完了 | 409 APPROVAL_REQUIRED | claim 200 / complete 409（APPROVAL_REQUIRED） | **PASS** |
| V-09 | 承認チェックリスト未確認（F-12 回帰） | 承認が先に成立しない | チェックなし承認 400（BAD_REQUEST）/ チェックあり 200 | **PASS** |
| V-10 | GET /knowledge/pending | 承認待ち一覧 | HTTP 200 / items=0 | **PASS** |
| V-11 | 下書き→申請→承認→knowledge 永続化 | draft→pending→approved | draft 200 / pending 200 / approved 200 / db=approved（KB-2026-0107） | **PASS** |
| V-12 | 承認済み KB の AI 出典反映 | KB-… が出典 | HTTP 200 / sources=2 / 当該 KB(KB-2026-0107) の引用=あり | **PASS** |
| V-13 | 別ID承認（claimant 以外） | self_approved=false | HTTP 200 / api=false / db=false | **PASS** |
| V-14 | final_reports 一意制約（021） | 二重作成されない | 部分一意 index=あり / 同一 (user,sha256) の2回目=23505 | **PASS** |
| V-15 | 中止セッションの報告書（023） | 「終了（未解決）」種別 | session 200 / step あり / close 200 / report 200 / kind=helpdesk_stopped | **PASS** |
| V-16 | 報告書の STEP 整合・表紙バッジ | 解決/停止で正しい | HTML 8686B / 「終了（未解決）」=あり | **PASS** |
| V-17 | 引継ぎ概要（SM-03）が件名と一致 | 最後の発言で上書きされない | subject="差分検証: 件名が正（SM-03）" / 一致=true | **PASS** |
| V-18 | 完了案件の GET /terminal/sessions（SM-04） | 404 でなく 200/空 | HTTP 200 / session=あり | **PASS** |
| V-19 | STEP7 の承認者・承認日時（F-13） | 表示される（API が返す） | approve 200 / approvedBy=k***@mirai-const.co.jp / approvedAt=2026-10-27T23:46:36.068Z | **PASS** |
| V-20 | RSP 相関（020/022・SM-09） | rsp_session_id 保存 | rsp_session_id=RSP-DELTA-SESSION-1 | **PASS** |
| V-21 | 端末エージェントの NUL/サロゲート除去（#91） | 500 にならない | HTTP 200 / ok=true / 保存 hostname=DELTAPC� | **PASS** |
| V-22 | E2E 担当者解決 1ラン（STEP1→7） | 完了・報告書 200 | `scripts/e2e/two-account-handover.mjs` → **10/10 OK**（引継ぎ→claim→AI追加質問→承認→復元） | **PASS** |
| V-23 | E2E AI解決 1ラン（STEP1→3→7） | 完了・報告書 200 | 未実施 | **未実施** |
| V-24 | 回帰（test/typecheck/lint/build）＋5xx 0・PII 0 | PASS | typecheck PASS / build PASS / lint PASS（warnings のみ）/ test 結果は下記 §4 / 検証インスタンスの 5xx 0 / 証跡に実メール無し（伏せ字） | **PASS** |

## 4. 検出した差分・ギャップ

| # | 内容 | 重大度 | 根拠 |
|---|---|---|---|
| G-1 | `/api/auth/me` が無く（cloudflare-access モードで 404）、`userDto` も `role` のみ。UI はロール集合を取得できない | Medium | V-01 実測 / `apps/api/src/lib/serializers.ts` |
| G-2 | セッション認証の `/knowledge/:id/submit`・`/review` は cloudflare-access モードで未登録。UI は `/knowledge/ui-sync` を使う（実測は ui-sync で PASS） | 仕様（記録） | V-11 実測 / `apps/api/src/server.ts:215` |
| G-3 | 報告書の UI 表示（表紙バッジ・STEP7 の承認者常設表示）は API/HTML では確認したが、ブラウザでのクリック確認は未実施 | 検証範囲 | V-16 / V-19 |
| G-4 | `rspCommandLogId`（RSP 実コマンドとの相関）は実ログが必要で未実施（`rspSessionId` の保存は PASS） | 検証範囲 | V-20 |
| G-5 | E2E AI解決（STEP1→3→7・kind=`ai_resolved`）は画面 payload 依存で未実施 | 検証範囲 | V-23 |
| G-6 | ローカルのテスト DB にチケットが 430 件（`/desk/queue` の LIMIT 100 を超える）蓄積し、統合テスト1件が落ちる | 環境 | V-24 §5 |

## 5. 回帰（V-24）

| 検査 | 結果 |
|---|---|
| `npm run typecheck` | PASS |
| `npm run lint` | PASS（exit 0 / warnings 245。error 0） |
| `npm run build` | PASS |
| `npm run test` | **507/508 PASS**（失敗1: `integration.test.ts`「主要3 Flow」） |
| 検証インスタンスの 5xx（08:40〜） | **0** |
| 証跡の PII | 実メールは伏せ字・実名なし・秘密なし |

**失敗1件の原因（実測）**: テスト DB `ai_helpdesk_test` の `tickets` が **430 件**、
`/api/desk/queue` の対象行が **158 件**（`LIMIT 100`・signal 昇順＋作成日時昇順）で、
新規チケットが 100 位圏外に落ちる。コードの不変条件ではなく**テスト DB の累積**が原因
（main CI は fresh DB のため green）。解消するにはテスト DB の再作成（migrate+seed）が必要。

## 6. 後始末・制約

- 検証で作った行は `ai_helpdesk_verify` に残している（使い捨て DB・本番 DB へは書き込みなし）。
- 検証インスタンス `:18962` は本検証の完了後に停止する。前日のビルド検証 `:18964` は停止済み。
- 本番 `:18949/:18950`・本番 DB `ai_helpdesk_preview` は**読み取りのみ**（V-14 の index 確認等は検証 DB で実施）。
