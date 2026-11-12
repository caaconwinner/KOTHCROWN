import type { Takeover } from "./db";

export const short = (address: string) => `${address.slice(0, 4)}…${address.slice(-4)}`;

/** Lamports as SOL with up to `digits` decimals, trailing zeros removed. */
export function sol(lamports: bigint, digits = 2): string {
  const scale = 10n ** BigInt(9 - digits);
  const rounded = (lamports + scale / 2n) / scale;
  const whole = rounded / 10n ** BigInt(digits);
  const frac = (rounded % 10n ** BigInt(digits)).toString().padStart(digits, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export function duration(secs: number): string {
  if (secs < 60) return `${secs}s`;
  if (secs < 3_600) return `${Math.floor(secs / 60)}m`;
  const h = Math.floor(secs / 3_600);
  const m = Math.floor((secs % 3_600) / 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** One-line takeover message for X / Telegram. */
export function formatTakeover(t: Takeover): string {
  const who = short(t.newKing);
  if (!t.oldKing) {
    return `👑 ${who} claimed the crown for ${sol(t.pricePaid)} SOL. ${sol(t.toBurn)} SOL burned.`;
  }
  const head = t.oldKing === t.newKing
    ? `👑 ${who} fortified the crown for ${sol(t.toBurn)} SOL.`
    : `👑 ${who} took the crown for ${sol(t.pricePaid)} SOL.`;
  return `${head} Old king reigned ${duration(t.reignSecs)} and earned ${sol(t.oldReignFees)} SOL. ${sol(t.toBurn)} SOL burned.`;
}

/** Console for now; X and Telegram plug in here later. */
export function announce(t: Takeover) {
  console.log(formatTakeover(t));
}
