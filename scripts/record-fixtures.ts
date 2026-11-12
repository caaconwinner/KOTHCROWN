// Records real Crown transactions from devnet as test fixtures for the indexer.
//   pnpm tsx scripts/record-fixtures.ts
import { writeFileSync } from "node:fs";
import { Connection } from "@solana/web3.js";
import { CROWN_PROGRAM_ID } from "@koth-crown/sdk";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const conn = new Connection(process.env.DEVNET_RPC ?? "https://api.devnet.solana.com", "confirmed");
  const sigs = (await conn.getSignaturesForAddress(CROWN_PROGRAM_ID, { limit: 40 })).filter((s) => !s.err).reverse();
  const out = [];
  for (const s of sigs) {
    await sleep(400);
    const tx = await conn.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const logs = tx?.meta?.logMessages ?? [];
    if (!logs.some((l) => l.startsWith("Program data: "))) continue;
    out.push({ signature: s.signature, slot: s.slot, logs });
  }
  writeFileSync("services/crown/test/fixtures/devnet-transactions.json", JSON.stringify(out, null, 1) + "\n");
  console.log(`recorded ${out.length} transactions`);
}
main();
