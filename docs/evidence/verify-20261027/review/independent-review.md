# 独立レビュー — 全面検証（2026-10-27）

> 実行者: reviewer（独立・fresh context）
> 実施: 2026-10-27 09:32〜09:45 JST（Asia/Tokyo）
> 方針: 他メンバーの自己申告を採用せず、コード・DB・HTTP・テストを自分で再実行して照合した。
> 対象: `docs/38-full-verification-plan-20261026.md` / `docs/39-full-verification-result-20261027.md`（入力リスト外のため後から発見） / `docs/evidence/verify-20261027/**` / `/tmp/aihd-fix`（branch `fix/verify20261027`、未コミット）

---

## §A. 証跡の横断レビュー（Phase A）

### A-0. 条件・環境・限界

| 項目 | 内容 |
|---|---|
| 既存サービス | `:18950/:18951/:18952/:18954/:18956/:18957/:18959/:18964` は**停止・再起動していない**（`ss -ltnp` で稼働確認と GET のみ） |
| 本番 DB | `ai_helpdesk_preview` は **SELECT のみ**（`audit_log` / `schema_migrations` / `information_schema`） |
| 書き込みを伴う再測 | 自前 DB `ai_helpdesk_rv_test` / `ai_helpdesk_rv_f` / `ai_helpdesk_rv_fix` と自前ポート `:18966/:18967`（終了時に停止）。既存 DB・本番 DB への書き込みなし |
| 認証情報 | `/proc/<pid>/environ` から実行時に取得し、**値は証跡・ファイルに書いていない**（作業用の一時ファイルは即時スクラブ） |
| 事故と復旧 | `createdb` の引数誤用で接続文字列を名前にした DB を 1 つ作成したが、**直後に DROP** し、リポジトリ・証跡には残していない |
| 未再測（環境依存） | A-05 の `CF_Authorization` 属性、A-06/A-12 のブラウザ挙動、G-04 の 73 本「到達」（定義数のみ確認）、G-08 の RSP 側 200、G-11/G-12 の UI、H-04 のロールバック、F-12 の UI 実操作、F-05 の実メール |
| 参照した修正差分 | `/tmp/aihd-fix` は**レビュー中も編集が続いていた**（09:36: 7 ファイル → 09:42: 11 ファイル＋新規 3 → 09:45: 12 ファイル＋新規 4）。コード原因の確認は修正前 `HEAD` に対して行い、修正の評価は **09:45:21 時点**のスナップショットに基づく（§A-4 に指紋）。凍結前の差分である |

### A-1. 再実測した数値（15 点以上）

| # | 出典 | 記載値 | 私の再測（方法） | 一致 |
|---|---|---|---|---|
| 1 | H-03 | `:18950 /api/health` = 200・`commit=ac8085e`・`db=ok` | 同一（curl） | ○ |
| 2 | H-01 | 稼働 dist digest `6edeb593…c6537d` / 128 ファイル | 同一（`sha256sum` 集約） | ○ |
| 3 | H-01 | `84bba83` クリーンビルド digest `f77351e8…f83113` / 128 ファイル | 同一（`/tmp/aihd-h-build` と `/tmp/aihd-head` の両方） | ○ |
| 4 | H-01 | 稼働 dist vs クリーンビルド = 10 行差分（5 JS + 5 map） | `diff -rq` = 10 | ○ |
| 5 | F-08/F-10 | `ai_helpdesk_f.final_reports` = 8 行 | 8 行（8 ID・sha 先頭 16 桁まで一致） | ○ |
| 6 | F-08 | `ai_helpdesk_f.audit_log` = 0 行 | 0 行 | ○ |
| 7 | F-06/E-10 | `ai_helpdesk_f.knowledge` / `knowledge_reviews` = 0 行 | 0 / 0 | ○ |
| 8 | G-01 | `ai_helpdesk_g.audit_log` = 76 行・actor NULL 26 行・引継ぎ監査 0 行 | 76 / 26 / 0 | ○ |
| 9 | G-01 | `/api/audit/verify` = `ok:false, checked:10, brokenAtId:10010, expected:db7c5e…, actual:08fcd2…` | **再計算で完全一致**（§A-3-G-01） | ○（ただし別行 10013 も不整合） |
| 10 | G-10 | dashboard total 9 / in_progress 3 / completed 4 / ai_resolved 0 | 同一（DB COUNT） | ○ |
| 11 | G-09 | 一般社員向け approved 12 件・draft 3 件 | 12 / 3 | ○ |
| 12 | G-04 | ルート定義 73 本（`/api` 71＋静的 2） | `app.(get\|post\|put\|patch\|delete)` の定義数 = **73**（到達は未再測） | ○（定義のみ） |
| 13 | H-02 | 新規 DB で 20 適用 → 2 回目 20 skip・`rsp_*` 列あり | `ai_helpdesk_h.schema_migrations` = 20 行、`rsp_session_id` / `rsp_command_log_id` あり | ○ |
| 14 | F-02/F-03 | 報告書 HTML 200・22,949 bytes・`text/html`／PDF 200・511,835 bytes・9 ページ | 自前 `:18966`（DB 複製）で **完全一致**。PDF は `pdftotext` で U+FFFD 0・IPAGothic emb=yes | ○ |
| 15 | F-04（報告書） | PII 生値 0／`[メールアドレス]` 13・`[IPアドレス]` 7・`[電話番号]` 6 | 同一（HTML/PDF 双方） | ○ |
| 16 | F-07 | 別ユーザーは 404・不存在 UUID も 404（区別不能） | 自前 `:18967` で **404 / 404** | ○ |
| 17 | 回帰 | unit 420 PASS / 50 files | `/tmp/aihd-head` で **420 / 50 PASS**（`DATABASE_URL`・`SESSION_SECRET`・`SEED_PASSWORD` を明示） | ○ |
| 18 | F-01 | 一般社員が他者宛を閲覧・claim 200 | 自前 DB 複製＋`:18967` で **inbox に宛先 MK0623 の 1 件、claim 200、claimed_by が一般社員** | ○（再現） |
| 19 | A 環境 | `:18951` = HEAD `84bba83` + migration 020 | プロセス cwd = `/tmp/aihd-head`、`ai_helpdesk_verify` に 020 あり（health の commit 表示は根拠にしていない） | ○ |
| 20 | 追加 | （証跡に記載なし）**本番 `ai_helpdesk_preview` の監査 15 行も 10010/10013 の 2 行が不整合** | 再計算で確認（SELECT のみ） | 追加所見 |

- 補足（G-06）: 証跡の「送信成功 8 件」は 00:19〜00:20 UTC 時点の値。DB にはその後 00:21〜00:28 に 11 件追加され計 20 件（`failed` は `ai_helpdesk_g_mail` に attempts=5 で 1 件）。**矛盾ではないが、時点値である旨が不明瞭**。
- 補足（F-05）: 通知件名は Phase B の対象のため再測していない。

### A-2. 判定の矛盾・二重基準・未検証の断定

