// The crown game, run by our server instead of a Solana program (owner's
// decision, 2026-11-13: no SOL for the program's rent deposit).
//
// Same rules and the same integer maths as programs/crown (SPEC section 2),
// through the BigInt mirror in packages/sdk/src/math.ts. Pure functions: no
// chain access, no clock, no randomness. The caller supplies all three.
import { math, type Params } from "@koth-crown/sdk";

export interface GameState {
  king: string | null;
  checkpointPrice: bigint;
  checkpointTs: bigint;
  meltBps: number;
  fastEma: bigint;
  slowEma: bigint;
  lastSyncTs: bigint;
  pendingFees: bigint;
  reignStartedTs: bigint;
  /** Price right after the last takeover; caps the floor during the reign. */
  reignPrice: bigint;
  takeoverCount: number;
  kingFeesThisReign: bigint;
  totalFees: bigint;
  totalBurnSol: bigint;
  totalTokensBurned: bigint;
  /** SOL set aside for the buyback-and-burn, not yet spent. */
  burnBucket: bigint;
  lastBuybackTs: bigint;
}

export function initialState(p: Params, now: bigint): GameState {
  return {
    king: null,
    checkpointPrice: p.openingPrice,
    checkpointTs: now,
    meltBps: p.meltMaxBps,
    fastEma: 0n,
    slowEma: 0n,
    lastSyncTs: now,
    pendingFees: 0n,
    reignStartedTs: now,
    reignPrice: p.openingPrice,
    takeoverCount: 0,
    kingFeesThisReign: 0n,
    totalFees: 0n,
    totalBurnSol: 0n,
    totalTokensBurned: 0n,
    burnBucket: 0n,
    lastBuybackTs: 0n,
  };
}

const max = (a: bigint, b: bigint) => (a > b ? a : b);

/** Floor in force: uncapped with no king, capped at `floorCapBps` of the reign price during a reign. */
export function floorOf(s: GameState, p: Params): bigint {
  return s.king === null
    ? math.floorPrice(s.fastEma, p.floorMinutes, p.minPrice)
    : math.cappedFloor(s.fastEma, p.floorMinutes, p.minPrice, s.reignPrice, p.floorCapBps);
}

/** Price at `now` from the checkpoint. */
export function priceAt(s: GameState, p: Params, now: bigint): bigint {
  const floor = floorOf(s, p);
  if (s.king === null) return max(p.openingPrice, floor);
  const secs = now > s.checkpointTs ? now - s.checkpointTs : 0n;
  return math.priceNow(s.checkpointPrice, s.meltBps, secs, floor);
}

export interface Accrued {
  state: GameState;
  /** Owed to the king (credited to their balance by the caller). */
  toKing: bigint;
  /** Added to the burn bucket: fees that arrived while nobody was king. */
  toBurn: bigint;
  floor: bigint;
}

/** `income` lamports of fees arrived at `now`: pay them to the king, update fee speed, melt and floor, re-checkpoint. */
export function accrue(prev: GameState, p: Params, now: bigint, income: bigint): Accrued {
  const s = { ...prev };
  const toKing = s.king !== null ? income : 0n;
  const toBurn = s.king !== null ? 0n : income;
  const price = priceAt(s, p, now);

  s.pendingFees += income;
  const dt = now - s.lastSyncTs;
  if (dt > 0n) {
    const rate = math.instRate(s.pendingFees, dt);
    s.fastEma = math.emaStep(s.fastEma, rate, dt, BigInt(p.fastHalfLifeS));
    s.slowEma = math.emaStep(s.slowEma, rate, dt, BigInt(p.slowHalfLifeS));
    s.pendingFees = 0n;
    s.lastSyncTs = now;
  }
  const floor = floorOf(s, p);
  s.meltBps = math.meltBps(s.fastEma, s.slowEma, p.meltMinBps, p.meltBaseBps, p.meltMaxBps);
  s.checkpointPrice = s.king !== null ? max(price, floor) : max(p.openingPrice, floor);
  s.checkpointTs = now;
  s.kingFeesThisReign += toKing;
  s.totalFees += income;
  s.totalBurnSol += toBurn;
  s.burnBucket += toBurn;
  return { state: s, toKing, toBurn, floor };
}

/** What a buyer must send to take the crown at `price`. Fortifying (the king buys again) only costs the burn. */
export function amountDue(s: GameState, p: Params, buyer: string, price: bigint): bigint {
  return s.king !== null && s.king === buyer ? math.bpsOf(price, p.burnBps) : price;
}

export interface Takeover {
  state: GameState;
  oldKing: string | null;
  pricePaid: bigint;
  /** Owed to the old king (90%). 0 on the first claim and on fortify. */
  toOldKing: bigint;
  toBurn: bigint;
  newPrice: bigint;
  jumpBps: number;
  reignSecs: bigint;
  oldReignFees: bigint;
}

/**
 * `buyer` takes the crown at `now` for `price` (the price they were quoted).
 * `jumpBps` is the random 1.3x to 1.6x jump, drawn by the caller.
 */
export function takeover(prev: GameState, p: Params, now: bigint, buyer: string, price: bigint, jumpBps: number): Takeover {
  const { state: s, floor } = accrue(prev, p, now, 0n);
  const oldKing = s.king;
  let toBurn = math.bpsOf(price, p.burnBps);
  let toOldKing = price - toBurn;
  if (oldKing === null) {
    toBurn = price;
    toOldKing = 0n;
  } else if (oldKing === buyer) {
    toOldKing = 0n; // the 90% would go from the king to the king: it is never sent
  }
  const newPrice = max(math.bpsOf(price, jumpBps), floor);
  const reignSecs = now > s.reignStartedTs ? now - s.reignStartedTs : 0n;
  const oldReignFees = s.kingFeesThisReign;
  const next: GameState = {
    ...s,
    king: buyer,
    checkpointPrice: newPrice,
    checkpointTs: now,
    reignStartedTs: now,
    reignPrice: newPrice,
    takeoverCount: s.takeoverCount + 1,
    kingFeesThisReign: 0n,
    totalBurnSol: s.totalBurnSol + toBurn,
    burnBucket: s.burnBucket + toBurn,
  };
  return { state: next, oldKing, pricePaid: price, toOldKing, toBurn, newPrice, jumpBps, reignSecs, oldReignFees };
}

/** Random jump in [jumpMinBps, jumpMaxBps] from a uniform random number in [0, 1). */
export function jumpFrom(p: Params, r: number): number {
  return p.jumpMinBps + Math.floor(r * (p.jumpMaxBps - p.jumpMinBps + 1));
}

// ---- storage helpers: bigints as strings

export const stateToJson = (s: GameState) => JSON.stringify(s, (_, v) => (typeof v === "bigint" ? `${v}n` : v));
export const stateFromJson = (j: string): GameState =>
  JSON.parse(j, (_, v) => (typeof v === "string" && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v));
