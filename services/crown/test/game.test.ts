import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_PARAMS as P, math } from "@koth-crown/sdk";
import { accrue, amountDue, initialState, jumpFrom, priceAt, stateFromJson, stateToJson, takeover } from "../src/game/logic";
import { GameStore } from "../src/game/store";

const SOL = 1_000_000_000n;
const T0 = 1_800_000_000n;
const A = "7xKpF1rstK1ngAAAAAAAAAAAAAAAAAAAAAAAAAAAQ2aa";
const B = "FiR2SecondK1ngBBBBBBBBBBBBBBBBBBBBBBBBBB9aBc";

test("game: first claim pays the opening price, all of it burned", () => {
  const s = initialState(P, T0);
  assert.equal(priceAt(s, P, T0 + 3_600n), P.openingPrice, "no melt before the first king");
  const t = takeover(s, P, T0, A, P.openingPrice, 14_000);
  assert.equal(t.toBurn, P.openingPrice);
  assert.equal(t.toOldKing, 0n);
  assert.equal(t.state.king, A);
  assert.equal(t.newPrice, (P.openingPrice * 14_000n) / 10_000n);
  assert.equal(t.state.reignPrice, t.newPrice);
  assert.equal(t.state.burnBucket, P.openingPrice);
});

test("game: takeover splits 90/10 and the price melts like the program's", () => {
  let s = takeover(initialState(P, T0), P, T0, A, P.openingPrice, 15_000).state;
  const start = s.checkpointPrice;
  // 5 minutes at the 8%/min melt of a coin with no volume.
  const p = priceAt(s, P, T0 + 300n);
  assert.equal(p, math.priceNow(start, 800, 300n, P.minPrice));
  const t = takeover(s, P, T0 + 300n, B, p, 13_000);
  assert.equal(t.toBurn + t.toOldKing, p);
  assert.equal(t.toBurn, math.bpsOf(p, 1_000));
  assert.equal(t.oldKing, A);
  assert.equal(t.reignSecs, 300n);
  s = t.state;
  assert.equal(s.takeoverCount, 2);
});

test("game: fortify costs only the burn, and the 90% stays with the king", () => {
  const s = takeover(initialState(P, T0), P, T0, A, P.openingPrice, 15_000).state;
  const price = priceAt(s, P, T0 + 60n);
  assert.equal(amountDue(s, P, A, price), math.bpsOf(price, P.burnBps));
  assert.equal(amountDue(s, P, B, price), price);
  const t = takeover(s, P, T0 + 60n, A, price, 13_000);
  assert.equal(t.toOldKing, 0n);
  assert.equal(t.toBurn, math.bpsOf(price, P.burnBps));
});

test("game: fees go to the king, or to the burn bucket with no king; floor capped and never under 0.1 SOL", () => {
  const empty = accrue(initialState(P, T0), P, T0 + 60n, SOL);
  assert.equal(empty.toBurn, SOL);
  assert.equal(empty.state.burnBucket, SOL);

  let s = takeover(initialState(P, T0), P, T0, A, P.openingPrice, 15_000).state;
  const a = accrue(s, P, T0 + 60n, 100n * SOL); // a huge burst of fees
  assert.equal(a.toKing, 100n * SOL);
  assert.equal(a.state.kingFeesThisReign, 100n * SOL);
  assert.ok(a.floor <= s.reignPrice / 2n, "fee floor capped at half the reign price");
  s = accrue(s, P, T0 + 86_400n, 0n).state; // a quiet day
  assert.equal(priceAt(s, P, T0 + 2n * 86_400n), P.minPrice);
  assert.equal(P.minPrice, SOL / 10n);
});

test("game: jump stays within 1.3x to 1.6x", () => {
  assert.equal(jumpFrom(P, 0), 13_000);
  assert.equal(jumpFrom(P, 0.999999), 16_000);
});

test("game: state survives a round trip through storage", () => {
  const s = takeover(initialState(P, T0), P, T0, A, P.openingPrice, 15_000).state;
  assert.deepEqual(stateFromJson(stateToJson(s)), s);
});

test("game store: owed balances, quotes and crash-safe payouts", () => {
  const st = new GameStore(":memory:");
  st.addOwed(A, 5n);
  st.addOwed(A, 7n);
  assert.equal(st.owed(A), 12n);
  assert.equal(st.takeOwed(A), 12n);
  assert.equal(st.owed(A), 0n);

  st.addQuote({ id: "q1", buyer: A, price: SOL, amount: SOL, takeoverCount: 3, expiresAt: 100 });
  assert.equal(st.quote("q1")!.amount, SOL);
  st.useQuote("q1", "sig");
  assert.equal(st.quote("q1")!.usedBy, "sig");

  st.addPayout(B, 9n, "takeover", 1);
  st.addPayout(B, 0n, "fees", 1); // nothing to pay: no row
  const [po] = st.unfinishedPayouts();
  assert.equal(st.unfinishedPayouts().length, 1);
  st.markSending(po.id, "sigX", 123);
  assert.equal(st.unfinishedPayouts()[0].signature, "sigX", "signature saved before sending");
  st.markPending(po.id);
  assert.equal(st.unfinishedPayouts()[0].status, "pending");
  st.markSent(po.id);
  assert.equal(st.unfinishedPayouts().length, 0);
  assert.equal(st.unpaidTotal(), 0n);

  assert.throws(() => st.atomic(() => { st.addOwed(B, 1n); throw new Error("boom"); }));
  assert.equal(st.owed(B), 0n, "a failed atomic block leaves nothing behind");
});