| # | 指摘 | 根拠 | 重大度 |
|---|---|---|---|
| C-1 | **総合判定は存在するが、High の台帳が不整合**。`docs/39-full-verification-result-20261027.md:15` は「**NO-GO**（条件付きで再判定可能）」を明示しており、「判定文書が無い」という初回所見は誤り（入力リストに docs/39 が無く、後から発見して本改訂に反映）。ただし ①22 行の「High 5 件」は F-01 / F-04 / **F-05** / F-12 / G-01-F1 で、§3-1 の High 表（F-01 / F-04 / F-12 / G-01-F1 / **H-01**）と**集合が一致しない** ②F-05 は §3-2 では Medium ③H-01 を High に数えるか配置ギャップに数えるかで High 残存数が変わる。結論（NO-GO）は妥当だが、台帳の一意性が無い | `docs/39` 15,22,61-69 行 | **Medium（監査性）** |
| C-2 | **F-04 の ID 二重定義**。B 領域の F-04 は「snapshot に PII 平文（High）」、F 領域の F-04 は「報告書の内容（PASS）」。F-results の判定サマリは F-04 を PASS に算入しており、High 一覧と突合すると「F-04 は解消済み」と誤読できる | `step1-3/B8-B14-results.md`／`report/F-results.md:16,33` | **High（監査性）** |
| C-3 | **F-01 の ID 二重定義**。D 領域の F-01 は「引継ぎの認可欠落（High）」、F 領域の F-01 は「完了表示が依頼者に反映されない（Medium）」。同名で別事象 | `handover/D-findings.md`／`report/F-results.md:30` | High（監査性） |
| C-4 | **期待値の扱いが不統一（二重基準）**。A-06 は「期待（送信前に遮断）と実装が違う」を FAIL（Low）、A-12 はコンソールエラーを FAIL（Low）。一方 F-17 は「403 期待→404」を PASS（実効拒否）、E-07 は「403 期待→401（セッション無し）」を PASS。同じ「期待と実装の差」を片方 FAIL・片方 PASS にしており、判定基準が一貫しない | `access/A-results.md:10,12`／`report/F-results.md:36`／`kb/E-results.md:13` | Medium |
| C-5 | **未実施を含む PASS（過大判定）**。F-04 は「実行記録」未実施のまま PASS に算入（判定サマリに「未実施 2 項目」と自認）。B-02 は必須検証未実施で「PASS（部分）」、E-07 は 401（未認証）で PASS。PASS の定義（全サブ条件成立）が守られていない | `report/F-results.md:16,19`／`step1-3/B-results.md:9`／`kb/E-results.md:13` | Medium |
| C-6 | **「検証対象＝配備対象」の前提が崩れている**。計画 §14-8 は「本番 dist と HEAD ビルドは完全一致。検証対象＝配備対象は成立」とするが、H-01 の実測は「稼働は `1bde379`、候補は `84bba83`」。A/F/G は `84bba83` で検証しており、**検証したコードと稼働コードが別**。H-results は正しく訂正しているが、計画書 §14-1/§14-8 は未訂正のまま | 計画 371-379,451 行／`deploy/H-results.md` §0,H-01 | **High（前提）** |
| C-7 | **A-03 の「commit 一致」が未確認**。A-03 の実測はタイトルと boot のみで commit を確認していない。さらに H-03 が「health の commit は設定値でコードと無関係」と実証しており、`18956/18957/18959/18964` が実際は `/tmp/aihd-head` ビルドなのに `ac8085e` を返すことを私も確認した。**health の commit を根拠にした同一性判定は使えない** | `access/A-results.md:7`／`deploy/H-results.md` H-03 | Medium |
| C-8 | **G-01 の影響記述が誇張**。「1 箇所で破断」「以降全部が検証不能」とあるが、実データでは不整合は **10010 と 10013 の 2 行**、再計算では 76 行中 74 行が一致し、以降の鎖は健全（最初の不一致で API が打ち切るだけ）。High の結論自体は妥当だが、機構の説明が不正確 | `platform/G-results.md` G-01-F1 | Medium |
| C-9 | **再現環境の記載が現状と不一致**。F-results は「検証用インスタンスは再現のため起動したまま（`:18958`/`:18962`）」とするが、私の確認時点で両ポートは停止（接続拒否）。私は同等環境を自前で起動して再測した | `report/F-results.md:9` | Low |
| C-10 | **伏せ字の自己確認が不成立**。G-results §6 は「raw 全体に実名・owner のアカウント名 等が含まれないことを grep で確認済み」とするが、実際は証跡に実在氏名（DX 5 名のフルネーム）と owner の実 Gmail が残る（§A-5）。自己確認のスコープ（自ファイルを含まない）と検出パターンが不十分 | `platform/G-results.md:279`／§A-5 | **High（PII）** |
| C-11 | **影響範囲の表現が過大**。D-findings は「認証済みの任意の社員が他者宛を閲覧・横取りできる」とするが、実測は `AUTH_MODE=local`。本番（cloudflare-access）では DX 以外は 403 で、影響は「DX メンバー間で宛先指名が無視される」に限定される。G-results はこの限定を明記しており、D-findings 側の表現を揃えるべき | `handover/D-findings.md`／`platform/G-results.md` F-01 | Medium |
| C-12 | **回帰の基準値が陳腐化**。計画 §9 は「unit 201 PASS」だが実測は 420。PASS 自体は再現したが、計画の合否基準が更新されていない。また G-results は初回失敗ログを破棄して `unit2.log` を採用（本文で開示済み）— 失敗を証跡から消す運用は再現性を下げる | 計画 292 行／`platform/G-results.md` §3 | Low |
| C-13 | **docs/39 §5-1 のテスト件数が古い／失敗の原因帰属**。447 tests / 1 failed とあるが、現行差分を分離環境で実行すると **52 files / 455 tests PASS**（`/tmp/aihd-fix-rv2`）。1 failed は共有 DB `ai_helpdesk_test` の有効チケットが **127 件**で `desk/queue` の `LIMIT 100` を超えるため（私も 127 件・最大 rank 127 を確認）で、**コード回帰ではない**。「base でも同様に失敗」は同じ汚染 DB なら妥当だが、分離 DB では base 420/420 PASS。件数・原因の記述を最新化すべき | `docs/39` 132-133 行 | Medium |

**総合**: A〜H の個別判定は概ね実測に裏付けられている（数値は 15 点以上一致）。問題は「点の正確さ」ではなく、**(1) ゲート判定は docs/39 にある（NO-GO）が High 台帳が不整合、(2) 同一 ID の二重定義、(3) 期待値の扱いの不統一、(4) 未実施を含む PASS、(5) 検証対象と配備対象の不一致、(6) テスト件数・失敗原因の記述が現行差分と不一致**である。

### A-3. High 指摘の原因確認（修正前コード・再現）

#### F-01 引継ぎの認可欠落 — 原因は記載どおり（再現済み）

| 観点 | 結果 |
|---|---|
| 記載原因 | `apps/api/src/routes/case-handovers.ts` の inbox は status のみ、claim は claimed_by/status のみ、`requireHelpdesk()` は開発モードで早期 return |
| 修正前コード | `HEAD:apps/api/src/routes/case-handovers.ts:99-103` に `if (config.AUTH_MODE !== 'cloudflare-access') return;`、inbox = 337-352 行（宛先条件なし）、claim = 354-410 行（`recipient_no` を検証しない）→ **記載と一致** |
| 再現 | 自前 DB 複製に「宛先 MK0623・owner 別人・pending」の引継ぎを 1 件用意し、一般社員セッション（`:18967`）で `GET /inbox` → **1 件返る**、`POST /{id}/claim` → **200**、`claimed_by` が一般社員に更新 |
| 影響の限定 | 本番 `cloudflare-access` では DX 以外 403。**DX メンバー間では宛先指名が無視される**（D-findings の「任意の社員」は過大） |
| 修正 | `apps/api/src/auth/helpdesk-scope.ts`（新規）＋ route。名簿で DX を確認、宛先は `recipientDecision` で match/open のみ許可、解決不能は fail-closed。inbox も宛先で絞る |

