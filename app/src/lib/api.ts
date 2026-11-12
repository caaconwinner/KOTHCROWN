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
}

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "");
/** False until an indexer API is configured: the site then shows its pre-launch page. */
export const LIVE = API_URL !== "";

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
