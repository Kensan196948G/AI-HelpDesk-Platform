#!/usr/bin/env bash
# Google アプリパスワード（SMTP）を設定する。
#
#   bash scripts/set-smtp-password.sh
#   bash scripts/set-smtp-password.sh --test-to user@example.com
#   bash scripts/set-smtp-password.sh --file ~/新パスワード.txt
#   bash scripts/set-smtp-password.sh --unit ai-helpdesk-prod-api.service
#
# やること:
#   1) パスワードを安全に受け取る（画面に出さない）
#   2) ~/.config/ai-helpdesk/api.conf の SMTP_PASS を差し替える（バックアップ + 0600）
#   3) SMTP の認証だけ確認する（メールは送らない）
#   4) サービスを再起動する（active な ai-helpdesk-prod-api を優先。--unit で明示指定も可）
#   5) --test-to があれば、そのアドレスへテスト送信する
#
# 秘密はログ・画面・引数履歴に残さない（履歴に残る --password は用意していない）。
# api.conf は systemd の EnvironmentFile 形式なので、シェルとして読み込まない
# （値の `|` などをシェルが解釈して失敗する。backup-db.sh と同じ理由）。
set -euo pipefail

CONF="${HOME}/.config/ai-helpdesk/api.conf"
PW_FILE=""
TEST_TO=""
UNIT_OVERRIDE=""
DO_RESTART=1
SKIP_VERIFY=0
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --conf) CONF="$2"; shift 2 ;;
    --file) PW_FILE="$2"; shift 2 ;;
    --test-to) TEST_TO="$2"; shift 2 ;;
    --no-restart) DO_RESTART=0; shift ;;
    --skip-verify) SKIP_VERIFY=1; shift ;;
    --unit)
      UNIT_OVERRIDE="${2:-}"
      # 先頭 '-' を許すと `--unit -h` が `systemctl restart -h` の 0 終了で偽成功する。
      if [ -z "$UNIT_OVERRIDE" ] || ! [[ "$UNIT_OVERRIDE" =~ ^[A-Za-z0-9_.@][A-Za-z0-9_.@-]*$ ]]; then
        echo "unit 名が不正です: ${2:-}（許可文字: 英数字 . _ @ -。先頭は - 以外）" >&2
        exit 2
      fi
      shift 2 ;;
    -h|--help) usage ;;
    *) echo "不明な引数: $1" >&2; exit 2 ;;
  esac
done

[ -f "$CONF" ] || { echo "設定ファイルがありません: $CONF" >&2; exit 1; }
# 後の処理は REPO_ROOT へ移動してから読むので、相対パスのまま渡さない。
CONF="$(realpath -- "$CONF")"

# ---- 書き換え前の検査: 再起動対象の決定（fail-closed） ----------------------
# restart は停止中の unit も起動するため、unit ファイルの有無では選ばない。
# rollback 後は prod unit が disabled でもファイルは残るので、ファイル存在で選ぶと
# 18950 を奪って rollback を巻き戻し得る。よって active な unit だけを対象にする。
SERVICE=""
if [ "$DO_RESTART" -eq 1 ]; then
  if [ -n "$UNIT_OVERRIDE" ]; then
    # 明示指定は利用者の判断を優先する（停止中の unit を起こす意図的な指定も許す）。
    SERVICE="$UNIT_OVERRIDE"
  else
    ACTIVE_UNITS=()
    for candidate in ai-helpdesk-prod-api.service ai-helpdesk-api.service; do
      if systemctl --user is-active --quiet -- "$candidate"; then
        ACTIVE_UNITS+=("$candidate")
      fi
    done
    case "${#ACTIVE_UNITS[@]}" in
      1) SERVICE="${ACTIVE_UNITS[0]}" ;;
      0)
        echo "再起動対象の active な unit が見つかりません（ai-helpdesk-prod-api / ai-helpdesk-api）。" >&2
        echo "SMTP_PASS は未更新です。unit を起動するか --unit <name> を指定するか、" >&2
        echo "--no-restart で設定だけ更新してください。" >&2
        exit 1
        ;;
      *)
        echo "active な unit が複数あります: ${ACTIVE_UNITS[*]}" >&2
        echo "SMTP_PASS は未更新です。--unit <name> で再起動対象を指定してください。" >&2
        exit 1
        ;;
    esac
  fi
fi

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
  # 対象は上の検査で決定済み（active 判定 or --unit 指定）。
  # set -e のままだと restart 失敗で即 abort し「設定は更新済み」を伝えられないため、明示的に受ける。
  if ! systemctl --user restart -- "$SERVICE"; then
    echo "❌ $SERVICE の再起動に失敗しました。SMTP_PASS は更新済みです。サービス状態を確認してください。" >&2
    exit 1
  fi
  sleep 2
  if systemctl --user is-active -- "$SERVICE" >/dev/null; then
    echo "✅ ${SERVICE%.service} を再起動しました"
  else
    echo "❌ $SERVICE が起動していません。SMTP_PASS は更新済みです。サービス状態を確認してください。" >&2
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
