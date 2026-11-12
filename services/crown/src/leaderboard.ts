import type { Takeover } from "./db";

export interface Entry {
  king: string;
  value: string;
  signature?: string;
}

export interface Leaderboard {
  longestReign: Entry[];
  mostEarned: Entry[];
  biggestTakeover: Entry[];
  mostBurned: Entry[];
}

const top = (m: Map<string, bigint>, n: number): Entry[] =>
  [...m.entries()].sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : a[0].localeCompare(b[0]))).slice(0, n)
    .map(([king, value]) => ({ king, value: value.toString() }));

/**
 * Built from takeover events only, so the reign in progress is not included
 * (a reign's length and fees are only final when it ends).
 *
 * - longestReign: a king's single longest finished reign, seconds
 * - mostEarned: creator fees earned over all finished reigns, lamports
 * - biggestTakeover: the largest prices ever paid, lamports
 * - mostBurned: lamports burned by a king's own takeovers
 */
export function leaderboard(takeovers: Takeover[], n = 10): Leaderboard {
  const reign = new Map<string, bigint>();
  const earned = new Map<string, bigint>();
  const burned = new Map<string, bigint>();
  for (const t of takeovers) {
    burned.set(t.newKing, (burned.get(t.newKing) ?? 0n) + t.toBurn);
    if (!t.oldKing) continue;
    const secs = BigInt(t.reignSecs);
    if (secs > (reign.get(t.oldKing) ?? -1n)) reign.set(t.oldKing, secs);
    earned.set(t.oldKing, (earned.get(t.oldKing) ?? 0n) + t.oldReignFees);
  }
  const biggest = [...takeovers].sort((a, b) => (b.pricePaid > a.pricePaid ? 1 : b.pricePaid < a.pricePaid ? -1 : a.takeoverCount - b.takeoverCount))
    .slice(0, n).map((t) => ({ king: t.newKing, value: t.pricePaid.toString(), signature: t.signature }));
  return { longestReign: top(reign, n), mostEarned: top(earned, n), biggestTakeover: biggest, mostBurned: top(burned, n) };
}
