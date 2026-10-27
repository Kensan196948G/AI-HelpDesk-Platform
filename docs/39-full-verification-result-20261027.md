# 全面検証 結果報告書（2026-10-27）— アクセス／ログイン → STEP1〜7 → 報告書・ナレッジ

- 計画: [docs/38-full-verification-plan-20261026.md](38-full-verification-plan-20261026.md)
- 対象: `https://ai-helpdesk.mirai-dx-platform.com/`（Cloudflare Access: One-time PIN / 12h）
- 検証対象コード: `main` **84bba83**（PR #63 までマージ済み）
- 実施: 2026-10-27 08:40〜（JST）
- 実行体制: Agent Team（Lead 1 + 検証3 + 修正2 + 独立レビュー1）
- 証跡: `docs/evidence/verify-20261027/`（access / step1-3 / handover / kb / report / platform / deploy / review）
- 実名・メール・PII は本書でも伏せ字。スクリーンショットは PII を含むためリポジトリへ追加していない（`/tmp` 保管）。

---

## 0. 結論（G5 デプロイ判定）

**現時点の判定: NO-GO（条件付きで再判定可能）**。理由は次の2点。

| # | 事実 | 影響 |
|---|---|---|
| 1 | 本番稼働コードは **1bde379 ビルド**（main 84bba83 より1コミット前）。`/api/health` の commit は `ac8085e` の固定値 | 検証対象（84bba83）と配備対象が不一致。Phase 2（RSP 出力取込・相関ID）が本番に無い |
| 2 | 本番DBに **migration 020 が未適用**（`schema_migrations` 最新 = 019、`terminal_sessions` に `rsp_*` 列なし） | 84bba83 を起動すると RSP 実行記録の保存経路が列不存在で失敗する |

- **High 指摘は 4 件**（F-01 / F-04 / F-12 / G-01-F1）と配備ドリフト **H-01** を検出。**コード High 4 件はすべて修正し、独立レビュアーの再検証で PASS（コード High 残存 0）**。配備ドリフト **H-01 は未解消**（本番は 1bde379・migration 020 未適用）で、これが NO-GO の理由。F-05 は Medium・修正済み。詳細は §5。
- デプロイ（計画 Phase 7）は、§6 の手順（ビルド → **migrate 020** → 再起動 → `COMMIT_SHA` 是正）と §5 の再検証 PASS、24h 監視の用意を条件に **GO に変更できる**。本報告では本番操作を実施していない。

---

## 1. 実施環境

| 区分 | 内容 |
|---|---|
| 本番 | `:18949`（proxy）→ `:18950`（DB `ai_helpdesk_preview`）。Cloudflare Access `enforce` |
| 検証 | A: `:18951` / F: `:18958`（一般社員 MK0122）・`:18962`（DX MK0623）/ G: `:18959`・`:18964` / H: `:18965`。各々専用 DB を作成し、本番DBへは書き込んでいない |
| ビルド | `/tmp/aihd-head` = 84bba83 クリーンビルド（128ファイル、digest `f77351e8…`） |
| 実装手段 | Playwright（Chromium）/ API（curl）/ psql / SMTP シンク `:2526` / 実 DeepSeek |
| 修正 | `/tmp/aihd-fix`（branch `fix/verify20261027`、main 84bba83 起点） |

---

## 2. 結果サマリー

| 領域 | 件数 | PASS | 部分PASS | FAIL | BLOCKED | 未実施/保留 |
|---|---|---|---|---|---|---|
| A アクセス・ログイン・初期化 | 12 | 8 | 1（A-10） | 2（A-06, A-12） | 0 | 1（A-07） |
| B STEP1〜3・AI一次対応 | 14 | 10 | 1（B-02） | 1（B-08=F-04） | 0 | 2（B-04, B-14） |
| C STEP4 引継ぎ | 10 | 6 | 0 | 0 | 0 | 2（C-08, C-09）+ 要判断1（C-01）+ N/A1（C-02） |
| D STEP5 担当者対応 | 14 | 6 | 0 | 2（D-01=F-01, D-14=F-02） | 0 | 6（D-04,07,09,10,11,12,13 のうち実測記録なし分） |
| E STEP6 ナレッジ化・承認 | 10 | 6 | 0 | 0 | 1（E-03=F-06） | 3（E-04, E-09, E-10） |
| F STEP7 完了・報告書 | 10 | 6 | 0 | 4（F-01, F-08, F-09, F-10） | 0 | 2項目（実行記録・403期待） |
| G 横断・非機能 | 12 | 7 | 2（G-02, G-12） | 2（G-01, G-05） | 1部（G-08 RSP側） | 0 |
| H 配備整合 | 4 | 3 | 0 | 1（H-01） | 0 | 0 |
| 回帰6 | 6 | 6 | — | 0 | 0 | 0 |

