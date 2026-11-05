# 82. 承認後に実行する手順 — Staging 公開 / 本番昇格（2026-11-06）

## 0. この文書の位置づけ

**未実行の手順書である。** 承認プロンプトが無効なセッションのため、`systemctl` を伴う操作と Cloudflare の追加は自動拒否される。本稿は、承認が得られた時点で**同一手順・同一検証**で実行できるように、コマンド・受入条件・rollback・影響範囲を固定するためのものである。実行した実績は §6 に追記する。

対象は 3 つ。**A と B は独立**で、A だけでも価値がある。C は本番の瞬断を伴う。

| 区分 | 内容 | 本番への影響 | 不可逆性 |
|---|---|---|---|
| A | Staging の service 定義更新・proxy 起動 | なし | なし |
| B | 公開 Staging（新規 tunnel / DNS / Access アプリ） | なし（既存 tunnel・既存 Access アプリを変更しない） | なし（削除で戻せる） |
| C | 本番を release 方式へ切替 + 新 main 配備 | **あり（秒〜十数秒の瞬断）** | 低（release/unit を戻せば復旧。DB は変更しない） |

## 1. 前提（現状の実測値）

| 項目 | 値 |
|---|---|
| main | `e7d7f6f`（docs/81 まで統合済み） |
| 本番稼働 commit | `a5e0a67`（main より遅れている） |
| 本番 api unit | `ai-helpdesk-api` / `WorkingDirectory=/home/kensan/Projects/Mirai-Admin-Platform/AI-HelpDesk-Platform` / `ExecStart=node apps/api/dist/index.js` |
| 本番 proxy unit | `ai-helpdesk-proxy`（SIDECAR_PORT=18949 / API_PORT=18950 を unit に固定） |
| 本番 tunnel | `96d0214e-8236-4bce-8dd0-75233d1e716f` / `~/.cloudflared/ai-helpdesk-config.yml`（ingress 1 本 → 18949） |
| Staging API | `127.0.0.1:18952`（`ai-helpdesk-stg-api`、稼働中） |
| Staging DB | `127.0.0.1:5437` / `ai_helpdesk_stg`（稼働中） |
| Staging release | `/home/kensan/ai-helpdesk-stg/releases/20261106T063553-359cbd012274` |
| Staging の未了 | health の `commit` が空（unit が `release.env` を読んでいない） / proxy 未起動 / 公開なし |

## 2. A: Staging の service 定義更新と proxy 起動（本番影響なし）

### 2-1. 変更内容

1. `~/.config/systemd/user/ai-helpdesk-stg-api.service` に次の 1 行を追加（`EnvironmentFile=` の**後ろ**に置き、`COMMIT_SHA` を release から供給する）。

   ```
   EnvironmentFile=/home/kensan/ai-helpdesk-stg/current/release.env
   ```

2. `systemctl --user daemon-reload`
3. `systemctl --user enable --now ai-helpdesk-stg-proxy`
4. `systemctl --user restart ai-helpdesk-stg-api`

### 2-2. 受入条件

| # | 検査 | 合格条件 |
|---|---|---|
| A-1 | health の commit | `GET http://127.0.0.1:18952/api/health` の `commit` が `359cbd012274fd23ed3ee99a5a497236b4ac7711` |
| A-2 | `ok` / `db` / `env` | `ok:true` / `db:"ok"` / `env:"production"` |
| A-3 | proxy 経由 | `GET http://127.0.0.1:18951/api/health` が 200（`X-Proxy-Secret` は proxy が付与） |
| A-4 | 未認証の閉鎖 | `GET http://127.0.0.1:18952/api/me` が 401 |
| A-5 | 本番不変 | 本番 api の MainPID・NRestarts・health commit が不変 |

### 2-3. rollback

unit から追加行を削除 → `daemon-reload` → `restart ai-helpdesk-stg-api`。Staging DB・release は変更しない。

## 3. B: 公開 Staging（新規 tunnel / DNS / Access）

### 3-1. 原則

- **既存 tunnel `96d0214e…` と既存 Access アプリは変更しない。** 変更すると本番の tunnel 再起動・認証境界の変更になる。
- 新規 tunnel `ai-helpdesk-stg`・新規 Access アプリ（staging 専用 AUD）を作る。
- Staging は `ACCESS_JWT_MODE=enforce`・`COOKIE_SECURE=true`・`ALLOWED_ORIGINS=https://ai-helpdesk-stg.mirai-dx-platform.com` に**先に**変更してから公開する。

### 3-2. 手順

```bash
# 1) 新規 tunnel（既存とは別名）
cloudflared tunnel create ai-helpdesk-stg
# 2) 新規 config（ingress は staging だけ。既存 config は触らない）
#    ~/.cloudflared/ai-helpdesk-stg-config.yml
#    tunnel: <新 UUID> / credentials-file: <新 json>
#    ingress: ai-helpdesk-stg.mirai-dx-platform.com -> http://127.0.0.1:18951
# 3) DNS（新規レコードのみ）
cloudflared tunnel route dns --config ~/.cloudflared/ai-helpdesk-stg-config.yml ai-helpdesk-stg ai-helpdesk-stg.mirai-dx-platform.com
# 4) systemd user unit: ai-helpdesk-stg-cloudflared.service（新規）
# 5) Cloudflare Access: 新規 self_hosted アプリ（domain=ai-helpdesk-stg…、専用 AUD、allow は staging 試験担当のみ）
# 6) staging 設定を enforce/secure に更新し、unit を再起動
```

