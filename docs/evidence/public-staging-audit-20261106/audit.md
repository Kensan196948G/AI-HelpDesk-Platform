# 公開 Staging 独立検証（Step12）

- 対象: PR #150（MERGED）/ `docs/84-public-staging-20261106.md` / main `0f86939`
- 検証時刻: 2026-11-06 11:00〜11:05 JST
- 検証者: 独立レビュー担当（実装者・Lead とは別）
- 方法: **read-only のみ**。ローカル `curl` / `dig` / `getent` / `ss` / `systemctl --user show|is-enabled|list-timers` / `journalctl` / `stat` / `sha256sum` / `cloudflared tunnel ingress rule` / Cloudflare API の **GET のみ**（書き込みなし）
- 制約: Secret・メールアドレス・資格情報 JSON・Access ポリシーのメール値は**取得・出力していない**（ポリシーは decision と件数のみ）。`resolvectl flush-caches` 等の非 read 操作は未実行

## 0. 判定

**PASS（必須 7 項目すべて充足）**

| # | 検証項目 | 判定 |
|---|---|---|
| 1 | 未認証アクセスが 302 → Access、kid == staging AUD（直・proxy 両方） | **PASS** |
| 2 | DNS が proxied CNAME → `c0abf547….cfargotunnel.com` | **PASS**（CNAME 実体は API で確認。公開 DNS は proxied A のみ） |
| 3 | 本番不変（config sha256 / 3 unit / health commit） | **PASS** |
| 4 | 既存 Access アプリ 3 件が未更新 | **PASS** |
| 5 | staging cloudflared が active・tunnel 接続あり | **PASS** |
| 6 | staging `/` が 401、`/api/health` が 200 | **PASS**（body code の記録に 1 件誤り。下記 F-1） |
| 7 | 本番ホストが staging ingress で 404 | **PASS** |

**総合**: 公開面の要件は満たしている。本番への影響は観測されない。
**指摘 1 件（Low・記録の誤り）**＋**未確認 2 件**（認証後の 200、および実運用フローを通した DB 分離の動的確認）。

---

## 1. 未認証アクセスの 302 と AUD 一致 — PASS

```
$ curl --noproxy '*' -sS -o /dev/null -w '%{http_code}' https://ai-helpdesk-stg.mirai-dx-platform.com/
302
$ curl -sS -o /dev/null -w '%{http_code}' https://ai-helpdesk-stg.mirai-dx-platform.com/      # ポリシープロキシ経由
302
```
- `location:` は `https://winter-lake-f4c9.cloudflareaccess.com/cdn-cgi/access/login/ai-helpdesk-stg.mirai-dx-platform.com?…`（Access のログイン URL。`cdn-cgi/access/login` の出現を確認）
- 遷移先の `kid` を抽出して比較:

| 経路 | final HTTP | kid | 判定 |
|---|---|---|---|
| 直接（`--noproxy '*'`） | 302 | `0cc3a1366c99…`（64 hex） | staging AUD と **MATCH** |
| ポリシープロキシ経由 | 302 | `0cc3a1366c99…`（64 hex） | staging AUD と **MATCH** |

期待値 `0cc3a1366c99c5ae541efd60ae19df1d9a0276f2d0ab15ba8cdc3dc44d5308fa` と完全一致（kid は Access アプリの AUD。秘密ではない）。

## 2. DNS — PASS

**公開 DNS**（負のキャッシュなし。両方で解決を確認）:
```
$ dig +short @1.1.1.1 ai-helpdesk-stg.mirai-dx-platform.com A
172.67.189.96
104.21.57.65
$ getent hosts ai-helpdesk-stg.mirai-dx-platform.com
2606:4700:3032::6815:3941 / 2606:4700:3037::ac43:bd60
```
→ Cloudflare のエッジ IP に解決（A レコード）。**proxied レコードのため CNAME は公開 DNS に現れない**（`dig +short … CNAME` は空）。これは仕様どおり。

