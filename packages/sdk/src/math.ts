// BigInt mirror of programs/crown/src/math.rs. Same operations in the same
// order, so results match the program to the lamport. Change both together.

export const ONE = 1n << 32n;
export const LN2 = 2_977_044_472n;
export const BPS = 10_000n;
const U64_MAX = (1n << 64n) - 1n;

const min = (a: bigint, b: bigint) => (a < b ? a : b);
const max = (a: bigint, b: bigint) => (a > b ? a : b);

/** e^(-y), y >= 0, Q32. */
export function expNeg(y: bigint): bigint {
  const halvings = y / LN2;
  if (halvings >= 64n) return 0n;
  const r = y % LN2;
  let sum = ONE;
  let term = ONE;
  for (let n = 1n; n <= 24n; n++) {
    term = (term * r) / ONE / n;
    if (term === 0n) break;
    sum = n % 2n === 1n ? sum - term : sum + term;
  }
  return max(sum, 0n) >> halvings;
}

/** -ln(1 - x), 0 <= x <= 0.5, Q32. */
export function negLnOneMinus(x: bigint): bigint {
  x = min(x, ONE / 2n);
  let sum = 0n;
  let pow = ONE;
  for (let k = 1n; k <= 64n; k++) {
    pow = (pow * x) / ONE;
    if (pow === 0n) break;
    sum += pow / k;
  }
  return sum;
}

/** 2^(-dt / halfLife), Q32. */
export function pow2Neg(dtSecs: bigint, halfLifeSecs: bigint): bigint {
  return expNeg((LN2 * dtSecs) / max(halfLifeSecs, 1n));
}

/** Fraction of the price left after `secs` at `meltBps` per minute, Q32. */
export function decay(meltBps: number, secs: bigint): bigint {
  const perMin = negLnOneMinus((BigInt(meltBps) * ONE) / BPS);
  return expNeg((perMin * min(secs, 1n << 40n)) / 60n);
}

export function emaStep(ema: bigint, instRate: bigint, dtSecs: bigint, halfLifeSecs: bigint): bigint {
  const alpha = ONE - pow2Neg(dtSecs, halfLifeSecs);
  return instRate >= ema
    ? ema + ((instRate - ema) * alpha) / ONE
    : ema - ((ema - instRate) * alpha) / ONE;
}

/** Lamports per minute. */
export function instRate(lamports: bigint, dtSecs: bigint): bigint {
  return min((lamports * 60n) / max(dtSecs, 1n), U64_MAX);
}

export function meltBps(fastEma: bigint, slowEma: bigint, mn: number, base: number, mx: number): number {
  const ratio = (fastEma * BPS) / max(slowEma, 1n);
  const [lo, b, hi] = [BigInt(mn), BigInt(base), BigInt(mx)];
  let m: bigint;
  if (ratio <= 8_000n) m = hi;
  else if (ratio <= 10_000n) m = hi - ((hi - b) * (ratio - 8_000n)) / 2_000n;
  else if (ratio < 12_000n) m = b - ((b - lo) * (ratio - 10_000n)) / 2_000n;
  else m = lo;
  return Number(m);
}

export function floorPrice(fastEma: bigint, floorMinutes: number, minPrice: bigint): bigint {
  return max(min(fastEma * BigInt(floorMinutes), U64_MAX), minPrice);
}

export function priceNow(checkpointPrice: bigint, melt: number, secs: bigint, floor: bigint): bigint {
  return max((checkpointPrice * decay(melt, secs)) / ONE, floor);
}

export function bpsOf(amount: bigint, bps: number): bigint {
  return min((amount * BigInt(bps)) / BPS, U64_MAX);
}
