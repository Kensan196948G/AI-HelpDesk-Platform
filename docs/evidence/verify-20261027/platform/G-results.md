# Phase 5 — G: 横断・非機能（12）＋回帰（6）実測結果

実施: 2026-10-27 09:10〜09:35 JST（Asia/Tokyo）
対象: `/tmp/aihd-head`（`main` 84bba83 のビルド。`apps/api/dist` 使用）
実行者: 検証担当 verify-g（API / psql / SMTP シンク / Playwright Chromium headless）

## 0. 環境（既存インスタンス・本番DBには触れない）

| 項目 | 実測値 |
|---|---|
| 検証 DB | `ai_helpdesk_g`（`ai_helpdesk_ui` のスナップショットを複製して作成。本番 `ai_helpdesk_preview` へは書き込みなし） |
| 一般社員 | `:18959`（`AUTH_MODE=local`、`DEV_AUTH_EMAIL=MK0122`＝東京支店工事部、`EMAIL_ALIASES` なし） |
| DX 推進部 | `:18964`（`AUTH_MODE=local`、`DEV_AUTH_EMAIL=MK0623`＝管理本部DX推進部） |
| メール | `MAIL_TRANSPORT=smtp` / `SMTP_HOST=127.0.0.1` / `SMTP_PORT=2526`（SMTP シンク稼働中） |
| RSP | `RSP_BASE_URL=http://127.0.0.1:8130`（uvicorn 稼働中） |
| 既存 18950/18951/18952/18954/18956/18957 | **未停止・未再起動**（`ss -ltnp` で稼働確認のみ） |
| 参考 DB | `ai_helpdesk_ui`（源流。監査チェーンの比較に read-only で使用） |

- 実名・メール・シークレットは伏せ字（`***`）。証跡の raw にも実名・実メール・シークレットを残していない（後述 §6 で機械確認）。
- 検証用のローカルユーザー 3 ロール（requester/helpdesk/approver）は **`ai_helpdesk_g` の `users.password_hash` のみ**を検証用に更新してセッションを取得した（本番・他 DB は不変）。

> 手順上の注意（再現性）: 実行シェルに `DATABASE_URL` が既に設定されている環境では、起動時に明示上書きしないと意図しない DB へ接続する。本検証では `/proc/<既存PID>/environ` から基盤設定を読み、`DATABASE_URL` だけを `ai_helpdesk_g` へ差し替えて起動した。

## 1. サマリー

| ID | 検証内容 | 判定 | 実測の要点 |
|---|---|---|---|
| G-01 | 監査（横断） | **FAIL（High 1 / Medium 2）** | 監査行は 76 件・対象/時刻あり。ただし**ハッシュチェーンが 1 箇所で破断**（改ざん検知不能）、actor 欠落 26 件、引継ぎ操作は監査 0 件 |
| G-02 | 権限分離（5ロール） | **部分PASS（Medium 1）** | 一般社員の不可操作は 403 / 非表示。ただしサーバのロールは 3 種のみで、DX 内 4 ロール（担当/承認/監査/IT端末管理）の分離は無い |
| G-03 | 状態保存（14キー） | **PASS** | 14 キー保持。`{v:31}` のみの状態でも白画面にならず 14 キーへ補完 |
| G-04 | API 全到達・5xx 0 | **PASS** | ルート定義 **73 本**（`/api` 71＋静的 2）を grep で列挙し **73/73 到達・5xx 0**（85 リクエスト） |
| G-05 | PII マスク（保存前） | **FAIL（High・既知 F-04 の再確認）** | `case_handovers.snapshot` と `prototype_states` にメール/電話/IP/カードが**平文** |
| G-06 | メール通知（キュー→送信→再試行→failed） | **PASS** | 送信成功 8 件（attempts=1）。失敗経路は attempts 1→5 で `failed`、6 回目は送信対象外 |
| G-07 | 二重引継ぎ防止 | **PASS** | 部分一意 index あり。同一案件の再共有は旧行 `cancelled`＋新行 1 件、同時 2 本でも有効行は 1 |
| G-08 | RSP 連携 401/200 境界 | **PASS（HelpDesk 側）／BLOCKED（RSP 側 200）** | 誤キー 401・正キー+operator 200・proxy-secret 付き 403・RSP `:8130` 未認証 401。RSP セッションが無く RSP 経由 200 は未実施 |
| G-09 | ナレッジ検索（承認済みのみ・出典順） | **PASS** | 一般社員は approved のみ（12 件）。draft 3 件は非公開。出典はスコア降順 |
| G-10 | ダッシュボード/統計 | **PASS** | API と DB COUNT が全項目一致（total 9 / in_progress 3 / completed 4 / signal 4-4-1） |
| G-11 | 表示幅 1280/1600 | **PASS** | 両幅で横スクロール 0（`scrollWidth == clientWidth`）、本文描画量も保持 |
| G-12 | キーボード/Esc/フォーカス | **部分PASS（Low 1）** | Esc は両モーダルを閉じる。ただし**開いたモーダルへフォーカスが移動しない**（トラップ無し） |
| 回帰 | unit / typecheck / lint / build / secret scan / migrate 冪等 | **PASS（6/6）** | unit **420 PASS**（50 files）/ typecheck 0 / lint 0（警告 198・info 110）/ build 0 / scan 0 / migrate 新規 20→再実行 skip 20 |

