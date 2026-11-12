// Findings from the security review (docs/SECURITY-REVIEW.md), shown on the
// real program. These tests describe the CURRENT behaviour: when a finding is
// fixed, its test flips and must be rewritten to assert the fix.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SystemProgram } from "@solana/web3.js";
import { Env, MAX, SOL } from "./helpers";

test("F1: the king can raise the floor for free by sending SOL to the vault and syncing", async () => {
  const env = await Env.create();
  const king = env.wallet(1_000n);
  await env.takeCrown(king, MAX);
  // Normal life: a small fee flow (0.01 SOL a minute) for 15 minutes.
  await env.flow(15, SOL / 100n);
  const honest = await env.price();

  // The king sends 100 SOL into the vault and syncs in the same transaction.
  // The sync pays the vault out to the king, so the 100 SOL comes straight back.
  const before = await env.balance(king.publicKey);
  const pump = async () => {
    await env.warp(60);
    await env.send([
      SystemProgram.transfer({ fromPubkey: king.publicKey, toPubkey: env.pdas.vault, lamports: 100n * SOL }),
      env.ix("sync_fees", {}, [
        [env.pdas.config, false, false],
        [env.pdas.crown, false, true],
        [env.pdas.vault, false, true],
        [env.pdas.burnBucket, false, true],
        [king.publicKey, false, true],
        [env.dev.publicKey, false, true],
        [SystemProgram.programId, false, false],
      ]),
    ], [king]);
  };
  await pump();
  const after = await env.balance(king.publicKey);
  const inflated = await env.price();

  assert.equal(after, before, "the king got every lamport back (the payer covered the tx fee)");
  assert.ok(inflated > 100n * honest, `price jumped from ${honest} to ${inflated} lamports at no cost`);

  // Repeating it once a minute keeps the crown out of reach indefinitely,
  // while the king keeps collecting 85% of the real fees.
  for (let i = 0; i < 30; i++) await pump();
  assert.ok((await env.price()) > 100n * SOL, "after 30 more minutes the crown still costs over 100 SOL");
  const c = await env.crown();
  assert.equal(c.meltBps, 200, "and the melt is pinned at its slowest");
});
