#!/usr/bin/env bash
# Local validator with the real pump.fun programs and the Crown program.
# pump.fun's programs are dumped from mainnet once into .fork/ (read-only RPC
# calls, no transactions). Accounts listed in accounts.txt are cloned from
# mainnet at startup. Nothing here touches mainnet state or spends SOL.
set -euo pipefail
cd "$(dirname "$0")/../.."
RPC="${MAINNET_RPC:-https://api.mainnet-beta.solana.com}"
PUMP=6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
AMM=pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA
FEES=pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ
CROWN=$(solana-keygen pubkey target/deploy/crown-keypair.json)
AUTH=11111111111111111111111111111111

mkdir -p .fork
for p in $PUMP $AMM $FEES; do
  [ -s ".fork/$p.so" ] || solana program dump -u "$RPC" "$p" ".fork/$p.so" >/dev/null
done

args=()
while read -r kind key; do
  case "$kind" in
    acct) args+=(--maybe-clone "$key") ;;
    prog) args+=(--clone-upgradeable-program "$key") ;;
  esac
done < scripts/fork/accounts.txt

exec solana-test-validator --reset --quiet --ledger .fork/ledger --url "$RPC" \
  --upgradeable-program $PUMP ".fork/$PUMP.so" $AUTH \
  --upgradeable-program $AMM ".fork/$AMM.so" $AUTH \
  --upgradeable-program $FEES ".fork/$FEES.so" $AUTH \
  --bpf-program "$CROWN" target/deploy/crown.so \
  "${args[@]}"
