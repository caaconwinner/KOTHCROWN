#!/usr/bin/env bash
# Starts the fork validator, runs the end-to-end script, and repeats while the
# script keeps discovering mainnet accounts it needs cloned.
set -uo pipefail
cd "$(dirname "$0")/../.."
for attempt in $(seq 1 15); do
  pkill -f solana-test-validator 2>/dev/null; sleep 1
  scripts/fork/validator.sh > .fork/validator.log 2>&1 &
  for _ in $(seq 1 90); do solana -u localhost cluster-version >/dev/null 2>&1 && break; sleep 1; done
  sleep 3
  pnpm -s tsx scripts/fork/e2e.ts; code=$?
  [ "$code" -ne 42 ] && break
done
pkill -f solana-test-validator 2>/dev/null
exit "$code"
