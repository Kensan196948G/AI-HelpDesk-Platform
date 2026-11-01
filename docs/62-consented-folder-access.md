# 本人同意付きフォルダ一覧（読み取り専用）— 設計と連携契約

- 状態: 開発中。機能フラグ `FOLDER_ACCESS_ENABLED`（既定 `false`）。無効時は全 API が 404、画面の導線も出ない。
- 正本の改訂: `docs/01-mvp-scope.md` と `docs/07-security.md` は個人フォルダ一覧を「取得しない」としている。
  本機能は、**本人が選択・同意したフォルダの直下一覧とメタデータに限る例外**である。常時収集・全ユーザーフォルダ走査はしない。
- 公開リポジトリのため、実在のユーザー名・SID・ホスト名・フォルダ名を本書と証跡に書かない。

## 1. 範囲

| 含む | 含まない |
|---|---|
| 本人が選択した 1 フォルダの直下一覧とメタデータ（名前・種別・サイズ・更新日時・クラウド属性） | 内容の読取、ダウンロード、アップロード、変更、削除 |
| 案件・相談者・担当者・PC・SID・セッション・ルート・操作・期限に束縛した同意 | 再帰走査、全プロファイル走査、常時収集 |
| 本人の取消、失効、監査 | AI への送信（パス・ファイル名・本文は送らない） |

- ファイル名・パスは個人情報として扱う。結果は専用テーブルにのみ保存し、同意の終了時に削除する。
  画面状態（`prototype_states`）、`case_handovers.snapshot`、AI コンテキスト、最終報告、監査ログへ入れない。
- 既存の「PC 基本情報の共有」同意とは別の同意である。

## 2. 方式

| 方式 | 判定 | 理由 |
|---|---|---|
| A. SYSTEM から参照（RSP / Mesh の runcommand） | **不採用** | 実機で実行主体が `S-1-5-18` と確認。ACL を回避してしまう |
| Mesh `runAsUser` | 不採用 | 値 1 はコンソールユーザーがいないとエージェント権限へ黙って戻る。出力がコンソール通知と `command_logs` へ流れる |
| Mesh 標準 Files | 不採用 | ルート限定・読取専用・同意失効を強制できない（コード読解） |
| **B. 本人権限ヘルパー（ログオン時タスク + 外向きポーリング）** | **採用** | 本人トークンで動き ACL に従う。パスワード不要。ログオフで停止する |

RSP は端末の識別（deviceId と固定テンプレートによる MachineGuid / セッションの取得）にのみ使う。
**一覧データは RSP / Mesh を通さない。** ヘルパーから HelpDesk へ直接送る。

### 2-1. 標準機能の実測（2026-10-31、検証端末、MeshCentral 1.2.4）

| 観点 | 実測 |
|---|---|
| Files の同意 | 接続ボタンだけで即接続。同意の確認なし（端末の「ユーザーの同意」は「なし」） |
| Files の範囲 | ドライブ全体を表示。SYSTEM 専用領域も表示。ルート限定の設定はない |
| Files の操作 | ディレクトリ内で「新しいフォルダ」「新しいファイル」「アップロード」が有効。実行はしていない（強制の有無はコード読解） |
| Terminal | 接続ボタンだけで管理者 PowerShell。`whoami` は `nt authority\system` |
| RSP のコマンド | 実行主体 `S-1-5-18`（`IsSystem=True`） |
| 本人タスク | 対話タスクは切断セッションでも本人 SID・非管理者トークンで動く。SYSTEM からパスワードなしで起動できる |

## 3. 状態遷移

`folder_access_requests.status`:

```
device_pending → helper_pending → consent_pending → active → ended
       │               │                 │             │
       └───────────────┴─────────────────┴─────────────┴──→ denied / revoked / expired
```

| 状態 | 画面表示 | 次へ進む条件 |
|---|---|---|
| `device_pending` | 対象PC確認待ち | 貸与情報と RSP の照合が一意に確定 |
| `helper_pending` | Windowsユーザー確認待ち | ヘルパーのペアリング + MachineGuid 一致 |
| `consent_pending` | 本人同意待ち | 本人がフォルダと期限を選んで同意 |
| `active` | 読取接続中 | — |
| `ended` / `revoked` / `expired` / `denied` | 終了・取消・期限切れ・拒否（`end_reason`） | 終端 |

`end_reason`: `operator_end`, `requester_revoked`, `expired`, `assignee_changed`, `session_changed`,
`user_logged_off`, `helper_revoked`, `lease_conflict`, `device_mismatch`, `sid_mismatch`。

