# 共通支援セッションと AI 操作ループ — 統合仕様と契約

- 状態: 開発中（`FOLDER_ACCESS_ENABLED` に加えて `ASSIST_SESSION_ENABLED`、既定 `false`）。本番未反映。
- 依存: PR #117（folder-access）、Mirai-Info PR #262、RSP PR #164。
- 本機能が強制するのは**本機能の経路だけ**である。基盤側の経路は §9 を参照。

## 1. 希望フローと現行の差分

| 段階 | 現行 | 本仕様で追加するもの |
|---|---|---|
| 本人認証 | Access + 名簿 | 変更なし |
| 社員・貸与照合 | #117（lease.ts）。実機は未検証モードのみ | 共通セッションへ結果と取得時刻を保存 |
| PC 確定 | #117（RSP + MachineGuid） | 共通セッションへ保存。resolve の WEB-ID をキーにしない |
| SID・セッション | #117 のヘルパー | 共通セッションへ保存 |
| 本人同意 | フォルダ同意のみ | **操作範囲の同意**（新規）と **AI 入力の同意**（新規）を分離 |
| AI 提案 | resolve（Skill + 型付きパラメータ）。`source` は監査のみ | `proposal_source` を列で保持。read/modify を明示 |
| Y/N | resolve（SID・同意・端末実体に束縛なし） | §5 の束縛を別 payload で実装 |
| 実行 | `device_commands` + エージェント。SID 検証なし、real/mock の区別なし | **ヘルパーのみ**（§6） |
| 結果 | mock を判別不能。ハッシュ不一致でも verify が通る疑い | `execution_mode` 必須、本番は real のみ（§7） |
| 確認操作 | `system:verify` が自動承認 | 承認時に提示した確認だけを実行（§8） |
| 反復 | 6 提案・30 分は resolve のみ | 共通セッションで一元管理（§8） |
| 失効 | 経路ごとに別 | 共通セッションから全経路へ伝搬（§10） |

## 2. 同意の 3 層

| 層 | 範囲 | 取消 | 備考 |
|---|---|---|---|
| フォルダ同意 | #117。直下一覧とメタデータ | 本人 | 操作の許可を含まない |
| 操作範囲の同意 | `read_only` または `user_reversible`。本人コンテキストのみ。期限つき | 本人 | **フォルダ同意から導出しない** |
| AI 入力の同意 | §4 の構造化要約を AI へ渡すこと | 本人 | 同意がなければルールベースのみ |
| 操作ごとの Y/N | 1 提案 1 回 | 本人 | **本人認証の代わりではない**。継続の Y を実行承認に使い回さない |

マシン全体の管理者操作は本経路の範囲外とする。フォルダ同意で昇格しない。

## 3. 共通セッション

`support_sessions` が 1 案件 1 件の親になる。保持する値: 案件、相談者、担当者、貸与結果（status / source / fetchedAt）、`rsp_device_id`、`mesh_node_id`、`machine_guid`、`sid`、`windows_session_id`、`helper_id`、`folder_request_id`、各同意の ID・版・期限、`proposal_count`、`status`、`end_reason`、`expires_at`（30 分）。

貸与者とログオンユーザーを同一視しない。候補 0 件・複数・古い情報・照合競合は確定せず止める（#117 の規則を流用）。メールや表示名からプロファイルパスを推測しない。

```
binding_pending → consent_pending → ready → proposing → awaiting_approval
    → approved → executing → verifying → awaiting_next → (proposing | resolve_confirm)
終端: resolved / stopped / escalated / expired / revoked
```

## 4. AI へ渡す情報（#117 からの仕様変更）

#117 は「一覧を AI へ渡さない」とした。これは維持する。**追加するのは、本人が同意した構造化要約だけ**である。

| 渡す | 渡さない |
|---|---|
| 対象の参照 ID（`T1`）、root の種別 | 実パス、ファイル名、フォルダ名 |
| 存在・アクセス可否、件数、合計サイズ、固定エラーコード | ファイル本文、ユーザー名、SID、ホスト名、MachineGuid |
| 実行済みの Skill ID、固定の結果コード、検証の真偽 | 端末出力の自由文 |

実パスはサーバ／ヘルパーで解決する。AI が生成したパスは受け付けない（パラメータは `T1` のみ）。ファイル名や端末出力は命令として扱わず、AI へ渡さない。

