# KOTH Crown: Spec v0.2

A single "crown" that receives 95% of a pump.fun token's creator fees. Anyone can take the crown at any time by paying its current price. The price jumps after each takeover and melts every minute. Every takeover burns 10%. 5% of the creator fees go to the dev wallet.

> One-liner for users: **"The crown gets cheaper every minute. Take it, earn the fees, get paid when someone takes it from you."**

---

## 1. Lifecycle

1. **Launch.** Token launches on pump.fun with standard creator fees (not Cashback Coins).
2. **Lock fees to the crown.** After `initialize` has created the fee vault PDA, the creator calls pump.fun's `create_fee_sharing_config` and then the one-shot `update_fee_shares_v2` with two shareholders: fee vault PDA 9500 bps, `dev_wallet` 500 bps. That call sets `admin_revoked = true`, so the creator can never change the split again (see 4.4 for what pump.fun itself can still do).
3. **First claim.** The crown starts empty with an opening price. The first buyer becomes king.
4. **Reign.** Every ~60s a permissionless crank runs pump.fun's sweep + distribute instructions (which push 95% into the vault and 5% to the dev wallet) followed by `sync_fees`, which pays the vault balance to the current king.
5. **Melt.** The crown's price falls every second, by 2–8% per minute depending on volume.
6. **Takeover.** Anyone calls `take_crown`. They pay the current price: 90% to the old king, 10% to the burn bucket. The new price jumps to 1.3–1.6× what they paid (random), then starts melting again.
7. **Floor.** The price never melts below ~10 minutes of current fee income.

---

## 2. Math

All amounts in lamports. All rates use fixed point (Q32 or bps; pick one and be consistent).

### 2.1 Fee speed (two EMAs)

On each `sync_fees` call, with `delta` = new lamports claimed and `dt` = seconds since last sync:

```
inst_rate = delta * 60 / dt                      # lamports per minute
alpha_fast = 1 - 2^(-dt / FAST_HALF_LIFE_S)      # FAST_HALF_LIFE_S = 180
alpha_slow = 1 - 2^(-dt / SLOW_HALF_LIFE_S)      # SLOW_HALF_LIFE_S = 900
fast_ema += alpha_fast * (inst_rate - fast_ema)
slow_ema += alpha_slow * (inst_rate - slow_ema)
```

### 2.2 Melt rate (volume-linked)

```
ratio = fast_ema / max(slow_ema, 1)
melt  = piecewise-linear through (0.8, MELT_MAX_BPS), (1.0, MELT_BASE_BPS), (1.2, MELT_MIN_BPS)
        clamped to MELT_MAX_BPS below 0.8 and MELT_MIN_BPS above 1.2
```

- Rising volume (ratio ≥ 1.2): 2%/min, the crown is worth holding.
- Flat (ratio ≈ 1.0): 4%/min.
- Falling (ratio ≤ 0.8): 8%/min, the crown gets cheap fast to force one more takeover.

### 2.3 Price

Because the melt rate changes over a reign, store a checkpoint and decay from it:

```
price_now = max(floor, checkpoint_price * (1 - melt/10000)^(minutes since checkpoint_ts))
floor     = FLOOR_MINUTES * fast_ema             # FLOOR_MINUTES = 10
```

- Compute the decay per second in fixed point: `factor_per_sec = (1 - melt/10000)^(1/60)`, precomputed per melt value, then exponentiate by squaring over elapsed seconds.
- On every `sync_fees` (melt may change) and every `take_crown`, write a new checkpoint: `checkpoint_price = price_now`, `checkpoint_ts = now`.

### 2.4 Takeover

```
P = price_now
require P <= max_price                      # slippage guard from the buyer
to_burn     = P * BURN_BPS / 10000              # BURN_BPS = 1000
to_old_king = P - to_burn                       # remainder, so rounding never loses lamports
jump_bps    = random in [JUMP_MIN_BPS, JUMP_MAX_BPS]   # 13000..16000
new_price   = max(floor, P * jump_bps / 10000)
checkpoint  = (new_price, now)
```

