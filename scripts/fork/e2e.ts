// End-to-end run of the Crown program against the REAL pump.fun programs on a
// local validator (scripts/fork/validator.sh). Local SOL only.
//
//   pnpm fork:validator      (terminal 1)
//   pnpm fork:e2e            (terminal 2)
//
// If a transaction needs a mainnet account the validator has not cloned yet,
// the script adds it to scripts/fork/accounts.txt and exits with code 42:
// restart the validator and run again. scripts/fork/run.sh loops that for you.
import { appendFileSync, readFileSync } from "node:fs";
import assert from "node:assert/strict";
import BN from "bn.js";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  bondingCurvePda,
  canonicalPumpPoolPda,
  creatorVaultPda,
  feeSharingConfigPda,
  getBuyTokenAmountFromSolAmount,
  GLOBAL_PDA,
  GLOBAL_VOLUME_ACCUMULATOR_PDA,
  AMM_GLOBAL_VOLUME_ACCUMULATOR_PDA,
  PUMP_FEE_CONFIG_PDA,
  OnlinePumpSdk,
  PUMP_SDK,
} from "@pump-fun/pump-sdk";
import { GLOBAL_CONFIG_PDA, OnlinePumpAmmSdk, PUMP_AMM_FEE_CONFIG_PDA, PUMP_AMM_SDK } from "@pump-fun/pump-swap-sdk";
import {
  BUYBACK_FEE_RECIPIENTS,
  buybackAccounts,
  buybackBurnIx,
  crownPdas,
  decodeConfig,
  decodeCrown,
  decodeEvents,
  DEFAULT_PARAMS,
  initializeIx,
  lockConfigIx,
  pumpSyncInstructions,
  syncFeesIx,
  takeCrownIx,
} from "@koth-crown/sdk";

const LOCAL = "http://127.0.0.1:8899";
const MAINNET = process.env.MAINNET_RPC ?? "https://api.mainnet-beta.solana.com";
const ACCOUNTS_FILE = "scripts/fork/accounts.txt";
const SOL = BigInt(LAMPORTS_PER_SOL);

const conn = new Connection(LOCAL, "confirmed");
const mainnet = new Connection(MAINNET, "confirmed");
const pump = new OnlinePumpSdk(conn);
const amm = new OnlinePumpAmmSdk(conn);

const known = new Set(readFileSync(ACCOUNTS_FILE, "utf8").split("\n").map((l) => l.split(" ")[1]).filter(Boolean));
const checked = new Set<string>();

/** Makes sure every account a transaction touches exists locally if it exists on mainnet. */
function ensureCloned(ixs: TransactionInstruction[]) {
  return ensureKeys(ixs.flatMap((ix) => [ix.programId, ...ix.keys.map((k) => k.pubkey)]));
}

async function ensureKeys(list: PublicKey[]) {
  const keys = [...new Set(list.map((k) => k.toBase58()))].filter((k) => !checked.has(k));
  if (!keys.length) return;
  const pks = keys.map((k) => new PublicKey(k));
  const local = await conn.getMultipleAccountsInfo(pks);
  const missing = pks.filter((_, i) => !local[i]);
  keys.forEach((k) => checked.add(k));
  if (!missing.length) return;
  const remote = await mainnet.getMultipleAccountsInfo(missing);
  let added = 0;
  missing.forEach((pk, i) => {
    const acc = remote[i];
    if (!acc || known.has(pk.toBase58())) return;
    appendFileSync(ACCOUNTS_FILE, `${acc.executable ? "prog" : "acct"} ${pk.toBase58()}\n`);
    known.add(pk.toBase58());
    added++;
  });
  if (added) {
    console.log(`\n${added} mainnet account(s) added to ${ACCOUNTS_FILE}. Restart the validator and run again.`);
    process.exit(42);
  }
}

interface Sent {
  logs: string[];
  units: number;
  bytes: number;
}

