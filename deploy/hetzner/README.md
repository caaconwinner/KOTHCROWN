# Game server on Hetzner

Since 2026-11-13 the crown game runs on our server instead of a Solana program (no SOL for the program's rent deposit). One process, `crown-api` (`services/crown/src/game/main.ts`), does everything:

- holds the **game wallet**: it creates the coin, receives 85% of the creator fees and every crown payment, and sends every payout;
- answers the website (`/api/crown`, `/api/history`, `/api/tx/take`, `/api/claim`, `/api/health`);
- every 3 s reads new payments (a takeover, or a full refund if someone took the crown first) and sends payouts;
- every minute collects pump.fun's fees and runs the buy-and-burn.

Caddy serves it over HTTPS at `api.takethecrown.fun`.

## 1. Server and DNS

Hetzner Cloud, Ubuntu 24.04, the smallest plan. Point an `A` record `api.takethecrown.fun` at its IPv4.

## 2. Install

```bash
ssh root@SERVER_IP
curl -fsSL https://raw.githubusercontent.com/caaconwinner/KOTHCROWN/main/deploy/hetzner/bootstrap.sh -o bootstrap.sh
bash bootstrap.sh
```

The first run stops and asks for:

- **`/etc/crown/game.json`**: the game wallet. Make it on the server (`solana-keygen new -o /etc/crown/game.json`, or ask Claude for a one-liner) so the key never leaves it. Send it about 0.05 SOL for the coin creation and network fees.
- **`/etc/crown/crown.env`**: `RPC_URL` (Helius, server key). `MINT` comes in step 3.

## 3. Launch the coin

```bash
cd /opt/crown/services/crown
sudo -u crown env $(cat /etc/crown/crown.env | xargs) GAME_KEYPAIR=/etc/crown/game.json DEV_WALLET=YOUR_DEV_WALLET \
  NAME="take the crown" SYMBOL=CROWN URI=https://takethecrown.fun/brand/coin.json \
  node_modules/.bin/tsx src/game/launch.ts --mainnet
```

On mainnet it also needs `CONFIRM_MAINNET=<game wallet address>`. It prints `MINT=...`: put that in `/etc/crown/crown.env`, then run `bash bootstrap.sh` again to start the game.

## 4. Point the website at it

On Vercel, set `NEXT_PUBLIC_API_URL=https://api.takethecrown.fun` and redeploy.

## Day to day

| Task | Command (as root) |
|---|---|
| Healthy? | `curl -s https://api.takethecrown.fun/api/health` |
| Logs | `journalctl -u crown-api -f` |
| Update to latest `main` | `bash /opt/crown/deploy/hetzner/update.sh` |

Point an uptime monitor at `/api/health`. It answers 503 if fees have not been collected for 5 minutes, or if the game wallet holds less than 0.02 SOL above everything it owes (unclaimed fees, unsent payouts, the burn bucket).

**Back up `/etc/crown/game.json` and `/var/lib/crown/crown.sqlite`.** The key holds all the money. The database records who is owed what; unlike before, it cannot be rebuilt from the chain.