- First claim (no king): the full price goes to the burn bucket.
- Self-takeover is allowed. It costs the king 10% (burned) and resets the price higher. That works as a built-in "fortify" and is good for holders.
- Randomness: V1 uses `SlotHashes` sysvar + takeover count + buyer key. A validator could bias it slightly; acceptable for V1. V2 option: Switchboard VRF.

### 2.5 Sanity check with real data (HOLD token, Nov 2026)

| | Peak | Cooling |
|---|---|---|
| Creator fees / min | ~0.5 SOL | ~0.14 SOL |
| Floor (10 min) | ~5 SOL | ~1.4 SOL |
| Crown after takeover | ~8–12 SOL | ~2–3 SOL |
| 5-min reign fees | ~2.5 SOL | ~0.7 SOL |
| Melt | ~2%/min | ~6–8%/min |

At 4%/min with a 1.5× jump, a king breaks even on the flip if taken within ~7.4 min (0.9 × 1.5 × 0.96^t ≥ 1 → t ≈ 7.35 min). Fees earned during the reign come on top (95% of creator fees).

---

## 3. Default parameters (locked at init)

| Param | Default | Notes |
|---|---|---|
| `JUMP_MIN_BPS` / `JUMP_MAX_BPS` | 13000 / 16000 | 1.3–1.6× |
| `MELT_MIN_BPS` / `MELT_BASE_BPS` / `MELT_MAX_BPS` | 200 / 400 / 800 | per minute |
| `FLOOR_MINUTES` | 10 | |
| `BURN_BPS` | 1000 | 10% of every takeover |
| `DEV_FEE_BPS` | 0 (V1 path) / 500 (fallback) | In-program dev split. 0 when pump.fun fee sharing already sends 5% to `dev_wallet` (4.5). Hard cap 1000 in code |
| `dev_wallet` | owner's wallet | fixed at init, frozen by `lock_config` |
| `FAST_HALF_LIFE_S` / `SLOW_HALF_LIFE_S` | 180 / 900 | |
| `OPENING_PRICE` | 0.5 SOL | used if floor is lower |
| `SYNC_INTERVAL_S` | 60 | crank target, not enforced |

Parameters are set at `initialize` and then frozen with `lock_config` (no admin after that).

---

## 4. Solana program (Anchor)

### 4.1 Accounts

**`Config`** PDA `["config", mint]`
- `mint: Pubkey`
- `authority: Option<Pubkey>` (set to `None` by `lock_config`)
- `dev_wallet: Pubkey` (receives the dev fee; frozen by `lock_config`)
- params from section 3
- `bump`s

**`Crown`** PDA `["crown", mint]`
- `king: Option<Pubkey>`
- `checkpoint_price: u64`, `checkpoint_ts: i64`
- `fast_ema: u64`, `slow_ema: u64` (lamports/min, fixed point)
- `last_sync_ts: i64`
- `reign_started_ts: i64`
- `takeover_count: u64`
- `king_fees_this_reign: u64`
- `total_fees: u64`, `total_burn_sol: u64`

**`FeeVault`** PDA `["vault", mint]`: system-owned SOL account, the pump.fun creator fee recipient.

**`BurnBucket`** PDA `["burn", mint]`: holds SOL waiting for buyback-and-burn.

### 4.2 Instructions

| Instruction | Who | Does |
|---|---|---|
| `initialize(params)` | creator | Creates Config, Crown, vault, burn bucket |
| `lock_config()` | creator | Sets `authority = None`. Irreversible |
| `sync_fees()` | anyone (crank) | Pure accounting, no CPI. `delta = vault.lamports - rent_exempt_min`. Updates EMAs, pays `delta` (minus `DEV_FEE_BPS`, which is 0 on the V1 path because pump.fun already split off the 5%) to the current king (or to the burn bucket if no king), writes a new price checkpoint. The crank puts the pump.fun sweep/distribute instructions before it in the same transaction (4.5) |
| `take_crown(max_price)` | anyone | Section 2.4. Calls `sync_fees` logic first so the old king gets fees up to this second |
| `buyback_burn(min_out)` | anyone | Swaps burn bucket SOL for the token on PumpSwap (CPI) and burns it. Fallback for V1: keeper wallet with a public log |
| `view_price()` | read-only | Returns current price, floor, melt, fee speed (for UI simulation) |

