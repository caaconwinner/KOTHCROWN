import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair } from "@solana/web3.js";
import { math } from "@koth-crown/sdk";
import { Env, MAX, SOL, START_TS, TxError } from "./helpers";

const near = (a: bigint, b: number, tol = 5) =>
  assert.ok(Math.abs(Number(a) - b) <= tol, `${a} not within ${tol} of ${b}`);

const fails = (fn: () => Promise<unknown>, code: string) =>
  assert.rejects(fn, (e: unknown) => e instanceof TxError && e.code === code);

test("first claim: opening price, all of it burned", async () => {
  const env = await Env.create();
  const a = env.wallet();
  const burn0 = await env.balance(env.pdas.burnBucket);
  const a0 = await env.balance(a.publicKey);

  assert.equal(await env.price(), SOL / 2n);
  const ev = await env.takeCrown(a, MAX);

  assert.equal(BigInt(ev.price_paid), SOL / 2n);
  assert.equal(ev.old_king, null);
  assert.equal(BigInt(ev.to_old_king), 0n);
  assert.equal(BigInt(ev.to_burn), SOL / 2n);
  assert.equal(await env.balance(a.publicKey), a0 - SOL / 2n);
  assert.equal(await env.balance(env.pdas.burnBucket), burn0 + SOL / 2n);

  const c = await env.crown();
  assert.ok(c.king!.equals(a.publicKey));
  assert.equal(c.takeoverCount, 1n);
  assert.equal(c.totalBurnSol, SOL / 2n);
  assert.equal(c.reignStartedTs, START_TS);
});

test("melt over time: compound per minute, checkpoints do not drift", async () => {
  const env = await Env.create();
  await env.takeCrown(env.wallet(), MAX);
  const c0 = await env.crown();
  const start = Number(c0.checkpointPrice);
  assert.equal(c0.meltBps, 800); // no volume yet: fastest melt

  assert.equal(await env.price(), c0.checkpointPrice);
  await env.warp(30);
  near(await env.price(), start * Math.sqrt(0.92));
  await env.warp(30);
  near(await env.price(), start * 0.92);
  await env.warp(240);
  near(await env.price(), start * 0.92 ** 5);

  // The program agrees with the local calculation to the lamport.
  const local = await env.price();
  await env.syncFees();
  assert.equal((await env.crown()).checkpointPrice, local);
  assert.equal((await env.crown()).checkpointTs, START_TS + 300n);

  // Re-checkpointing every 10s for 5 more minutes lands on the same curve.
  for (let i = 0; i < 30; i++) {
    await env.warp(10);
    await env.syncFees();
  }
  near((await env.crown()).checkpointPrice, start * 0.92 ** 10, 100);
});

test("floor: price stops at 10 minutes of fee income", async () => {
  const env = await Env.create();
  await env.takeCrown(env.wallet(), MAX);
  const perMin = SOL / 20n; // 0.05 SOL/min -> floor 0.5 SOL
  await env.flow(180, perMin);

  const c = await env.crown();
  near(c.fastEma, Number(perMin), 1000);
  const floor = c.fastEma * 10n;
  near(floor, Number(SOL / 2n), 10_000);
  assert.equal(c.checkpointPrice, floor);
  assert.equal(await env.price(), floor);

  // A takeover in the same second pays exactly the floor.
  const ev = await env.takeCrown(env.wallet(), MAX);
  assert.equal(BigInt(ev.price_paid), floor);
});

test("floor: with no fees the price stops at min_price, never zero", async () => {
  const env = await Env.create();
  await env.takeCrown(env.wallet(), MAX);
  await env.warp(86_400);
  assert.equal(await env.price(), env.params.minPrice);
  const ev = await env.takeCrown(env.wallet(), MAX);
  assert.equal(BigInt(ev.price_paid), env.params.minPrice);
  assert.ok(BigInt(ev.new_price) >= (env.params.minPrice * 13n) / 10n);
});

