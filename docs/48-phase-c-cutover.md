# Phase C 切替手順（自己承認の禁止）と準備状況 — 2026-10-27

- 正本: [docs/43](43-role-separation-design.md) Phase C
- 本稿: Phase C（`ALLOW_SELF_APPROVAL=false` の本番既定化）の**準備状況**と切替手順
- 状態: **未実施**（前提条件を満たしていないため。下記 §1）

## 1. 準備状況（2026-10-27 19:09 実測・本番 `ai_helpdesk_preview`）

| 前提 | 実測 | 判定 |
|---|---|---|
| 承認ロールの人数（2 名以上） | `users.role='approver'` は **1 名** | ❌ 未達 |
| 別 ID での承認実績 | あり（`case_handovers.self_approved=false` の completed が存在） | ✅ |
| 自己承認の残存 | `case_handovers` 3 件中 **1 件が self_approved=true**（過去分） | 参考 |
| `knowledge_reviews` | 0 件（サーバ永続化のナレッジ承認はまだ運用されていない） | 参考 |

- 現在 `ALLOW_SELF_APPROVAL=true`（本番）。**承認者が 1 名のまま `false` にすると、その 1 名が自分の下書きを承認できず、他の承認者がいないため承認が止まる**。切替はしない。
- 前提を満たすには、**2 名目以降の承認者を `users.role='approver'` で用意する**（Access グループ `hd-approver` の作成と同期、または運用で追加）。これは人間の判断・作業。

## 2. 切替手順（前提が整った後）

1. 事前確認（本番 DB・読み取りのみ）:
   ```sql
   SELECT count(*) FROM users WHERE role='approver' AND is_active;            -- 2 以上
   SELECT count(*) FROM case_handovers WHERE self_approved;                    -- 過去分（既知）
   ```
2. バックアップ: `cp ~/.config/ai-helpdesk/api.conf /tmp/api.conf.before-phase-c && chmod 600 ...`
3. 設定変更: `~/.config/ai-helpdesk/api.conf` の `ALLOW_SELF_APPROVAL=false`（1 行）
4. 反映: `systemctl --user restart ai-helpdesk-api` → `/api/health` 200 を確認
5. 検証（本番・別 ID で 1 件）:
   - 自分の下書きを承認 → **403 `SELF_APPROVAL_FORBIDDEN`**
   - 別の承認者が承認 → **200**・`self_approved=false`・監査 `knowledge.approve` に `selfApproved=false`
   - 引継ぎ承認も同様（`case_handovers` の `selfApproved` が false）
6. 24h 監視（5xx・403 の増加・承認キュー滞留）

## 3. ロールバック

1. `cp /tmp/api.conf.before-phase-c ~/.config/ai-helpdesk/api.conf && chmod 600 ...`
2. `systemctl --user restart ai-helpdesk-api`
3. `/api/health` 200 と、承認が再び可能なことを確認（自分の下書きで 200）

## 4. Phase B の残り（Access グループ前提）

| 残り | 必要なもの |
|---|---|
| Access グループ → `users.role` の同期 | Cloudflare Access で `hd-support` / `hd-approver` / `hd-auditor` / `hd-itops` を作成（人間） |
| グループと名簿の不一致時の優先順位 | 方針決定（docs/43 §7-4）。決まるまで同期は実装しない（誤った権限付与を避ける） |
| 単一ロールか複数ロールか | 方針決定（docs/43 §7-3）。現行 `users.role` は単一値 |
| `itops` の端末系権限 | 認可モデルの変更（`authenticateUi` ベースの端末系を `itops` 対応にする）。既存 `helpdesk` のアクセスを壊さない移行が必要 |

## 5. 現在の実装状態（まとめ）

- 済: ロール 5 種・`auditor` 読み取り専用・監査閲覧（approver/auditor）・migration 024（PR #95）
- 済: 名簿実測（Phase A）と未割当の可視化（docs/47）
- 未: Access グループ同期・itops・Phase C の切替（いずれも人間の判断/作業が前提）
