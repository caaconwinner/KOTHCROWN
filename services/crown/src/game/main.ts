// The server-run crown game: API + the loops that move money.
//   RPC_URL=... MINT=... GAME_KEYPAIR=/etc/crown/game.json DB_PATH=... PORT=8787 tsx src/game/main.ts
import { createServer } from "node:http";
import { PublicKey } from "@solana/web3.js";
import { DEFAULT_PARAMS } from "@koth-crown/sdk";
import { createApiHandler } from "../api";
import { connection, keypair, mint, num, str } from "../config";
import { Db } from "../db";
import { sleep } from "../tx";
import { CrownGame } from "./game";
import { GameStore } from "./store";

const stamp = (line: string) => line && console.log(new Date().toISOString(), line);

/** Runs `fn` every `ms`, one at a time, logging instead of crashing. */
async function every(ms: number, name: string, fn: () => Promise<string | string[]>) {
  for (;;) {
    try {
      const out = await fn();
      (Array.isArray(out) ? out : [out]).forEach(stamp);
    } catch (e) {
      stamp(`${name} failed: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
    }
    await sleep(ms);
  }
}

async function main() {
  process.env.KEYPAIR ??= process.env.GAME_KEYPAIR;
  const conn = connection();
  const path = str("DB_PATH", "./crown.sqlite");
  const db = new Db(path);
  // OPENING_PRICE_LAMPORTS: price of the first claim (cheaper for a test coin). Never below the 0.2 SOL minimum.
  const opening = BigInt(process.env.OPENING_PRICE_LAMPORTS ?? DEFAULT_PARAMS.openingPrice);
  // No buyback cooldown: the server burns right after every takeover or fortify
  // (the cooldown only guarded the permissionless on-chain buyback).
  const params = { ...DEFAULT_PARAMS, buybackCooldownS: 0, openingPrice: opening > DEFAULT_PARAMS.minPrice ? opening : DEFAULT_PARAMS.minPrice };
  const game = new CrownGame(conn, mint(), keypair(), new GameStore(db.connection), db, { params, buybackMinLamports: 5_000_000n });
  /** Reads new payments; after a takeover or fortify, burns its share at once. */
  const payments = async () => {
    const log = await game.processIncoming();
    if (log.some((l) => l.startsWith("takeover"))) log.push(await game.buyback());
    return log;
  };
  console.log(`game wallet ${game.gameWallet.toBase58()}, mint ${game.mint.toBase58()}`);

  const api = createApiHandler(db, async () => game.view(), 0, (buyer, maxPrice) => game.quote(buyer, maxPrice), {
    crankStaleS: num("CRANK_STALE_S", 300),
    crankBalance: async () => {
      // Healthy only while the wallet covers every promise plus a little for network fees.
      const bal = BigInt(await conn.getBalance(game.gameWallet, "confirmed"));
      return bal - game.liabilities();
    },
    crankMinLamports: BigInt(num("GAME_MIN_SPARE_LAMPORTS", 20_000_000)),
  });

  const port = num("PORT", 8787);
  createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" });
      res.end(JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
    };
    try {
      if (url.pathname === "/api/claim") {
        const wallet = new PublicKey(url.searchParams.get("wallet") ?? "");
        const lamports = await game.claim(wallet);
        game.payouts().catch(() => undefined);
        return send(200, { lamports });
      }
      if (url.pathname === "/api/take/confirm") {
        // The buyer's page calls this right after its payment lands, so the takeover shows at once.
        const log = await game.processIncoming();
        log.forEach(stamp);
        // Payouts and the burn run in the background: the buyer's page does not wait for them.
        game.payouts().catch(() => undefined);
        if (log.some((l) => l.startsWith("takeover"))) game.buyback().then(stamp).catch((e) => stamp(`burn failed: ${e}`));
        return send(200, { ok: true });
      }
      const out = await api(req.method ?? "GET", url);
      res.writeHead(out.status, { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" });
      res.end(out.body);
    } catch (e) {
      send(400, { error: e instanceof Error ? e.message : String(e) });
    }
  }).listen(port, () => console.log(`api: http://localhost:${port}/api/crown`));

  every(3_000, "payments", payments);
  every(3_000, "payouts", () => game.payouts());
  every(num("FEE_INTERVAL_S", 60) * 1_000, "fees", async () => [await game.collect(), await game.buyback()]);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
