# KOTH Crown: Spec v0.1

A single "crown" that receives 100% of a pump.fun token's creator fees. Anyone can take the crown at any time by paying its current price. The price jumps after each takeover and melts every minute. Every takeover burns 10%.

> One-liner for users: **"The crown gets cheaper every minute. Take it, earn the fees, get paid when someone takes it from you."**

---

## 1. Lifecycle

1. **Launch.** Token launches on pump.fun with standard creator fees (not Cashback Coins).
2. **Lock fees to the crown.** The creator uses pump.fun's one-time fee redirect to send 100% of creator fees to the Crown program's fee vault PDA. After this, pump.fun locks the setting permanently, so the team can never take the fees back.
3. **First claim.** The crown starts empty with an opening price. The first buyer becomes king.
4. **Reign.** Every ~60s a permissionless crank claims creator fees into the vault and streams them to the current king.
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
to_old_king = P * (10000 - BURN_BPS) / 10000   # BURN_BPS = 1000
to_burn     = P - to_old_king
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

At 4%/min with a 1.5× jump, a king breaks even on the flip if taken within ~7.4 min (0.9 × 1.5 × 0.96^t ≥ 1 → t ≈ 7.35 min).

---

## 3. Default parameters (locked at init)

| Param | Default | Notes |
|---|---|---|
| `JUMP_MIN_BPS` / `JUMP_MAX_BPS` | 13000 / 16000 | 1.3–1.6× |
| `MELT_MIN_BPS` / `MELT_BASE_BPS` / `MELT_MAX_BPS` | 200 / 400 / 800 | per minute |
| `FLOOR_MINUTES` | 10 | |
| `BURN_BPS` | 1000 | 10% of every takeover |
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
| `sync_fees()` | anyone (crank) | Claims pump.fun creator fees into the vault (CPI), measures delta, updates EMAs, pays the delta to the current king (or to the burn bucket if no king), writes a new price checkpoint |
| `take_crown(max_price)` | anyone | Section 2.4. Calls `sync_fees` logic first so the old king gets fees up to this second |
| `buyback_burn(min_out)` | anyone | Swaps burn bucket SOL for the token on PumpSwap (CPI) and burns it. Fallback for V1: keeper wallet with a public log |
| `view_price()` | read-only | Returns current price, floor, melt, fee speed (for UI simulation) |

### 4.3 Events

`CrownTaken { new_king, old_king, price_paid, to_old_king, to_burn, new_price, reign_secs, old_reign_fees }`, `FeesSynced { delta, fast_ema, slow_ema, melt_bps, floor }`, `Burned { sol_in, tokens_burned }`.

### 4.4 Open technical questions (verify first)

1. **pump.fun fee claim from a PDA.** Find the exact creator-fee claim instruction (bonding curve and PumpSwap creator vaults) and confirm a PDA recipient can claim via CPI with `invoke_signed`. If not, V1 uses a keeper keypair as recipient and forwards everything on-chain to the vault, with public logs.
2. **Fee redirect flow.** Confirm the current pump.fun fee-sharing config lets you set 100% to one address, and that the one-time lock applies.
3. **PumpSwap CPI** for `buyback_burn` (program id, accounts, slippage).
4. **Devnet availability** of pump.fun programs. If missing, test the Crown logic with a mock fee source and do the pump.fun integration on mainnet with tiny amounts.

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

## 7. Risks

- Low volume → small crown. The game is mostly the first 12–24h after graduation.
- Bots will take the crown at optimal moments. Random jump makes timing less predictable; every bot takeover still burns 10%.
- Legal: selling a right to a revenue stream may look security-like in some places. Get advice before launch copy.
- Fee claim lag: if the crank stops, the old king misses fees until the next sync. `take_crown` syncs first to avoid this.
