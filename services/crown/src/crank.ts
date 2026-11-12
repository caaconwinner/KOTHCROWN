import { Connection, Keypair, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, NATIVE_MINT } from "@solana/spl-token";
import {
  buybackAccounts,
  buybackBurnIx,
  crownPdas,
  decodeConfig,
  decodeCrown,
  decodeEvents,
  pumpSyncInstructions,
  quoteBuyback,
  syncFeesIx,
} from "@koth-crown/sdk";
import { sendAndConfirm, sleep } from "./tx";

export interface CrankOptions {
  priorityMicroLamports: number;
  /** Do not bother buying back less than this. */
  buybackMinLamports: bigint;
  /** How far below the quoted amount a buyback may land, in bps. */
  buybackSlippageBps: number;
}

/** Leaves room in the bucket for the one-off PumpSwap volume-accumulator rent. */
const BUYBACK_RESERVE = 3_000_000n;

export type BuybackPlan =
  | { ixs: TransactionInstruction[]; lamports: bigint; minOut: bigint }
  | { skip: string };

/**
 * What a `buyback_burn` would do right now, paid by `payer`: the instructions
 * (bucket token accounts first), or why there is nothing to do. Used by the
 * crank and by the takeover transaction (burn on every takeover).
 */
export async function planBuyback(
  conn: Connection,
  mint: PublicKey,
  payer: PublicKey,
  opts: { buybackMinLamports: bigint; buybackSlippageBps: number; extraLamports?: bigint },
): Promise<BuybackPlan> {
  const pdas = crownPdas(mint);
  const [cfgAcc, crownAcc, bucket] = await conn.getMultipleAccountsInfo([pdas.config, pdas.crown, pdas.burnBucket], "confirmed");
  if (!cfgAcc || !crownAcc) throw new Error("crown is not initialized for this mint");
  const cfg = decodeConfig(cfgAcc.data);
  const crown = decodeCrown(crownAcc.data);
  const p = cfg.params;
  // The chain's clock, not this machine's: the program compares against it.
  const now = BigInt((await conn.getBlockTime(await conn.getSlot("confirmed"))) ?? Math.floor(Date.now() / 1000));
  if (now - crown.lastBuybackTs < BigInt(p.buybackCooldownS)) return { skip: "cooling down" };
  if (!(await conn.getAccountInfo(cfg.pool, "confirmed"))) return { skip: "coin has not graduated" };

  const rentMin = BigInt(await conn.getMinimumBalanceForRentExemption(0));
  // `extraLamports`: SOL that will reach the bucket before this runs (a takeover's 10%).
  const spare = BigInt(bucket?.lamports ?? 0) + (opts.extraLamports ?? 0n) - rentMin - BUYBACK_RESERVE;
  const lamports = spare < p.maxBuybackLamports ? spare : p.maxBuybackLamports;
  if (lamports < opts.buybackMinLamports) return { skip: `bucket has only ${spare} spare lamports` };

  const acc = await buybackAccounts(conn, mint);
  // pump.fun's own quote. The slippage allowance is what a sandwich could
  // take; the on-chain cap and cooldown bound it further.
  const quoted = await quoteBuyback(conn, mint, lamports);
  const minOut = (quoted * BigInt(10_000 - opts.buybackSlippageBps)) / 10_000n;
  if (minOut === 0n) return { skip: "pool quote is zero" };
  return {
    lamports,
    minOut,
    ixs: [
      createAssociatedTokenAccountIdempotentInstruction(payer, acc.bucketWsol, pdas.burnBucket, NATIVE_MINT),
      createAssociatedTokenAccountIdempotentInstruction(payer, acc.bucketTokens, pdas.burnBucket, mint, acc.baseTokenProgram),
      buybackBurnIx(acc, lamports, minOut),
    ],
  };
}

export class Crank {
  private pdas;
  /** Why the last `buyback()` did nothing. */
  lastSkip = "";

  constructor(private conn: Connection, private payer: Keypair, private mint: PublicKey, private opts: CrankOptions) {
    this.pdas = crownPdas(mint);
  }

  private async state() {
    const [cfgAcc, crownAcc, bucket] = await this.conn.getMultipleAccountsInfo(
      [this.pdas.config, this.pdas.crown, this.pdas.burnBucket], "confirmed");
    if (!cfgAcc || !crownAcc) throw new Error("crown is not initialized for this mint");
    return { cfg: decodeConfig(cfgAcc.data), crown: decodeCrown(crownAcc.data), bucketLamports: BigInt(bucket?.lamports ?? 0) };
  }

  private skip(why: string): null {
    this.lastSkip = why;
    return null;
  }

  /** pump.fun sweep/distribute + `sync_fees`, in one transaction. */
  async sync(): Promise<{ signature: string; delta: bigint }> {
    const { cfg, crown } = await this.state();
    const pump = await pumpSyncInstructions(this.conn, this.mint, this.payer.publicKey);
    const ixs = [...pump.instructions, syncFeesIx({ mint: this.mint, king: crown.king, devWallet: cfg.devWallet })];
    const sent = await sendAndConfirm(this.conn, this.payer, ixs, { priorityMicroLamports: this.opts.priorityMicroLamports });
    const ev = decodeEvents(sent.logs).find((e) => e.name === "FeesSynced");
    return { signature: sent.signature, delta: BigInt(String(ev?.data.delta ?? 0)) };
  }

  /** Runs `buyback_burn` if the coin has graduated, the cooldown has passed
   * and the bucket holds enough. Returns null when there is nothing to do. */
  async buyback(): Promise<{ signature: string; solIn: bigint; tokensBurned: bigint } | null> {
    const plan = await planBuyback(this.conn, this.mint, this.payer.publicKey, this.opts);
    if ("skip" in plan) return this.skip(plan.skip);
    const sent = await sendAndConfirm(this.conn, this.payer, plan.ixs, { priorityMicroLamports: this.opts.priorityMicroLamports });
    const ev = decodeEvents(sent.logs).find((e) => e.name === "Burned");
    return { signature: sent.signature, solIn: plan.lamports, tokensBurned: BigInt(String(ev?.data.tokens_burned ?? 0)) };
  }

  /** One round. Errors are returned, not thrown, so the loop keeps going. */
  async tick(): Promise<string[]> {
    const lines: string[] = [];
    try {
      const s = await this.sync();
      lines.push(`sync ${s.signature} delta ${s.delta} lamports`);
    } catch (e) {
      lines.push(`sync failed: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
    }
    try {
      const b = await this.buyback();
      if (b) lines.push(`buyback ${b.signature} spent ${b.solIn} lamports, burned ${b.tokensBurned} tokens`);
    } catch (e) {
      lines.push(`buyback failed: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
    }
    return lines;
  }

  /** Ticks forever, one at a time. A slow tick delays the next; it never overlaps it. */
  async run(intervalS: number) {
    for (;;) {
      const started = Date.now();
      for (const line of await this.tick()) console.log(new Date().toISOString(), line);
      await sleep(Math.max(0, intervalS * 1_000 - (Date.now() - started)));
    }
  }
}
