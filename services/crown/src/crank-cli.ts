// Runs the crank forever: `pnpm --filter @koth-crown/services crank`.
import { connection, keypair, mint as mintFromEnv, num } from "./config";
import { Crank } from "./crank";

const crank = new Crank(connection(), keypair(), mintFromEnv(), {
  priorityMicroLamports: num("PRIORITY_MICROLAMPORTS", 0),
  buybackMinLamports: BigInt(num("BUYBACK_MIN_LAMPORTS", 50_000_000)),
  buybackSlippageBps: num("BUYBACK_SLIPPAGE_BPS", 200),
});
crank.run(num("SYNC_INTERVAL_S", 60));
