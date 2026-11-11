#!/usr/bin/env bash
# AI HelpDesk: immutable release deployer（Staging / 本番の共通手順）。
#
# 目的: 作業ツリーの汚れに依存せず、指定した commit だけから release を作り、
#       current シンボリックリンクを原子的に切り替え、health を確認する。
#       失敗時は直前の release へ自動で戻す。
#
# 使い方:
#   scripts/deploy-release.sh --repo <git repo> --ref <40hex commit> --root <release root> \
#     --env-file <0600 の EnvironmentFile> --unit <systemd --user unit> --health-port <port> \
#     [--migrate] [--seed] [--dry-run] [--keep N] [--unit-template <path>]
#
# 前提:
#   - Systemd の unit は WorkingDirectory=<root>/current, ExecStart=<root>/current/apps/api/dist/index.js。
#   - --env-file は NODE_ENV / DATABASE_URL / SESSION_SECRET 等を含む（値はログへ出さない）。
#   - 実行ユーザーの systemd --user と同一ユーザーで動かす。
#
# このスクリプトは秘密値を argv・標準出力・ログへ出さない。
set -euo pipefail
umask 077

fail() { printf 'ERROR: %s\n' "$1" >&2; exit 1; }
note() { printf '%s\n' "$1"; }

REPO='' REF='' ROOT='' ENV_FILE='' UNIT='' HEALTH_PORT='' UNIT_TEMPLATE=''
DO_MIGRATE=0 DO_SEED=0 DRY_RUN=0 KEEP=3

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo) REPO=${2:?--repo requires a value}; shift 2 ;;
    --ref) REF=${2:?--ref requires a value}; shift 2 ;;
    --root) ROOT=${2:?--root requires a value}; shift 2 ;;
    --env-file) ENV_FILE=${2:?--env-file requires a value}; shift 2 ;;
    --unit) UNIT=${2:?--unit requires a value}; shift 2 ;;
    --health-port) HEALTH_PORT=${2:?--health-port requires a value}; shift 2 ;;
    --keep) KEEP=${2:?--keep requires a value}; shift 2 ;;
    --unit-template) UNIT_TEMPLATE=${2:?--unit-template requires a value}; shift 2 ;;
    --migrate) DO_MIGRATE=1; shift ;;
    --seed) DO_SEED=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
done

# ---- 入力の検証（すべて失敗側に倒す） ----
[ -n "$REPO" ] && [ -n "$REF" ] && [ -n "$ROOT" ] && [ -n "$ENV_FILE" ] && [ -n "$UNIT" ] && [ -n "$HEALTH_PORT" ] \
  || fail 'missing required argument (--repo --ref --root --env-file --unit --health-port)'
