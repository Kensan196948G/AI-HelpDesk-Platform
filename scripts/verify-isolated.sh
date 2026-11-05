#!/usr/bin/env bash
# 新規の使い捨て PG16 だけで検証する。既存 .env・DB・サービス・公開設定は読まない/変更しない。
set -euo pipefail
umask 077
case "${1:-}" in
  --ack-isolated-worktree) ;;
  *) printf 'usage: verify-isolated.sh --ack-isolated-worktree (never use the live checkout)\n' >&2; exit 2 ;;
esac
test "$#" = 1 || exit 2
# 資格情報を生成する前に環境を一度だけ空にする。以後、秘密を env コマンドの argv に入れない。
if test "${AIHD_VERIFY_CLEAN:-}" != 1; then
  exec env -i "PATH=$PATH" AIHD_VERIFY_CLEAN=1 /bin/bash "$0" "$@"
fi
unset AIHD_VERIFY_CLEAN
ROOT=$(realpath -- "$(dirname -- "$0")/..")
test "$(pwd -P)" = "$ROOT" || { printf 'run from the isolated worktree root\n' >&2; exit 2; }
cd "$ROOT"
# main の live checkout の誤実行を拒否。任意の linked live 配備の検出を保証するものではない。
test -f "$ROOT/.git" && ! test -L "$ROOT/.git" || { printf 'linked isolated worktree required\n' >&2; exit 2; }
test "$(realpath -- "$(git rev-parse --show-toplevel)")" = "$ROOT" || exit 2
case "$(git branch --show-current)" in
  feat/cto-readiness-*|fix/cto-followup-*) ;;
  *) printf 'dedicated CTO readiness/followup branch required\n' >&2; exit 2 ;;
esac
PG_BIN=/usr/lib/postgresql/16/bin
NODE=$(command -v node)
NPM=$(command -v npm)
for bin in initdb pg_ctl createdb psql; do
  test -x "$PG_BIN/$bin" || { printf 'missing PostgreSQL 16 tool: %s\n' "$bin" >&2; exit 2; }
done
# dotenv の隠れた値を使わない。production smoke の .env fallback も禁止する。
for file in .env .env.local .env.test.local; do
  if test -e "$ROOT/$file" || test -L "$ROOT/$file"; then
    printf 'refusing worktree with local environment files\n' >&2
    exit 2
  fi
