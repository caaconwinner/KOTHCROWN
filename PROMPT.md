# Kickoff prompt for Claude Code

Paste this into Claude Code from the repo root.

---

We're building KOTH Crown: a Solana program and website where one "crown" receives 100% of a pump.fun token's creator fees. Anyone can take the crown by paying its current price; the price jumps 1.3–1.6× on each takeover, melts 2–8% per minute depending on volume, never drops below 10 minutes of fee income, every takeover burns 10%, and 5% of creator fees go to a dev wallet (see SPEC section 7).

Read `CLAUDE.md`, `docs/SPEC.md` and `docs/DESIGN.md` first. Then work in phases and stop for my review after each phase.

**Phase 0: research the unknowns (no code yet)**
Answer the open questions in `docs/SPEC.md` section 4.4: the exact pump.fun creator-fee claim instruction(s) for the bonding curve and PumpSwap, whether a PDA recipient can claim via CPI, the PumpSwap swap instruction for buyback-and-burn, and whether pump.fun programs exist on devnet. Use the pump-fun public docs/IDLs on GitHub. Write the findings into the spec and propose the V1 fee path.

**Phase 1: program core with a mock fee source**
Scaffold the pnpm monorepo and the Anchor program. Implement `initialize`, `lock_config`, `sync_fees` (with a mock "fee source" instruction that drops lamports into the vault for testing), `take_crown`, and the price math (EMAs, volume-linked melt, floor, checkpointing, random jump). Write tests that time-travel the clock and check: melt over time, floor, the 90/10 split, slippage guard, self-takeover, first claim, and EMA behavior on a volume spike and a volume crash. Use integer math only.

**Phase 2: real pump.fun integration**
Swap the mock for the real creator-fee claim CPI from Phase 0, plus `buyback_burn` via PumpSwap. Test on devnet if possible, otherwise list exactly what needs a tiny mainnet test and wait for me.

**Phase 3: crank, indexer, announcer**
TypeScript services: 60s `sync_fees` crank, event indexer with a small API (`/api/crown`, `/api/history`, `/api/leaderboard`), and an announcer that formats takeover messages (print to console for now; X/Telegram later).

**Phase 4: the website**
Next.js app following `docs/DESIGN.md`: the throne page with a price that ticks every second (computed locally from the on-chain checkpoint), melt bar, takeover feed with the shake-and-flash "bump" animation, `[take the crown]` with a slippage guard, hall of kings, and a one-screen how-it-works page.

Start with Phase 0.
