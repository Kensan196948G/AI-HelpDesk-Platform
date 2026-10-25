#!/usr/bin/env bash
# Tunnel と API の間に置くローカル・プロキシ（X-Proxy-Secret 付与）を systemd user に登録する。
# 事前に ~/.config/ai-helpdesk/api.conf へ PROXY_SECRET（16 文字以上）を設定しておくこと。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$UNIT_DIR"
install -m 0644 "$ROOT/ops/systemd/ai-helpdesk-proxy.service" "$UNIT_DIR/"
systemctl --user daemon-reload
systemctl --user enable --now ai-helpdesk-proxy.service
sleep 1
curl -fsS -m 5 http://127.0.0.1:18949/api/health >/dev/null
echo "proxy ok: http://127.0.0.1:18949 -> http://127.0.0.1:18950"
