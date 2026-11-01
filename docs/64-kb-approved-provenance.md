# 64. AI の根拠を DB の承認済みナレッジに限定する

対象: `apps/api/src/lib/knowledge-search.ts`、`apps/api/src/ai/deepseek.ts`、`POST /api/knowledge/ui-sync`、`assist-bridge.js`

## 1. 直した問題

`prototype_states` はブラウザが送る JSON である。修正前の `/api/ai/answer` は、その `data.kb` の `status='active'` を
承認済みとして根拠にしていた。一般相談者が自分の state に KB を入れれば、承認なしで根拠になった。
一方でユーザー単位のため、担当者が承認した KB は別の相談者に届かなかった。

## 2. AI の根拠の条件

`findApprovedKnowledge`（`cases.ts` の案件診断も同じ関数）は DB の `knowledge` だけを読み、次をすべて要求する。

| 条件 | 内容 |
|---|---|
| 承認 | `status='approved'`、`approver_id` と `approved_at` がある |
| 職務分離 | `approver_id <> author_id`（[docs/58](./58-phase-c-applied-20261028.md) のとおりアカウント単位）。同一人物の別アカウント（`SHARED_IDENTITY_GROUPS`）は除かず、`sharedIdentity` として応答と監査に残す |
| 版 | `updated_at <= approved_at`（承認後に行が更新されていない）。版は出典（`sources[].version`）とプロンプト（`[KB-… v2]`）に出す |

- 承認と `version` 加算は同じトランザクションで、`updated_at` はトリガの `now()` なので `approved_at` と一致する。
- 案件や解決記録の削除で `case_id` / `resolution_id` が `SET NULL` になると `updated_at` も進み、その KB は根拠から外れる（安全側）。
  検出スクリプトの `editedAfterApproval` に数える。
- 本人の state の KB は「未承認資料」としても使わない。出典で区別する必要が生じないようにするため。

## 3. 外部 AI へ送る内容

承認済み KB は全相談者の相談で候補になる。送信量と内容は次のように制限する。

- 件数は 3 件まで（従来どおり）。一致点が 2 未満の KB は送らない。無関係な相談では KB を送らない。
- 1 件あたり 題名 160 / 症状 600 / 原因 600 / 手順 1,500 字で切る。
  各項目最大長の 3 件で 8,351 字（結合試験のスタブが受け取った実測値）。上限がないと約 48,000 字になる。
- 送る前に `redactPII` を再度かける。保存時の伏せ字に加える二重の防御である。

`keywords` が空の行（画面経路は原本の `draftForSync` が返さないため空で保存される）は、題名の 3 文字以上の語で照合する。保存値は変えない。

## 4. 既存データと移行案

既存データは自動で書き換えない。件数は読み取り専用スクリプトで確認する。

```bash
AUDIT_DATABASE_URL=<接続先> SHARED_IDENTITY_GROUPS=<本番と同じ値> \
  node scripts/report-state-kb-provenance.mjs [--allow-db=<DB 名>]
```

出力は件数だけで、メール・題名・本文を含まない。DB 名が `_test` で終わらない場合は `--allow-db` がなければ接続しない。
**本番 DB への実行はユーザーの判断で行う。この PR の作業では実行していない。**

| 出力 | 意味 | 移行案 |
|---|---|---|
| `state.demoInitial` | 原本 HTML の初期 KB（KB-101 系のデモ）。全員の state に入る | 対応不要。AI の根拠から外れるだけ。本番で必要な内容は下書きとして起票する |
| `state.noDraftLink` | 下書きと結びつかない active KB（デモでない）。JSON 読込や不正入力の可能性 | 内容を担当者が確認し、必要なら新しい下書きにする。自動取り込みしない |
| `state.linkedNoDbRow` | 下書きはあるが DB に行がない。引継ぎ経路の承認で起きる（§5） | 担当者が再度下書きを申請し、別人が承認する |
| `state.linkedNotUsable` | DB に行はあるが使えない（承認待ち、自己承認など） | 別の承認者が承認する。自己承認の行は次の行を参照 |
| `db.selfApproved` | 承認済みだが作成者本人の承認 | 別のアカウントが内容を確認して再承認する手順を決める（下記） |
| `db.usableSharedIdentity` | 使えるが、承認者と作成者が同一人物の別アカウント | 記録のみ。別の人物が画面で承認できるようになったら、除外するか判断する（§7） |
| `db.editedAfterApproval` | 承認後に行が更新された | 差分を確認して再承認する |
| `db.usableWithoutKeywords` | 使えるがキーワードが空 | 題名で照合されるため必須ではない。精度が足りなければ別途補う |
| `db.draftsWithoutClientRef` | 承認前で `client_ref` がない（この修正前の端末記録の下書きなど）。画面から承認できない | 自動で書き換えない。必要なら起票し直す |

