import { DatabaseSync } from "node:sqlite";
import { type GameState, stateFromJson, stateToJson } from "./logic";

export interface Quote {
  id: string;
  buyer: string;
  /** The crown's price the buyer is quoted. */
  price: bigint;
  /** What they send (the price, or only the burn when fortifying). */
  amount: bigint;
  takeoverCount: number;
  expiresAt: number;
  /** Set once a payment for it has been processed. */
  usedBy: string | null;
}

export type PayoutReason = "takeover" | "fees" | "refund";

export interface Payout {
  id: number;
  wallet: string;
  lamports: bigint;
  reason: PayoutReason;
  /** pending -> sending (signature known, may or may not have landed) -> sent */
  status: "pending" | "sending" | "sent";
  signature: string | null;
  lastValidBlockHeight: number | null;
  createdAt: number;
}

/**
 * The game's own tables, next to the event tables of `Db`. Pass `Db.connection`
 * so game state and events commit in one transaction.
 */
export class GameStore {
  private db: DatabaseSync;

  constructor(pathOrConnection: string | DatabaseSync) {
    this.db = typeof pathOrConnection === "string" ? new DatabaseSync(pathOrConnection) : pathOrConnection;
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS game_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS quotes (
        id TEXT PRIMARY KEY, buyer TEXT NOT NULL, price TEXT NOT NULL, amount TEXT NOT NULL,
        takeover_count INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_by TEXT
      );
      CREATE TABLE IF NOT EXISTS owed (wallet TEXT PRIMARY KEY, lamports TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS payouts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, wallet TEXT NOT NULL, lamports TEXT NOT NULL, reason TEXT NOT NULL,
        status TEXT NOT NULL, signature TEXT, last_valid_block_height INTEGER, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS processed (signature TEXT PRIMARY KEY, outcome TEXT NOT NULL);
    `);
  }

  close() {
    this.db.close();
  }

  /** Runs `fn` in one SQLite transaction: all of it lands, or none. */
  atomic<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  get(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM game_meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }
  set(key: string, value: string) {
    this.db.prepare("INSERT INTO game_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  state(): GameState | null {
    const j = this.get("state");
    return j === null ? null : stateFromJson(j);
  }
  saveState(s: GameState) {
    this.set("state", stateToJson(s));
  }

  // ---- quotes

  addQuote(q: Omit<Quote, "usedBy">) {
    this.db.prepare("INSERT INTO quotes (id, buyer, price, amount, takeover_count, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(q.id, q.buyer, q.price.toString(), q.amount.toString(), q.takeoverCount, q.expiresAt);
  }
  quote(id: string): Quote | null {
    const r = this.db.prepare("SELECT * FROM quotes WHERE id = ?").get(id) as Record<string, any> | undefined;
    if (!r) return null;
    return {
      id: r.id, buyer: r.buyer, price: BigInt(r.price), amount: BigInt(r.amount),
      takeoverCount: Number(r.takeover_count), expiresAt: Number(r.expires_at), usedBy: r.used_by ?? null,
    };
  }
  useQuote(id: string, signature: string) {
    this.db.prepare("UPDATE quotes SET used_by = ? WHERE id = ?").run(signature, id);
  }
  pruneQuotes(before: number) {
    this.db.prepare("DELETE FROM quotes WHERE expires_at < ? AND used_by IS NULL").run(before);
  }

  // ---- balances owed to wallets (fees not yet claimed)

  owed(wallet: string): bigint {
    const r = this.db.prepare("SELECT lamports FROM owed WHERE wallet = ?").get(wallet) as { lamports: string } | undefined;
    return r ? BigInt(r.lamports) : 0n;
  }
  addOwed(wallet: string, lamports: bigint) {
    if (lamports === 0n) return;
    this.db.prepare("INSERT INTO owed (wallet, lamports) VALUES (?, ?) ON CONFLICT(wallet) DO UPDATE SET lamports = CAST(CAST(lamports AS INTEGER) + ? AS TEXT)")
      .run(wallet, lamports.toString(), lamports.toString());
  }
  /** Moves everything `wallet` is owed into a payout. Returns the amount. */
  takeOwed(wallet: string): bigint {
    const v = this.owed(wallet);
    if (v > 0n) this.db.prepare("DELETE FROM owed WHERE wallet = ?").run(wallet);
    return v;
  }
  totalOwed(): bigint {
    const rows = this.db.prepare("SELECT lamports FROM owed").all() as { lamports: string }[];
    return rows.reduce((s, r) => s + BigInt(r.lamports), 0n);
  }

  // ---- payouts

  addPayout(wallet: string, lamports: bigint, reason: PayoutReason, now: number) {
    if (lamports <= 0n) return;
    this.db.prepare("INSERT INTO payouts (wallet, lamports, reason, status, created_at) VALUES (?, ?, ?, 'pending', ?)")
      .run(wallet, lamports.toString(), reason, now);
  }
  private payoutRow(r: Record<string, any>): Payout {
    return {
      id: Number(r.id), wallet: r.wallet, lamports: BigInt(r.lamports), reason: r.reason, status: r.status,
      signature: r.signature ?? null, lastValidBlockHeight: r.last_valid_block_height ?? null, createdAt: Number(r.created_at),
    };
  }
  unfinishedPayouts(): Payout[] {
    return (this.db.prepare("SELECT * FROM payouts WHERE status != 'sent' ORDER BY id").all() as Record<string, any>[]).map((r) => this.payoutRow(r));
  }
  /** Records the signature BEFORE sending, so a crash can never lead to paying twice. */
  markSending(id: number, signature: string, lastValidBlockHeight: number) {
    this.db.prepare("UPDATE payouts SET status = 'sending', signature = ?, last_valid_block_height = ? WHERE id = ?").run(signature, lastValidBlockHeight, id);
  }
  markSent(id: number) {
    this.db.prepare("UPDATE payouts SET status = 'sent' WHERE id = ?").run(id);
  }
  /** The send expired without landing: try again with a new transaction. */
  markPending(id: number) {
    this.db.prepare("UPDATE payouts SET status = 'pending', signature = NULL, last_valid_block_height = NULL WHERE id = ?").run(id);
  }
  unpaidTotal(): bigint {
    const rows = this.db.prepare("SELECT lamports FROM payouts WHERE status != 'sent'").all() as { lamports: string }[];
    return rows.reduce((s, r) => s + BigInt(r.lamports), 0n);
  }

  // ---- incoming payments already handled

  processed(signature: string): boolean {
    return this.db.prepare("SELECT 1 FROM processed WHERE signature = ?").get(signature) !== undefined;
  }
  markProcessed(signature: string, outcome: string) {
    this.db.prepare("INSERT OR IGNORE INTO processed (signature, outcome) VALUES (?, ?)").run(signature, outcome);
  }
}
