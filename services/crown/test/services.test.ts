import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Keypair } from "@solana/web3.js";
import { duration, formatTakeover, short, sol } from "../src/announcer";
import { createApi, type CrownView } from "../src/api";
import { Db, type Takeover } from "../src/db";
import { Indexer, parseLogs } from "../src/indexer";
import { leaderboard } from "../src/leaderboard";

// Real transactions recorded from devnet (scripts/record-fixtures.ts): two
// runs of the end-to-end script, so two different coins.
const fixtures: { signature: string; slot: number; logs: string[] }[] = JSON.parse(
  readFileSync(new URL("./fixtures/devnet-transactions.json", import.meta.url), "utf8"),
);

const SOL = 1_000_000_000n;
const key = () => Keypair.generate().publicKey.toBase58();
const [A, B, C] = [key(), key(), key()];

let n = 0;
const takeover = (over: Partial<Takeover>): Takeover => ({
  signature: `sig${++n}`, slot: n, ts: 1_800_000_000 + n, takeoverCount: n, newKing: A, oldKing: null,
  pricePaid: SOL, toOldKing: 0n, toBurn: SOL, newPrice: 2n * SOL, jumpBps: 15_000, reignSecs: 0, oldReignFees: 0n,
  ...over,
});

const tmpDb = () => join(mkdtempSync(join(tmpdir(), "crown-")), "test.sqlite");

test("decodes real devnet transactions", () => {
  const all = fixtures.map((f) => parseLogs(f.logs, f.signature, f.slot));
  const takeovers = all.flatMap((e) => e.takeovers);
  const syncs = all.flatMap((e) => e.syncs);
  assert.equal(takeovers.length, 3);
  assert.equal(syncs.length, 8); // 5 crank syncs + one inside each take_crown

  const first = takeovers[0];
  assert.equal(first.oldKing, null);
  assert.equal(first.pricePaid, SOL / 20n);
  assert.equal(first.toBurn, first.pricePaid);
  assert.equal(first.takeoverCount, 1);

  const last = takeovers[2];
  assert.equal(last.takeoverCount, 2);
  assert.equal(last.oldKing, takeovers[1].newKing);
  assert.equal(last.toOldKing + last.toBurn, last.pricePaid);
  assert.equal(last.toBurn, last.pricePaid / 10n);
  assert.ok(last.jumpBps >= 13_000 && last.jumpBps <= 16_000);
  assert.ok(last.oldReignFees > 0n && last.reignSecs > 0);

  for (const s of syncs) assert.equal(s.toKing + s.toDev + s.toBurn, s.delta);
});

test("ingesting the same transaction twice stores and announces it once", () => {
  const db = new Db(":memory:");
  const announced: Takeover[] = [];
  const indexer = new Indexer({} as any, Keypair.generate().publicKey, db, (t) => announced.push(t));
  for (let round = 0; round < 2; round++) {
    for (const f of fixtures) indexer.ingest(f.logs, f.signature, f.slot);
  }
  assert.deepEqual(db.counts(), { takeovers: 3, syncs: 8, burns: 0 });
  assert.equal(announced.length, 3);
});

/** Just enough of a Connection for Indexer.poll. Newest first, like the RPC. */
function fakeChain(txs: typeof fixtures) {
  let calls = 0;
  return {
    get calls() { return calls; },
    async getSignaturesForAddress(_a: unknown, opts: { until?: string }) {
      const newestFirst = [...txs].reverse();
      const stop = opts.until ? newestFirst.findIndex((t) => t.signature === opts.until) : -1;
      return (stop === -1 ? newestFirst : newestFirst.slice(0, stop)).map((t) => ({ signature: t.signature, slot: t.slot, err: null }));
    },
    async getTransaction(signature: string) {
      calls++;
      return { meta: { logMessages: txs.find((t) => t.signature === signature)!.logs } };
    },
  };
}