#### F-04 引継ぎスナップショットの PII 平文 — 原因は記載どおり（再現済み）

| 観点 | 結果 |
|---|---|
| 記載原因 | `lib/case-handover.ts` はメモ生成時に `redactPII` するが、保存する snapshot は素の case |
| 修正前コード | `HEAD:apps/api/src/lib/case-handover.ts:93-139` の `extractCaseSnapshot` が `case: targetCase` をそのまま返す。`HEAD:apps/api/src/routes/case-handovers.ts:250-262` が `jsonbValue(snapshot)` で INSERT → **記載と一致** |
| 実測 | `ai_helpdesk_f` の CASE-0001 / CASE-0002 に、それぞれ別の合成 PII（メール・電話・IP）が平文。G-05 の `prototype_states` も 4 種すべて平文 |
| 修正 | `redactSnapshotValue` で snapshot 全体（ネスト・配列）を伏せ字化。`device` / `deviceId` / `agentId` / `hostname` は識別子として保持。単体テスト（作者作成）23 件は自前実行で PASS |
| 残課題 | **`prototype_states`（相談本文・チャット）は未対策**。計画 §9「PII 平文 0」は snapshot 修正だけでは満たせない（§A-4 N-1） |

#### F-12 チェックリスト未確認でサーバー承認が先行 — 原因は記載どおり（コード確認）

| 観点 | 結果 |
|---|---|
| 記載原因 | `assist-bridge.js:1740-1770` のラッパがサーバー承認を先に実行し、その後にローカル承認を呼ぶ。ローカル失敗時に巻き戻さない。再承認は 409 |
| 修正前コード | `HEAD:apps/api/src/prototype/assist-bridge.js:1740-1770` — 1751 行で `POST /approve`、1757 行で `originalApprove.apply`。`HEAD:...html:2320` の `approve(id)` が 2325 行でチェックリストを検証。`HEAD:apps/api/src/routes/case-handovers.ts:494-500` が `claimed\|resolved` 以外を 409 `NOT_CLAIMED` → **すべて記載と一致** |
| 修正 | `ahClientApproveBlockReason()` で承認権限・申請者分離・チェックリスト 4 件を**サーバー呼び出し前に**検証。ローカル承認失敗時は `PATCH status=resolved` で補償し再承認可能にする。使用するグローバル（`isApprover` / `CHECKS` / `state` / `drById`）は HTML 側に実在することを確認（842/852/908/922 行）。`publish()` は同期で `status='approved'`・`kbId` を設定するため、補償の誤発火は起きない |
| 留意 | クライアント検証を HTML の `approve()` と二重実装している（将来の乖離リスク）。成功時に toast が二重になる。補償 PATCH は新設の「ヘルプデスクのみ」権限に依存する（DX なら可）。UI 実操作は Phase B で確認 |

#### G-01-F1 監査ハッシュチェーン破断 — 原因は記載どおり（機械的に証明）

| 観点 | 結果 |
|---|---|
| 記載原因 | `terminal.ts` が `detail.expiresAt` に `Date` を渡し、`stableStringify` が `Date` を `{}` にする一方、保存時は jsonb が ISO 文字列になる |
| 修正前コード | `HEAD:apps/api/src/routes/terminal.ts:152` = `detail: { actorEmail, caseId, expiresAt: session.expires_at }`、`HEAD:apps/api/src/domain/audit.ts:22-30` = `stableStringify`（Date 分岐なし）→ **記載と一致** |
| 証明 | 保存スナップショットから再計算すると、`expiresAt` を **Date として `{}`** にした場合の sha256 が保存値 `08fcd2…` と一致し、ISO 文字列として計算した `db7c5e…` は一致しない。**原因の機序を再現** |
| 追加 | 不整合は 10010 だけでなく **10013 も同型**（証跡は「1 箇所」）。本番 `ai_helpdesk_preview` の 15 行でも同じ 2 行が不整合 |
| 修正 | `stableStringify` が `Date` を ISO 文字列化。既知移行点（10010/10013）を保存 hash・再計算 hash 付きで固定し、既知行だけ読み飛ばす。最終状態では env `AUDIT_KNOWN_BREAKS` で環境ごとに設定可能（既定値が本番実測の 2 行、`scripts/audit-find-breaks.ts` で生成）。**修正版 `verifyAuditChain` を実データ（g 76 行・preview 15 行）に適用 → `ok:true, checked:76/15, knownBreaks:2`**（HTTP は Phase B） |
| 設計注意 | 既知 2 行を「読み飛ばして ok:true」にする設計。API は `knownBreaks` を返すが、消費側が表示しない限り「監査は健全」に見える。計画 §9「監査欠落 0」との整合を明記し、運用画面で既知移行点を可視化すべき |

#### G-01-F2（Medium）— 原因も記載どおり

`HEAD:apps/api/src/routes/cases.ts:157-166` の `appendAudit` が `actorId: null` を明示 → 修正で `user.id` に変更（確認済み）。

### A-4. 修正差分（`/tmp/aihd-fix`）の現状と Phase B 事前評価

**レビュー時点の指紋**（差分は 2 回更新された。最終的にレビューしたのは 09:45:21 の状態）:

```
2026-10-27T09:45:21+09:00
git diff                              sha256 = bee2efcea87e6096ce4dbe81442fbc3db24863554bde607310136d9b12437de6
git status --porcelain                sha256 = e9e9d792d6a68d6c3154cdf3289cc53a56d8b84ac487149037022db2461aab90
assist-bridge.js    5199dab50faf3b2e23f0573f1220688557d11a59e43ed75b72a5e7d959fce2c3
domain/audit.ts     d1803e2debec4e9aea9802a70a344586b14fd6c073286b7432392e9530494c14
config.ts           a8ac030ae12624fbed1c4c939d4e51caa59727fb1e39520c54d8a6d67f218d82
routes/terminal.ts  3e4a1c336d59dc176961ba9db2daac0c91a08fba39c47de8ca52ad8a43b2a42a
routes/cases.ts     1915b8a4c863f272fa0e75d8c55716e578c6d18e4473ba1e5f8b14b3087c2ad3
routes/case-handovers.ts 9d5587f52c194e34441a9d5625e369f0bd42f9e86849e489c7ce12936aeb0c71
lib/case-handover.ts      1d6457ff97165145f2b936995e17e26418b275eb5144d66f6b79af531744ec4f
auth/helpdesk-scope.ts    c80696dbedd03d2665d9b247f1eb96d3eee94bd1f94dcbe968fa88dcad4c44f6
lib/handover-notify.ts    0b15bdf20435a83fbc2a7a3ffbfd257b1fb8c7856da2f23fb35f81b04d09b2fa
scripts/audit-find-breaks.ts 7fc2ccdc0e481ca7afc79e0be7dab08e7c8f72a60bc236637c499c5dd5b3bb19
```

