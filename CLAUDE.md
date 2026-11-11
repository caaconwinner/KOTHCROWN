# KOTH Crown: notes for Claude Code

Read `docs/SPEC.md` (mechanics, math, program design) and `docs/DESIGN.md` (look and feel) before changing anything.

## Stack
- Solana program: Rust + Anchor, in `programs/crown/`
- Tests: TypeScript with `anchor test` (use bankrun / litesvm for time travel: melt depends on clock)
- Crank + indexer + bot: TypeScript (Node) in `services/`
- Frontend: Next.js (App Router) + Tailwind + `@solana/wallet-adapter`, in `app/`
- Monorepo with pnpm workspaces

## Rules
- Never deploy to mainnet or spend real SOL without the owner explicitly asking.
- Never commit keypairs, RPC keys or `.env` files.
- All money math in integers (lamports, bps, fixed point). No floats on-chain.
- Every parameter lives in `Config` and is frozen by `lock_config`. No hidden admin powers.
- Keep the UI inspired by the 2024 "king of the hill" era, but never use another platform's logo, name or assets.
- When something in `docs/SPEC.md` section 4.4 (open questions) gets answered, update the spec in the same commit.

## Commands (fill in as the project grows)
- `anchor build`
- `anchor test`
- `pnpm --filter app dev`
