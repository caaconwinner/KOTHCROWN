// A scripted test session on devnet against a live site: trades to create
// fees, fee payouts, and takeovers by two throwaway wallets through the
// site's own API. Funded from ~/.config/solana/devnet.json; what is left in
// the throwaway wallets is sent back at the end.
//   pnpm tsx scripts/devnet-session.ts [site-url] [rounds]
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import BN from "bn.js";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, VersionedTransaction } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import { getBuyTokenAmountFromSolAmount, OnlinePumpSdk, PUMP_SDK } from "@pump-fun/pump-sdk";
import { Crank } from "../services/crown/src/crank";
import { sendAndConfirm, sleep } from "../services/crown/src/tx";

const load = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));
const fmt = (l: bigint | number) => `${(Number(l) / 1e9).toFixed(4)} SOL`;

let gate: Promise<unknown> = Promise.resolve();
const politeFetch: typeof fetch = async (input, init) => {
  for (let attempt = 0; ; attempt++) {
    const turn = gate.then(() => sleep(250));
    gate = turn;
    await turn;
    const res = await fetch(input, init);
    if (res.status !== 429 || attempt >= 10) return res;
    await sleep(1_000 * (attempt + 1));
  }
};

async function main() {
  const site = (process.argv[2] ?? "https://takethecrown.fun").replace(/\/$/, "");
  const rounds = Number(process.argv[3] ?? 2);
  const conn = new Connection(process.env.DEVNET_RPC ?? "https://api.devnet.solana.com", { commitment: "confirmed", fetch: politeFetch, disableRetryOnRateLimit: true });
  if ((await conn.getGenesisHash()) !== "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG") throw new Error("devnet only");
  const funder = load(`${homedir()}/.config/solana/devnet.json`);
  const crankKey = load(`${homedir()}/.config/solana/crank-devnet.json`);
  const api = async (path: string) => (await fetch(site + path)).json() as Promise<any>;
  const view = await api("/api/crown");
  const mint = new PublicKey(view.mint);
  const pump = new OnlinePumpSdk(conn);
  const crank = new Crank(conn, crankKey, mint, { priorityMicroLamports: 0, buybackMinLamports: 50_000_000n, buybackSlippageBps: 200 });
  const global = await pump.fetchGlobal();
  const feeConfig = await pump.fetchFeeConfig();
  const tokenProgram = (await conn.getAccountInfo(mint))!.owner;

  const players = [Keypair.generate(), Keypair.generate()];
  await sendAndConfirm(conn, funder, players.map((p) => SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: p.publicKey, lamports: 0.3 * LAMPORTS_PER_SOL })));
  console.log("players:", players.map((p) => p.publicKey.toBase58().slice(0, 4) + "…").join(", "));

  const buy = async (who: Keypair, sol: number) => {
    const { bondingCurveAccountInfo, bondingCurve, associatedUserAccountInfo } = await pump.fetchBuyState(mint, who.publicKey, tokenProgram);
    const solAmount = new BN(Math.round(sol * LAMPORTS_PER_SOL));
    const amount = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: bondingCurve.tokenTotalSupply, bondingCurve, amount: solAmount, quoteMint: NATIVE_MINT });
    await sendAndConfirm(conn, who, await PUMP_SDK.buyInstructions({ global, bondingCurveAccountInfo, bondingCurve, associatedUserAccountInfo, mint, user: who.publicKey, amount, solAmount, slippage: 5, tokenProgram }));
    console.log(`  trade: ${who.publicKey.toBase58().slice(0, 4)}… bought ${sol} SOL of the coin`);
  };
  const take = async (who: Keypair) => {
    const now = await api("/api/crown");
    const maxPrice = (BigInt(now.price) * 102n) / 100n;
    const built = await api(`/api/tx/take?buyer=${who.publicKey.toBase58()}&maxPrice=${maxPrice}`);
    if (!built.transaction) throw new Error(built.error ?? "site returned no transaction");
    const tx = VersionedTransaction.deserialize(Buffer.from(built.transaction, "base64"));
    tx.sign([who]);
    const sig = await conn.sendTransaction(tx);
    for (let i = 0; i < 60; i++) {
      const st = (await conn.getSignatureStatuses([sig])).value[0];
      if (st?.err) throw new Error(`take failed: ${JSON.stringify(st.err)}`);
      if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") break;
      await sleep(1_000);
    }
    console.log(`  takeover: ${who.publicKey.toBase58().slice(0, 4)}… took the crown (price was about ${fmt(BigInt(now.price))})`);
  };

  for (let r = 0; r < rounds; r++) {
    console.log(`round ${r + 1}`);
    await buy(players[r % 2], 0.04);
    await buy(players[(r + 1) % 2], 0.03);
    const s = await crank.sync();
    console.log(`  fees paid out: ${fmt(s.delta)} to the king`);
    await take(players[r % 2]);
    await sleep(20_000); // let the price melt a little, like a real gap
  }

  for (const p of players) {
    const lamports = (await conn.getBalance(p.publicKey)) - 5_000;
    if (lamports > 0) await sendAndConfirm(conn, p, [SystemProgram.transfer({ fromPubkey: p.publicKey, toPubkey: funder.publicKey, lamports })]);
  }
  await sleep(6_000);
  const end = await api("/api/crown");
  console.log(`\nsite now shows: king ${end.king.slice(0, 4)}…, price ${fmt(BigInt(end.price))}, fees ${fmt(BigInt(end.feesPerMinute))}/min, takeovers ${end.takeoverCount}, all-time fees ${fmt(BigInt(end.totalFees))}`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
