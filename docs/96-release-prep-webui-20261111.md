# 96. WebUI 変更（PR-1〜3）の配備準備とリリース判定（案）（2026-11-11）

## 0. この文書の位置づけ

PR-1〜PR-3（[docs/93](93-right-panel-tabs.md) / [docs/94](94-knowledge-trial-and-review.md) / [docs/95](95-right-panel-footer-and-reflect.md)）で main に入った WebUI 変更を、Staging・本番へ配備するための**準備**をまとめた。

- **実配備はしていない。** `current` の切り替え・サービスの再起動・DB の変更は行っていない。
- 実施したのは、現状の実測、**両環境の release ビルド（dry-run）**、手順・検証・ロールバック・判定案の整理まで。
- リリース判定は**案（条件付き GO 候補）**であり、最終判断は人間が行う。

## 1. 対象

| 項目 | 内容 |
|---|---|
| 対象 commit | `77bdf712a719d37cf61483416670f1f1887b678e`（main） |
| 対象 PR | #163（右ペイン 5 タブ）・#164（候補一覧・AI検査・承認進捗）・#165（固定フッター・監査全件・今回反映）・#166（レポート v5） |
| 変更の性質 | ブリッジ 3 本の追加、読み取り専用 API 1 本、文書・証跡。**DB マイグレーションなし**、環境変数の追加なし |
| 原本 HTML | 変更しない（配信時の差し替えとブリッジのみ） |
| 配信物への影響 | `apps/api/src/prototype/*.js` 3 本、`apps/api/src/routes/knowledge.ts`、`apps/api/src/routes/prototype.ts`、`apps/api/src/domain/knowledge-inspect.ts` |

## 2. 現状（実測）

測定: 2026-11-11 14:11 JST（read-only）

| 項目 | 値 |
|---|---|
| main / origin/main | `77bdf71` / `77bdf71`（一致） |
| 本番 health | `env=production` / `commit=9a4eacc`（2026-11-06） / `db=ok` / `ok=true` |
| Staging health | `commit=0dbb1b7`（2026-11-06） / `db=ok` / `ok=true` |
| 本番 current | `/home/kensan/ai-helpdesk-prod/releases/20261106T121453-9a4eaccca62e` |
| Staging current | `/home/kensan/ai-helpdesk-stg/releases/20261106T123305-0dbb1b7bb704` |
| 直近の DB backup | `ai_helpdesk_preview-20261111-023320.dump`（266,820 B） |
| ディスク | 936G 中 117G 空き（88% 使用） |

**本番・Staging とも、PR-1〜3 は未反映**である。

## 3. 準備で実施したこと（dry-run）

`scripts/deploy-release.sh --dry-run` を両環境に対して実行した。**release を組み立てて manifest を検証するだけで、`current` の切り替えも再起動もしない。**

| 環境 | 実行結果 | release ディレクトリ | 記録 |
|---|---|---|---|
| Staging | 成功（build・manifest 検証） | `/home/kensan/ai-helpdesk-stg/releases/20261111T141233-77bdf712a719` | `state/deploy-20261111T141233-77bdf712a719.json`（`result: "dry-run"`） |
| 本番 | 成功（build・manifest 検証） | `/home/kensan/ai-helpdesk-prod/releases/20261111T141301-77bdf712a719` | `state/deploy-20261111T141301-77bdf712a719.json`（`result: "dry-run"`） |

- dist-manifest の SHA-256 は両環境で一致: **`3d10454b069d98d09b9f475467b36d5f06a06431a7c743d732ad2c1362a7b9e0`**
- 各 release のサイズ: 69 MB
- 本番 dry-run の `previous` は現行の `20261106T121453-9a4eaccca62e`（= 切り替え時に戻す先）
- dry-run は release を残す（read-only）。実配備時に同じ commit の release が既にあれば再利用される。

## 4. 配備手順（実配備は人間の承認後）

順序: **Staging → 受入 → 本番**。各段の間に人間の確認を置く。

### 4-1. Staging

```bash
MAIN=/home/kensan/Projects/Mirai-Admin-Platform/AI-HelpDesk-Platform
REF=$(git -C "$MAIN" rev-parse origin/main)

# 事前確認（read-only）
curl -sS --noproxy '*' http://127.0.0.1:18952/api/health
readlink -f /home/kensan/ai-helpdesk-stg/current

# 配備（切り替え＋再起動。restart 失敗時は自動で previous へ戻る）
bash "$MAIN/scripts/deploy-release.sh" \
  --repo "$MAIN" --ref "$REF" \
  --root /home/kensan/ai-helpdesk-stg \
  --env-file /home/kensan/ai-helpdesk-stg/current/release.env \
  --unit ai-helpdesk-stg-api --health-port 18952
```

### 4-2. 本番

