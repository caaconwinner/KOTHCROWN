#!/usr/bin/env bash
# Pulls the latest main and restarts the game. Run as root on the server.
set -euo pipefail
cd /opt/crown
git config --global --add safe.directory /opt/crown
git pull --ff-only
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --frozen-lockfile --filter "@koth-crown/services..." >/dev/null
# Files touched as root (pulls, installs) go back to the service user.
chown -R crown:crown /opt/crown
cp deploy/hetzner/crown-api.service /etc/systemd/system/
systemctl daemon-reload
systemctl restart crown-api
sleep 8
curl -fsS http://127.0.0.1:8787/api/health && echo
