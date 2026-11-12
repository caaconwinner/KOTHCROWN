// Creates a TEST coin on devnet with its crown, for the test-mode website.
//   pnpm tsx scripts/devnet-launch.ts
// Uses ~/.config/solana/devnet.json as creator and dev wallet. Refuses to run
// on anything but devnet. Writes the result to .fork/devnet-launch.json and a
// small crank keypair to ~/.config/solana/crank-devnet.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import BN from "bn.js";
import { Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { getBuyTokenAmountFromSolAmount, OnlinePumpSdk, PUMP_SDK } from "@pump-fun/pump-sdk";
import { crownPdas, DEFAULT_PARAMS, initializeIx } from "@koth-crown/sdk";
import { sendAndConfirm, sleep } from "../services/crown/src/tx";

const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const load = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));

// The public devnet RPC rate-limits hard: space requests out and retry 429s.
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
  const conn = new Connection(process.env.DEVNET_RPC ?? "https://api.devnet.solana.com", { commitment: "confirmed", fetch: politeFetch, disableRetryOnRateLimit: true });
  if ((await conn.getGenesisHash()) !== DEVNET_GENESIS) throw new Error("this script only runs on devnet");
  const creator = load(`${homedir()}/.config/solana/devnet.json`);
  const crankPath = `${homedir()}/.config/solana/crank-devnet.json`;
  const crank = existsSync(crankPath) ? load(crankPath) : Keypair.generate();
  writeFileSync(crankPath, JSON.stringify([...crank.secretKey]), { mode: 0o600 });
  const mintKp = Keypair.generate();
  const mint = mintKp.publicKey;
  const pump = new OnlinePumpSdk(conn);

  let sent = await sendAndConfirm(conn, creator, [
    await PUMP_SDK.createV2Instruction({
      mint, name: "take the crown (test)", symbol: "CROWN", uri: "https://takethecrown.fun/brand/coin.json",
      creator: creator.publicKey, user: creator.publicKey, mayhemMode: false,
    }),
  ], { signers: [mintKp] });
  console.log("coin created:", mint.toBase58(), sent.signature);

  // Smaller prices than the real defaults, so testers need little test SOL.
  const params = { ...DEFAULT_PARAMS, openingPrice: DEFAULT_PARAMS.minPrice };
  sent = await sendAndConfirm(conn, creator, [initializeIx({ authority: creator.publicKey, mint, devWallet: creator.publicKey, params })]);
  console.log("crown initialized:", sent.signature);

  const pdas = crownPdas(mint);
  sent = await sendAndConfirm(conn, creator, [
    await PUMP_SDK.createFeeSharingConfig({ creator: creator.publicKey, mint, pool: null }),
    await PUMP_SDK.updateFeeSharesV2({
      authority: creator.publicKey, mint, currentShareholders: [creator.publicKey],
      newShareholders: [{ address: pdas.vault, shareBps: 8_500 }, { address: creator.publicKey, shareBps: 1_500 }],
      quoteMint: NATIVE_MINT, quoteTokenProgram: TOKEN_PROGRAM_ID,
    }),
    SystemProgram.transfer({ fromPubkey: creator.publicKey, toPubkey: crank.publicKey, lamports: 0.15 * LAMPORTS_PER_SOL }),
  ]);
  console.log("fee shares 8500/1500 set, crank funded:", sent.signature);

  // A little trading so there are fees to see.
  const global = await pump.fetchGlobal();
  const feeConfig = await pump.fetchFeeConfig();
  const tokenProgram = (await conn.getAccountInfo(mint))!.owner;
  for (const sol of [0.06, 0.04]) {
    const { bondingCurveAccountInfo, bondingCurve, associatedUserAccountInfo } = await pump.fetchBuyState(mint, creator.publicKey, tokenProgram);
    const solAmount = new BN(Math.round(sol * LAMPORTS_PER_SOL));
    const amount = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: bondingCurve.tokenTotalSupply, bondingCurve, amount: solAmount, quoteMint: NATIVE_MINT });
    sent = await sendAndConfirm(conn, creator, await PUMP_SDK.buyInstructions({
      global, bondingCurveAccountInfo, bondingCurve, associatedUserAccountInfo, mint, user: creator.publicKey, amount, solAmount, slippage: 5, tokenProgram,
    }));
    console.log(`test buy ${sol} SOL:`, sent.signature);
  }

  mkdirSync(".fork", { recursive: true });
  writeFileSync(".fork/devnet-launch.json", JSON.stringify({ mint: mint.toBase58(), crank: crank.publicKey.toBase58(), creator: creator.publicKey.toBase58() }, null, 2));
  console.log("\nMINT", mint.toBase58(), "\nconfig NOT locked (test coin)");
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
