# 証跡の秘匿化レポート — verify-20261027

> 実施: 2026-10-27 09:47〜09:55 JST（Asia/Tokyo）
> 担当: hygiene（独立レビュー `review/independent-review.md` §A-5 / C-10 の指摘対応）
> 対象: `docs/evidence/verify-20261027/` 配下（`review/` を除く）
> 制約: 判定・実測値・HTTP コード・件数・ケース ID・行番号・ファイル名は変更しない。git 操作・コード変更・本番 DB 操作は行っていない。

本レポートには**置換前の実値は記載しない**（実値はすべて証跡から除去済み。作業用バックアップも削除済み）。

---

## 1. 置換方針

| 種別 | 置換後 | 例（伏せ字後の形） |
|---|---|---|
| 実メール（owner の Gmail） | 役割表記 | `owner@***` |
| Cloudflare `CF_AppSession` Cookie 実値 | `<redacted>` | `CF_AppSession=<redacted>` |
| 署名付き meta JWT | `<redacted>` | `meta=<redacted>` |
| 実在氏名（DX 名簿の 5 名） | 役割ラベル（社員番号は保持） | `DX1 MK1073` 〜 `DX5 MK0952` |
| 実在氏名（社員番号の対応が取れないもの・姓のみ） | `***` | `承認者 ***` |
| hostname / OS アカウント名 | `<user>` | `"hostname":"<user>"`、`/home/<user>/...` |

補足:

- 氏名 → `DX1`〜`DX5` は `handover/C-results.md` の DX 5 名（社員番号順）に対応する。**氏名とラベルの対応表は本レポートに書かない**（実値の再掲になるため）。社員番号 `MK####` は識別子として元のまま保持した。
- 社員番号の対応が取れない氏名（姓のみ 3 名・フルネーム 2 名）は `***` に統一した。判定・表示内容の区別は、同一行内の社員番号・役割語（申請者/承認者/担当）で維持される。
- hostname の指示対象は 3 本の `.log`（27 箇所）。加えて、`deploy/` 配下の生ログ・`/proc` 出力・コマンド例に含まれる **`/home/<user>` 形式の OS アカウント名（34 箇所）** と **`ls -l` の所有者/グループ表記（2 箇所）** も、同一人物を識別できるため併せて `<user>` に置換した（指示の「hostname 内のアカウント名」の趣旨に沿う拡張。パス構造・コマンド・実測値は不変）。

---

## 2. 置換一覧（ファイル別・件数）

| ファイル | 種別 | 件数 |
|---|---|---|
| `access/A-01-headers.txt` | 資格情報（`CF_AppSession` / meta JWT） | 2 |
| `handover/C-results.md` | 氏名（DX 5 名 ＋ フルネーム 1） | 6 |
| `handover/D-findings.md` | 実メール 1 / 氏名 1 | 2 |
| `kb/E-results.md` | 氏名 2（申請者・actor 切替先） | 2 |
| `report/F-results.md` | 氏名 1（承認者） | 1 |
| `report/raw/ui-flow.txt` | 氏名 2（承認者・デモ俳優） | 2 |
| `report/raw/report-content-checks.txt` | 氏名 2（承認者・担当） | 2 |
| `step1-3/B-results.md` | 氏名 1（ログイン本人） | 1 |
| `platform/raw/g01-audit.txt` | 氏名 6（監査 actor。seed 由来の合成名だが実名と区別不能のため伏せ字） | 6 |
| `platform/G-results.md` | アカウント名 1 / 氏名 1（自己確認の記述内） | 2 |
| `deploy/H-results.md` | 実メール 1 / アカウント名（パス） 8 | 9 |
| `deploy/raw/H01-deployment-facts.txt` | アカウント名（パス 8 ＋ 所有者/グループ 2） | 10 |
| `deploy/raw/H01-diff-running.txt` | アカウント名（パス） | 10 |
| `deploy/raw/H01-dist-digests.txt` | アカウント名（パス） | 1 |
| `deploy/raw/H01-feature-tokens.txt` | アカウント名（パス） | 5 |
| `deploy/raw/H03-commit-sha-wiring.txt` | アカウント名（パス） | 2 |
| `deploy/raw/H03-mislabel-demo.log` | hostname | 7 |
| `deploy/raw/H04-run-new.log` | hostname | 11 |
| `deploy/raw/H04-run-rollback.log` | hostname | 9 |
| **合計（19 ファイル）** | | **90** |

種別合計:

| 種別 | 件数 |
|---|---|
| 実メール | 2 |
| 資格情報（Cookie / JWT） | 2 |
| 実在氏名 | 22 |
| アカウント名（hostname / パス / 所有者） | 64 |
| **合計** | **90** |

---

## 3. 機械確認（秘匿化後）

実行ディレクトリ: `docs/evidence/verify-20261027/`。`review/`（他担当が書込み中）は対象外。

