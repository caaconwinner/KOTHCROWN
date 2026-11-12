# Backend on Hetzner

One small server runs the two always-on processes the site needs:

| Service | What it does | Needs |
|---|---|---|
| `crown-api` | Indexer (reads takeovers and fees from the chain into SQLite), the API the website calls, the takeover announcer | RPC |
| `crown-crank` | Every minute pays the fees out to the king; buys back and burns once the coin has graduated | RPC + the crank keypair with a little SOL |

Caddy sits in front and serves the API over HTTPS at `api.takethecrown.fun`.

## 1. Server

Hetzner Cloud, Ubuntu 24.04, the smallest shared-CPU plan (2 vCPU, 4 GB) is plenty. Add your SSH key when creating it. Note the IPv4 address.

## 2. DNS

Add an `A` record `api.takethecrown.fun` pointing at the server's IPv4 (wherever the domain's DNS is managed; today that is Vercel).

## 3. Install

```bash
ssh root@SERVER_IP
curl -fsSL https://raw.githubusercontent.com/caaconwinner/KOTHCROWN/main/deploy/hetzner/bootstrap.sh -o bootstrap.sh
bash bootstrap.sh
```

It installs Node 22, pnpm, Caddy and a firewall (SSH and HTTPS only), creates a `crown` user, clones the repo to `/opt/crown` and installs the services. The first run stops and asks for two things:

- **`/etc/crown/crown.env`**: fill in `RPC_URL` (the paid RPC), `MINT` and `CRANK_PUBKEY`. Everything else has sensible defaults. See `crown.env.example`.
- **`/etc/crown/crank.json`**: the crank's keypair. Make a new one just for this (`solana-keygen new -o crank.json`), copy it up with `scp`, and send it about 0.2 SOL. It only pays transaction fees (about 0.00001 SOL a minute plus priority fees). **Never** put the coin creator's key, the dev wallet's key or the program's upgrade key on this server.

Then run `bash bootstrap.sh` again: it starts both services.

## 4. Point the website at it

On Vercel, rename `OFF_NEXT_PUBLIC_API_URL` back to `NEXT_PUBLIC_API_URL` with the value `https://api.takethecrown.fun`, set `NEXT_PUBLIC_CLUSTER` and `NEXT_PUBLIC_RPC_URL` for the cluster, and redeploy. Only on the owner's go for mainnet.

## Day to day

| Task | Command (on the server, as root) |
|---|---|
| Is it healthy? | `curl -s https://api.takethecrown.fun/api/health` |
| Logs | `journalctl -u crown-api -f` / `journalctl -u crown-crank -f` |
| Restart | `systemctl restart crown-api crown-crank` |
| Update to the latest `main` | `bash /opt/crown/deploy/hetzner/update.sh` |

**Monitoring:** point a free uptime monitor (UptimeRobot, Better Stack...) at `https://api.takethecrown.fun/api/health` with alerts to your phone. It answers **503** when:
- no fees have been paid out for 5 minutes (the crank is down or failing), or
- the crank's SOL is below 0.05 (top it up).

The SQLite database (`/var/lib/crown/crown.sqlite`) is only a cache of the chain: if it is lost, the indexer rebuilds it on start.
