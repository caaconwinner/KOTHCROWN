// Everything the game does on Solana: read payments into the game wallet,
// collect pump.fun creator fees, send payouts, buy back and burn.
import BN from "bn.js";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  type ParsedTransactionWithMeta,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { createBurnInstruction, getAssociatedTokenAddressSync, NATIVE_MINT } from "@solana/spl-token";
import { getBuyTokenAmountFromSolAmount, OnlinePumpSdk, PUMP_SDK, canonicalPumpPoolPda } from "@pump-fun/pump-sdk";
import { OnlinePumpAmmSdk, PUMP_AMM_SDK } from "@pump-fun/pump-swap-sdk";
import { pumpSyncInstructions } from "@koth-crown/sdk";
import { sendAndConfirm } from "../tx";

export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
export const MEMO_PREFIX = "crown:";

/**
 * Priority fee on every game transaction, micro-lamports per compute unit.
 * Without one, transactions often expire unlanded on a busy mainnet. At the
 * default 200,000 a 1,000-unit payment costs about 0.0000002 SOL extra.
 */
export const PRIORITY = Number(process.env.PRIORITY_MICROLAMPORTS ?? 200_000);
const budget = (units: number) => [
  ComputeBudgetProgram.setComputeUnitLimit({ units }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY }),
];

export function memoIx(text: string, signer: PublicKey) {
  return new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [{ pubkey: signer, isSigner: true, isWritable: false }], data: Buffer.from(text, "utf8") });
}

/** The transaction a buyer signs: a memo naming their quote, and the SOL to the game wallet. */
export async function buildPaymentTx(conn: Connection, buyer: PublicKey, game: PublicKey, lamports: bigint, quoteId: string) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: buyer,
    recentBlockhash: blockhash,
    instructions: [
      ...budget(40_000),
      memoIx(MEMO_PREFIX + quoteId, buyer),
      SystemProgram.transfer({ fromPubkey: buyer, toPubkey: game, lamports }),
    ],
  }).compileToV0Message();
  return { transaction: Buffer.from(new VersionedTransaction(msg).serialize()).toString("base64"), blockhash, lastValidBlockHeight };
}

export interface Payment {
  signature: string;
  slot: number;
  blockTime: number;
  /** null if the transaction carries no crown memo. */
  quoteId: string | null;
  /** Wallet that signed and paid (fee payer). */
  payer: string;
  /** Lamports moved from the payer to the game wallet by plain transfers. */
  lamports: bigint;
}

/** Reads a confirmed transaction that touched the game wallet. */
export function parsePayment(tx: ParsedTransactionWithMeta, signature: string, game: PublicKey): Payment | null {
  if (!tx.meta || tx.meta.err) return null;
  const payer = tx.transaction.message.accountKeys[0].pubkey.toBase58();
  let quoteId: string | null = null;
  let lamports = 0n;
  for (const ix of tx.transaction.message.instructions) {
    if (!("parsed" in ix)) continue;
    if (ix.program === "spl-memo" && typeof ix.parsed === "string" && ix.parsed.startsWith(MEMO_PREFIX)) quoteId = ix.parsed.slice(MEMO_PREFIX.length);
    if (ix.program === "system" && ix.parsed?.type === "transfer"
      && ix.parsed.info.destination === game.toBase58() && ix.parsed.info.source === payer) {
      lamports += BigInt(ix.parsed.info.lamports);
    }
  }
  return { signature, slot: tx.slot, blockTime: tx.blockTime ?? 0, quoteId, payer, lamports };
}

/**
 * New transactions that touched the game wallet since `after` (a signature),
 * oldest first: the order they happened on chain.
 */
export async function newSignatures(conn: Connection, game: PublicKey, after: string | null): Promise<{ signature: string; err: unknown }[]> {
  const out: { signature: string; err: unknown }[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await conn.getSignaturesForAddress(game, { before, until: after ?? undefined, limit: 1000 }, "confirmed");
    out.push(...page.map((s) => ({ signature: s.signature, err: s.err })));
    if (page.length < 1000) break;
    before = page[page.length - 1].signature;
  }
  return out.reverse();
}

/**
 * Runs pump.fun's sweep + distribute, which pays the game wallet its 85% share
 * of the creator fees. Returns the lamports the game wallet received.
 */