**CNAME の実体は Cloudflare API で確認**（read-only GET）:

| 項目 | 値 |
|---|---|
| type / name | `CNAME` / `ai-helpdesk-stg.mirai-dx-platform.com` |
| content | `c0abf547-445e-4791-b998-403c5f7e9deb.cfargotunnel.com` |
| proxied | **true** |
| created_on / modified_on | **2026-11-06T01:53:21Z / 同日同刻**（新規作成・以後未変更） |

本番レコード `ai-helpdesk.mirai-dx-platform.com` は `96d0214e-…cfargotunnel.com` / proxied / created=modified=`2026-10-23T05:46:05Z` → **未変更**。

## 3. 本番不変 — PASS

| 対象 | 実測 | 期待（docs/84 §3-1） | 判定 |
|---|---|---|---|
| 本番 `~/.cloudflared/ai-helpdesk-config.yml` sha256 | `d51927da44c6b778c61f84743b3a79be530f713150e43b2552a7f1f69fa35d5b` | `d51927da…35d5b` | 一致 |
| `ai-helpdesk-cloudflared` | MainPID **2274303** / NRestarts **0** / active | 2274303 / 0 | 一致 |
| `ai-helpdesk-api` | MainPID **2379216** / NRestarts **0** / active | 2379216 / 0 | 一致 |
| `ai-helpdesk-proxy` | MainPID **863034** / NRestarts **0** | 863034 | 一致 |
| 本番 health commit | `a5e0a6719699d4711fc1811bbdb79c74d9aab393` | `a5e0a67…` | 一致 |

補強: 本番 unit ファイルの mtime は `2026-10-23 14:45`、本番 config は `2026-10-25 13:20` で、**本日変更されていない**。

## 4. 既存 Access アプリ 3 件が未更新 — PASS

Cloudflare API（GET `/accounts/{id}/access/apps`）の読み戻し。`updated_at == created_at` かつ作成日が本日より前であることを確認（値は記録可との指示に従い記載。ポリシー内容・メールは取得していない）。

| アプリ | 対象ドメイン | AUD（先頭） | created_at | updated_at | 判定 |
|---|---|---|---|---|---|
| Mirai AI HelpDesk MVP | `ai-helpdesk.mirai-dx-platform.com` | `df503c7f…` | 2026-10-23T05:44:10Z | **2026-10-23T05:44:10Z** | 未更新 |
| AI HelpDesk Endpoint Agent (device token) | `ai-helpdesk.mirai-dx-platform.com/api/device/agent` | `816ad302…` | 2026-10-23T07:12:43Z | **2026-10-23T07:12:43Z** | 未更新 |
| AI HelpDesk Endpoint Agent (command poll) | `ai-helpdesk.mirai-dx-platform.com/api/device/command` | `057be3a3…` | 2026-10-26T00:41:14Z | **2026-10-26T00:41:14Z** | 未更新 |

新規 staging アプリ: `AI HelpDesk Staging` / id `bc2b00ff-2bbf-4325-ae98-cf53da5de4f4` / domain `ai-helpdesk-stg.mirai-dx-platform.com` / AUD `0cc3a1366c99…` / created=updated=`2026-11-06T01:52:15Z`。**docs/84 §1 の App ID・AUD と一致**。

本番 AUD `df503c7ffa8b5e519a87c62c4dc98d8554cacecf7ac7c262d1671a6d24a41598` と staging AUD が**別値**であることも確認（B-4 の分離）。

**ポリシー（構造のみ）**: `staging-testers` / decision `allow` / include **1 件**（種別 `email`）/ exclude 0 / require 0。
→ docs/84 の「単一メールのみ allow」と整合。**メールアドレス自体は取得・出力していない。**

## 5. staging cloudflared unit と tunnel 接続 — PASS