test("indexer resumes after a restart without losing or repeating events", async () => {
  const path = tmpDb();
  const mint = Keypair.generate().publicKey;
  const announced: string[] = [];
  const chain = fakeChain(fixtures.slice(0, 4));

  // First process: quiet backfill of what exists.
  let db = new Db(path);
  let indexer = new Indexer(chain as any, mint, db, (t) => announced.push(t.signature));
  assert.ok((await indexer.poll(false)) > 0);
  assert.equal(announced.length, 0);
  assert.equal(await indexer.poll(), 0); // nothing new
  const before = db.counts();
  db.close();

  // Restart with more history on chain.
  const chain2 = fakeChain(fixtures);
  db = new Db(path);
  indexer = new Indexer(chain2 as any, mint, db, (t) => announced.push(t.signature));
  await indexer.poll();
  assert.equal(chain2.calls, fixtures.length - 4, "only the new transactions are fetched");
  assert.deepEqual(db.counts(), { takeovers: 3, syncs: 8, burns: 0 });
  assert.ok(db.counts().syncs > before.syncs);
  assert.equal(announced.length, 2, "only takeovers after the restart are announced");
  assert.equal(await indexer.poll(), 0);
  db.close();
});

test("a failed fetch leaves the cursor where it was", async () => {
  const db = new Db(":memory:");
  const chain = fakeChain(fixtures);
  const real = chain.getTransaction.bind(chain);
  let fail = true;
  (chain as any).getTransaction = async (sig: string) => (fail && sig === fixtures[5].signature ? null : real(sig));
  const indexer = new Indexer(chain as any, Keypair.generate().publicKey, db);
  await assert.rejects(() => indexer.poll());
  fail = false;
  await indexer.poll();
  assert.deepEqual(db.counts(), { takeovers: 3, syncs: 8, burns: 0 });
});

test("leaderboard", () => {
  const rows = [
    takeover({ newKing: A, pricePaid: SOL, toBurn: SOL }), // first claim
    takeover({ newKing: B, oldKing: A, pricePaid: 3n * SOL, toBurn: SOL * 3n / 10n, reignSecs: 600, oldReignFees: 2n * SOL }),
    takeover({ newKing: A, oldKing: B, pricePaid: 5n * SOL, toBurn: SOL / 2n, reignSecs: 90, oldReignFees: SOL / 2n }),
    takeover({ newKing: C, oldKing: A, pricePaid: 2n * SOL, toBurn: SOL / 5n, reignSecs: 1_200, oldReignFees: SOL }),
  ];
  const lb = leaderboard(rows);
  assert.deepEqual(lb.longestReign.map((e) => [e.king, e.value]), [[A, "1200"], [B, "90"]]);
  assert.deepEqual(lb.mostEarned.map((e) => [e.king, e.value]), [[A, String(3n * SOL)], [B, String(SOL / 2n)]]);
  assert.deepEqual(lb.biggestTakeover.map((e) => e.value).slice(0, 2), [String(5n * SOL), String(3n * SOL)]);
  assert.equal(lb.biggestTakeover[0].king, A);
  assert.deepEqual(lb.mostBurned.map((e) => [e.king, e.value]), [[A, String(SOL + SOL / 2n)], [B, String(SOL * 3n / 10n)], [C, String(SOL / 5n)]]);
  assert.deepEqual(leaderboard([]), { longestReign: [], mostEarned: [], biggestTakeover: [], mostBurned: [] });
});

test("announcer messages", () => {
  const a = "7xKpAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQ2a";
  assert.equal(short(a), "7xKp…AQ2a");
  assert.equal(
    formatTakeover(takeover({ newKing: a, oldKing: B, pricePaid: 4_200_000_000n, toBurn: 420_000_000n, reignSecs: 372, oldReignFees: 1_100_000_000n })),
    "👑 7xKp…AQ2a took the crown for 4.2 SOL. Old king reigned 6m and earned 1.1 SOL. 0.42 SOL burned.",
  );
  assert.equal(
    formatTakeover(takeover({ newKing: a, pricePaid: SOL / 2n, toBurn: SOL / 2n })),
    "👑 7xKp…AQ2a claimed the crown for 0.5 SOL. 0.5 SOL burned.",
  );
  assert.match(formatTakeover(takeover({ newKing: a, oldKing: a, pricePaid: SOL, toBurn: SOL / 10n, reignSecs: 30 })), /fortified the crown for 0\.1 SOL/);
  assert.equal(sol(1_999_999_999n), "2");
  assert.equal(sol(1_004_999_999n), "1");
  assert.equal(sol(1_005_000_000n), "1.01");
  assert.equal(sol(0n), "0");
  assert.equal(sol(123_456_789n, 4), "0.1235");
  assert.deepEqual([5, 59, 60, 3_599, 3_600, 5_400].map(duration), ["5s", "59s", "1m", "59m", "1h", "1h 30m"]);
});

