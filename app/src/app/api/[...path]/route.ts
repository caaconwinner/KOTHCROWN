// The indexer API, served from inside the website ("lite mode").
//
// Used when NEXT_PUBLIC_API_URL is "/" (same origin). It keeps events in an
// in-memory database that is rebuilt from the chain whenever the server
// starts cold, so it suits testing and low traffic. For a real launch, run
// services/crown on an always-on server and point NEXT_PUBLIC_API_URL at it.
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { buildTakeTx, createApiHandler, fetchCrownView, type ApiHandler } from "@koth-crown/services/src/api";
import { Crank } from "@koth-crown/services/src/crank";
import { Db } from "@koth-crown/services/src/db";
import { Indexer } from "@koth-crown/services/src/indexer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const POLL_MS = 4_000;
const CRANK_EVERY_S = 55;
/** A cold start reads at most this many past transactions. */
const MAX_BACKFILL = 200;

interface State {
  conn: Connection;
  mint: PublicKey;
  indexer: Indexer;
  handle: ApiHandler;
  crank: Crank | null;
  polledAt: number;
  polling: Promise<unknown> | null;
  cranking: Promise<unknown> | null;
}

function init(): State {
  const rpc = process.env.RPC_URL ?? process.env.NEXT_PUBLIC_RPC_URL;
  const mintAddress = process.env.MINT;
  if (!rpc || !mintAddress) throw new Error("RPC_URL and MINT must be set for the built-in API");
  const conn = new Connection(rpc, "confirmed");
  const mint = new PublicKey(mintAddress);
  const db = new Db(":memory:");
  // Optional: a funded keypair lets visitors' pages trigger the fee sync (see /api/crank).
  const secret = process.env.CRANK_KEYPAIR;
  const crank = secret
    ? new Crank(conn, Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secret))), mint, {
        priorityMicroLamports: 0,
        buybackMinLamports: 50_000_000n,
        buybackSlippageBps: 200,
      })
    : null;
  return {
    conn, mint, crank,
    indexer: new Indexer(conn, mint, db),
    handle: createApiHandler(db, () => fetchCrownView(conn, mint), 2_000, (buyer, maxPrice) => buildTakeTx(conn, mint, buyer, maxPrice)),
    polledAt: 0, polling: null, cranking: null,
  };
}

// One per server instance, kept across requests while it stays warm.
const g = globalThis as { __crownApi?: State };
const state = () => (g.__crownApi ??= init());

/** Catches the in-memory database up with the chain, at most every few seconds. */
async function catchUp(s: State) {
  if (Date.now() - s.polledAt < POLL_MS) return;
  s.polling ??= s.indexer.poll(false, MAX_BACKFILL)
    .catch(() => {}) // serve what we have; the next request tries again
    .finally(() => { s.polledAt = Date.now(); s.polling = null; });
  await s.polling;
}

/**
 * Pays out pending fees (pump.fun distribute + sync_fees) if nobody has in
 * the last minute. Anyone may call it: the instruction is permissionless and
 * this only decides who pays the small transaction fee.
 */
async function crankOnce(s: State): Promise<{ status: number; body: string }> {
  const reply = (body: object) => ({ status: 200, body: JSON.stringify(body) });
  if (!s.crank) return reply({ synced: false, reason: "no crank key configured" });
  const view = await fetchCrownView(s.conn, s.mint);
  if (view.now - view.checkpointTs < CRANK_EVERY_S) return reply({ synced: false, reason: "synced recently" });
  if (s.cranking) return reply({ synced: false, reason: "sync in progress" });
  s.cranking = s.crank.tick().finally(() => { s.cranking = null; });
  return reply({ synced: true, log: await s.cranking });
}

export async function GET(req: Request) {
  const headers = { "content-type": "application/json", "cache-control": "no-store" };
  try {
    const s = state();
    const url = new URL(req.url);
    if (url.pathname === "/api/crank") {
      const out = await crankOnce(s);
      return new Response(out.body, { status: out.status, headers });
    }
    if (url.pathname === "/api/history" || url.pathname === "/api/leaderboard" || url.pathname === "/api/health") await catchUp(s);
    const out = await s.handle("GET", url);
    return new Response(out.body, { status: out.status, headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), { status: 500, headers });
  }
}