- **新規 High 1 件**（G-01-F1: 監査チェーン破断）、**新規 Medium 2 件**（G-01-F2: actor 欠落、G-02-F1: 5ロール分離）、**新規 Low 2 件**（G-02-F2: 初期表示の 403 呼び出し、G-12-F1: モーダルのフォーカス）。
- 既知 FAIL の再確認: **F-01（他者宛閲覧/claim）再現**、**F-02（引継ぎ監査なし）再確認**、**F-04（PII 平文）再確認**。F-05（件名なし）は API 経路では再現せず、UI 経路由来と判断。F-06（承認の職務分離）は G-02 の Medium と同根。

## 2. ケース別実測

### G-01 監査（横断）— FAIL（High 1 / Medium 2）

| 観点 | 実測 | 判定 |
|---|---|---|
| 行数・対象・時刻 | `audit_log` **76 行**。`action` / `target_type` / `target_id` / `created_at` は全行あり | PASS |
| actor | `actor_id IS NULL` が **26 行**（`case.ai_assess` 6、`terminal.session.start` 4、`resolution.*` 8、`terminal.*` 6、`seed_demo_data` 1 ほか） | **FAIL（Medium）** |
| ハッシュチェーン | `POST /api/audit/verify` → `{"ok":false,"checked":10,"brokenAtId":10010,...}` | **FAIL（High）** |
| 引継ぎ操作 | `target_type IN ('case_handover','handover')` の監査行 = **0**（create/claim/approve いずれも無し） | **FAIL（Medium・既知 F-02）** |

**G-01-F1【High】監査ハッシュチェーンが `terminal.session.expire` で破断（改ざん検知不能）**
- 実測: `brokenAtId=10010`（`terminal.session.expire`、2026-10-26 09:29）。保存 `hash=08fcd2…`、再計算 `db7c5e…` が不一致。以降の行は破断行の保存 hash を `prev_hash` に取るため、**以降全部が検証不能**（`checked=10` で打ち切り）。
- **clone 依存ではない**: 源流 DB `ai_helpdesk_ui` でも同一行・同一値で破断（`raw/g01-audit.txt`）。すなわち本番系 DB にも同じ破断が存在する。
- 原因（コード）: `apps/api/src/routes/terminal.ts:152` が `detail: { ..., expiresAt: session.expires_at }` と **`Date` を渡している**。ハッシュ計算の `stableStringify`（`apps/api/src/domain/audit.ts:23-30`）は `Date` を「キー無しオブジェクト」として `{}` に落とす一方、保存時は jsonb が ISO 文字列になるため、**保存値から再計算したハッシュが一致しない**。
- 影響: 監査ログの改ざん・欠落を機械検知できない（E-10 / F-08 の前提が崩れる）。`/api/audit/verify` は常に `ok:false` を返す。
- 修正方針: `detail` へ入れる前に `expiresAt` を ISO 文字列化する（`new Date(...).toISOString()`）。併せて `stableStringify` で `Date` を ISO 文字列として扱い、既存破断行の再計算互換を設計する（過去行は再ハッシュ不可のため、`brokenAtId` を既知の移行点として記録する扱いが必要）。