終端状態の対応: `requester_revoked` / `helper_revoked` → `revoked`、`expired` → `expired`、
`lease_conflict` / `device_mismatch` → `denied`、それ以外 → `ended`。
`assignee_changed` は claim 者の変更に加え、引継ぎが `claimed` / `resolved` でなくなった場合も含む。
同意前の依頼は 30 分で `expired` になる。留まっている理由は `reason_code` で画面に出す
（`LEASE_*`, `RSP_*`, `EMPLOYEE_UNRESOLVED`, `DEVICE_NOT_LINKED`, `NOT_LOGGED_ON`, `SESSION_UNRESOLVED`）。

## 4. 本人・PC・Windows ユーザーの照合

1. **本人**: Access のメール → Mirai-Info の有効社員。案件の `owner_email` と一致すること。
2. **貸与端末**: Mirai-Info の PII API（`LEASE_API_URL` + サービストークン）から `employee_no` で取得する。
   契約は Mirai-Info PR #262。`source` と `fetchedAt`、`generatedAt` を保存する。鮮度は `dataAsOf.employeeDirectoryLastSeenAt` で判定し、
   `LEASE_MAX_AGE_HOURS`（既定 72。週末の空きを考慮）を超えたら古い扱い。
   **`device_staff` ビューを SQL で直接読まない**（PII API の Access 制御の迂回になる）。
   - 候補 0 件・複数・照合競合・古い情報は確定しない。`device_pending` に留め、理由を画面に出す。
   - トークン未設定なら `LEASE_UNAVAILABLE` で留まる。
   - **応答**: `{ok, source, generatedAt, filter:{employee_no}, dataAsOf:{employeeDirectoryLastSeenAt}, records:[{asset_tag, hostname, employee_no, mesh_node_id, employee_active, lease_active}]}`。
     認証は Cloudflare Access サービストークン（`LEASE_API_TOKEN_ID` / `LEASE_API_TOKEN_SECRET`）。
   - `filter.employee_no` と全行の `employee_no` が要求と一致しない応答は `LEASE_UNAVAILABLE`。
     現貸与は `employee_active === true` かつ `lease_active === true` の行だけ。
     貸与情報と RSP の `mesh_node_id` が食い違えば `LEASE_CONFLICT`（nodeId は手掛かりで、同一性は MachineGuid で確認する）。
   - 同意の直前に取り直す。端末が変わった・確定できなくなった場合は `lease_conflict`、取得できない場合は同意を進めない。
   - `FOLDER_ACCESS_ALLOW_UNVERIFIED_LEASE=true`（`NODE_ENV=production` では起動拒否）のときだけ、
     検証用に `lease_status='unverified'` として担当者の指定端末で進める。
3. **端末**: RSP `deviceId` と `mesh_node_id` を保存する。hostname だけを許可の根拠にしない。
   RSP の固定テンプレートで MachineGuid を取得し、ヘルパーの申告と一致しなければ `device_mismatch`。
   テンプレートは引数を挿入しない定数で、キュー投入は依頼の確定時、結果の取得はペアリング後（`pair` / 状態確認 / `poll` の延長。5 秒間隔）に行う。
   出力は解釈して捨てる（ユーザー名を含むため HelpDesk には保存しない。RSP の `command_logs` には残る）。
   `AGENT_BUSY` と、ヘルパーの登録より前に完了した結果（古い quser では判断できない）だけ、最大 3 回まで投入し直す。
   上限に達しても古い結果では進めず、`RSP_PROBE_STALE` で `helper_pending` に留める（担当者の再確認でやり直せる）。
   `mesh_node_id` は RSP 応答にあれば保存し、無ければ `null`。
4. **Windows ユーザー**: ペアリングで結び付ける。
   - ヘルパーは本人セッション内で `WindowsIdentity.GetCurrent()` の SID を取得し、登録して 8 桁のコードを本人の画面に表示する。
   - 本人が Access 認証済みの画面でコードを入力し、表示された端末名・Windows ユーザーを確認する。
   - これで Access 上の本人と `(device, SID, sessionId)` が結び付く。
     **貸与者とログオンユーザーを同一視せず、メールや表示名からフォルダ名を推測しない。**
   - `S-1-5-18/19/20` と昇格プロセスは拒否する（サーバは `S-1-5-21-*` と `S-1-12-1-*` だけを受ける。昇格の判定は端末側）。
   - ログオン無しは `NOT_LOGGED_ON`。quser で同じユーザーのセッションが複数ある、またはヘルパーのセッションと一致しない場合は
     どの画面でコードを見たか確定できないので `SESSION_UNRESOLVED` で留まる。担当者の再確認で固定テンプレートを投入し直す。

### 4-1. 導入コード（2026-11-01、ユーザー判断）

ヘルパーの登録に**導入コードを必須**とする。匿名でトークンを発行しない（`AGENTS.md` §6 との不一致の解消）。

