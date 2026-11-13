// Everything the page computes locally. Pure functions, no React, so they can
// be tested against the same numbers the program produces.
//
// Only the SDK's math file is imported: it is plain BigInt with no
// dependencies, and mirrors programs/crown/src/math.rs line for line.
import * as math from "@koth-crown/sdk/src/math";
import type { CrownView } from "./api";

export const LAMPORTS_PER_SOL = 1_000_000_000n;

export interface Live {
  price: bigint;
  floor: bigint;
}

/**
 * The crown's price at `nowSecs`, from the last on-chain checkpoint. This is
 * the program's own formula, so the number on screen is what `take_crown`
 * would charge at that second (until the next sync moves the checkpoint).
 */
export function priceAt(view: CrownView, nowSecs: number): Live {
  const floor = BigInt(view.floor);
  if (!view.king) return { price: BigInt(view.price), floor };
  const secs = BigInt(Math.max(0, Math.floor(nowSecs) - view.checkpointTs));
  return { price: math.priceNow(BigInt(view.checkpointPrice), view.meltBps, secs, floor), floor };
}

/** How much of the crown is left: 1 right after a takeover, 0 at the floor. */
export function meltFraction(price: bigint, floor: bigint, startPrice: bigint | null): number {
  if (price <= floor) return 0;
  if (startPrice === null || startPrice <= floor) return 1;
  const f = Number(((price - floor) * 10_000n) / (startPrice - floor)) / 10_000;
  return Math.min(1, Math.max(0, f));
}

export type Heat = "gold" | "ember" | "red";

/** The live game's melt range, bps per minute: 4% rising, 8% flat, 16% drying up. */
export const MELT = { baseBps: 800, maxBps: 1_600 };

/** Crown and melt bar colour, from the melt rate (DESIGN.md): red at the fastest melt, orange from halfway between flat and fastest. */
export function heat(meltBps: number, maxBps = MELT.maxBps, baseBps = MELT.baseBps): Heat {
  return meltBps >= maxBps ? "red" : meltBps >= (baseBps + maxBps) / 2 ? "ember" : "gold";
}

// ---- the pixel crown

/** The crown's silhouette, 11 x 6. Row 5 is the band: the floor, it never melts. */
export const CROWN_ROWS = ["X....X....X", "X....X....X", "XX..XXX..XX", "XXXXXXXXXXX", "XXXXXXXXXXX", "XXXXXXXXXXX"];
/** Each silhouette pixel is drawn as SCALE x SCALE small pixels. */
export const CROWN_SCALE = 3;
export const CROWN_W = 11 * CROWN_SCALE;
/** Rows (in small pixels) above the band. */
export const CROWN_BODY_H = 5 * CROWN_SCALE;
export const CROWN_H = 6 * CROWN_SCALE;

export interface Cell { x: number; y: number }

const smallCells = (rows: string[], rowOffset: number): Cell[] =>
  rows.flatMap((row, ry) => [...row].flatMap((c, rx) => {
    if (c !== "X") return [];
    const out: Cell[] = [];
    for (let dy = 0; dy < CROWN_SCALE; dy++) for (let dx = 0; dx < CROWN_SCALE; dx++) {
      out.push({ x: rx * CROWN_SCALE + dx, y: (ry + rowOffset) * CROWN_SCALE + dy });
    }
    return out;
  }));

/** The band's small pixels. Always drawn. */
export const CROWN_BAND: Cell[] = smallCells(CROWN_ROWS.slice(5), 5);

/** A fixed pseudo-random number in [0, 1) for a cell, the same on every device. */
function scatter(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * The body's small pixels in the order they fall off. Scattered all over the
 * crown, with only a slight lean toward the top, so it keeps its three points
 * and reads as a crown for most of the way down.
 */
export const CROWN_MELT_ORDER: Cell[] = smallCells(CROWN_ROWS.slice(0, 5), 0)
  .map((c) => ({ c, key: (c.y / CROWN_BODY_H) * 0.3 + scatter(c.x, c.y) }))
  .sort((a, b) => a.key - b.key)
  .map((e) => e.c);

/**
 * How many of the body's pixels have fallen off: none right after a takeover
 * (fraction 1), all of them at the floor (fraction 0).
 */
export function pixelsGone(fraction: number): number {
  const f = Math.min(1, Math.max(0, fraction));
  return Math.round((1 - f) * CROWN_MELT_ORDER.length);
}

// ---- formatting

/** Lamports as "3.41 SOL"-style digits (no unit), rounded half up. */
export function sol(lamports: bigint | string, digits = 2): string {
  const v = BigInt(lamports);
  const scale = 10n ** BigInt(9 - digits);
  const rounded = (v + scale / 2n) / scale;
  const unit = 10n ** BigInt(digits);
  return `${rounded / unit}.${(rounded % unit).toString().padStart(digits, "0")}`;
}

export const short = (address: string) => `${address.slice(0, 4)}…${address.slice(-4)}`;

export function duration(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  if (s < 60) return `${s}s`;
  if (s < 3_600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3_600)}h ${Math.floor((s % 3_600) / 60)}m`;
}

export function ago(ts: number, nowSecs: number): string {
  const s = Math.max(0, Math.floor(nowSecs - ts));
  if (s < 60) return `${s}s ago`;
  if (s < 3_600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3_600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

/** The most the buyer agrees to pay: the price now plus a small allowance. */
export function maxPriceFor(price: bigint, slippageBps: number): bigint {
  return price + (price * BigInt(slippageBps)) / 10_000n;
}
