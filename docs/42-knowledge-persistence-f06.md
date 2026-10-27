# F-06: ナレッジ下書き・承認のサーバ永続化

- 対象: AI HelpDesk（`apps/api` / プロトタイプ UI）
- 実装日: 2026-10-27
- 関連: `docs/39-full-verification-result-20261027.md` の F-06、`docs/41-self-approval-and-inbox-policy.md` の別 ID 承認、`docs/40-deploy-20261027.md` §7

## 1. 直していた問題

STEP6 のナレッジ下書き作成・承認・差戻しは、**ブラウザ内の state（`state.drafts` / `state.kb`）だけ**を更新していた。

そのため、

- サーバの `knowledge` テーブルは 0 行のまま（`docs/39` の実測）
- 別のブラウザ・別の PC では承認結果が見えない
- `docs/41` の「別 ID での承認」は、下書きがクライアント状態のため **API を直接叩いて**しか検証できなかった（`docs/41` の 2026-10-27 追記）

API とテーブル自体（`knowledge` / `knowledge_reviews`）は 001 から存在し、`POST /api/cases/:id/knowledge-draft` と
`POST /api/terminal/sessions/:id/knowledge-draft` はサーバへ下書きを作っていた。
欠けていたのは **画面側の承認系操作をサーバへ接続する経路**である。

## 2. 変更内容

### 2-1. migration 022（`db/migrations/022_knowledge_client_ref.sql`）

- `knowledge.client_ref text` を追加（画面の下書き ID）
- `(client_ref) WHERE client_ref IS NOT NULL` の**部分一意インデックス**を追加

既存行は `client_ref IS NULL` のままで影響を受けない。画面の下書き ID をキーにするので、
再送・二重クリック・リロード後の再操作でも行が増えない。

### 2-2. API（`apps/api/src/routes/knowledge.ts`）

`POST /api/knowledge/ui-sync` を追加した。画面の状態をそのまま受け取り、`client_ref` で冪等に同期する。

| 項目 | 内容 |
|---|---|
| 認証 | `authenticateUi`（Access の画面セッション）。`requireHelpdeskActor` で DX 推進部の担当者に限定 |
| 入力 | `clientRef`, `status`（`draft` / `pending` / `approved` / `rejected`）, タイトル・症状・原因・手順・キーワード、承認時は `checklist` と `comment` |
| 下書き・申請 | 行が無ければ `nextKbNo` で採番して作成し、`status` を反映 |
| 承認 | 4 項目チェックリストが揃っていることを必須化。`knowledge_reviews` に承認行を作り、`approver_id` / `approved_at` / `version+1` を記録 |
| 差戻し | 理由（`comment`）を必須化。`knowledge_reviews` に差戻し行を記録 |
| PII | タイトル・症状・原因・手順は `redactPII` を通す（既存 API と同じ） |
| 監査 | `knowledge.create` / `knowledge.submit` / `knowledge.approve` / `knowledge.reject` を `appendAudit` で記録。承認の `detail` に `selfApproved` を残す |

**既存の `POST /api/knowledge/:id/review` は変更していない。**
こちらは Bearer セッションと `role=approver` を前提にした API パートナー向けの経路で、
画面（単一 Access ID 運用）とは信頼境界が違うため、UI 用の経路を分けた。

### 2-3. 自己承認の扱い（SM-02 と同一）

- 承認は `config.ALLOW_SELF_APPROVAL` に従う（**既定 true**）。運用（単一 Access ID）を壊さない。
- `false` のとき、作成者本人の承認は **403 `SELF_APPROVAL_FORBIDDEN`** で止め、状態も監査も変えない。
- 自己承認かどうかは応答の `selfApproved` と監査 `detail.selfApproved` に残す（黙って通さない）。

### 2-4. 画面側の接続

| 場所 | 変更 |
|---|---|
| `Mirai_AIHelpdesk_Cowork_StepWizard_V3.1_PCinfo_Offline.html` | 公開 API `window.HD.draftForSync(id)` を追加（下書きの本文を返す） |
| `apps/api/src/prototype/assist-bridge.js` | `App.submitDraft`（申請）・`App.approve`（承認）・`App.returnDraft`（差戻し）をラップし、サーバへ同期 |

挙動:

- **承認**は「サーバへ保存 → 成功したら画面を更新」。サーバ保存に失敗した場合は**承認を行わず**、理由をトーストで表示する（画面だけ承認済みになる状態を作らない）。
- **引継ぎ案件（`case_handovers`）の承認**は従来どおり `/api/case-handovers/:id/approve` を通る（変更なし）。
- **申請・差戻し**は画面操作を妨げない。失敗時はトーストで知らせ、承認時に改めて永続化する。

### 2-5. 共通化