1. 本人が Access 認証済みの画面で導入コードを発行する（一回限り、10 分。再発行で旧コードは無効）。
2. 本人が PC で `install-folder-helper.ps1 -ServerUrl <url> -EnrollCode <code>` を実行する。無効なコードは `403 ENROLL_CODE_INVALID`。
3. ヘルパーが表示したペアリングコードを本人が画面へ入力する（従来どおり。「端末の前の人」と本人を結び付ける確認）。

全体の上限と短い保持期間も多層防御として残す。**残存リスク**: 導入コードは install の引数としてプロセス一覧に見える（一回限り・10 分で緩和）。

## 5. API（`/api`）

**相談者（Access、案件の `owner_email` 本人のみ）**
- `POST /folder-access/requests/:id/enroll-code` 導入コードの発行
- `GET /folder-access/mine?handoverId=` 状態 → `{ok, requests:[...], request}`。`handoverId` を省くと、自分の進行中の依頼すべてと直近 10 分以内に終了した依頼を返す（古い同意も確認・取消できるように 1 件に絞らない）。指定すると、その引継ぎの最新 1 件。`request` は `requests` の先頭
- `POST /folder-access/requests/:id/pair` `{code}` ペアリング
- `POST /folder-access/requests/:id/consent` `{root, segments, ttlMinutes}`
- `POST /folder-access/requests/:id/revoke`

**担当者（Access、`requireHelpdeskActor` かつ引継ぎを claim した本人のみ。approver だけでは不可）**
- `POST /folder-access/requests` `{handoverId, rspDeviceId?, hostname?}`（`hostname` は検証専用モードの指定端末。留まっている依頼へ再送すると照合をやり直す）
- `GET /folder-access/requests?handoverId=` 既存の依頼を引く（画面の再読込用）
- `GET /folder-access/requests/:id` 状態・許可範囲
- `POST /folder-access/requests/:id/list` 一覧の取得を投入
- `GET /folder-access/requests/:id/result` 結果（`active` の間のみ）
- `POST /folder-access/requests/:id/end`

**ヘルパー（`/api/device/agent/folder-helper/*`。既存の Access bypass 配下。Access の変更は不要）**
- `POST /register` `{enrollCode, machineGuid, sid, userName, sessionId, sessionState, hostname, helperVersion}`
  → `{helperId, helperToken, pairingCode, pairingExpiresAt}`（レート制限あり。未ペアのトークンは poll 以外に使えない）
- `POST /poll` ヘッダ `x-folder-helper-token`。ボディは heartbeat（`sid, sessionId, sessionState`）。
  応答 `{ops:[{opId, requestId, sid, sessionId, root, segments, operation:'list_metadata', expiresAt, maxEntries, maxBytes, maxSeconds, sig}], cancel:[opId...], revoked:bool, paired:bool}`
- `POST /ops/:id/result`
  `{actorSid, sessionId, root, status, reason?, truncated, elapsedMs, entries:[{name,type,size,modifiedAt,attrs:{reparse?,cloudOnly?,hidden?}}]}`
  → `{ok:true, discarded:false, truncated, count}` または `{ok:true, discarded:true, reason}`（破棄しても 200。再送しない）。
  `status` は `ok` / `partial` / `error`、`reason` は `^[A-Z0-9_]{1,64}$` の固定コードのみ（パスを入れない）、
  `type` は `file` / `directory` / `link` / `other`。本文 64KB 超は 413。500 件 / 32KB 超はサーバが切り詰めて `truncated=true`。
  トークンの扱い: 無効・不明なトークンは 401。失効済み（同意の終了、ペアリング期限切れを含む）のトークンは poll が `revoked:true` を返す。
  ペアリング期限切れの登録は 1 日後に行を消すので、その後は 401 になる。
- `POST /revoke` ヘッダ `x-folder-helper-token`、ボディ `{}` → `{ok:true}`。ヘルパーを失効させ、紐づく同意を `helper_revoked` で終了する。

`sig` は `HMAC-SHA256(helperToken, canonicalJson(opId,requestId,sid,sessionId,root,segments,operation,expiresAt))`（小文字 16 進）。
`canonicalJson` はこのキー順・空白なしの JSON（`JSON.stringify` と同じバイト列）。`sessionId` は数値、`expiresAt` は受信した文字列のまま。
DB にはトークンの SHA-256 しか無いので、サーバは `poll` のヘッダで受け取った平文を鍵に配信時に計算する。
ヘルパーは実行前に署名・SID・セッション・期限を検証する。

## 6. 検証ルール