- 09:42:51 の状態（diff `270399c7…`）で F-01 / F-04 / F-05 / F-12 / G-01-F1 の実装を確認。09:44〜09:45 に `config.ts`・`domain/audit.ts`・`audit.test.ts`・`scripts/audit-find-breaks.ts` が追加され、既知破断が env `AUDIT_KNOWN_BREAKS`（`id:保存hash:再計算hash`）で環境ごとに設定可能になった。**最終状態でも関数レベル再確認済み**（§A-3 G-01）。
- 変更: 実装 8 ファイル（`case-handovers.ts` / `case-handover.ts` / `handover-notify.ts` / `assist-bridge.js` / `domain/audit.ts` / `routes/terminal.ts` / `routes/cases.ts` / `config.ts`）＋新規 `auth/helpdesk-scope.ts`・`scripts/audit-find-breaks.ts`、テスト 5 ファイル＋新規 `routes/audit.integration.test.ts`。
- テスト（**分離コピー**で自前実行）: **52 files / 455 tests PASS**（`/tmp/aihd-fix-rv2`、専用 DB `ai_helpdesk_rv_fix2`）。09:42 の状態でも 52 files / 452 tests PASS。作者テストを含むが、私が独立に実行した件数として記録する。
- **環境の罠（重要）**: `/tmp/aihd-fix` には `.env.test.local` への symlink があり、`NODE_ENV=test` では `dotenv` が `override:true` で読むため、**シェルの `DATABASE_URL` が上書きされる**。私は最初これに気づかず共有 DB で実行し 1 件 FAIL した（分離コピーでは PASS）。Phase B のビルド・テストは DB と env を明示して隔離すること。
- **差分が動いている**: 本レビュー中に 2 回内容が変わった。Phase B の前に**指紋を固定（freeze）**し、ビルド・テスト・再検証を同一スナップショットで行うこと。

| Phase B 項目 | 修正の有無 | 事前評価 | 条件・残リスク |
|---|---|---|---|
| F-01（inbox/claim 403・指名外 403・DX 正常 200） | あり | **PASS 見込み** | `AUTH_MODE=local` で一般社員が名簿解決できること。dev アカウントが名簿外だと `employeeNo=null` で指名あり claim は 403（意図どおり） |
| F-04（snapshot に平文なし・識別子保持） | あり | **PASS 見込み** | 新規作成の引継ぎで確認。既存行は平文のまま（遡及マスクなし）。`prototype_states` は対象外 |
| F-05（通知件名） | あり（`subject` をクライアントから送信＋サーバ補完） | **PASS 見込み** | SMTP シンクでの実受信確認が必要 |
| F-12（未確認でサーバー承認されない） | あり | **条件付き PASS 見込み** | UI 実操作で「チェックリスト OFF → 承認 → サーバー状態が completed にならない」を確認。直接 API 呼び出しは従来どおり承認できる（クライアント側の防御であり、サーバー強制ではない） |
| G-01（audit verify ok:true） | あり | **PASS 見込み** | 関数レベルでは実データで `ok:true` を確認済み。HTTP はビルド＋起動後の `/api/audit/verify` で確認（approver セッション必要）。`knownBreaks` の扱いを合格条件に含めるか要決定 |

**残る指摘（私の追加）**:

| # | 内容 | 重大度 |
|---|---|---|
| N-1 | **`prototype_states` の PII 平文は未修正**。G-05 は引き続き FAIL で、計画 §9「PII 平文 0」は達成できない。snapshot だけ直して High 0 とするのは**スコープの縮小**であり、G4 で明示的に判断・記録すべき | **High（ゲート）** |
| N-2 | 監査の既知移行点 2 行を「ok:true」で読み飛ばす。改ざん検知は維持される設計だが、**API 利用側が `knownBreaks` を無視すると破断が隠れる**。運用手順・画面表示・計画 §9 への反映が必要 | Medium |
| N-3 | F-12 のクライアント検証が HTML の `approve()` と二重実装。成功時の toast 二重。補償 PATCH が新設の権限チェックに依存 | Low |
| N-4 | `case-handover.ts` の `ExtractCaseSnapshotOptions.subject` のコメントが「現行の routes は渡していない」まま（実際は渡している）。コードとコメントが不一致 | Low |
| N-5 | PATCH `/api/case-handovers/:id` が**全員ヘルプデスク必須**に変更。UI の PATCH 呼び出しは DX 側のみ（確認済み）だが、API 利用の「辞退・取り下げ」経路があるなら回帰。Phase B で D-12 を確認 | Medium |
| N-6 | 既知移行点は env `AUDIT_KNOWN_BREAKS` で環境ごとに設定可能になった（既定は本番実測の 2 行、`scripts/audit-find-breaks.ts` で生成可）。ただし**既定値が本番 2 行を埋め込む**ため、別環境では設定漏れに注意。形式不正は起動時 fail-fast | Low |
| N-7 | `domain/audit.ts` が `config` を import するようになり、純粋なハッシュ関数が `DATABASE_URL` / `SESSION_SECRET` 等の env を要求する。単体で使うスクリプト・テストが env 必須になった（`knownBreaks` を引数で渡す形にすると結合が減る） | Low |

### A-5. PII・秘匿値の機械確認

実施: `grep -rInE`（氏名・メール・電話・IP・カード・owner のアカウント名・`@mirai-const`・`postgresql://`・`sk-`・JWT・`password`・`SECRET`）を `docs/evidence/verify-20261027/` 全体に適用。

| 種別 | 場所（file:line） | 内容 | 件数 | 対応 |
|---|---|---|---|---|
| **実メール** | `handover/D-findings.md:17`、`deploy/H-results.md:229` | owner の実 Gmail アドレス（`DEV_AUTH_EMAIL=` / `claimed_by=`） | 2 箇所 | **必ず伏せ字化**。計画 §3「証跡でも伏せ字化」違反 |
| **実在氏名** | `handover/C-results.md:7,8`（DX 5 名のフルネーム＋社員番号）、`kb/E-results.md:7,12`、`report/F-results.md:38`、`report/raw/ui-flow.txt:26,36`、`report/raw/report-content-checks.txt:29` | 承認者・担当者・宛先の氏名 | 10 行 | 氏名は伏せ字（社員番号のみ残す方針に合わせる） |
| **raw 内の氏名** | `platform/raw/g01-audit.txt:21-28` | 氏名 1 名（seed 由来か実在か不明） | 6 行 | 実在なら伏せ字。少なくとも「seed 由来」と明記 |
| **端末/アカウント名** | `deploy/raw/H04-run-new.log`・`H04-run-rollback.log`・`H03-mislabel-demo.log` | ログの `hostname` に owner のアカウント名 | 27 行 | 端末名としてマスク（メールと同一文字列のため誤認リスク） |
| **セッション隣接値** | `access/A-01-headers.txt:6-7` | Cloudflare Access のログイン URL＋署名付き meta JWT（有効 5 分・期限切れ）＋`CF_AppSession` Cookie（Expires 12h） | 1 ブロック | 証跡から削除推奨（単体では資格情報にならないが、セッション識別子） |
| **合成 PII** | `step1-3/B8-B14-results.md` ほか | `taro.yamada@example.com` / `090-1234-5678` 等 | — | 意図的な検証データ。**合成である旨を明記**（実データと誤認されないように） |
| DB パスワード・API キー・秘密鍵 | — | DB 接続文字列の実値、`sk-`、`BEGIN PRIVATE KEY`、`SESSION_SECRET=` の実値 | **0 件** | 良好（`H-results` は `$TARGET` 等のプレースホルダのみ） |

- 証跡はまだ **git untracked**（`?? docs/evidence/verify-20261027/`）であり、コミット前に修正できる。現状のままコミットすると計画 §8（PII を証跡に残さない）違反。
- G-results §6 の「raw 全体に実名・owner のアカウント名 が含まれない」という自己確認は、**自ファイルと deploy/ 配下を見ていない**ため成立していない（C-10）。

