import * as anchorNs from "@coral-xyz/anchor";
import type { Idl } from "@coral-xyz/anchor";
import BN from "bn.js";

// @coral-xyz/anchor is CommonJS. Loaded from an ES module its exports sit
// under `default`; loaded from CommonJS they sit on the namespace itself.
const anchor: typeof anchorNs = (anchorNs as any).default ?? anchorNs;
import {
  PublicKey,
  SystemProgram,
  SYSVAR_SLOT_HASHES_PUBKEY,
  TransactionInstruction,
} from "@solana/web3.js";
import idlJson from "./idl/crown.json";
import type { Params } from "./index";

export const IDL = idlJson as unknown as Idl;
export const coder = new anchor.BorshCoder(IDL);
export const CROWN_PROGRAM_ID = new PublicKey(IDL.address);

const bn = (v: bigint) => new BN(v.toString());
const big = (v: unknown) => BigInt((v as BN).toString());

type Key = [pubkey: PublicKey, isSigner: boolean, isWritable: boolean];
const ix = (name: string, args: object, keys: Key[], programId = CROWN_PROGRAM_ID) =>
  new TransactionInstruction({
    programId,
    data: coder.instruction.encode(name, args),
    keys: keys.map(([pubkey, isSigner, isWritable]) => ({ pubkey, isSigner, isWritable })),
  });

const pda = (seed: string, mint: PublicKey, programId: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from(seed), mint.toBuffer()], programId)[0];

export function crownPdas(mint: PublicKey, programId: PublicKey = CROWN_PROGRAM_ID) {
  return {
    config: pda("config", mint, programId),
    crown: pda("crown", mint, programId),
    vault: pda("vault", mint, programId),
    burnBucket: pda("burn", mint, programId),
  };
}

export const toIdlParams = (p: Params) => ({
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
  opening_price: bn(p.openingPrice),
  min_price: bn(p.minPrice),
  max_buyback_lamports: bn(p.maxBuybackLamports),
  buyback_cooldown_s: p.buybackCooldownS,
});

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
}

export function decodeCrown(data: Buffer): CrownState {
  const raw = coder.accounts.decode("Crown", data);
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
  };
}

export interface ConfigState {
  mint: PublicKey;
  authority: PublicKey | null;
  devWallet: PublicKey;
  pool: PublicKey;
  params: Params;
}

export function decodeConfig(data: Buffer): ConfigState {
  const raw = coder.accounts.decode("Config", data);
  const p = raw.params;
  return {
    mint: raw.mint,
    authority: raw.authority,
    devWallet: raw.dev_wallet,
    pool: raw.pool,
    params: {
      jumpMinBps: p.jump_min_bps,
      jumpMaxBps: p.jump_max_bps,
      meltMinBps: p.melt_min_bps,
      meltBaseBps: p.melt_base_bps,
      meltMaxBps: p.melt_max_bps,
      floorMinutes: p.floor_minutes,
      burnBps: p.burn_bps,
      devFeeBps: p.dev_fee_bps,
      fastHalfLifeS: p.fast_half_life_s,
      slowHalfLifeS: p.slow_half_life_s,
      openingPrice: big(p.opening_price),
      minPrice: big(p.min_price),
      maxBuybackLamports: big(p.max_buyback_lamports),
      buybackCooldownS: p.buyback_cooldown_s,
    },
  };
}

/** Decodes Crown events from transaction logs. */
export function decodeEvents(logs: string[]): { name: string; data: any }[] {
  return logs
    .filter((l) => l.startsWith("Program data: "))
    .map((l) => {
      try {
        return coder.events.decode(l.slice("Program data: ".length));
      } catch {
        return null; // another program's event
      }
    })
    .filter((e): e is { name: string; data: any } => e !== null);
}

export function initializeIx(a: { authority: PublicKey; mint: PublicKey; devWallet: PublicKey; params: Params }) {
  const p = crownPdas(a.mint);
  return ix("initialize", { params: toIdlParams(a.params), dev_wallet: a.devWallet }, [
    [a.authority, true, true],
    [a.mint, false, false],
    [p.config, false, true],
    [p.crown, false, true],
    [p.vault, false, true],
    [p.burnBucket, false, true],
    [SystemProgram.programId, false, false],
  ]);
}

