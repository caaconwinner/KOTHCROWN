// The game server: one process, one writer. Every change to the game state
// happens inside `serial()`, so two takeovers can never interleave.
import { randomBytes, randomInt } from "node:crypto";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { DEFAULT_PARAMS, type Params } from "@koth-crown/sdk";
import type { CrownView, TakeTx } from "../api";
import type { Db } from "../db";
import { buildPaymentTx, buyAndBurn, collectFees, newSignatures, parsePayment, signedTransfer } from "./chain";
import { accrue, amountDue, floorOf, initialState, jumpFrom, priceAt, takeover, type GameState } from "./logic";
import type { GameStore } from "./store";

export interface GameOptions {
  params?: Params;
  /** How long a quote stays valid, seconds. */
  quoteTtlS?: number;
  /** Do not buy back less than this. */
  buybackMinLamports?: bigint;
  /** Clock, seconds. Tests replace it. */
  now?: () => number;
}

export class CrownGame {
  readonly p: Params;
  private ttl: number;
  private buybackMin: bigint;
  private clock: () => number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private conn: Connection,
    readonly mint: PublicKey,
    private wallet: Keypair,
    private store: GameStore,
    private db: Db,
    opts: GameOptions = {},
  ) {
    this.p = opts.params ?? DEFAULT_PARAMS;
    this.ttl = opts.quoteTtlS ?? 90;
    this.buybackMin = opts.buybackMinLamports ?? 10_000_000n;
    this.clock = opts.now ?? (() => Math.floor(Date.now() / 1000));
    if (!this.store.state()) this.store.saveState(initialState(this.p, BigInt(this.clock())));
  }

  get gameWallet(): PublicKey {
    return this.wallet.publicKey;
  }

  /** Runs `fn` after everything queued before it, never in parallel. */
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private state(): GameState {
    return this.store.state()!;
  }

  // ---------------------------------------------------------------- reads

  view(): CrownView {
    const s = this.state();
    const now = this.clock();
    return {
      mint: this.mint.toBase58(),
      king: s.king,
      price: priceAt(s, this.p, BigInt(now)).toString(),
      floor: floorOf(s, this.p).toString(),
      meltBps: s.meltBps,
      feesPerMinute: s.fastEma.toString(),
      checkpointPrice: s.checkpointPrice.toString(),
      checkpointTs: Number(s.checkpointTs),
      lastSyncTs: Number(s.lastSyncTs),
      reignStartedTs: Number(s.reignStartedTs),
      kingFeesThisReign: s.kingFeesThisReign.toString(),
      takeoverCount: s.takeoverCount,
      totalFees: s.totalFees.toString(),
      totalBurnSol: s.totalBurnSol.toString(),
      totalTokensBurned: s.totalTokensBurned.toString(),
      burnBucketLamports: s.burnBucket.toString(),
      locked: true,
      params: Object.fromEntries(Object.entries(this.p).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v])),
      now,
      kingOwed: s.king ? this.store.owed(s.king).toString() : "0",
      gameWallet: this.wallet.publicKey.toBase58(),
    };
  }

  /** What the game wallet must hold to cover every promise: owed fees, unsent payouts, the burn bucket. */
  liabilities(): bigint {
    return this.store.totalOwed() + this.store.unpaidTotal() + this.state().burnBucket;
  }

  // ---------------------------------------------------------------- take

  /** A quote: the current price, held for `ttl` seconds, and the payment transaction for the buyer to sign. */
  async quote(buyer: PublicKey, maxPrice: bigint): Promise<TakeTx> {
    const s = this.state();
    const now = this.clock();
    const price = priceAt(s, this.p, BigInt(now));
    if (price > maxPrice) throw new Error("PriceAboveMax: the price is above your limit");
    const amount = amountDue(s, this.p, buyer.toBase58(), price);
    const id = randomBytes(8).toString("hex");
    this.store.addQuote({ id, buyer: buyer.toBase58(), price, amount, takeoverCount: s.takeoverCount, expiresAt: now + this.ttl });
    const built = await buildPaymentTx(this.conn, buyer, this.wallet.publicKey, amount, id);
    return { ...built, maxPrice: maxPrice.toString() };
  }

  /**
   * Reads every new transaction into the game wallet, oldest first, and acts
   * on crown payments: a valid one takes the crown, anything else is refunded.
   */
  processIncoming(): Promise<string[]> {
    return this.serial(async () => {
      const log: string[] = [];
      const after = this.store.get("cursor");
      const sigs = await newSignatures(this.conn, this.wallet.publicKey, after);
      for (const { signature, err } of sigs) {
        if (!this.store.processed(signature)) {
          if (err) this.store.markProcessed(signature, "failed on chain");
          else log.push(await this.handlePayment(signature));
        }
        this.store.set("cursor", signature);
      }
      this.store.pruneQuotes(this.clock() - 3_600);
      return log.filter(Boolean);
    });
  }

  private async handlePayment(signature: string): Promise<string> {
    const tx = await this.conn.getParsedTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (!tx) throw new Error(`transaction ${signature} not found yet`); // retried on the next pass (cursor not moved)
    const pay = parsePayment(tx, signature, this.wallet.publicKey);
    if (!pay || pay.quoteId === null || pay.lamports === 0n) {
      this.store.markProcessed(signature, "not a crown payment");
      return "";
    }
    const q = this.store.quote(pay.quoteId);
    const s = this.state();
    const now = this.clock();
    const refund = (why: string) => {
      this.store.atomic(() => {
        this.store.addPayout(pay.payer, pay.lamports, "refund", now);
        this.store.markProcessed(signature, `refunded: ${why}`);
        if (q) this.store.useQuote(q.id, signature);
      });
      return `refund ${pay.lamports} to ${pay.payer}: ${why}`;
    };
    if (!q) return refund("unknown quote");
    if (q.usedBy) return refund("quote already used");
    if (q.buyer !== pay.payer) return refund("paid from a different wallet than quoted");
    if (pay.lamports < q.amount) return refund("paid less than quoted");
    if (pay.blockTime > q.expiresAt) return refund("quote expired before the payment landed");
    if (s.takeoverCount !== q.takeoverCount) return refund("someone took the crown first");

    const t = takeover(s, this.p, BigInt(pay.blockTime), pay.payer, q.price, jumpFrom(this.p, randomInt(0, 1_000_000) / 1_000_000));
    this.store.atomic(() => {
      this.store.saveState(t.state);
      this.store.useQuote(q.id, signature);
      this.store.markProcessed(signature, "takeover");
      if (pay.lamports > q.amount) this.store.addPayout(pay.payer, pay.lamports - q.amount, "refund", now);
      if (t.oldKing && t.oldKing !== pay.payer) {
        // The old king leaves with their 90% and every fee they had not claimed.
        this.store.addPayout(t.oldKing, t.toOldKing + this.store.takeOwed(t.oldKing), "takeover", now);
      }
      this.db.insertTakeover({
        signature, slot: pay.slot, ts: pay.blockTime, takeoverCount: t.state.takeoverCount, newKing: pay.payer, oldKing: t.oldKing,
        pricePaid: t.pricePaid, toOldKing: t.toOldKing, toBurn: t.toBurn, newPrice: t.newPrice, jumpBps: t.jumpBps,
        reignSecs: Number(t.reignSecs), oldReignFees: t.oldReignFees,
      });
    });
    return `takeover #${t.state.takeoverCount}: ${pay.payer} for ${q.price}`;
  }

  // ---------------------------------------------------------------- fees

  /** Collects pump.fun's creator fees into the game wallet and credits them to the king. */
  collect(): Promise<string> {
    return this.serial(async () => {
      const { income, signature } = await collectFees(this.conn, this.mint, this.wallet);
      const now = this.clock();
      const a = accrue(this.state(), this.p, BigInt(now), income);
      this.store.atomic(() => {
        this.store.saveState(a.state);
        if (a.state.king && a.toKing > 0n) this.store.addOwed(a.state.king, a.toKing);
        if (signature) {
          this.db.insertSync({
            signature, seq: 0, slot: 0, ts: now, delta: income, toKing: a.toKing, toDev: 0n, toBurn: a.toBurn,
            fastEma: a.state.fastEma, slowEma: a.state.slowEma, meltBps: a.state.meltBps, floor: a.floor, price: a.state.checkpointPrice,
          });
        }
      });
      return `fees ${income} lamports (king ${a.toKing}, burn ${a.toBurn})`;
    });
  }

  /** Pays `wallet` everything it is owed. Anyone may ask: the money only ever goes to that wallet. */
  claim(wallet: PublicKey): Promise<bigint> {
    return this.serial(async () => {
      const w = wallet.toBase58();
      return this.store.atomic(() => {
        const v = this.store.takeOwed(w);
        this.store.addPayout(w, v, "fees", this.clock());
        return v;
      });
    });
  }

  // ---------------------------------------------------------------- payouts

  /** Sends pending payouts. A payout's signature is saved before it is sent, so a crash never pays twice. */
  payouts(): Promise<string[]> {
    return this.serial(async () => {
      const log: string[] = [];
      for (const po of this.store.unfinishedPayouts()) {
        if (po.status === "sending" && po.signature) {
          const st = (await this.conn.getSignatureStatuses([po.signature], { searchTransactionHistory: true })).value[0];
          if (st && !st.err && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
            this.store.markSent(po.id);
            log.push(`paid ${po.lamports} to ${po.wallet} (${po.reason})`);
            continue;
          }
          if (st?.err || (await this.conn.getBlockHeight("confirmed")) > (po.lastValidBlockHeight ?? 0)) {
            this.store.markPending(po.id); // expired or failed: send a fresh one below
          } else continue; // still in flight
        }
        const t = await signedTransfer(this.conn, this.wallet, new PublicKey(po.wallet), po.lamports, `crown-payout:${po.id}`);
        this.store.markSending(po.id, t.signature, t.lastValidBlockHeight);
        await this.conn.sendRawTransaction(t.tx.serialize(), { skipPreflight: false, maxRetries: 3 }).catch((e) => {
          log.push(`payout ${po.id} send failed: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
        });
      }
      return log;
    });
  }

  // ---------------------------------------------------------------- burn

  /** Spends the burn bucket (at most `maxBuybackLamports`, once per cooldown) on the coin and burns it. */
  buyback(): Promise<string> {
    return this.serial(async () => {
      const s = this.state();
      const now = this.clock();
      if (BigInt(now) - s.lastBuybackTs < BigInt(this.p.buybackCooldownS)) return "";
      const spend = s.burnBucket < this.p.maxBuybackLamports ? s.burnBucket : this.p.maxBuybackLamports;
      if (spend < this.buybackMin) return "";
      const { tokensBurned, signature } = await buyAndBurn(this.conn, this.mint, this.wallet, spend);
      this.store.atomic(() => {
        const cur = this.state();
        this.store.saveState({ ...cur, burnBucket: cur.burnBucket - spend, totalTokensBurned: cur.totalTokensBurned + tokensBurned, lastBuybackTs: BigInt(now) });
        this.db.insertBurn({ signature, seq: 0, slot: 0, ts: now, solIn: spend, tokensBurned });
      });
      return `burned ${tokensBurned} tokens for ${spend} lamports`;
    });
  }
}
