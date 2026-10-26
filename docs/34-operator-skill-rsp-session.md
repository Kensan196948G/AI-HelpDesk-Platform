# 担当者承認のSkill実行とRSP都度セッション（設計）

| 項目 | 値 |
|---|---|
| 版 | v0.1（設計。実装は次フェーズ） |
| 対象 | 引継ぎワークスペース（3ペイン） |
| 決定 | Y/N の主体は**ヘルプデスク対応担当者**。任意PowerShellの生成は行わない |
| 関連 | [25-skill-resolution-loop.md](25-skill-resolution-loop.md) / [30-solution-loop-measurement.md](30-solution-loop-measurement.md) / [22-remote-assist-handover.md](22-remote-assist-handover.md) / [33-handover-workspace.md](33-handover-workspace.md) |

## 1. 目的

引継ぎ後の担当者が、承認済みSkillをAIに選ばせ、**実際のPowerShellを確認してY/N**し、
対象PCで実行・verify・監査まで閉じられるようにする。あわせて、RSPのターミナルを
「常時ログイン」ではなく**ケースに紐づく都度セッション**として扱う。

## 2. 現状（事実）

- 解決ループ（`/api/resolve/*`）は存在する。Skillは16件、AIは `skillId + params` のみを返し、
  サーバが承認済みテンプレートからコマンドを組み立てる。承認ハッシュは5分・nonce付き。
- ただし `POST /resolve/sessions` は **ログイン本人の案件・端末**（`ownsDevice` /
  `findOwnedCase`）を要求する。担当者（Bさん）は依頼者（Aさん）の端末を所有しないため、
  そのままでは担当者承認のセッションを作れない。
- 端末実行は `device_commands` と端末エージェント。`device_commands.user_email` は依頼者。
- 遠隔支援は「依頼→承認→案内」で、RSP/MeshCentralのターミナルをアプリ内に埋め込んではいない。
  RSPへのログイン状態をアプリが確認・制御する仕組みもない。
- 3ペイン画面には、AI質問（`/ai/answer-case` / `/ai/answer`）とプロンプト表示までを実装済み。
  Skillの提案・実行UIは未接続。

## 3. 担当者承認のSkill実行（設計）

### 3-1. 方針

1. **AIはコマンド文字列を生成しない。** `skillId + 型付きパラメータ` だけを返す。
2. サーバが承認済みSkillのテンプレートから**表示用のPowerShell**を組み立てる。
   実行も同じテンプレート・引数配列を使う（表示と実行を一致させる）。
3. 実行前に担当者がY/N。承認ハッシュは**依頼者・担当者・案件・端末・Skill・版・
   パラメータ・nonce・期限**に束縛する。5分で失効、再利用不可。
4. 端末がオフラインなら実行しない。verify（サーバ評価）と監査を必須にする。
5. まず**読み取り専用Skill（risk 1）**でPoC。修復系は別フェーズ。
   リスク4以上は従来どおりIT管理者の別承認を必須とし、担当者の自己承認で通さない。

### 3-2. セッションの委任

`resolution_sessions` に次の列を追加する（additive migration）。

| 列 | 内容 |
|---|---|
| `delegated_by` | 承認する担当者のメール（通常セッションはNULL） |
| `handover_id` | 紐づく `case_handovers.id` |
| `requester_email` | 端末・案件の所有者（`user_email` と同一。将来の分離用） |

- セッションの `user_email` は**依頼者**（端末所有者）のまま。`delegated_by` が担当者。
- 担当者は、`case_handovers.claimed_by = 自分` かつ status が `claimed` の案件に限り、
  セッションの作成・承認・照会を行える。
- 案件が `resolved` / `cancelled` / 期限切れになったら、委任セッションを停止する。
- 端末は依頼者の `device_id`。スナップショット/依頼者の状態から引き、**担当者の端末とは混ぜない**。

### 3-3. API契約（案）

| メソッド | パス | 内容 |
|---|---|---|
| POST | `/api/handover/:handoverId/resolve/sessions` | 担当者が委任セッションを作成。AIが最初のSkillを提案 |
| POST | `/api/resolve/steps/:id/approve` | Y/N。委任セッションは `delegated_by` の担当者のみ承認可 |
| POST | `/api/resolve/steps/:id/continue` | 結果後の継続Y/N |
| GET | `/api/resolve/sessions/:id` | 状態・結果・verify。依頼者または担当者が参照可 |
| POST | `/api/resolve/sessions/:id/stop` | 担当者または依頼者が停止 |

承認ハッシュのpayloadは通常セッションと分け、`delegatedBy` と `requesterEmail` を含める。
通常セッションのハッシュ形式は変えない（後方互換）。