### A-6. 総括（Phase B への申し送り）

1. **数値の再現性は高い**。15 点以上の重要数値（health・dist digest・件数・HTTP・PDF・テスト・監査ハッシュ・権限）を自力で再現し、すべて証跡と一致した。証跡の「実測値」自体は信頼できる。
2. **ゲートはあるが台帳が不整合**。`docs/39` は NO-GO を明示しており妥当（H-01・020 未適用）。ただし「High 5 件」の内訳が 22 行と §3-1 で異なり、F-05 が High/Medium の両方に現れ、H-01 の扱いも揺れる。**G4 前に、ID を一意化した指摘一覧とゲート集計表（High 残存数）を確定すべき**。
3. **PII が証跡に残存**。実メール 2 箇所・実名 10 行以上・セッション隣接値 1 ブロック。コミット前に機械的な伏せ字化と再 grep が必要（私の grep パターンを回帰チェックに使える）。
4. **修正差分は Phase B の 5 項目をすべて含む**（09:45 時点の指紋）。関数レベルでは G-01 の `ok:true` と F-04 の識別子保持を確認済み。ただし (a) 差分が現在も編集されており**凍結が必要**、(b) `.env.test.local` による DB 上書きの罠、(c) `prototype_states` の PII 未対策（N-1）が残る。
5. **Phase B の判定基準を先に固定すること**。特に G-01 は `ok:true` だけでなく `knownBreaks` の許容を明記し、F-04 は「snapshot のみ」か「保存全体」かを明記する（現行の計画 §9 は「PII 平文 0」で後者）。
6. **本番への影響**: 監査チェーンの破断は本番 DB `ai_helpdesk_preview` にも存在（15 行中 2 行）。デプロイ判断では「既知移行点として許容するか」を明示する必要がある。

### A-7. 結果報告書（`docs/39`）との突合

`docs/39-full-verification-result-20261027.md`（09:33 作成・未コミット）は Phase A の入力リストに無かったが、存在を確認して突合した。