[[ "$REF" =~ ^[a-f0-9]{40}$ ]] || fail 'ref must be a full 40-hex commit'
[[ "$UNIT" =~ ^[A-Za-z0-9_.@-]+$ ]] || fail 'invalid unit name'
[[ "$HEALTH_PORT" =~ ^[1-9][0-9]{3,4}$ ]] || fail 'invalid health port'
[[ "$KEEP" =~ ^[1-9][0-9]?$ ]] || fail 'keep must be 1-99'
[[ "$ROOT" = /* ]] || fail 'root must be an absolute path'
[ -d "$REPO" ] || fail 'repo directory not found'
git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1 || fail 'repo is not a git repository'
git -C "$REPO" cat-file -e "${REF}^{commit}" 2>/dev/null || fail 'ref is not a commit in repo'
[ -f "$ENV_FILE" ] || fail 'env file not found'
[ -O "$ENV_FILE" ] || fail 'env file must be owned by the current user'
case "$(stat -c '%a' "$ENV_FILE")" in
  600|400) ;;
  *) fail 'env file must be mode 0600 or 0400' ;;
esac
case "$ROOT" in
  /|/home|/tmp|/var|/usr) fail 'refusing to use a system directory as release root' ;;
esac

REPO=$(realpath -- "$REPO")
ENV_FILE=$(realpath -- "$ENV_FILE")

# --unit-template は __ENV_FILE__ を unit の EnvironmentFile に埋め込む。検証用の
# 一時ファイル（プレースホルダ）を渡すと、再起動後に環境変数不足でサービスが起動
# しない（2026-11-11 のインシデント）。build より前に、値は出さずキーだけ確認する。
if [ -n "$UNIT_TEMPLATE" ]; then
  [ -f "$UNIT_TEMPLATE" ] || fail "unit template not found: $UNIT_TEMPLATE"
  grep -q '^DATABASE_URL=' "$ENV_FILE" \
    || fail 'env file passed with --unit-template lacks DATABASE_URL; pass the real EnvironmentFile'
  grep -q '^SESSION_SECRET=' "$ENV_FILE" \
    || fail 'env file passed with --unit-template lacks SESSION_SECRET; pass the real EnvironmentFile'
fi

mkdir -p "$ROOT/releases" "$ROOT/state"
ROOT=$(realpath -- "$ROOT")
LOCK="$ROOT/.deploy.lock"
exec 9>"$LOCK"
flock -n 9 || fail 'another deploy is running (lock held)'

STAMP=$(date +%Y%m%dT%H%M%S)
SHORT=${REF:0:12}
RELEASE_ID="${STAMP}-${SHORT}"
RELEASE_DIR="$ROOT/releases/$RELEASE_ID"
PREVIOUS=''
if [ -L "$ROOT/current" ]; then
  PREVIOUS=$(readlink -f "$ROOT/current" 2>/dev/null || true)
fi

note "deploy: ref=$REF release=$RELEASE_ID root=$ROOT"
note "deploy: previous=${PREVIOUS:-none}"

# ---- 1. commit から release を組み立てる ----
build_release() {
  local tmp="$ROOT/releases/.tmp-${STAMP}-$$"
  rm -rf -- "$tmp"
  mkdir -p -- "$tmp"
  # 作業ツリーではなく commit の内容だけを使う（未 commit 差分・dirty build を配備しない）。
  git -C "$REPO" archive --format=tar "$REF" | tar -xf - -C "$tmp"
  [ -f "$tmp/package-lock.json" ] || fail 'package-lock.json missing in commit'
  (
    cd "$tmp"
    npm ci --no-audit --no-fund --ignore-scripts
    npm run build
  ) >&2
  [ -f "$tmp/apps/api/dist/index.js" ] || fail 'build did not produce apps/api/dist/index.js'
  # migration / seed は開発依存（tsx）を使うため、prune より前に実行する。
  if [ "$DO_MIGRATE" = 1 ]; then
    note 'migrate: applying DB migrations for this commit'
    ( cd "$tmp" && node scripts/run-with-env-file.mjs "$ENV_FILE" -- npx tsx scripts/migrate.ts ) >&2
  fi
  if [ "$DO_SEED" = 1 ]; then
    note 'seed: applying demo seed (idempotent upsert)'
    ( cd "$tmp" && node scripts/run-with-env-file.mjs "$ENV_FILE" -- npx tsx scripts/seed.ts ) >&2
  fi
  # 実行時に不要な開発依存を落として release を小さく・監査しやすくする。
  ( cd "$tmp" && npm prune --omit=dev --no-audit --no-fund ) >&2
  [ -d "$tmp/node_modules" ] || fail 'node_modules missing after build'
  node "$tmp/scripts/dist-manifest.mjs" --write --manifest "$tmp/dist-manifest.json" --commit "$REF" >&2
  node "$tmp/scripts/dist-manifest.mjs" --verify --manifest "$tmp/dist-manifest.json" --commit "$REF" >&2
  # 配信に必要な正本ファイルの存在（HTML/bridge/unit 参照）を最低限確認する。
  local html_count
  html_count=$(find "$tmp" -maxdepth 1 -name '*.html' -type f | wc -l)
  [ "$html_count" -ge 1 ] || fail 'prototype HTML missing in release'
  # COMMIT_SHA は env ファイルへ手書きせず、切替対象の release から供給する。
  {
    printf 'COMMIT_SHA=%s\n' "$REF"
    printf 'RELEASE_ID=%s\n' "$RELEASE_ID"
    printf 'RELEASE_BUILT_AT=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "$tmp/release.env"
  chmod 600 "$tmp/release.env"
  mv -T -- "$tmp" "$RELEASE_DIR"
  # release は生成後に書き換えない（誤編集・部分更新の検知を容易にする）。
  chmod -R a-w -- "$RELEASE_DIR"
  # 読み取り専用化した後でも manifest を再検証できること（退行防止）。
  node "$RELEASE_DIR/scripts/dist-manifest.mjs" --verify \
    --manifest "$RELEASE_DIR/dist-manifest.json" --commit "$REF" >&2
}

# ---- 2. 切り替えと health ----
switch_to() {
  local target=$1
  ln -sfn -- "$target" "$ROOT/.current.new"
  mv -Tf -- "$ROOT/.current.new" "$ROOT/current"
}

health_ok() {
  local expected=$1 deadline=$((SECONDS + 45)) body
  while [ "$SECONDS" -lt "$deadline" ]; do
    if body=$(curl -fsS -m 3 "http://127.0.0.1:${HEALTH_PORT}/api/health" 2>/dev/null); then
      if printf '%s' "$body" | node -e '
        let raw = "";
        process.stdin.on("data", (chunk) => { raw += chunk; });
        process.stdin.on("end", () => {
          try {
            const json = JSON.parse(raw);
            process.exit(json.ok === true && json.db === "ok" && json.commit === process.argv[1] ? 0 : 1);
          } catch {
            process.exit(1);
          }
        });
      ' "$expected"; then
        return 0
      fi
    fi
    sleep 2
  done
  return 1
}

record_deploy() {
  local result=$1
  node -e '
    const [root, id, ref, previous, result, healthPort] = process.argv.slice(1);
    const fs = require("node:fs");
    const path = require("node:path");
    const record = {
      releaseId: id,
      ref,
      previous: previous || null,
      result,
      healthPort: Number(healthPort),
      at: new Date().toISOString(),
    };
    const file = path.join(root, "state", `deploy-${id}.json`);
    fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    console.log(`DEPLOY_RECORD ${file}`);
  ' "$ROOT" "$RELEASE_ID" "$REF" "$PREVIOUS" "$result" "$HEALTH_PORT"
}

prune_releases() {
  local keep_paths
  keep_paths=$(find "$ROOT/releases" -maxdepth 1 -mindepth 1 -type d -name '[0-9]*' -printf '%T@ %p\n' \
    | sort -rn | head -n "$KEEP" | cut -d' ' -f2-)
  find "$ROOT/releases" -maxdepth 1 -mindepth 1 -type d -name '[0-9]*' -print0 \
    | while IFS= read -r -d '' dir; do
        case " $keep_paths " in
          *" $dir "*) ;;
          *)
            if [ -n "$PREVIOUS" ] && [ "$(realpath -- "$dir")" = "$PREVIOUS" ]; then continue; fi
            if [ "$(realpath -- "$dir")" = "$(realpath -m -- "$ROOT/current")" ]; then continue; fi
            # release は read-only（a-w）なので、削除前に所有者の書込を戻す。
            chmod -R u+w -- "$dir" 2>/dev/null || true
            rm -rf -- "$dir"
            note "prune: removed old release $(basename -- "$dir")"
            ;;
        esac
      done
}

# ---- 実行 ----
if [ -d "$RELEASE_DIR" ]; then
  note "release already exists; reusing $RELEASE_ID"
  if [ "$DO_MIGRATE" = 1 ] || [ "$DO_SEED" = 1 ]; then
    fail 'release already exists; migration/seed run inside build. remove the release to rebuild'
  fi
else
  build_release
fi

if [ "$DRY_RUN" = 1 ]; then
  record_deploy 'dry-run'
  note "dry-run: built $RELEASE_DIR (no switch, no restart)"
  exit 0
fi

# 任意: unit テンプレートから systemd user unit を配置する（本番の unit 新設を再現可能にする）。
if [ -n "$UNIT_TEMPLATE" ]; then
  [ -f "$UNIT_TEMPLATE" ] || fail "unit template not found: $UNIT_TEMPLATE"
  UNIT_DIR=$(dirname -- "$HOME/.config/systemd/user/$UNIT.service")
  mkdir -p -- "$UNIT_DIR"
  sed -e "s|__ROOT__|$ROOT|g" \
      -e "s|__STG_ROOT__|$ROOT|g" \
      -e "s|__PROD_ROOT__|$ROOT|g" \
      -e "s|__ENV_FILE__|$ENV_FILE|g" \
      -e "s|__STG_CONF__|$ENV_FILE|g" \
      -e "s|__NODE__|$(command -v node)|g" \
      -e "s|__NODE_DIR__|$(dirname -- "$(command -v node)")|g" \
      "$UNIT_TEMPLATE" > "$UNIT_DIR/$UNIT.service"
  chmod 644 -- "$UNIT_DIR/$UNIT.service"
  note "unit installed from template: $UNIT_DIR/$UNIT.service"
  systemctl --user daemon-reload
fi

switch_to "$RELEASE_DIR"
note 'restart: systemctl --user restart'
if ! systemctl --user restart "$UNIT"; then
  # restart に失敗した場合も current を直前の release へ戻す。
  # 戻さないと「起動しない release を指したまま」になり、次の deploy の PREVIOUS 基準も壊れる。
  printf 'ERROR: restart failed for %s; rolling back current\n' "$UNIT" >&2
  if [ -n "$PREVIOUS" ] && [ -d "$PREVIOUS" ]; then
    switch_to "$PREVIOUS"
    systemctl --user restart "$UNIT" || true
  fi
  record_deploy 'restart-failed'
  exit 1
fi

if health_ok "$REF"; then
  record_deploy 'success'
  note "deploy: OK $RELEASE_ID (commit=$REF)"
  prune_releases
  exit 0
fi

# ---- 失敗時は直前の release へ戻す（データは変更しない） ----
printf 'ERROR: health check failed after switch; rolling back\n' >&2
if [ -n "$PREVIOUS" ] && [ -d "$PREVIOUS" ]; then
  switch_to "$PREVIOUS"
  systemctl --user restart "$UNIT" || true
  PREVIOUS_REF=$(node -e 'const m=require(process.argv[1]);console.log(m.commit)' "$PREVIOUS/dist-manifest.json" 2>/dev/null || true)
  if [ -n "$PREVIOUS_REF" ] && health_ok "$PREVIOUS_REF"; then
    record_deploy 'rolled-back'
    printf 'ERROR: deployed release failed health; rolled back to %s\n' "$(basename -- "$PREVIOUS")" >&2
  else
    record_deploy 'rollback-failed'
    printf 'ERROR: rollback release did not pass health either; manual action required\n' >&2
  fi
else
  record_deploy 'failed-no-previous'
  printf 'ERROR: no previous release to roll back to\n' >&2
fi
exit 1
