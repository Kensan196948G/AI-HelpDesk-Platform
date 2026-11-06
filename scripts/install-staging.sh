#!/usr/bin/env bash
# AI HelpDesk: 独立 Staging 環境の初期構築（冪等・本番非変更）。
#
# 作るもの（すべてホスト内で完結し、公開経路は作らない）:
#   - 専用 PostgreSQL 16 クラスタ（127.0.0.1:5437, PGDATA=<root>/pgdata）
#   - DB ai_helpdesk_stg（専用 role aihd_stg / 専用パスワード）
#   - systemd --user unit: ai-helpdesk-stg-postgres / -stg-api / -stg-proxy
#   - 設定ファイル ~/.config/ai-helpdesk/stg-api.conf（0600、秘密は生成して書くだけ）
#
# 作らないもの: Cloudflare Tunnel / DNS / Access アプリ / 本番 unit の変更。
# それらは別承認・別手順（docs/77）。
set -euo pipefail
umask 077

fail() { printf 'ERROR: %s\n' "$1" >&2; exit 1; }
note() { printf '%s\n' "$1"; }

DRY_RUN=0
[ "${1:-}" = '--dry-run' ] && DRY_RUN=1

STG_ROOT=${AIHD_STG_ROOT:-$HOME/ai-helpdesk-stg}
CONF_DIR=${AIHD_STG_CONF_DIR:-$HOME/.config/ai-helpdesk}
CONF="$CONF_DIR/stg-api.conf"
ALLOWLIST="$CONF_DIR/stg-access-allowlist.txt"
PG_PORT=5437
API_PORT=18952
PROXY_PORT=18951
DB_NAME=ai_helpdesk_stg
DB_ROLE=aihd_stg
PG_BIN=/usr/lib/postgresql/16/bin
NODE_BIN=$(command -v node || true)
UNIT_DIR=$HOME/.config/systemd/user
REPO_SRC=$(cd "$(dirname -- "$0")/.." && pwd)