## 5. 提案と承認

**提案**: skillId、version、contentHash、目的、対象参照、実行主体（`user_session`）、params、`effect`（read / modify）、影響、成功条件、確認操作（skillId + params）、失敗時対応、戻せる範囲、`proposal_source`（deepseek / rule）。AI の自然文は表示用であり実行契約にしない。登録外 Skill、不正パラメータ、操作範囲の外は拒否する。

**承認ハッシュの束縛**: supportSessionId、caseId、proposalId、stepSeq、requesterEmail、assigneeEmail、machineGuid、sid、windowsSessionId、helperId、folderConsentId + 版 + 範囲 + 期限、operationConsentId + 版 + scope + 期限、skillId、version、contentHash、scriptHash、params、requiredPrivilege、nonce、expiresAt、確認操作の定義。

Y の後に束縛値が変われば承認は無効。nonce は一度だけ消費する。N は実行せず `stopped`。承認期限は 5 分。高リスクは既存の管理者承認も必要。

## 6. 実行器

**実行器はヘルパーだけである。** 共通セッションに束縛された提案は `device_commands`、`endpoint-command-agent`、RSP へ配送しない（サーバで拒否する）。ヘルパーがない、またはセッションが一致しない場合は停止する。これが「SYSTEM へフォールバックしない」の実装上の定義である。

```
サーバ: queued → (poll) delivered
ヘルパー: 署名・SID・セッション・期限・scriptHash を検証 → POST /ops/:id/start
サーバ: 同意・承認・担当・SID・セッション・期限・nonce を再検証し executing へ原子的に遷移（応答なしなら実行しない）
ヘルパー: 実行記録を CreateNew で書く → 子プロセス起動（Job Object） → 結果報告
```

再起動時に実行記録があれば再実行せず `INTERRUPTED` を報告する。

## 7. 結果と出所

`assist_executions`: proposalId、stepId、executionId、対象、実行主体 SID（OS 確認）、開始・終了、終了コード、取消、タイムアウト、正規化出力、`result_source`、`execution_mode`（real / mock / manual）。

- `real` はヘルパートークン経由の報告だけ。**本番で `real` 以外は拒否する。**
- 手動記録は証拠にしない。出所を確認できない結果で次の変更へ進まない。
- 成功はサーバの固定条件で判定する。出力欠落、タイムアウト、評価不能は成功にしない。AI の判断で解決にしない。
- AI へは許可フィールドをマスクして渡す。resolve の `lastVerify.actual` と `params` の素通しは本経路で修正する。

## 8. 反復の上限

6 提案・30 分を共通セッションで管理する。**確認操作の数え方**: 承認時に提示した確認はその提案の一部で、枠を消費しない。未提示の追加確認は新しい提案として数え、別に Y/N を取る。terminal の 20 ステップと旧 UI の 15 回とは別物である。

停止条件: 同一操作の重複、進捗なし（結果コードが 2 回同じ）、失敗、期限切れ、検証不能。成功条件を満たしたら本人の解決確認へ進む。

## 9. 迂回経路（本機能では塞げない）

| 経路 | 新条件を迂回できるか | 対策案（別承認） | 残存 |
|---|---|---|---|
| RSP サービスキー | できる（SYSTEM で自由文） | 固定テンプレート専用ルート、キー分離 | PC-Ops の自由文 |
| Mesh Files / Terminal | できる（実測） | `removeRights` | フル権限の管理者 |
| runcommand | できる | 権限ビットの除去 | executor |
| HelpDesk terminal | 担当者の手入力で可能 | 同意中の注意表示 | 手入力 |
| command-agent | 既存 Skill は可能 | `scope:user_profile` の投入拒否 | 既存トークン |
| `POST /device/command` | 固定 op のみ | 承認条件の統一 | — |

SYSTEM を持つ者はヘルパーと本人タスクを操作できる。**封鎖するまで、本機能の制御を基盤全体の制御と説明しない。**

## 10. 失効の伝搬

取消、N、中止、期限切れ、担当変更、ログオフ、SID・セッション変更で次を行う。

| 対象 | 動作 | 記録 |
|---|---|---|
| 未配送 | 取消 | `cancelled` |
| 配送済み・未開始 | `/start` が拒否 | `rejected_at_start` |
| 実行中 | 停止要求 → Job Object の終了 | `stop_requested` と `stopped` / `stop_failed` を**別に記録** |
| 遅延結果 | 保存するが次へ進めない | `late_result` |
| 権限 | トークン失効、ヘルパー停止 | 監査 |
| 個人データ | 保持方針に従い削除 | 監査 |