| 項目 | 実測 |
|---|---|
| `ai-helpdesk-stg-cloudflared` | ActiveState **active** / SubState **running** / MainPID **3326243** / NRestarts **0** |
| enabled | **enabled** |
| tunnel 接続 | journal に `Registered tunnel connection` を **connIndex 0〜3 の 4 本**確認（protocol=quic、location=nrt12/nrt17 等） |
| config | `~/.cloudflared/ai-helpdesk-stg-config.yml` は **600**、`credentials-file` の実体 JSON も **600** |
| unit 配置 | deployed は `ops/systemd/ai-helpdesk-stg-cloudflared.service` のレンダリング結果と **完全一致** |
| ingress（config 実体） | 1) `ai-helpdesk-stg.mirai-dx-platform.com` → `http://127.0.0.1:18951`、2) catch-all `http_status:404` |

## 6. staging のローカル認証境界 — PASS（body code の記録に誤りあり）

| パス | 18952 直 | 18951 proxy 経由 | body code |
|---|---|---|---|
| `/` | **401** | **401** | 直 = **`PROXY_REQUIRED`** / proxy = **`UNAUTHORIZED`** |
| `/api/state` | **401** | **401** | 同上 |
| `/api/health` | **200** | **200** | `ok:true` / `db:"ok"` / `commit 4465f8d…` |

staging 設定（`~/.config/ai-helpdesk/stg-api.conf`）の非秘密フラグ:
```
AUTH_MODE=cloudflare-access
ACCESS_JWT_MODE=enforce
COOKIE_SECURE=true
ALLOWED_ORIGINS=https://ai-helpdesk-stg.mirai-dx-platform.com
REQUIRE_PROXY_SECRET=true
ACCESS_AUD=0cc3a136…（task 指定値と一致）
```
`current` → `releases/20261106T083747-4465f8d8905c`、18951/18952 とも listen、`ai-helpdesk-stg-proxy` MainPID 1945305 / NRestarts 0。

## 7. 本番ホストが staging ingress で 404 — PASS

```
$ cloudflared --config ~/.cloudflared/ai-helpdesk-stg-config.yml tunnel ingress rule https://ai-helpdesk.mirai-dx-platform.com/
Matched rule #1
	service: http_status:404
$ cloudflared --config … tunnel ingress rule https://ai-helpdesk-stg.mirai-dx-platform.com/
Matched rule #0
	hostname: ai-helpdesk-stg.mirai-dx-platform.com
	service: http://127.0.0.1:18951
```
→ 本番ホスト名は staging tunnel では **404**（rule #1 の catch-all）、staging ホスト名のみ rule #0 で origin に到達。負の対照が成立。
（`cloudflared tunnel ingress rule` はグローバルフラグを先に置く必要がある。`--config` を後置すると `flag provided but not defined` になる＝コマンドの書き方に注意）

---

## 8. 指摘

### F-1（Low・記録の誤り）: docs/84 §3-5 が「18952 直も `UNAUTHORIZED`」と記載しているが、実測は `PROXY_REQUIRED`

- docs/84 §3-5 の表:
  - `staging /（18952 直）` → **401 `UNAUTHORIZED`**（enforce が効いている）
  - `staging /（18951 proxy 経由）` → **401 `UNAUTHORIZED`**
- 実測: 18952 直の body は `{"error":{"code":"PROXY_REQUIRED",...}}`。`UNAUTHORIZED` を返すのは **18951 proxy 経由**のみ。
- これは実装どおりの正しい挙動（`REQUIRE_PROXY_SECRET=true` のため、proxy secret 無しの直接アクセスは Access 判定より前に 401 になる。`apps/api/src/server.ts` の onRequest フック）。
- 影響: セキュリティ上の問題はない（401 であることに変わりはない）。ただし**「enforce が効いている証拠」としては proxy 経由の `UNAUTHORIZED` を引く必要がある**。直叩きの 401 は proxy secret の証拠であり、Access enforce の証拠にはならない。記録の正確性のため 1 行修正を推奨。

### 観測事項（本件の範囲外・要確認）: 同一アカウントで別アプリが同時刻に作成されている

