import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface SendResult {
  signature: string;
  logs: string[];
}

/**
 * Simulates, sends and waits for one transaction. It either lands or its
 * blockhash expires; only then does this return or throw, so a caller that
 * retries can never have two copies in flight.
 */
export async function sendAndConfirm(
  conn: Connection,
  payer: Keypair,
  ixs: TransactionInstruction[],
  opts: { priorityMicroLamports?: number; signers?: Keypair[] } = {},
): Promise<SendResult> {
  const budget = [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })];
  if (opts.priorityMicroLamports) {
    budget.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: opts.priorityMicroLamports }));
  }
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [...budget, ...ixs],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([payer, ...(opts.signers ?? [])]);

  const sim = await conn.simulateTransaction(tx, { sigVerify: false });
  if (sim.value.err) {
    throw new Error(`simulation failed: ${JSON.stringify(sim.value.err)}\n${(sim.value.logs ?? []).join("\n")}`);
  }

  const raw = tx.serialize();
  const signature = await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 });
  for (;;) {
    const status = (await conn.getSignatureStatuses([signature])).value[0];
    if (status?.err) throw new Error(`transaction ${signature} failed: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") break;
    if ((await conn.getBlockHeight("confirmed")) > lastValidBlockHeight) {
      throw new Error(`transaction ${signature} expired before landing`);
    }
    // Same bytes, same signature: re-sending cannot double-spend.
    await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
    await sleep(1_000);
  }
  const landed = await conn.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  return { signature, logs: landed?.meta?.logMessages ?? [] };
}