export function updateConfigIx(a: { authority: PublicKey; mint: PublicKey; devWallet: PublicKey; params: Params }) {
  return ix("update_config", { params: toIdlParams(a.params), dev_wallet: a.devWallet }, [
    [a.authority, true, false],
    [crownPdas(a.mint).config, false, true],
  ]);
}

export function lockConfigIx(a: { authority: PublicKey; mint: PublicKey }) {
  return ix("lock_config", {}, [
    [a.authority, true, false],
    [crownPdas(a.mint).config, false, true],
  ]);
}

/** `king`: the current king, or any writable account when there is none. */
export function syncFeesIx(a: { mint: PublicKey; king: PublicKey | null; devWallet: PublicKey }) {
  const p = crownPdas(a.mint);
  return ix("sync_fees", {}, [
    [p.config, false, false],
    [p.crown, false, true],
    [p.vault, false, true],
    [p.burnBucket, false, true],
    [a.king ?? p.burnBucket, false, true],
    [a.devWallet, false, true],
    [SystemProgram.programId, false, false],
  ]);
}

export function takeCrownIx(a: {
  mint: PublicKey;
  buyer: PublicKey;
  king: PublicKey | null;
  devWallet: PublicKey;
  maxPrice: bigint;
}) {
  const p = crownPdas(a.mint);
  return ix("take_crown", { max_price: bn(a.maxPrice) }, [
    [a.buyer, true, true],
    [p.config, false, false],
    [p.crown, false, true],
    [p.vault, false, true],
    [p.burnBucket, false, true],
    [a.king ?? p.burnBucket, false, true],
    [a.devWallet, false, true],
    [SYSVAR_SLOT_HASHES_PUBKEY, false, false],
    [SystemProgram.programId, false, false],
  ]);
}

export function viewPriceIx(mint: PublicKey) {
  const p = crownPdas(mint);
  return ix("view_price", {}, [
    [p.config, false, false],
    [p.crown, false, false],
  ]);
}

/** Accounts of `buyback_burn`, in program order. See `pump.ts` for a builder
 * that fills them in from chain state. */
export interface BuybackAccounts {
  mint: PublicKey;
  bucketWsol: PublicKey;
  bucketTokens: PublicKey;
  pool: PublicKey;
  ammGlobalConfig: PublicKey;
  wsolMint: PublicKey;
  poolBaseTokenAccount: PublicKey;
  poolQuoteTokenAccount: PublicKey;
  baseTokenProgram: PublicKey;
  quoteTokenProgram: PublicKey;
  userVolumeAccumulator: PublicKey;
  feeConfig: PublicKey;
  buybackFeeRecipient: PublicKey;
  ammEventAuthority: PublicKey;
  pumpAmmProgram: PublicKey;
}

export function buybackBurnIx(a: BuybackAccounts, lamports: bigint, minTokensOut: bigint) {
  const p = crownPdas(a.mint);
  return ix("buyback_burn", { lamports: bn(lamports), min_tokens_out: bn(minTokensOut) }, [
    [p.config, false, false],
    [p.crown, false, true],
    [p.burnBucket, false, true],
    [a.mint, false, true],
    [a.bucketWsol, false, true],
    [a.bucketTokens, false, true],
    [a.pool, false, true],
    [a.ammGlobalConfig, false, false],
    [a.wsolMint, false, false],
    [a.poolBaseTokenAccount, false, true],
    [a.poolQuoteTokenAccount, false, true],
    [a.baseTokenProgram, false, false],
    [a.quoteTokenProgram, false, false],
    [SystemProgram.programId, false, false],
    [a.userVolumeAccumulator, false, true],
    [a.feeConfig, false, false],
    [a.buybackFeeRecipient, false, true],
    [a.ammEventAuthority, false, false],
    [a.pumpAmmProgram, false, false],
  ]);
}