### 4.3 Events

`CrownTaken { new_king, old_king, price_paid, to_old_king, to_burn, new_price, reign_secs, old_reign_fees }`, `FeesSynced { delta, to_king, to_dev, fast_ema, slow_ema, melt_bps, floor }`, `Burned { sol_in, tokens_burned }`.

### 4.4 Phase 0 findings (answered 2026-11-11)

Source: `pump-fun/pump-public-docs` at commit `639b87f` (Oct 13 2026): `docs/instructions/CREATOR_FEE_SHARING.md`, `COLLECT_CREATOR_FEE.md`, `SWEEP_FEES.md`, `PUMP_SWAP_TRADE_V2.md`, `TRADE_V3.md`, `docs/CPI_README.md`, and `idl/pump.json`, `idl/pump_amm.json`, `idl/pump_fees.json`. Nothing here has been executed on-chain yet; items marked **unverified** are checked in Phase 2.

Program ids (same on mainnet and devnet):

| Program | Id |
|---|---|
| Pump (bonding curve) | `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` |
| PumpSwap (Pump AMM) | `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` |
| Pump Fees | `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ` |

**1. Creator-fee claim, and can a PDA claim it? Yes, and no signature is needed.**

There are two mutually exclusive claim paths, chosen by whether the coin has a `sharing_config`:

- *Single creator (no sharing config):* Pump `collect_creator_fee_v2` (bonding curve vault `["creator-vault", creator]`) and PumpSwap `collect_coin_creator_fee` (vault authority `["creator_vault", coin_creator]`, wSOL ATA). Both are permissionless and pay the `creator` address; the creator does not sign. Both fail once the coin has a sharing config.
- *Fee sharing (what we use):* Pump `distribute_creator_fees_v2(initialize_ata: bool)` pays the vault `["creator-vault", sharing_config]` to every shareholder by `share_bps`. Permissionless; only a fee `payer` signs. For SOL-paired coins it transfers lamports straight to each shareholder address, passed as remaining accounts in the exact order of `sharing_config.shareholders`.

Since fees are pushed and the recipient never signs, the fee vault PDA needs no `invoke_signed` to receive them, and no keeper keypair is needed. Constraints on a recipient: it must not be executable (error 6052) and must already exist with lamports (error 6070), so `initialize` funds the vault to rent-exempt before the fee shares are set. **Unverified:** that a 0-data system-owned PDA is accepted as a shareholder (nothing in the docs or IDL forbids it).

Fees now wait in up to three places before they reach the creator vault, each drained by a permissionless instruction. The full sequence for a graduated SOL-paired coin, in order:

| # | Program | Instruction | Discriminator | Moves |
|---|---|---|---|---|
| 1 | PumpSwap | `sweep_creator_fee` (12 accounts) | `[32,246,191,52,8,201,73,186]` | `Pool.creator_fees` → AMM creator vault wSOL ATA |
| 2 | PumpSwap | `transfer_creator_fees_to_pump_v2` (12 accounts) | `[1,33,78,185,33,67,44,92]` | AMM creator vault → Pump creator vault (unwraps to lamports) |
| 3 | Pump | `sweep_creator_fee` (13 accounts) | `[32,246,191,52,8,201,73,186]` | `BondingCurve.creator_fee` → Pump creator vault |
| 4 | Pump | `distribute_creator_fees_v2` (12 accounts + shareholders) | `[255,203,19,79,244,68,8,159]` | Pump creator vault → shareholders |

Before graduation only 3 and 4 apply. Step 4 fails with `CreatorFeesNotSwept` (6095) if step 3 was skipped. Step 4 also needs a minimum balance in the creator vault (`get_minimum_distributable_fee` reports it); the amount is **unverified**, so the crank must check it and send `sync_fees` alone when the vault is below it.

**2. Fee split and lock. Yes: 95% vault / 5% dev at the pump.fun level.**

