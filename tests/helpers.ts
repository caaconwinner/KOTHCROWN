import { readFileSync } from "node:fs";
import { BN, BorshCoder, type Idl } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_SLOT_HASHES_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { Clock, type ProgramTestContext, start } from "solana-bankrun";

process.env.BPF_OUT_DIR = "target/deploy";
import { crownPdas, DEFAULT_PARAMS, math, type Params } from "@koth-crown/sdk";

export const SOL = 1_000_000_000n;
export const START_TS = 1_800_000_000n;

const idl = JSON.parse(readFileSync("target/idl/crown.json", "utf8")) as Idl;
const coder = new BorshCoder(idl);
export const PROGRAM_ID = new PublicKey(idl.address);

const toIdlParams = (p: Params) => ({
  jump_min_bps: p.jumpMinBps,
  jump_max_bps: p.jumpMaxBps,
  melt_min_bps: p.meltMinBps,
  melt_base_bps: p.meltBaseBps,
  melt_max_bps: p.meltMaxBps,
  floor_minutes: p.floorMinutes,
  burn_bps: p.burnBps,
  dev_fee_bps: p.devFeeBps,
  fast_half_life_s: p.fastHalfLifeS,
  slow_half_life_s: p.slowHalfLifeS,
  opening_price: new BN(p.openingPrice.toString()),
  min_price: new BN(p.minPrice.toString()),
  max_buyback_lamports: new BN(p.maxBuybackLamports.toString()),
  buyback_cooldown_s: p.buybackCooldownS,
  floor_cap_bps: p.floorCapBps,
});

const big = (v: unknown) => BigInt((v as BN).toString());

export interface CrownState {
  king: PublicKey | null;
  checkpointPrice: bigint;
  checkpointTs: bigint;
  meltBps: number;
  fastEma: bigint;
  slowEma: bigint;
  lastSyncTs: bigint;
  pendingFees: bigint;
  reignStartedTs: bigint;
  takeoverCount: bigint;
  kingFeesThisReign: bigint;
  totalFees: bigint;
  totalDevFees: bigint;
  totalBurnSol: bigint;
  lastBuybackTs: bigint;
  totalTokensBurned: bigint;
  reignPrice: bigint;
}

export class TxError extends Error {
  constructor(public logs: string[], public errString: string) {
    super(`transaction failed: ${errString}\n${logs.join("\n")}`);
  }
  /** Anchor error name from the logs, e.g. "PriceAboveMax". */
  get code(): string | undefined {
    return this.logs.join("\n").match(/Error Code: (\w+)/)?.[1];
  }
}

export interface TxMeta {
  logs: string[];
  returnData: Buffer;
  computeUnits: number;
}

/** One Crown deployment inside a fresh bankrun bank, with a controllable clock. */
export class Env {
  payer!: Keypair; // pays every tx fee, so other balances stay exact
  authority = Keypair.generate();
  dev = Keypair.generate();
  mint = Keypair.generate().publicKey;
  pdas = crownPdas(this.mint, PROGRAM_ID);
  params: Params;
  /** Result of the most recent successful transaction. */
  last!: TxMeta;
  private ctx!: ProgramTestContext;
  // Shared by every Env on the same bank.
  private shared = { ts: START_TS, nonce: 0 };

  private constructor(overrides: Partial<Params>) {
    this.params = { ...DEFAULT_PARAMS, ...overrides };
  }

  /** A fresh bank with one crown, or a second crown on `sameBankAs`'s bank. */
  static async create(overrides: Partial<Params> = {}, sameBankAs?: Env): Promise<Env> {
    const env = new Env(overrides);
    if (sameBankAs) {
      env.ctx = sameBankAs.ctx;
      env.shared = sameBankAs.shared;
    } else {
      env.ctx = await start([{ name: "crown", programId: PROGRAM_ID }], []);
      await env.setTime(START_TS);
    }
    env.payer = env.ctx.payer;
    env.fund(env.payer.publicKey, 5_000_000n * SOL);
    env.fund(env.authority.publicKey, 10n * SOL);
    env.fund(env.dev.publicKey, 1n * SOL);
    await env.initialize();
    return env;
  }