| 観点 | docs/39 の記載 | 私の確認 | 評価 |
|---|---|---|---|
| 総合判定 | **NO-GO**（H-01・020 未適用） | 妥当。`ai_helpdesk_preview` に 020 が無いことを SELECT で確認 | ○ |
| High の集合 | 22 行: F-01/F-04/**F-05**/F-12/G-01-F1 ／ §3-1 表: F-01/F-04/F-12/G-01-F1/**H-01** | 集合が不一致。F-05 は §3-2 で Medium | **要修正** |
| 修正後の再検証 | §5 は「記入待ち」（独立レビュアーの §B とあわせて確定） | Phase B 未実施と一致。**過大な PASS 主張は無い** | ○（誠実） |
| 回帰テスト | 「修正差分 447 tests / 1 failed。base でも同様に失敗」 | 分離環境の現行差分は **455/455 PASS**。1 failed は共有 DB のチケット 127 件 > `LIMIT 100` が原因で回帰ではない | **要更新**（C-13） |
| G-01 の破断行 | 「同一行で破断」（1 行） | 実際は 10010 と 10013 の **2 行**、本番 preview も同じ | 要修正（C-8） |
| PII | 本書でも伏せ字 | docs/39 に実名・実メールなし（grep 0 件） | ○ |
| 検証環境 | F: `:18958`/`:18962` と記載 | 現在は停止（C-9） | 注記要 |
| 未実施の申し送り | E2E 10 ラン未達・B/D/E の未実施を明記 | 証跡と整合 | ○ |

**評価**: docs/39 は「未実施を未実施と書く」「§5 を記入待ちにする」点で誠実であり、NO-GO の結論も妥当。修正すべきは **High 台帳の集合・F-05 の重大度・テスト件数/失敗原因・G-01 の破断行数**の 4 点で、いずれも「判定を誤らせる」種類の不整合である。

---

## §B. 修正後の再検証（Phase B）

> 実施: 2026-10-27 09:51〜10:05 JST（Asia/Tokyo）
> 対象: `/tmp/aihd-fix`（freeze `git diff` sha256 = `18feab155696f572db43ee51dcbb2b40f8f4851f8186fc8db31d387a8b27e4e1`）のビルドとインスタンス（`:18966` 一般社員 MK0122 / `:18967` DX MK0623、DB `ai_helpdesk_fix`）
> 追加検証環境: `:18968`（DX MK1073）・`:18969`（非DX MK0141）・`:18972`（自前 DB `ai_helpdesk_rvb`、監査 HTTP 用）。**Lead の `:18966/:18967` は停止・再起動していない**（追加分は終了時に停止）。
> 方針: 修正者のテストを根拠にせず、HTTP / DB / 実ブラウザ（Playwright）で自分の手順により再測した。

### B-1. 判定一覧

| ID | 観点 | 判定 | 実測の要点 |
|---|---|---|---|
| **F-01** | 一般社員 inbox/claim 403・指名外 claim 403・指名 DX claim 200・依頼者本人 GET 200 | **PASS** | 9 操作すべて期待どおり（§B-2） |
| **F-04** | snapshot にメール/電話/IP/カードの平文なし・端末識別子は保持 | **PASS** | 平文 4 種すべて 0、伏せ字 4 種あり、`device`/`agentId`/`hostname`/コンピュータ名は保持（§B-3） |
| **F-05** | 通知件名に案件件名・空件名は「(件名なし)」 | **PASS** | キュー 4 件＋SMTP シンク実受信 4 通で一致（§B-4） |
| **F-12** | チェックリスト未確認でサーバー承認されない／ON で正常完了 | **FAIL** | **未確認・ON のどちらも「対象のナレッジ下書きが見つかりません」で承認不能**（サーバー未到達）。共有案件の承認が全滅する回帰（§B-5） |
| **G-01** | `/api/audit/verify` が `ok:true`／既知破断を空にすると FAIL | **PASS** | HTTP 200 `{"ok":true,"checked":2}`、既知破断 2 行は `ok:true`、`AUDIT_KNOWN_BREAKS=''` では `ok:false,brokenAtId:10010`（§B-6） |

### B-2. F-01（PASS）

前提: 一般社員（`:18966`）が `PUT /api/state/cowork` で案件を保存し、`POST /api/case-handovers` で「MK0623 宛（B01/B03/B04）」と「MK1073 宛（B02）」を作成（通知は SMTP シンクへ実送信）。

| # | 操作 | 期待 | 実測 |
|---|---|---|---|
| 1 | 一般社員 `GET /inbox` | 403 | **403** FORBIDDEN |
| 2 | 一般社員 `POST /{B01}/claim` | 403 | **403** FORBIDDEN |
| 3 | 指名外 DX MK1073（`:18968`）が MK0623 宛 B03 を claim | 403 | **403** `RECIPIENT_MISMATCH` |
| 4 | 指名された DX MK0623（`:18967`）が B01 を claim | 200 | **200** claimed |
| 5 | 指名された DX MK1073（`:18968`）が B02 を claim | 200 | **200** claimed |
| 6 | 依頼者本人が `GET /{B01}` | 200 | **200** |
| 7 | 非所有者・非DX MK0141（`:18969`）が `GET /{B01}` | 403 | **403** FORBIDDEN |
| 8 | MK0623 の inbox | MK0623 宛のみ | **3 件（B01/B03/B04）**、B02 は非表示 |
| 9 | MK1073 の inbox | MK1073 宛のみ | **1 件（B02）** |

- 補足: claim は「引受先の状態（cowork と helpdesk の両方）が保存済み」でないと 409 `STATE_NOT_READY`（D-04 の既知挙動）。画面操作では状態が保存されるため問題ない。DX に状態を PUT した後は 200 になった。
- 補足: `GET /{id}` は DX（ヘルプデスク相当）なら他人の案件も 200（設計どおり）。「依頼者本人のみ」という表現は「非DXの他人は 403」の意味で満たしている。

### B-3. F-04（PASS）

PII を含む案件（メール `b04@example.com` / 電話 `090-1111-2222` / IP `10.9.8.7` / カード `4111 1111 1111 1111`、端末 `MRK-NB-1000`）を引継ぎ、DB の `case_handovers.snapshot` を直接検査。

| 検査 | CASE-B01 | CASE-B02 |
|---|---|---|
| メール平文 | **なし** | なし |
| 電話平文 | **なし** | **なし** |
| IP 平文 | **なし** | **なし** |
| カード平文 | **なし** | なし（カード無し） |
| 伏せ字 `[メールアドレス]` / `[電話番号]` / `[IPアドレス]` / `[カード番号]` | **すべてあり** | 該当分あり |
| `case.device` / `pc.snap.device` / `remote.agentId` / `remote.hostname` | **`MRK-NB-1000` / `MRK-NB-1000` / `AGENT-MRK-2000` / `MRK-NB-1000` を保持** | 保持 |
| 表示用シリアル・PC内IP | `SN123456` / `10.1.2.3` は伏せ字（設計どおり） | — |

- 追加確認: 通知メール本文・件名にも PII 平文は無し（4 通すべて `body_has_pii=f` / `subject_has_pii=f`）。
- **残存**: `prototype_states`（相談本文・チャット）には平文が残る（修正対象外）。G-05 の High は未解消（§B-7）。

### B-4. F-05（PASS）

| ケース | 入力 | 通知キュー `subject` | SMTP シンク実受信 |
|---|---|---|---|
| B01 | 案件件名あり＋クライアント `subject` | `[AIヘルプデスク] 引継ぎ: 【PhaseB】共有フォルダの権限申請で連絡先が通じない（CASE-B01）` | 同文（MIME を unfold/decode して確認） |
| B02 | 案件件名あり | `...【PhaseB】別担当宛の引継ぎ（CASE-B02）` | 同文 |
| B03 | 案件件名なし・チケット概要あり | `...【PhaseB】チケット概要から補完（CASE-B03）` | 同文（フォールバック動作） |
| B04 | 件名・概要・チャット名（プレースホルダ）のみ | `...(件名なし)（CASE-B04）` | 同文 |

### B-5. F-12（FAIL）— 共有案件の承認が全滅する回帰

**実測（`:18967`、Playwright、承認画面を実際に表示してボタンをクリック）**

| 手順 | 実測 |
|---|---|
| 承認者 actor = 承認権限のあるデモ名、下書き DR-F12（`review`）、共有案件 CASE-B01（`handoverId` あり） | パネル表示 OK、承認ボタン有効、チェックリスト 4 件は未チェック |
| **チェック未確認のまま「承認してDB保存・本棚に反映」をクリック** | toast「**対象のナレッジ下書きが見つかりません**」。`case_handovers` は `claimed` のまま・`approved_by` NULL・`audit_log` に approve 行なし（**サーバー未到達**） |
| 4 件すべてチェックして再クリック | **同じ toast**。DB 状態も `claimed` のまま（**正常完了できない**） |

**原因（コードとスコープの実測）**

- ヘルプデスク側スクリプトは IIFE（`Mirai_AIHelpdesk_Cowork_StepWizard_V3.1_PCinfo_Offline.html:812`〜`2485`）で、`state` / `drById` / `CHECKS` / `isApprover` は**その内部に閉じている**。
- ブリッジは別 `<script>`（配信ページの script index 3）で、ページ文脈での実測は `typeof state === 'undefined'`、`typeof drById === 'undefined'`、`typeof CHECKS === 'undefined'`、`typeof isApprover === 'undefined'`。
- 修正コード `ahDraftById()`（`apps/api/src/prototype/assist-bridge.js:1222-1228`）は `typeof drById === 'function' ? … : null` とガードしているため、**常に null**。`ahClientApproveBlockReason()`（同 1234 行〜）が「対象のナレッジ下書きが見つかりません」を返し、`const blocked`（同 1832 行）で**サーバー呼び出しの前に必ず中断**する。
- `window.HD` には `draftInfo` / `actor` が公開されている（実測キーに含まれる）ため、`window.HD.draftInfo(id)` と actor 取得を使えば参照可能だった。ガード付きの `typeof` が失敗を黙って飲み込み、**全承認をブロックする回帰**になっている。
- 影響: STEP4 で共有された案件の承認（＝通常の担当者解決フロー）が**すべて実行不能**。修正前は「チェック ON なら承認できた（OFF のとき巻き戻らない）」ため、**修正前より悪化**している。F-12 の受入条件「ON なら正常完了」は満たせない。
- なお、サーバー API を直接叩けば承認自体は可能（クライアント側防御のため）。これは F-12 の設計上の限界であり、今回の FAIL とは別。

**修正案（Lead 向け）**: ブリッジを HD と同じスコープに注入するか、`window.HD.draftInfo` / `window.HD.actor` 等の公開 API 経由に変更する。`typeof` ガードで黙って block せず、依存が取れない場合は「承認できません（画面を再読み込み）」と明示して**フェイルクローズでも通常承認を殺さない**設計にする。修正後は本節の手順（未確認→ON）を再実行する。

### B-6. G-01（PASS）

| 検査 | 期待 | 実測 |
|---|---|---|
| `POST /api/audit/verify`（新規 DB・approver セッション） | `ok:true` | **200 `{"ok":true,"checked":2}`**（自前 `:18972` + 自前 DB `ai_helpdesk_rvb`、freeze と同一ビルド） |
| Lead DB `ai_helpdesk_fix` の 2 行（claim） | `ok:true` | 関数レベルで `{"ok":true,"checked":2}` |
| 既知破断あり DB（本番 `ai_helpdesk_preview` 15 行）・既定 `AUDIT_KNOWN_BREAKS` | `ok:true`（既知 2 行を読み飛ばす） | **`ok:true, checked:15, knownBreaks:[10010,10013]`** |
| 同 DB・`AUDIT_KNOWN_BREAKS=''` | **FAIL** | **`ok:false, checked:10, brokenAtId:10010, expected:db7c5e…, actual:08fcd2…`** |

- 補足: `ai_helpdesk_fix` は **users が 0 行**のため、同 DB のインスタンスではセッション必須の `/api/audit/verify` を実行できない。HTTP 検証は同一ビルド・同一コードの自前インスタンス＋自前 DB で行った（環境差のみ）。
- 補足: 既知破断は env で環境ごとに設定可能（`scripts/audit-find-breaks.ts` で生成）。読み飛ばしは保存 hash と再計算 hash の両方を固定しており、当該行の改ざんは検知できる（設計として妥当）。

### B-7. High 4 件＋H-01 の最終状態

| ID | 最終状態 | 根拠 |
|---|---|---|
| **F-01** | **修正済み・PASS** | 9 操作すべて期待どおり（§B-2） |
| **F-04** | **修正済み・PASS（Phase B 観点）／G-05 は未解消** | snapshot は平文 0・識別子保持。`prototype_states` は平文のままで、計画 §9「PII 平文 0」は未達（スコープ判断が必要） |
| **F-12** | **修正不成立・FAIL（High 残存）** | 共有案件の承認が全滅（§B-5）。`docs/39` の「修正済み」は要訂正 |
| **G-01-F1** | **修正済み・PASS** | HTTP `ok:true`、空設定で FAIL することを確認（§B-6） |
| **H-01** | **未解消（NO-GO 継続）** | 稼働 `1bde379` / 候補 `84bba83`、本番 020 未適用。デプロイ（ビルド＋020＋再起動＋COMMIT_SHA）で解消する性質は変わらない |

### B-8. `docs/39` の修正確認

Lead が修正した点は確認できた。

| 項目 | 状態 |
|---|---|
| High 台帳 | **4 件（F-01/F-04/F-12/G-01-F1）＋配備ドリフト H-01** に整理され、F-05 は Medium。§A の C-1 は解消 |
| G-01 の破断行 | **2 行（10010/10013、preview も同じ）** に修正。C-8 は解消 |
| 回帰テスト | 420 / 455 / 共有 DB の 1 failed（DB 汚染）に整理。C-13 は解消 |
| **F-12 の状態** | §3-1 は依然「**修正済み**」。Phase B は FAIL のため「**修正したが再検証で FAIL（回帰）**」へ訂正が必要 |
| §5 再検証 | 本節の結果を転記し、「記入待ち」を解除する必要 |

### B-9. 残存リスク（§A 指摘の整理）

| # | リスク | 重大度 | 対応案 |
|---|---|---|---|
| R-1 | **F-12 の承認全滅回帰**（本 Phase B の新規） | **High** | §B-5 の修正案。修正後、私の手順（未確認→ON）で再検証 |
| R-2 | **`prototype_states` の PII 平文**（G-05） | **High（定義次第）** | snapshot のみの修正で「High 0」とするなら、計画 §9 の「PII 平文 0」を「引継ぎスナップショットおよび報告書」に限定する判断を G4 で記録する。状態保存も対象にするなら別修正が必要 |
| R-3 | F-01 / F-04 の **ID 二重定義**（AUTHZ と完了表示、PII と報告書内容） | Medium | 指摘 ID を一意化（例: AUTHZ-01 / COMPLETE-01 / PII-01 / REPORT-CONTENT-01） |
| R-4 | **期待値の扱いの不統一**（A-06 は FAIL、F-17/E-07 は PASS） | Medium | 「実装が妥当なら期待値を更新し PASS」の規則を G4 で固定 |
| R-5 | **未実施を含む PASS**（F-04 実行記録、B-02 必須検証、E-07 401） | Medium | PASS の定義（全サブ条件成立）を明記し、部分は「部分PASS」に統一 |
| R-6 | **引継ぎ create がサーバ監査に無い**（F-02 の主張と不一致。claim/approve は記録される） | Medium | `POST /case-handovers` にも 1 行追加、または docs/39 の F-02 の記述を「claim/approve のみ」に訂正 |
| R-7 | **証跡の PII**（実 Gmail 2 箇所・実名 10 行以上・AppSession/JWT） | **High（コミット前）** | §A-5 のとおり伏せ字化・削除。docs/39 自体は PII なし |
| R-8 | **F-01 修正で PATCH が全員ヘルプデスク必須に変更** | Medium | 依頼者の「取り下げ・辞退」API 経路があるなら回帰。D-12 の実測を追加 |
| R-9 | **検証 DB `ai_helpdesk_fix` に users が無い** | Low | 監査 API などセッション必須の確認ができない。seed を入れるか、検証手順に明記 |

### B-10. 再現メモ

- F-12 の再現: `:18967` を Playwright で開き、HD 状態（drafts/INC）を PUT → `App.go('approve','DR-F12')` で承認画面を表示 → 承認ボタンをクリック。toast・`case_handovers.status`・`audit_log` を確認。
- F-01/F-04/F-05 のデータは `:18966` から API で作成（CASE-B01〜B04）。DB は `ai_helpdesk_fix`（Lead の検証用）。既存サービス・本番 DB へは書き込みなし。
- G-01 の HTTP は自前 DB `ai_helpdesk_rvb`（seed 済み・approver セッション）。既知破断の比較は `ai_helpdesk_preview` の SELECT のみ。
- 追加で起動した `:18968/:18969/:18972` は終了時に停止済み。Lead の `:18966/:18967` は稼働継続。

---

## §C. F-12 是正・create 監査の再検証（Phase C）

> 実施: 2026-10-27 10:11〜10:20 JST（Asia/Tokyo）
> 対象 freeze: `git diff` sha256 = `13b9ca95e95fbaf2a9e880248c8867a90529c7fdf8c823c91241746675cd2f14`（前回 `18feab15` から assist-bridge.js の F-12 是正と case-handovers.ts の create 監査を追加）
> 環境: Lead の `:18966`（一般社員 MK0122）/`:18967`（DX MK0623）、DB `ai_helpdesk_fix`。**Lead の 2 インスタンスは停止・再起動せず**、実ブラウザ（Playwright）で操作した。追加検証は自前の分離コピー（`.env` なし）と自前 DB `ai_helpdesk_rvb` を使用（§C-6 の env 危険性のため）。

### C-1. 判定一覧

| ID | 観点 | 判定 | 要点 |
|---|---|---|---|
| **F-12** | (a) 未確認→サーバー不変 (b) ON→完了 (c) 共有外の通常承認 (d) 補償 | **PASS（4/4）** | すべて実ブラウザで実測（§C-2） |
| **F-02** | create 監査が 1 操作 1 行 | **PASS** | `case_handover.create` 1 行・同一トランザクション（§C-3） |
| F-01 | 回帰（403/403/200） | **PASS** | 一般社員 inbox/claim 403、DX claim 200（§C-4） |
| F-04 | 回帰（snapshot 平文なし・識別子保持） | **PASS** | B05 で 4 種平文 0・識別子保持（§C-4） |
| F-05 | 回帰（通知件名） | **PASS** | B05 の件名が正しい（§C-4） |
| G-01 | 回帰（audit verify ok:true） | **PASS** | 新規行 8 行で `ok:true`、HTTP 200 `{"ok":true,"checked":3}`（§C-5） |

### C-2. F-12（PASS）

対象: `:18967`、HD 状態に下書き DR-F12（`review`）＋共有案件 CASE-B01（`handoverId`）＋承認者 actor を用意。

| ケース | 操作 | 実測 | 判定 |
|---|---|---|---|
| (a) 未確認 | 4 件すべて未チェックで「承認してDB保存・本棚に反映」を実クリック | toast「**チェックリストをすべて確認してください**」（「見つかりません」は出ない）。`case_handovers` は **claimed のまま**・`approved_by` NULL・`audit_log` に approve 行なし（サーバー未到達） | **PASS** |
| (b) 確認済み | 4 件をチェックして再クリック | サーバー承認 200 → `status=completed`・`approved_by` あり・`self_approved=true`・**approve 監査 1 行**。下書きは **`approved` / `kbId=KB-111`**、KB-111 が `active` で作成。toast は自己承認の警告 | **PASS** |
| (c) 共有外 | 共有案件に紐づかない DR-F13 を、共有案件の無い状態で承認 | サーバー呼び出しなし（監査行は増えない）。**下書きは `approved` / `kbId=KB-112`**、KB-112 作成。従来の通常承認は壊れていない | **PASS** |
| (d) 補償 | 共有案件 B03 で、サーバー承認後にローカル承認が失敗する状態（既存 KB の履歴不整合で `publish` が失敗）を作り承認 | サーバー承認は成立（approve 監査 +1）。続いて **PATCH `resolved` の補償**が実行され `status=resolved`・resolve 監査 +1。toast「**サーバーの承認は成立しましたが、画面の承認に失敗したため、引継ぎを「対応中」に戻しました…**」、下書きは `review` のまま | **PASS** |

- (c)(d) の画面表示は、再読込後に HD の承認ビューへの遷移がシェルの再描画で戻るため、**アプリ自身の `window.HD.panel('approve', id)` で承認パネルを描画し、実ボタン（`App.approve`）をクリック**した。承認処理そのものは本物の UI 経路（ブリッジのラッパー＋`originalApprove`）を通っている。
- 修正の実装確認: `ahDraftInfo()` は `window.HD.draftInfo()`、`ahActorName()` は `window.HD.actor()`、チェックリストは DOM の `#ck0`〜`#ck3` を参照。内部状態が取れない場合はブロックせず従来動作へフォールバックする（`ahClientApproveBlockReason` が draft 不在で `null`）。前回の「別 script から IIFE 内 `drById` を参照して全承認をブロック」という回帰は解消されている。

### C-3. F-02 create 監査（PASS）

`:18966` から CASE-B05 を引継ぎ作成（`POST /api/case-handovers`）。

| 検査 | 実測 |
|---|---|
| `case_handover.create` 行 | **1 行**（`target_id=cf41e2d8-…`、`detail.caseId=CASE-B05`、`detail.recipient_no=MK0623`、`actorEmail` あり） |
| 1 操作 1 行 | create 1／claim 4（B01/B02/B03/B05）／approve 2（B01/B03）／resolve 1（補償）＝各操作 1 行 |
| トランザクション | コード上、INSERT と `recordHandoverAudit` が同一 `sql.begin(...)` 内（目視確認） |

### C-4. 回帰（F-01 / F-04 / F-05）

| 検査 | 実測 | 判定 |
|---|---|---|
| F-01: 一般社員 `GET /inbox` | **403** | PASS |
| F-01: 一般社員 `POST /{B05}/claim` | **403** FORBIDDEN | PASS |
| F-01: DX MK0623 `POST /{B05}/claim` | **200** claimed（claim 監査 +1） | PASS |
| F-04: B05 snapshot の平文 | メール/電話/IP/カード **すべて false** | PASS |
| F-04: 端末識別子 | `MRK-NB-5000`・`AGENT-MRK-5000` を保持、シリアル `SN555555` は伏せ字 | PASS |
| F-05: B05 通知件名 | `[AIヘルプデスク] 引継ぎ: 【PhaseC】create監査とPIIの回帰確認（CASE-B05）`・`sent` | PASS |

### C-5. G-01 回帰（PASS）

| 検査 | 実測 |
|---|---|
| `ai_helpdesk_fix` の監査 8 行（claim/approve/create/resolve 混在） | 関数レベル `{"ok":true,"checked":8}` |
| `POST /api/audit/verify`（分離コピー＋自前 DB、approver セッション） | **200 `{"ok":true,"checked":3}`** |
| 既知破断の扱い | 前回同様、既定で `knownBreaks` 2 行を読み飛ばし、`AUDIT_KNOWN_BREAKS=''` では `ok:false`（Phase B で確認済み・今回も同じコード） |

### C-6. 環境の危険（重要・Lead 向け）

- `/tmp/aihd-fix` には 10:11 時点で **`.env.local` / `.env.test.local` の symlink が復活**しており、`config.ts` は非 production で `dotenv` を **`override: true`** で読む。そのため `NODE_ENV=development` で `/tmp/aihd-fix` から新規インスタンスを起動すると、**明示した `PORT` / `DATABASE_URL` が `.env.local` の値で上書きされる**。
- 実際に私の検証用インスタンス（`PORT=18972` 指定）が **`:18950` を bind しようとして EADDRINUSE で終了**した。**本番 DB `ai_helpdesk_preview` は不変**（監査 15 行・max id 10014 を確認）で、listen 前に終了したため書き込みはない。
- 対策: Lead の 2 インスタンスを再起動する際は symlink を退避した状態で行うか、`/tmp/aihd-fix` 以外の分離コピーから起動する。私は後者（`.env` を除いたコピー）で監査 HTTP を実施した。
- `health` の commit は `18feab15-fix` のままだが、監査 HTTP は分離コピーの `13b9ca95-fix` で確認しており、コード同一性は freeze 指紋で担保している。

### C-7. High 残存数と G5 再判定材料

| 指標 | 値 | 根拠 |
|---|---|---|
| **コード High（F-01 / F-04 / F-12 / G-01-F1）残存** | **0** | F-01/F-04/F-12/G-01 すべて Phase B/C で PASS |
| 追加の High 候補 | **1（G-05: `prototype_states` の PII 平文）** | snapshot は修正済みだが状態保存は未対策。計画 §9「PII 平文 0」をそのまま適用するなら未達。スコープを「snapshot と報告書」に限定するなら 0 |
| 配備ドリフト **H-01** | **未解消** | 稼働 `1bde379` / 候補 `84bba83`、本番 `020` 未適用。デプロイ（ビルド＋migrate 020＋再起動＋`COMMIT_SHA` 是正＋スモーク S1〜S7＋24h 監視）で解消する性質は変わらない |

- **判定材料**: コード起因の High は 0 になった。ただし **H-01 と本番 020 未適用が残るため、現時点の G5 は NO-GO のまま**。§6 のデプロイ手順と §B/§C の PASS、24h 監視の用意が揃えば **GO に変更できる**。G-05 を High に数えるかは G4 で明示的なスコープ判断が必要。
- **docs/39 の更新**: §3-1 の F-12 を「修正済み」から「**Phase C で PASS**」へ、§5 の再検証表を本節の結果で埋め、「High 残存 0（コード）／H-01 未解消で NO-GO」を反映する。F-02 は create も含めて PASS。

### C-8. 残存リスク（§B から継続）

| # | リスク | 状態 |
|---|---|---|
| R-2 | `prototype_states` の PII 平文（G-05） | 未解消（スコープ判断待ち） |
| R-3 | 指摘 ID の二重定義（F-01/F-04） | 未解消（文書） |
| R-4 | 期待値の扱いの不統一（A-06 vs F-17/E-07） | 未解消（G4 で規則化） |
| R-5 | 未実施を含む PASS（F-04 実行記録・B-02・E-07） | 未解消（文書） |
| R-7 | 証跡の実 Gmail 2 箇所・実名・AppSession/JWT | 未解消（コミット前必須） |
| R-8 | PATCH 全員ヘルプデスク必須化（辞退・取下げ経路） | 未検証（D-12） |
| R-9 | `ai_helpdesk_fix` は users=0（セッション必須 API 不可） | 継続（監査 HTTP は自前 DB で代替） |
| R-10 | `.env` symlink による PORT/DB 上書き（§C-6） | **新規・要運用注意** |

### C-9. 後始末

- 追加起動した分離コピー `:18972` は停止済み。Lead の `:18966/:18967` は稼働継続。
- 検証データ CASE-B05 は `ai_helpdesk_fix` に残置（Lead の検証用 DB）。本番 DB への書き込みなし。
- `.env` symlink は**私が変更していない**（Lead の設定のまま）。
