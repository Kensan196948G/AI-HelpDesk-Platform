# 85. 本番切替の実行記録（release 方式への移行 / 2026-11-06 JST）

## 0. 結論

**本番 API を checkout 直配備から immutable release 方式へ切り替え、main `625c3be` を配備した。停止は 11:46:48〜11:46:50 の約 1〜2 秒。DB スキーマ・設定値・port・tunnel は変更していない。**

| 受入 | 結果 |
|---|---|
| C-1 health の commit が配備 release と一致 | **PASS**（§3-1） |
| C-2 公開経路 302 / ローカル health 200 | **PASS**（§3-2） |
| C-3 主要画面 3 URL（実 Access ログイン） | **未実施**（人間の OTP が必要） |
| C-4 監査の既知破断が不変 | **PASS**（§3-4） |
| C-5 rollback 実効性 | **PASS（staging 訓練）**（§3-5） |
| C-6 監視（10 分窓 + tunnel-watch） | §3-6 |
| C-7 unit 交代の永続性 | **PASS**（§3-7） |

**本記録には 1 件のインシデント（runbook の判定コマンドの誤り）と、その復旧を隠さず書く（§4）。**

## 1. 実行内容

| 項目 | 値 |
|---|---|
| 配備 ref | `625c3bec6aa3016cfc177d4935e655bb429487f7`（実行時 `origin/main`） |
| release | `/home/kensan/ai-helpdesk-prod/releases/20261106T114603-625c3bec6aa3` |
| dist manifest | `d7fb9a6a007ddc9b233b22701c917108a393cb5947cb90e55d1324e5348a9d61`（196 files） |
| 新 unit | `ai-helpdesk-prod-api`（`ops/systemd/ai-helpdesk-prod-api.service` からレンダリング） |
| 事前 backup | `ai_helpdesk_preview-20261106-114516.dump` 266,592 B / sha256 `1d3a6f76…` |
| 事前 audit | checked 80 / mismatchCount 2 / ids `[10010,10013]` / kind `hash_mismatch` |
| DB | 未変更（`db/` 差分 0 を preflight で確認。`--migrate` / `--seed` を渡していない） |

### 1-1. 手順（docs/82 §4）

1. **§4-1 preflight**: ref 40 hex・main の祖先・root/unit/env の固定・#146 以降・`db/` 差分 0・テンプレート存在・MODE=bootstrap・18953 空き。すべて合格。
2. **§4-2 backup**: `scripts/backup-db.sh` で fresh dump を取得し `pg_restore --list` で読めることを確認。
3. **§4-4 precheck**: テンプレートをレンダリングして内容確認。`state/precheck.*` と drop-in `precheck-port.conf`（`PORT=18953`）を設置。
4. **§4-5 daemon-reload**: 旧 unit の `InvocationID`（`4f8d29d2…`）が不変であることを確認。
5. **§4-6 実配備**: `deploy-release.sh`（`--unit-template` / `--health-port 18953`）→ **RC=0**、`deploy: OK`、`unit installed from template`。この時点で旧 unit は 18950 で稼働継続（本番は止まっていない）。
6. **§4-7 出自確認（18953）**: `EnvironmentFiles` が `api.conf` → `current/release.env` → `state/precheck.*` の順、health の commit が ref と一致、`current` 実体・プロセス cwd が一致。
7. **§4-8 切替**: 旧 unit stop → precheck 除去 → 新 unit restart（18950）→ health の commit 一致確認 → 旧 unit disable/退避 → 新 unit enable。
8. **§4-9 受入**: 本節 §3。

### 1-2. 停止時間

| 事象 | 時刻 |
|---|---|
| 旧 `ai-helpdesk-api` 停止（SIGTERM → Stopped） | 11:46:48 |
| 新 `ai-helpdesk-prod-api` Started | 11:46:49 |
| 新 unit が 18950 で listen | 11:46:50 |

**停止は約 1〜2 秒。** 直前の旧 unit ログは 11:46:28 まで 200 を返していた。

## 2. 変更した状態

| 変更 | 内容 |
|---|---|
| `current` symlink | 新規作成 → `releases/20261106T114603-625c3bec6aa3` |
| 新 unit | 配置 + `enable`（`on-failure` / `RestartSec=3`） |
| 旧 unit | `disable`。`mask` は unit ファイルが存在するため失敗し、runbook の分岐どおり **unit ファイルを退避**（`state/ai-helpdesk-api.service.disabled`）→ `is-enabled` は `not-found` |
| 旧 unit の定義 | `state/ai-helpdesk-api.service.bak` に退避 |
| 旧 release（dry-run） | `prune_releases` により削除（`20261106T071603-e7d7f6f9dc94`） |
| tunnel / DNS / Access / 設定値 / DB | **変更なし** |