公開済みの行は `ui-sync` で変更できないので、再承認には新しい下書きとして起票し直す。`approver_id` を SQL で書き換えない。

## 5. 引継ぎの承認と KB 公開

`POST /api/case-handovers/:id/approve` は案件の完了を承認するだけで、`knowledge` に書かない。
従来の画面は同じ「承認」ボタンから引継ぎの承認と原本のローカル公開を行い、「ナレッジを承認しました」と表示していた。
そのため DB の行は申請中のまま残っていた。

`assist-bridge.js` は引継ぎの承認後に `ui-sync` で KB の公開を別に保存し、両方の結果を分けて表示する。
公開に失敗しても引継ぎの承認は戻さず、未公開と伝える。行は申請中のまま残るので「サーバ下書き」から承認し直せる。

### 引継ぎワークスペースの「ナレッジ下書きを作成」

`POST /api/terminal/sessions/:id/knowledge-draft` は、`client_ref = terminal-<session id>`、`status='pending'` で行を作る。

- 画面に下書きを編集する導線はなく、作成の時点で「承認待ち」と表示していたので、実際の状態を表示に合わせた。自動公開はしない。
- 承認者は ⑥ 承認者の確認の「サーバ下書き」から承認する。DX 推進部以外の承認者にも一覧に出る。
- 既存の `client_ref` なしの行は書き換えない。件数は検出スクリプトの `db.draftsWithoutClientRef` で確認する。必要なら作成者が別の手順で起票し直す。

## 6. `POST /api/knowledge/ui-sync` の調査結果

クライアントは `status` を指定できるが、権限はサーバーで判定している。

| 操作 | 判定 | 結果 |
|---|---|---|
| 一般社員の `pending` / `approved` | `requireHelpdeskActor` / `requireApproverActor` | 403 |
| ヘルプデスクでない承認者が未知の `clientRef` で `approved` | `requireHelpdeskActor` | 403 |
| `approverId` / `version` / `approved` の指定 | zod が捨てる | 無視される |
| 公開済みの行の更新 | `conflict` | 409 |
| **他人の行を `draft` / `pending` で上書き** | **判定なし（修正前）** | **本文を差し替えて自分で承認でき、職務分離を抜けられた。作成者別の別の行（`<clientRef>~<作成者 ID 先頭 8 桁>`）に保存し、元の行を変えないように修正** |
| 本文比較と承認の競合 | 条件付き更新 | 承認の `UPDATE` に状態と本文の一致を条件に入れた。行ロックの後で評価し直すので、比較の直後に作成者が更新しても 409 で止まる。作成者の更新も `status <> 'approved'` を条件にした（PATCH と `/review` も同様） |
| 自己承認（`ALLOW_SELF_APPROVAL=true`） | 設定で許可 | 行は `approved` になるが AI の根拠にしない。応答の `aiUsable=false` で画面に伝える |

下書き番号（`DR-001`）はブラウザごとの連番で担当者間で重なる。別の行にするのはこのためで、拒否すると二人目の担当者が保存できなくなる。
本文の上限は計 16,000 字なので、`bodyLimit` を 64KiB に広げた（16KiB では端末記録の長い下書きを承認できない）。

## 7. 影響と残課題

- 相談者の AI 回答から、原本 HTML のデモ KB（KB-101 系）が根拠として消える。DB に承認済み KB がなければ「担当者へ引き継いでください」が増える。
- 画面内の決定ルールと `HD.kb()`（ブラウザ内の検索、API 障害時の `originalKb`）は引き続き state の KB を使う。本人のブラウザだけで完結し、サーバーの根拠にはならない。DB で未承認のものは承認済みと表示しない（[docs/14](./14-prototype-ui-integration.md) 2-14）。
- `findApprovedKnowledge` は更新順に 100 件までを照合する。承認済みが 100 件を超えると古い KB は候補から外れる。
- 職務分離はアカウント単位である。[docs/61](./61-approvers-and-owners-20261031.md) §7 のとおり、画面から承認できるのは現在人物 A の 2 アカウントだけなので、同一人物の承認を除くと新しい KB が AI に届かなくなる。別の人物が画面で承認できるようになった時点で、除外を検討する。
- `MIN_SCORE` は案件診断（`cases.ts`）が示す KB にも適用される。`scripts/eval` は実行していない。
