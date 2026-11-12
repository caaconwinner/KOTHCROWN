// Runs the Phase 3 services against the chain state scripts/fork/e2e.ts left
// on the local validator: indexer backfill, API, one crank sync, one buyback.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { buildClaimTx, buildTakeTx, createApi, fetchCrownView } from "../../services/crown/src/api";
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

  // The transaction the website asks for: built by the API, signed by the buyer.
  const buyer = Keypair.generate();
  await conn.confirmTransaction(await conn.requestAirdrop(buyer.publicKey, 50 * 1e9), "confirmed");
  await new Promise((r) => setTimeout(r, 7_000)); // past the fork's 5s buyback cooldown
  const live = await get("/api/crown");
  const built = await buildTakeTx(conn, mint, buyer.publicKey, (BigInt(live.price) * 101n) / 100n);
  const tx = VersionedTransaction.deserialize(Buffer.from(built.transaction, "base64"));
  tx.sign([buyer]);
  const sig = await conn.sendTransaction(tx);
  await conn.confirmTransaction({ signature: sig, blockhash: built.blockhash, lastValidBlockHeight: built.lastValidBlockHeight }, "confirmed");
  assert.equal((await fetchCrownView(conn, mint)).king, buyer.publicKey.toBase58());
  await indexer.poll();
  assert.equal(announced.length, 1);
  console.log(`  ok   api-built take_crown landed (${tx.serialize().length} bytes): ${formatTakeover(announced[0])}`);

  // Burn on takeover: the API adds a buyback-and-burn transaction once the
  // coin has graduated and the cooldown has passed.
  assert.ok(built.burn, "graduated coin past its cooldown: the take comes with a burn transaction");
  const burnTx = VersionedTransaction.deserialize(Buffer.from(built.burn!, "base64"));
  burnTx.sign([buyer]);
  const burnsBefore = db.counts().burns;
  const burnSig = await conn.sendTransaction(burnTx);
  await conn.confirmTransaction({ signature: burnSig, blockhash: built.blockhash, lastValidBlockHeight: built.lastValidBlockHeight }, "confirmed");
  await indexer.poll();
  assert.equal(db.counts().burns, burnsBefore + 1);
  console.log(`  ok   burn sent right after the takeover landed (${burnTx.serialize().length} bytes)`);

  // The king's claim button: pump.fun distribute + sync_fees, paid by the king.
  const kingBefore = await conn.getBalance(buyer.publicKey);
  const syncsBefore = db.counts().syncs;
  const claim = await buildClaimTx(conn, mint, buyer.publicKey);
  const claimTx = VersionedTransaction.deserialize(Buffer.from(claim.transaction, "base64"));
  claimTx.sign([buyer]);
  const claimSig = await conn.sendTransaction(claimTx);
  await conn.confirmTransaction({ signature: claimSig, blockhash: claim.blockhash, lastValidBlockHeight: claim.lastValidBlockHeight }, "confirmed");
  await indexer.poll();
  assert.equal(db.counts().syncs, syncsBefore + 1);
  console.log(`  ok   king claimed fees with the button's transaction (balance ${kingBefore} -> ${await conn.getBalance(buyer.publicKey)} lamports)`);

  // A price limit below the current price must be refused by the program.
  const low = await buildTakeTx(conn, mint, cranker.publicKey, 1n);
  const sim = await conn.simulateTransaction(VersionedTransaction.deserialize(Buffer.from(low.transaction, "base64")), { sigVerify: false });
  assert.ok(JSON.stringify(sim.value.logs).includes("PriceAboveMax"), "slippage guard holds");
  console.log("  ok   take_crown with a too-low price limit is rejected (PriceAboveMax)");

  server.close();
  console.log("\nSERVICES CHECK PASSED");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