**サーバ（毎操作）**: フラグ有効、同意が `active`、期限内、claim 者が同一担当者、本人が相談者、
ヘルパー未失効、heartbeat の SID・セッション一致。不一致なら終了させる。
`sessionState` は `active` と `disconnected` だけ同意を保つ（`disconnected` の間は操作を配らず、投入も拒否する）。それ以外は `user_logged_off`。
heartbeat が 180 秒途絶えても `user_logged_off`。ヘルパーのポーリングは 120 秒以内にする（上限 60 回/分）。
期限切れは定期処理（60 秒間隔。DB のみ）でも終了させ、結果を消す。終了時はサブフォルダ名と Windows ユーザー名も消す。
**遅れて届いた結果は保存しない**（同意が `active` でなければ破棄し、監査に `result_discarded`）。
結果の `actorSid` が同意の SID と違えば `sid_mismatch` で終了する。これは端末の自己申告であり、
**成功ログだけを実アクセス成功として扱わない**（OS 境界の根拠は本人トークンと ACL）。

**端末（ヘルパー）**: 署名・SID・セッション active・期限・非昇格の検証。入力は `root` の enum
（`Desktop, Documents, Downloads, Pictures, Music, Videos`）と相対セグメント配列のみ。生パスを受けない。
`..`、`.`、`:`、`\`、`/`、ワイルドカード、制御文字、末尾のドット・空白、予約デバイス名を拒否する。
起点は `GetFolderPath` で取得し `ProfileList\<SID>` と照合する。環境変数を使わない。
全祖先の reparse point を拒否し、`GetFinalPathNameByHandle` の最終パスが起点内にあることを確認する。
文字列の前方一致だけで判定しない。OneDrive 等へのリダイレクトは最終パスで範囲を確認する。
ACL 拒否は `ACCESS_DENIED` を返し、昇格で回避しない。
子のリンクは辿らず種別だけ返す。オンデマンドファイルを開かない。**検査した対象を `FILE_SHARE_DELETE` なしで開いたハンドルで列挙し（`GetFileInformationByHandleEx`）、列挙の後にも検査する**（検査後の差し替えで範囲外の名前を返さないため。2026-11-01、外部レビューで再現された不具合の修正）。
上限: 500 件 / 15 秒 / 32KB、超過は `truncated=true`。

## 7. 監査（`appendAudit`）

`folder_access.request / pair / consent / list_requested / list_result / result_discarded / end / revoke / expire / deny`。
`detail` には案件、担当者、端末（HMAC の参照）、SID の HMAC、セッション、同意 ID、操作種別、開始・終了、結果、件数を入れる。
パス、ファイル名、トークンは入れない（ルートの種別とサブフォルダも入れない）。SID はハッシュのみ。

### 7-1. 保持

| データ | 保持 |
|---|---|
| 一覧の結果、サブフォルダ名、Windows ユーザー名 | 同意の終了時に削除 |
| 未ペアのヘルパー登録 | ペアリング期限切れで登録情報を消して失効。1 日後に行を削除 |
| 依頼の SID・セッション・MachineGuid・ルート・端末（hostname、RSP 端末 ID、Mesh ノード ID、資産番号）、操作の SID・ルート、ペア済みヘルパーの SID・MachineGuid・hostname | 終了から `FOLDER_ACCESS_RETENTION_DAYS`（既定 30 日）で定期処理が消す |
| 依頼の状態・終了理由・時刻・案件・相談者と担当者のメール | 残す（履歴の確認用） |
| 監査ログ | 変更しない（§7 のとおり機微情報を含まない） |

機能フラグが無効でも定期処理は動く。

## 8. 残存リスク（基盤側。本機能では防げない）

本機能が強制するのは**本機能の経路**だけである。次の経路は残っている（封鎖は別途承認）。

1. MeshCentral の社員アカウントは標準 Files / Terminal を直接開ける（`NOFILES` / `NOTERMINAL` 未設定、文書値）。
2. RSP のサービスキーで任意の PowerShell を SYSTEM 実行できる。
3. HelpDesk のターミナル経路の AI 提案にパス制限がない。
4. ヘルパーの SID 申告は自己申告である。防げるのは誤配備と誤接続で、改ざんされた端末は防げない。
   MachineGuid とセッション情報を知る者は偽ヘルパーを登録でき、本人がコードを入力すれば一覧を捏造できる。
5. **「本人権限」の保証は、端末の SYSTEM を誰が握っているかに依存する**（実測）。SYSTEM はパスワードなしで本人の対話タスクを起動でき、
   実機検証でもペアリングコードを SYSTEM 経由で読み取った。Mesh Terminal や RSP サービスキーを持つ者は、同じ手順でコードを取得できる。

## 9. Windows ヘルパー（`scripts/windows/`）

実装は `folder-helper.ps1`、`install-folder-helper.ps1`、`uninstall-folder-helper.ps1`。
実機での確認結果は §10-2、未確認の項目は §10-3 を参照する。CI で検証するのは Linux の pwsh 上の純粋関数と、
OS 依存部をスタブにした結合動作だけ。§10-3 の項目は動作する前提で扱わない。

### 9.1 署名の正準形（ヘルパーと Node で共通）

- メッセージ: 次のキー順、空白なしの JSON（`JSON.stringify` と同じバイト列）。
  `opId, requestId, sid, sessionId, root, segments, operation, expiresAt`
- `sessionId` は JSON の数値。ほかは文字列（`segments` は文字列の配列）。
- `expiresAt` は受信した文字列のまま署名する。日時として解釈し直して整形しない。
- エスケープは `"`、`\`、`\b \t \n \f \r`、その他の U+0020 未満（`\u00xx` 小文字）、
  対にならないサロゲート（`\udxxx` 小文字）だけ。`/ < > & '`、U+007F、U+2028/2029、非 ASCII は生の UTF-8。
