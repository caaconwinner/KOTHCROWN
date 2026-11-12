// Checks which pump.fun instructions exist on a cluster by simulating each
// discriminator with no accounts. Anchor answers 101 (InstructionFallbackNotFound)
// for an unknown instruction and something else (missing accounts) for a known one.
//   pnpm tsx scripts/devnet-probe.ts [rpc-url]
import { Connection, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";

const url = process.argv[2] ?? "https://api.devnet.solana.com";
const PUMP = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const AMM = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const FEES = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
// Any funded account works as fee payer: signatures are not verified.
const PAYER = new PublicKey("62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV");

const probes: [string, PublicKey, number[]][] = [
  ["pump.sweep_creator_fee", PUMP, [32, 246, 191, 52, 8, 201, 73, 186]],
  ["pump.distribute_creator_fees_v2", PUMP, [255, 203, 19, 79, 244, 68, 8, 159]],
  ["pump.distribute_creator_fees", PUMP, [165, 114, 103, 0, 121, 206, 247, 81]],
  ["pump.get_minimum_distributable_fee", PUMP, [117, 225, 127, 202, 134, 95, 68, 35]],
  ["pump.collect_creator_fee_v2", PUMP, [207, 17, 138, 242, 4, 34, 19, 56]],
  ["pump.buy_exact_quote_in_v3", PUMP, [225, 247, 80, 30, 213, 179, 132, 136]],
  ["amm.sweep_creator_fee", AMM, [32, 246, 191, 52, 8, 201, 73, 186]],
  ["amm.transfer_creator_fees_to_pump_v2", AMM, [1, 33, 78, 185, 33, 67, 44, 92]],
  ["amm.buy_exact_quote_in_v2", AMM, [194, 171, 28, 70, 104, 77, 91, 47]],
  ["amm.buy_exact_quote_in", AMM, [198, 46, 21, 82, 180, 217, 232, 112]],
  ["fees.create_fee_sharing_config", FEES, [195, 78, 86, 76, 111, 52, 251, 213]],
  ["fees.update_fee_shares_v2", FEES, [111, 251, 49, 6, 78, 78, 106, 18]],
  ["control: unknown instruction", PUMP, [1, 2, 3, 4, 5, 6, 7, 8]],
];

async function main() {
  const conn = new Connection(url, "confirmed");
  const { blockhash } = await conn.getLatestBlockhash();
  for (const [name, programId, disc] of probes) {
    const ix = new TransactionInstruction({ programId, keys: [], data: Buffer.from(disc) });
    const msg = new TransactionMessage({ payerKey: PAYER, recentBlockhash: blockhash, instructions: [ix] }).compileToV0Message();
    const sim = await conn.simulateTransaction(new VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: true });
    const logs = (sim.value.logs ?? []).join(" | ");
    const code = logs.match(/Error Number: (\d+)/)?.[1] ?? JSON.stringify(sim.value.err);
    const verdict = code === "101" ? "MISSING" : "present";
    console.log(`${verdict.padEnd(8)} ${name.padEnd(40)} (error ${code})`);
  }
}
main();
