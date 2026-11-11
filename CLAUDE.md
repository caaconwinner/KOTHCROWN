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

## Commands
- `anchor build` builds `target/deploy/crown.so` and `target/idl/crown.json`
- `pnpm test` runs the bankrun time-travel tests (needs `anchor build` first). `anchor test` does not work here: it wants a validator.
- `cargo test -p crown --lib` runs the Rust math unit tests
- `pnpm typecheck`
- `pnpm --filter app dev` (Phase 4)

## Toolchain
- Anchor CLI and `anchor-lang` 0.32.1, Solana CLI 2.3.13, pnpm 10, Node 22.
- `Cargo.lock` is resolved for Rust 1.84 (the compiler inside the Solana build tools). If a dependency update breaks `anchor build` with an `edition2024` error, regenerate it with `CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS=fallback cargo generate-lockfile`.
- Tests use `solana-bankrun`. Do not switch to `litesvm` for Node: versions 0.3 to 0.8 abort the process after a failed transaction.
- `programs/crown/src/math.rs` and `packages/sdk/src/math.ts` are mirrors. Change both together.