test("takeover split: 90% to the old king, 10% burned, nothing lost", async () => {
  const env = await Env.create();
  const a = env.wallet();
  const b = env.wallet();
  await env.takeCrown(a, MAX);
  await env.warp(45);

  const price = await env.price();
  const [a0, b0, burn0] = await Promise.all([a.publicKey, b.publicKey, env.pdas.burnBucket].map((k) => env.balance(k)));
  const ev = await env.takeCrown(b, MAX);

  const toBurn = price / 10n;
  assert.equal(BigInt(ev.price_paid), price);
  assert.equal(BigInt(ev.to_burn), toBurn);
  assert.equal(BigInt(ev.to_old_king), price - toBurn);
  assert.equal(await env.balance(a.publicKey), a0 + price - toBurn);
  assert.equal(await env.balance(b.publicKey), b0 - price);
  assert.equal(await env.balance(env.pdas.burnBucket), burn0 + toBurn);
  assert.ok(ev.old_king.equals(a.publicKey));
  assert.equal(BigInt(ev.reign_secs), 45n);
  assert.ok((await env.crown()).king!.equals(b.publicKey));
});

test("takeover pays the old king's pending fees first", async () => {
  const env = await Env.create();
  const a = env.wallet();
  await env.takeCrown(a, MAX);
  await env.warp(60);
  await env.dropFees(2n * SOL); // not synced yet
  const a0 = await env.balance(a.publicKey);

  const ev = await env.takeCrown(env.wallet(), MAX);
  assert.equal(BigInt(ev.old_reign_fees), 2n * SOL);
  assert.equal(await env.balance(a.publicKey), a0 + 2n * SOL + BigInt(ev.to_old_king));
  assert.equal((await env.crown()).kingFeesThisReign, 0n);
});

test("jump: new price is 1.3x to 1.6x the price paid, and varies", async () => {
  const env = await Env.create();
  const jumps = new Set<number>();
  for (let i = 0; i < 25; i++) {
    await env.warp(300); // long enough that the price does not run away
    const ev = await env.takeCrown(env.wallet(), MAX);
    assert.ok(ev.jump_bps >= 13_000 && ev.jump_bps <= 16_000, `jump ${ev.jump_bps}`);
    assert.equal(BigInt(ev.new_price), math.bpsOf(BigInt(ev.price_paid), ev.jump_bps));
    assert.equal((await env.crown()).checkpointPrice, BigInt(ev.new_price));
    jumps.add(ev.jump_bps);
  }
  assert.ok(jumps.size > 15, `only ${jumps.size} distinct jumps`);
});

test("fee split, V1 path: king gets everything that reaches the vault", async () => {
  const env = await Env.create(); // dev_fee_bps = 0, pump.fun already took the 5%
  const a = env.wallet();
  await env.takeCrown(a, MAX);
  await env.warp(60);
  await env.dropFees(SOL);
  const [a0, dev0, vault0] = await Promise.all([a.publicKey, env.dev.publicKey, env.pdas.vault].map((k) => env.balance(k)));

  const ev = env.events(await env.syncFees())[0].data;
  assert.equal(BigInt(ev.delta), SOL);
  assert.equal(BigInt(ev.to_king), SOL);
  assert.equal(BigInt(ev.to_dev), 0n);
  assert.equal(await env.balance(a.publicKey), a0 + SOL);
  assert.equal(await env.balance(env.dev.publicKey), dev0);
  assert.equal(await env.balance(env.pdas.vault), vault0 - SOL); // back to rent minimum
  assert.equal((await env.crown()).kingFeesThisReign, SOL);
});

test("fee split, fallback path: 95% king, 5% dev", async () => {
  const env = await Env.create({ devFeeBps: 500 });
  const a = env.wallet();
  await env.takeCrown(a, MAX);
  await env.warp(60);
  await env.dropFees(SOL + 7n); // odd amount: rounding goes to the king
  const [a0, dev0] = await Promise.all([a.publicKey, env.dev.publicKey].map((k) => env.balance(k)));

  const ev = env.events(await env.syncFees())[0].data;
  const toDev = ((SOL + 7n) * 500n) / 10_000n;
  assert.equal(BigInt(ev.to_dev), toDev);
  assert.equal(BigInt(ev.to_king), SOL + 7n - toDev);
  assert.equal(await env.balance(env.dev.publicKey), dev0 + toDev);
  assert.equal(await env.balance(a.publicKey), a0 + SOL + 7n - toDev);
  const c = await env.crown();
  assert.equal(c.totalDevFees, toDev);
  assert.equal(c.totalFees, SOL + 7n - toDev);
});