  initialize() {
    return this.send([this.ix("initialize", { params: toIdlParams(this.params), dev_wallet: this.dev.publicKey }, [
      [this.authority.publicKey, true, true],
      [this.mint, false, false],
      [this.pdas.config, false, true],
      [this.pdas.crown, false, true],
      [this.pdas.vault, false, true],
      [this.pdas.burnBucket, false, true],
      [SystemProgram.programId, false, false],
    ])], [this.authority]);
  }

  // ---- clock

  now(): bigint {
    return this.shared.ts;
  }
  async setTime(ts: bigint) {
    const c = await this.ctx.banksClient.getClock();
    this.ctx.setClock(new Clock(c.slot, c.epochStartTimestamp, c.epoch, c.leaderScheduleEpoch, ts));
    this.shared.ts = ts;
  }
  warp(secs: number | bigint) {
    return this.setTime(this.shared.ts + BigInt(secs));
  }

  // ---- accounts

  /** Sets a system account's balance outright. */
  fund(to: PublicKey, lamports: bigint) {
    this.ctx.setAccount(to, {
      lamports: Number(lamports),
      data: Buffer.alloc(0),
      owner: SystemProgram.programId,
      executable: false,
    });
  }
  wallet(sol = 100n): Keypair {
    const kp = Keypair.generate();
    this.fund(kp.publicKey, sol * SOL);
    return kp;
  }
  balance(a: PublicKey): Promise<bigint> {
    return this.ctx.banksClient.getBalance(a);
  }
  private async data(a: PublicKey): Promise<Buffer> {
    return Buffer.from((await this.ctx.banksClient.getAccount(a))!.data);
  }
  async crown(): Promise<CrownState> {
    const raw = coder.accounts.decode("Crown", await this.data(this.pdas.crown));
    return {
      king: raw.king,
      checkpointPrice: big(raw.checkpoint_price),
      checkpointTs: big(raw.checkpoint_ts),
      meltBps: raw.melt_bps,
      fastEma: big(raw.fast_ema),
      slowEma: big(raw.slow_ema),
      lastSyncTs: big(raw.last_sync_ts),
      pendingFees: big(raw.pending_fees),
      reignStartedTs: big(raw.reign_started_ts),
      takeoverCount: big(raw.takeover_count),
      kingFeesThisReign: big(raw.king_fees_this_reign),
      totalFees: big(raw.total_fees),
      totalDevFees: big(raw.total_dev_fees),
      totalBurnSol: big(raw.total_burn_sol),
      lastBuybackTs: big(raw.last_buyback_ts),
      totalTokensBurned: big(raw.total_tokens_burned),
      reignPrice: big(raw.reign_price),
    };
  }
  async config(): Promise<any> {
    return coder.accounts.decode("Config", await this.data(this.pdas.config));
  }
  /** What the program would charge right now (ignores unsynced vault fees). */
  async price(): Promise<bigint> {
    const c = await this.crown();
    const p = this.params;
    const floor = c.king
      ? math.cappedFloor(c.fastEma, p.floorMinutes, p.minPrice, c.reignPrice, p.floorCapBps)
      : math.floorPrice(c.fastEma, p.floorMinutes, p.minPrice);
    if (!c.king) return this.params.openingPrice > floor ? this.params.openingPrice : floor;
    return math.priceNow(c.checkpointPrice, c.meltBps, this.now() - c.checkpointTs, floor);
  }

  // ---- transactions