[[ "$STG_ROOT" = /* ]] || fail 'staging root must be absolute'
case "$STG_ROOT" in /|/home|/tmp|/var|/usr) fail 'refusing a system directory as staging root' ;; esac
for bin in initdb pg_ctl createdb psql; do
  [ -x "$PG_BIN/$bin" ] || fail "missing PostgreSQL 16 binary: $bin"
done
[ -n "$NODE_BIN" ] || fail 'node not found in PATH'

note "staging root: $STG_ROOT"
note "postgres port: $PG_PORT / api port: $API_PORT / proxy port: $PROXY_PORT"

if [ "$DRY_RUN" = 1 ]; then
  note 'dry-run: would create directories, cluster, database, units and config (nothing changed)'
  exit 0
fi

# ---- 1. ディレクトリ ----
mkdir -p "$STG_ROOT/releases" "$STG_ROOT/state" "$STG_ROOT/run" "$CONF_DIR"
chmod 700 "$STG_ROOT" "$STG_ROOT/state" "$STG_ROOT/run" "$CONF_DIR"

# ---- 2. 設定ファイル（秘密は初回だけ生成し、以後は読み取りのみ） ----
if [ ! -f "$CONF" ]; then
  DB_PASSWORD=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')
  SESSION_SECRET=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
  PROXY_SECRET=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
  SEED_PASSWORD=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
  DATABASE_URL="postgresql://${DB_ROLE}:${DB_PASSWORD}@127.0.0.1:${PG_PORT}/${DB_NAME}"
  cat > "$CONF" <<EOF
# AI HelpDesk Staging（生成物。リポジトリへコミットしない）
NODE_ENV=production
PORT=${API_PORT}
HOST=127.0.0.1
AUTH_MODE=cloudflare-access
# 公開 Staging の Access アプリを作るまでは JWT を検証しない（loopback 限定・別承認で有効化）。
ACCESS_JWT_MODE=off
ACCESS_ALLOWLIST_FILE=${ALLOWLIST}
DATABASE_URL=${DATABASE_URL}
MIRAI_INFO_DATABASE_URL=${DATABASE_URL}
SESSION_SECRET=${SESSION_SECRET}
REQUIRE_PROXY_SECRET=true
PROXY_SECRET=${PROXY_SECRET}
ALLOWED_ORIGINS=http://127.0.0.1:${PROXY_PORT}
# 公開 Staging（https）を作る際に true へ変更する。
COOKIE_SECURE=false
LOG_LEVEL=info
# Staging は外部サービスへ接続しない（本番の資格情報を使わない）。
DEEPSEEK_BASE_URL=http://127.0.0.1:1
MAIL_TRANSPORT=disabled
RSP_BASE_URL=http://127.0.0.1:1
ALLOW_SELF_APPROVAL=false
FOLDER_ACCESS_ENABLED=false
AUDIT_KNOWN_BREAKS=
NOTIFY_BASE_URL=http://127.0.0.1:${PROXY_PORT}
SEED_PASSWORD=${SEED_PASSWORD}
EOF
  chmod 600 "$CONF"
  note "config written: $CONF (0600)"
else
  note "config exists: $CONF (not modified)"
fi

if [ ! -f "$ALLOWLIST" ]; then
  printf 'synthetic-staging@example.invalid\n' > "$ALLOWLIST"
  chmod 600 "$ALLOWLIST"
  note "staging allowlist written: $ALLOWLIST (synthetic only)"
fi

DB_PASSWORD=$(sed -n "s|^DATABASE_URL=postgresql://${DB_ROLE}:\([a-f0-9]*\)@.*|\1|p" "$CONF")
[ -n "$DB_PASSWORD" ] || fail 'could not read staging DB password from config'

# ---- 3. PostgreSQL クラスタ ----
if [ ! -f "$STG_ROOT/pgdata/PG_VERSION" ]; then
  note 'initdb: creating dedicated staging cluster'
  PW_FILE=$(mktemp)
  printf '%s\n' "$DB_PASSWORD" > "$PW_FILE"
  trap 'rm -f "$PW_FILE"' EXIT
  "$PG_BIN/initdb" -D "$STG_ROOT/pgdata" -U "$DB_ROLE" \
    --auth=scram-sha-256 --pwfile="$PW_FILE" --no-locale --encoding=UTF8 \
    > "$STG_ROOT/state/initdb.log" 2>&1
  rm -f "$PW_FILE"
  trap - EXIT
  chmod 700 "$STG_ROOT/pgdata"
else
  note 'initdb: existing cluster found (not re-initialized)'
fi
# 専用クラスタ設定（initdb 済みでも冪等に上書きする）
cat > "$STG_ROOT/pgdata/postgresql.auto.conf" <<EOF
# managed by ai-helpdesk install-staging.sh
port = ${PG_PORT}
listen_addresses = '127.0.0.1'
unix_socket_directories = '${STG_ROOT}/run'
EOF
chmod 600 "$STG_ROOT/pgdata/postgresql.auto.conf"

# ---- 4. systemd --user unit ----
mkdir -p "$UNIT_DIR"
install_unit() {
  local src=$1 dst=$2
  sed -e "s|__STG_ROOT__|$STG_ROOT|g" \
      -e "s|__STG_CONF__|$CONF|g" \
      -e "s|__NODE__|$NODE_BIN|g" \
      -e "s|__NODE_DIR__|$(dirname -- "$NODE_BIN")|g" \
      -e "s|__CLOUDFLARED__|$(command -v cloudflared || true)|g" \
      -e "s|__CFG_DIR__|$HOME/.cloudflared|g" \
      "$src" > "$dst"
  chmod 644 "$dst"
  note "unit installed: $dst"
}
install_unit "$REPO_SRC/ops/systemd/ai-helpdesk-stg-postgres.service" "$UNIT_DIR/ai-helpdesk-stg-postgres.service"
install_unit "$REPO_SRC/ops/systemd/ai-helpdesk-stg-api.service" "$UNIT_DIR/ai-helpdesk-stg-api.service"
install_unit "$REPO_SRC/ops/systemd/ai-helpdesk-stg-proxy.service" "$UNIT_DIR/ai-helpdesk-stg-proxy.service"
install_unit "$REPO_SRC/ops/systemd/ai-helpdesk-stg-backup.service" "$UNIT_DIR/ai-helpdesk-stg-backup.service"
install_unit "$REPO_SRC/ops/systemd/ai-helpdesk-stg-backup.timer" "$UNIT_DIR/ai-helpdesk-stg-backup.timer"
install_unit "$REPO_SRC/ops/systemd/ai-helpdesk-stg-restore-drill.service" "$UNIT_DIR/ai-helpdesk-stg-restore-drill.service"
install_unit "$REPO_SRC/ops/systemd/ai-helpdesk-stg-restore-drill.timer" "$UNIT_DIR/ai-helpdesk-stg-restore-drill.timer"
install_unit "$REPO_SRC/ops/systemd/ai-helpdesk-stg-healthcheck.service" "$UNIT_DIR/ai-helpdesk-stg-healthcheck.service"
install_unit "$REPO_SRC/ops/systemd/ai-helpdesk-stg-healthcheck.timer" "$UNIT_DIR/ai-helpdesk-stg-healthcheck.timer"
# 公開 Staging の tunnel unit は、tunnel と config が既にある場合だけ配置する。
# このスクリプトは Cloudflare 側（tunnel/DNS/Access）を作らない（docs/84 の手順で作成）。
if [ -f "$HOME/.cloudflared/ai-helpdesk-stg-config.yml" ]; then
  install_unit "$REPO_SRC/ops/systemd/ai-helpdesk-stg-cloudflared.service" "$UNIT_DIR/ai-helpdesk-stg-cloudflared.service"
else
  note 'skip: staging tunnel config not found (public staging is not created by this script)'
fi
systemctl --user daemon-reload

STG_TIMERS=(
  ai-helpdesk-stg-backup.timer
  ai-helpdesk-stg-restore-drill.timer
  ai-helpdesk-stg-healthcheck.timer
)
if [ -L "$STG_ROOT/current" ]; then
  systemctl --user enable --now "${STG_TIMERS[@]}"
  note 'staging timers enabled and started'
else
  # unit は release 内の script を指すため、release が無い状態で start すると失敗する。
  systemctl --user enable "${STG_TIMERS[@]}"
  note 'staging timers enabled but not started: deploy a release first, then systemctl --user start them'
fi

# ---- 5. 起動と DB 作成 ----
systemctl --user enable --now ai-helpdesk-stg-postgres.service
for _ in $(seq 1 30); do
  if PGPASSWORD="$DB_PASSWORD" "$PG_BIN/psql" -X -w -h 127.0.0.1 -p "$PG_PORT" -U "$DB_ROLE" -d postgres -Atqc 'SELECT 1' >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
PGPASSWORD="$DB_PASSWORD" "$PG_BIN/psql" -X -w -h 127.0.0.1 -p "$PG_PORT" -U "$DB_ROLE" -d postgres -Atqc 'SELECT 1' >/dev/null \
  || fail 'staging PostgreSQL did not become ready'
EXISTS=$(PGPASSWORD="$DB_PASSWORD" "$PG_BIN/psql" -X -w -h 127.0.0.1 -p "$PG_PORT" -U "$DB_ROLE" -d postgres -Atqc \
  "SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'")
if [ "$EXISTS" != 1 ]; then
  PGPASSWORD="$DB_PASSWORD" "$PG_BIN/createdb" -w -h 127.0.0.1 -p "$PG_PORT" -U "$DB_ROLE" -- "$DB_NAME"
  note "database created: $DB_NAME"
else
  note "database exists: $DB_NAME"
fi

# 所有証明（このスクラッチ DB が staging 用であることの刻印。秘密ではない）
OWNER=$(PGPASSWORD="$DB_PASSWORD" "$PG_BIN/psql" -X -w -h 127.0.0.1 -p "$PG_PORT" -U "$DB_ROLE" -d "$DB_NAME" -Atqc \
  "SELECT shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = current_database();")
note "staging db owner comment: ${OWNER:-<none>}"

# ---- 6. 次の手順 ----
cat <<EOF

install-staging: OK

次に release を配備する（例）:
  scripts/deploy-release.sh \\
    --repo $(printf '%q' "$REPO_SRC") \\
    --ref \$(git -C $(printf '%q' "$REPO_SRC") rev-parse origin/main) \\
    --root $(printf '%q' "$STG_ROOT") \\
    --env-file $(printf '%q' "$CONF") \\
    --unit ai-helpdesk-stg-api \\
    --health-port ${API_PORT} --migrate --seed

起動確認:
  systemctl --user start ai-helpdesk-stg-proxy
  curl -fsS http://127.0.0.1:${API_PORT}/api/health
  curl -fsS http://127.0.0.1:${PROXY_PORT}/api/health

公開経路（Tunnel/DNS/Access）は未作成。docs/77 の承認手順を参照。
EOF
