import { createServer, type Server } from "node:http";
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { type TransactionInstruction } from "@solana/web3.js";
import { crownPdas, decodeConfig, decodeCrown, livePrice, pumpSyncInstructions, syncFeesIx, takeCrownIx } from "@koth-crown/sdk";
import { planBuyback } from "./crank";
import type { Db } from "./db";
import { leaderboard } from "./leaderboard";

/** `/api/crown`: everything the throne page needs, lamports as strings. */
export interface CrownView {
  mint: string;
  king: string | null;
  price: string;
  floor: string;
  meltBps: number;
  feesPerMinute: string;
  checkpointPrice: string;
  checkpointTs: number;
  /** When fees were last paid out (crank sync or takeover). */
  lastSyncTs: number;
  reignStartedTs: number;
  kingFeesThisReign: string;
  takeoverCount: number;
  totalFees: string;
  totalBurnSol: string;
  totalTokensBurned: string;
  burnBucketLamports: string;
  locked: boolean;
  params: Record<string, string | number>;
  now: number;
  /** Server-run game only: fees waiting for the king to claim, and the wallet payments go to. */
  kingOwed?: string;
  gameWallet?: string;
}

export async function fetchCrownView(conn: Connection, mint: PublicKey, now = Math.floor(Date.now() / 1000)): Promise<CrownView> {
  const pdas = crownPdas(mint);
  const [cfgAcc, crownAcc, bucket] = await conn.getMultipleAccountsInfo([pdas.config, pdas.crown, pdas.burnBucket], "confirmed");
  if (!cfgAcc || !crownAcc) throw new Error("crown is not initialized for this mint");
  const cfg = decodeConfig(cfgAcc.data);
  const c = decodeCrown(crownAcc.data);
  const { price, floor } = livePrice(
    { hasKing: c.king !== null, checkpointPrice: c.checkpointPrice, checkpointTs: c.checkpointTs, meltBps: c.meltBps, fastEma: c.fastEma, reignPrice: c.reignPrice },
    cfg.params,
    BigInt(now),
  );
  return {
    mint: mint.toBase58(),
    king: c.king?.toBase58() ?? null,
    price: price.toString(),
    floor: floor.toString(),
    meltBps: c.meltBps,
    feesPerMinute: c.fastEma.toString(),
    checkpointPrice: c.checkpointPrice.toString(),
    checkpointTs: Number(c.checkpointTs),
    lastSyncTs: Number(c.lastSyncTs),
    reignStartedTs: Number(c.reignStartedTs),
    kingFeesThisReign: c.kingFeesThisReign.toString(),
    takeoverCount: Number(c.takeoverCount),
    totalFees: c.totalFees.toString(),
    totalBurnSol: c.totalBurnSol.toString(),
    totalTokensBurned: c.totalTokensBurned.toString(),
    burnBucketLamports: (bucket?.lamports ?? 0).toString(),
    locked: cfg.authority === null,
    params: Object.fromEntries(Object.entries(cfg.params).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v])),
    now,
  };
}

export interface TakeTx {
  /** Unsigned v0 transaction, base64. The buyer is the fee payer and only signer. */
  transaction: string;
  blockhash: string;
  lastValidBlockHeight: number;
  maxPrice: string;
  /** Optional second transaction, sent after the takeover lands: the
   * buyback-and-burn, when the coin has graduated and the cooldown is over.
   * Its failure does not undo the takeover. */
  burn?: string;
}

export interface ClaimTx {
  /** Unsigned v0 transaction, base64: pump.fun distribute + `sync_fees`, paid by the king. */
  transaction: string;
  blockhash: string;
  lastValidBlockHeight: number;
}

/** Spend at least this much on a burn that rides along with a takeover. */
const BURN_MIN_LAMPORTS = 10_000_000n;
const BURN_SLIPPAGE_BPS = 200;

const toTx = (payer: PublicKey, blockhash: string, ixs: TransactionInstruction[], units = 400_000) =>
  Buffer.from(new VersionedTransaction(new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units }), ...ixs],
  }).compileToV0Message()).serialize()).toString("base64");

