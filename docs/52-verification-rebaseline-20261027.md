# 全面検証の再基準化（2026-10-27 21:35）— be1e0c3 / HEAD 6d2bb87

## 0. 結論

- 昨夜の全面検証 [docs/39](39-full-verification-result-20261027.md) が **本計画（docs/38）と同じ86ケース**を実行済み。High 4件（F-01/F-04/F-12/G-01-F1）は修正・再検証 PASS。
- 当時の NO-GO 理由 **H-01（配備ドリフト）は解消**。本番は `be1e0c3`、migration は **025 まで適用済み**（`schema_migrations` 実測）。
- ただし docs/39 の検証対象は `84bba83` / デプロイ `804295c`。**その後に PR #95〜#102（ロールモデル・F-06・報告書・引継ぎ表示）が入り、本番 `be1e0c3` に反映**された。この差分は未検証。
- したがって今夜の作業は「82ケースの再実行」ではなく、**差分24ケースの検証＋本番 A12＋スモーク2**に絞る。

## 1. 基準の実測（2026-10-27 21:32 JST）

| 項目 | 値 |
|---|---|
| 本番（`/api/health` :18950） | `be1e0c3096a6c35ba0a17fb651dbd673a3c61134` / db ok |
| HEAD | `6d2bb87`（`be1e0c3..HEAD` は docs のみ＝コード同一） |
| 本番 DB migration | **025 まで適用**（`025_user_roles` / `024_role_separation` / … / `019`） |
| `ALLOW_SELF_APPROVAL` | `true`（自己承認は許可＋`self_approved` 記録。Phase C は未実施） |
| 検証環境 | `:18962`（HEAD ビルド / DB `ai_helpdesk_verify` / migration 025 / AUTH=cloudflare-access, JWT=off） |
| 検証DB | 021〜025 を適用済み |
| docs/39 の残課題 | F-05 Medium 修正済 / 未実施（B-04, B-14, C-08, C-09, D-04/07/09/10/11/12/13, E-04/09/10） |

## 2. Phase 0 完了記録

| # | 実施 | 結果 |
|---|---|---|
| 1 | DB バックアップ | `/tmp/aihd-verify-20261027/` に prod 223,688 / verify 473,000 / verify_api 122,814 bytes（0600） |
| 2 | owner 状態スナップショット | `prototype_states` 2行の md5 を保存 |
| 3 | 検証DB migration | 021〜025 を適用（019/020 は適用済み） |
| 4 | 証跡ディレクトリ | `docs/evidence/verify-20261027/` |
| 5 | 検証インスタンス | `:18962` 起動・health 200・employees 200 |
| 6 | 稼働 dist | 本番 `be1e0c3` ビルド。HEAD は docs-only のためコード同一 |

## 3. 差分検証マトリクス（24）

| ID | 検証内容 | 期待 | 環境 |
|---|---|---|---|
| V-01 | `/auth/me` が複数ロールを返す | `roles[]` に担当/承認等 | 18962 |
| V-02 | `auditor` の併存拒否（role set 検証） | 400/拒否 | 18962 |
| V-03 | `auditor` の UI 書込み | 403 | 18962 |
| V-04 | 一般社員の inbox / claim | 403 | 18962 |
| V-05 | 指名外 DX の claim | 403 `RECIPIENT_MISMATCH` | 18962 |
| V-06 | 指名 DX の claim / inbox 分離 | 200・他担当に出ない | 18962 |
| V-07 | 自己承認（`ALLOW_SELF_APPROVAL=true`） | 200・`self_approved=true` | 18962 |
| V-08 | 承認なし完了 | 409 `APPROVAL_REQUIRED` | 18962 |
| V-09 | 承認チェックリスト未確認（F-12 回帰） | 承認が先に成立しない | 18962 |
| V-10 | `GET /knowledge/pending` | 承認待ち一覧 | 18962 |
| V-11 | `POST /knowledge/:id/submit` → `review` | 下書き→承認→`knowledge` 永続化 | 18962 |
| V-12 | 承認済み KB の AI 出典反映 | `KB-…` が出典 | 18962 |
| V-13 | 別ID承認（claimant 以外） | `self_approved=false` | 18962 |
| V-14 | `final_reports` 一意制約（021） | 二重作成されない | 18962 |
| V-15 | 中止セッションの報告書（023） | 「終了（未解決）」種別 | 18962 |
| V-16 | 報告書の STEP 整合・表紙バッジ | 解決/停止で正しい | 18962 |
| V-17 | 引継ぎ概要（SM-03）が件名と一致 | 最後の発言で上書きされない | 18962 |
| V-18 | 完了案件の `GET /terminal/sessions`（SM-04） | 404 でなく 200/空 | 18962 |
| V-19 | STEP7 の承認者・承認日時 常設表示（F-13） | 表示される | 18962 |
| V-20 | RSP 相関（020/022・SM-09） | `rsp_session_id` / `rsp_command_log_id` 保存 | 18962 |
| V-21 | 端末エージェントの NUL/サロゲート除去（#91） | 500 にならない | 18962 |
| V-22 | E2E 担当者解決 1ラン（STEP1→7） | 完了・報告書 200 | 18962 |
| V-23 | E2E AI解決 1ラン（STEP1→3→7） | 完了・報告書 200 | 18962 |
| V-24 | 回帰（test/typecheck/lint/build）＋5xx 0・PII 0 | PASS | ローカル |

## 4. 本番での確認（A12＋スモーク2）

| 区分 | 内容 |
|---|---|
| A-01〜A-12 | Access 302→PIN→200、名簿解決（複数ロール）、`switchMode=self`、初期画面 |
| S-pre-1 | STEP1〜3 を1周（AI回答・出典） |
| S-pre-2 | STEP4〜7 を1周（引継ぎ→承認→報告書）※テスト案件 `【検証20261027】`・終了後復元 |
| デプロイ後 S1〜S7 | GO 時のみ（18:00〜19:00） |

## 5. 判定

- V-01〜V-24 に Critical/High が無いこと。
- 本番 A12＋スモーク2 が PASS。
- 回帰6 PASS。
- 上記が揃えば **G5 = GO（修正なしなら `COMMIT_SHA` 是正のみ）**。

## 6. 未決

1. 本番 A12＋スモーク2 の実施には **Access の One-time PIN** が必要（22:00 頃）。
2. 本番テスト案件は 2件（`【検証20261027】`）。終了後に状態復元。
3. Phase C（自己承認禁止）は前提未達のため対象外（docs/48）。

---

## 7. 実施結果（2026-10-28 追記）

- 差分 24 ケースを `:18962`（HEAD `6d2bb87` / 検証DB）で実行した。結果は
  **[docs/53](53-delta-verification-20261028.md)**、生データは
  `docs/evidence/verify-20261027/delta/results.json`。
- 集計: **PASS 20 / FAIL 1（V-01）/ 未実施 1（V-23）/ 部分 1（V-24）**。V-22（E2E）は 10/10 OK。
- **V-01 の FAIL**（`/api/auth/me` が無く `roles[]` も返らない）は Medium の機能欠落として起票対象。
  Critical/High は 0。
- 24h 監視の確定測定は 08:40 に実施済み（[docs/44 §4-1](44-s5-sm12-20261027.md)・
  `docs/evidence/verify-20261027/monitor/24h-recheck-20261028.md`）。新規 5xx は 0。
- 残り: 本番 A12＋スモーク2（OTP が必要）と、V-23（AI解決の画面 E2E）。