- Pump Fees `create_fee_sharing_config` (signer: coin creator) creates `["sharing-config", mint]` and repoints `bonding_curve.creator` (and `pool.coin_creator` if graduated) at it. Initial shareholders: `[(creator, 10000)]`.
- Pump Fees `update_fee_shares_v2(shareholders)` (signer: `sharing_config.admin`): 1 to 10 entries, no duplicates, each `share_bps > 0`, sum exactly 10000. It first pays pending fees to the old list, then sets `admin_revoked = true`, so it works once.
- So `[(fee_vault, 9500), (dev_wallet, 500)]` is valid, and the creator cannot change it afterwards.
- Limits of the lock, to state honestly on the site: all three pump.fun programs are upgradeable, pump.fun has admin instructions (`admin_cto`, `admin_cto_sharing_config`) that can reassign a coin's creator or a sharing config's admin, and a sharing config has a `Paused` status that blocks distribution. The lock is permanent against the team, not against pump.fun.
- Coin requirements: SOL-paired, regular coin. Not a holder-rewards coin (`is_holder_reward`), where creator fees go to holders and the creator cannot be changed. Cashback coins can no longer be created.

**3. PumpSwap swap for `buyback_burn`.**

PumpSwap `buy_exact_quote_in_v2(spendable_quote_in: u64, min_base_amount_out: u64)`, discriminator `[194,171,28,70,104,77,91,47]`, 17 accounts, no remaining accounts:

`pool, user (signer), global_config, base_mint, quote_mint, user_base_token_account, user_quote_token_account, pool_base_token_account, pool_quote_token_account, base_token_program, quote_token_program, system_program, user_volume_accumulator, fee_config, buyback_fee_recipient, event_authority, program`

- `user` is the burn bucket PDA, signed with `invoke_signed`. It must hold a wSOL token account (wrap with a system transfer + `sync_native`) and a token account for the coin; the trade creates neither. `user_volume_accumulator` (`["user_volume_accumulator", user]`) is created on first use and paid by `user`, which works because the bucket is system-owned.
- `global_config` = `ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw`, `fee_config` = `5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx`, `buyback_fee_recipient` = wSOL ATA of any of the 8 buyback wallets in `FEE_RECIPIENTS.md`.
- Canonical pool address: PumpSwap PDA for `(index 0, creator = Pump PDA ["pool-authority", mint], base = mint, quote = wSOL)`.
- Slippage is the `min_base_amount_out` argument. Quotes must use `pool_quote_token_account.amount + Pool.virtual_quote_reserves` (signed, can be negative).
- Then burn with the coin's token program. Read the mint's owner rather than assuming SPL Token vs Token-2022.
- Before graduation there is no pool. The equivalent is Pump `buy_exact_quote_in_v3(spendable_quote_in, min_tokens_out, partial_fill)`, discriminator `[225,247,80,30,213,179,132,136]`, 17 accounts, paid in native SOL.
- pump.fun documents CPI from Anchor via `declare_program!` and the `pump-rust-client` crate (0.4.1), so CPI is supported.

**4. Devnet. The programs exist.** Checked against `api.devnet.solana.com` on 2026-11-11: all three program ids are deployed and executable, and the PumpSwap `global_config` and `fee_config` accounts exist. The devnet builds are not the same binaries as mainnet (different sizes, different deploy slots), so it is **unverified** whether devnet has the newest instructions (`sweep_creator_fee`, the v2/v3 trades). Phase 2 starts by simulating each instruction from the table above on devnet; anything missing goes on the tiny-mainnet-test list.

**Still open (Phase 2):**

1. Does `distribute_creator_fees_v2` accept the vault PDA as a shareholder? (devnet test)
2. The minimum distributable amount, and whether falling below it is an error or a no-op.
3. Devnet parity with the instructions in finding 1 and 3.
4. Compute and transaction size of the 5-instruction sync transaction (expected to need an address lookup table).

### 4.5 V1 fee path (proposed)