Cloudflare の Access アプリ作成・AUD 取得は API（`POST /accounts/{id}/access/apps`）で行い、**既存アプリの PUT はしない**。

### 3-3. 受入条件

| # | 検査 | 合格条件 |
|---|---|---|
| B-1 | 本番不変 | 本番 tunnel の ingress digest・cloudflared PID・NRestarts が不変 |
| B-2 | 未認証 | `GET https://ai-helpdesk-stg…/` が 302 → Access |
| B-3 | 認証後 | 試験担当の Access ログインで `/` が 200（実 OTP は人間） |
| B-4 | 本番と別 AUD | staging の JWT が本番 AUD と一致しない（設定値の照合） |
| B-5 | DB 隔離 | staging の操作が本番 DB に現れない（件数・最終更新の前後比較） |

### 3-4. rollback

`ai-helpdesk-stg-cloudflared` を stop/disable → DNS レコード削除 → Access アプリ削除。本番側は無変更のため影響なし。

## 4. C: 本番の release 方式への切替と配備

### 4-1. 危険度と前提

- **本番の unit を書き換える**ため、承認が必須。瞬断を伴う。
- 事前に本番 DB の新規 dump を取得し、**新規 DB への復元確認**（本稿 §5）を行ってから実施する。
- 変更は「起動元を checkout 直参照から immutable release 参照へ変える」こと。port・tunnel・DB・設定値は変えない。

### 4-2. 手順（案）

```bash
# 0) 事前バックアップ（本番 DB は読み取りのみ。既存 backup スクリプトを使う）
bash scripts/backup-db.sh

# 1) 本番用 release を生成（本番 unit 名は既存を流用しない）
scripts/deploy-release.sh \
  --repo /home/kensan/Projects/Mirai-Admin-Platform/AI-HelpDesk-Platform \
  --ref <main SHA> \
  --root /home/kensan/ai-helpdesk-prod \
  --env-file ~/.config/ai-helpdesk/api.conf \
  --unit ai-helpdesk-prod-api \
  --health-port 18950 --dry-run      # ← build と manifest 検証だけ

# 2) 本番用 unit を新設（既存 ai-helpdesk-api は停止しない）
#    ai-helpdesk-prod-api.service: WorkingDirectory=<prod root>/current, PORT=18950
#    ※ 同一 port のため、切替時に旧 unit を停止してから新 unit を起動する（瞬断）

# 3) 切替（承認後に実行）
systemctl --user stop ai-helpdesk-api
systemctl --user start ai-helpdesk-prod-api
curl -fsS http://127.0.0.1:18950/api/health   # commit が新 main と一致すること

# 4) 失敗時
systemctl --user stop ai-helpdesk-prod-api
systemctl --user start ai-helpdesk-api        # 旧 dist のまま復旧
```

### 4-3. 受入条件

| # | 検査 | 合格条件 |
|---|---|---|
| C-1 | health | `commit` が配備 SHA と一致、`db:"ok"`、`env:"production"` |
| C-2 | 公開経路 | 未認証 302 → Access、`/api/health` ローカル 200 |
| C-3 | 主要フロー | 認証後 UI の主要 3 画面が 200（実 Access ログインは人間） |
| C-4 | 監査 | 配備前後の audit_log に想定外の増減・チェーン破断がない |
| C-5 | rollback 実効性 | 旧 unit へ戻して health が旧 commit で復旧することを**訓練で確認** |
| C-6 | 監視 | tunnel-watch が `ok`、5xx が増えない |

### 4-4. リスク

| リスク | 影響 | 緩和 |
|---|---|---|
| 瞬断 | 数秒の 502/接続失敗 | 事前告知・短時間で切替・health 即確認 |
| unit 書換の誤り | 起動失敗 | `--dry-run` で build 済み・旧 unit を残す・rollback 手順を先に訓練 |
| dist と HTML の不整合 | 画面の無音故障 | release に HTML/bridge/skills を同梱済み（docs/78 §1） |
| DB 変更 | なし（本手順は DB を変更しない） | migration は別承認 |

## 5. 事前に実施できる検証（承認不要）

1. `--dry-run` で本番相当 release を生成し、manifest・HTML 同梱を検証する（**本番 unit は触らない**）。
2. 事前 dump の**新規 DB への復元**と監査鎖検証（docs/78 §7-1 / docs/81 §10 と同じ手順）。
3. rollback 手順の机上確認と、staging での同等切替の訓練。

## 6. 実行記録（承認後に追記）

| 日時 | 区分 | 実行者 | 結果 | 証跡 |
|---|---|---|---|---|
| — | — | — | 未実行 | — |
