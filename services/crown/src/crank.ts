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
    const { cfg, crown, bucketLamports } = await this.state();
    const p = cfg.params;
    // The chain's clock, not this machine's: the program compares against it.
    const now = BigInt((await this.conn.getBlockTime(await this.conn.getSlot("confirmed"))) ?? Math.floor(Date.now() / 1000));
    if (now - crown.lastBuybackTs < BigInt(p.buybackCooldownS)) return this.skip("cooling down");
    if (!(await this.conn.getAccountInfo(cfg.pool, "confirmed"))) return this.skip("coin has not graduated");

    const rentMin = BigInt(await this.conn.getMinimumBalanceForRentExemption(0));
    const spare = bucketLamports - rentMin - BUYBACK_RESERVE;
    const lamports = spare < p.maxBuybackLamports ? spare : p.maxBuybackLamports;
    if (lamports < this.opts.buybackMinLamports) return this.skip(`bucket has only ${spare} spare lamports`);

    const acc = await buybackAccounts(this.conn, this.mint);
    // pump.fun's own quote. The slippage allowance is what a sandwich could
    // take; the on-chain cap and cooldown bound it further.
    const quoted = await quoteBuyback(this.conn, this.mint, lamports);
    const minOut = (quoted * BigInt(10_000 - this.opts.buybackSlippageBps)) / 10_000n;
    if (minOut === 0n) return this.skip("pool quote is zero");

    const ixs: TransactionInstruction[] = [
      createAssociatedTokenAccountIdempotentInstruction(this.payer.publicKey, acc.bucketWsol, this.pdas.burnBucket, NATIVE_MINT),
      createAssociatedTokenAccountIdempotentInstruction(this.payer.publicKey, acc.bucketTokens, this.pdas.burnBucket, this.mint, acc.baseTokenProgram),
      buybackBurnIx(acc, lamports, minOut),
    ];
    const sent = await sendAndConfirm(this.conn, this.payer, ixs, { priorityMicroLamports: this.opts.priorityMicroLamports });
    const ev = decodeEvents(sent.logs).find((e) => e.name === "Burned");
    return { signature: sent.signature, solIn: lamports, tokensBurned: BigInt(String(ev?.data.tokens_burned ?? 0)) };
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