1. Launch the coin (SOL-paired, regular). Call `initialize`, which creates and funds the fee vault PDA.
2. Creator sends one transaction: `create_fee_sharing_config`, then `update_fee_shares_v2([(fee_vault, 9500), (dev_wallet, 500)])`. Then `lock_config`.
3. Crank, every ~60s, one transaction: the pump.fun instructions from finding 1 (steps 1 to 4, or 3 to 4 before graduation), then Crown `sync_fees`.
4. `sync_fees` does no CPI. The vault only ever holds unpaid fees, so `delta = vault.lamports - rent_exempt_min`, and all of it goes to the king. `DEV_FEE_BPS` is set to 0 for this path because pump.fun has already sent the 5% to `dev_wallet`; the in-program split stays implemented and tested as the fallback.
5. `take_crown` runs the same accounting first. The frontend builds the transaction with the pump.fun instructions in front, so the old king is paid up to that second.

Why no CPI for fees: every pump.fun step is permissionless and pushes funds, so a CPI adds nothing except ~30 extra accounts per instruction and a hard dependency on pump.fun's account layouts, which changed several times in 2026. With a locked config, a layout change could brick `take_crown`. Composing in the transaction cannot.

Known trade-offs of this path:

- A taker who leaves out the pump.fun instructions keeps the fees that accrued since the last distribute (at most about one crank interval) instead of the old king. It is bounded, and a king can run the crank themselves. If that is not acceptable, the alternative is CPI inside `take_crown` only.
- Anyone can send SOL to the vault. It is paid to the king and counted as fee income, which raises the EMAs and the floor. It costs the sender the full amount.
- Fees arrive in lumps when the creator vault is below the minimum distributable amount. The EMAs already divide by `dt`, but at very low volume the fast EMA will sag between lumps and push melt to the maximum.

`buyback_burn` is the one place that needs a CPI (the bucket PDA must sign the swap). Because it is permissionless and the caller picks `min_out`, add a per-call spend cap to `Config` so a caller passing `min_out = 0` cannot sandwich the whole bucket at once.

---

## 5. Off-chain services

- **Crank** (TypeScript, Node): every 60s call `sync_fees`; every N minutes call `buyback_burn` if the bucket > threshold. Permissionless, so anyone can run a backup.
- **Indexer**: subscribe to program logs, store events in SQLite/Postgres, serve `/api/crown`, `/api/history`, `/api/leaderboard`.
- **Announcer bot** (X + Telegram): "👑 7xKp… took the crown for 4.2 SOL. Old king reigned 6m and earned 1.1 SOL. 0.42 SOL burned."

## 6. Frontend

See `docs/DESIGN.md`. Pages:
- `/` the throne: current king card, live price (ticks every second), melt bar, fee speed, floor, `[take the crown]` button, live takeover feed.
- `/kings` hall of kings: longest reign, most earned, biggest takeover, most burned.
- `/how` one-screen explainer.

The UI must compute the live price locally from the on-chain checkpoint + melt so it ticks every second without RPC spam, then re-sync on every event.

## 7. Dev fee

- 5% of all creator fees go to `dev_wallet`; the king gets the other 95%. Takeover payments are untouched (90% old king, 10% burn).
- **V1: split at the pump.fun level** (confirmed in Phase 0, see 4.4 finding 2 and 4.5). `update_fee_shares_v2` sets 9500 bps → Crown fee vault PDA and 500 bps → `dev_wallet`, once, and the creator can never change it. The split is enforced by pump.fun, not by our program, and `DEV_FEE_BPS` in `Config` is 0.
- **Fallback: split in `sync_fees`.** If the pump.fun split can't be used, route 100% to the vault, set `DEV_FEE_BPS = 500`, and in `sync_fees` pay `to_dev = delta * DEV_FEE_BPS / 10000` to `dev_wallet`, `to_king = delta - to_dev` to the king.
- EMAs, floor and melt are computed on the king's 95% so the UI numbers match what the king actually earns.
- Shown openly on the site ("king earns 95% of creator fees · 5% dev") and in `FeesSynced` events. `DEV_FEE_BPS` is capped at 1000 in code and frozen by `lock_config`.

## 8. Risks

- Low volume → small crown. The game is mostly the first 12–24h after graduation.
- Bots will take the crown at optimal moments. Random jump makes timing less predictable; every bot takeover still burns 10%.
- Legal: selling a right to a revenue stream may look security-like in some places. Get advice before launch copy.
- Fee claim lag: if the crank stops, the old king misses fees until the next sync. `take_crown` syncs first to avoid this.
