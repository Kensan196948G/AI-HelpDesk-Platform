# 91. 本番 proxy unit の恒久修正の適用（2026-11-11 JST）

## 0. 結論

[PR #156](https://github.com/Kensan196948G/AI-HelpDesk-Platform/pull/156)（`726cc64`）でリポジトリに入れた proxy unit の恒久修正を、**ユーザー承認（選択肢 1）に基づき保守ウィンドウで本番ホストへ適用した**。`Wants=` は削除され、`After=ai-helpdesk-prod-api.service` のみになった。proxy を再起動しても旧 unit（`ai-helpdesk-api`）は引き上げられず、prod API のプロセスは変化せず、health は 200 を返した。

| 項目 | 結果 |
|---|---|
| 適用 | `bash scripts/install-proxy-service.sh` → **exit 0**（install → `daemon-reload` → `enable --now` → health） |
| 適用後の依存 | `Wants=`（空） / `After=` に `ai-helpdesk-prod-api.service` |
| 再起動（証跡用） | 2026-11-11T04:05:58 JST → **exit 0**、新 MainPID 3363623、`NRestarts=0` |
| 旧 unit | 再起動後も `inactive` / `not-found`（**引き上げなし**） |
| prod API | `MainPID=18626`（適用前後で不変）、`active` |
| health | HTTP 200（0.004〜0.017 s）、`db:"ok"`、`commit:"9a4eacc…"`、`env:"production"` |
| 失敗 dependency | `systemctl --user status` の表示になし |

## 1. 適用前（実測）

| 対象 | 実測 |
|---|---|
| deployed unit | `After=network-online.target ai-helpdesk-api.service` / `Wants=ai-helpdesk-api.service`（mtime 2026-10-25） |
| repo unit との差 | リポジトリ側は `Wants=` 削除済み（`diff` で差分あり＝未反映） |
| proxy | `enabled` / `active`、MainPID 863034、ActiveEnterTimestamp 2026-10-31 18:30:51 |
| prod API | `enabled` / `active`、MainPID 18626、ActiveEnterTimestamp 2026-11-06 12:15:09 |
| 旧 `ai-helpdesk-api` | `not-found` / `inactive` |
| health（18949 proxy 経由） | 200、`commit:"9a4eacc…"`、`db:"ok"` |

## 2. 適用（コマンドと出力）

```bash
cd <repo>            # 6c15c48
bash scripts/install-proxy-service.sh
```

出力（要点）:

```
上流 unit: ai-helpdesk-prod-api.service = active
上流 unit: ai-helpdesk-api.service = inactive
proxy ok: http://127.0.0.1:18949 -> http://127.0.0.1:18950
```

- `enable --now` は稼働中の proxy を**再起動しない**（MainPID 863034 のまま）。依存関係は `daemon-reload` で以後の起動に反映される。
- この時点で `Wants=` は空、`After=` は `ai-helpdesk-prod-api.service` を含む。

## 3. 保守ウィンドウ内の再起動（証跡）

依存関係が**新しい unit 定義で実際にロードされる**ことを確かめるため、proxy のみ再起動した。

```bash
systemctl --user restart ai-helpdesk-proxy.service   # exit 0 / 2026-11-11T04:05:58 JST
```

| 確認 | 結果 |
|---|---|
| proxy | `active (running)`、MainPID **3363623**、`NRestarts=0` |
| `Wants` / `After` | `Wants=`（空） / `After=` … `ai-helpdesk-prod-api.service` |
| 旧 unit の引き上げ | **なし**（`inactive` / `not-found` のまま） |
| prod API | MainPID **18626** のまま（再起動していない） |
| health 3 回 | すべて **200**（0.004〜0.017 s）、`db:"ok"`、`commit:"9a4eacc…"` |
| status | failed dependency の表示なし |
| journal | `[proxy] listening on http://127.0.0.1:18949 -> http://127.0.0.1:18950`（エラーなし） |

## 4. 意味と限界

- **意味**: rollback 等で旧 unit を復元した場合でも、proxy の再起動が旧 unit を引き上げて 18950 を奪う構造は**解消された**。`After=` により prod API の起動順序は保たれ、上流が落ちている間も proxy は 502 を返して稼働を続ける。
- **限界**:
  - 再起動に伴う瞬断の正確な時間は計測していない（再起動は 1 秒未満で完了し、3 秒後の health は 200）。
  - 認証付き Staging 受入・実 Access OTP・実機受入ではない。
  - 本適用はホストの unit ファイルと systemd の状態変更であり、リポジトリの変更ではない（リポジトリは `726cc64` で既に反映済み）。
  - 旧 unit を戻す rollback 手順（docs/82 §4-10）は残るが、proxy の `Wants=` が無いため引き上げは起きない。

## 5. 参照

- 承認: ユーザー選択「1. 保守ウィンドウで適用する」（2026-11-11）
- リポジトリ側の修正: [PR #156](https://github.com/Kensan196948G/AI-HelpDesk-Platform/pull/156) / [docs/89](89-round-20261110.md)
- 本番切替と未実施項目: [docs/85](85-production-cutover-20261106.md) §6 U-5