## 3. 受入の実測

### 3-1. C-1

```
$ curl -sS --noproxy '*' http://127.0.0.1:18950/api/health
{"ok":true,"service":"ai-helpdesk-api","version":"0.1.0","commit":"625c3bec6aa3016cfc177d4935e655bb429487f7","db":"ok","time":"2026-11-06T02:47:17.368Z","env":"production"}
$ readlink -f /home/kensan/ai-helpdesk-prod/current
/home/kensan/ai-helpdesk-prod/releases/20261106T114603-625c3bec6aa3
$ grep -E '^(COMMIT_SHA|RELEASE_ID)=' .../current/release.e*
COMMIT_SHA=625c3bec6aa3016cfc177d4935e655bb429487f7
RELEASE_ID=20261106T114603-625c3bec6aa3
MainPID=3956288 cwd=/home/kensan/ai-helpdesk-prod/releases/20261106T114603-625c3bec6aa3
```

health・`current`・`release.env`・プロセス cwd が一致。deploy state は `result: "success"`。

### 3-2. C-2

| 検査 | 結果 |
|---|---|
| 公開 URL（プロキシ経由） | **302**（Access） |
| 公開 URL（直接） | **302** |
| ローカル health | **200** |
| 18949 proxy 経由（JWT なし） | **401**（Access が要求される） |

### 3-3. C-3（未実施）

実 Access セッション（JWT）が必要。**未実施を合格扱いにしない。** JWT なしでは `/` も `/api/state` も 401 であることだけ確認した。

### 3-4. C-4

```
before: checked 80 / mismatchCount 2 / ids [10010,10013] / kinds ["hash_mismatch"]
after : checked 80 / mismatchCount 2 / ids [10010,10013] / kinds ["hash_mismatch"]
C-4 OK: 既知破断が不変（checked 80 -> 80）
```

`database = 127.0.0.1:5435/ai_helpdesk_preview`、`readOnly: true`。`prev_hash_mismatch` は 0 件。

### 3-5. C-5（staging 訓練）

切替と同じ機構（`current` symlink + `systemctl restart`）で、staging は 2026-11-06 08:28 に **2.1 秒**で旧 release へ戻り、**1.1 秒**で前方復帰した（docs/83 §4）。本番では訓練していない（runbook の指定どおり）。

### 3-6. C-6

切替 T0 = 2026-11-06T11:46:48+09:00。10 分後の 11:56:53 に、T0 を中心とする同一長（10 分）の窓で比較した。

| 検査 | 結果 |
|---|---|
| `ai-helpdesk-cloudflared` 経路失敗 before / after | 0 / **0** |
| `ai-helpdesk-proxy` 経路失敗 before / after | 0 / **0** |
| 新 unit の `statusCode:5xx`（after） | **0**（分母 `completed` = 8） |
| 旧 unit の before | 5xx 0 / completed 1 |
| `tunnel-watch` | **`tunnel-watch: ok (failures=0 window=10min)`**（閾値 3 未満） |

**判定: PASS。** ただし `ok` はその回の判定であり恒常的な正常の証明ではない。経路失敗 0・5xx 0（分母 8）と併記して C-6 の証拠とする。

### 3-7. C-7

| 検査 | 結果 |
|---|---|
| `is-enabled ai-helpdesk-prod-api` | **enabled** |
| `is-enabled ai-helpdesk-api` | **not-found**（退避） |
| 18950 の待受 | 新 unit の MainPID 3956288 のみ |
| 18953 | 待受なし（precheck は除去済み） |

### 3-8. DB の不変

| 指標 | 切替前 | 切替後 |
|---|---|---|
| users | 10 | **10** |
| knowledge | 9 | **9** |
| cases | 3 | **3** |
| schema_migrations | 37 | **37** |
| audit_log | 80 | **80** |

## 4. インシデント（runbook の判定コマンドの誤り）と復旧

### 4-1. 何が起きたか

§4-8 の切替スクリプトが、**health 合格後・旧 unit の disable 前**に「cmdline 不一致」で `exit 1` した。

```
cutover T0=2026-11-06T11:46:48+09:00
old unit stopped at 2026-11-06T11:46:48+09:00
cmdline 不一致
```