**G-01-F2【Medium】`case.ai_assess` の actor が NULL（6 件）**
- 実測: `action='case.ai_assess'` 6 件すべて `actor_id IS NULL`。「誰の相談を AI が評価したか」が監査の主体として残らない（対象 `case` は記録される）。
- 原因: `apps/api/src/routes/cases.ts:158-166` の `appendAudit` が **`actorId: null` を明示**しており、`request.authUser`（`user.id`）を使っていない。

**G-01-F3【Medium／既知 F-02 の再確認】引継ぎの作成・claim・承認がサーバ監査に無い**
- 実測: 引継ぎ create 2 回・claim 3 回・approve 1 回を実行し、`audit_log` の増分は **0**。`prototype_states.helpdesk.audit`（クライアント状態）にのみ記録され、actor は `system`。
- 該当: `apps/api/src/routes/case-handovers.ts`（`appendAudit` 呼び出しが 1 つも無い）。

### G-02 権限分離（5ロール）— 部分PASS（Medium 1）

サーバ API のロール境界（`requireRole`）:

| 呼び出し元 | `GET /api/audit` | `GET /api/desk/queue` | `POST /api/knowledge/:id/review` |
|---|---|---|---|
| 一般社員（requester） | **403** FORBIDDEN | **403** FORBIDDEN | **403** FORBIDDEN |
| ヘルプデスク（helpdesk） | **403** FORBIDDEN | 200 | **403** FORBIDDEN（`requireRole('approver')`） |
| 承認者（approver） | 200 | 200 | 200 |

UI（可視要素のみを抽出。非表示の DOM は除外）:

| 画面 | 一般社員 `:18959` | DX `:18964` |
|---|---|---|
| ヘルプデスク業務・承認キューの可視ラベル | **なし**（STEP タブのみ） | あり（`引継ぎ` / `ヘルプデスク業務▾` 等） |
| `GET /api/dashboard` | 200（`role=requester`、`total=5`＝自分の案件のみ） | 200（全件） |

**G-02-F1【Medium】「5 ロール」のうち DX 内 4 ロールの分離が無い**
- 実測: 名簿解決は DX 推進部メンバー全員に `staff/approver/auditor/itadmin` を同時付与する設計（`Mirai_AIHelpdesk_Cowork_StepWizard_V3.1_PCinfo_Offline.html:2544-2550`）。サーバの `users.role` は `requester/helpdesk/approver` の 3 種のみで、**「監査担当者」「IT端末管理者」に対応するサーバ強制が存在しない**（`IT端末管理` の承認 API は DX でも 403＝`/api/resolve/admin/pending`）。
- 影響: 「一般社員 ⇔ DX」の 2 水準の分離は成立するが、DX 内の職務分離（承認者と担当者の分離、監査専任、端末管理専任）は**クライアント状態のみ**で、サーバでは担保されない（既知 F-06 と同根）。

**G-02-F2【Low】初期表示で権限外 API を呼び 403 がコンソールに出る**
- 実測: 一般社員・DX の双方で `/api/resolve/admin/pending` **403**、`/api/remote-support/session` **403（一般社員）/404（DX）**。画面は表示されるが、コンソールに 3 件のエラーが出る（A-12 の CSP エラーとは別種）。

