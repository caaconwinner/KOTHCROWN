# To do and test list

Status as of Phase 1. Tick items in the same commit that finishes them.

## Decisions waiting on the owner

- [ ] Program upgrade authority after launch: keep, hand to a multisig, or burn (immutable). Needed before mainnet.
- [ ] Final `dev_wallet` address.
- [ ] `MIN_PRICE` (0.01 SOL) and `OPENING_PRICE` (0.5 SOL): confirm or change.
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

Not yet tested in Phase 1:

- [ ] Buyer with too little SOL (expected: clean failure, state untouched)
- [ ] `initialize` twice for the same mint (expected: fails)
- [ ] Two mints side by side do not share state
- [ ] Extreme values: very large fee drop, very long gap (years), price near `u64::MAX`
- [ ] Randomized run: many random takeovers, drops and warps, checking that lamports are conserved and the program matches the SDK model at every step
- [ ] Compute units for `sync_fees` and `take_crown` recorded and capped in a test

## Phase 2: real pump.fun integration (next)

Build:

- [ ] Add `max_buyback_lamports` to `Config` (per-call cap)
- [ ] `buyback_burn(min_out)`: wrap SOL, PumpSwap `buy_exact_quote_in_v2` CPI signed by the burn bucket, burn the tokens, emit `Burned`
- [ ] Pre-graduation buyback via Pump `buy_exact_quote_in_v3`, or leave the bucket to accumulate until graduation (decide)
- [ ] Remove `mock_drop_fees` from the production build
- [ ] SDK builders: the pump.fun sweep + distribute instructions, the one-off fee sharing setup transaction, an address lookup table for the sync transaction
- [ ] Setup script: `initialize`, set fee shares, `lock_config`, in that order, with checks between steps

Devnet checks (SPEC 4.4 "still open"):

- [ ] Each instruction in the fee sequence exists on devnet (simulate)
- [ ] Create a test coin, set fee shares to vault 9500 / dev 500
- [ ] `distribute_creator_fees_v2` accepts the vault PDA as a shareholder
- [ ] Minimum distributable amount, and what happens below it
- [ ] `update_fee_shares_v2` really is one-shot (second call fails)
- [ ] Full sync transaction lands: sweep, distribute, `sync_fees`; king and dev balances match 95/5
- [ ] Same after graduation (PumpSwap sweep and transfer added)
- [ ] `take_crown` with the pump.fun instructions in front
- [ ] `buyback_burn`: tokens bought and burned, supply drops, cap enforced, `min_out` enforced
- [ ] Transaction size and compute for each of the above

Anything devnet cannot do goes on a tiny-mainnet-test list for the owner. No mainnet action without an explicit go.

## Phase 3: crank, indexer, announcer

- [ ] Crank: 60s sync loop, skips distribute when below the minimum, retries, never double-sends
- [ ] Crank: periodic `buyback_burn` above a threshold
- [ ] Indexer: program log subscription, backfill on restart, SQLite
- [ ] API: `/api/crown`, `/api/history`, `/api/leaderboard`
- [ ] Announcer: takeover message to console

Tests:

- [ ] Event decoding against recorded transactions
- [ ] Indexer restart does not lose or duplicate events
- [ ] Leaderboard maths (longest reign, most earned, biggest takeover, most burned)
- [ ] API responses against a seeded database
- [ ] Announcer message format

## Phase 4: website

- [ ] Throne page: king card, ticking price from the checkpoint, melt bar, fee speed, floor
- [ ] `[take the crown]` with slippage guard and the pump.fun instructions in front
- [ ] Takeover feed with the bump animation; `prefers-reduced-motion` respected
- [ ] `/kings` hall of kings, `/how` explainer
- [ ] Honest copy: "king earns 95% of creator fees, 5% dev", and the limits of the fee lock (SPEC 4.4)

Tests:

- [ ] Local price equals the program's price for the same checkpoint and time
- [ ] Price re-syncs on `CrownTaken` and `FeesSynced`
- [ ] Take-crown flow against a local validator or devnet: success, slippage failure, wallet rejection
- [ ] Layout at phone width; contrast and keyboard access
- [ ] No other platform's name, logo or assets anywhere

## Before mainnet

- [ ] Independent security review of the program
- [ ] Verifiable build, program id and keypair handling agreed
- [ ] Tiny-amount mainnet rehearsal of the whole lifecycle
- [ ] Monitoring for the crank (alerts if no sync for N minutes)
