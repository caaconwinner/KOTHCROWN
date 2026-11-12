import { DatabaseSync } from "node:sqlite";

// Lamport amounts are stored as TEXT and handled as bigint: they do not fit
// in a JS number once totals grow.

export interface Takeover {
  signature: string;
  slot: number;
  ts: number;
  takeoverCount: number;
  newKing: string;
  oldKing: string | null;
  pricePaid: bigint;
  toOldKing: bigint;
  toBurn: bigint;
  newPrice: bigint;
  jumpBps: number;
  reignSecs: number;
  oldReignFees: bigint;
}

export interface FeeSync {
  signature: string;
  seq: number;
  slot: number;
  ts: number;
  delta: bigint;
  toKing: bigint;
  toDev: bigint;
  toBurn: bigint;
  fastEma: bigint;
  slowEma: bigint;
  meltBps: number;
  floor: bigint;
  price: bigint;
}

export interface Burn {
  signature: string;
  seq: number;
  slot: number;
  ts: number;
  solIn: bigint;
  tokensBurned: bigint;
}

export class Db {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS takeovers (
        signature TEXT PRIMARY KEY, slot INTEGER, ts INTEGER, takeover_count INTEGER,
        new_king TEXT, old_king TEXT, price_paid TEXT, to_old_king TEXT, to_burn TEXT,
        new_price TEXT, jump_bps INTEGER, reign_secs INTEGER, old_reign_fees TEXT);
      CREATE INDEX IF NOT EXISTS takeovers_count ON takeovers (takeover_count);
      CREATE TABLE IF NOT EXISTS syncs (
        signature TEXT, seq INTEGER, slot INTEGER, ts INTEGER, delta TEXT, to_king TEXT, to_dev TEXT,
        to_burn TEXT, fast_ema TEXT, slow_ema TEXT, melt_bps INTEGER, floor TEXT, price TEXT,
        PRIMARY KEY (signature, seq));
      CREATE TABLE IF NOT EXISTS burns (
        signature TEXT, seq INTEGER, slot INTEGER, ts INTEGER, sol_in TEXT, tokens_burned TEXT,
        PRIMARY KEY (signature, seq));
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    `);
  }

  close() {
    this.db.close();
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }
  setMeta(key: string, value: string) {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  /** Each insert returns true only the first time that row is seen. */
  insertTakeover(t: Takeover): boolean {
    const r = this.db.prepare("INSERT OR IGNORE INTO takeovers VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      t.signature, t.slot, t.ts, t.takeoverCount, t.newKing, t.oldKing, String(t.pricePaid), String(t.toOldKing),
      String(t.toBurn), String(t.newPrice), t.jumpBps, t.reignSecs, String(t.oldReignFees));
    return Number(r.changes) > 0;
  }
  insertSync(s: FeeSync): boolean {
    const r = this.db.prepare("INSERT OR IGNORE INTO syncs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      s.signature, s.seq, s.slot, s.ts, String(s.delta), String(s.toKing), String(s.toDev), String(s.toBurn),
      String(s.fastEma), String(s.slowEma), s.meltBps, String(s.floor), String(s.price));
    return Number(r.changes) > 0;
  }
  insertBurn(b: Burn): boolean {
    const r = this.db.prepare("INSERT OR IGNORE INTO burns VALUES (?,?,?,?,?,?)").run(
      b.signature, b.seq, b.slot, b.ts, String(b.solIn), String(b.tokensBurned));
    return Number(r.changes) > 0;
  }

  private toTakeover = (r: any): Takeover => ({
    signature: r.signature, slot: r.slot, ts: r.ts, takeoverCount: r.takeover_count, newKing: r.new_king,
    oldKing: r.old_king, pricePaid: BigInt(r.price_paid), toOldKing: BigInt(r.to_old_king), toBurn: BigInt(r.to_burn),
    newPrice: BigInt(r.new_price), jumpBps: r.jump_bps, reignSecs: r.reign_secs, oldReignFees: BigInt(r.old_reign_fees),
  });

  /** Newest first. `before` is a takeover_count for paging. */
  takeovers(limit: number, before?: number): Takeover[] {
    const rows = before === undefined
      ? this.db.prepare("SELECT * FROM takeovers ORDER BY takeover_count DESC LIMIT ?").all(limit)
      : this.db.prepare("SELECT * FROM takeovers WHERE takeover_count < ? ORDER BY takeover_count DESC LIMIT ?").all(before, limit);
    return rows.map(this.toTakeover);
  }
  allTakeovers(): Takeover[] {
    return this.db.prepare("SELECT * FROM takeovers ORDER BY takeover_count ASC").all().map(this.toTakeover);
  }
  burns(): Burn[] {
    return this.db.prepare("SELECT * FROM burns ORDER BY slot ASC, seq ASC").all().map((r: any) => ({
      signature: r.signature, seq: r.seq, slot: r.slot, ts: r.ts, solIn: BigInt(r.sol_in), tokensBurned: BigInt(r.tokens_burned),
    }));
  }
  counts() {
    const n = (t: string) => Number((this.db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c);
    return { takeovers: n("takeovers"), syncs: n("syncs"), burns: n("burns") };
  }
}
