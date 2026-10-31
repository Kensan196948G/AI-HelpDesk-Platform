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

## 4. 本人・PC・Windows ユーザーの照合

1. **本人**: Access のメール → Mirai-Info の有効社員。案件の `owner_email` と一致すること。
2. **貸与端末**: Mirai-Info の PII API（`LEASE_API_URL` + サービストークン）から `employee_no` で取得する。
   `source` と `fetchedAt`、応答の `generatedAt` を保存し、`LEASE_MAX_AGE_HOURS`（既定 24）を超えたら古い扱い。
   **`device_staff` ビューを SQL で直接読まない**（PII API の Access 制御の迂回になる）。
   - 候補 0 件・複数・照合競合・古い情報は確定しない。`device_pending` に留め、理由を画面に出す。
   - トークン未設定なら `LEASE_UNAVAILABLE` で留まる。
   - `FOLDER_ACCESS_ALLOW_UNVERIFIED_LEASE=true`（`NODE_ENV=production` では起動拒否）のときだけ、
     検証用に `lease_status='unverified'` として担当者の指定端末で進める。
3. **端末**: RSP `deviceId` と `mesh_node_id` を保存する。hostname だけを許可の根拠にしない。
   RSP の固定テンプレートで MachineGuid を取得し、ヘルパーの申告と一致しなければ `device_mismatch`。
4. **Windows ユーザー**: ペアリングで結び付ける。
   - ヘルパーは本人セッション内で `WindowsIdentity.GetCurrent()` の SID を取得し、登録して 8 桁のコードを本人の画面に表示する。
   - 本人が Access 認証済みの画面でコードを入力し、表示された端末名・Windows ユーザーを確認する。
   - これで Access 上の本人と `(device, SID, sessionId)` が結び付く。
     **貸与者とログオンユーザーを同一視せず、メールや表示名からフォルダ名を推測しない。**
   - `S-1-5-18/19/20` と昇格プロセスは拒否する。

## 5. API（`/api`）

**相談者（Access、案件の `owner_email` 本人のみ）**
- `GET /folder-access/mine?handoverId=` 状態
- `POST /folder-access/requests/:id/pair` `{code}` ペアリング
- `POST /folder-access/requests/:id/consent` `{root, segments, ttlMinutes}`
- `POST /folder-access/requests/:id/revoke`

**担当者（Access、`requireHelpdeskActor` かつ引継ぎを claim した本人のみ。approver だけでは不可）**
- `POST /folder-access/requests` `{handoverId, rspDeviceId?}`
- `GET /folder-access/requests/:id` 状態・許可範囲
- `POST /folder-access/requests/:id/list` 一覧の取得を投入
- `GET /folder-access/requests/:id/result` 結果（`active` の間のみ）
- `POST /folder-access/requests/:id/end`

**ヘルパー（`/api/device/agent/folder-helper/*`。既存の Access bypass 配下。Access の変更は不要）**
- `POST /register` `{machineGuid, sid, userName, sessionId, sessionState, hostname, helperVersion}`
  → `{helperId, helperToken, pairingCode, pairingExpiresAt}`（レート制限あり。未ペアのトークンは poll 以外に使えない）
- `POST /poll` ヘッダ `x-folder-helper-token`。ボディは heartbeat（`sid, sessionId, sessionState`）。
  応答 `{ops:[{opId, requestId, sid, sessionId, root, segments, operation:'list_metadata', expiresAt, maxEntries, maxBytes, maxSeconds, sig}], cancel:[opId...], revoked:bool}`
- `POST /ops/:id/result`
  `{actorSid, sessionId, root, status, reason?, truncated, elapsedMs, entries:[{name,type,size,modifiedAt,attrs:{reparse?,cloudOnly?,hidden?}}]}`

`sig` は `HMAC-SHA256(helperToken, canonicalJson(opId,requestId,sid,sessionId,root,segments,operation,expiresAt))`。
ヘルパーは実行前に署名・SID・セッション・期限を検証する。

## 6. 検証ルール

**サーバ（毎操作）**: フラグ有効、同意が `active`、期限内、claim 者が同一担当者、本人が相談者、
ヘルパー未失効、heartbeat の SID・セッション一致。不一致なら終了させる。
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
子のリンクは辿らず種別だけ返す。オンデマンドファイルを開かない（`FindFirstFileExW` + `FindExInfoBasic`）。
上限: 500 件 / 15 秒 / 32KB、超過は `truncated=true`。

## 7. 監査（`appendAudit`）

`folder_access.request / pair / consent / list_requested / list_result / result_discarded / end / revoke / expire / deny`。
`detail` には案件、担当者、端末、SID のハッシュ、セッション、同意 ID、操作種別、開始・終了、結果、件数を入れる。
パス、ファイル名、トークンは入れない。

## 8. 残存リスク（基盤側。本機能では防げない）

本機能が強制するのは**本機能の経路**だけである。次の経路は残っている（封鎖は別途承認）。

1. MeshCentral の社員アカウントは標準 Files / Terminal を直接開ける（`NOFILES` / `NOTERMINAL` 未設定、文書値）。
2. RSP のサービスキーで任意の PowerShell を SYSTEM 実行できる。
3. HelpDesk のターミナル経路の AI 提案にパス制限がない。
4. ヘルパーの SID 申告は自己申告である。防げるのは誤配備と誤接続で、改ざんされた端末は防げない。
