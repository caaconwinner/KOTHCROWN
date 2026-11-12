# Security review (2026-11-12)

Scope: the Solana program (`programs/crown`, all 1,034 lines at commit `1aeaa95`), the setup script (`services/crown/src/setup.ts`) and how the website signs the take-crown transaction (`app/src/components/TakeButton.tsx`, `services/crown/src/api.ts`).

**This is not an independent audit.** It was done by Claude, the same tool that wrote the code, so it shares the code's blind spots. A paid review by a human audit firm is still needed before mainnet (`docs/TODO.md`, "Before mainnet").

Method: line-by-line reading of every instruction and account constraint, arithmetic overflow check of `math.rs`, and a proof test on the real program for the main finding (`tests/security.test.ts`, bankrun). `pnpm test` (45 tests) and `cargo test -p crown --lib` (7) pass.

## Summary

| # | Severity | Finding | Fix needs |
|---|---|---|---|
| F1 | **High** | The king can raise the floor for free and keep the crown out of reach | **Fixed** (floor capped at 50% of the reign's opening price) |
| F2 | **Medium** | Anyone can `initialize` a coin's crown first; the setup script does not notice | Setup-script fix now; program change advised |
| F3 | **Medium** | `buyback_burn` can be stalled for almost nothing, and sandwiched | Program change |
| F4 | **Medium** | The website signs whatever transaction the API sends back | Website change |
| F5 | Low | The takeover jump is predictable and can be ground | Accept or program change |
| F6 | Low | A takeover that leaves out the pump.fun instructions shifts unsynced fees to the new king | Known trade-off (SPEC 4.5) |
| F7 | Info | Trust assumptions: upgrade authority, unlocked config, pump.fun's own powers | Owner decisions |

Nothing found that lets an outsider take SOL out of the vault, the burn bucket or a king's wallet. Account constraints (PDA seeds, `address =` checks, king check, canonical pool), the lamport split and the integer maths all hold up.

## F1 (High): the king can raise the floor for free

**Status: fixed in the program, not yet deployed** (the devnet program predates it). During a reign the fee floor is capped at `floor_cap_bps` (default 5000 = 50%) of `reign_price`, the price right after the takeover (SPEC 2.3). Pumping still costs the king nothing, but it can no longer hold the price above that cap, so the crown always melts to at most half of where the reign started and can be taken there. `tests/security.test.ts` checks this on the real program. With no king, fees sent to the vault are burned, so the floor stays uncapped then.

What remains: a pumping king can still slow the melt to its minimum (2%/min) by making fee speed look like it is rising. That only changes how fast the crown gets to the cap, not where it stops.

F2 to F4 are left open for now (owner's call, 2026-11-12).

Original finding:

**What.** The floor is 10 minutes of fee income, and fee income is simply "whatever SOL is in the vault" (`lib.rs:255`). Anyone can send SOL to the vault. When the king does it and calls `sync_fees` in the same transaction, the sync pays the vault out to the king (`lib.rs:286`), so the SOL comes straight back. It still counts as fee income, so the fast EMA, and with it the floor, jumps. A price below the floor is lifted to it (`lib.rs:316`).

**Proof** (`tests/security.test.ts`). A king on a coin earning 0.01 SOL a minute sends 100 SOL to the vault and syncs: the king's balance is unchanged to the lamport, and the crown's price goes up more than 100x. Doing it once a minute keeps the price above 100 SOL for as long as the king likes, with the melt pinned at its slowest (2%/min). The king meanwhile keeps 85% of the real fees. The 100 SOL can be the king's own or a same-transaction flash loan.

**Impact.** The core game breaks: a king can make the crown untakeable and keep the fees indefinitely. The same trick lets a king who sees a takeover coming push the price up to the buyer's `max_price` (the slippage limit, +1% by default) and pocket the difference.

**Fix (needs a program change and your decision).** The program cannot tell donated SOL from real fees, so the fix has to make donations useless:
- *Recommended:* cap the fee-based floor at a fraction of the reign's opening price, e.g. 50% (store the price at takeover in `Crown`). A pumped floor can then never hold the crown above half its post-takeover price, so it always gets cheap enough to take.
- Optionally also clamp how much one sync may move the EMAs (e.g. at most 2x the slow EMA), which limits melt manipulation too.

## F2 (Medium): anyone can initialize a coin's crown first

**What.** `initialize` is open to anyone for any mint (`lib.rs:362`), and the first caller becomes `authority` with their own params. Once the coin is created its mint is public, and the setup script initializes in a separate, later transaction. An attacker who gets in between owns the Config.

`setup.ts` then finds "already initialized" and checks only that `dev_wallet` matches (`setup.ts:53`). So an attacker who copies the real dev wallet passes. The script goes on to point pump.fun's fees at the vault, which is permanent, and only fails later at `lock_config`. The attacker can then `update_config` to take a 15% in-program dev fee for themselves, set the burn to 50%, or set prices that ruin the game.

**Fix.**
- *Now, off-chain:* the setup script must check `authority` is the creator and the params equal the intended ones **before** step 2. I can make this change.
- *Program:* only let the coin's pump.fun creator call `initialize` (read the creator from the bonding-curve account). Alternatively, put `initialize` in the same transaction as the coin's creation.

## F3 (Medium): buyback can be stalled cheaply, and sandwiched

**What.** `buyback_burn` is permissionless, and the caller chooses the amount and `min_tokens_out` (`buyback.rs:54`). Any call that buys at least one token starts the 300-second cooldown. Someone calling it every 5 minutes with a few lamports, at about 0.00001 SOL a time, stops the real buyback forever. A caller can also set `min_tokens_out = 0` and sandwich the buy, taking part of each 0.5 SOL.

**Fix (program).** The program should pick the amount, `min(spare, max_buyback_lamports)`, rather than the caller. Sandwiching then still costs the bucket a slice of each buy. To limit that, either let only a crank key named in `Config` call it, or accept it as the price of a permissionless buyback.

## F4 (Medium): the website signs whatever the API returns

**What.** `[take the crown]` fetches a ready-made transaction from the API and sends it to the wallet unchecked (`TakeButton.tsx:42`). If the backend is ever compromised (the planned Hetzner server, its DNS, or a bad deploy), it could return a transaction that drains the user's wallet, and the site would ask them to sign it. Wallet previews help, but people click through.

**Fix (website, no program change).** Before signing, decode the transaction and refuse it unless:
- every instruction is ComputeBudget, pump.fun, PumpSwap or `take_crown`;
- `take_crown` names this buyer, this mint's crown accounts and the `max_price` the page shows;
- nothing transfers SOL from the buyer except `take_crown` itself.

## F5 (Low): the jump is predictable

The 1.3x to 1.6x jump comes from the newest slot hash, the takeover count and the buyer's address (`lib.rs:344`), all known before the transaction lands. A buyer can generate wallets until one gives 1.6x, or wait for a slot that does. That raises the price the next buyer faces, but only within the 1.3x to 1.6x bounds the rules already allow. SPEC 2.4 accepts this; it's listed here for completeness.

## F6 (Low): leaving out the pump.fun instructions

A takeover sent without pump.fun's distribute instructions in front leaves fees waiting in pump.fun, and the new king receives them at the next sync instead of the old king. This is the known SPEC 4.5 trade-off. The `docs/TODO.md` item to measure how much an old king can lose this way is still open.

## F7 (Info): trust assumptions to settle before launch

- **Program upgrade authority:** while it exists, whoever holds it can replace all of the above. This decision is open in `docs/TODO.md`.
- **Unlocked Config:** until `lock_config`, the authority can change every parameter and the dev wallet, within the hard caps (dev ≤ 15%, burn ≤ 50%, melt ≤ 50%/min, jump 1x to 10x). Lock it before announcing.
- **pump.fun:** the fee split is enforced by pump.fun, which can upgrade its own programs (SPEC 4.4). `buyback_burn` also relies on PumpSwap to validate the accounts it passes on.
- **API errors:** the API returns internal error text to callers (`api.ts`, 500 responses). This is harmless today; trim it before launch.

## Checked and fine

- PDAs for config, crown, vault and burn bucket are re-derived from stored bumps on every call. The pool is fixed at `initialize` and checked by address.
- The king account must equal `crown.king` (`lib.rs:251`) whenever there is a king. With no king, the passed account is never paid.
- A king or dev wallet that cannot receive SOL cannot block syncs or takeovers; its share is burned (`can_receive`).
- `update_config` and `lock_config` require the authority, and nothing can change Config after the lock.
- The arithmetic in `math.rs` cannot overflow `u128` for any input. `overflow-checks = true` in release. Splits round down and the remainder goes to the recipient, so no lamports appear or vanish (also covered by the 300-step randomized test).
- `buyback_burn` checks the token accounts' owner, mint and token program, wraps and syncs SOL with the bucket's own signature, and burns only what the bucket holds.
