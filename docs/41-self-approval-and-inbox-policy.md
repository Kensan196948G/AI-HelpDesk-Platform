# 自己承認と引継ぎ受信箱の方針（SM-01 / SM-02）

| 項目 | 値 |
|---|---|
| 作成日 | 2026-10-27 |
| 対象 | 引継ぎ（`/api/case-handovers`）の受信箱とナレッジ承認 |
| 実装 | `ALLOW_SELF_APPROVAL`（既定 true）／inbox の自己案件表示 |
| 関連 | [07-security.md](07-security.md), [20-employee-directory.md](20-employee-directory.md), [22-remote-assist-handover.md](22-remote-assist-handover.md), [33-handover-workspace.md](33-handover-workspace.md), [39-full-verification-result-20261027.md](39-full-verification-result-20261027.md) |

---

## 1. 現状の運用（Cloudflare Access の実質1アイデンティティ）

本番は Cloudflare Access の実質1アイデンティティ運用である。同じ1つのログインで
「依頼者（相談する人）」と「DX 推進部の担当者（引き受けて承認する人）」の両方を
ペルソナ切替で行うことがある。

この運用では、次の連鎖が起きていた。

1. 依頼者として引継ぎを作成する（`owner_email` = ログイン中のメール）。
2. 受信箱（`GET /api/case-handovers/inbox`）は「自分が依頼した案件」を除外していたため、
   自分の引継ぎが受信箱に出ない。
3. UI から claim できないので、API で claim する。
4. 引き受けたのも承認するのも同じ人になり、`self_approved=true` で承認される。

つまり「職務分離ができない」のではなく、**同一人物が依頼者・担当者・承認者を兼ねる**
ことが、UI の受信箱仕様によって誘発されていた。これを次の2点で緩和する。

- **SM-01**: ヘルプデスク権限がある人には、自分が依頼した案件も受信箱に返す。
- **SM-02**: 自己承認を許可するかどうかを設定（`ALLOW_SELF_APPROVAL`）で切り替える。

---

## 2. 受信箱の緩和（SM-01）

`GET /api/case-handovers/inbox` は、ヘルプデスク相当（`requireHelpdeskActor` を通る人）
だけが利用できる。そのうえで、以前の `owner_email <> 自分` の除外を廃止し、
**自分の案件も受信箱に返す**。

維持している条件:

- `status IN ('pending', 'claimed')` のみ。
- 宛先が指名されている引継ぎ（`recipient_no` が非 NULL）は、**指名された本人の受信箱にだけ**
  表示する（他の DX メンバーには出さない）。
- 一般社員は従来どおり 403（受信箱そのものを開けない）。

これにより、単一 ID 運用でも「作成 → 受信箱 → claim → 承認（自己承認）」の順で
UI から完結できる。自己承認を許すかどうかは次のフラグで決める。

---

## 3. 自己承認フラグ（SM-02）

### 3.1 設定

`.env`（本番は systemd の `Environment=` など）に次を設定する。

```dotenv
# true（既定）: 自分が引き受けた案件も承認できる（self_approved=true を記録）
# false: 職務分離を強制し、自分が引き受けた案件の承認は 403 SELF_APPROVAL_FORBIDDEN
ALLOW_SELF_APPROVAL=true
```

- 型は **厳密な真偽値**（`true` / `false` の文字列のみ）。`z.coerce.boolean()` は
  `'false'` を `true` と解釈するため使っていない。`1` / `0` / `yes` などは起動時に
  設定エラーになる（fail-fast）。
- 既定は `true`。単一 Access ID 運用の間は `true` のままにする。
- 変更は**サービス再起動後に反映**される（起動時に env を読む）。

### 3.2 挙動

| `ALLOW_SELF_APPROVAL` | 実行者 = `claimed_by` の approve | それ以外の approve |
|---|---|---|
| `true`（既定） | 200。`status='completed'`、`approved_by=実行者`、`self_approved=true` | 200。`self_approved=false` |
| `false` | **403 `SELF_APPROVAL_FORBIDDEN`**。状態は変更しない | 200。`self_approved=false` |

- 403 のときは `case_handovers` の更新も監査（`case_handover.approve`）も行わない。
- 「他者が引き受けた案件を別の人（DX メンバー）が承認する」ことは `false` でも可能。
- 承認前の状態チェック（`pending` は 409 `NOT_CLAIMED`、`cancelled` は 409
  `ALREADY_HANDLED`）は従来どおり先に評価される。

---

## 4. 別 Access ID 運用へ移行して `false` にする手順

単一 ID 運用のまま `false` にすると、自分の引継ぎを自分で承認できず業務が止まる。
次の前提を満たしてから切り替える。

### 4.1 前提

1. 依頼者と DX 担当者が**別の Access ID**（別メール）でログインできる。
2. 両方のメールが `docs/MailAddress.txt`（`ACCESS_ALLOWLIST_FILE`）で許可されている。
3. 両方のメールが Mirai-Info の社員名簿に存在する（`/api/me` で解決できる）。
   DX 担当者は `section` または `division` が `DX推進部` であること。
