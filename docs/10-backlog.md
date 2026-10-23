# Backlog / Future Features

MVP では実装しない。必要になった順に Issue 化する。

## P1（MVP の次に検討）

| # | 機能 | 理由 / 要件 |
|---|---|---|
| B-01 | 添付ファイル（メタデータ→実体） | FR-05。区分・AI 可否・マルウェア検査・保存先の設計が必要 |
| B-02 | 端末修復 L2〜L5 | FR-19〜21, 23。承認ハッシュ・実行前検証・許可リスト・緊急停止 |
| B-03 | ~~外部 AI Provider 接続~~ **完了（DeepSeek-V4.1-Flash）** | 承認済みナレッジ + PC 情報を根拠に接続 |
| B-04 | SSO / Entra ID（Cloudflare Access + OTP は完了） | NFR-08。本番の職務分離・SSO 連携 |
| B-05 | 外部ヘルプデスク基盤連携 | desknet's NEO / AppSuite。INC の正本連携 |
| B-06 | E2E（Playwright）と Preview 実操作 | 承認後の WebUI 実装とセット |
| B-07 | CI の有効化 | `.github/workflows/ci.yml` は policy gate で未作成。[docs/08-deployment.md](08-deployment.md) |
| B-08 | ~~Cloudflare Preview 配備~~ **完了（Tunnel + Access）** | 追加の WAF / Turnstile は次段階 |

## P2（運用が始まってから）

| # | 機能 | 理由 |
|---|---|---|
| B-09 | 問い合わせ台帳・機器台帳・CSV 出力 | FR-39, 40 |
| B-10 | 受け入れ試験 19 項目 / AI 試験 12 問の画面 | FR-42 |
| B-11 | ダッシュボードの高度化（SLA・傾向） | 個人利用では不要 |
| B-12 | 監査ログの SIEM / 追記専用ストレージ連携 | NFR-14 |
| B-13 | バックアップの自動化・PITR | NFR-23 |
| B-14 | レート制限の分散化（Redis 等） | 現在はプロセス内メモリ |
| B-15 | スマートフォン最適化 | 現在は PC 中心・820px 以下は簡易対応 |
| B-16 | 多言語化 | MVP は日本語のみ |
| B-17 | メール / Chat 通知 | 現在は画面内のみ |
| B-18 | ~~PC エージェント実装~~ **一部完了**（読み取り専用 Agent） | Windows インストーラ・署名・自動更新・複数端末管理が残 |
| B-19 | 高度なナレッジ版管理・差分・利用統計 | 現在は単純な version のみ |
| B-20 | 専用 DB ロール・最小権限 | 現在は Local PG の既存スーパーユーザー |
| B-21 | CSRF トークン・WAF・Turnstile | SameSite + Origin 検証で代替中 |
| B-22 | ~~Windows ログオンタスク（Node不要）~~ **一部完了** | PowerShell CLI + ログオン/60分タスクを追加。残: GPO/Intune 配布、コード署名、Windows実機検証 |
| B-23 | エージェント用 Access bypass をサービスドメインへ移行 | 現在の資格情報に `access-service-token.write` が無いため bypass + デバイストークン |
| B-24 | 複数端末の同時管理（user_email + device_id） | 現在は user_email + source の 1 端末 MVP |
| B-25 | 導入ソフトの AI 送信 allowlist / 除外設定 | 現在は関連ソフト最大 20 件に絞る |
| B-26 | エージェントの死活監視・最終取得アラート | `updated_at` の監視は未実装 |

## 対象外（MVP の価値に不要）

- 本番正式環境・Production deploy
- 大規模 Multi-Tenant / 組織階層 / 権限の高度化
- 端末の遠隔操作（画面共有）
- 人事評価・勤怠・行動追跡への利用
- ハラスメント通報の本文保存
- 課金・契約・Billing 変更

## Issue 化の単位

- 1 機能 = 1 Issue。受入条件とセキュリティ影響を記載する。
- WebUI を含むものは OpenDesign の設計更新を先に行う。
- DB 変更は Migration（追加のみ）とロールバック手順をセットにする。