- E2E 一気通貫: **担当者解決 2ラン実施**（CASE-0002 が STEP1→7 到達、CASE-0001 は F-12 で STEP6 停止＝再現用）。**AI解決の UI ランは未実施**（API の STEP ゲートのみ確認）。計画の10ランには未到達。
- F 検証のインスタンス（`:18958` / `:18962`）は検証終了後に停止している（証跡の実測値は独立レビュアーが自前環境で再現済み）。
- 報告書: HTML 200 / PDF 200（9頁・文字化け0・IPAゴシック埋め込み）。
- ナレッジ: 承認→AI 出典反映（`prototype:KB-111`）まで1周。ただしサーバ `knowledge` テーブルは 0 行（クライアント状態のみ・F-06）。

---

## 3. 検出した指摘

### 3-1. High

| ID | 指摘 | 実測根拠 | 状態 |
|---|---|---|---|
| **F-01** | 引継ぎの受信箱・claim・詳細・更新に権限/宛先検証が無い。一般社員が他者宛の引継ぎを閲覧し claim できる | 一般社員 MK0122 で `GET /inbox` が DX 宛2件を返し、`POST /{id}/claim` が 200（`routes/case-handovers.ts`） | **修正済み**（§4） |
| **F-04** | `case_handovers.snapshot` にメール・電話・IP が平文保存。メモ生成時のみ redactPII | CASE-0004/0001/0002 の snapshot に平文。カードのみクライアント置換 | **修正済み**（§4） |
| **F-12** | 承認チェックリスト未確認でもサーバー承認が先に成立し、案件が完了不能（409 NOT_CLAIMED）の詰みになる | CASE-0001/0002 で再現。`prototype/assist-bridge.js:1740-1770` が HTML:2320 の検証より先に POST /approve | **修正済み・独立再検証 PASS**（1次修正が実ブラウザで承認全滅の回帰を起こしたため是正し、Phase C で 4 シナリオ PASS。§5） |
| **G-01-F1** | 監査ハッシュチェーンが破断し `/api/audit/verify` が常に `ok:false`（改ざん検知不能） | 破断は **2行**（`brokenAtId=10010` / `10013`、いずれも `terminal.session.expire`）。`routes/terminal.ts:152` が detail に `Date` を渡し `stableStringify` が `{}` 化。源流 `ai_helpdesk_ui` と本番 `ai_helpdesk_preview`（15行）でも同じ2行 | **修正済み**（§4） |
| **H-01** | 本番稼働 dist が main HEAD と不一致（1bde379 ビルド）。migration 020 未適用 | `diff -rq` で 84bba83 と 10 行差分、`schema_migrations` 最新 019 | **未解消（デプロイで解消）** |

### 3-2. Medium

| ID | 指摘 | 状態 |
|---|---|---|
| F-02 | 引継ぎ create/claim/approve がサーバ監査に無く、actor が `system`・3重記録 | **修正済み**（`audit_log` へ1操作1行） |
| F-05 | 引継ぎ通知メールの件名が常に `(件名なし)` | **修正済み**（クライアント送信＋snapshot から解決） |
| F-06 / G-02-F1 | ナレッジ下書き・承認がクライアント状態のみ。申請者と別担当の承認ができず、DX 内4ロール（担当/承認/監査/IT端末管理）のサーバ分離も無い | **一部修正済み（2026-10-27 14:24 追記）**: サーバ永続化は PR #79 / migration 022 で解消し本番反映済み（`docs/42`・`docs/40 §11`）。**4ロールのサーバ分離は未実装**（単一 Access ID 運用のため `ALLOW_SELF_APPROVAL=true` を維持） |
| F-13 | DX が解決・完了しても依頼者側の案件が STEP4 のまま（`case_handovers.status` を画面が読まない） | 未修正 |
| F-14 | 報告書バッジが常に「STEP 5 完了」（`final-report.ts:844` が `case.step` を見ない） | 未修正 |
| F-15 / F-08 | 報告書作成が `audit_log` に残らない（`routes/reports.ts`） | 未修正 |
| F-16 / F-09 | 報告書からナレッジ下書きへのリンクが無い（`<a>` 0個） | 未修正 |
| F-10 | 同一内容の報告書が二重作成される（`(user_email, sha256)` の一意制約なし） | 未修正 |
| E-03 / F-06 | 別担当者による承認が成立しない（自己承認のみ・警告あり） | **BLOCKED（環境制約）**：local モードでは全ペルソナが同一 canonical email に正規化される |
| G-01-F2 | `case.ai_assess` の actor が NULL（6件） | **修正済み**（`request.authUser` を使用） |

