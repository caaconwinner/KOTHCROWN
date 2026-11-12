// Indexer + API + announcer in one process. The crank runs separately
// (`pnpm --filter @koth-crown/services crank`) because it needs a keypair.
import { announce } from "./announcer";
import { buildTakeTx, createApi, fetchCrownView } from "./api";
import { connection, mint, num, str } from "./config";
import { Db } from "./db";
import { Indexer } from "./indexer";
import { sleep } from "./tx";

async function main() {
  const conn = connection();
  const m = mint();
  const db = new Db(str("DB_PATH", "./crown.sqlite"));
  const indexer = new Indexer(conn, m, db, announce);

  // Catch up quietly, then announce only what happens from now on.
  const backfilled = await indexer.poll(false);
  console.log(`indexer: backfilled ${backfilled} rows`, db.counts());

  const port = num("PORT", 8787);
  createApi(db, () => fetchCrownView(conn, m), 2_000, (buyer, maxPrice) => buildTakeTx(conn, m, buyer, maxPrice)).listen(port, () => console.log(`api: http://localhost:${port}/api/crown`));

  const pollMs = num("POLL_MS", 5_000);
  for (;;) {
    await sleep(pollMs);
    try {
      await indexer.poll();
    } catch (e) {
      console.error("indexer:", e instanceof Error ? e.message : e);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