- `dd-production`（domain `dd-prod.mirai-dx-platform.com`）が **2026-11-06T02:01:32Z**（= 11:01:32 JST、本検証の直前）に作成されている。
- 本プロジェクト（AI HelpDesk）とは別系統で、**本 PR の検証対象外**。ただし「本番昇格作業の当日に別プロジェクトの本番 Access アプリが作成された」事実は、作業者・承認の帰属を確認しておく価値がある（本事業の作業ログには現れない）。判定には影響しない。

---

## 9. 未確認（未確認と明記する）

1. **認証後の実画面（Access ログイン → `/` 200）**: Access のセッション（人間のログイン）が必要なため未実施。tunnel→origin の leg は「トンネル接続 4 本 registered」「ingress rule #0 → 18951」「18951/18952 が listen し health 200」で**間接的に支持される**が、エンドツーエンドの 200 は**観測していない**。
2. **DB 分離の動的確認（業務フローを通した件数比較）**: docs/84 §3-4 も「構造の証拠であり、業務フローを通した後の件数比較は未実施」と明記している。本検証も DB へは接続していない（read-only 制約を超えるため）。構造（別クラスタ 5437/5435・別 DB 名）は docs/81 §5 の既測。
3. **Access ポリシーのメール値**: PII のため意図的に取得・出力していない。件数・種別・decision のみ確認（§4）。

---

## 10. 再現コマンド（read-only）

```bash
H=https://ai-helpdesk-stg.mirai-dx-platform.com/
# 1) 302 と kid
curl --noproxy '*' -sS -o /dev/null -D - "$H" | grep -i '^location:'   # kid= を抽出して AUD と比較
curl -sS -o /dev/null -w '%{http_code}\n' "$H"
# 2) DNS
dig +short @1.1.1.1 ai-helpdesk-stg.mirai-dx-platform.com A
getent hosts ai-helpdesk-stg.mirai-dx-platform.com
# 3) 本番不変
sha256sum ~/.cloudflared/ai-helpdesk-config.yml
systemctl --user show ai-helpdesk-cloudflared -p MainPID -p NRestarts -p ActiveState
systemctl --user show ai-helpdesk-api -p MainPID -p NRestarts
curl -sS --noproxy '*' http://127.0.0.1:18950/api/health
# 4) Access アプリ（GET のみ。ポリシーは件数のみ）
#    GET /accounts/{id}/access/apps → name/domain/aud/created_at/updated_at
#    GET /accounts/{id}/access/apps/{appId}/policies → decision / include 件数
# 5) staging tunnel
systemctl --user show ai-helpdesk-stg-cloudflared -p ActiveState -p SubState -p MainPID -p NRestarts
systemctl --user is-enabled ai-helpdesk-stg-cloudflared
journalctl --user -u ai-helpdesk-stg-cloudflared --since '-10min' --no-pager -o cat | grep -c 'Registered tunnel connection'
stat -c '%a %n' ~/.cloudflared/ai-helpdesk-stg-config.yml ~/.cloudflared/c0abf547-445e-4791-b998-403c5f7e9deb.json
# 6) staging 認証境界
for p in / /api/state /api/health; do
  printf '%s direct=' "$p"; curl -sS --noproxy '*' -o /dev/null -w '%{http_code}' "http://127.0.0.1:18952$p"
  printf ' proxy=';           curl -sS --noproxy '*' -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:18951$p"
done
curl -sS --noproxy '*' http://127.0.0.1:18952/ | head -c 120   # → PROXY_REQUIRED
curl -sS --noproxy '*' http://127.0.0.1:18951/ | head -c 120   # → UNAUTHORIZED
# 7) ingress の負の対照
cloudflared --config ~/.cloudflared/ai-helpdesk-stg-config.yml tunnel ingress rule https://ai-helpdesk.mirai-dx-platform.com/
cloudflared --config ~/.cloudflared/ai-helpdesk-stg-config.yml tunnel ingress rule https://ai-helpdesk-stg.mirai-dx-platform.com/
```