### G-03 状態保存（14キー）— PASS

| 観点 | 実測 |
|---|---|
| 14 キー | 一般社員・DX とも `v,ui,chats,proposals,tickets,audit,devices,faqCandidates,faqs,estop,failNext,counters,stats,cases` の **14/14** |
| 欠落時の復元 | `PUT /api/state/cowork {data:{v:31}}` → 再読込で**白画面なし**（本文 8,595 文字）、`console error 0`、14 キーへ補完、`一覧` 画面も描画（7,944 文字）、`cases=0`（補完のみでデータは増やさない） |
| 復元後 | 元の 14 キー状態へ復元し一致を確認 |
| DB | `prototype_states`（cowork）3 ユーザーすべて **14 キー** |

### G-04 API 全到達・5xx 0 — PASS

- ルート定義の列挙: `apps/api/src/routes/*.ts` ＋ `resolve/routes.ts` ＋ `remote-support/routes.ts` を grep（`app.get|post|put|patch|delete`）→ **73 本**（内訳: `/api` 71 本＋静的 `GET /`・`GET /index.html` の 2 本）。
  - 計画書の「47 本」は 2026-10-25 時点の定義。現行 HEAD は `resolve/*`（11）・`terminal/*`（12）等が加わり 71 本。**計画値を上回る全数を到達確認**した。
- 到達結果: **73/73 到達・HTTP 5xx 0**（総リクエスト 85。最終ステータス内訳: **2xx 50 / 4xx 23**）。認証要否を踏まえた到達結果は `raw/g04-api-coverage.txt`（全 73 行の表）。
- 4xx の内訳: 401 3（デバイストークン必須）、403 6（認可）、404 5（存在しない ID を渡した確認）、409 6（状態遷移の競合）、**400 3（入力検証で拒否＝到達）**: `POST /api/device/browser`・`POST /api/device/command`・`POST /api/ai/remote-prompt`（いずれも検証用の最小 body がスキーマに満たないため。ハンドラ到達と 5xx 0 は確認）。
- 認証別の代表例:

| 認証 | 例 | 実測 |
|---|---|---|
| UI 局所認証（`DEV_AUTH_EMAIL`） | `GET/PUT /api/state`, `POST /api/ai/answer`, `POST /api/case-handovers` | 200 |
| セッション（cookie） | `/api/audit`（approver 200 / 他 403）、`/api/desk/queue`、`/api/cases`、`/api/knowledge` | 200 / 403 |
| デバイストークン必須 | `/api/device/agent`, `/api/device/command` | **401**（未認証で拒否＝到達） |
| RSP 統合ヘッダー | `/api/terminal/*` | 200（正キー+operator） |
| 認可で拒否 | `/api/resolve/admin/pending`（403）、`/api/remote-support/*`（403） | 4xx（5xx なし） |

- 主要フローは 2xx で通過: 案件作成→handoff→resolve、チケット更新/解決記録、ナレッジ下書き→申請→承認、報告書 HTML/PDF（`200`、PDF 646ms）、端末セッション 開始→提案→実行記録→終了→報告書→KB下書き（すべて 200）。
- `POST /api/ai/answer` は実 DeepSeek（`provider=deepseek` / `model=deepseek-flash`）で 200（約 2.2 秒）。

### G-05 PII マスク（保存前）— FAIL（High・既知 F-04）

検証用の合成 PII（`taro.sample@example.com` / `090-0000-1111` / `192.168.10.25` / `4111 1111 1111 1111`）を本文・チャットに入れ、UI と同じ経路（`PUT /api/state/cowork` → `POST /api/case-handovers`）で保存した。

| 保存先 | 平文の残存 | 実測 |
|---|---|---|
| `prototype_states`（cowork 状態） | **あり** | 4 種すべて平文 |
| `case_handovers.snapshot`（jsonb） | **あり** | email/phone/IP/card の 4 種すべて `true` |
| 通知メール本文 | なし | 本文・PC 情報を含まない（C-07 と一致） |
| 通知メール件名 | なし | 件名は `redactPII` 済み |