### 3-3. Low / 仕様差

| ID | 内容 | 扱い |
|---|---|---|
| A-06 | Access は許可外メールでもコード送信画面へ進む（列挙防止の仕様）。アクセス付与はされない | 期待値を実装仕様に合わせる（G4 判断） |
| A-12 | CSP が favicon と Cloudflare beacon を拒否（コンソール4件）。アプリコード由来ではない | 修正候補（`img-src`/beacon） |
| F-17 | 報告書の権限拒否が 403 ではなく 404（秘匿のため実効拒否は成立） | 期待値を 404 に合わせる |
| G-02-F2 | 初期表示で権限外 API を呼び 403 が3件 | 表示条件の見直し |
| G-12-F1 | モーダルを開いてもフォーカスが移動しない（Esc は機能） | アクセシビリティ改善 |

---

### 3-4. 指摘 ID とケース ID の対応（ID 二重定義の解消）
計画のケース ID（A-01〜H-04）と、検出した不具合 ID が衝突している箇所がある。**§3 の `F-xx` は「検出した不具合」**を指し、ケース ID は §2 と各証跡を参照する。

| 衝突 | ケース ID（検証項目） | 不具合 ID（§3） |
|---|---|---|
| F-01 | STEP7 の完了表示・一覧更新 | 引継ぎの受信箱・claim に権限/宛先検証が無い |
| F-04 | 報告書の内容（PII マスク・時系列） | `case_handovers.snapshot` の PII 平文保存 |

### 3-5. PII の取扱い（G-05 の合格条件の再定義案）

- 修正により、**引継ぎスナップショット・引継ぎメモ・通知メール・最終報告書**は保存/出力前にマスクされる。
- 一方、**依頼者本人の案件入力（`prototype_states`）は業務上原文が必要なため平文で保持**される。ここまで「平文 0」にするには入力時マスク（内容の復元不能）か保存時暗号化＋権限分離が必要で、業務影響が大きい。
- 提案: G-05 の合格条件を「**外部共有・出力・通知・ログに平文が無いこと**」に再定義し、`prototype_states` は「本人と DX のみがアクセスできる原データ」として、保持期間・アクセス監査・DLP の運用要件で管理する（**G4 の判断事項**）。
- 現状の整理: 計画 §9 の「PII 平文 0」をそのまま適用すると **G-05 は High 残存 1 件**、上記に再定義すると **0 件**。独立レビューも同じ整理をしており、G4 でスコープを明示する必要がある。



## 4. 修正内容（Phase 6）

`/tmp/aihd-fix`（branch `fix/verify20261027`・main 84bba83 起点）。差分の指紋は `18feab15…`（`git diff` の sha256）。**未コミット**。

| 指摘 | 変更 | テスト |
|---|---|---|
| F-01 | 新規 `apps/api/src/auth/helpdesk-scope.ts`（`requireHelpdeskActor`）。inbox / claim / GET / PATCH / approve に適用。DX 推進部所属で判定、名簿解決不能は fail-closed(403)。宛先指名は `recipient_no` 照合（指名外 claim 403、別担当 claim 409、再 claim 冪等） | helpdesk-scope 11件、case-handovers 13件 |
| F-02 | `appendAudit` を流用し claim・解決記録・承認を `audit_log` に1操作1行（`detail.actorEmail`・caseId・時刻） | 同上 |
| F-04 | `extractCaseSnapshot` の戻り値を `redactCaseSnapshot`（再帰）で伏せ字化。`/ai/answer-case` の再 UPDATE 前にも適用。端末識別子（device/deviceId/agentId/hostname/machineId/terminalId、コンピュータ名系の表示項目）は保持 | case-handover 16件（端末識別子の保持を固定） |
| F-05 | `extractCaseSnapshot(..., { subject })` を追加。`ShareBodySchema.subject` と `assist-bridge.js` の共有 POST から件名を送信。件名の解決順: クライアント値 → case.subject → ticket.summary → inc.subject → chat.title（プレースホルダ除外）。空白のみは `(件名なし)` | case-handover / handover-notify |
| F-12 | 承認ラッパでクライアント検証を先に実施。サーバー承認後のローカル失敗時は `PATCH` で `resolved` に補償 | assist-bridge の実測 |
| G-01-F1 | `terminal.ts` の detail を ISO 文字列化。`stableStringify` を Date 対応に。既存破断行の扱いは §4-1 | audit / terminal integration |
| G-01-F2 | `cases.ts` の `appendAudit` に `request.authUser` の id を渡す | cases |

