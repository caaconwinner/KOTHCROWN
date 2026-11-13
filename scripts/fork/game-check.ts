// The server-run game against the REAL pump.fun programs on the local fork
// validator (scripts/fork/validator.sh). Local SOL only.
//   scripts/fork/game-run.sh
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { getMint, NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
import { getBuyTokenAmountFromSolAmount, OnlinePumpSdk, PUMP_SDK } from "@pump-fun/pump-sdk";
import { DEFAULT_PARAMS } from "@koth-crown/sdk";
import { Db } from "../../services/crown/src/db";
import { CrownGame } from "../../services/crown/src/game/game";
import { GameStore } from "../../services/crown/src/game/store";
import { sendAndConfirm, sleep } from "../../services/crown/src/tx";

const conn = new Connection("http://127.0.0.1:8899", "confirmed");
const SOL = BigInt(LAMPORTS_PER_SOL);
const ok = (m: string) => console.log(`  ok   ${m}`);

async function fund(...kps: Keypair[]) {
  for (const kp of kps) await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, 100 * LAMPORTS_PER_SOL), "confirmed");
}

async function curveBuy(user: Keypair, mint: PublicKey, sol: number) {
  const pump = new OnlinePumpSdk(conn);
  const global = await pump.fetchGlobal();
  const feeConfig = await pump.fetchFeeConfig();
  const tokenProgram = (await conn.getAccountInfo(mint))!.owner;
  const { bondingCurveAccountInfo, bondingCurve, associatedUserAccountInfo } = await pump.fetchBuyState(mint, user.publicKey, tokenProgram);
  const solAmount = new BN(Math.round(sol * LAMPORTS_PER_SOL));
  const amount = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: bondingCurve.tokenTotalSupply, bondingCurve, amount: solAmount, quoteMint: NATIVE_MINT });
  await sendAndConfirm(conn, user, await PUMP_SDK.buyInstructions({
    global, bondingCurveAccountInfo, bondingCurve, associatedUserAccountInfo, mint, user: user.publicKey, amount, solAmount, slippage: 5, tokenProgram,
  }));
}

/** The buyer's side of [take the crown]: get the transaction, sign it, send it. */
async function pay(game: CrownGame, buyer: Keypair, maxPrice = 1_000n * SOL) {
  const built = await game.quote(buyer.publicKey, maxPrice);
  const tx = VersionedTransaction.deserialize(Buffer.from(built.transaction, "base64"));
  tx.sign([buyer]);
  const sig = await conn.sendTransaction(tx);
  await conn.confirmTransaction({ signature: sig, blockhash: built.blockhash, lastValidBlockHeight: built.lastValidBlockHeight }, "confirmed");
  return { built, sig };
}

async function settlePayouts(game: CrownGame) {
  for (let i = 0; i < 30; i++) {
    await game.payouts();
    if (game.liabilities() === BigInt(game.view().burnBucketLamports)) return; // only the burn bucket left
    await sleep(1_000);
  }
  throw new Error("payouts did not settle");
}