- **修正前は FAIL**（既知 F-04 の再確認）。原因は `apps/api/src/lib/case-handover.ts` の `extractCaseSnapshot` が `redactPII` を通さず素の case オブジェクトを `snapshot` に保存する点（`routes/case-handovers.ts:250-262` で `jsonbValue(snapshot)`）。
- 併せて、`POST /api/cases`（サーバ API 経路）は `redactPII` 済みで保存されることを確認（同 API の subject/body は伏字化）。**UI 状態と引継ぎスナップショットの 2 経路が未マスク**。

### G-06 メール通知 — PASS

| 段階 | 実測 |
|---|---|
| キュー生成 | 引継ぎ作成時に `notify.queued=1`（`transport=smtp`）。`case_handover_notifications` に 1 行（`pending`） |
| 送信 | SMTP シンク `:2526` へ送信成功。**8 行が `sent` / attempts=1**（初回 flush で送信） |
| 再試行→failed | SMTP 2599（未 listen）で flush を反復: attempts **1→2→3→4→5**、`last_error="connect ECONNREFUSED 127.0.0.1:2599"`、5 回目で `status='failed'`、6 回目は送信対象外（`remaining=0`） |
| 実装境界 | `MAX_ATTEMPTS=5`、`WHERE status='pending' AND attempts < 5`、`CASE WHEN attempts+1 >= 5 THEN 'failed'`（`apps/api/src/lib/handover-notify.ts:32,159-161,196-200`） |
| 件名（F-05 の再確認） | API 経路では `[AIヘルプデスク] 引継ぎ: 【検証G07】二重引継ぎ防止（CASE-G5-2）` と**正しく入る**。UI 経路（STEP4 直後の共有）でのみ `(件名なし)` になる既知 F-05 は、件名が状態へ反映される前の共有が原因で、API 経路では再現しない |

### G-07 二重引継ぎ防止 — PASS

| 観点 | 実測 |
|---|---|
| 部分一意 index | `case_handovers_active_case_idx ON (case_id, owner_email) WHERE status IN ('pending','claimed')` が存在 |
| 同一案件の再共有 | 1 回目 `pending` → 2 回目で旧行 `cancelled`＋新行 `pending`（**有効行は常に 1**） |
| 同時 2 本の共有 | 2 リクエストとも **200**（5xx なし）。結果の有効行も **1**（`raw/g05-g07-handover.txt`） |
| 二重 claim | 同一利用者の再 claim は 200（冪等）。**別担当（一般社員）が先に claim すると 200 で取得でき、以降の正当な担当は 409 ALREADY_HANDLED**（下記 F-01 の再現） |
| 通知の二重生成 | `(handover_id, recipient_email)` の一意 index により再共有でも 1 通/宛先 |

**F-01【High・既知／再現】他者宛の引継ぎ閲覧と claim**
- 実測: 一般社員セッション `:18959` の `GET /api/case-handovers/inbox` が **3 件**（DX 宛を含む）を返し、`MK0623` 指名の引継ぎに対する `POST /api/case-handovers/{id}/claim` が **200 / status=claimed**（横取り成功）。
- 原因: `apps/api/src/routes/case-handovers.ts` の `requireHelpdesk()` は `AUTH_MODE !== 'cloudflare-access'` で**早期 return（開発バイパス）**、かつ claim は `recipient_no`（宛先指名）を検証しない。inbox も宛先で絞らない。
- 本番（`cloudflare-access`）では DX 推進部以外は 403 になるが、**DX メンバー間では宛先指名が無視され、他者宛を claim できる**（職務分離の欠落）。

### G-08 RSP 連携 401/200 境界 — PASS（HelpDesk 側）／BLOCKED（RSP 側 200）

