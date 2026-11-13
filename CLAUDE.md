# KOTH Crown: notes for Claude Code

Read `docs/SPEC.md` (mechanics, math, program design) and `docs/DESIGN.md` (look and feel) before changing anything.

## Stack
- Solana program: Rust + Anchor, in `programs/crown/`
- Tests: TypeScript with `anchor test` (use bankrun / litesvm for time travel: melt depends on clock)
- Crank + indexer + bot: TypeScript (Node) in `services/`
- Frontend: Next.js (App Router) + Tailwind + `@solana/wallet-adapter`, in `app/`
- Monorepo with pnpm workspaces

## Rules
- The owner wants short answers: a few lines, the key point first, no long tables or lists.
- Never deploy to mainnet or spend real SOL without the owner explicitly asking.
- Never commit keypairs, RPC keys or `.env` files.
- All money math in integers (lamports, bps, fixed point). No floats on-chain.
- Every parameter lives in `Config` and is frozen by `lock_config`. No hidden admin powers.
- Keep the UI inspired by the 2024 "king of the hill" era, but never use another platform's logo, name or assets.
- The site is called "take the crown" (ticker $CROWN, wordmark "crown"). Do not put "KOTH" in anything users see. Package and repo names keep it.
- When something in `docs/SPEC.md` section 4.4 (open questions) gets answered, update the spec in the same commit.

## Commands
- `pnpm build:program` runs `anchor build` and copies the IDL into `packages/sdk/src/idl/` (the SDK reads it there; the tests read `target/idl/`)
- `pnpm test` runs the bankrun time-travel tests (needs `anchor build` first), the services tests and the website's unit tests. `anchor test` does not work here: it wants a validator.
- `cargo test -p crown --lib` runs the Rust math unit tests
- `pnpm typecheck`
- `pnpm fork:run` runs the end-to-end flow against the real pump.fun programs on a local validator (`scripts/fork/`). It makes read-only mainnet RPC calls to dump programs and clone accounts; no mainnet transactions. Run it after any change to `buyback.rs`, `packages/sdk/src/pump.ts` or the pump.fun SDK versions.
- `CLUSTER=devnet pnpm fork:e2e` runs the bonding-curve steps on devnet against the deployed program, funded from `~/.config/solana/devnet.json` (needs about 1 devnet SOL, refunds what is left). Redeploy with `solana program deploy --use-rpc -u devnet ...` after program changes; without `--use-rpc` the CLI fails behind a proxy.
- `pnpm tsx scripts/devnet-probe.ts [rpc]` checks that the pump.fun instructions we rely on still exist
- Services (`services/crown`, see its `.env.example`): `pnpm --filter @koth-crown/services setup|crank|start`. Load env with `node --env-file` or export it.
- Website (`app/`, see its `.env.example`): `pnpm --filter app dev`. It needs the indexer API running (`pnpm --filter @koth-crown/services start`).
- `pnpm app:smoke` builds the site and tests it in a browser against a mock API (`node scripts/app-smoke.cjs --prelaunch` tests the pre-launch page)
- The site shows a pre-launch page until `NEXT_PUBLIC_API_URL` is set. `/` means the API built into the site (`app/src/app/api`, needs `RPC_URL` and `MINT`): an in-memory indexer rebuilt on every cold start, plus an optional `/api/crank` that open pages ping. That mode is for testing. For a real launch run `services/crown` on an always-on server (Hetzner is the plan) and point `NEXT_PUBLIC_API_URL` at it.
- takethecrown.fun shows the pre-launch page (since 2026-11-12, owner's call). On Vercel the test-mode settings are parked as `OFF_NEXT_PUBLIC_API_URL` and `OFF_MINT`; rename them back to bring the devnet test coin `59STgQBMEgdocm3xkF7812FE9UmpWFvjtFjVwB3kQKZy` back. `scripts/devnet-take.ts <site-url>` takes the crown through a site's API with the devnet key.
- **The live game is server-run (since 2026-11-13):** `services/crown/src/game/` (rules in `logic.ts`, SQLite store, chain I/O, `main.ts` server, `launch.ts` creates the coin from the game wallet). The Solana program in `programs/crown` is kept but not deployed (no SOL for its rent). `scripts/fork/game-run.sh` checks the game against the real pump.fun programs on the fork; run it after changing `game/` or the pump.fun SDKs.
- Mainnet is not deployed. Do not point the live site at mainnet without the owner's explicit go. Production is on Vercel (project root `app/`, domain takethecrown.fun) and publishes from `main`.
- `pnpm brand:build` regenerates the logo files in `docs/brand/assets/` and `app/public/brand/`

## Toolchain
- Anchor CLI and `anchor-lang` 0.32.1, Solana CLI 2.3.13, pnpm 10, Node 22.
- `Cargo.lock` is resolved for Rust 1.84 (the compiler inside the Solana build tools). If a dependency update breaks `anchor build` with an `edition2024` error, regenerate it with `CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS=fallback cargo generate-lockfile`.
- Tests use `solana-bankrun`. Do not switch to `litesvm` for Node: versions 0.3 to 0.8 abort the process after a failed transaction.
- `programs/crown/src/math.rs` and `packages/sdk/src/math.ts` are mirrors. Change both together.
- `packages/sdk` and `services/crown` are deliberately not `"type": "module"`: a pump.fun dependency (`@pump-fun/agent-payments-sdk`) has a broken ES-module build, so everything is loaded as CommonJS through `tsx`.
- `pnpm fork:run` also runs `scripts/fork/services-check.ts` (crank, indexer, API against the fork).
- Browser code in the website imports only `@koth-crown/sdk/src/math` from the SDK. Do not import the SDK's index in client components: it pulls pump.fun's SDK into the browser bundle. The server-only API route may import `@koth-crown/services`; pump.fun's SDK is kept out of the bundle there with `serverExternalPackages`.
- Vercel's Node runtime refuses `require()` of ES modules, which Node 22 here allows. `rpc-websockets` (a web3.js dependency) requires `uuid`, so `uuid` is pinned to 9.0.1 (CommonJS) for it in the root `package.json`. Before publishing a change to the API route's dependencies, check them the way Vercel loads them: start the built site with `NODE_OPTIONS=--no-experimental-require-module` and call `/api/crown`.
- pump.fun SDKs are pinned (`@pump-fun/pump-sdk` 4.1.0, `@pump-fun/pump-swap-sdk` 2.1.0). pump.fun changes its programs often: re-run `pnpm fork:run` before bumping them and before any launch.
