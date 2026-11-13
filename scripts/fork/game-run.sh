#!/usr/bin/env bash
# Starts the fork validator and runs the server-run game check against it.
set -uo pipefail
cd "$(dirname "$0")/../.."
pkill -f solana-test-validator 2>/dev/null; sleep 1
mkdir -p .fork
scripts/fork/validator.sh > .fork/validator.log 2>&1 &
for _ in $(seq 1 90); do solana -u localhost cluster-version >/dev/null 2>&1 && break; sleep 1; done
sleep 3
pnpm -s tsx scripts/fork/game-check.ts; code=$?
pkill -f solana-test-validator 2>/dev/null
exit "$code"