HelpDesk `:18959` の `/api/terminal/*`（`authenticateTerminal`）:

| リクエスト | 期待 | 実測 |
|---|---|---|
| 統合ヘッダーなし（局所 UI 認証） | 開発時 200 | **200** |
| 誤った `x-helpdesk-service-key` | 401 | **401** |
| 正しいキー + `x-operator-email`（loopback） | 200 | **200** |
| 正しいキー + 不正 operator | 401 | **401** |
| 正しいキー + `x-proxy-secret`（公開経路） | 403 | **403** |

RSP `:8130` の `/api/v1/helpdesk/*`:

| リクエスト | 実測 |
|---|---|
| `/api/v1/helpdesk/sessions`・`/cases`・`/context`（未認証） | **401**（`require_remote_support` で拒否） |
| RSP セッション有りでの 200 | **BLOCKED**（RSP のログイン資格情報が本検証の範囲外。RSP 側 JWT を偽造しない方針） |

- 実装: loopback 限定・`x-proxy-secret` 付きは 403・本番は Access 許可リスト照合（`apps/api/src/auth/rsp-integration.ts:48-90`）を確認。**認証境界は仕様どおり**。

### G-09 ナレッジ検索（承認済みのみ・出典順）— PASS

| 観点 | 実測 |
|---|---|
| 承認済みのみ | `GET /api/knowledge`（一般社員）= **approved 12 件のみ**。承認者 = draft 3＋approved 12 |
| 承認前の非公開 | draft 3 件（`KB-2026-0103/0105/0106`）は一般社員の一覧にも AI の出典にも**出ない** |
| 出典順 | `POST /api/ai/answer`（"プリンタで印刷できない"）→ sources は `KB-108` → `KB-2026-0003` の順。`scoreKnowledge`（`apps/api/src/lib/knowledge-search.ts:12-55`）はスコア降順で `slice(0,3)`。承認済み KB のみを対象にした実行でも 3 件がスコア順に返る（`raw/g09-knowledge.txt`） |
| 絞り込み | 検索 SQL は `WHERE status = 'approved'`（`lib/knowledge-search.ts:62`） |

### G-10 ダッシュボード/統計 — PASS

| 指標 | API | DB COUNT | 一致 |
|---|---|---|---|
| total | 9 | 9 | ○ |
| in_progress | 3 | 3 | ○ |
| completed | 4 | 4 | ○ |
| ai_resolved | 0 | 0（`ai_resolved=true` も 0） | ○ |
| signal blue/amber/red | 4 / 4 / 1 | 4 / 4 / 1 | ○ |
| pendingKnowledge | 0 | 0 | ○ |
| myQueueCount | 2 | 3（全担当の queued/assigned/in_progress） | ○（API は「自分 or 未割当」で絞る仕様どおり） |

### G-11 表示幅 1280/1600 — PASS

| 幅 | 一般社員 | DX |
|---|---|---|
| 1280×900 | `scrollWidth=1280 / clientWidth=1280`（横スクロールなし） | 同 |
| 1600×900 | `scrollWidth=1600 / clientWidth=1600`（横スクロールなし） | 同 |
| 本文描画量 | 8,650 文字 | 8,762 文字 |

- 3 ペイン（ナビ・本文・補助）の崩れは目視相当の DOM 計測で検出せず。スクリーンショットは実名を含むため**リポジトリに保存していない**（計測値のみ）。

### G-12 キーボード・Esc・フォーカス — 部分PASS（Low 1）

| 観点 | 実測 | 判定 |
|---|---|---|
| Esc でモーダルを閉じる（Cowork `#modal`） | 開: 可視 → Esc 後: `hide`（不可視） | PASS |
| Esc でモーダルを閉じる（HelpDesk `#hdModal`） | 開 → Esc 後 `open` 解除 | PASS |
| Tab 移動 | 4〜6 回の Tab で `ホーム→新しい相談→ボード→一覧→…` と移動。`:focus-visible` の outline（`auto/1px`）が全要素で有効 | PASS |
| **モーダルを開いた時のフォーカス** | `modal()` 実行後も `document.activeElement` は背後のボタンのまま（`focusInsideModal=false`） | **FAIL（Low）** |
| フォーカス復帰 | 開閉でフォーカスが動かないため「復帰」は見かけ上成立（`focusReturned=true` はフォーカスが移動していないことの裏返し） | — |