export async function collectFees(conn: Connection, mint: PublicKey, game: Keypair): Promise<{ income: bigint; signature: string | null }> {
  const pump = await pumpSyncInstructions(conn, mint, game.publicKey);
  if (pump.instructions.length === 0) return { income: 0n, signature: null };
  const sent = await sendAndConfirm(conn, game, pump.instructions, { priorityMicroLamports: PRIORITY });
  const tx = await conn.getTransaction(sent.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (!tx?.meta) throw new Error("fee collection landed but could not be read back");
  const keys = tx.transaction.message.getAccountKeys().staticAccountKeys;
  const i = keys.findIndex((k) => k.equals(game.publicKey));
  // The game wallet also paid the network fee: add it back to get the fee income.
  const income = BigInt(tx.meta.postBalances[i]) - BigInt(tx.meta.preBalances[i]) + BigInt(tx.meta.fee);
  return { income: income > 0n ? income : 0n, signature: sent.signature };
}

/** A signed SOL transfer, not yet sent: the signature is known before it goes out. */
export async function signedTransfer(conn: Connection, from: Keypair, to: PublicKey, lamports: bigint, memo: string) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: from.publicKey,
    recentBlockhash: blockhash,
    instructions: [...budget(40_000), memoIx(memo, from.publicKey), SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports })],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([from]);
  return { tx, signature: bs58(tx.signatures[0]), lastValidBlockHeight };
}

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bs58(bytes: Uint8Array): string {
  let n = BigInt("0x" + Buffer.from(bytes).toString("hex"));
  let s = "";
  while (n > 0n) { s = ALPHABET[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = "1" + s; }
  return s;
}

/**
 * Buys the coin with `lamports` from the game wallet (bonding curve before
 * graduation, PumpSwap after) and burns exactly what was bought.
 */
export async function buyAndBurn(conn: Connection, mint: PublicKey, game: Keypair, lamports: bigint, slippagePct = 2): Promise<{ tokensBurned: bigint; signature: string }> {
  const mintInfo = await conn.getAccountInfo(mint, "confirmed");
  if (!mintInfo) throw new Error("mint not found");
  const tokenProgram = mintInfo.owner;
  const ata = getAssociatedTokenAddressSync(mint, game.publicKey, false, tokenProgram);
  const balance = async () => {
    const a = await conn.getTokenAccountBalance(ata, "confirmed").catch(() => null);
    return a ? BigInt(a.value.amount) : 0n;
  };
  const before = await balance();

  const pump = new OnlinePumpSdk(conn);
  const pool = canonicalPumpPoolPda(mint);
  const graduated = (await conn.getAccountInfo(pool, "confirmed")) !== null;
  let ixs: TransactionInstruction[];
  if (!graduated) {
    const global = await pump.fetchGlobal();
    const feeConfig = await pump.fetchFeeConfig();
    const { bondingCurveAccountInfo, bondingCurve, associatedUserAccountInfo } = await pump.fetchBuyState(mint, game.publicKey, tokenProgram);
    if (bondingCurve.complete) throw new Error("bonding curve complete, waiting for the pool");
    const solAmount = new BN(lamports.toString());
    const amount = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: bondingCurve.tokenTotalSupply, bondingCurve, amount: solAmount, quoteMint: NATIVE_MINT });
    ixs = await PUMP_SDK.buyInstructions({
      global, bondingCurveAccountInfo, bondingCurve, associatedUserAccountInfo, mint, user: game.publicKey, amount, solAmount, slippage: slippagePct, tokenProgram,
    });
  } else {
    const state = await new OnlinePumpAmmSdk(conn).swapSolanaState(pool, game.publicKey);
    ixs = await PUMP_AMM_SDK.buyQuoteInput(state, new BN(lamports.toString()), slippagePct);
  }
  await sendAndConfirm(conn, game, ixs, { priorityMicroLamports: PRIORITY });
  const bought = (await balance()) - before;
  if (bought <= 0n) throw new Error("buy landed but no tokens arrived");
  const burned = await sendAndConfirm(conn, game, [createBurnInstruction(ata, mint, game.publicKey, bought, [], tokenProgram)], { priorityMicroLamports: PRIORITY });
  return { tokensBurned: bought, signature: burned.signature };
}
