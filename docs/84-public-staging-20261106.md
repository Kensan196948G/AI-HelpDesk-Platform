# 84. 公開 Staging の構築記録（2026-11-06 JST）

## 0. 結論

**公開 Staging（`https://ai-helpdesk-stg.mirai-dx-platform.com`）を新規 tunnel・新規 DNS・新規 Access アプリで構築した。既存の本番 tunnel / 本番 Access アプリは一切変更していない。**

| # | 受入条件 | 結果 |
|---|---|---|
| B-1 | 本番不変（tunnel ingress digest・cloudflared PID・NRestarts） | **PASS**（§3-1） |
| B-2 | 未認証 `GET /` が 302 → Access | **PASS**（§3-2） |
| B-3 | 認証後の `/` が 200 | **未実施**（実 Access OTP が人間の操作を要する） |
| B-4 | staging の AUD が本番 AUD と一致しない | **PASS**（§3-3） |
| B-5 | staging の操作が本番 DB に現れない | **PASS（構造）**（§3-4） |

**未実施の B-3 を「完了」とは扱わない。** 公開面は「Access で保護され、未認証は 302 で拒否される」ところまで実測した。

## 1. 構築したもの

| 種別 | 値 |
|---|---|
| tunnel 名 / ID | `ai-helpdesk-stg` / `c0abf547-445e-4791-b998-403c5f7e9deb` |
| tunnel config | `~/.cloudflared/ai-helpdesk-stg-config.yml`（0600、ingress は staging 1 本 + catch-all 404） |
| 資格情報 | `~/.cloudflared/c0abf547-….json`（0600） |
| DNS | `ai-helpdesk-stg.mirai-dx-platform.com` CNAME → `c0abf547-….cfargotunnel.com`（proxied） |
| systemd unit | `ai-helpdesk-stg-cloudflared.service`（enabled / active / MainPID 3326243 / NRestarts 0） |
| Access アプリ | `AI HelpDesk Staging` / domain `ai-helpdesk-stg.mirai-dx-platform.com` / self_hosted / session 8h |
| Access ポリシー | `staging-testers` / decision `allow` / include は**単一の管理者メール**（PII のため本書に書かない） |
| staging AUD | `0cc3a1366c99c5ae541efd60ae19df1d9a0276f2d0ab15ba8cdc3dc44d5308fa`（本番は `df503c7f…`） |
| App ID | `bc2b00ff-2bbf-4325-ae98-cf53da5de4f4` |

### 1-1. fail-closed の順序（実行順）

runbook docs/82 §3-1 の順序に従った。

1. 事前確認（tunnel 不在・DNS 不在・本番 config の基準値 `d51927da…`・空き 138G）
2. tunnel 作成 + 資格情報 0600
3. config 作成 → `cloudflared --config … tunnel ingress validate` = **OK**、`ingress rule` で staging → 18951 / 本番ホスト → 404 を確認（負の対照）
4. Access アプリ作成（allow は 1 名のみ）
5. staging 設定へ `ACCESS_AUD` / `ACCESS_TEAM_DOMAIN` / `ACCESS_JWT_MODE=enforce` / `COOKIE_SECURE=true` / `ALLOWED_ORIGINS` を反映 → staging API を restart
6. その後に tunnel unit を enable --now → DNS CNAME を作成

**「先に公開してから enforce」にはしていない。** 公開時点で既に enforce が有効。

## 2. 変更した設定（staging のみ）

`~/.config/ai-helpdesk/stg-api.conf`（0600）から 6 キーを置換して追記した。他のキー（DB 接続・秘密）は変更していない。

| キー | 値 |
|---|---|
| `AUTH_MODE` | `cloudflare-access` |
| `ACCESS_JWT_MODE` | `enforce`（従来は `off`） |
| `ACCESS_TEAM_DOMAIN` | 本番と同一 team（`winter-lake-f4c9.cloudflareaccess.com`） |
| `ACCESS_AUD` | staging 専用 AUD（本番と別） |
| `COOKIE_SECURE` | `true` |
| `ALLOWED_ORIGINS` | `https://ai-helpdesk-stg.mirai-dx-platform.com` |

反映後に staging API を restart（MainPID 3323176 / NRestarts 0 / active）。

## 3. 受入の実測

### 3-1. B-1 本番不変

| 対象 | 実行前 | 実行後 |
|---|---|---|
| 本番 tunnel config sha256 | `d51927da44c6b778c61f84743b3a79be530f713150e43b2552a7f1f69fa35d5b` | **同一** |
| 本番 `ai-helpdesk-cloudflared` MainPID / NRestarts | 2274303 / 0 | **2274303 / 0** |
| 本番 `ai-helpdesk-api` MainPID / NRestarts | 2379216 / 0 | **2379216 / 0** |
| 本番 `ai-helpdesk-proxy` MainPID | 863034 | **863034** |
| 本番 health commit | `a5e0a67…` | **同一** |
| 本番 DNS `ai-helpdesk.mirai-dx-platform.com` | 104.21.57.65 / 172.67.189.96 | **同一** |

既存 Access アプリ 3 件（本体・device token・device command）は**作成も更新もしていない**。

### 3-2. B-2 未認証アクセス

```
$ curl -sS -m15 -o /dev/null -w '%{http_code}' https://ai-helpdesk-stg.mirai-dx-platform.com/
302
$ curl -sS -m12 --noproxy '*' -o /dev/null -w '%{http_code}' https://ai-helpdesk-stg.mirai-dx-platform.com/
302
```

リダイレクト先は `https://winter-lake-f4c9.cloudflareaccess.com/cdn-cgi/access/login/ai-helpdesk-stg.mirai-dx-platform.com?kid=0cc3a136…`（kid は staging の AUD と一致）。