**G-12-F1【Low】モーダルのフォーカス管理が無い**
- 影響: スクリーンリーダー／キーボード利用時に、モーダル表示後も背後の要素へ Tab で抜けられる。Esc は効くため操作不能にはならない。修正は `modal()`（HTML:3369）/`App.closeModal`（2184）で `aria-hidden`・初期フォーカス・復帰先の保存を追加する。

## 3. 回帰（6）— PASS 6/6

実行場所: `/tmp/aihd-head`（84bba83）。ログは `raw/regression/`。

| # | 項目 | コマンド | 結果 |
|---|---|---|---|
| 1 | unit | `npx vitest run --reporter=dot` | **PASS**: 50 files / **420 tests passed**（`raw/regression/unit2.log`） |
| 2 | typecheck | `npm run typecheck` | **PASS**（exit 0、出力なし） |
| 3 | lint | `npm run lint`（biome check） | **PASS**（exit 0。**警告 198・info 110・エラー 0**。`--max-diagnostics` 超過で全件は非表示） |
| 4 | build | `npm run build`（tsc） | **PASS**（exit 0） |
| 5 | secret scan | `bash scripts/scan-secrets.sh` | **PASS**: `No obvious secret patterns found.` |
| 6 | migrate 冪等 | `tsx scripts/migrate.ts` を 2 回 | **PASS**: 既存 DB は 2 回とも skip（適用 0）。**空 DB では 1 回目 20 適用 → 2 回目 20 skip**（`schema_migrations=20`） |

- 補足: unit は初回、実行シェルの `DATABASE_URL`（他システム向け）を継承して globalSetup の migrate が失敗した。**専用 DB `ai_helpdesk_g_test` と検証用 `SEED_PASSWORD` を明示**して再実行し 420 PASS。初回の失敗ログは証跡から除外（`unit.log` は破棄し `unit2.log` を採用）。
- 補足: `DEEPSEEK_API_KEY` 未設定のため、テスト内の AI 呼び出しは承認済みナレッジのフォールバック経路で実行された（実 API 疎通は G-04 の `POST /api/ai/answer` で別途確認）。

## 4. 新規指摘（重大度順）

| # | 重大度 | 指摘 | 原因ファイル:行 | 影響 |
|---|---|---|---|---|
| G-01-F1 | **High** | 監査ハッシュチェーン破断（`terminal.session.expire` の `detail.expiresAt` が `Date` のため、保存 jsonb と再計算が不一致）。以降の全行が検証不能 | `apps/api/src/routes/terminal.ts:152` / `apps/api/src/domain/audit.ts:23-30` | 改ざん・欠落を機械検知できない。`/api/audit/verify` が常に `ok:false` |
| G-05-F1 | **High**（既知 F-04） | 引継ぎスナップショットと UI 状態に PII が平文保存 | `apps/api/src/lib/case-handover.ts:93-135` / `routes/case-handovers.ts:250-262` | 個人情報が DB・バックアップに残る |
| F-01 | **High**（既知・再現） | 他者宛の引継ぎを閲覧・claim できる（宛先検証なし。開発モードは DX ガードもバイパス） | `apps/api/src/routes/case-handovers.ts:337-372`・`requireHelpdesk()` | なりすまし引き受け・情報閲覧 |
| G-01-F2 | Medium | `case.ai_assess` の actor が NULL（`actorId: null` を明示） | `apps/api/src/routes/cases.ts:158-166` | 「誰の相談を AI が評価したか」が残らない |
| G-01-F3 | Medium（既知 F-02） | 引継ぎ create/claim/approve がサーバ監査に無い（0 行） | `apps/api/src/routes/case-handovers.ts` | 引継ぎの監査証跡がクライアント状態のみ |
| G-02-F1 | Medium | DX 内 4 ロール（担当/承認/監査/IT端末管理）のサーバ分離が無い | `Mirai_AIHelpdesk…html:2544-2550` / `auth/session.ts`（3 ロールのみ） | 職務分離が画面のみ（F-06 と同根） |
| G-02-F2 | Low | 初期表示で権限外 API を呼び 403（`/api/resolve/admin/pending`, `/api/remote-support/session`） | 画面側の初期ロード | コンソール誤検知・無駄なリクエスト |
| G-12-F1 | Low | モーダルを開いてもフォーカスが移動しない（トラップ無し） | HTML:3369 `modal()` / 2184 `App.closeModal` | キーボード/読み上げ操作の混乱 |

