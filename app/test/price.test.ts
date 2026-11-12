import assert from "node:assert/strict";
import { test } from "node:test";
import * as math from "@koth-crown/sdk/src/math";
import type { CrownView } from "../src/lib/api";
import { ago, CROWN_BODY_ROWS, CROWN_ROWS, crownSink, duration, heat, maxPriceFor, meltFraction, priceAt, short, sol } from "../src/lib/price";

const SOL = 1_000_000_000n;
const view = (over: Partial<CrownView> = {}): CrownView => ({
  mint: "m", king: "7xKpAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQ2a", price: "0", floor: String((14n * SOL) / 10n), meltBps: 400,
  feesPerMinute: "140000000", checkpointPrice: String((341n * SOL) / 100n), checkpointTs: 1_800_000_000, reignStartedTs: 1_799_999_900,
  kingFeesThisReign: "0", takeoverCount: 3, totalFees: "0", totalBurnSol: "0", totalTokensBurned: "0", burnBucketLamports: "0",
  locked: true, params: {}, now: 1_800_000_000, ...over,
});

test("local price is the program's formula for the same checkpoint and second", () => {
  const v = view();
  for (const dt of [0, 1, 30, 60, 61, 600, 3_600, 86_400]) {
    const expected = math.priceNow(BigInt(v.checkpointPrice), v.meltBps, BigInt(dt), BigInt(v.floor));
    assert.equal(priceAt(v, v.checkpointTs + dt).price, expected, `dt ${dt}`);
  }
  // 4%/min for one minute.
  assert.ok(Math.abs(Number(priceAt(v, v.checkpointTs + 60).price) - 3.41e9 * 0.96) < 10);
  // Fractions of a second do not move it; the program only knows whole seconds.
  assert.equal(priceAt(v, v.checkpointTs + 30.9).price, priceAt(v, v.checkpointTs + 30).price);
});

test("local price never goes below the floor, and a clock behind the chain does not raise it", () => {
  const v = view();
  assert.equal(priceAt(v, v.checkpointTs + 10 * 86_400).price, BigInt(v.floor));
  assert.equal(priceAt(v, v.checkpointTs - 500).price, BigInt(v.checkpointPrice));
});

test("with no king the price is the opening price and does not tick", () => {
  const v = view({ king: null, price: String(SOL / 2n) });
  assert.equal(priceAt(v, v.checkpointTs).price, SOL / 2n);
  assert.equal(priceAt(v, v.checkpointTs + 9_999).price, SOL / 2n);
});

test("melt fraction", () => {
  assert.equal(meltFraction(3n * SOL, SOL, 3n * SOL), 1);
  assert.equal(meltFraction(2n * SOL, SOL, 3n * SOL), 0.5);
  assert.equal(meltFraction(SOL, SOL, 3n * SOL), 0);
  assert.equal(meltFraction(SOL / 2n, SOL, 3n * SOL), 0);
  assert.equal(meltFraction(4n * SOL, SOL, 3n * SOL), 1, "clamped when the floor pushed the price up");
  assert.equal(meltFraction(2n * SOL, SOL, null), 1, "unknown start price shows a whole crown");
  assert.equal(meltFraction(2n * SOL, SOL, SOL), 1);
});

test("crown colour follows the melt rate", () => {
  assert.deepEqual([200, 400, 599, 600, 799, 800].map(heat), ["gold", "gold", "gold", "ember", "ember", "red"]);
});

test("crown gauge: stands whole at 1, sunk to the band at 0, only ever sinks", () => {
  assert.equal(crownSink(1), 0);
  assert.equal(crownSink(0), CROWN_BODY_ROWS);
  assert.equal(crownSink(0.5), 2.5);
  assert.equal(crownSink(2), 0);
  assert.equal(crownSink(-1), CROWN_BODY_ROWS);
  let last = -1;
  for (let i = 0; i <= 100; i++) {
    const sink = crownSink(1 - i / 100);
    assert.ok(sink >= last && sink >= 0 && sink <= CROWN_BODY_ROWS);
    assert.equal(sink * 4, Math.round(sink * 4), "quarter-pixel steps");
    last = sink;
  }
  assert.equal(CROWN_ROWS.length, CROWN_BODY_ROWS + 1, "one band row under the body");
  assert.equal(CROWN_ROWS[CROWN_BODY_ROWS], "XXXXXXXXXXX", "the band is solid");
});

test("formatting", () => {
  assert.equal(sol(3_410_000_000n), "3.41");
  assert.equal(sol("1999999999"), "2.00");
  assert.equal(sol(1_234_567_890n, 4), "1.2346");
  assert.equal(sol(0n), "0.00");
  assert.equal(short("7xKpAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQ2a"), "7xKp…AQ2a");
  assert.deepEqual([5, 252, 3_700, -4].map(duration), ["5s", "4m 12s", "1h 1m", "0s"]);
  assert.deepEqual([10, 130, 7_300, 200_000].map((s) => ago(1_000, 1_000 + s)), ["10s ago", "2m ago", "2h ago", "2d ago"]);
});

test("price limit: the price plus the chosen allowance, rounded down", () => {
  assert.equal(maxPriceFor(SOL, 100), SOL + SOL / 100n);
  assert.equal(maxPriceFor(3n, 50), 3n);
  assert.equal(maxPriceFor(0n, 300), 0n);
});
