# 同一視解除の実測証跡（2026-10-28）

- 決定と手順: `docs/56-identity-split-20261028.md`
- 対象: 検証インスタンス `:18962`（HEAD `05b2398` ビルド / DB `ai_helpdesk_verify` / migration 025 /
  `EMAIL_ALIASES=''` / `AUTH_MODE=cloudflare-access` / `ACCESS_JWT_MODE=off` / `ALLOW_SELF_APPROVAL=true`）

## 実行方法

```bash
BASE=http://127.0.0.1:18962 \
DATABASE_URL='<ai_helpdesk_verify の DSN>' \
node scripts/verify/split-identity-20261028.mjs
```

スクリプトは DB 名が `ai_helpdesk_verify` 以外なら即終了する。作った行は末尾で削除する。

## 結果（5/5 PASS）

```
OK  状態キーが分離される :: operator=k-aritoh@mirai-const.co.jp / approver=kensan1969@gmail.com
OK  名簿解決が分離される :: operator=MK0623（DX） / approver=null（demo 扱い）
OK  運用者（k-aritoh）が指名引継ぎを claim :: HTTP 200
OK  別アカウント承認が成立（self_approved=false） :: HTTP 200 / claimed_by=k-aritoh… / approved_by=kensan1969@gmail.com
OK  監査に運用者と承認者が別々に残る :: actors=split-owner… / k-aritoh… / kensan1969@gmail.com
```

## 本番側の実測（読み取りのみ）

| 項目 | 値 |
|---|---|
| `EMAIL_ALIASES`（プロセス環境） | 空 |
| `/api/health` | `ok:true` / `db:ok` / `commit=be1e0c3…` / `env=production` |
| 公開 URL | 302（Cloudflare Access） |
| 再起動後の 5xx | 0 |
| `user_roles` の `approver` | `w***@example.com`（seed）・`kens***@gmail.com`（manual） |

- 本番は `ACCESS_JWT_MODE=enforce` のため、認証済み API の自動実行はできません（Access の JWT が必要）。
  このため「別アカウント承認が成立する」ことは、**同一コード・同一設定の検証インスタンス**で実測しています。
- 同日 09:25 に検証インスタンス停止時の `pkill` が本番 API にも一致し、約 20 秒停止しました（復旧済み・
  詳細と再発防止は `docs/56 §4`）。