/** The king's "claim fees" button: pays out everything pump.fun and the vault hold for the king. */
export async function buildClaimTx(conn: Connection, mint: PublicKey, payer: PublicKey): Promise<ClaimTx> {
  const pdas = crownPdas(mint);
  const [cfgAcc, crownAcc] = await conn.getMultipleAccountsInfo([pdas.config, pdas.crown], "confirmed");
  if (!cfgAcc || !crownAcc) throw new Error("crown is not initialized for this mint");
  const cfg = decodeConfig(cfgAcc.data);
  const crown = decodeCrown(crownAcc.data);
  const pump = await pumpSyncInstructions(conn, mint, payer);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  return {
    transaction: toTx(payer, blockhash, [...pump.instructions, syncFeesIx({ mint, king: crown.king, devWallet: cfg.devWallet })]),
    blockhash,
    lastValidBlockHeight,
  };
}

/**
 * Builds the transaction a buyer signs to take the crown: pump.fun's
 * sweep/distribute instructions first (so the old king is paid up to this
 * second), then `take_crown` with the buyer's price limit. Built here so the
 * browser does not need pump.fun's SDK.
 */
export async function buildTakeTx(conn: Connection, mint: PublicKey, buyer: PublicKey, maxPrice: bigint): Promise<TakeTx> {
  const pdas = crownPdas(mint);
  const [cfgAcc, crownAcc] = await conn.getMultipleAccountsInfo([pdas.config, pdas.crown], "confirmed");
  if (!cfgAcc || !crownAcc) throw new Error("crown is not initialized for this mint");
  const cfg = decodeConfig(cfgAcc.data);
  const crown = decodeCrown(crownAcc.data);
  const pump = await pumpSyncInstructions(conn, mint, buyer);
  // This takeover's own burn share reaches the bucket first. The price only
  // melts between now and landing, so count 99% of today's share.
  const { price } = livePrice(
    { hasKing: crown.king !== null, checkpointPrice: crown.checkpointPrice, checkpointTs: crown.checkpointTs, meltBps: crown.meltBps, fastEma: crown.fastEma, reignPrice: crown.reignPrice },
    cfg.params,
    BigInt(Math.floor(Date.now() / 1000)),
  );
  const incoming = crown.king === null ? price : (price * BigInt(cfg.params.burnBps)) / 10_000n;
  // Burn on every takeover: a second transaction, so a failed buyback never blocks the takeover.
  const burn = await planBuyback(conn, mint, buyer, { buybackMinLamports: BURN_MIN_LAMPORTS, buybackSlippageBps: BURN_SLIPPAGE_BPS, extraLamports: (incoming * 99n) / 100n })
    .catch(() => ({ skip: "could not plan" }));
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  return {
    transaction: toTx(buyer, blockhash, [
      ...pump.instructions,
      takeCrownIx({ mint, buyer, king: crown.king, devWallet: cfg.devWallet, maxPrice }),
    ]),
    blockhash,
    lastValidBlockHeight,
    maxPrice: maxPrice.toString(),
    ...("ixs" in burn ? { burn: toTx(buyer, blockhash, burn.ixs) } : {}),
  };
}

const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

export interface ApiResponse {
  status: number;
  /** JSON text. */
  body: string;
}

export type ApiHandler = (method: string, url: URL) => Promise<ApiResponse>;

/** What `/api/health` checks besides the API itself. Point an uptime monitor at it: it answers 503 when something needs a human. */
export interface HealthChecks {
  /** Unhealthy when fees have not been paid out for this many seconds (the crank syncs every minute). */
  crankStaleS?: number;
  /** The crank's balance in lamports, and the level below which it needs topping up. */
  crankBalance?: () => Promise<bigint>;
  crankMinLamports?: bigint;
}

/**
 * The API as a plain function of (method, url), so the same routes can be
 * served by the standalone HTTP server below or from inside the website.
 */