```bash
# 事前確認（read-only）: 直近 backup・health・current・previous の確認
ls -lt /home/kensan/backups/ai-helpdesk | head -3
curl -sS --noproxy '*' http://127.0.0.1:18950/api/health
readlink -f /home/kensan/ai-helpdesk-prod/current

# 配備（unit テンプレートを配置して切り替え。restart 失敗時は自動 rollback）
bash "$MAIN/scripts/deploy-release.sh" \
  --repo "$MAIN" --ref "$REF" \
  --root /home/kensan/ai-helpdesk-prod \
  --env-file /home/kensan/.config/ai-helpdesk/api.conf \
  --unit ai-helpdesk-prod-api --health-port 18950 \
  --unit-template "$MAIN/ops/systemd/ai-helpdesk-prod-api.service"
```

- `--migrate` / `--seed` は**渡さない**（今回の変更に DB 変更はない。渡すと DB へ接続する）。
- 秘密値は argv・ログ・証跡に出さない（runbook §0-1 の約束どおり）。

## 5. 検証（各環境）

| # | 確認 | 期待 |
|---|---|---|
| V-1 | `/api/health` | `commit` が配備した commit と一致、`db=ok`、`ok=true` |
| V-2 | unit | `ActiveState=active`、`NRestarts=0`、`MainPID` が更新 |
| V-3 | 配信ページ | 200、title 一致、**ページの JS エラー 0** |
| V-4 | PR-1 の画面 | 引継ぎワークスペース右ペインに 5 タブ（案件/実行/端末/ナレッジ/記録） |
| V-5 | PR-2 の画面 | ② に候補一覧、⑤ に「AI検査・指摘」、⑥ に「n/4」とボタン制御 |
| V-6 | PR-3 の画面 | 右ペインの固定フッター、記録の「すべて表示」、承認後の「今回反映」 |
| V-7 | 公開経路 | 302 → Access OTP（本番・Staging とも） |

- V-3〜V-6 は **Access の OTP ログインが必要**（人間）。ローカル環境での同等の確認は[レポート v5](evidence/qa-20261111-v5/report-v5.md) に記録済み（A05 / A08a）。
- 新しい検査 API は読み取り専用。`POST /api/knowledge/inspect` は認証（UI）とヘルプデスク相当の権限を要求する（未認証は 401/403）。

## 6. ロールバック

- **自動**: `deploy-release.sh` は restart 失敗時に previous へ戻す（`restart-failed` / `rollback-failed` の判定は runbook §4-10）。
- **手動**: `current` symlink を previous に戻して再起動する（runbook §4-10 の手順）。DB は変更していないため DB の rollback は不要。
- 対象 release は read-only で残る（`--keep 3` の範囲）。本番 dry-run の `previous` は `20261106T121453-9a4eaccca62e`。
- rollback 後は `/api/health` の `commit` が previous と一致することを確認する。

## 7. リスクと条件

| # | リスク | 対応 |
|---|---|---|
| R-1 | 受入がローカル環境のみ（本番/Staging の Access OTP 未実施） | 配備後に V-3〜V-6 を人間の OTP で実施する。実施までは「配備済み・受入未完了」とする |
| R-2 | 受入の他項目（#5 の通し、#6/#7/#9 等）が未実施 | 配備と並行〜配備後に再実行する（レポート v5 に追記） |
| R-3 | ブリッジの JS エラーで既存画面が止まる | ローカル受入で `pageerror` 0 を確認済み。配備後の V-3 で再確認し、異常時は §6 で戻す |
| R-4 | 「今回反映」は 30 分・タブ内のみ、監査は最大 50 件、固定フッターはデスクトップ幅のみ | 仕様として許容（docs/95 §3-2）。変更しない |
| R-5 | ディスク 88% | release は 69 MB。`--keep 3` で古い release は自動削除。backup は日次で 266 KB |

## 8. リリース判定（案）

**条件付き GO 候補（未承認）**。次の条件を満たした時点で GO と判断できる、という案である。

1. Staging 配備後、V-1〜V-4 が PASS（V-3〜V-6 は OTP ログインで人間が確認）
2. 本番配備後、V-1〜V-7 が PASS
3. 異常時は §6 の rollback が実行できる（`previous` の存在を配備前に確認済み）
4. 本番 DB は変更しない（今回の対象に migration はない）

**この文書は GO ではない。** 実配備・再起動・Access ログインは人間の承認と操作が必要である。

## 9. 人間に必要な判断・作業

| # | 作業 | 理由 |
|---|---|---|
| H-1 | 配備の実施可否（GO/保留） | 本番影響のある操作のため |
| H-2 | 配備の時間帯（保守ウィンドウ） | 再起動を伴うため |
| H-3 | Staging / 本番の Access OTP ログインと V-3〜V-6 の確認 | AI は OTP を通過できない |
| H-4 | 受入の残項目（#5 通し・#6/#7/#9）を先にやるか、配備を先にするか | 順序の判断 |

## 10. 参照

- 正本の手順: [docs/82](82-promotion-runbook-20261106.md)（§4-9 / §4-10）、[docs/85](85-production-cutover-20261106.md)（§5 rollback）
- 変更: [docs/93](93-right-panel-tabs.md) / [docs/94](94-knowledge-trial-and-review.md) / [docs/95](95-right-panel-footer-and-reflect.md)
- 受入: [レポート v5](evidence/qa-20261111-v5/report-v5.md)
- 実装: `scripts/deploy-release.sh`、`ops/systemd/ai-helpdesk-prod-api.service`