### 4-1. 既存の監査破断行の扱い

過去行は保存済みハッシュの再計算ができないため、**破断点（`terminal.session.expire` / 2026-10-26 09:29）を既知の移行点として記録**し、以降の新規行から検証可能にする。恒久対応（既存チェーンの再構築）は本番 DB への書き込みを伴うため人間承認とし、修復スクリプト案を本報告に添える。

---

## 5. 修正後の再検証

（Phase 6 実行中。結果は独立レビュアーの `docs/evidence/verify-20261027/review/independent-review.md` §B とあわせて確定する）

修正差分を freeze（`git diff` sha256 `18feab15…`）し、`:18966`（一般社員）/`:18967`（DX）/DB `ai_helpdesk_fix` で独立レビュアーが自前の HTTP・DB・UI 手順で再実測した。

| 指摘 | 再検証の観点 | 判定 |
|---|---|---|
| F-01 | 一般社員の inbox/claim 403、指名外 claim 403、DX 正常 claim 200 | **PASS**（一般社員 403、指名外 DX は `RECIPIENT_MISMATCH` 403、指名 DX は 200、inbox は宛先で分離、依頼者本人 GET のみ 200） |
| F-04 | snapshot にメール/電話/IP の平文が無い。端末識別子は保持 | **PASS（snapshot 観点）**（平文0・伏せ字4種・device/agentId/hostname 保持。通知本文/件名も PII なし） |
| F-05 | 通知件名に案件件名が入る（空件名のみ `(件名なし)`） | **PASS**（キュー4件＋SMTP シンク実受信4通で確認。件名なしは空件名時のみ） |
| F-12 | チェックリスト未確認ではサーバー承認されない。ON なら正常完了 | **PASS（Phase C 4/4）**：未確認→toast 警告のみ・サーバー不変（claimed のまま・approve 監査なし）／ON→completed・下書き approved・監査1行／共有外の通常承認は従来動作／補償で `resolved` に戻り再承認可 |
| G-01 | `/api/audit/verify` が新規行で `ok:true` | **PASS**（HTTP 200 `ok:true`、`AUDIT_KNOWN_BREAKS` を空にすると `ok:false`/`brokenAtId=10010` で検出。既知破断は 10010/10013 の2行） |

- **残存**: `prototype_states`（依頼者本人の案件入力）は平文のまま。§3-5 のとおり G-05 の合格条件の再定義が必要（G4/人間判断）。
### 5-2. Phase C（F-12 の再是正と回帰確認）

1次修正は実ブラウザで `ahDraftById` が常に null となり承認が全件中断する回帰を起こした（独立レビューの Phase B で検出）。是正版では公開 API（`window.HD.draftInfo` / `actor`）と DOM（`#ck0`〜`#ck3`）で判定し、**判定不能時はブロックせず従来動作へフォールバック**する。

| 観点 | 判定 |
|---|---|
| F-12 未確認→承認 | PASS（toast 警告のみ・サーバー claimed のまま・approve 監査なし） |
| F-12 ON→承認 | PASS（completed・approved_by・self_approved・監査1行・KB 作成） |
| 共有外の通常承認 | PASS（サーバー呼び出しなし・従来動作維持） |
| 補償（サーバー成功→ローカル失敗） | PASS（PATCH resolved・監査+1・再承認で completed） |
| F-02 create 監査 | PASS（`case_handover.create` が1行、create/claim/approve が1操作1行） |
| 回帰（F-01 / F-04 / F-05 / G-01） | PASS（403/200、snapshot 平文0・識別子保持、件名、`audit verify ok:true`） |