| # | 確認対象 | コマンド | 結果 |
|---|---|---|---|
| V1 | 実 Gmail | `grep -rInE "@gmail\.com" --exclude-dir=review .` | **0 件** |
| V1b | 実名簿ドメインの実アドレス（`@mirai-const.co.jp` の伏せ字でない localpart） | `grep -rInE "[A-Za-z0-9._%+-]+@mirai-const\.co\.jp" --exclude-dir=review .` | **0 件**（既存の伏せ字 `k-***@mirai-const.co.jp` は保持） |
| V2 | JWT（`eyJ` で始まる署名付きトークン） | `grep -rInE "eyJ[A-Za-z0-9_-]{4,}\." --exclude-dir=review .` | **0 件** |
| V3 | `CF_AppSession=` / `CF_Authorization=` の実値 | `grep -rInE "CF_AppSession=[0-9a-fA-F]{8,}\|CF_Authorization=[A-Za-z0-9]{8,}" --exclude-dir=review .` | **0 件** |
| V4 | 抽出した実名リスト（氏名・姓の計 11 語。**実名は本レポートに記載しない**） | `printf '%s\n' … > /tmp/hygiene-names.txt && grep -rInF -f /tmp/hygiene-names.txt --exclude-dir=review .` | **0 件** |
| V5 | owner のアカウント名（hostname 形・メール localpart 形の 2 語。**実値は本レポートに記載しない**） | `printf '%s\n' … > /tmp/hygiene-accounts.txt && grep -rInF -f /tmp/hygiene-accounts.txt --exclude-dir=review .` | **0 件** |
| V6 | API キー・秘密鍵 | `grep -rInE "sk-[A-Za-z0-9]{10,}\|ghp_[A-Za-z0-9]{10,}\|xox[b]-\|AK[I]A[0-9A-Z]{16}\|BEGIN (RSA \|EC \|OPENSSH )?PRIVATE KEY" --exclude-dir=review .` | **0 件** |
| V7 | DB 接続文字列の実値 | `grep -rInE "postgres(ql)?://[^.\"' ]" --exclude-dir=review .` | **0 件** |

補足（V3）: `CF_AppSession` の**属性**（`Expires` / `Path` / `Secure` / `HttpOnly`）は A-05 の実測対象のため保持し、値だけを `<redacted>` にした。`CF_Authorization` は証跡に実値が存在しなかった（属性の記載のみ）。

補足（V6）: 本レポート自身が検出パターンに一致して V6 が 1 件になるのを避けるため、Slack・AWS のトークン接頭辞だけは文字クラス表記（`xox[b]-`・`AK[I]A`）で記載した。実際の確認は接頭辞を直接指定して実行し、**0 件**だった。

補足（V4/V5）: パターンファイル `/tmp/hygiene-names.txt` / `/tmp/hygiene-accounts.txt` は実値を含むため実行後に削除した。再現には置換前の証跡が必要だが、本作業で実値は証跡に残っていない。

---

## 4. 証跡の意味が壊れていないことの確認

| 確認 | 方法 | 結果 |
|---|---|---|
| 行数・行番号の不変 | 置換対象の全 68 ファイル（`review/` と本レポートを除く）で置換前後の行数を比較 | **全ファイルで一致**（行の追加・削除 0） |
| 判定の不変 | `PASS` / `FAIL` の出現数を置換前後で比較 | PASS 90→90、FAIL 28→28（一致） |
| HTTP コード・件数の不変 | `200/400/401/403/404/409/429` の出現数を比較 | すべて一致（150/18/25/46/20/14/2） |
| ケース ID・識別子の不変 | `CASE-` / `INC-` / `TKT-` / `KB-` の出現数を比較 | 69/6/3/32（すべて一致） |
| 社員番号の保持 | `MK0` の出現数 | 26→27（`kb/E-results.md` の「申請者=氏名」を社員番号 `MK0623` に置換した +1 のみ。他は不変） |
| 変更範囲 | 置換前バックアップとの行差分 | 変更 19 ファイル / 77 行。すべて §2 の値置換のみ |

---

## 5. 除外・据え置きの判断

| 項目 | 判断 |
|---|---|
| `review/` ディレクトリ | 他担当が書込み中のため**未変更**（本作業時点で `<redacted>` / `<user>` / アカウント名 / Gmail の混入 0 を確認） |
| `.gitignore` 対象の `.log`（`deploy/raw/*.log`） | git 管理外だがワークスペースに残るため、指示どおり**秘匿化を実施**（hostname 27 箇所） |
| 合成 PII（`example.com` / `090-….` / `192.168….` / `10.20.30.40` 等） | 意図的な検証データであり、`step1-3/B8-B14-results.md` に合成である旨の記載があるため**保持** |
| Cloudflare `kid=`（Access アプリの公開鍵識別子）・NEL 報告 URL の `s=` | 個人識別情報ではなく、単体で資源アクセス権限を与えないため**保持**（値は `<redacted>` にしない） |
| `platform/G-results.md` §6 の自己確認記述 | 記述中のアカウント名・氏名のみ伏せ字化。**主張・判定は変更していない**。レビュー C-10 の「自己確認が不成立」という指摘は、本レポート §3 の再 grep（対象を `deploy/`・自ファイル含む全体に拡大）で充足した |
| 氏名が seed 由来の合成データ（`platform/raw/g01-audit.txt` の監査 actor 等） | 実在の個人と区別できないため伏せ字化。seed 定義（`scripts/seed.ts`）に同名があるものは合成名だが、それでも実名と区別できないため伏せ字化した |

---

## 6. 申し送り

1. **値の除去であって、値の無効化ではない**。meta JWT は有効 5 分・`CF_AppSession` は 12 時間（レビュー §A-5 の記載）。証跡からは消えたが、当該セッションを再利用する必要がある場合は再取得すること。
2. **作業用バックアップは削除済み**（`/tmp/hygiene-backup` と置換スクリプトを削除）。実値が残るコピーはワークスペース内に存在しない。
3. 証跡はレビュー §A-5 の時点で **git untracked**（`?? docs/evidence/verify-20261027/`）。コミット前に、`review/` の確定後に同ディレクトリ全体へ §3 の grep を再実行することを推奨（`review/` を書いている担当の成果物に実値が入る可能性があるため）。
4. 本レポート自体も証跡ディレクトリに含まれるため、§3 の確認対象に含まれている（実値を含まない）。
