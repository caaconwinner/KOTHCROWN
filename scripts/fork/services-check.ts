// Runs the Phase 3 services against the chain state scripts/fork/e2e.ts left
// on the local validator: indexer backfill, API, one crank sync, one buyback.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { createApi, fetchCrownView } from "../../services/crown/src/api";
import { Crank } from "../../services/crown/src/crank";
import { Db, type Takeover } from "../../services/crown/src/db";
import { Indexer } from "../../services/crown/src/indexer";
import { formatTakeover } from "../../services/crown/src/announcer";

async function main() {
  const run = JSON.parse(readFileSync(".fork/last-run.json", "utf8"));
  const conn = new Connection("http://127.0.0.1:8899", "confirmed");
  const mint = new PublicKey(run.mint);
  const cranker = Keypair.fromSecretKey(Uint8Array.from(run.cranker));
  const db = new Db(":memory:");
  const announced: Takeover[] = [];
  const indexer = new Indexer(conn, mint, db, (t) => announced.push(t));
  console.log("\n== services against the fork");

  await indexer.poll(false);
  const counts = db.counts();
  assert.equal(counts.takeovers, 3);
  assert.equal(counts.burns, 2);
  assert.ok(counts.syncs >= 9);
  assert.equal(announced.length, 0);
  console.log(`  ok   indexer backfill: ${counts.takeovers} takeovers, ${counts.syncs} syncs, ${counts.burns} burns`);
  for (const t of db.takeovers(3).reverse()) console.log(`       ${formatTakeover(t)}`);

  const server = createApi(db, () => fetchCrownView(conn, mint), 0);
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const get = async (path: string) => (await fetch(base + path)).json() as Promise<any>;
  const crown = await get("/api/crown");
  assert.equal(crown.king, run.king);
  assert.equal(crown.takeoverCount, 3);
  assert.equal(crown.locked, true);
  assert.ok(BigInt(crown.price) >= BigInt(crown.floor) && BigInt(crown.price) > 0n);
  const history = await get("/api/history");
  assert.deepEqual(history.takeovers.map((t: any) => t.takeoverCount), [3, 2, 1]);
  const lb = await get("/api/leaderboard");
  assert.equal(lb.totals.takeovers, 3);
  assert.ok(BigInt(lb.totals.tokensBurned) > 0n);
  console.log(`  ok   api: king ${crown.king.slice(0, 4)}…, price ${(Number(crown.price) / 1e9).toFixed(4)} SOL, floor ${(Number(crown.floor) / 1e9).toFixed(4)} SOL, melt ${crown.meltBps} bps/min`);

  const crank = new Crank(conn, cranker, mint, { priorityMicroLamports: 1_000, buybackMinLamports: 50_000_000n, buybackSlippageBps: 200 });
  const sync = await crank.sync();
  console.log(`  ok   crank sync ${sync.signature.slice(0, 8)}… delta ${sync.delta}`);
  await new Promise((r) => setTimeout(r, 8_000)); // let the 5s buyback cooldown from the e2e run pass
  const buy = await crank.buyback();
  assert.ok(buy && buy.tokensBurned > 0n, `crank bought back and burned (skipped: ${crank.lastSkip})`);
  console.log(`  ok   crank buyback: ${(Number(buy.solIn) / 1e9).toFixed(4)} SOL -> ${(Number(buy.tokensBurned) / 1e6).toFixed(0)} tokens burned`);
  assert.equal(await crank.buyback(), null, "second buyback waits for the cooldown");
  const lines = await crank.tick();
  assert.ok(lines.length === 1 && lines[0].startsWith("sync "), lines.join("; "));
  console.log("  ok   crank tick inside the cooldown: sync only");

  const fresh = await indexer.poll();
  assert.equal(fresh, 3); // two syncs and one burn
  assert.deepEqual(db.counts(), { takeovers: 3, syncs: counts.syncs + 2, burns: 3 });
  assert.equal(announced.length, 0);
  assert.equal((await get("/api/leaderboard")).totals.solBoughtBack !== lb.totals.solBoughtBack, true);
  console.log("  ok   indexer picked up the crank's transactions");

  server.close();
  console.log("\nSERVICES CHECK PASSED");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