done
test -d "$ROOT/node_modules" && ! test -L "$ROOT/node_modules" || { printf 'run npm ci in the isolated worktree first\n' >&2; exit 2; }
BASE=$(mktemp -d /tmp/aihd-verify.XXXXXXXX)
BASE=$(realpath -- "$BASE")
[[ "$BASE" =~ ^/tmp/aihd-verify\.[A-Za-z0-9]{8}$ ]] || exit 2
# step の成否だけを残す（token・DSN・コマンド全文は書かない）。
SUMMARY="$BASE/summary"
mkdir -m 700 "$BASE/home" "$BASE/socket"
export HOME="$BASE/home" LANG=C.UTF-8 TZ=Asia/Tokyo PGCONNECT_TIMEOUT=5
PASSFILE="$BASE/password"
# 合成資格情報。出力せずファイルと子プロセスの環境だけに渡す（argv に含めない）。
PASSWORD=$("$NODE" -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")
printf '%s\n' "$PASSWORD" > "$PASSFILE"
PORT=$("$NODE" --input-type=module -e "import net from 'node:net';const s=net.createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
DBNAME=aihd_test_$("$NODE" -e "process.stdout.write(require('node:crypto').randomBytes(8).toString('hex'))")
PG_STARTED=false
cleanup() {
  local result=$?
  trap - EXIT INT TERM
  if test "$PG_STARTED" = true; then
    # 停止の対象は自分が生成した絶対パスだけ。別 PGDATA/PID を停止しない。
    if test "$(realpath -- "$BASE/pgdata")" != "$BASE/pgdata" || test -L "$BASE/pgdata"; then
      printf 'cleanup: scratch identity mismatch; no stop attempted\n' >&2
      result=1
    else
      if ! timeout --kill-after=5s 25s "$PG_BIN/pg_ctl" -D "$BASE/pgdata" -m fast -w -t 20 stop > "$BASE/stop.log" 2>&1; then
        timeout --kill-after=5s 15s "$PG_BIN/pg_ctl" -D "$BASE/pgdata" -m immediate -w -t 10 stop >> "$BASE/stop.log" 2>&1 || result=1
      fi
      if test -e "$BASE/pgdata/postmaster.pid" || "$PG_BIN/pg_ctl" -D "$BASE/pgdata" status > /dev/null 2>&1; then
        printf 'cleanup: isolated PostgreSQL may remain; inspect private scratch\n' >&2
        result=1
      elif "$NODE" --input-type=module -e "import net from 'node:net';const s=net.connect({host:'127.0.0.1',port:Number(process.argv[1])});s.setTimeout(1000);s.on('connect',()=>{s.destroy();process.exit(1)});s.on('error',()=>process.exit(0));s.on('timeout',()=>{s.destroy();process.exit(1)})" "$PORT"; then
        printf 'cleanup: isolated PostgreSQL stopped; owned port closed\n'
      else
        printf 'cleanup: port still reachable (no unrelated process is stopped)\n' >&2
        result=1
      fi
    fi
  fi
  # private scratch を保持する。削除・既存DBのDROP・既存PIDへのkillは一切しない。
  # 最終行は exit code（token・DSNは書かない）。
  if test -n "${SUMMARY:-}" && test -d "$BASE"; then
    printf 'exit=%s\n' "$result" >> "$SUMMARY"
  fi
  printf 'evidence directory (private 0700): %s\n' "$BASE"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
printf 'isolated verification: new PG16 cluster, synthetic data only\n'
timeout --kill-after=5s 60s "$PG_BIN/initdb" -D "$BASE/pgdata" -U aihd_verify --auth=scram-sha-256 --pwfile="$PASSFILE" --no-locale --encoding=UTF8 > "$BASE/initdb.log" 2>&1
# 開始が失敗した場合にも postmaster が残る可能性があるため、開始試行前に cleanup を有効にする。
PG_STARTED=true
timeout --kill-after=5s 25s "$PG_BIN/pg_ctl" -D "$BASE/pgdata" -l "$BASE/postgres.log" -w -t 20 -o "-h 127.0.0.1 -p $PORT -k $BASE/socket" start > "$BASE/start.log" 2>&1
PGPASSWORD="$PASSWORD" timeout --kill-after=5s 15s "$PG_BIN/createdb" -w -h 127.0.0.1 -p "$PORT" -U aihd_verify -- "$DBNAME"
# 明示した新規クラスタの実DBを照合し、他DBは参照しない。
ACTUAL=$(PGPASSWORD="$PASSWORD" timeout --kill-after=5s 15s "$PG_BIN/psql" -X -w -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$PORT" -U aihd_verify -d "$DBNAME" -Atqc 'SELECT current_database()')
test "$ACTUAL" = "$DBNAME" || { printf 'database identity mismatch\n' >&2; exit 1; }
# 所有証明: 新規 DB の comment にだけ刻印し、staging-smoke が同じ token を読めることを確認する。
# token は argv に出さない（psql へは stdin で渡す）。刻印・確認の出力も token を出さない。
SMOKE_OWNER_TOKEN=$("$NODE" -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")
[[ "$SMOKE_OWNER_TOKEN" =~ ^[a-f0-9]{64}$ ]] || { printf 'owner token generation failed\n' >&2; exit 1; }
printf "COMMENT ON DATABASE \"%s\" IS 'smoke-owner:%s';\n" "$DBNAME" "$SMOKE_OWNER_TOKEN" \
  | PGPASSWORD="$PASSWORD" timeout --kill-after=5s 15s "$PG_BIN/psql" -X -w -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$PORT" -U aihd_verify -d "$DBNAME" -q > /dev/null
OWNER_COMMENT=$(printf '%s\n' "SELECT shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = current_database();" \
  | PGPASSWORD="$PASSWORD" timeout --kill-after=5s 15s "$PG_BIN/psql" -X -w -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$PORT" -U aihd_verify -d "$DBNAME" -Atq)
test "$OWNER_COMMENT" = "smoke-owner:$SMOKE_OWNER_TOKEN" || { printf 'database ownership proof mismatch\n' >&2; exit 1; }
export NODE_ENV=test DATABASE_URL="postgresql://aihd_verify:${PASSWORD}@127.0.0.1:${PORT}/${DBNAME}"
export AIHD_TEST_DATABASE_NAME="$DBNAME" SESSION_SECRET=synthetic-session-secret-0123456789abcdef
export SEED_PASSWORD=synthetic-seed-password LOG_LEVEL=silent COOKIE_SECURE=false REQUIRE_PROXY_SECRET=false
export MAIL_TRANSPORT=disabled AUDIT_KNOWN_BREAKS= MIRAI_INFO_DATABASE_URL="$DATABASE_URL"
export DEEPSEEK_BASE_URL=http://127.0.0.1:1 RSP_BASE_URL=http://127.0.0.1:1
run_step() {
  local name=$1
  shift
  printf 'step: %s\n' "$name"
  if timeout --signal=TERM --kill-after=10s 600s "$@" > "$BASE/$name.log" 2>&1; then
    printf 'PASS: %s\n' "$name"
    printf 'PASS: %s\n' "$name" >> "$SUMMARY"
  else
    local status=$?
    printf 'FAIL: %s (exit=%s; log in private evidence directory)\n' "$name" "$status" >&2
    printf 'FAIL: %s (exit=%s)\n' "$name" "$status" >> "$SUMMARY"
    return "$status"
  fi
}
run_step pure "$NPM" run test:pure
run_step migrate-first "$NPM" run db:migrate
run_step migrate-second "$NPM" run db:migrate
run_step typecheck "$NPM" run typecheck
run_step lint "$NPM" run lint
run_step test "$NPM" test
run_step build "$NPM" run build
# build 直後の dist を HEAD に束縛する。staging-smoke はこの manifest の commit と全 hash を検証し、
# COMMIT_SHA にも manifest.commit を使う（stale dist の自己申告 PASS を防ぐ）。
HEAD_SHA=$(git rev-parse HEAD)
[[ "$HEAD_SHA" =~ ^[a-f0-9]{40}$ ]] || { printf 'commit invalid\n' >&2; exit 1; }
DIST_MANIFEST="$BASE/dist-manifest.json"
run_step dist-manifest "$NODE" scripts/dist-manifest.mjs --write --manifest "$DIST_MANIFEST" --commit "$HEAD_SHA"
# 所有証明 token と manifest path は、staging-smoke の直前まで env に載せない。
export AIHD_SMOKE_OWNER_TOKEN="$SMOKE_OWNER_TOKEN"
export AIHD_DIST_MANIFEST="$DIST_MANIFEST"
# 接続先は同じ新規クラスタだが、アプリを production/Access enforce/off 既定で起動する。
# 実 Access ログイン・JWT鍵取得・外部API・人間による受入は実行しない。
SMOKE_STATUS=0
run_step staging-smoke "$NODE" scripts/staging-smoke.mjs || SMOKE_STATUS=$?
# smoke 後は token / manifest path を cleanup の子プロセスへ継承させない（失敗時も同じ）。
unset AIHD_SMOKE_OWNER_TOKEN AIHD_DIST_MANIFEST
test "$SMOKE_STATUS" = 0 || exit "$SMOKE_STATUS"
printf 'PASS: isolated verification completed (not authenticated Staging acceptance)\n'
printf 'completed\n' >> "$SUMMARY"
