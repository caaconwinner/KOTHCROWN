// Creates the coin on pump.fun from the game wallet and points its creator
// fees 85% at the game wallet and 15% at the dev wallet (one-shot, permanent).
//
//   RPC_URL=... GAME_KEYPAIR=/etc/crown/game.json DEV_WALLET=... \
//   NAME="take the crown" SYMBOL=CROWN URI=https://takethecrown.fun/brand/coin.json \
//   tsx src/game/launch.ts
//
// On mainnet it refuses to run unless --mainnet is passed AND CONFIRM_MAINNET
// is set to the game wallet's address. Prints the mint: put it in MINT.
import { Keypair, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PUMP_SDK } from "@pump-fun/pump-sdk";
import { connection, isMainnet, keypair, str } from "../config";
import { sendAndConfirm } from "../tx";

async function main() {
  process.env.KEYPAIR ??= process.env.GAME_KEYPAIR;
  const conn = connection();
  const game = keypair();
  const dev = new PublicKey(str("DEV_WALLET"));
  if (await isMainnet(conn)) {
    if (!process.argv.includes("--mainnet") || process.env.CONFIRM_MAINNET !== game.publicKey.toBase58()) {
      throw new Error("this is MAINNET. Re-run with --mainnet and CONFIRM_MAINNET=<game wallet address> to spend real SOL.");
    }
  }
  if (!(await conn.getAccountInfo(dev))) throw new Error("DEV_WALLET has no SOL. pump.fun cannot pay fees to an account that does not exist yet: fund it first.");

  const mintKp = Keypair.generate();
  const mint = mintKp.publicKey;
  let sent = await sendAndConfirm(conn, game, [await PUMP_SDK.createV2Instruction({
    mint, name: str("NAME"), symbol: str("SYMBOL"), uri: str("URI"), creator: game.publicKey, user: game.publicKey, mayhemMode: false,
  })], { signers: [mintKp] });
  console.log("coin created:", mint.toBase58(), sent.signature);
  sent = await sendAndConfirm(conn, game, [
    await PUMP_SDK.createFeeSharingConfig({ creator: game.publicKey, mint, pool: null }),
    await PUMP_SDK.updateFeeSharesV2({
      authority: game.publicKey, mint, currentShareholders: [game.publicKey],
      newShareholders: [{ address: game.publicKey, shareBps: 8_500 }, { address: dev, shareBps: 1_500 }],
      quoteMint: NATIVE_MINT, quoteTokenProgram: TOKEN_PROGRAM_ID,
    }),
  ]);
  console.log("creator fees: 85% game wallet, 15% dev (permanent):", sent.signature);
  console.log(`\nMINT=${mint.toBase58()}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