async function send(
  label: string,
  payer: Keypair,
  ixs: TransactionInstruction[],
  signers: Keypair[] = [],
  opts: { expectFail?: boolean; alts?: AddressLookupTableAccount[] } = {},
): Promise<Sent> {
  await ensureCloned(ixs);
  const all = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), ...ixs];
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: all })
    .compileToV0Message(opts.alts);
  const tx = new VersionedTransaction(msg);
  tx.sign([payer, ...signers.filter((s) => !s.publicKey.equals(payer.publicKey))]);
  const bytes = tx.serialize().length;
  const sim = await conn.simulateTransaction(tx, { sigVerify: false });
  const logs = sim.value.logs ?? [];
  if (sim.value.err) {
    if (opts.expectFail) {
      console.log(`  ok   ${label}: rejected as expected (${logs.join(" ").match(/Error Code: (\w+)/)?.[1] ?? JSON.stringify(sim.value.err)})`);
      return { logs, units: 0, bytes };
    }
    console.error(`\nFAILED ${label}\n${logs.join("\n")}\n${JSON.stringify(sim.value.err)}`);
    process.exit(1);
  }
  assert.ok(!opts.expectFail, `${label}: expected to fail but simulation passed`);
  const sig = await conn.sendTransaction(tx);
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  // Read logs from the landed transaction: the price moves between the
  // simulation and the real execution.
  const landed = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  assert.ok(landed && !landed.meta?.err, `${label}: transaction did not land cleanly`);
  const units = landed.meta?.computeUnitsConsumed ?? 0;
  console.log(`  ok   ${label} (${bytes} bytes, ${units} CU)`);
  return { logs: landed.meta?.logMessages ?? [], units, bytes };
}

async function funded(sol: number): Promise<Keypair> {
  const kp = Keypair.generate();
  const sig = await conn.requestAirdrop(kp.publicKey, sol * LAMPORTS_PER_SOL);
  await conn.confirmTransaction(sig, "confirmed");
  return kp;
}