test("api", async () => {
  const db = new Db(":memory:");
  for (let i = 0; i < 5; i++) db.insertTakeover(takeover({ takeoverCount: i + 1, newKing: i % 2 ? B : A, oldKing: i ? (i % 2 ? A : B) : null, reignSecs: i * 10, oldReignFees: BigInt(i) * SOL }));
  db.insertBurn({ signature: "b1", seq: 0, slot: 1, ts: 1, solIn: SOL / 4n, tokensBurned: 500_000n });
  let chainCalls = 0;
  const view = { mint: A, king: B, price: "123" } as unknown as CrownView;
  const server = createApi(db, async () => { chainCalls++; return view; });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const get = async (path: string) => {
    const res = await fetch(base + path);
    return { status: res.status, body: await res.json() as any, cors: res.headers.get("access-control-allow-origin") };
  };
  try {
    const crown = await get("/api/crown");
    assert.equal(crown.status, 200);
    assert.equal(crown.cors, "*");
    assert.deepEqual(crown.body, { mint: A, king: B, price: "123" });
    await get("/api/crown");
    assert.equal(chainCalls, 1, "second request served from the cache");

    const page1 = await get("/api/history?limit=2");
    assert.deepEqual(page1.body.takeovers.map((t: any) => t.takeoverCount), [5, 4]);
    assert.equal(typeof page1.body.takeovers[0].pricePaid, "string");
    const page2 = await get(`/api/history?limit=2&before=${page1.body.takeovers[1].takeoverCount}`);
    assert.deepEqual(page2.body.takeovers.map((t: any) => t.takeoverCount), [3, 2]);
    assert.equal((await get("/api/history?before=abc")).status, 400);
    assert.equal((await get("/api/history?limit=100000")).body.takeovers.length, 5);

    const lb = await get("/api/leaderboard");
    assert.equal(lb.body.totals.takeovers, 5);
    assert.equal(lb.body.totals.solBoughtBack, String(SOL / 4n));
    assert.equal(lb.body.totals.tokensBurned, "500000");
    assert.equal(lb.body.longestReign[0].value, "40");

    assert.equal((await get("/api/tx/take?buyer=" + A + "&maxPrice=1")).status, 404, "tx endpoint is off unless a builder is given");
    assert.equal((await get("/api/nope")).status, 404);
    assert.equal((await fetch(base + "/api/crown", { method: "POST" })).status, 405);
    assert.equal((await get("/api/health")).body.ok, true);
  } finally {
    server.close();
  }
});

test("api reports a chain failure as a 500, not a crash", async () => {
  const server = createApi(new Db(":memory:"), async () => { throw new Error("rpc down"); });
  await new Promise<void>((r) => server.listen(0, r));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/crown`);
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: "rpc down" });
  } finally {
    server.close();
  }
});

test("api: take-crown transaction endpoint validates its input", async () => {
  const calls: [string, bigint][] = [];
  const server = createApi(new Db(":memory:"), async () => ({}) as CrownView, 0, async (buyer, maxPrice) => {
    calls.push([buyer.toBase58(), maxPrice]);
    return { transaction: "AAAA", blockhash: "x", lastValidBlockHeight: 1, maxPrice: maxPrice.toString() };
  });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/tx/take`;
  const status = async (q: string) => (await fetch(base + q)).status;
  try {
    assert.equal(await status(""), 400);
    assert.equal(await status("?buyer=notakey&maxPrice=5"), 400);
    assert.equal(await status(`?buyer=${A}`), 400);
    assert.equal(await status(`?buyer=${A}&maxPrice=0`), 400);
    assert.equal(await status(`?buyer=${A}&maxPrice=-5`), 400);
    assert.equal(await status(`?buyer=${A}&maxPrice=1.5`), 400);
    assert.equal(await status(`?buyer=${A}&maxPrice=18446744073709551616`), 400);
    assert.equal(calls.length, 0);
    const ok = await fetch(`${base}?buyer=${A}&maxPrice=3410000000`);
    assert.equal(ok.status, 200);
    assert.equal((await ok.json() as any).maxPrice, "3410000000");
    assert.deepEqual(calls, [[A, 3_410_000_000n]]);
  } finally {
    server.close();
  }
});