export function createApiHandler(
  db: Db,
  getCrown: () => Promise<CrownView>,
  cacheMs = 2_000,
  takeTx?: (buyer: PublicKey, maxPrice: bigint) => Promise<TakeTx>,
  health: HealthChecks = {},
  claimTx?: (payer: PublicKey) => Promise<ClaimTx>,
): ApiHandler {
  let cached: { at: number; view: CrownView } | null = null;
  const crownView = async () => {
    if (!cached || cacheMs <= 0 || Date.now() - cached.at > cacheMs) cached = { at: Date.now(), view: await getCrown() };
    return cached.view;
  };
  const send = (status: number, body: unknown): ApiResponse => ({ status, body: json(body) });
  return async (method, url) => {
    try {
      if (method !== "GET") return send(405, { error: "GET only" });
      if (url.pathname === "/api/crown") return send(200, await crownView());
      if (url.pathname === "/api/history") {
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1), 200);
        const beforeRaw = url.searchParams.get("before");
        const before = beforeRaw === null ? undefined : Number(beforeRaw);
        if (before !== undefined && !Number.isInteger(before)) return send(400, { error: "before must be a takeover number" });
        return send(200, { takeovers: db.takeovers(limit, before) });
      }
      if (url.pathname === "/api/leaderboard") {
        const burns = db.burns();
        return send(200, {
          ...leaderboard(db.allTakeovers()),
          totals: {
            takeovers: db.counts().takeovers,
            solBoughtBack: burns.reduce((s, b) => s + b.solIn, 0n),
            tokensBurned: burns.reduce((s, b) => s + b.tokensBurned, 0n),
          },
        });
      }
      if (url.pathname === "/api/tx/take") {
        if (!takeTx) return send(404, { error: "not found" });
        let buyer: PublicKey;
        try {
          buyer = new PublicKey(url.searchParams.get("buyer") ?? "");
        } catch {
          return send(400, { error: "buyer must be a wallet address" });
        }
        const raw = url.searchParams.get("maxPrice") ?? "";
        if (!/^[0-9]{1,20}$/.test(raw) || BigInt(raw) === 0n || BigInt(raw) >= 1n << 64n) {
          return send(400, { error: "maxPrice must be a positive number of lamports" });
        }
        return send(200, await takeTx(buyer, BigInt(raw)));
      }
      if (url.pathname === "/api/tx/claim") {
        if (!claimTx) return send(404, { error: "not found" });
        let payer: PublicKey;
        try {
          payer = new PublicKey(url.searchParams.get("payer") ?? "");
        } catch {
          return send(400, { error: "payer must be a wallet address" });
        }
        return send(200, await claimTx(payer));
      }
      if (url.pathname === "/api/health") {
        const problems: string[] = [];
        const out: Record<string, unknown> = { ...db.counts() };
        if (health.crankStaleS !== undefined) {
          const v = await crownView();
          out.lastSyncAgeS = v.now - v.lastSyncTs;
          if (v.now - v.lastSyncTs > health.crankStaleS) problems.push(`no fee payout for ${v.now - v.lastSyncTs}s: is the crank running?`);
        }
        if (health.crankBalance) {
          const bal = await health.crankBalance();
          out.crankLamports = bal;
          if (health.crankMinLamports !== undefined && bal < health.crankMinLamports) problems.push(`crank balance ${bal} lamports is low: top it up`);
        }
        return send(problems.length ? 503 : 200, { ok: problems.length === 0, problems, ...out });
      }
      return send(404, { error: "not found" });
    } catch (e) {
      return send(500, { error: e instanceof Error ? e.message : String(e) });
    }
  };
}

export function createApi(
  db: Db,
  getCrown: () => Promise<CrownView>,
  cacheMs = 2_000,
  takeTx?: (buyer: PublicKey, maxPrice: bigint) => Promise<TakeTx>,
  health: HealthChecks = {},
  claimTx?: (payer: PublicKey) => Promise<ClaimTx>,
): Server {
  const handle = createApiHandler(db, getCrown, cacheMs, takeTx, health, claimTx);
  return createServer(async (req, res) => {
    const out = await handle(req.method ?? "GET", new URL(req.url ?? "/", "http://localhost"));
    res.writeHead(out.status, { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" });
    res.end(out.body);
  });
}
