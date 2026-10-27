# ロールモデルの決定と実装（複数ロール・Access 優先）— 2026-10-27

- 正本: [docs/43](43-role-separation-design.md)（4 ロール職務分離の設計）
- 本稿: docs/43 §7 の未決事項 **3（単一/複数ロール）** と **4（Access グループと名簿の優先）** の決定と実装
- 決定日: 2026-10-27（オーナーの判断により設計・実装を委任）

## 1. 決定

| # | 決定 | 理由 |
|---|---|---|
| **D1** | **複数ロール**を採用する。`user_roles` を正本とし、`users.role` は主ロール（後方互換）として残す | DX 推進部のメンバーは担当・承認・監査・IT 端末管理を兼務しうる。単一値では表現できない。`users.role` を残すことで、移行前のユーザーと既存 API を壊さない |
| **D2** | 優先順位は **Access グループ（明示マッピング）> 名簿/主ロール**。マッピングが無いユーザーは従来どおり `users.role` で判定する | Access は人間が管理する認可の正本（docs/43 §3-1）。名簿は本人確認・所属の正本。**未設定時に現行動作を維持**することで、グループ作成前でも業務を止めない |
| **D3** | 同期は **明示マッピングの適用**で行う（`scripts/sync-roles.ts`）。既定は dry-run、`--apply` で反映し、`auth.role.sync` を監査に残す | Access API の資格情報が無い環境でも、グループのエクスポートから安全に適用できる。dry-run と監査で誤付与を追跡できる |
| **D4** | **`auditor` は他ロールと併存させない**（同期時に検証して拒否） | 監査の読み取り専用境界（docs/43 §3-4）を、兼務で崩さないため |

## 2. 実装（2026-10-27）

| 変更 | 内容 |
|---|---|
| **migration 025** | `user_roles (user_id, role, source, granted_at, granted_by)` を追加し、既存 `users.role` を `source='seed'` で移行（重複無視・既存行は不変） |
| `apps/api/src/auth/role-values.ts` | ロール値・検証（DB 非依存。CLI からも使う） |
| `apps/api/src/auth/roles.ts` | `loadUserRoles`（`user_roles` 優先・空なら主ロール）/ `rolesInclude` |
| `apps/api/src/auth/session.ts` | セッション認証時にロール集合を読み込み、`requireRole` と監査の読み取り専用判定を**集合**で行う |
| `scripts/sync-roles.ts` | JSON マッピングの dry-run / apply。不明メールは既定でエラー（`--allow-unknown` で警告）、監査 `auth.role.sync` を追記 |

### 2-1. 同期の使い方

```bash
# 1) マッピングを用意（Access グループのエクスポート等から）
cat > roles.json <<'JSON'
{ "users": { "k-aritoh@mirai-const.co.jp": ["helpdesk", "approver"] } }
JSON

# 2) 確認（DB は変更しない）
npx tsx scripts/sync-roles.ts --file roles.json

# 3) 反映（監査 auth.role.sync が残る）
npx tsx scripts/sync-roles.ts --file roles.json --apply --by <実行者メール>
```

### 2-2. テスト（2026-10-27）

- `apps/api/src/auth/role-separation.integration.test.ts` → **7 passed**
  - `validateRoleSet`: auditor の併存・空・不明ロールを拒否
  - 主ロール `requester` + `user_roles=[helpdesk, approver]` のユーザーが `/api/desk/queue`（helpdesk）と `/api/audit`（approver）を **200** で呼べる
  - `user_roles` が空のユーザーは主ロールへ**フォールバック**（requester は `/api/desk/queue` で 403）
- CLI 実測（隔離 DB `ai_helpdesk_e2e`・テスト用ユーザー `cli-test@example.com`）
  - dry-run: `[helpdesk] -> [approver, helpdesk]` を表示し DB は不変
  - apply: `user_roles` 2 行（`source=sync` / `granted_by`）と監査 `auth.role.sync` 1 行を確認
  - 不正入力: `auditor` 併存は拒否、未登録メールは「付与しません」で停止

## 3. 制約・残り

1. **UI（Cloudflare Access）経路はこのロール集合をまだ参照していない**。UI の認可は名簿（DX 推進部）ベースのまま（`authenticateUi` + `requireHelpdeskActor`）。UI 側の職務分離は、Access グループの作成後に「グループ → `user_roles` 同期」と「UI 経路のロール参照」をセットで実装する（Phase B 残り）。
2. Access グループは未作成のため、同期の入力（マッピング）はまだ運用に乗っていない。
3. Phase C（`ALLOW_SELF_APPROVAL=false`）は承認者 2 名以上の確認後（[docs/48](48-phase-c-cutover.md)）。
4. `users.role` は主ロールとして残る。`user_roles` を持つユーザーでは `users.role` は表示・互換用で、認可は集合で行う。

## 4. ロールバック

- コードを revert → build → restart（`user_roles` を参照しない旧コードは `users.role` で従来どおり動く）
- migration 025 は追加のみ。戻す場合のみ `DROP TABLE user_roles;`（ロール集合の情報は失われる）