既に生じた変更、停止不能、復元不能は `partial_effect` として隠さず記録する。報告の順序は kill → 報告 → トークン削除とする。**機能フラグを無効にしても端末側は止まらない**（`uninstall-folder-helper.ps1` が必要）。

## 11. Skill

| Skill | 区分 | 内容 |
|---|---|---|
| `folder.summary` | read | 許可フォルダ直下の件数、種別別件数、合計サイズ、`truncated`。名前を返さない |
| `user.marker.set` / `clear` | modify（可逆） | `HKCU\\Software\\AIHelpDesk\\Verify` の合成値。前値を返し復元する。検証用 manifest のみ |
| 読取 Skill 1 件 | read | `disk.space` |

## 12. 実装と本仕様の差（2026-11-01）

- poll は `skillOps` を別配列で返し、`capabilities` を申告したヘルパーにだけ配送する。結果は `POST /ops/:id/skill-result`。
- 確認専用の `user.marker.status` を追加した（提案不可）。
- 新 Skill は専用カタログに置き、resolve には載せない。§6 の拒否は構造で担保し、resolve 側に実行時ガードはない。
- 高リスク Skill は管理者承認を実装せず、**カタログから除外**している。
- フォルダ同意の版は固定値。`binding_pending` は未使用。
- nonce は 2 段（Y と `/start` で各 1 回）。
- 全終端でフォルダ同意とトークンを失効する（解決時も）。
- 成功コードは Skill ごとに固定のため、「進捗なし」は実質「同一 Skill の連続成功」である。
- ヘルパー: `/start` の無応答・5xx は `rejected` + `START_NO_RESPONSE`。poll が 30 秒成功しなければ子を停止する。op の期限は開始前だけ判定する。

- **AI 応答の採用（§2、外部レビューで再現）**: AI に問い合わせた場合は、提案・停止・引継ぎ・解決確認の全分岐の前で同意 ID と有効期限を照合する。変わっていれば `ai_consent_changed` で停止する。ルールベースへ切り替えない。
- **報告権限の期限**: 失効済みトークンでの報告は `revoked_at` + 24 時間まで。再送で延長しない。期限切れは `410 RESULT_REPORT_EXPIRED` で、結果は保存しない。来なかった実行は「停止未確認」として記録を残し、停止完了や成功にしない。24 時間は運用上の推奨値である。
- **報告用資格情報の分離**: 未報告が残る失効では `token.dat` を `report-token.dat` へ移し、未報告の記録も別の場所へ移す。報告専用トークンは poll と `/start` に使わない。これで再導入が新規登録できる。報告専用の枠は 1 つで、埋まっていれば前回分を `abandoned` として閉じる。登録時に残っていた記録も `abandoned` にする。報告専用トークンの 401 は `rejected` で閉じる。**これらの場合は結果が届かないまま閉じる**ので、サーバ側は停止未確認のまま残る。

## 13. 未実装・未確認

| 項目 | 状態 |
|---|---|
| Skill の承認手段 | **阻害要因**。`scripts/approve-skills.ts` は `SKILL_CATALOG` だけで `approved.json` を全書換えするので、新 Skill を承認できない |
| 担当者パネル | 未実装（開始と中止は API のみ） |
| `diag.sleep` | サーバ未登録（実行中の停止試験に発行手段が必要） |
| 実 Windows | **ヘルパー全体の受入確認は未実施**。ヘルパーと Skill 承認は Mock。Add-Type、Job、stdin、ハッシュ一致（CRLF 変換で不一致になる）、HKCU、ログオフ時の停止、DPAPI、`report-token.dat` の移動は未実測。`folder.summary` の列挙のみ、外部レビューが Windows 上の合成データで確認済み（800 件の件数・サイズ・リンク種別の一致、ハンドル保持中の対象・親・祖父の改名拒否） |
| 実 AI | 未確認（ユーザーは利用を承認済み） |
| 実貸与照合 | 未確認（Mirai-Info #262 のマージ、read API 再起動、トークン発行が必要） |
| 認証済みブラウザ | 未確認（これまでの画面確認はヘッダ注入のヘッドレス） |