### 3-4. 表示と実行

- `stepDto` に `commandPreview` を追加する。内容は
  `powershell -NoProfile -ExecutionPolicy Bypass -File <scriptPath> <args>`。
  パラメータは**表示用にシェル連結しない**（エスケープした引数配列を表示）。
- 画面には Skill名・版・risk・パラメータ・**PowerShell全文**・verify・戻し方・対象端末を表示。
- Y/Nは担当者。Yで承認ハッシュを保存し、`device_commands` に依頼者のメール・端末で登録。
- 実行結果はPIIマスク・長さ制限の上で表示。verifyはサーバが評価する。
- 監査: 提案・承認・実行・結果・verify・停止を、依頼者・担当者・案件ID付きで記録。

### 3-5. 受け入れ条件（読み取りPoC）

- 担当者以外は委任セッションを作成・承認できない
- 他人のhandover、未claim、停止済み案件では403/404
- 承認ハッシュの改変・期限切れ・再利用が拒否される
- 端末オフラインで実行されない
- PowerShell表示と実行引数が一致する
- 実行結果・verify・監査が案件に紐づく
- 担当者がY/Nしたことが監査から追える

## 4. RSP都度セッション（設計）

### 4-1. 方針

**常時ログインをやめ、ケースに紐づく都度セッション**にする。PC側はRSPエージェントが
待機していてよいが、ターミナルは未接続・ロック状態とし、claim＋本人同意で開く。

### 4-2. 状態

| 状態 | 意味 | 遷移 |
|---|---|---|
| `none` | RSP未導入/オフライン | → `ready`（agent疎通） |
| `ready` | 接続可能。ターミナルは未接続 | → `active`（claim＋同意） |
| `active` | ケースに紐づくセッション中 | → `closed`（解決/停止/TTL） |
| `closed` | 終了。再接続は新しいセッション | — |

- セッションは `case_id` / `handover_id` / `device_id` / `operator_email` / `consent_at` /
  `expires_at` を持つ。
- TTLは30分を初期値。解決・担当変更・停止・TTLで自動切断。
- 同意は「画面共有」「操作支援」を別々に記録。ターミナル操作は「操作支援」に含める。
- 端末ログ・接続元・開始/終了・操作者を監査に残す。共有資格情報は使わない。

### 4-3. PoCの範囲

- RSPの実セッションAPI/資格情報が未確定のため、まず**モックアダプタ**で状態機械・
  同意・TTL・監査・UIを検証する。
- 実RSP接続は、RSP側のセッション作成/終了API、認証方式、端末側エージェントの
  状態取得が確認できてから接続する。
- UIはチケットに「RSP: 待機/接続可能/接続中/終了」と残り時間を表示し、
  「セッションを開く」で外部ターミナルを開く（アプリ内埋め込みは別途）。

### 4-4. 状態機械PoC（モック・検証済み）

実RSPには接続せず、状態・同意・TTL・監査の契約だけを検証した。

```bash
node scripts/poc/rsp-session-state.mjs
```

| 検証 | 結果 |
|---|---|
| 初期状態は `none`（常時ログインしない） | ✅ |
| agent 疎通で `ready`。claim 前は開けない | ✅ |
| claim + 同意で `active`。担当者以外は開けない | ✅ |
| 同意なしでは `active` にしない | ✅ |
| TTL 経過で自動 `closed` | ✅ |
| 解決で `closed`。監査に claim/同意/開始/終了が残る | ✅ |

実RSPのセッション作成/終了API・認証・端末側状態取得は未確認のため、
モックとの差し替えポイントを `RspSession` クラスに閉じている。

## 5. フェーズ

| フェーズ | 内容 | 状態 |
|---|---|---|
| 1 | プロンプト表示・コピー | **実装済み** |
| 2 | 読み取り専用Skillの委任セッション（API/DB/UI/テスト） | 次に実装 |
| 3 | 修復Skill（risk 2〜3）とverify/rollbackの実機確認 | フェーズ2の後 |
| 4 | RSP都度セッションのモックPoC（状態・同意・TTL・監査） | フェーズ2と並行可 |
| 5 | RSP実接続（API/資格情報の確認後） | 未定 |

## 6. 未決事項

1. 依頼者本人の同意をどこで取るか（handover同意で足りるか、実行ごとに再同意か）。
2. リスク4以上の管理者承認と担当者承認の順序・画面。
3. RSPの実API・認証・端末エージェントの状態取得方法。
4. 端末ログの保存範囲・マスキング・保存期間。
5. 担当者が複数いる場合の同時セッションの排他。
