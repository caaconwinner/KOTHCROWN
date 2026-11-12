// One-time setup for a launched coin, in the only safe order:
//   1. initialize the crown (creates the fee vault)
//   2. point pump.fun creator fees at vault 95% / dev 5% (one-shot, permanent)
//   3. lock_config (only with --lock, permanent)
// Every step checks the chain first, so the script can be re-run after a
// failure and never repeats a step that is already done.
//
//   RPC_URL=... KEYPAIR=... MINT=... DEV_WALLET=... pnpm --filter @koth-crown/services setup [--lock]
//
// KEYPAIR must be the coin's creator. On mainnet the script refuses to run
// unless --mainnet is passed AND CONFIRM_MAINNET is set to the mint address.
import { PublicKey } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { canonicalPumpPoolPda, feeSharingConfigPda, PUMP_SDK } from "@pump-fun/pump-sdk";
import { crownPdas, decodeConfig, DEFAULT_PARAMS, initializeIx, lockConfigIx } from "@koth-crown/sdk";
import { connection, isMainnet, keypair, mint as mintFromEnv, str } from "./config";
import { sendAndConfirm } from "./tx";

const VAULT_BPS = 9_500;
const DEV_BPS = 500;

async function main() {
  const conn = connection();
  const creator = keypair();
  const mint = mintFromEnv();
  const devWallet = new PublicKey(str("DEV_WALLET"));
  const lock = process.argv.includes("--lock");
  const pdas = crownPdas(mint);

  if (await isMainnet(conn)) {
    if (!process.argv.includes("--mainnet") || process.env.CONFIRM_MAINNET !== mint.toBase58()) {
      throw new Error("this is MAINNET. Re-run with --mainnet and CONFIRM_MAINNET=<mint address> to spend real SOL.");
    }
    console.log("MAINNET run confirmed for", mint.toBase58());
  }

  if (!(await conn.getAccountInfo(mint))) throw new Error(`mint ${mint.toBase58()} does not exist on this cluster`);
  if (!(await conn.getAccountInfo(devWallet))) {
    throw new Error("DEV_WALLET has no SOL. pump.fun cannot pay fees to an account that does not exist yet: fund it first.");
  }

  // 1. initialize
  let cfgAcc = await conn.getAccountInfo(pdas.config);
  if (!cfgAcc) {
    const sent = await sendAndConfirm(conn, creator, [
      initializeIx({ authority: creator.publicKey, mint, devWallet, params: DEFAULT_PARAMS }),
    ]);
    console.log("1. initialized:", sent.signature);
    cfgAcc = await conn.getAccountInfo(pdas.config);
  } else {
    console.log("1. already initialized");
  }
  const cfg = decodeConfig(cfgAcc!.data);
  if (!cfg.devWallet.equals(devWallet)) throw new Error(`Config.dev_wallet is ${cfg.devWallet.toBase58()}, not DEV_WALLET`);
  if (!(await conn.getAccountInfo(pdas.vault))) throw new Error("fee vault was not created");

  // 2. fee shares
  const want = [
    { address: pdas.vault, shareBps: VAULT_BPS },
    { address: devWallet, shareBps: DEV_BPS },
  ];
  const sharingAddress = feeSharingConfigPda(mint);
  let sharingAcc = await conn.getAccountInfo(sharingAddress);
  if (!sharingAcc) {
    const poolAddress = canonicalPumpPoolPda(mint);
    const pool = (await conn.getAccountInfo(poolAddress)) ? poolAddress : null;
    const sent = await sendAndConfirm(conn, creator, [
      await PUMP_SDK.createFeeSharingConfig({ creator: creator.publicKey, mint, pool }),
      await PUMP_SDK.updateFeeSharesV2({
        authority: creator.publicKey, mint, currentShareholders: [creator.publicKey], newShareholders: want,
        quoteMint: NATIVE_MINT, quoteTokenProgram: TOKEN_PROGRAM_ID,
      }),
    ]);
    console.log("2. fee shares set:", sent.signature);
    sharingAcc = await conn.getAccountInfo(sharingAddress);
  } else {
    console.log("2. fee sharing config already exists, checking it");
  }
  const sharing = PUMP_SDK.decodeSharingConfig(sharingAcc!);
  const got = sharing.shareholders.map((s) => `${s.address.toBase58()}:${s.shareBps}`).join(",");
  const expected = want.map((s) => `${s.address.toBase58()}:${s.shareBps}`).join(",");
  if (got !== expected) {
    throw new Error(`fee shares are not vault ${VAULT_BPS} / dev ${DEV_BPS}.\n  on chain: ${got}\n  expected: ${expected}\nDo NOT lock. The shares ${sharing.adminRevoked ? "can no longer be changed" : "can still be fixed"}.`);
  }
  if (!sharing.adminRevoked) throw new Error("fee shares are right but not locked on pump.fun (admin_revoked is false)");
  console.log(`   vault ${pdas.vault.toBase58()} ${VAULT_BPS} bps, dev ${devWallet.toBase58()} ${DEV_BPS} bps, permanent`);

  // 3. lock
  if (cfg.authority === null) {
    console.log("3. config already locked");
  } else if (lock) {
    const sent = await sendAndConfirm(conn, creator, [lockConfigIx({ authority: creator.publicKey, mint })]);
    console.log("3. config locked:", sent.signature);
  } else {
    console.log("3. config NOT locked. Check the parameters, then run again with --lock (permanent).");
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
