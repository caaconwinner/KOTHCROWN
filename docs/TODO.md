# To do and test list

Status as of Phase 4. Tick items in the same commit that finishes them.

## Decisions waiting on the owner

- [ ] Program upgrade authority after launch: keep, hand to a multisig, or burn (immutable). Needed before mainnet.
- [ ] Final `dev_wallet` address.
- [ ] `MIN_PRICE` (0.01 SOL) and `OPENING_PRICE` (0.5 SOL): confirm or change.
- [ ] `MAX_BUYBACK_LAMPORTS` (0.5 SOL) and `BUYBACK_COOLDOWN_S` (300): confirm or change.
- [ ] Burned-when-unpayable rule (SPEC 2.4): confirm, or switch to a claimable balance.
- [ ] Legal review of launch copy (SPEC 8).

## Phase 0: research (done)

- [x] Creator-fee claim path, fee sharing split, PumpSwap buy, devnet availability (SPEC 4.4)
- [x] V1 fee path proposed and accepted (SPEC 4.5)

## Phase 1: program core (done)

- [x] `initialize`, `update_config`, `lock_config`, `sync_fees`, `take_crown`, `view_price`, `mock_drop_fees`
- [x] Integer price math and BigInt mirror in `packages/sdk`

Tests passing (`pnpm test`, `cargo test -p crown --lib`):

- [x] First claim: opening price, all burned
- [x] Melt over time, checkpoints do not drift
- [x] Floor at 10 minutes of fee income
- [x] Floor at `MIN_PRICE` with no fees
- [x] Takeover split 90/10, no lamports lost
- [x] Takeover pays the old king's pending fees first
- [x] Jump within 1.3x to 1.6x and varies
- [x] Fee split, V1 path (king gets everything in the vault)
- [x] Fee split, fallback path (95/5)
- [x] Fees with no king go to the burn bucket
- [x] Slippage guard
- [x] Self-takeover
- [x] EMAs match the local model step by step
- [x] EMA steady state, volume spike, volume crash
- [x] Several syncs in the same second
- [x] Config: update, lock, frozen after lock
- [x] Wrong king account rejected
- [x] King who cannot receive lamports cannot block the game
- [x] `view_price`

- [x] Buyer with too little SOL
- [x] `initialize` twice for the same mint
- [x] Two mints side by side do not share state
- [x] Extreme values: 1M SOL fee drop, ten-year gap
- [x] Randomized 300-step run: lamports conserved, program equals the SDK model at every step
- [x] Compute units capped (`sync_fees` about 25k, `take_crown` about 32k)

## Phase 2: real pump.fun integration (done)

Build:

- [x] `max_buyback_lamports` and `buyback_cooldown_s` in `Config`
- [x] `buyback_burn(lamports, min_tokens_out)` via PumpSwap, canonical pool enforced
- [x] Pre-graduation: the bucket accumulates (no bonding-curve buyback)
- [x] `mock_drop_fees` removed
- [x] SDK: Crown instruction builders, account decoders, `pumpSyncInstructions`, `buybackAccounts`

Verified with `pnpm fork:run` (real pump.fun binaries on a local validator, SPEC 4.4):

- [x] Every pump.fun instruction we use exists on devnet and mainnet (`scripts/devnet-probe.ts`)
- [x] Fee shares set to vault 9500 / dev 500; vault PDA accepted
- [x] `update_fee_shares_v2` is one-shot
- [x] Minimum distributable amount: not a threshold, small fees distribute
- [x] Sync transaction on the curve: king and dev get 95/5
- [x] Sync transaction after graduation (4 pump.fun instructions): 95/5
- [x] `take_crown` with the pump.fun instructions in front, before and after graduation
- [x] `buyback_burn`: tokens burned, supply drops; cap, cooldown, wrong pool, wrong token account and `min_tokens_out` all rejected
- [x] Transaction sizes and compute recorded; no lookup table needed

Left over:

