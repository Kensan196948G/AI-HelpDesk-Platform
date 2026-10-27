# Phase 3 — C-05 / C-07 / 通知（2026-10-27 08:58 JST）

- **C-05 PASS（指名なし）**: 共有ダイアログで「グループ全員（指名なし）」を選択 → `case_handovers` に `recipient_no=NULL` で作成。
- **C-07 PASS**: 通知メール本文は「相談の本文や PC の情報は、個人情報保護のためメールには載せていません」と明記され、本文・PC情報を含まない（SMTP シンクで実受信・デコードして確認）。
- **G-06 部分PASS**: SMTP シンク（:2526）へ **1通送信成功**（`case_handover_notifications.status='sent'`、宛先は `HANDOVER_NOTIFY_EMAIL`）。

## F-05【Medium】引継ぎ通知の件名が常に「(件名なし)」
- 案件の件名「【検証20261027】共有フォルダの権限申請で連絡先が通じない」を入力済みでも、通知メールの件名は `(件名なし)（CASE-0004）`。
- 原因候補: 共有が STEP4 の引継ぎ直後に行われ、サーバの case スナップショットに件名が反映される前に `case_handovers` を作成している（`ahShareCase` が ticket 作成直後に POST する）。
