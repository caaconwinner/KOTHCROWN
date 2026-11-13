import * as math from "./math";

export { math };
export * from "./instructions";
export * from "./pump";

export const LAMPORTS_PER_SOL = 1_000_000_000n;

export interface Params {
  jumpMinBps: number;
  jumpMaxBps: number;
  meltMinBps: number;
  meltBaseBps: number;
  meltMaxBps: number;
  floorMinutes: number;
  burnBps: number;
  devFeeBps: number;
  fastHalfLifeS: number;
  slowHalfLifeS: number;
  openingPrice: bigint;
  minPrice: bigint;
  maxBuybackLamports: bigint;
  buybackCooldownS: number;
  floorCapBps: number;
}

/** SPEC section 3 defaults for the V1 path (pump.fun splits off the dev 15%). */
export const DEFAULT_PARAMS: Params = {
  jumpMinBps: 13_000,
  jumpMaxBps: 16_000,
  meltMinBps: 200,
  meltBaseBps: 400,
  meltMaxBps: 800,
  floorMinutes: 10,
  burnBps: 1_000,
  devFeeBps: 0,
  fastHalfLifeS: 180,
  slowHalfLifeS: 900,
  openingPrice: LAMPORTS_PER_SOL / 2n,
  minPrice: LAMPORTS_PER_SOL / 5n, // 0.2 SOL: the crown never costs less, whatever the fees
  maxBuybackLamports: LAMPORTS_PER_SOL / 2n,
  buybackCooldownS: 300,
  floorCapBps: 5_000,
};

/** The on-chain fields needed to compute the live price locally. */
export interface CrownCheckpoint {
  hasKing: boolean;
  checkpointPrice: bigint;
  checkpointTs: bigint;
  meltBps: number;
  fastEma: bigint;
  reignPrice: bigint;
}

/**
 * Price at `nowSecs`, exactly as the program would compute it from the same
 * checkpoint. Lets the UI tick every second without touching the RPC.
 */
export function livePrice(c: CrownCheckpoint, p: Params, nowSecs: bigint): { price: bigint; floor: bigint } {
  const floor = c.hasKing
    ? math.cappedFloor(c.fastEma, p.floorMinutes, p.minPrice, c.reignPrice, p.floorCapBps)
    : math.floorPrice(c.fastEma, p.floorMinutes, p.minPrice);
  if (!c.hasKing) return { price: p.openingPrice > floor ? p.openingPrice : floor, floor };
  const secs = nowSecs > c.checkpointTs ? nowSecs - c.checkpointTs : 0n;
  return { price: math.priceNow(c.checkpointPrice, c.meltBps, secs, floor), floor };
}
