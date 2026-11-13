#!/usr/bin/env bash
# One-time setup of a fresh Hetzner server (Ubuntu 24.04), run as root:
#   curl -fsSL https://raw.githubusercontent.com/caaconwinner/KOTHCROWN/main/deploy/hetzner/bootstrap.sh -o bootstrap.sh
#   bash bootstrap.sh
# Safe to run again. It does not start anything until /etc/crown/crown.env
# and /etc/crown/crank.json exist (see README.md).
set -euo pipefail
REPO=https://github.com/caaconwinner/KOTHCROWN.git

apt-get update
apt-get install -y ca-certificates curl git ufw caddy unattended-upgrades

# Node 22 (NodeSource) and pnpm (through corepack).
if ! node --version 2>/dev/null | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
corepack enable

# Firewall: SSH and HTTPS only. The API itself listens on localhost.
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# A user with no login for the services.
id crown >/dev/null 2>&1 || useradd --system --home /opt/crown --shell /usr/sbin/nologin crown
mkdir -p /etc/crown /var/lib/crown
chown crown:crown /var/lib/crown
chown root:crown /etc/crown
chmod 750 /etc/crown

# Code.
if [ ! -d /opt/crown/.git ]; then git clone "$REPO" /opt/crown; fi
git config --global --add safe.directory /opt/crown
cd /opt/crown
git pull --ff-only
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --frozen-lockfile --filter "@koth-crown/services..."
chown -R crown:crown /opt/crown

# Services and HTTPS.
cp deploy/hetzner/crown-api.service deploy/hetzner/crown-crank.service /etc/systemd/system/
cp deploy/hetzner/Caddyfile /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl reload caddy || systemctl restart caddy

if [ ! -f /etc/crown/crown.env ]; then
  cp deploy/hetzner/crown.env.example /etc/crown/crown.env
  chown root:crown /etc/crown/crown.env
  chmod 640 /etc/crown/crown.env
  echo "Now fill in /etc/crown/crown.env and put the crank keypair at /etc/crown/crank.json (see README.md)."
  exit 0
fi
if [ ! -f /etc/crown/game.json ]; then
  echo "Put the game wallet keypair at /etc/crown/game.json (see README.md), then run this again."
  exit 0
fi
chown crown:crown /etc/crown/game.json
chmod 600 /etc/crown/game.json
systemctl disable --now crown-crank 2>/dev/null || true
systemctl enable --now crown-api
systemctl restart crown-api
echo "Running. Check: curl -s https://api.takethecrown.fun/api/health"
