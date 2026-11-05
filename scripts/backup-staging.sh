#!/usr/bin/env bash
# AI HelpDesk Staging: 専用 DB の dump を取得する（本番 backup と混ぜない）。
#
# - 接続先は staging 設定ファイルの DATABASE_URL だけを使う。
# - DB 名・port・host を照合し、staging 以外（本番相当）へは接続しない。
# - 出力は $STG_ROOT/shared/backup（0700）、dump は 0600、保持 7 日。
# - 本番ディレクトリ・本番 DB・本番 unit には触れない。
set -euo pipefail
umask 077

CONF=${AIHD_STG_CONF:-$HOME/.config/ai-helpdesk/stg-api.conf}
STG_ROOT=${AIHD_STG_ROOT:-$HOME/ai-helpdesk-stg}
BACKUP_DIR=${AIHD_STG_BACKUP_DIR:-$STG_ROOT/shared/backup}
KEEP_DAYS=${AIHD_STG_BACKUP_KEEP_DAYS:-7}
PG_BIN=/usr/lib/postgresql/16/bin
EXPECTED_DB=ai_helpdesk_stg
EXPECTED_PORT=5437

fail() { printf 'ERROR: %s\n' "$1" >&2; exit 1; }

[ -f "$CONF" ] || fail "staging config not found: $CONF"
case "$(stat -c '%a' "$CONF")" in 600|400) ;; *) fail 'staging config must be 0600/0400' ;; esac

DB_URL=$(sed -n 's/^DATABASE_URL=//p' "$CONF" | head -1)
[ -n "$DB_URL" ] || fail 'DATABASE_URL is not set in staging config'

# postgresql://user:pass@host:port/dbname を分解（値は出力しない）
URL_RE='^postgres(ql)?://[^@]*@([^:/]+):([0-9]+)/([^?]+).*'
HOST=$(printf '%s' "$DB_URL" | sed -E "s|$URL_RE|\\2|")
PORT=$(printf '%s' "$DB_URL" | sed -E "s|$URL_RE|\\3|")
DBNAME=$(printf '%s' "$DB_URL" | sed -E "s|$URL_RE|\\4|")
[ "$HOST" = '127.0.0.1' ] || fail "refusing non-loopback host"
[ "$PORT" = "$EXPECTED_PORT" ] || fail "refusing unexpected port"
[ "$DBNAME" = "$EXPECTED_DB" ] || fail "refusing unexpected database"
[[ "$KEEP_DAYS" =~ ^[0-9]+$ ]] || fail 'keep days must be numeric'

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
TS=$(date +%Y%m%d-%H%M%S)
OUT="$BACKUP_DIR/${DBNAME}-${TS}.dump"
TMP="$BACKUP_DIR/.${DBNAME}-${TS}.dump.tmp"

if ! "$PG_BIN/pg_dump" --format=custom --no-owner --no-privileges --file="$TMP" "$DB_URL"; then
  rm -f -- "$TMP"
  fail 'pg_dump failed'
fi
chmod 600 "$TMP"
mv -T -- "$TMP" "$OUT"
SIZE=$(stat -c '%s' "$OUT")
SHA=$(sha256sum "$OUT" | cut -d' ' -f1)

# 取得した dump が同じ DB 名を含むことを確認（取り違え検知）
"$PG_BIN/pg_restore" --list "$OUT" > /dev/null || fail 'pg_restore --list failed'

LOG="$BACKUP_DIR/backup.log"
printf '%s OK db=%s file=%s bytes=%s sha256=%s keep=%sd\n' \
  "$(date -Is)" "$DBNAME" "$(basename -- "$OUT")" "$SIZE" "$SHA" "$KEEP_DAYS" >> "$LOG"
chmod 600 "$LOG"

find "$BACKUP_DIR" -maxdepth 1 -type f -name "${DBNAME}-*.dump" -mtime +"$KEEP_DAYS" -delete
printf 'backup ok: %s (%s bytes, sha256 %s)\n' "$(basename -- "$OUT")" "$SIZE" "$SHA"
