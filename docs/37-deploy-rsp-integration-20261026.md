# RSP AI支援パネル デプロイ記録（2026-10-26）

| 項目 | 値 |
|---|---|
| 対象 | RSP WebUI「AI支援」＋ HelpDesk 連携API |
| ブランチ | HelpDesk `feat/handover-workspace`（`67476f8`）/ RSP `feat/helpdesk-ai-panel`（`9634e99`） |
| 実施 | 2026-10-26 17:24〜17:25 JST |
| 状態 | **コードは反映済み。連携キーの設定だけ未実施（下記 §3）** |

## 1. 実施内容

| # | 作業 | 結果 |
|---|---|---|
| 1 | DBバックアップ | `~/backups/ai-helpdesk/ai_helpdesk_preview-20261026-172400.dump`（114,636 bytes） |
| 2 | HelpDesk ビルド | `npm run build`（`67476f8`）成功 |
| 3 | HelpDesk migration | `019_terminal_sessions.sql` を production DB（`ai_helpdesk_preview`）へ適用 |
| 4 | HelpDesk 再起動 | `ai-helpdesk-api` active / `/api/health` 200 / db ok |
| 5 | RSP 再起動 | `rsp-api` active / `/health` 200 / database ok |
| 6 | RSP UI 確認 | 配信HTMLに「AI支援」6箇所（ナビ＋ビュー） |
| 7 | RSP API 確認 | `/api/v1/helpdesk/context` 未認証 = 401 `AUTH_REQUIRED`（ルート登録済み） |
| 8 | HelpDesk 統合ルート確認 | 統合ヘッダー付き = 401 `RSP 連携が設定されていません。`（新コード稼働・fail-closed） |

- RSP の MeshCentral / Tunnel は再起動していない（active のまま）。
- RSP の DB スキーマ変更なし。HelpDesk の変更は追加テーブルのみ。
- HelpDesk の `/api/health` の `commit` は `api.conf` の `COMMIT_SHA=ac8085e` を表示する（環境変数のため。
  必要なら `COMMIT_SHA=67476f8` に更新）。

## 2. 反映後の状態

- 既存の RSP 画面・API・監査・MeshCentral は従来どおり。左ナビに「AI支援」が1つ増える。
- 既存の HelpDesk 画面は不変。`/api/terminal/*` に連携用の認証経路が増える。
- **連携キーが未設定のため、AI支援パネルは「未設定（503）」を表示する（fail-closed）。**
  既存業務への影響はない。

## 3. 残作業（人間によるキー設定）

`.env` への秘密書き込みはエージェントのポリシーで拒否されたため、次のブロックを**人間が実行**する。
共通キーを1つ生成し、HelpDesk と RSP の両方へ同じ値を設定して再起動する。

```bash
KEY="$(openssl rand -hex 32)"
HD_CONF="$HOME/.config/ai-helpdesk/api.conf"
RSP_ENV="/home/kensan/Projects/Mirai-Project/Remote-Service-Platform-for-Linux/.env"

# HelpDesk（未設定なら追記）
grep -q '^RSP_INTEGRATION_KEY=' "$HD_CONF" || \
  printf 'RSP_INTEGRATION_KEY=%s\n' "$KEY" >> "$HD_CONF"

# RSP（未設定なら追記）
if ! grep -q '^HELPDESK_SERVICE_KEY=' "$RSP_ENV"; then
  sudo sh -c "printf 'HELPDESK_SERVICE_KEY=%s\n' '$KEY' >> '$RSP_ENV'"
fi
if ! grep -q '^HELPDESK_BASE_URL=' "$RSP_ENV"; then
  sudo sh -c "printf 'HELPDESK_BASE_URL=http://127.0.0.1:18950\n' >> '$RSP_ENV'"
fi

systemctl --user restart ai-helpdesk-api
sudo systemctl restart rsp-api
```

- 2回実行しても重複しない（`grep -q` ガード）。ただし**片方だけ既に別のキーがある場合は不一致**になるので、
  両方の値を確認して揃えること。
- RSP のログイン（Entra）メールと HelpDesk の `claimed_by`（Access メール）が異なる場合は、
  RSP `.env` に読み替えを追加する:
  `HELPDESK_OPERATOR_ALIASES=entra@example.co.jp=access@example.com`

### 動作確認

```bash
# 1) HelpDesk の統合認証（認証通過なら 404 NOT_FOUND。401/403 ならキー未反映）
KEY=$(grep '^RSP_INTEGRATION_KEY=' ~/.config/ai-helpdesk/api.conf | cut -d= -f2-)
curl -s -H "X-Helpdesk-Service-Key: $KEY" \
     -H "X-Operator-Email: kensan1969@gmail.com"   # Access許可リストのメール \
     "http://127.0.0.1:18950/api/terminal/context?caseId=NO-SUCH"  # 例: -H "X-Operator-Email: kensan1969@gmail.com"

# 2) ブラウザ: https://rsp.mirai-remotetools.com/ にログイン → 左ナビ「AI支援」
#    → 案件ID（HelpDeskで claim 済み）を読み込み → AI提案 → 記録 → 終了 → 報告書 → ナレッジ下書き
```

## 4. ロールバック

```bash
# HelpDesk（旧コードへ戻して再起動。DBの追加テーブルはそのまま）
cd /home/kensan/Projects/Mirai-Admin-Platform/AI-HelpDesk-Platform
git checkout ac8085e && npm run build
systemctl --user restart ai-helpdesk-api
git checkout feat/handover-workspace

# RSP（main へ戻して再起動）
cd /home/kensan/Projects/Mirai-Project/Remote-Service-Platform-for-Linux
git checkout main
sudo systemctl restart rsp-api
```

- 旧コードは追加テーブルを参照しないため、DB のロールバックは不要。
- キーは残っていても旧コードでは使われない（無害）。不要なら該当行を削除する。

## 5. 既知の制約

- 実 Entra/MFA ログインでのUI通しは未確認（API・モックUI・ビルド後の起動は確認済み）。
- 出力は手動貼り付け（Phase 2 で W23 コマンド実行の自動取込を接続予定）。
- HelpDesk の `/api/health` の commit 表示は `COMMIT_SHA` 固定のため、デプロイ自動検知には使えない。