**結論: コード High 残存 0。** ただし G-05（`prototype_states` の PII 平文）は §3-5 の合格条件を G4 で確定する必要があり、配備ドリフト H-01 が残るため G5 は **NO-GO 継続**。

### 5-1. 回帰

| 対象 | 実測 | 備考 |
|---|---|---|
| 修正前 84bba83（分離 DB） | **420 PASS / 0 FAIL**（50 files） | `/tmp/aihd-head` |
| 修正差分（分離 DB） | **455 PASS / 0 FAIL**（52 files） | 独立レビュアーの分離環境 |
| 修正差分（共有テスト DB） | 454 / 455（1 failed） | 失敗は `apps/api/src/routes/integration.test.ts`「主要3 Flow」。共有テスト DB の有効チケット127件が `/api/desk/queue` の `LIMIT 100` を超え、新規案件が一覧から漏れる**テストDB汚染**（base でも同条件で再現）。コード回帰ではない |

typecheck / lint / build / secret scan / migrate 冪等はすべて成功（修正前・修正後とも）。

> 再現性の注意: 実行シェルに `DATABASE_URL` が残っていると、起動・テストが意図しない DB へ接続する。分離 DB と明示的な環境変数で実行すること（本検証では `.env.test.local` の override でも 1 件の誤 FAIL が出たため、分離環境で再実行した）。

---

## 6. デプロイ手順（G5 で GO の場合）

> **実施済み（2026-10-27 10:23〜10:52 JST）**: 本節の手順で本番へデプロイした（commit `804295c`・migration 020 適用・`COMMIT_SHA` 是正・再起動）。スモークは **S1/S2/S3/S4/S6/S7 PASS・S5 は RSP ローカルログイン経由で UI 経路まで実測**（実行は端末オフラインで不成立・15:20 追記参照）。実行記録・ロールバック資産・24h 監視は [docs/40](40-deploy-20261027.md) を参照。

> コードは未配備（1bde379）。デプロイの実体は「84bba83＋本修正のビルド＋migration 020＋再起動＋COMMIT_SHA 是正」。

1. `pg_dump ai_helpdesk_preview`（`/tmp`・0600）と現行 `apps/api/dist` の tar + digest を退避（ロールバック用。H-04 で成立を実測）
2. `npm run build` / `npm test` / `npm run typecheck` / `npm run lint`。ビルド後の dist を 84bba83 クリーンビルドと比較（H-01 の候補 `f77351e8…` と一致確認）
3. `npx tsx scripts/migrate.ts` で **020 を適用**（019/020 とも追加のみ。旧コードでも 200 を実測済み＝ロールバック可）
4. `~/.config/ai-helpdesk/api.conf` の `COMMIT_SHA` をビルド元 commit（修正マージ後の SHA）へ更新。**設定だけ先行すると health が実態と乖離する**ことを :18965 で実証済み
5. `systemctl --user restart ai-helpdesk-api`
6. スモーク S1〜S7（health commit 一致・Access 302→200・STEP1〜3・STEP4〜7・RSP 実行セッション・RSP 連携 401/200・監査/通知キュー/5xx）
7. 24h 監視（5xx・health・Access 302・レイテンシ）

**ロールバック**: dist を退避版へ差し替え → 再起動。DB は追加のみのため戻す必要なし（020 適用済みでも旧コードは 200 を実測）。

---

## 7. 未実施・制約（正直な申し送り）

1. **E2E 10ラン未達**: 担当者解決 2ラン（STEP7 到達1・F-12 停止1）のみ。AI解決の UI ランは未実施（API の step ゲートのみ）。
2. **B領域 5件**（B-04 端末未所有、B-14 通信断）と **D領域 6件**（D-04/07/09/10/11/12/13 の一部）は未実施。
3. **E-04 / E-09 / E-10**（却下・編集破棄・承認ハッシュ監査）は未実施。
4. **F-04 の「実行記録」**: RSP 実行セッションを含む案件を作っていないため、報告書の RSP 節は未検証。
5. **別担当者による承認（職務分離）**は local モードの制約で BLOCKED。本番 Access（別メール）では別主体になるが、同一 canonical email に正規化される設定では同じ制約が残る。
6. **本番書込みは行っていない**: テスト案件の作成・状態復元・メール送信（D2=送らない）は未実施。本番 DB は読み取りのみ。
7. **負荷試験・ペネトレーションテスト**は対象外（計画どおり）。