- [x] Devnet deployment, and the bonding-curve steps on devnet (`CLUSTER=devnet pnpm fork:e2e`)
- [ ] Graduation, PumpSwap fees and `buyback_burn` on a live cluster (devnet SOL is too scarce to graduate a coin; local fork only so far)
- [ ] `buyback_burn` when the pool is very shallow or the bucket is nearly empty (only the happy path and the guards were run)
- [ ] A hostile `take_crown` that leaves out the pump.fun instructions: measure how much the old king loses (SPEC 4.5 trade-off)

Tiny-mainnet rehearsal list (only on the owner's explicit go):

- [ ] Launch a throwaway coin, `initialize`, set fee shares, `lock_config`
- [ ] Check pump.fun's website shows the fee split correctly
- [ ] One sync, one takeover, one buyback after graduation, with priority fees

## Phase 3: crank, indexer, announcer (done)

- [x] Setup script with checks between steps and a mainnet guard
- [x] Crank: 60s sync loop, never double-sends; `buyback_burn` above a threshold, creating the bucket's token accounts first
- [x] Indexer: transaction-history polling from a stored cursor, SQLite
- [x] API: `/api/crown`, `/api/history`, `/api/leaderboard`, `/api/health`
- [x] Announcer: takeover message to console

Tests passing (`pnpm test`, and `pnpm fork:run` for the last block):

- [x] Event decoding against real transactions recorded from devnet
- [x] Same transaction ingested twice is stored and announced once
- [x] Indexer restart does not lose or duplicate events; a failed fetch does not move the cursor
- [x] Leaderboard maths
- [x] API responses, paging, caching, errors, against a seeded database
- [x] Announcer message format, SOL rounding, durations
- [x] On the fork: indexer backfill, API against chain state, crank sync, crank buyback, cooldown respected

Not done:

- [ ] Setup script has not been run end to end (its three steps are the same calls `scripts/fork/e2e.ts` makes; the script's own resume and guard logic is untested)
- [ ] Crank soak test: hours of running, RPC errors, restarts
- [ ] X / Telegram posting
- [ ] Process supervision, logs and alerting (see "Before mainnet")

## Phase 4: website (done)

- [x] Name "take the crown", ticker $CROWN, final logo and media files (`scripts/brand/build.cjs`, `docs/brand/assets/`)
- [x] Throne page: king card, ticking price from the checkpoint, crown gauge, melt bar, fee speed, earned this reign, all-time fees, floor
- [x] `[take the crown]` with a price limit; transaction built by the API with the pump.fun instructions in front
- [x] Takeover feed with the bump animation; `prefers-reduced-motion` respected
- [x] `/kings` hall of kings, `/how` explainer
- [x] Honest copy: 95% king, 5% dev, limits of the fee lock, "you can lose money"

Tests passing:

- [x] Local price equals the program's formula for the same checkpoint and second (`pnpm test`)
- [x] Gauge, colours, formatting, price limit (`pnpm test`)
- [x] In a browser against a mock API (`pnpm app:smoke`): price ticks locally, takeover bump, wallet chooser opens, indexer outage message, `/kings` and `/how`, phone width, reduced motion, no page errors
- [x] API-built take-crown transaction lands on the fork when the buyer signs it; a too-low price limit is rejected (`pnpm fork:run`)

Not done:

- [ ] The button has not been clicked through with a real wallet. Everything either side of the wallet popup is tested (transaction built and landed on the fork; button opens the chooser), but not the signing step in a browser.
- [ ] Accessibility pass beyond the basics (labels, focus rings and contrast are in; no screen-reader run)
- [x] Domain takethecrown.fun, pre-launch page (shown until `NEXT_PUBLIC_API_URL` is set)
- [ ] Host the indexer/API and the crank somewhere always-on (Vercel cannot run them as they are), then set `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_RPC_URL` on Vercel to switch the throne page on
- [ ] Share-card image per takeover (design exists in `docs/brand/concepts.html`)
- [ ] Trademark, domain and handle checks for "take the crown" and $CROWN

## Before mainnet

- [ ] Independent security review of the program
- [ ] Verifiable build, program id and keypair handling agreed
- [ ] Tiny-amount mainnet rehearsal of the whole lifecycle
- [ ] Monitoring for the crank (alerts if no sync for N minutes)
