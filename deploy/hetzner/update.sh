#!/usr/bin/env bash
# Pulls the latest main and restarts both services. Run as root on the server.
set -euo pipefail
cd /opt/crown
sudo -u crown git pull --ff-only
sudo -u crown env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --frozen-lockfile --filter "@koth-crown/services..."
cp deploy/hetzner/crown-api.service deploy/hetzner/crown-crank.service /etc/systemd/system/
systemctl daemon-reload
systemctl restart crown-api crown-crank
sleep 5
curl -fsS http://127.0.0.1:8787/api/health && echo