`userIdForEmail` / `ensureAuthorUser` を `apps/api/src/lib/users.ts` へ移し、`terminal.ts` と `knowledge.ts` で共用する（実装の二重化を避ける）。

## 3. 検証（2026-10-27）

| 項目 | 結果 |
|---|---|
| 型検査 `npm run typecheck` | 成功（エラーなし） |
| `biome check apps scripts worker db tests` | exit 0（警告のみ・既存水準） |
| migration 022 | 空の検証 DB へ 001〜022 を順に適用して成功。`knowledge_client_ref_uq` が部分一意インデックスとして作成されることを確認 |
| プロトタイプ単体テスト（`apps/api/src/prototype/**`） | **15 passed**（`assist-bridge.test.ts` 13 件を含む） |
| 統合テスト（`knowledge-ui.integration.test.ts`） | **CI で実行**（下記） |

### 統合テストをローカルで実行できなかった理由

この環境には HelpDesk のテスト用 DB 接続設定（`.env.test.local`）が無く、
資格情報領域の参照は許可されていない。ローカルの PostgreSQL は TCP がパスワード必須・
Unix ソケットは peer 認証のみで、`postgres.js` は URL 形式でソケットを指定できない。
そのため統合テストは **PR の CI（PostgreSQL サービス）で実行**する。
テスト内容は以下を固定している。

1. 申請でサーバに残り、同じ `clientRef` の再送で行が増えない
2. 自己承認は既定で許可され、`knowledge_reviews` と監査（create→submit→approve）が残る
3. `ALLOW_SELF_APPROVAL=false` は 403 で止まり、状態・レビューが変わらない
4. 別の DX 担当者が承認すると `selfApproved=false` になり、承認者を記録する
5. チェックリスト不足の承認は 400、差戻しは理由必須

## 4. 制約（意図的にやっていないこと）

- **案件（`cases`）への紐付けは行わない**。画面の下書きはチケット ID を持たないため `case_id` は NULL。
  案件を完了させるのは従来どおり `case_handovers` の承認経路の責務。
- ナレッジの「本棚」表示・AI の出典反映は従来どおり画面状態を使う（サーバは保存先の追加であって置き換えではない）。
- `rspSessionId` の相互参照や Phase 2 の取込は変更していない。

## 5. ロールバック

- アプリ: 本 PR を revert すれば画面は従来のクライアント状態のみに戻る（サーバの列は無害）。
- DB: `022` は列と部分インデックスの追加のみ。戻す場合は
  `DROP INDEX IF EXISTS knowledge_client_ref_uq; ALTER TABLE knowledge DROP COLUMN IF EXISTS client_ref;`

---

## 6. 追加実装（2026-10-27）— 承認者向け pending 一覧と別ID承認

PR #79 の実装だけでは、**承認者（別ID）の画面に他人の下書きが出ない**（下書きは自分のクライアント状態にしか無い）。実測で確認したため、差分を追加した（PR #82）。

### 6-1. 変更

| 側 | 内容 |
|---|---|
| サーバ | `GET /api/knowledge/pending`（`authenticateUi` + `requireHelpdeskActor`）。`client_ref` 付きの `draft`/`pending` を最大50件、`authorEmail` 付きで返す（`/knowledge/:id` より先に登録） |
| UI | 「⑥ 承認者の確認」に **サーバ下書き（承認待ち）** セクション。4項目ONで承認可。承認は既存 `POST /api/knowledge/ui-sync` を再送（専用 API は追加しない）。却下は理由必須。障害時はローカル画面を維持 |

### 6-2. 本番での職務分離の実測

同一社員の別アドレスを使うため `EMAIL_ALIASES` を一時的に外して別ID化し、**作者と承認者を分けて**承認した（検証後に設定は復元）。

| 項目 | 実測 |
|---|---|
| 下書き（KB-2026-0103） | 作成者 = **gmail**（別名ありの状態で作成） |
| 承認 | `EMAIL_ALIASES` を外した状態で、**社内アドレス**のセッションが `/api/knowledge/ui-sync`（画面の承認と同じ経路）で承認 → 200 |
| knowledge | `status=approved` / `version=2` / `author=gmail` / **`approver=社内アドレス`** |
| 監査 | `knowledge.approve` の `detail.selfApproved` = **false**（`clientRef`・comment 付き） |
| reviews | `approved` / reviewer = **社内アドレス** |

> 補足: 本番の社員名簿は実質1名のため、別ID化には `EMAIL_ALIASES` の一時解除が必要。**解除中は gmail が名簿に解決できず 403** になるため、「gmail で作成 → 別名解除 → 社内アドレスで承認」の順で行う必要がある（この順序を実測で確認）。
> 画面のクリック操作そのものは検証インスタンス（API モック）で確認済み。本番では同じエンドポイントを直接呼んで確認した。

