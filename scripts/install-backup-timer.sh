#!/usr/bin/env bash
# AI HelpDesk の DB バックアップ timer を systemd user に登録する（冪等）。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$UNIT_DIR"
install -m 0644 "$ROOT/ops/systemd/ai-helpdesk-backup.service" "$UNIT_DIR/"
install -m 0644 "$ROOT/ops/systemd/ai-helpdesk-backup.timer" "$UNIT_DIR/"
systemctl --user daemon-reload
systemctl --user enable --now ai-helpdesk-backup.timer
systemctl --user list-timers ai-helpdesk-backup.timer --no-pager