test("fees with no king go to the burn bucket", async () => {
  const env = await Env.create({ devFeeBps: 500 });
  await env.warp(60);
  await env.dropFees(SOL);
  const [burn0, dev0] = await Promise.all([env.pdas.burnBucket, env.dev.publicKey].map((k) => env.balance(k)));
  await env.syncFees();
  assert.equal(await env.balance(env.dev.publicKey), dev0 + SOL / 20n);
  assert.equal(await env.balance(env.pdas.burnBucket), burn0 + (SOL * 19n) / 20n);
  assert.equal((await env.crown()).totalBurnSol, (SOL * 19n) / 20n);
});

test("slippage guard: fails above max_price, state untouched", async () => {
  const env = await Env.create();
  const a = env.wallet();
  const b = env.wallet();
  await env.takeCrown(a, MAX);
  await env.warp(30);
  const price = await env.price();
  const b0 = await env.balance(b.publicKey);

  await fails(() => env.takeCrown(b, price - 1n), "PriceAboveMax");
  assert.ok((await env.crown()).king!.equals(a.publicKey));
  assert.equal(await env.balance(b.publicKey), b0);

  await env.takeCrown(b, price); // exactly the price is fine
  assert.ok((await env.crown()).king!.equals(b.publicKey));
});

test("self-takeover: costs the king 10% and resets the price higher", async () => {
  const env = await Env.create();
  const a = env.wallet();
  await env.takeCrown(a, MAX);
  await env.warp(120);
  const price = await env.price();
  const [a0, burn0] = await Promise.all([a.publicKey, env.pdas.burnBucket].map((k) => env.balance(k)));

  const ev = await env.takeCrown(a, MAX);
  assert.equal(await env.balance(a.publicKey), a0 - price / 10n);
  assert.equal(await env.balance(env.pdas.burnBucket), burn0 + price / 10n);
  const c = await env.crown();
  assert.ok(c.king!.equals(a.publicKey));
  assert.equal(c.takeoverCount, 2n);
  assert.equal(c.reignStartedTs, START_TS + 120n);
  assert.ok(BigInt(ev.new_price) >= (price * 13n) / 10n);
});

test("EMAs match the local model step by step", async () => {
  const env = await Env.create();
  await env.takeCrown(env.wallet(), MAX);
  let [fast, slow] = [0n, 0n];
  for (const lamports of [SOL / 10n, 0n, SOL / 3n, 12_345n, SOL, 0n, 0n, SOL / 50n]) {
    await env.warp(60);
    if (lamports > 0n) await env.dropFees(lamports);
    await env.syncFees();
    const rate = math.instRate(lamports, 60n);
    fast = math.emaStep(fast, rate, 60n, 180n);
    slow = math.emaStep(slow, rate, 60n, 900n);
    const c = await env.crown();
    assert.equal(c.fastEma, fast);
    assert.equal(c.slowEma, slow);
    assert.equal(c.meltBps, math.meltBps(fast, slow, 200, 400, 800));
  }
});

test("EMA: steady volume settles at the base melt", async () => {
  const env = await Env.create();
  await env.takeCrown(env.wallet(), MAX);
  await env.flow(180, SOL / 20n);
  const c = await env.crown();
  near(c.slowEma, Number(SOL / 20n), 20_000);
  assert.ok(Math.abs(c.meltBps - 400) <= 1, `melt ${c.meltBps}`);
});

test("EMA: volume spike -> fast above slow, slowest melt, higher floor", async () => {
  const env = await Env.create();
  await env.takeCrown(env.wallet(), MAX);
  await env.flow(180, SOL / 20n);
  const before = await env.crown();

  await env.flow(3, SOL / 2n); // 10x for three minutes
  const c = await env.crown();
  // One fast half-life: halfway from 0.05 to 0.5 SOL/min.
  near(c.fastEma, 0.275e9, 1e5);
  assert.ok(c.slowEma > before.slowEma && c.slowEma < c.fastEma);
  assert.equal(c.meltBps, 200);
  assert.ok(c.checkpointPrice >= c.fastEma * 10n); // floor followed the spike
});