## 5. 限界・未実施

- **G-08 RSP 側 200**: RSP（`:8130`）のログイン資格情報が本検証の付与範囲外のため、`/api/v1/helpdesk/*` の **200 経路は未実施（BLOCKED）**。401 境界と HelpDesk 側の 200/401/403 は実測済み。RSP の JWT 秘密鍵を読んで偽造する行為は行っていない。
- **G-02 実在 5 名のロール**: 名簿が DX 5 名を同一権限で返すため、「別人物の承認者」での職務分離は実測不能（F-06 と同じ制約）。サーバ 3 ロールの境界は実測済み。
- **G-11**: スクリーンショットは実名を含むため保存せず、DOM 計測（スクロール幅・描画文字数）で判定。
- **G-06 実メール送信**: SMTP シンクのみ（本番送信なし＝計画 D2 どおり）。
- 既知 FAIL（F-01/F-04）は**修正前の実装**での実測。修正後の再検証は別タスク（Phase 6）。

## 6. 証跡と伏せ字の確認

- 本ファイル: `docs/evidence/verify-20261027/platform/G-results.md`
- raw（すべて機械確認済み。実名・実メール・シークレットを含まない）:
  - `raw/g01-audit.txt`（監査一覧・actor 欠落・チェーン破断・源流 DB 比較）
  - `raw/g02-roles.txt`（3 ロール境界・UI 可視ラベル・403 一覧）
  - `raw/g03-state.txt`（14 キー・欠落復元）
  - `raw/g04-api-coverage.txt`（**73 本の全到達表**）
  - `raw/g05-g07-handover.txt`（PII 平文・再共有・部分一意 index・通知）
  - `raw/g06-mail.txt`（送信成功・attempts 1→5→failed）
  - `raw/g08-rsp.txt`（401/200/403 境界）
  - `raw/g09-knowledge.txt`（承認済みのみ・スコア順）
  - `raw/g10-dashboard.txt`（API と DB の一致）
  - `raw/g11-g12-ui.txt`（1280/1600・Esc・フォーカス）
  - `raw/regression/`（unit2 / typecheck / lint / secret-scan / migrate×4 / build / summary）
- 伏せ字の機械確認: `raw/` 全体に `<user>` / 実名（*** 等）/ `@mirai-const` / パスワード・キー類が含まれないことを grep で確認済み。

## 7. 環境の後始末

- 検証インスタンス `:18959` / `:18964` は検証 DB `ai_helpdesk_g` のみを参照（本番 DB への書き込みなし）。
- 作成した補助 DB: `ai_helpdesk_g_test`（unit 用）、`ai_helpdesk_g_mail`（G-06 再試行用）、`ai_helpdesk_g_mig`（migrate 冪等用）。証跡確定後に削除してよい（本番・既存検証 DB とは独立）。
- `ai_helpdesk_g` の `users.password_hash` は検証用に更新した（3 ロールのログイン用）。他 DB は不変。
