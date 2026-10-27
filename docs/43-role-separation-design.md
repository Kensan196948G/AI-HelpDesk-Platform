# 4ロール職務分離の設計（提案・未実装）

- 状態: **proposed（設計のみ。実装・設定変更は未実施）**
- 作成: 2026-10-27
- 関連: `docs/41-self-approval-and-inbox-policy.md`（自己承認と受信箱の運用）、`docs/42-knowledge-persistence-f06.md`（F-06 のサーバ永続化）、`docs/39` の F-06 / §7-5
- 対象: AI HelpDesk（`apps/api`）、運用は Cloudflare Access 経由

## 1. なぜ必要か

F-06 でナレッジの下書き・承認は**サーバに永続化**され、別 ID での承認も UI から成立することを実測した
（2026-10-27 / `docs/42` §6）。しかし現状は「**同じ人が作って同じ人が承認できる**」設定
（`ALLOW_SELF_APPROVAL=true`）を維持しており、次の 4 つの職務はサーバで分離されていない。

| 職務 | 現状の実装 | 不足 |
|---|---|---|
| 担当（対応する） | `users.role = helpdesk` / UI は `authenticateUi` + `requireHelpdeskActor`（DX 推進部） | 担当と承認の境界が設定値のみ |
| 承認（ナレッジを公開する） | `knowledge.author_id` と `approver_id` を記録。`ALLOW_SELF_APPROVAL=false` なら 403 | 既定が `true`。UI 経路は名簿の氏名一致で事前ブロックするだけ |
| 監査（記録を検証する） | `audit_log`（ハッシュチェーン）を全員が `GET /api/audit` で閲覧 | 閲覧専用のロールが無い（書込み権限と同居） |
| IT 端末管理（端末・コマンドを扱う） | `routes/device.ts` / `routes/terminal.ts` / RSP 連携 | 端末系の権限が helpdesk に包含されている |

本稿はこの 4 職務を**サーバ側で分離する設計**と、単一 ID 運用から移行する手順を提案する。
**実装は行わない**（別 PR・別判断）。

## 2. 現状の実測（2026-10-27）

| 項目 | 実測値・実装 |
|---|---|
| ロール定義 | `apps/api/src/auth/types.ts`: `'requester' | 'helpdesk' | 'approver'` の **3 種のみ** |
| UI 経路の主体解決 | `authenticateUi`（Cloudflare Access JWT）→ `canonicalEmail` → `requireHelpdeskActor`（Mirai-Info 名簿で DX 推進部を確認。解決できなければ fail-closed） |
| API 経路の主体解決 | `authenticate`（Bearer セッション）→ `requireRole(...)` |
| ナレッジ承認（API） | `POST /api/knowledge/:id/review` = `requireRole('approver')`。作成者本人は常に 400 |
| ナレッジ承認（UI） | `POST /api/knowledge/ui-sync` = `authenticateUi` + `requireHelpdeskActor`。`ALLOW_SELF_APPROVAL` に従い `selfApproved` を応答・監査に記録 |
| 自己承認の設定 | `ALLOW_SELF_APPROVAL=true`（既定）。`false` で 403 `SELF_APPROVAL_FORBIDDEN`（統合テストで固定） |
| 別 ID 承認の実績 | 2026-10-27 14:44 `KB-2026-0103`: author=`kensan1969@gmail.com` / approver=`k-aritoh@mirai-const.co.jp` / `self_approved=false` |
| 監査 | `audit_log` は追記のみ（ハッシュチェーン）。閲覧は `GET /api/audit`（認証のみ） |

## 3. 設計方針（提案）

### 3-1. ロールの正本を「Access のグループ」に置く

- Cloudflare Access のポリシーで利用者を **4 グループ**に割り当てる（`hd-support` / `hd-approver` / `hd-auditor` / `hd-itops`）。
- サーバは起動時にグループ→`users.role` を同期する（名簿の所属と併用し、**両方一致**を条件にする）。
- 名簿（Mirai-Info）で解決できない ID は従来どおり fail-closed（`requireHelpdeskActor` の挙動を維持）。

理由: アプリ内でロールを編集できるようにすると「自分で承認者になれる」経路が生まれる。
Access 側（人間が管理）を正本にすれば、アプリは検証するだけになる。

### 3-2. ロールを 4 種へ拡張し、経路ごとに要求する

| ロール | できること（案） |
|---|---|
| `requester`（依頼者） | 自分の案件の作成・閲覧・AI 相談。承認済みナレッジの閲覧 |
| `helpdesk`（担当） | 引継ぎの受信箱・claim・解決記録・端末セッション（**RSP 実行**）・ナレッジ下書き作成 |
| `approver`（承認） | 承認待ちナレッジの承認/差戻し。**作成者本人は不可**（サーバ強制） |
| `auditor`（監査） | `GET /api/audit`・監査エクスポート・最終報告書の検証。**書込み系は 403** |
| `itops`（IT 端末管理） | 端末インベントリ・コマンドキュー・展開。**ナレッジ承認は不可** |

