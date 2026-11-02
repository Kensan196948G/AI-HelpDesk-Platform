# リリース候補の検証（2026-11-02、コード `82008f2`）

実データはこの文書と JSON に書かない。**出力は件数とハッシュの一致だけ**である。

## migration と復元（隔離 DB、確認の後に削除）

| 確認 | 結果 |
|---|---|
| dump | 2026-11-02 02:32 の日次バックアップ（221,507 バイト）。PG16 の `pg_restore --no-owner --no-privileges` |
| 復元の直後 | migration 25 件、26 テーブル。`knowledge` 9、`knowledge_reviews` 0、`case_handovers` 3、`device_commands` 2（done）、`resolution_sessions` 3（`waiting_execute` 1、`escalated` 1、`stopped` 1）、`audit_log` 79 |
| 候補で migrate | 026〜037 を適用（1.2 秒）。37 件 |
| 再実行 | 全件 skip |
| 26 テーブルの照合 | 元の列の全行ハッシュが、`schema_migrations` を除きすべて一致 |
| 旧アプリ `98f80ec` の試験（候補のスキーマ、空の DB） | 530 件すべて成功 |
| 旧アプリ、候補の起動（復元コピー、AUTH_MODE=local、外部接続の設定なし） | health 200、DB ok。`column/relation does not exist` のログ 0 件 |
| KB の件数（READ ONLY） | 承認済み 9、使える 9、すべて seed、`usableSharedIdentity` 0、自己承認 0、端末情報 0、指紋なし 9 |

## 試験

| 項目 | SHA | 結果 |
|---|---|---|
| vitest | `82008f2` | 1577 件成功 |
| `folder-helper.tests.ps1` | `f008f2c` | 428 成功 |
| `command-agent.tests.ps1` | `d7e1598` | 217 成功、失敗 0、SKIP 8（Windows 実機が要るもの。実機で 17 件成功） |
| 通し E2E（スタブ AI、模擬の実行器） | `82008f2` | 88 項目、失敗 0（`e2e-dataflow.json`） |
| wizard E2E（本番モードを含む） | `82008f2` | 65 項目、失敗 0（`e2e-wizard.json`） |
| command-agent E2E（本番モードを含む） | `82008f2` | 16 項目、失敗 0（`e2e-command-agent.json`） |
| CI（secret scan、audit 2 種、migrate 2 回、test、build、pwsh） | `82008f2` | [成功](https://github.com/Kensan196948G/AI-HelpDesk-Platform/actions/runs/41390813892) |
| `npm audit --audit-level=high`、`scan-secrets.sh` | `2d5b409` | 0 件、検出なし |

`npm audit` と `scan-secrets.sh` のローカル実行は `2d5b409`。`82008f2` では CI の同じ手順が成功している。

## 実機（`2d5b409`。候補との差は設定の判定、`device-status` の応答項目、画面の文言と CSS で、実機は流し直していない。`../real-chain-20261102/resend-2d5b409.json`）

Windows 1 台、PowerShell 5.1、非昇格、実 DeepSeek、AUTH_MODE=local。Y は条件付きの事前承認で、提案を機械照合してから押した。

| 確認 | 結果 |
|---|---|
| 画面が無いときの結果の取り込み | 63 秒で done |
| 報告を 503 → エージェントを再起動 → 結果だけ届く | 結果は `done`、`Running`。コマンドは増えない。ステップは期限切れで `failed` のまま（成功へ変えない） |
| サーバの拒否と同じ 409 | 端末のログに `report rejected RESULT_CONFLICT`。報告は 1 回だけ |
| ACL | 1 件、継承なし。SYSTEM からは一覧できない |
| 同一性の試験 | 17 件成功 |

**開示**
- 再起動の 1 回目は、私の起動スクリプトの安全弁（設定があれば中止）で失敗した。追加の Y を得て、起動スクリプトを差し替えてやり直した。修正の欠陥ではない。
- 後片付けの 1 回目は、RSP が危険なコマンド（`takeown`、`icacls`）として拒否した（`DANGEROUS_BLOCKED`）。迂回せず、保存先は本人のタスクで消す方法へ変えた。
- 端末からタスク、エージェント、設定、保存した結果、ログ、検証フォルダが消えたことを確認した。検証 DB、トンネルも削除した。
- RSP の `command_logs` には導入コマンドが残る。デバイストークンは含まない。1 回限りの取得キーと一時トンネルの URL は含むが、どちらも失効している。

**このセッションのログへ出たもの（証跡とリポジトリには無い）:** `.env.test.local` のテスト用の値、`RESOLVE_ADMIN_ALLOWLIST` の実メールアドレス 4 件。
