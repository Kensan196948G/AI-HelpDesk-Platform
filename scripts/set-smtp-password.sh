#!/usr/bin/env bash
# Google アプリパスワード（SMTP）を設定する。
#
#   bash scripts/set-smtp-password.sh
#   bash scripts/set-smtp-password.sh --test-to user@example.com
#   bash scripts/set-smtp-password.sh --file ~/新パスワード.txt
#
# やること:
#   1) パスワードを安全に受け取る（画面に出さない）
#   2) ~/.config/ai-helpdesk/api.conf の SMTP_PASS を差し替える（バックアップ + 0600）
#   3) SMTP の認証だけ確認する（メールは送らない）
#   4) サービスを再起動する
#   5) --test-to があれば、そのアドレスへテスト送信する
#
# 秘密はログ・画面・引数履歴に残さない（履歴に残る --password は用意していない）。
# api.conf は systemd の EnvironmentFile 形式なので、シェルとして読み込まない
# （値の `|` などをシェルが解釈して失敗する。backup-db.sh と同じ理由）。
set -euo pipefail

CONF="${HOME}/.config/ai-helpdesk/api.conf"
PW_FILE=""
TEST_TO=""
DO_RESTART=1
SKIP_VERIFY=0
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --conf) CONF="$2"; shift 2 ;;
    --file) PW_FILE="$2"; shift 2 ;;
    --test-to) TEST_TO="$2"; shift 2 ;;
    --no-restart) DO_RESTART=0; shift ;;
    --skip-verify) SKIP_VERIFY=1; shift ;;
    -h|--help) usage ;;
    *) echo "不明な引数: $1" >&2; exit 2 ;;
  esac
done

[ -f "$CONF" ] || { echo "設定ファイルがありません: $CONF" >&2; exit 1; }
# 後の処理は REPO_ROOT へ移動してから読むので、相対パスのまま渡さない。
CONF="$(realpath -- "$CONF")"

# ---- 1) パスワードの受け取り ------------------------------------------------
PW=""
if [ -n "$PW_FILE" ]; then
  [ -f "$PW_FILE" ] || { echo "ファイルがありません: $PW_FILE" >&2; exit 1; }
  # 16 桁の英小文字/数字のかたまりを探す（Google は "xxxx xxxx xxxx xxxx" 形式）
  PW="$(tr -d ' \r\n\t' < "$PW_FILE" | grep -oE '[a-z0-9]{16}' | head -1 || true)"
elif [ -n "${SMTP_PASS:-}" ]; then
  PW="$(printf '%s' "$SMTP_PASS" | tr -d ' ')"
else
  printf 'Google のアプリパスワード（16 桁・画面には出ません）: '
  read -rs PW
  echo
  PW="$(printf '%s' "$PW" | tr -d ' ')"
fi

if ! printf '%s' "$PW" | grep -qE '^[a-z0-9]{16}$'; then
  echo "パスワードの形式が想定と違います（16 桁の英小文字/数字）。中止しました。" >&2
  exit 1
fi

# ---- 2) api.conf の SMTP_PASS を差し替える ---------------------------------
BK="${CONF}.bak-$(date +%Y%m%d%H%M%S)"
cp -p "$CONF" "$BK"
chmod 600 "$BK"

TMP="$(mktemp)"
chmod 600 "$TMP"
# 新しいパスワードをプロセス引数へ出さないよう、環境変数で awk へ渡す。
AIHD_NEW_SMTP_PASS="$PW" awk -v key="SMTP_PASS" '
  BEGIN { done = 0; val = ENVIRON["AIHD_NEW_SMTP_PASS"] }
  $0 ~ "^" key "=" { print key "=" val; done = 1; next }
  { print }
  END { if (!done) print key "=" val }
' "$CONF" > "$TMP"
mv "$TMP" "$CONF"
chmod 600 "$CONF"

echo "✅ SMTP_PASS を更新しました（バックアップ: $(basename "$BK")）"

# ---- 3) 認証だけ確認（メールは送らない） -----------------------------------
if [ "$SKIP_VERIFY" -eq 0 ]; then
  echo "… SMTP の認証を確認しています（送信はしません）"
  ( cd "$REPO_ROOT" && AIHD_ENV_FILE="$CONF" node --input-type=module -e '
    import { createSmtpTransport, readEnvFile } from "./scripts/lib/ops-mail.mjs";
    const env = readEnvFile(process.env.AIHD_ENV_FILE);
    const t = createSmtpTransport(env);
    try { await t.verify(); console.log("✅ 認証 OK:", env.SMTP_USER); }
    catch (e) { console.error("❌ 認証 NG:", String(e.message).slice(0, 140)); process.exit(1); }
  ' ) || { echo "認証に失敗しました。設定は更新済みですが、サービスは再起動していません。" >&2; exit 1; }
fi

# ---- 4) 再起動 -------------------------------------------------------------
if [ "$DO_RESTART" -eq 1 ]; then
  systemctl --user restart ai-helpdesk-api.service
  sleep 2
  if systemctl --user is-active ai-helpdesk-api.service >/dev/null; then
    echo "✅ ai-helpdesk-api を再起動しました"
  else
    echo "❌ サービスの起動に失敗しました" >&2
    exit 1
  fi
fi

# ---- 5) テスト送信（任意） -------------------------------------------------
if [ -n "$TEST_TO" ]; then
  echo "… テスト送信: ${TEST_TO}"
  ( cd "$REPO_ROOT" && AIHD_ENV_FILE="$CONF" TEST_TO="$TEST_TO" node --input-type=module -e '
    import { createSmtpTransport, fromAddress, readEnvFile } from "./scripts/lib/ops-mail.mjs";
    const env = readEnvFile(process.env.AIHD_ENV_FILE);
    const t = createSmtpTransport(env);
    const info = await t.sendMail({
      from: fromAddress(env),
      to: process.env.TEST_TO,
      subject: "[AIヘルプデスク] アプリパスワード更新テスト",
      text: "新しいアプリパスワードでの送信テストです。このメールが届けば設定完了です。",
    });
    console.log("✅ 送信受付:", JSON.stringify(info.accepted));
  ' ) || { echo "❌ テスト送信に失敗しました" >&2; exit 1; }
fi

echo
echo "完了しました。"
echo "  - Google 側で **古いアプリパスワードを削除** してください（今回の切り替え後は不要）。"
echo "  - 通知の送信状況: psql \"\$DATABASE_URL\" -c \"select status,count(*) from case_handover_notifications group by status\""
