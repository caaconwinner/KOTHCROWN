// Takes the crown on devnet through a site's own API, the way the website
// does: ask for the transaction, sign it, send it.
//   pnpm tsx scripts/devnet-take.ts [site-url]
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";

async function main() {
  const site = (process.argv[2] ?? "http://127.0.0.1:3122").replace(/\/$/, "");
  const buyer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/devnet.json`, "utf8"))));
  const conn = new Connection(process.env.DEVNET_RPC ?? "https://api.devnet.solana.com", "confirmed");
  const crown = await (await fetch(`${site}/api/crown`)).json() as { price: string };
  const maxPrice = (BigInt(crown.price) * 101n) / 100n;
  const built = await (await fetch(`${site}/api/tx/take?buyer=${buyer.publicKey.toBase58()}&maxPrice=${maxPrice}`)).json() as { transaction: string; error?: string };
  if (!built.transaction) throw new Error(built.error ?? "no transaction returned");
  const tx = VersionedTransaction.deserialize(Buffer.from(built.transaction, "base64"));
  tx.sign([buyer]);
  const signature = await conn.sendTransaction(tx);
  for (let i = 0; i < 60; i++) {
    const st = (await conn.getSignatureStatuses([signature])).value[0];
    if (st?.err) throw new Error(JSON.stringify(st.err));
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") break;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  console.log("took the crown:", signature, `(max ${maxPrice} lamports)`);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