経路別の要求ロール（抜粋）:

| 経路 | 現状 | 変更案 |
|---|---|---|
| `POST /api/knowledge/ui-sync`（承認） | UI 認証 + DX 判定 | `approver` かつ `author_id != actor` |
| `POST /api/knowledge/:id/review` | `requireRole('approver')` | 変更なし（作成者不可も維持） |
| `POST /api/knowledge/ui-sync`（下書き/申請） | UI 認証 + DX 判定 | `helpdesk` |
| `GET /api/audit` | `authenticate` のみ | `auditor`（または `approver`）に限定 |
| `POST /api/devices/*`・`/api/terminal/sessions/*` | `helpdesk` | `itops`（閲覧は `helpdesk` も可） |

### 3-3. 職務分離をサーバで強制する

- 承認は `author_id != approver_id` を**常に**要求する（`ALLOW_SELF_APPROVAL` は移行期の逃げ道としてのみ残し、Phase C で `false` 固定）。
- 引継ぎの承認（`case_handovers.self_approved`）も同じ扱いに揃える。
- UI の「申請者本人は承認できません」は**事前案内**に降格し、最終判断はサーバに置く（現状はクライアント検証が先に走る二重実装）。

### 3-4. 監査の分離

- `auditor` は書込み API を一切呼べない（`requireRole('auditor')` のルートを GET に限定）。
- 監査のハッシュチェーン検証（`scripts/audit-find-breaks.ts`）を `auditor` 向けの画面/レポートに載せる。

## 4. 移行計画

| Phase | 内容 | 受入条件 | 前提 |
|---|---|---|---|
| **A**（影響なし） | 名簿の DX 所属と Access グループの突合レポートを作る（読み取りのみ） | 4 グループに該当する実 ID が一覧化され、未割当が明示される | なし |
| **B** | `users.role` を 4 種へ拡張し、経路別ガードを実装。既存の UI 経路は `helpdesk` のまま動く | 統合テストで経路×ロールの許可/拒否を固定。本番は Access グループ未設定でも現行動作を維持 | Cloudflare Access のグループ作成（**人間ゲート**） |
| **C** | `ALLOW_SELF_APPROVAL=false` を本番既定へ | 別 ID での承認が本番で 1 件成立（`self_approved=false`）。同一 ID は 403 | Phase B 完了 + 承認者が 2 名以上いること |

Phase C の前提が満たせない間は、`ALLOW_SELF_APPROVAL=true` を維持しつつ
「自己承認は監査に `selfApproved=true` として残る」現状の可視性で運用する（現行と同じ）。

## 5. 影響とリスク

| リスク | 内容 | 緩和 |
|---|---|---|
| 業務停止 | 単一 ID 運用のまま `false` にすると**承認が誰もできなくなる** | Phase C の受入条件（承認者 2 名）を満たすまで既定を変えない |
| Access 設定変更 | グループ作成・ポリシー変更は人間の操作が必要 | アプリ側は「グループ未設定なら現行動作」にフォールバック |
| 名簿依存 | 名簿で解決できない ID は fail-closed | 現行 `requireHelpdeskActor` の挙動を維持し、4 ロールでも同じ原則 |
| 二重実装 | UI のクライアント検証とサーバ検証が併存 | サーバを正とし、UI は案内のみ（§3-3） |

## 6. スコープ外（この提案で決めないこと）

- 承認者の**人数・当番**の運用設計（`docs/41` の範囲）
- RSP 側のロール（`require_remote_support` / `require_ops_admin`）との突合
- 監査ログの保持期間・外部保管
- Cloudflare Access の具体的なグループ名・ポリシー式（人間が決定）

## 7. 未決事項

1. `auditor` を `GET /api/audit` の**唯一**の閲覧者にするか、`approver` にも残すか
2. `itops` を端末の**破壊的**操作（コマンド実行・展開）に限定するか、閲覧も含めるか
3. ~~Phase B で `users.role` を単一値から**複数ロール**へ変えるか~~ → **決定済み（2026-10-27・[docs/49](49-role-model-decision.md)）**: 複数ロールを採用（`user_roles` が正本・`users.role` は主ロール）
4. ~~Access グループと名簿の**どちらを優先**するか~~ → **決定済み（[docs/49](49-role-model-decision.md)）**: Access の明示マッピングを優先し、未設定時は名簿/主ロールへフォールバック
5. 自己承認禁止を、ナレッジだけでなく引継ぎ承認にも同時適用するか