4. 本番の「操作する人」切替が `switchMode=self`（本人以外に切り替え不可）であること。
   ペルソナ切替で他人になりすませる状態では職務分離にならない。

### 4.2 切替手順（推奨: 段階移行）

1. **準備**: 別 ID でログインできることを確認する。依頼者 ID で引継ぎを作成し、
   DX 担当 ID の受信箱に出ること、claim できることを確認する。
2. **監査のベースライン**: `/api/audit/verify` が `ok:true` であることを確認する。
   `case_handovers` の `self_approved=true` 件数を記録する（下記 §5）。
3. **設定変更**: `ALLOW_SELF_APPROVAL=false` を設定する。
4. **再起動**: サービスを再起動する（Lead / 運用担当の承認を得る）。
5. **スモーク**:
   - 自分の引継ぎを自分で承認 → **403 `SELF_APPROVAL_FORBIDDEN`**
   - 別の DX 担当が引き受けた案件を承認 → 200、`self_approved=false`
   - 一般社員が受信箱・claim・approve → 403
6. **監視**: 週次で `self_approved=true` の新規行が 0 であることを確認する。

### 4.3 ロールバック

- 業務が止まる場合は `ALLOW_SELF_APPROVAL=true` に戻して再起動する。
  監査行は残るため、自己承認が発生した事実は `self_approved` で追跡できる。
- フラグを戻しても過去の `self_approved` は書き換えない（履歴を改変しない）。

---

## 5. 監査の見方

### 5.1 サーバ監査（`audit_log`）

引継ぎの操作は `audit_log` に 1 操作 1 行で記録される（ハッシュチェーン）。

| action | 内容 | target |
|---|---|---|
| `case_handover.create` | 引継ぎ作成 | `case_handover` / handover id |
| `case_handover.claim` | 引き受け | 同上 |
| `case_handover.resolve` | 解決記録（PATCH resolved） | 同上 |
| `case_handover.status` | その他の状態変更 | 同上 |
| `case_handover.approve` | ナレッジ承認 | 同上 |

- `detail.actorEmail` に実行者メール、`detail.caseId`、`created_at` に時刻が入る。
- `detail.selfApproved` で、その承認が自己承認だったかが分かる（`approve` の行）。
- 監査一覧は `GET /api/audit`（approver ロール）。action 名でそのまま判別できる。
- 鎖の検証は `POST /api/audit/verify`。`ok:true` なら改ざん・欠損なし
  （既知の移行点は `knownBreaks` に表示される）。

### 5.2 引継ぎ行（`case_handovers`）

| 列 | 意味 |
|---|---|
| `claimed_by` | 引き受けた人のメール |
| `approved_by` / `approved_at` | 承認した人・時刻 |
| `self_approved` | **`claimed_by` = `approved_by` だったか**（true = 自己承認） |

自己承認の件数を確認する SQL 例:

```sql
-- 直近30日の自己承認（0 件であることが職務分離の条件）
SELECT count(*) AS self_approved_count
FROM case_handovers
WHERE self_approved = true
  AND approved_at >= now() - interval '30 days';

-- 自己承認の内訳（誰が・いつ・どの案件か）
SELECT id, case_id, claimed_by, approved_by, approved_at
FROM case_handovers
WHERE self_approved = true
ORDER BY approved_at DESC
LIMIT 50;
```

`self_approved=true` は「不正」ではなく「同一人物が担当と承認を兼ねた」事実である。
単一 ID 運用では発生し得るため、件数を把握し、別 ID 運用へ移行した後に
増えないことを確認する。

---

## 6. 制約・残リスク

- **単一 Access ID 運用では職務分離を強制できない**。`ALLOW_SELF_APPROVAL=true` は
  「自己承認を許す」設定であり、監査に `self_approved=true` が残ることを受容する運用。
- `false` にしても、同じ人が複数のメール（別名）を持ち、`EMAIL_ALIASES` で同一人物に
  正規化される場合は、見かけ上別 ID でも同一人物になり得る。別名の運用を確認する。
- 本人以外へのペルソナ切替が許可されている環境では、`claimed_by` と実行者が一致しても
  職務分離にならない。本番は `switchMode=self` を前提とする。
- 受信箱の緩和は「ヘルプデスク権限がある人」に限る。一般社員は引き続き 403。
- 宛先指名の絞り込みは維持している。指名された本人以外は受信箱に出ない。

---

## 7. 検証（自動テスト）

`apps/api/src/routes/case-handovers.integration.test.ts` に以下を追加した。

- 本番相当（`AUTH_MODE=cloudflare-access`）で、依頼者＝自分の案件が受信箱に出る。
- 指名外（`recipient_no` が他者）の案件は受信箱に出ない。
- `ALLOW_SELF_APPROVAL=false`: 自己承認は 403 `SELF_APPROVAL_FORBIDDEN`、状態・監査は
  変更されない。他者が引き受けた案件は 200。
- `ALLOW_SELF_APPROVAL=true`: 自己承認は 200、`self_approved=true` が保存される。

実行:

```bash
npx vitest run apps/api/src/routes/case-handovers.integration.test.ts apps/api/src/auth/
npm run typecheck
npm run lint
```
