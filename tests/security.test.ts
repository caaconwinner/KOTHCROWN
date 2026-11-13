// Regression tests for docs/SECURITY-REVIEW.md, on the real program.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair, SystemProgram } from "@solana/web3.js";
import { Env, MAX, SOL } from "./helpers";

/** The king sends `lamports` into the vault and syncs in the same transaction. */
async function pump(env: Env, king: Keypair, lamports: bigint) {
  await env.send([
    SystemProgram.transfer({ fromPubkey: king.publicKey, toPubkey: env.pdas.vault, lamports }),
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
}

test("F1: a king pumping the vault cannot hold the price above half the reign's opening price", async () => {
  const env = await Env.create();
  const king = env.wallet(1_000n);
  await env.takeCrown(king, MAX);
  const reign = (await env.crown()).reignPrice;
  assert.equal(reign, (await env.crown()).checkpointPrice, "reign price is the price right after the takeover");

  // The SOL comes straight back to the king, so the pump is free...
  const before = await env.balance(king.publicKey);
  for (let i = 0; i < 90; i++) {
    await env.warp(60);
    await pump(env, king, 100n * SOL);
  }
  assert.equal(await env.balance(king.publicKey), before, "the king got every lamport back");

  // ...but useless: after 90 minutes of it the crown has melted to the capped floor.
  const capped = (reign * 5_000n) / 10_000n;
  assert.equal(await env.price(), capped, "price sits at 50% of the reign's opening price");
  assert.ok((await env.crown()).fastEma * 10n > 100n * capped, "even though the raw fee floor is far higher");

  // And anyone can take it there.
  const ev = await env.takeCrown(env.wallet(), MAX);
  assert.equal(BigInt(ev.price_paid), capped);
});

test("F1: honest fee income still holds the price, up to the cap", async () => {
  // Busy coin: real fees of 0.2 SOL a minute, crown taken at 1 SOL.
  const env = await Env.create({ openingPrice: SOL });
  await env.takeCrown(env.wallet(), MAX);
  const reign = (await env.crown()).reignPrice; // 1.3 to 1.6 SOL
  await env.flow(60, SOL / 5n);
  // 10 minutes of fees is about 2 SOL, above the cap, so the cap holds.
  assert.equal(await env.price(), (reign * 5_000n) / 10_000n);

  // Quiet coin: 0.03 SOL a minute, floor about 0.3 SOL: above the 0.2 SOL minimum, under the cap.
  const quiet = await Env.create({ openingPrice: SOL });
  await quiet.takeCrown(quiet.wallet(), MAX);
  await quiet.flow(180, (3n * SOL) / 100n);
  const c = await quiet.crown();
  assert.equal(await quiet.price(), c.fastEma * 10n, "uncapped: 10 minutes of fees");
});

test("F1: floor_cap_bps must be 1 to 10000", async () => {
  await assert.rejects(Env.create({ floorCapBps: 0 }));
  await assert.rejects(Env.create({ floorCapBps: 10_001 }));
  await Env.create({ floorCapBps: 10_000 });
});