  ix(name: string, args: object, keys: [PublicKey, boolean, boolean][]): TransactionInstruction {
    return new TransactionInstruction({
      programId: PROGRAM_ID,
      data: coder.instruction.encode(name, args),
      keys: keys.map(([pubkey, isSigner, isWritable]) => ({ pubkey, isSigner, isWritable })),
    });
  }

  async send(ixs: TransactionInstruction[], signers: Keypair[] = []): Promise<TxMeta> {
    // A changing compute limit keeps otherwise identical transactions distinct.
    const unique = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 + this.shared.nonce++ });
    const tx = new Transaction().add(unique, ...ixs);
    tx.feePayer = this.payer.publicKey;
    tx.recentBlockhash = (await this.ctx.banksClient.getLatestBlockhash())![0];
    tx.sign(this.payer, ...signers);
    const res = await this.ctx.banksClient.tryProcessTransaction(tx);
    const logs = res.meta?.logMessages ?? [];
    if (res.result) throw new TxError(logs, res.result);
    return this.last = {
      logs,
      returnData: Buffer.from(res.meta?.returnData?.data ?? []),
      computeUnits: Number(res.meta?.computeUnitsConsumed ?? 0n),
    };
  }

  events(meta: TxMeta): { name: string; data: any }[] {
    return meta.logs
      .filter((l) => l.startsWith("Program data: "))
      .map((l) => coder.events.decode(l.slice("Program data: ".length)))
      .filter((e): e is { name: string; data: any } => e !== null);
  }

  private async kingKey(): Promise<PublicKey> {
    return (await this.crown()).king ?? this.pdas.burnBucket;
  }

  /** Mock fee source: a plain transfer into the vault, which is exactly what
   * pump.fun's distribute does. */
  dropFees(lamports: bigint) {
    return this.send([
      SystemProgram.transfer({ fromPubkey: this.payer.publicKey, toPubkey: this.pdas.vault, lamports }),
    ]);
  }

  async syncFees(king?: PublicKey) {
    king ??= await this.kingKey();
    return this.send([this.ix("sync_fees", {}, [
      [this.pdas.config, false, false],
      [this.pdas.crown, false, true],
      [this.pdas.vault, false, true],
      [this.pdas.burnBucket, false, true],
      [king, false, true],
      [this.dev.publicKey, false, true],
      [SystemProgram.programId, false, false],
    ])]);
  }

  async takeCrown(buyer: Keypair, maxPrice: bigint, king?: PublicKey) {
    king ??= await this.kingKey();
    const meta = await this.send([this.ix("take_crown", { max_price: new BN(maxPrice.toString()) }, [
      [buyer.publicKey, true, true],
      [this.pdas.config, false, false],
      [this.pdas.crown, false, true],
      [this.pdas.vault, false, true],
      [this.pdas.burnBucket, false, true],
      [king, false, true],
      [this.dev.publicKey, false, true],
      [SYSVAR_SLOT_HASHES_PUBKEY, false, false],
      [SystemProgram.programId, false, false],
    ])], [buyer]);
    return this.events(meta).find((e) => e.name === "CrownTaken")!.data;
  }

  updateConfig(signer: Keypair, params: Params, devWallet: PublicKey = this.dev.publicKey) {
    return this.send([this.ix("update_config", { params: toIdlParams(params), dev_wallet: devWallet }, [
      [signer.publicKey, true, false],
      [this.pdas.config, false, true],
    ])], [signer]);
  }

  lockConfig(signer: Keypair) {
    return this.send([this.ix("lock_config", {}, [
      [signer.publicKey, true, false],
      [this.pdas.config, false, true],
    ])], [signer]);
  }

  /** `minutes` rounds of: wait 60s, drop `perMinute` lamports, sync. */
  async flow(minutes: number, perMinute: bigint) {
    for (let i = 0; i < minutes; i++) {
      await this.warp(60);
      if (perMinute > 0n) await this.dropFees(perMinute);
      await this.syncFees();
    }
  }
}

export const MAX = (1n << 64n) - 1n;