test("EMA: volume crash -> fast below slow, fastest melt, lower floor", async () => {
  const env = await Env.create();
  await env.takeCrown(env.wallet(), MAX);
  await env.flow(180, SOL / 20n);
  const before = await env.crown();

  await env.flow(3, 0n); // nothing for three minutes
  const c = await env.crown();
  near(c.fastEma, 0.025e9, 1e4); // halved
  assert.ok(c.slowEma < before.slowEma && c.slowEma > c.fastEma);
  assert.equal(c.meltBps, 800);
  // The floor halved with the fee speed; the price follows it down at 8%/min.
  assert.ok(c.fastEma * 10n < before.fastEma * 10n);
  assert.ok(c.checkpointPrice < before.checkpointPrice);
  assert.ok(c.checkpointPrice > c.fastEma * 10n);
});

test("several syncs in the same second: paid at once, counted once", async () => {
  const env = await Env.create();
  const a = env.wallet();
  await env.takeCrown(a, MAX);
  await env.warp(60);
  await env.syncFees();
  const a0 = await env.balance(a.publicKey);

  await env.dropFees(SOL);
  await env.syncFees(); // dt = 0
  assert.equal(await env.balance(a.publicKey), a0 + SOL);
  assert.equal((await env.crown()).pendingFees, SOL);
  assert.equal((await env.crown()).fastEma, 0n);

  await env.warp(60);
  await env.syncFees();
  const c = await env.crown();
  assert.equal(c.pendingFees, 0n);
  assert.equal(c.fastEma, math.emaStep(0n, math.instRate(SOL, 60n), 60n, 180n));
});

test("config: changeable by the authority until locked, then frozen", async () => {
  const env = await Env.create();
  const stranger = env.wallet();
  const next = { ...env.params, burnBps: 2_000 };

  await fails(() => env.updateConfig(stranger, next), "ConfigLocked");
  await fails(() => env.updateConfig(env.authority, { ...next, devFeeBps: 1_001 }), "InvalidParams");
  await fails(() => env.updateConfig(env.authority, { ...next, meltMinBps: 900 }), "InvalidParams");
  await env.updateConfig(env.authority, next);
  assert.equal((await env.config()).params.burn_bps, 2_000);

  await fails(() => env.lockConfig(stranger), "ConfigLocked");
  await env.lockConfig(env.authority);
  assert.equal((await env.config()).authority, null);
  await fails(() => env.updateConfig(env.authority, env.params), "ConfigLocked");
  await fails(() => env.lockConfig(env.authority), "ConfigLocked");
  assert.equal((await env.config()).params.burn_bps, 2_000);

  // The game still runs after locking.
  await env.takeCrown(env.wallet(), MAX);
});

test("sync rejects a wrong king account", async () => {
  const env = await Env.create();
  await env.takeCrown(env.wallet(), MAX);
  await env.warp(60);
  await env.dropFees(SOL);
  await fails(() => env.syncFees(Keypair.generate().publicKey), "WrongKing");
});

test("a king who cannot receive lamports cannot block the game", async () => {
  const env = await Env.create();
  const a = env.wallet();
  await env.takeCrown(a, MAX);
  // King empties the wallet: a small transfer to it would break rent rules.
  env.fund(a.publicKey, 0n);
  await env.warp(60);
  await env.dropFees(1_000n);
  const burn0 = await env.balance(env.pdas.burnBucket);

  await env.syncFees();
  assert.equal(await env.balance(env.pdas.burnBucket), burn0 + 1_000n);
  assert.equal(await env.balance(a.publicKey), 0n);

  await env.takeCrown(env.wallet(), MAX); // and the crown can still be taken
});

test("view_price returns the live price", async () => {
  const env = await Env.create();
  await env.takeCrown(env.wallet(), MAX);
  await env.warp(77);
  const meta = await env.send([env.ix("view_price", {}, [
    [env.pdas.config, false, false],
    [env.pdas.crown, false, false],
  ])]);
  const data = meta.returnData;
  assert.equal(data.readBigUInt64LE(0), await env.price());
  assert.equal(data.readBigUInt64LE(8), env.params.minPrice); // floor
  assert.equal(data.readUInt16LE(16), 800);
});