const bal = async (k: PublicKey) => BigInt(await conn.getBalance(k, "confirmed"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmt = (l: bigint) => `${(Number(l) / 1e9).toFixed(6)} SOL`;
const step = (s: string) => console.log(`\n== ${s}`);

async function main() {
  // Accounts the SDKs read directly rather than through a transaction.
  await ensureKeys([
    GLOBAL_PDA, PUMP_FEE_CONFIG_PDA, GLOBAL_VOLUME_ACCUMULATOR_PDA, AMM_GLOBAL_VOLUME_ACCUMULATOR_PDA,
    GLOBAL_CONFIG_PDA, PUMP_AMM_FEE_CONFIG_PDA, NATIVE_MINT,
    ...BUYBACK_FEE_RECIPIENTS.map((w) => getAssociatedTokenAddressSync(NATIVE_MINT, w, true)),
  ]);
  const creator = await funded(100);
  const trader = await funded(2_000);
  const cranker = await funded(10);
  const alice = await funded(100);
  const bob = await funded(100);
  const dev = await funded(1);
  const mintKp = Keypair.generate();
  const mint = mintKp.publicKey;
  const pdas = crownPdas(mint);
  const params = { ...DEFAULT_PARAMS, buybackCooldownS: 5 };

  const crownState = async () => decodeCrown((await conn.getAccountInfo(pdas.crown, "confirmed"))!.data);

  // ------------------------------------------------------------ launch
  step("1. launch a regular SOL-paired coin on the bonding curve");
  await send("create_v2", creator, [
    await PUMP_SDK.createV2Instruction({
      mint, name: "Crown Test", symbol: "CRWN", uri: "https://example.invalid/crwn.json",
      creator: creator.publicKey, user: creator.publicKey, mayhemMode: false,
    }),
  ], [mintKp]);
  const tokenProgram = (await conn.getAccountInfo(mint))!.owner;
  console.log(`  mint ${mint.toBase58()} owned by ${tokenProgram.equals(TOKEN_2022_PROGRAM_ID) ? "Token-2022" : "SPL Token"}`);

  step("2. initialize the crown, then point 95% / 5% of creator fees at vault / dev");
  await send("crown initialize", creator, [
    initializeIx({ authority: creator.publicKey, mint, devWallet: dev.publicKey, params }),
  ]);
  const cfg = decodeConfig((await conn.getAccountInfo(pdas.config))!.data);
  assert.ok(cfg.pool.equals(canonicalPumpPoolPda(mint)), "program-derived pool == SDK canonical pool");

  const shares = [
    { address: pdas.vault, shareBps: 9_500 },
    { address: dev.publicKey, shareBps: 500 },
  ];
  await send("create_fee_sharing_config + update_fee_shares_v2", creator, [
    await PUMP_SDK.createFeeSharingConfig({ creator: creator.publicKey, mint, pool: null }),
    await PUMP_SDK.updateFeeSharesV2({
      authority: creator.publicKey, mint, currentShareholders: [creator.publicKey], newShareholders: shares,
      quoteMint: NATIVE_MINT, quoteTokenProgram: TOKEN_PROGRAM_ID,
    }),
  ]);
  const sharing = PUMP_SDK.decodeSharingConfig((await conn.getAccountInfo(feeSharingConfigPda(mint)))!);
  assert.equal(sharing.adminRevoked, true);
  assert.deepEqual(sharing.shareholders.map((s) => [s.address.toBase58(), s.shareBps]), shares.map((s) => [s.address.toBase58(), s.shareBps]));
  console.log("  vault PDA accepted as shareholder; admin_revoked = true");

  await send("update_fee_shares_v2 a second time", creator, [
    await PUMP_SDK.updateFeeSharesV2({
      authority: creator.publicKey, mint, currentShareholders: shares.map((s) => s.address),
      newShareholders: [{ address: creator.publicKey, shareBps: 10_000 }],
      quoteMint: NATIVE_MINT, quoteTokenProgram: TOKEN_PROGRAM_ID,
    }),
  ], [], { expectFail: true });

  await send("crown lock_config", creator, [lockConfigIx({ authority: creator.publicKey, mint })]);

  // ------------------------------------------------------------ curve trading
  const global = await pump.fetchGlobal();
  const feeConfig = await pump.fetchFeeConfig();
  const curveBuy = async (sol: number) => {
    const { bondingCurveAccountInfo, bondingCurve, associatedUserAccountInfo } = await pump.fetchBuyState(mint, trader.publicKey, tokenProgram);
    const solAmount = new BN(sol * LAMPORTS_PER_SOL);
    const amount = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: bondingCurve.tokenTotalSupply, bondingCurve, amount: solAmount, quoteMint: NATIVE_MINT });
    return send(`curve buy ${sol} SOL`, trader, await PUMP_SDK.buyInstructions({
      global, bondingCurveAccountInfo, bondingCurve, associatedUserAccountInfo, mint, user: trader.publicKey,
      amount, solAmount, slippage: 5, tokenProgram,
    }));
  };

  /** One crank transaction: pump.fun sweep/distribute, then Crown sync_fees. */
  const sync = async (label: string) => {
    const king = (await crownState()).king;
    const pumpIxs = await pumpSyncInstructions(conn, mint, cranker.publicKey);
    const before = await Promise.all([bal(pdas.vault), bal(dev.publicKey), bal(pdas.burnBucket), king ? bal(king) : 0n]);
    const sent = await send(label, cranker, [...pumpIxs.instructions, syncFeesIx({ mint, king, devWallet: dev.publicKey })]);
    const after = await Promise.all([bal(pdas.vault), bal(dev.publicKey), bal(pdas.burnBucket), king ? bal(king) : 0n]);
    const ev = decodeEvents(sent.logs).find((e) => e.name === "FeesSynced")!.data;
    return {
      distributed: pumpIxs.distributes, delta: BigInt(ev.delta), toKing: after[3] - before[3], toDev: after[1] - before[1],
      toBurn: after[2] - before[2], vaultChange: after[0] - before[0], sent,
    };
  };

  step("3. trade on the curve, then crank with no king (fees go to the burn bucket)");
  await curveBuy(2);
  const min = await pump.getMinimumDistributableFee(mint, cranker.publicKey);
  console.log(`  minimum distributable: ${fmt(BigInt(min.minimumRequired.toString()))}, in vault: ${fmt(BigInt(min.distributableFees.toString()))}, can distribute: ${min.canDistribute}`);
  let r = await sync("sweep + distribute + sync_fees");
  console.log(`  creator fees: ${fmt(r.delta + r.toDev)} -> burn bucket ${fmt(r.toBurn)}, dev ${fmt(r.toDev)}`);
  assert.equal(r.toBurn, r.delta);
  assert.ok(r.delta > 0n && r.toDev > 0n);
  // pump.fun rounds each share down, so allow one lamport either way.
  const total = r.delta + r.toDev;
  assert.ok(r.toDev - (total * 500n) / 10_000n <= 1n && r.toDev >= (total * 500n) / 10_000n - 1n, "5% to dev");
  assert.equal(r.vaultChange, 0n);

  step("4. first claim with the pump.fun instructions in front");
  {
    const pumpIxs = await pumpSyncInstructions(conn, mint, alice.publicKey);
    const sent = await send("take_crown (alice)", alice, [
      ...pumpIxs.instructions,
      takeCrownIx({ mint, buyer: alice.publicKey, king: null, devWallet: dev.publicKey, maxPrice: SOL }),
    ]);
    const ev = decodeEvents(sent.logs).find((e) => e.name === "CrownTaken")!.data;
    console.log(`  alice paid ${fmt(BigInt(ev.price_paid))}, new price ${fmt(BigInt(ev.new_price))}`);
  }

  step("5. trade, crank: king gets 95%, dev gets 5%");
  await curveBuy(3);
  await curveBuy(1);
  await sleep(2_000);
  r = await sync("sweep + distribute + sync_fees");
  console.log(`  creator fees: ${fmt(r.toKing + r.toDev)} -> king ${fmt(r.toKing)}, dev ${fmt(r.toDev)}`);
  assert.equal(r.toKing, r.delta);
  {
    const t = r.toKing + r.toDev;
    assert.ok(r.toDev >= (t * 500n) / 10_000n - 1n && r.toDev <= (t * 500n) / 10_000n + 1n, "5% to dev");
  }
  let c = await crownState();
  assert.equal(c.kingFeesThisReign, r.toKing);
  console.log(`  fee speed ${fmt(c.fastEma)}/min, melt ${c.meltBps} bps/min`);

  step("6. crank with nothing to distribute");
  r = await sync("sweep + distribute + sync_fees, nothing pending");
  assert.equal(r.delta, 0n);
  console.log(`  pump.fun instructions ${r.distributed ? "succeed as a no-op" : "fail"} when nothing is pending`);

  step("6b. a fee below pump.fun's minimum distributable amount");
  await curveBuy(0.1);
  const small = await pump.getMinimumDistributableFee(mint, cranker.publicKey);
  console.log(`  in creator vault after sweep: ${fmt(BigInt(small.distributableFees.toString()))}, minimum ${fmt(BigInt(small.minimumRequired.toString()))}, can distribute: ${small.canDistribute}`);
  r = await sync("crank below the minimum");
  console.log(`  pump.fun instructions ${r.distributed ? "succeeded" : "would fail, sync_fees sent alone"}; reached the king: ${fmt(r.toKing)}`);

  step("7. takeover: bob takes it from alice, alice is paid fees + 90%");
  await curveBuy(1);
  {
    const pumpIxs = await pumpSyncInstructions(conn, mint, bob.publicKey);
    const a0 = await bal(alice.publicKey);
    const sent = await send("take_crown (bob)", bob, [
      ...pumpIxs.instructions,
      takeCrownIx({ mint, buyer: bob.publicKey, king: alice.publicKey, devWallet: dev.publicKey, maxPrice: 100n * SOL }),
    ]);
    const ev = decodeEvents(sent.logs).find((e) => e.name === "CrownTaken")!.data;
    const fees = decodeEvents(sent.logs).find((e) => e.name === "FeesSynced")!.data;
    assert.equal((await bal(alice.publicKey)) - a0, BigInt(ev.to_old_king) + BigInt(fees.to_king));
    assert.ok(BigInt(fees.to_king) > 0n, "alice got the fees that accrued before the takeover");
    console.log(`  bob paid ${fmt(BigInt(ev.price_paid))}: alice got ${fmt(BigInt(ev.to_old_king))} + ${fmt(BigInt(fees.to_king))} fees, ${fmt(BigInt(ev.to_burn))} burned`);
  }

  // ------------------------------------------------------------ graduation
  step("8. graduate: buy out the curve and migrate to PumpSwap");
  for (let i = 0; i < 40; i++) {
    const bc = await pump.fetchBondingCurve(mint);
    if (bc.complete) break;
    const left = Number(bc.realTokenReserves.toString());
    const { bondingCurveAccountInfo, bondingCurve, associatedUserAccountInfo } = await pump.fetchBuyState(mint, trader.publicKey, tokenProgram);
    // Buy by token amount so the last buy takes exactly what is left.
    const amount = BN.min(bondingCurve.realTokenReserves, new BN("150000000000000"));
    await send(`curve buy ${(left / 1e12).toFixed(0)}M tokens left`, trader, await PUMP_SDK.buyInstructions({
      global, bondingCurveAccountInfo, bondingCurve, associatedUserAccountInfo, mint, user: trader.publicKey,
      amount, solAmount: new BN(60 * LAMPORTS_PER_SOL), slippage: 1, tokenProgram,
    }));
  }
  assert.ok((await pump.fetchBondingCurve(mint)).complete, "curve complete");
  r = await sync("sweep + distribute + sync_fees (curve complete)");
  console.log(`  king ${fmt(r.toKing)}, dev ${fmt(r.toDev)}`);
  await send("migrate", cranker, [
    await PUMP_SDK.migrateV2Instruction({
      withdrawAuthority: global.withdrawAuthority, mint, user: cranker.publicKey,
      baseTokenProgram: tokenProgram, quoteTokenProgram: TOKEN_PROGRAM_ID,
    }),
  ]);
  const pool = canonicalPumpPoolPda(mint);
  assert.ok(await conn.getAccountInfo(pool), "canonical pool exists");

  step("9. trade on PumpSwap, crank with the full 4-step sequence");
  const ammBuy = async (sol: number) => {
    const state = await amm.swapSolanaState(pool, trader.publicKey);
    return send(`pool buy ${sol} SOL`, trader, await PUMP_AMM_SDK.buyQuoteInput(state, new BN(sol * LAMPORTS_PER_SOL), 5));
  };
  await ammBuy(5);
  await ammBuy(3);
  await sleep(2_000);
  r = await sync("pool sweep + transfer + curve sweep + distribute + sync_fees");
  console.log(`  creator fees: ${fmt(r.toKing + r.toDev)} -> king ${fmt(r.toKing)}, dev ${fmt(r.toDev)}`);
  assert.ok(r.toKing > 0n);
  {
    const t = r.toKing + r.toDev;
    assert.ok(r.toDev >= (t * 500n) / 10_000n - 1n && r.toDev <= (t * 500n) / 10_000n + 1n, "5% to dev");
  }

  // ------------------------------------------------------------ buyback
  step("10. buyback_burn");
  const bucket = pdas.burnBucket;
  const acc = await buybackAccounts(conn, mint);
  const supply = async () => BigInt((await conn.getTokenSupply(mint, "confirmed")).value.amount);
  const prepare = [
    createAssociatedTokenAccountIdempotentInstruction(cranker.publicKey, acc.bucketWsol, bucket, NATIVE_MINT),
    createAssociatedTokenAccountIdempotentInstruction(cranker.publicKey, acc.bucketTokens, bucket, mint, tokenProgram),
  ];
  const bucket0 = await bal(bucket);
  const supply0 = await supply();
  console.log(`  burn bucket holds ${fmt(bucket0)}`);

  await send("buyback above the cap", cranker, [...prepare, buybackBurnIx(acc, params.maxBuybackLamports + 1n, 0n)], [], { expectFail: true });
  await send("buyback through a different pool", cranker, [
    ...prepare, buybackBurnIx({ ...acc, pool: bondingCurvePda(mint) }, SOL / 10n, 0n),
  ], [], { expectFail: true });
  await send("buyback into someone else's token account", cranker, [
    ...prepare,
    createAssociatedTokenAccountIdempotentInstruction(cranker.publicKey, getAssociatedTokenAddressSync(mint, cranker.publicKey, false, tokenProgram), cranker.publicKey, mint, tokenProgram),
    buybackBurnIx({ ...acc, bucketTokens: getAssociatedTokenAddressSync(mint, cranker.publicKey, false, tokenProgram) }, SOL / 10n, 0n),
  ], [], { expectFail: true });
  await send("buyback with an impossible min_tokens_out", cranker, [...prepare, buybackBurnIx(acc, SOL / 10n, (1n << 63n))], [], { expectFail: true });

  const spend = SOL / 4n;
  const sent = await send("buyback_burn 0.25 SOL", cranker, [...prepare, buybackBurnIx(acc, spend, 1n)]);
  const burned = BigInt(decodeEvents(sent.logs).find((e) => e.name === "Burned")!.data.tokens_burned);
  assert.equal(supply0 - (await supply()), burned);
  assert.ok(burned > 0n);
  const spent = bucket0 - (await bal(bucket));
  console.log(`  burned ${(Number(burned) / 1e6).toFixed(0)} tokens; bucket down ${fmt(spent)} (${fmt(spent - spend)} one-off rent for its volume accumulator)`);
  c = await crownState();
  assert.equal(c.totalTokensBurned, burned);

  await send("buyback again inside the cooldown", cranker, [buybackBurnIx(acc, spend, 1n)], [], { expectFail: true });
  await sleep(6_000);
  const again = await send("buyback_burn after the cooldown", cranker, [buybackBurnIx(acc, spend, 1n)]);
  assert.equal(bucket0 - (await bal(bucket)) - spent, spend, "second buyback costs exactly the amount");
  assert.ok(BigInt(decodeEvents(again.logs).find((e) => e.name === "Burned")!.data.tokens_burned) > 0n);

  step("11. takeover after graduation, pump.fun instructions in front");
  await ammBuy(2);
  {
    const pumpIxs = await pumpSyncInstructions(conn, mint, alice.publicKey);
    const b0 = await bal(bob.publicKey);
    const sent = await send("take_crown (alice from bob)", alice, [
      ...pumpIxs.instructions,
      takeCrownIx({ mint, buyer: alice.publicKey, king: bob.publicKey, devWallet: dev.publicKey, maxPrice: 1_000n * SOL }),
    ]);
    const ev = decodeEvents(sent.logs).find((e) => e.name === "CrownTaken")!.data;
    const fees = decodeEvents(sent.logs).find((e) => e.name === "FeesSynced")!.data;
    assert.equal((await bal(bob.publicKey)) - b0, BigInt(ev.to_old_king) + BigInt(fees.to_king));
    console.log(`  alice paid ${fmt(BigInt(ev.price_paid))}; bob got ${fmt(BigInt(ev.to_old_king))} + ${fmt(BigInt(fees.to_king))} fees`);
  }

  console.log("\nALL STEPS PASSED");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
