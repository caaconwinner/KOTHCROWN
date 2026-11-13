// Types and fetchers for the indexer API (services/crown/src/api.ts).
// Lamport amounts arrive as strings.

export interface CrownView {
  mint: string;
  king: string | null;
  price: string;
  floor: string;
  meltBps: number;
  feesPerMinute: string;
  checkpointPrice: string;
  checkpointTs: number;
  lastSyncTs?: number;
  reignStartedTs: number;
  kingFeesThisReign: string;
  takeoverCount: number;
  totalFees: string;
  totalBurnSol: string;
  totalTokensBurned: string;
  burnBucketLamports: string;
  locked: boolean;
  params: Record<string, string | number>;
  now: number;
  /** Server-run game only: fees waiting for the king to claim, and the wallet payments go to. */
  kingOwed?: string;
  gameWallet?: string;
}

export interface Takeover {
  signature: string;
  ts: number;
  takeoverCount: number;
  newKing: string;
  oldKing: string | null;
  pricePaid: string;
  toOldKing: string;
  toBurn: string;
  newPrice: string;
  jumpBps: number;
  reignSecs: number;
  oldReignFees: string;
}

export interface Entry { king: string; value: string; signature?: string }

export interface Leaderboard {
  longestReign: Entry[];
  mostEarned: Entry[];
  biggestTakeover: Entry[];
  mostBurned: Entry[];
  totals: { takeovers: number; solBoughtBack: string; tokensBurned: string };
}

export interface TakeTx {
  transaction: string;
  blockhash: string;
  lastValidBlockHeight: number;
  maxPrice: string;
  /** Buyback-and-burn, sent after the takeover lands (only once the coin has graduated). */
  burn?: string;
}

export interface ClaimTx {
  transaction: string;
  blockhash: string;
  lastValidBlockHeight: number;
}

const RAW_API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";
/** False until an API is configured: the site then shows its pre-launch page. */
export const LIVE = RAW_API_URL !== "";
/** "/" means the API built into this site (src/app/api); anything else is a separate server. */
export const API_URL = RAW_API_URL.replace(/\/$/, "");
export const CLUSTER = process.env.NEXT_PUBLIC_CLUSTER ?? "mainnet";
/** When set, open pages ask the built-in API to pay out fees about once a minute. */
export const LAZY_CRANK = process.env.NEXT_PUBLIC_LAZY_CRANK === "1";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(API_URL + path, { cache: "no-store" });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `request failed (${res.status})`);
  return body as T;
}

export const getCrown = () => get<CrownView>("/api/crown");
export const getHistory = (limit = 30) => get<{ takeovers: Takeover[] }>(`/api/history?limit=${limit}`).then((r) => r.takeovers);
export const getLeaderboard = () => get<Leaderboard>("/api/leaderboard");
export const getTakeTx = (buyer: string, maxPrice: bigint) =>
  get<TakeTx>(`/api/tx/take?buyer=${buyer}&maxPrice=${maxPrice}`);
export const getClaimTx = (payer: string) => get<ClaimTx>(`/api/tx/claim?payer=${payer}`);
/** Server-run game: pays the wallet what it is owed. */
export const claimFees = (wallet: string) => get<{ lamports: string }>(`/api/claim?wallet=${wallet}`);
/** Server-run game: asks the server to read the payment that just landed. */
export const confirmTake = () => get<{ ok: boolean }>(`/api/take/confirm`).catch(() => undefined);

/** Asks the built-in API to run the fee sync if it is due. Failures do not matter. */
export const pingCrank = () => fetch(API_URL + "/api/crank", { cache: "no-store" }).catch(() => undefined);