> **2026-10-27 14:50 追記（F-06 完了後）**
>
> - 上記 **5（別担当者による承認は BLOCKED）は解消**。ナレッジのサーバ永続化（PR #79・migration 022）と承認者向け pending 一覧（PR #82）により、**UI から**別 ID での承認が成立することを実測した。`KB-2026-0103`: author=`kensan1969@gmail.com` / approver=`k-aritoh@mirai-const.co.jp` / `self_approved=false`。さらに 14:48 に `KB-2026-0102`（作成者=社内アドレス）を UI から承認し、pending→approved・version 2・監査 `knowledge.approve`（`selfApproved=false`）を確認した（`docs/42` §7）。
> - ただし **4 ロール（担当／承認／監査／IT 端末管理）のサーバ分離は未実装**で、`ALLOW_SELF_APPROVAL=true` を維持している。設計案と移行計画は `docs/43` に提案として起案した（実装は別判断）。
> - 上記 **6（本番書込みは行っていない）は当時の記述**であり、10/27 のデプロイと本検証で本番 DB への書込み（`knowledge` 行の更新・`audit_log` 追記・migration 022 の適用）が発生している。
> - 即時スモーク監視の結果は `docs/42` §8（今回の変更に起因する 5xx・error は 0 件）。

> **2026-10-27 15:20 追記（S5 の RSP UI 経路）**
>
> - 上記 **S5「BLOCKED（RSP 未ログイン）」は解消**。RSP のローカルログインで `rspadmin`（System Admin）として UI に入り、AI支援パネルで CASE-39192 の読込→同意→セッション開始→AI提案→実行試行→記録→中止終了までを実測した（[`smoke-S5-ui.md`](evidence/verify-20261027/deploy/smoke-S5-ui.md)・`docs/40` §12）。
> - **RSP 実行だけは不成立**: 対象端末 `DESKTOP-TMQM61D` が `agent_status=offline`（`last_seen=2026-10-26T11:39:35Z`）で、UI はキュー投入の手前で停止（`POST /devices/…/commands` は 0 件・実行なし）。実行記録は `output_source=manual` / `exit_status=failure` / 出力空で、**虚偽の出力は入れていない**。
> - したがって「記録・報告書反映」のうち **報告書は未作成**（中止セッションでも `kind=helpdesk_resolved` になるため・**SM-12**）。報告書への RSP 節の反映自体は API 実測（[`smoke-S5.md`](evidence/verify-20261027/deploy/smoke-S5.md)）で確認済み。
> - 上記 **4（F-04 の実行記録）は一部解消**: Phase 2（`rsp_command` 取込・相関・報告書反映）は `docs/40` §9 で実測済み。残るは端末オンライン時の UI 自動取込のみ。

---

## 8. 次アクション

| # | 内容 | 前提 |
|---|---|---|
| 1 | 修正差分（F-01/F-04/F-05/F-12/G-01）をレビューし、コミット・PR・CI・マージ | §5 の再検証 PASS |
| 2 | Medium（F-13/F-14/F-15/F-16/F-10）の採否決定と実装 | 別 PR |
| 3 | F-06（ナレッジ承認のサーバ永続化・職務分離）の設計 | **サーバ永続化は PR #79（2026-10-27 14:24 本番反映）で解消済み**。職務分離（4ロール・別担当承認の強制）は設計課題として残る |
| 4 | 監査破断行の恒久修復（本番 DB への書込み＝人間承認） | 修復スクリプト案 |
| 5 | デプロイ（§6）と 24h 監視 | G5 GO |
| 6 | E2E 10ラン・未実施ケースの消化 | デプロイ後 |

---

## 9. 証跡索引

| 領域 | ファイル |
|---|---|
| A | `docs/evidence/verify-20261027/access/A-results.md`（+ `A-01-headers.txt`） |
| B | `step1-3/B-results.md` / `step1-3/B8-B14-results.md` |
| C | `handover/C-results.md` / `handover/C5-C7-results.md` |
| D | `handover/D-findings.md` |
| E | `kb/E-results.md` |
| F | `report/F-results.md`（+ `raw/` 5ファイル） |
| G | `platform/G-results.md`（+ `raw/` 11ファイル + `regression/` 11ファイル） |
| H | `deploy/H-results.md`（+ `raw/` 31ファイル） |
| レビュー | `review/independent-review.md` |