### 6-3. 残課題

- `knowledge.approve` の監査 `detail` に **actorEmail が無い**（`approver_id` と `knowledge_reviews` には残る）。監査画面で一行で追うなら追加が望ましい（SM-11）。
- 承認待ちのテストデータ `KB-2026-0102`（作成者=社内アドレス）が残置。不要なら却下（`ui-sync` status=rejected）で整理する。

## 7. UI 完結確認（2026-10-27 14:48）— 残置の pending を別 ID で承認

§3 の「統合テストはサーバ経路のみ」に対し、**本番 UI からの完結**を実測した。

| 項目 | 値 |
|---|---|
| 操作 | 本番 `https://ai-helpdesk.mirai-dx-platform.com/` をブラウザで開き（Access セッション）、承認画面の「サーバ下書き（承認待ち）」→ `KB-2026-0102` のチェックリスト4件を確認 → 承認 |
| 操作前 | `knowledge` 合計 **12 行**（approved 11 / pending 1）。`KB-2026-0102` = pending・version 1・作成者 `k-aritoh@mirai-const.co.jp` |
| 操作後 | `knowledge` 合計 **12 行**（approved 12）。`KB-2026-0102` = **approved**・version **2**・承認者 **`kensan1969@gmail.com`**・`approved_at` `2026-10-27T05:48:52Z` |
| 監査 | `knowledge.approve` / `detail.selfApproved=false` / `2026-10-27T05:48:52Z` |
| ゲート | チェックリスト4件が未チェックの間は「承認」ボタンが **disabled**（実測） |

確認できたこと:

- **行が増えず更新される**（`clientRef` による冪等更新。pending → approved で version+1）
- **別 ID による承認が UI から成立**する（作成者=社内アドレス、承認者=gmail、`self_approved=false`）
- 承認はサーバ保存が成功した後に画面へ反映される（F-06 の再発防止の設計どおり）

これにより「下書き → 承認申請 → 承認」の全段が UI 経由でサーバに残ることを、申請（`KB-2026-0102` の
`knowledge.submit` / `clientRef=ui-f06b-…`）と承認（本節）の両方で確認した。
§6-3 の残置データは本操作で approved となったため、未処理の pending は 0 件。

## 8. 即時スモーク監視（2026-10-27 14:50）

24h 監視（翌 10:45）を待たずに一度点検した。**今回の変更に起因する異常は無し**。

| 項目 | 実測 |
|---|---|
| health `:18950` / `:18949` | `ok:true` / `db:ok` / `commit:"d9fb7da"` / `env:"production"` |
| RSP `/health`（:8130） | `status:ok` / `database:ok` |
| `ai-helpdesk-api.service` | active / `NRestarts=0` / メモリ 55.6MB |
| 24h のログ | 4,190 行。**5xx 4 件・error 3 件はすべて 10/26 18:11〜20:12 の `unsupported Unicode escape` と 10/27 11:13 の 502**（いずれも今回のデプロイ前）。**14:24 / 14:44 のデプロイ以降は 0 件** |
| ホスト | ディスク 83% 使用 / load 2.61 3.15 3.15 |

留意: 10/26 の `unsupported Unicode escape`（PostgresError → 500）は未修正の既存事象であり、
本変更とは無関係。再発時に別件として調査する。本節は 24h 監視の**代替ではない**。

## 9. 残課題（4 ロール職務分離）

F-06 の残りは「4 ロール（担当／承認／監査／IT 端末管理）のサーバ分離」であり、
`ALLOW_SELF_APPROVAL=true` を維持している間は職務分離が設定依存である。
設計案と移行計画（Phase A〜C・受入条件・未決事項）は **`docs/43-role-separation-design.md`** に提案として起案した（実装は未着手）。

## 10. SM-11 の修正とテストデータの整理（2026-10-27 14:52）

- `POST /api/knowledge/ui-sync` の監査 detail に **`actorEmail`** を追加した（`knowledge.create` / `submit` / `approve` / `reject`。PR #84）。`actor_id`（users FK）に加え、Access の実行者メールを1行で追える。
- 本番実測: 新しい `knowledge.approve` の detail が
  `{"via":"ui","comment":"SM-11 検証","clientRef":"…","actorEmail":"k…@gmail.com","selfApproved":true}` となり、`actorEmail` が記録されることを確認（修正前の行には無い）。
- テストデータの整理: 検証で作成した `client_ref LIKE 'ui-f06%' / 'ui-sm11%'` の knowledge 4行と knowledge_reviews 4行を削除。**knowledge はシード9行に復帰**（監査ログは append-only のため削除せず履歴として残置）。
- 以上により §6-3 の残課題（SM-11・残置データ）は解消。