async function main() {
  const gameKp = Keypair.generate(), dev = Keypair.generate(), a = Keypair.generate(), b = Keypair.generate(), c = Keypair.generate(), d = Keypair.generate(), trader = Keypair.generate();
  await fund(gameKp, dev, a, b, c, d, trader);

  // 1. The game wallet creates the coin and points 85% of creator fees at itself, 15% at the dev wallet.
  const mintKp = Keypair.generate();
  const mint = mintKp.publicKey;
  await sendAndConfirm(conn, gameKp, [await PUMP_SDK.createV2Instruction({
    mint, name: "Crown Game Test", symbol: "CRWN", uri: "https://example.invalid/c.json", creator: gameKp.publicKey, user: gameKp.publicKey, mayhemMode: false,
  })], { signers: [mintKp] });
  await sendAndConfirm(conn, gameKp, [
    await PUMP_SDK.createFeeSharingConfig({ creator: gameKp.publicKey, mint, pool: null }),
    await PUMP_SDK.updateFeeSharesV2({
      authority: gameKp.publicKey, mint, currentShareholders: [gameKp.publicKey],
      newShareholders: [{ address: gameKp.publicKey, shareBps: 8_500 }, { address: dev.publicKey, shareBps: 1_500 }],
      quoteMint: NATIVE_MINT, quoteTokenProgram: TOKEN_PROGRAM_ID,
    }),
  ]);
  ok("coin created by the game wallet, creator fees 85% game wallet / 15% dev");

  const path = ".fork/game-check.sqlite";
  rmSync(path, { force: true }); rmSync(path + "-wal", { force: true }); rmSync(path + "-shm", { force: true });
  const db = new Db(path);
  const game = new CrownGame(conn, mint, gameKp, new GameStore(db.connection), db, {
    params: { ...DEFAULT_PARAMS, buybackCooldownS: 0 },
    buybackMinLamports: 1_000_000n,
  });

  // 2. Fees with no king go to the burn bucket.
  await curveBuy(trader, mint, 2);
  console.log("   ", await game.collect());
  assert.ok(BigInt(game.view().burnBucketLamports) > 0n);
  ok("fees with no king go to the burn bucket");

  // 3. First claim.
  const open = BigInt(game.view().price);
  await pay(game, a);
  console.log("   ", (await game.processIncoming()).join("; "));
  assert.equal(game.view().king, a.publicKey.toBase58());
  ok(`A takes the crown for the opening price ${open}`);

  // 4. Fees accrue to king A.
  await curveBuy(trader, mint, 3);
  console.log("   ", await game.collect());
  const owedA = BigInt(game.view().kingOwed!);
  assert.ok(owedA > 0n);
  ok(`king A is owed ${owedA} lamports of fees`);

  // 5. B takes it: A gets 90% of the price plus the unclaimed fees.
  const aBefore = BigInt(await conn.getBalance(a.publicKey));
  const priceB = BigInt(game.view().price);
  await pay(game, b);
  await game.processIncoming();
  assert.equal(game.view().king, b.publicKey.toBase58());
  await settlePayouts(game);
  const aGot = BigInt(await conn.getBalance(a.publicKey)) - aBefore;
  const expect = priceB - priceB / 10n + owedA;
  assert.ok(aGot >= expect - 2n && aGot <= expect + 2n, `A received ${aGot}, expected about ${expect}`);
  ok(`B takes it; A received 90% of ${priceB} plus ${owedA} unclaimed fees`);

  // 6. Two buyers race on the same price: the first lands, the second is refunded in full.
  const q1 = await game.quote(c.publicKey, 1_000n * SOL);
  const q2 = await game.quote(d.publicKey, 1_000n * SOL);
  const dBefore = BigInt(await conn.getBalance(d.publicKey));
  for (const [kp, q] of [[c, q1], [d, q2]] as const) {
    const tx = VersionedTransaction.deserialize(Buffer.from(q.transaction, "base64"));
    tx.sign([kp]);
    await conn.confirmTransaction({ signature: await conn.sendTransaction(tx), blockhash: q.blockhash, lastValidBlockHeight: q.lastValidBlockHeight }, "confirmed");
  }
  console.log("   ", (await game.processIncoming()).join("; "));
  assert.equal(game.view().king, c.publicKey.toBase58());
  await settlePayouts(game);
  const dLost = dBefore - BigInt(await conn.getBalance(d.publicKey));
  assert.ok(dLost < 20_000n, `D lost only network fees (${dLost} lamports)`);
  ok("C and D pay for the same price: C becomes king, D gets a full refund");

  // 7. Fortify: the king pays only the 10% burn.
  const cBefore = BigInt(await conn.getBalance(c.publicKey));
  const priceC = BigInt(game.view().price);
  await pay(game, c);
  await game.processIncoming();
  const cPaid = cBefore - BigInt(await conn.getBalance(c.publicKey));
  assert.ok(cPaid < priceC / 10n + 20_000n, `fortify cost ${cPaid}, the burn is ${priceC / 10n}`);
  assert.equal(game.view().takeoverCount, 4);
  ok(`C fortifies for ${cPaid} lamports (10% of ${priceC} plus network fee)`);

  // 8. Claim: the king's fees are paid to their wallet.
  await curveBuy(trader, mint, 2);
  await game.collect();
  const owedC = BigInt(game.view().kingOwed!);
  const cBefore2 = BigInt(await conn.getBalance(c.publicKey));
  assert.equal(await game.claim(c.publicKey), owedC);
  await settlePayouts(game);
  assert.equal(BigInt(await conn.getBalance(c.publicKey)) - cBefore2, owedC);
  ok(`king C claims ${owedC} lamports of fees`);

  // 9. Buyback and burn on the bonding curve.
  const supply0 = (await getMint(conn, mint, "confirmed", (await conn.getAccountInfo(mint))!.owner)).supply;
  console.log("   ", await game.buyback());
  const supply1 = (await getMint(conn, mint, "confirmed", (await conn.getAccountInfo(mint))!.owner)).supply;
  assert.ok(supply1 < supply0, "supply went down");
  assert.ok(BigInt(game.view().totalTokensBurned) > 0n);
  ok(`burn: supply ${supply0} -> ${supply1}`);

  // 10. Solvency: the game wallet covers every promise.
  const bal = BigInt(await conn.getBalance(gameKp.publicKey));
  assert.ok(bal >= game.liabilities(), `game wallet ${bal} >= liabilities ${game.liabilities()}`);
  ok(`game wallet ${bal} lamports covers its liabilities ${game.liabilities()}`);
  console.log("\nGAME CHECK PASSED");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
