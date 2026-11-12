// Glue between Crown and pump.fun's SDKs: the instructions that go in front of
// `sync_fees` / `take_crown`, and the accounts `buyback_burn` needs.
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { canonicalPumpPoolPda, OnlinePumpSdk } from "@pump-fun/pump-sdk";
import {
  GLOBAL_CONFIG_PDA,
  OnlinePumpAmmSdk,
  PUMP_AMM_EVENT_AUTHORITY_PDA,
  PUMP_AMM_FEE_CONFIG_PDA,
  PUMP_AMM_PROGRAM_ID,
  userVolumeAccumulatorPda,
} from "@pump-fun/pump-swap-sdk";
import { crownPdas, type BuybackAccounts } from "./instructions";

/** The 8 buyback fee recipient wallets (pump-public-docs, FEE_RECIPIENTS.md). */
export const BUYBACK_FEE_RECIPIENTS = [
  "5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD",
  "9M4giFFMxmFGXtc3feFzRai56WbBqehoSeRE5GK7gf7",
  "GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL",
  "3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR",
  "5cjcW9wExnJJiqgLjq7DEG75Pm6JBgE1hNv4B2vHXUW6",
  "EHAAiTxcdDwQ3U4bU6YcMsQGaekdzLS3B5SmYo46kJtL",
  "5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD",
  "A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW",
].map((k) => new PublicKey(k));

export interface PumpSync {
  /** pump.fun instructions to put before `sync_fees` / `take_crown`. Empty
   * when there is nothing pump.fun would distribute right now. */
  instructions: TransactionInstruction[];
  /** Whether `instructions` push fees to the vault. */
  distributes: boolean;
  isGraduated: boolean;
}

/**
 * Builds pump.fun's sweep + (transfer) + distribute instructions for `mint`
 * and checks by simulation that they would succeed. They fail when the creator
 * vault is below pump.fun's minimum distributable amount; in that case this
 * returns no instructions and the caller sends its Crown instruction alone.
 */
export async function pumpSyncInstructions(conn: Connection, mint: PublicKey, payer: PublicKey): Promise<PumpSync> {
  const sdk = new OnlinePumpSdk(conn);
  const built = await sdk.buildDistributeCreatorFeesInstructions(mint, { payer });
  const { blockhash } = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), ...built.instructions],
  }).compileToV0Message();
  const sim = await conn.simulateTransaction(new VersionedTransaction(msg), { sigVerify: false });
  const ok = !sim.value.err;
  return { instructions: ok ? built.instructions : [], distributes: ok, isGraduated: built.isGraduated };
}

/** Fills in the `buyback_burn` accounts for a graduated coin. */
export async function buybackAccounts(
  conn: Connection,
  mint: PublicKey,
  buybackRecipientIndex = 0,
): Promise<BuybackAccounts> {
  const pool = canonicalPumpPoolPda(mint);
  const [poolState, mintInfo] = await Promise.all([
    new OnlinePumpAmmSdk(conn).fetchPool(pool),
    conn.getAccountInfo(mint),
  ]);
  if (!mintInfo) throw new Error(`mint ${mint.toBase58()} not found`);
  const bucket = crownPdas(mint).burnBucket;
  const baseTokenProgram = mintInfo.owner;
  return {
    mint,
    bucketWsol: getAssociatedTokenAddressSync(NATIVE_MINT, bucket, true),
    bucketTokens: getAssociatedTokenAddressSync(mint, bucket, true, baseTokenProgram),
    pool,
    ammGlobalConfig: GLOBAL_CONFIG_PDA,
    wsolMint: NATIVE_MINT,
    poolBaseTokenAccount: poolState.poolBaseTokenAccount,
    poolQuoteTokenAccount: poolState.poolQuoteTokenAccount,
    baseTokenProgram,
    quoteTokenProgram: TOKEN_PROGRAM_ID,
    userVolumeAccumulator: userVolumeAccumulatorPda(bucket),
    feeConfig: PUMP_AMM_FEE_CONFIG_PDA,
    buybackFeeRecipient: getAssociatedTokenAddressSync(
      NATIVE_MINT,
      BUYBACK_FEE_RECIPIENTS[buybackRecipientIndex % BUYBACK_FEE_RECIPIENTS.length],
      true,
    ),
    ammEventAuthority: PUMP_AMM_EVENT_AUTHORITY_PDA,
    pumpAmmProgram: PUMP_AMM_PROGRAM_ID,
  };
}