### 3-3. B-4 AUD の分離

| 環境 | Access アプリ | AUD |
|---|---|---|
| 本番 | Mirai AI HelpDesk MVP | `df503c7ffa8b5e519a87c62c4dc98d8554cacecf7ac7c262d1671a6d24a41598` |
| staging | AI HelpDesk Staging | `0cc3a1366c99c5ae541efd60ae19df1d9a0276f2d0ab15ba8cdc3dc44d5308fa` |

異なることを API の読み戻しで確認。staging 設定の `ACCESS_AUD` も staging 側と一致。

### 3-4. B-5 DB 隔離

| DB | 接続 | users | knowledge | cases | schema_migrations |
|---|---|---|---|---|---|
| staging | `127.0.0.1:5437` / `ai_helpdesk_stg` | **6** | 9 | 3 | 37 |
| 本番 | `127.0.0.1:5435` / `ai_helpdesk_preview` | **10** | 9 | 3 | 37 |

別クラスタ・別 DB。staging 側の users が 6 で本番が 10 のままであることを確認（staging の操作が本番へ現れない構造）。**構造の証拠であり、業務フローを通した後の件数比較は未実施。**

### 3-5. ローカル健康性

| 検査 | 結果 |
|---|---|
| staging `/api/health`（18952） | 200 / `ok:true` / `commit 4465f8d…` |
| staging `/`（18952 直） | **401 `PROXY_REQUIRED`**（proxy secret が無いための拒否） |
| staging `/`（18951 proxy 経由） | **401 `UNAUTHORIZED`**（Access enforce による拒否） |
| staging tunnel unit | active / MainPID 3326243 / NRestarts 0 / tunnel 接続 4 本 |

**401 の意味を取り違えないこと（独立検証 F-1 の指摘を反映）**: 18952 直の 401 は `REQUIRE_PROXY_SECRET=true` により Access 判定より前に返る `PROXY_REQUIRED` であり、**Access enforce の証拠にはならない**。enforce が効いていることの証拠は、proxy 経由の `UNAUTHORIZED`（proxy が `X-Proxy-Secret` を付与した後に Access JWT が無いため拒否）と、公開側の 302 → Access である。

## 4. 未実施・制約

| # | 項目 | 理由 |
|---|---|---|
| U-1 | 実 Access OTP でのログイン、認証後の `/` 200、主要フローの操作 | 人間のメール受信と OTP 入力が必要 |
| U-2 | Access グループによる複数名アクセス | 既存グループは PC-Ops/RSP 用の 1 件のみで流用不可。今回は単一管理者の email ポリシーにした（グループ作成は API トークンの権限不足で 403） |
| U-3 | staging からの業務操作後の本番 DB 件数比較 | 認証後 UI が必要（U-1） |
| U-4 | `COOKIE_SECURE=true` でのブラウザ動作 | 実ブラウザと Access セッションが必要 |
| U-5 | tunnel の長期安定性 | 構築直後のみ観測 |

## 5. rollback（公開面のみ。本番には影響しない）

```bash
systemctl --user disable --now ai-helpdesk-stg-cloudflared
rm -f ~/.cloudflared/ai-helpdesk-stg-config.yml
# DNS レコードと Access アプリは Cloudflare API で削除（tunnel は残しても害がない）
cloudflared tunnel delete ai-helpdesk-stg
```

staging API の `ACCESS_JWT_MODE` を `off` に戻す場合は、AUD を消すのではなく **enforce を維持したまま**公開面だけを下ろすこと（off に戻すと loopback からのヘッダ偽装が可能になる）。

## 6. 再現手順（要点）

```bash
# 1) tunnel
cloudflared tunnel create ai-helpdesk-stg
TUNNEL_ID=$(cloudflared tunnel list --output json | node -e '...')

# 2) config（本番ファイルは編集しない）
#    ~/.cloudflared/ai-helpdesk-stg-config.yml に tunnel / credentials-file / ingress を書く
cloudflared --config ~/.cloudflared/ai-helpdesk-stg-config.yml tunnel ingress validate
cloudflared --config ~/.cloudflared/ai-helpdesk-stg-config.yml tunnel ingress rule \
  https://ai-helpdesk.mirai-dx-platform.com/     # 期待: http_status:404（本番はこの tunnel が受けない）

# 3) Access アプリ + ポリシー（AUD を取得）
# 4) staging 設定へ AUD/enforce を反映して restart
# 5) unit 配置 → 起動 → DNS
install -m 644 ops/systemd/ai-helpdesk-stg-cloudflared.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now ai-helpdesk-stg-cloudflared
cloudflared --config ~/.cloudflared/ai-helpdesk-stg-config.yml tunnel route dns \
  ai-helpdesk-stg ai-helpdesk-stg.mirai-dx-platform.com
```

`scripts/install-staging.sh` は、tunnel config が既に存在する場合のみこの unit を配置する（Cloudflare 側は作らない）。

## 7. 限界

- 本記録は「公開面が Access で保護され、未認証が 302 で拒否され、本番と分離されている」ことの証拠である。**認証後の機能受入ではない。**
- Access ポリシーは単一メールの allow のみ。ステークホルダーを増やす場合はグループ作成（要 `access-acct.write` 権限のトークン）とポリシー更新が必要。
- 同一ホスト・同一 UID のため、staging と本番は CPU・メモリ・ディスクを共有する。
- 独立検証（`docs/evidence/public-staging-audit-20261106/audit.md`）は必須 7 項目すべて PASS。未確認は「Access ログイン後の実画面 200」と「業務フローを通した DB 分離の動的確認」の 2 点。
- DNS の負のキャッシュにより、`dig` は構築直後に NXDOMAIN を返すことがある（`resolvectl flush-caches` で解消。実測済み）。
