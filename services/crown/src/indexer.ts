import { Connection, PublicKey } from "@solana/web3.js";
import { crownPdas, decodeEvents } from "@koth-crown/sdk";
import type { Burn, Db, FeeSync, Takeover } from "./db";

const big = (v: unknown) => BigInt(String(v));

export interface ParsedEvents {
  takeovers: Takeover[];
  syncs: FeeSync[];
  burns: Burn[];
}

/** Turns one transaction's logs into rows. `seq` is the event's position in
 * the transaction, which keeps rows unique when a transaction has several. */
export function parseLogs(logs: string[], signature: string, slot: number): ParsedEvents {
  const out: ParsedEvents = { takeovers: [], syncs: [], burns: [] };
  decodeEvents(logs).forEach(({ name, data: d }, seq) => {
    if (name === "CrownTaken") {
      out.takeovers.push({
        signature, slot, ts: Number(d.ts), takeoverCount: Number(d.takeover_count),
        newKing: d.new_king.toBase58(), oldKing: d.old_king ? d.old_king.toBase58() : null,
        pricePaid: big(d.price_paid), toOldKing: big(d.to_old_king), toBurn: big(d.to_burn), newPrice: big(d.new_price),
        jumpBps: d.jump_bps, reignSecs: Number(d.reign_secs), oldReignFees: big(d.old_reign_fees),
      });
    } else if (name === "FeesSynced") {
      out.syncs.push({
        signature, seq, slot, ts: Number(d.ts), delta: big(d.delta), toKing: big(d.to_king), toDev: big(d.to_dev),
        toBurn: big(d.to_burn), fastEma: big(d.fast_ema), slowEma: big(d.slow_ema), meltBps: d.melt_bps,
        floor: big(d.floor), price: big(d.price),
      });
    } else if (name === "Burned") {
      out.burns.push({ signature, seq, slot, ts: Number(d.ts), solIn: big(d.sol_in), tokensBurned: big(d.tokens_burned) });
    }
  });
  return out;
}

const CURSOR = "cursor";

/**
 * Follows the Crown account's transaction history and stores its events.
 * Polling rather than a websocket subscription: it survives restarts and
 * dropped connections without missing anything, because every poll asks for
 * "everything after the last signature I stored".
 */
export class Indexer {
  private address: PublicKey;

  constructor(
    private conn: Connection,
    mint: PublicKey,
    private db: Db,
    private onTakeover: (t: Takeover) => void = () => {},
  ) {
    this.address = crownPdas(mint).crown;
  }

  /** Stores the events of one transaction. Safe to call twice for the same one. */
  ingest(logs: string[], signature: string, slot: number, announce = true): number {
    const ev = parseLogs(logs, signature, slot);
    let fresh = 0;
    for (const t of ev.takeovers) {
      if (this.db.insertTakeover(t)) {
        fresh++;
        if (announce) this.onTakeover(t);
      }
    }
    for (const s of ev.syncs) if (this.db.insertSync(s)) fresh++;
    for (const b of ev.burns) if (this.db.insertBurn(b)) fresh++;
    return fresh;
  }

  /** Fetches everything newer than the stored cursor, oldest first. Returns
   * the number of new rows. */
  async poll(announce = true): Promise<number> {
    const until = this.db.getMeta(CURSOR) ?? undefined;
    const pending: { signature: string; slot: number }[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await this.conn.getSignaturesForAddress(this.address, { until, before, limit: 1_000 }, "confirmed");
      for (const s of page) if (!s.err) pending.push({ signature: s.signature, slot: s.slot });
      if (page.length < 1_000) break;
      before = page[page.length - 1].signature;
    }
    let fresh = 0;
    for (const { signature, slot } of pending.reverse()) {
      const tx = await this.conn.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (!tx) throw new Error(`transaction ${signature} not available yet`); // retry on the next poll
      fresh += this.ingest(tx.meta?.logMessages ?? [], signature, slot, announce);
      this.db.setMeta(CURSOR, signature);
    }
    return fresh;
  }
}