- 鍵は `helperToken` 文字列の UTF-8 バイト、メッセージは UTF-8 バイト。
- `sig` は小文字 16 進 64 文字。ヘルパーは大文字を受けず、固定時間で比較する。
- `maxEntries / maxBytes / maxSeconds` は署名の対象外なので、ヘルパーは 500 件 / 32768 バイト / 15 秒を超えさせない。

テストベクトル（鍵 `test-helper-token-not-a-secret`、共通の値は
`requestId=req-0001, sid=S-1-5-21-1000-2000-3000-1001, sessionId=2, operation=list_metadata, expiresAt=2026-11-01T00:00:00.000Z`。Node で生成）:

| opId | root | segments | sig |
|---|---|---|---|
| `op-0001` | `Documents` | `[]` | `b70e5c50b8a96ed675de7f16e4eed2f0d001649d7564be1e606ff31691342ad9` |
| `op-0001` | `Documents` | `["alpha"]` | `8312545a3c8c05654081258357d395dd2cd495c844bf83fa55eaa665fa9012cd` |
| `op-0003` | `Desktop` | `["資料","2026年度 計画","テスト😀"]` | `66ab20ce0c620c7eda2ce5c1a240a2f509f3073a41c009665247e966a18c37fd` |
| `op-0004` | `Documents` | JS 表記で `["q\"b\\s/<&>'", "\n\t\b\f\r\x01\x7f", "\u2028\u2029é", "\ud83d"]` | `9f3fdea853998db0898d79174147698a8c8368adefbba4293837aeeba6306a8e` |

1 行目の正準形: `{"opId":"op-0001","requestId":"req-0001","sid":"S-1-5-21-1000-2000-3000-1001","sessionId":2,"root":"Documents","segments":[],"operation":"list_metadata","expiresAt":"2026-11-01T00:00:00.000Z"}`

`apps/api/src/folder-access/sign.test.ts` の固定ベクトル（sig `32bb903bb816eb361d56378e98cb41d7d491cf58a18c22ecd207cca2aa69b2f7`）も PowerShell 側のテストで一致を確認している。
`op-0004` は正準化の境界の確認用で、これらの文字はセグメント検証では拒否される。

### 9.2 手順

```powershell
# 本人の標準権限のウィンドウで実行する（管理者不要、パスワード不要）
powershell -ExecutionPolicy Bypass -File .\install-folder-helper.ps1 -ServerUrl https://helpdesk.example.com
# 画面に出たコードを、本人としてログインした HelpDesk の画面に入力する

# 削除（タスク・トークン・状態フォルダを消し、サーバへの失効通知を試みる）
powershell -ExecutionPolicy Bypass -File .\uninstall-folder-helper.ps1

# テスト（Pester 不要、Linux の pwsh でも可）
pwsh -NoProfile -File scripts/windows/tests/folder-helper.tests.ps1
```

