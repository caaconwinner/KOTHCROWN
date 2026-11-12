import { createServer, type Server } from "node:http";
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { crownPdas, decodeConfig, decodeCrown, livePrice, pumpSyncInstructions, takeCrownIx } from "@koth-crown/sdk";
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
}

export async function fetchCrownView(conn: Connection, mint: PublicKey, now = Math.floor(Date.now() / 1000)): Promise<CrownView> {
  const pdas = crownPdas(mint);
  const [cfgAcc, crownAcc, bucket] = await conn.getMultipleAccountsInfo([pdas.config, pdas.crown, pdas.burnBucket], "confirmed");
  if (!cfgAcc || !crownAcc) throw new Error("crown is not initialized for this mint");
  const cfg = decodeConfig(cfgAcc.data);
  const c = decodeCrown(crownAcc.data);
  const { price, floor } = livePrice(
    { hasKing: c.king !== null, checkpointPrice: c.checkpointPrice, checkpointTs: c.checkpointTs, meltBps: c.meltBps, fastEma: c.fastEma },
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
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: buyer,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ...pump.instructions,
      takeCrownIx({ mint, buyer, king: crown.king, devWallet: cfg.devWallet, maxPrice }),
    ],
  }).compileToV0Message();
  return {
    transaction: Buffer.from(new VersionedTransaction(msg).serialize()).toString("base64"),
    blockhash,
    lastValidBlockHeight,
    maxPrice: maxPrice.toString(),
  };
}

const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

export interface ApiResponse {
  status: number;
  /** JSON text. */
  body: string;
}

export type ApiHandler = (method: string, url: URL) => Promise<ApiResponse>;

/**
 * The API as a plain function of (method, url), so the same routes can be
 * served by the standalone HTTP server below or from inside the website.
 */
export function createApiHandler(
  db: Db,
  getCrown: () => Promise<CrownView>,
  cacheMs = 2_000,
  takeTx?: (buyer: PublicKey, maxPrice: bigint) => Promise<TakeTx>,
): ApiHandler {
  let cached: { at: number; view: CrownView } | null = null;
  const send = (status: number, body: unknown): ApiResponse => ({ status, body: json(body) });
  return async (method, url) => {
    try {
      if (method !== "GET") return send(405, { error: "GET only" });
      if (url.pathname === "/api/crown") {
        if (!cached || Date.now() - cached.at > cacheMs) cached = { at: Date.now(), view: await getCrown() };
        return send(200, cached.view);
      }
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
      if (url.pathname === "/api/health") return send(200, { ok: true, ...db.counts() });
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
): Server {
  const handle = createApiHandler(db, getCrown, cacheMs, takeTx);
  return createServer(async (req, res) => {
    const out = await handle(req.method ?? "GET", new URL(req.url ?? "/", "http://localhost"));
    res.writeHead(out.status, { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" });
    res.end(out.body);
  });
}