### 4-2. 原因

runbook §4-8 の判定は `cmdline` に `<current の実体パス>/apps/api/dist/index.js` が含まれることを要求する。しかし unit の `ExecStart` は `__PROD_ROOT__/current/apps/api/dist/index.js`（**symlink パス**）であり、プロセスの argv には symlink パスが残る。`cwd` は実体に解決されるため一致するが、**cmdline の比較だけが必ず失敗する**。runbook の記述誤り（実装は正しい）。

実測: `tr '\0' '\n' < /proc/3956288/cmdline` → `/home/kensan/ai-helpdesk-prod/current/apps/api/dist/index.js`

### 4-3. 影響（正直な記載）

- **本番の停止は延びていない。** 旧 unit 停止（11:46:48）→ 新 unit が 18950 で listen（11:46:50）の 1〜2 秒で復帰しており、スクリプトの異常終了はその**後**に起きた。
- ただし、**新 unit が `enable` されないまま、旧 unit が `enabled` のまま残った**状態が約 20 秒続いた（11:46:50〜11:47:09）。この間にホストが再起動していれば、旧 unit が起動して `current` を読まない checkout 直配備に戻っていた（＝意図しない版で起動）。**サービス断ではないが、永続化の不整合**である。

### 4-4. 復旧

`cwd` と health は合格していたため、判定を `current` 経由のパスで再実行して合格を確認し、§4-8 step 4 を実行した。

- `disable ai-helpdesk-api` → `mask` 失敗（unit ファイル存在）→ 退避 → `is-enabled = not-found`
- `enable ai-helpdesk-prod-api` → `enabled`
- 18950 の待受が新 unit の MainPID のみであることを確認

### 4-5. 再発防止

runbook §4-8 の cmdline 検査を「`current` を解決した実体」ではなく **`current` を含む起動時パス**で比較するか、`cwd` と `release.env` と health の 3 点で判定するよう修正する（docs の PR で対応する）。§4-7 の同じ検査も同様。

## 5. rollback（本番を旧方式へ戻す）

```bash
systemctl --user stop ai-helpdesk-prod-api
systemctl --user disable ai-helpdesk-prod-api
cp -p /home/kensan/ai-helpdesk-prod/state/ai-helpdesk-api.service.disabled \
      "$HOME/.config/systemd/user/ai-helpdesk-api.service"   # 退避した定義を戻す
systemctl --user daemon-reload
systemctl --user enable --now ai-helpdesk-api
curl -sS --noproxy '*' http://127.0.0.1:18950/api/health   # 期待: commit a5e0a67…
```

`current` は release の証跡として残す。新 unit を再び有効化する場合は旧 unit を再度 disable する。**DB は変更していないため、DB の rollback は不要。**

## 6. 未実施・残リスク

| # | 項目 | 状態 |
|---|---|---|
| U-1 | C-3 実 Access ログイン後の 3 画面 200 | 未実施（人間の OTP） |
| U-2 | 再配備（subsequent）モードの実配備 | 未実施（今回は bootstrap のみ） |
| U-3 | `restart` 失敗時の rollback（`restart-failed`）の実地訓練 | 未実施（コード分岐のみ） |
| U-4 | 本番での rollback 訓練 | 未実施（staging で代替） |
| U-5 | proxy unit の `Wants=` 恒久修正 | **リポジトリ側は修正済み（2026-11-10、[docs/89](89-round-20261110.md)）**。`ops/systemd/ai-helpdesk-proxy.service` から **`Wants=` を削除**し、`After=network-online.target ai-helpdesk-prod-api.service` のみにした。`Wants=` は disable 済み unit も起動するため、rollback 後の proxy 再起動で prod を引き上げて 18950 を奪い、rollback を黙って巻き戻す。installer は `api.conf` 不在を exit 1、上流 unit の状態は**表示のみ**（非致命）とし、**health を唯一の hard gate** にした。**本番 unit へは 2026-11-11 に適用済み**（承認を得て `scripts/install-proxy-service.sh` → `daemon-reload` → 保守ウィンドウ内で再起動検証。[docs/91](91-proxy-unit-applied-20261111.md)）。適用後は `Wants=` が空、旧 unit は `not-found` / `inactive` のまま引き上げられず、prod API の MainPID は不変、health は 200（受入は `systemctl --user show ai-helpdesk-proxy -p Wants,After`） |
| U-6 | 監査ログの暗号学的な真正性 | 未証明（既知破断 2 件は維持） |