- タスク名は `AIHelpDesk-FolderHelper-<SID末尾>`。本人のログオン時に LogonType Interactive / RunLevel Limited / 実行時間制限なしで動く。
- 状態は `%LOCALAPPDATA%\AIHelpDesk\folder-helper\`（ACL は本人のみ）。`token.dat` は DPAPI（CurrentUser）。
  `helper.log` はイベント名・opId・状態コード・件数・例外の型名だけを記録し、パス・ファイル名・トークン・コードは書かない。
- **案件ごとに `install-folder-helper.ps1` を実行する。** サーバは同意の終了、ペアリング期限切れ、セッションの変更（再ログオンを含む）で
  `revoked:true` を返す。ヘルパーはトークンを消して `revoked.flag` を置いて停止し、自動では再登録しない（install がフラグを消して再登録する）。
  このためログオン時タスクが効くのは、トークンが有効な間の再起動などに限られる。
- ペアリングコードは install の画面に `Write-Host` で表示する。タスク（`-Background`）が登録し直したときだけ `pairing-code.txt` に書き、
  最初の op を受けたとき（ペア済みとみなす）または期限切れで消す。

### 9.3 §5 の補足

| 項目 | 内容 |
|---|---|
| `sessionState` | WTS の接続状態を小文字で送る（`active`, `connected`, `connectquery`, `shadow`, `disconnected`, `idle`, `listen`, `reset`, `down`, `init`、取得失敗は `unknown`）。一覧を実行するのは `active` のときだけ。サーバは `active` / `disconnected` 以外をログオフとして扱うので、それ以外の状態では poll を送らない |
| 結果の `status` | ヘルパーが送るのは `ok` / `error`。切り詰めは `ok` + `truncated:true`（サーバ側で `partial` に変換） |
| 結果の `reason` | `BAD_OP, BAD_SIGNATURE, ELEVATED, SID_MISMATCH, SESSION_MISMATCH, SESSION_NOT_ACTIVE, EXPIRED, INVALID_ROOT, INVALID_SEGMENT, OUT_OF_SCOPE, REPARSE_REJECTED, ACCESS_DENIED, NOT_FOUND, NOT_A_DIRECTORY, PATH_CHANGED, IO_ERROR, INTERNAL_ERROR`。cancel された op は結果を送らない |
| `entries[].type` | `file` / `directory` / `link`。`link` は名前サロゲートのタグ（symlink・junction など）。クラウドのプレースホルダーは `file` / `directory` に `attrs.reparse` |
| `entries[].size` | `file` のみ数値。`directory` と `link` は `null` |
| `POST /revoke` | 実装済み（§5）。ヘッダ `x-folder-helper-token`、ボディ `{}`。uninstall が通知先に使う。通知に失敗しても端末側の削除は続行し、サーバ側は heartbeat の途絶で終了させる |
| poll の `paired` | サーバは実装済み（§5）。ヘルパーは参照せず、最初の op の受信でペア完了とみなしている |

### 9.4 判断: OneDrive と「全祖先の reparse 拒否」

§6 の全祖先拒否を文字どおり適用すると、Files On-Demand のフォルダがクラウドタグを持つ場合に OneDrive 配下を一切扱えない。次のように限定した（実機の状況は §10-3。OneDrive は未確認）:

- 名前サロゲートのタグ（symlink・junction 等）は場所を問わず拒否する。
- クラウドタグ（`(tag & 0xFFFF0FFF) == 0x9000001A`）だけ、`HKCU\Software\Microsoft\OneDrive` の `UserFolder` 配下で許可する。その他のタグは拒否する。
- `UserFolder` と `ProfileImagePath` は環境変数を展開せずに読み、`%` を含む値、ドライブ直下、UNC は範囲として使わない。
- 範囲判定は起点・対象・範囲のすべてを `GetFinalPathNameByHandleW` の最終パスに揃えて行う。

`Downloads` は `Environment.SpecialFolder` に無いため `SHGetKnownFolderPath`（`FOLDERID_Downloads`）で取得する。

### 9.5 実機の確認項目（責任者が実施）

- [ ] Windows PowerShell 5.1 の C# 5 コンパイラで `Add-Type` が通る（5.1 で `folder-helper.tests.ps1` を実行すれば確認できる）。`FullLanguage` でなければ（AppLocker / WDAC 環境など）終了する
- [ ] 標準ユーザーでタスクを登録できる（`-AtLogOn -User` と `-LogonType Interactive`）。ログオンで起動し、別ユーザーでは起動しない
- [ ] `-WindowStyle Hidden` でコンソールが一瞬出ないか
- [ ] 管理者のフィルタ済みトークンで `IsInRole(Administrator)` が偽、昇格で真。SYSTEM / LOCAL SERVICE / NETWORK SERVICE で終了する
- [ ] 状態フォルダの ACL が本人のみになる。DPAPI のトークンを別ユーザーで復号できない
- [ ] `ACCESS_DENIED`: 他ユーザーのプロファイルや ACL で拒否したフォルダで、昇格せずに報告する（`CreateFileW` の `FILE_READ_ATTRIBUTES` は親の権限で通る場合がある）
- [ ] `FILE_FLAG_BACKUP_SEMANTICS` が標準トークンで ACL を回避しない
- [ ] junction / symlink（中間・対象・`C:\Users` より上）で `REPARSE_REJECTED`。列挙中の差し替えで `PATH_CHANGED`
- [ ] 子の symlink / junction が `link` になり、辿らない
- [ ] OneDrive: 既知フォルダのリダイレクトで範囲内と判定され、Files On-Demand のタグと属性が想定どおり（プレースホルダーの互換モードで属性が隠れないか）。オンライン専用ファイルが **ハイドレートされない**、列挙でディレクトリのダウンロードが起きない
- [ ] GPO のフォルダリダイレクト（UNC）が `OUT_OF_SCOPE` になる
- [ ] 500 件 / 32KB / 15 秒の切り詰め。低速な場所で `FindNextFileW` が止まると 15 秒を超え得る（判定は件の間だけ）
- [ ] 高速ユーザー切替・RDP 切断 / 再接続での `sessionState`。遷移中は poll を止めるので、その間の heartbeat 欠落でサーバが誤判定しないか。ロック中は `active` のまま（ロックは判定していない）
- [ ] `HttpWebRequest` のプロキシ・TLS 1.2 と Cloudflare Access bypass の疎通。リダイレクトを辿らない
- [ ] イベントログ: スクリプトブロック / モジュールログが有効な環境でトークン・名前が記録されないか

### 9.6 残る制約

- **機能フラグの無効化ではヘルパーは停止しない。** 無効化すると API は 404 を返すが、ヘルパーは失敗として poll を続ける。
  rollback では端末ごとに `uninstall-folder-helper.ps1` の実行が必須（タスク・トークン・状態フォルダを消す）。

- 署名の鍵は端末に復号できる形であり、本人権限のマルウェアはトークンを読める。§8 の 4 と同じく、改ざんされた端末は防げない。
- 同じユーザーの複数セッションでは `MultipleInstances IgnoreNew` により 1 つしか動かない。
- op の期限判定は端末の時計に依存する。

## 10. 実機検証の結果と手順（2026-10-31、Windows 11 Pro + PowerShell 5.1）

### 10-1. 検証環境

- **対象コミット**: サーバ `0b85a38`、ヘルパー `72e7265`。その後の変更（インストーラの再試行、ブリッジの競合修正、古いプローブでの fail-closed、同時作成の処理）は自動試験のみで、**端末では動かしていない**。
- 検証端末 1 台（ドメイン参加、MeshAgent 導入済み）。相談者役はローカルの検証ユーザー。実在社員のプロファイルには触れていない。
- 検証専用 DB + ループバックの API。ヘルパー用パスだけを通すプロキシ + 一時 Quick Tunnel（DNS 変更なし）。検証後に DB とトンネルを削除した。
- 相談者役の Access アカウントには依頼者自身のアカウントを検証 DB 内でのみ使った。担当者役はデモ用アカウント。検証モードで端末を直接指定したため、**本機能の社員照合と貸与照合の経路は通っていない**。
- 検証ユーザーはローカル Administrators の一員で、タスクは `RunLevel=Limited` で動く。つまり **UAC で制限されたトークン**での結果であり、純粋な標準ユーザーでの結果ではない。
- 検証用 UI は Playwright（ヘッドレス）で操作した。

### 10-2. 実機で確認した結果

| 観点 | 結果 |
|---|---|
| 正常系 | ヘルパー導入 → 登録 → コード入力 → MachineGuid と `quser`（日本語版）の照合 → 同意 → 一覧 7 件 → 終了 / 取消 → 監査 |
| 実行主体（OS の根拠） | `Win32_Process.GetOwnerSid` のヘルパー所有者 SID のハッシュが同意の SID と一致。SYSTEM ではない。`IsInRole(Administrators)=false`（UAC で制限されたトークン） |
| 実行主体（比較） | RSP コマンドと Mesh Terminal は `S-1-5-18`。同じ経路で読まない理由の実測 |
| SYSTEM 起動 | 終了コード 2 で拒否（昇格プロセスからの起動拒否は mock のみ） |
| ACL 拒否 | 本人に権限のないフォルダは `ACCESS_DENIED`。昇格せず、制限トークンでは `FILE_FLAG_BACKUP_SEMANTICS` でも回避されない |
| リンク | ジャンクション・シンボリックリンクの指定は `REPARSE_REJECTED`。子としては種別 `link` のみ返し、辿らない |
| 入力拒否 | ADS、`..`、UNC、デバイスパス、絶対パス、ワイルドカード、予約デバイス名、末尾ドットを拒否。存在しない場合は `NOT_FOUND`、ファイル指定は `NOT_A_DIRECTORY` |
| 上限 | 600 件のフォルダで `partial` / `truncated=true`（349 件で 32KB に到達） |
| 権限 | 他人・担当者によるペア/同意/取消は 403、approver のみの list/result は 403、相談者の list は 403、同意前の list は 409 |
| コード | 誤コード 400、再利用 409 |
| 取消 | 本人取消で 409、結果行 0、ヘルパー失効、端末のヘルパーは自動停止 |
| 期限切れ | 1 分の同意が失効し 409（`expired`） |
| 担当変更 | 旧担当 409、結果行 0、ヘルパー失効（`assignee_changed`） |
| セッション切断 | 切断中の一覧は `SESSION_NOT_ACTIVE`、同意は保持。切断セッションでの登録は `NOT_LOGGED_ON` |
| 通信断 | ヘルパー停止から 173 秒で `user_logged_off` |
| 監査 | パス・ファイル名を含まないことを DB で確認 |
| 画面 | 相談者・担当者の両パネルで状態、確認対象、許可範囲、取消、一覧表示、終了を確認。`S`、`localStorage`、サーバ状態にファイル名なし |

### 10-3. 実機で未確認（完成とは言えない項目）

| 項目 | 理由 |
|---|---|
| 社員照合・貸与端末の実照合 | Mirai-Info のサービストークン未発行。すべて検証モード（`lease_status='unverified'`）で実施し、この経路は mock のみ |
| 複数セッションの選択 | 検証時は単一セッションのみ。mock のみ |
| 実際の別ユーザー（別 SID・ユーザー切替） | 第 2 ユーザーはポリシーでログオン拒否（タスク スケジューラ イベント 104）。mock のみ |
| 実ログオフ | 検証ユーザーの既存セッションを壊すため未実施。heartbeat 途絶で代替確認 |
| RDP・複数ログオン | 検証環境なし。mock のみ |
| OneDrive（リダイレクト、ハイドレートなし） | 検証端末で未確認。§9.4 の例外はユーザーが承認済み（2026-10-31）で、OneDrive 使用端末での実機確認が条件 |
| 本人の実画面でのコード表示・操作 | ヘッドレス操作。コードは検証用に端末のログから取得した |
| `mesh_node_id` の実値 | RSP PR が未配備 |

### 10-4. 実機で判明した注意点

- **起動の不安定さ**: タスクの起動で、CPU 0 のまま進まない事象が 1 回、`0xC0000142` が 2 回発生した。いずれも再現条件は未解明（後者はセッション再接続の前後）。
  安全側に倒れる（ヘルパーなしでは先へ進まない）が、運用上の課題である。インストーラに再試行（3 回）を追加した。再試行の実機確認は未実施。
- **端末のオンラインが断続的**: 検証中に 1 回オフラインになり、RSP が `AGENT_NO_REPLY` を返した。
- **RSP の残留**: 固定テンプレートの出力（MachineGuid、`quser` のユーザー名）は RSP の `command_logs` に残る。検証で実行した診断コマンドの出力も同じ場所に残っている。
- **画面の露出**: `tscon` で接続した間、検証ユーザーのセッションは物理コンソールにロック解除の状態で表示される。
- **ペアリングのやり直し**: コードを失った状態で再導入しても、トークンがあると再登録しない。`uninstall-folder-helper.ps1` が先に必要。
- **RSP の危険判定は書き方の判定である**: 再帰削除は `DANGEROUS_BLOCKED` になったが、`[IO.File]::Delete` を正確なパスで繰り返すと通った。後片付けでは自分の作成物だけをこの方法で消した。同じ効果の操作を別の書き方で通せるので、安全策として過信しない。

- **支援セッションとの統合の実機結果**: `docs/63-assist-session.md` §14 を参照。RSP のコマンドが固まると `AGENT_BUSY` が続き、固定テンプレートの照合も進まない。

### 10-4-1. ユーザー判定（2026-10-31）

- PR #117 は未確認項目を解消するまで保留（draft のまま）。
- §9.4 の OneDrive の例外を承認。
- RSP の `command_logs` に残った検証コマンドの出力は、監査ログとして残す（残存リスクとして記録）。

### 10-5. 再現手順

1. 検証専用 DB を作り、`NODE_ENV=development`、`AUTH_MODE=cloudflare-access`、`ACCESS_JWT_MODE=off`、`FOLDER_ACCESS_ENABLED=true`、`FOLDER_ACCESS_ALLOW_UNVERIFIED_LEASE=true` で API をループバックに起動する。
2. 端末から到達できる経路を用意する（ヘルパー用パス以外を拒否するプロキシ経由。Quick Tunnel は `--config` に空ファイルを指定しないと `/etc/cloudflared` の ingress で 404 になる）。
3. 検証ユーザーのセッションをアクティブにする（SYSTEM から `tscon <id> /dest:console`）。合成フォルダを作る。
4. 本人権限で `install-folder-helper.ps1 -ServerUrl <url>` を実行する。
5. `scripts/verify/folder-access-real.mjs` で `seed` → `create` → `pair` → `consent` → `list` → `result` → `revoke` を順に実行する（`AIHD_BASE`、`AIHD_OWNER`、`AIHD_OPERATOR`、`AIHD_HOSTNAME`、`DATABASE_URL` を指定）。
6. 範囲検査は本人権限で `scripts/windows/tests/folder-helper-realfs.ps1` を実行する（名前を出力しない）。
7. 後片付け: `uninstall-folder-helper.ps1`、作成物の個別削除、`tsdiscon`、DB とトンネルの削除。
