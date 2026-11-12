use anchor_lang::prelude::*;

pub const CONFIG_SEED: &[u8] = b"config";
pub const CROWN_SEED: &[u8] = b"crown";
pub const VAULT_SEED: &[u8] = b"vault";
pub const BURN_SEED: &[u8] = b"burn";

/// Hard caps enforced in code, whatever the authority passes.
pub const MAX_DEV_FEE_BPS: u16 = 1_500;
pub const MAX_BURN_BPS: u16 = 5_000;
pub const MAX_MELT_BPS: u16 = 5_000;
pub const MAX_JUMP_BPS: u32 = 100_000;

/// Every tunable number. Set at `initialize`, changeable with `update_config`
/// until `lock_config`, frozen forever after.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, InitSpace, PartialEq, Eq)]
pub struct Params {
    pub jump_min_bps: u32,
    pub jump_max_bps: u32,
    pub melt_min_bps: u16,
    pub melt_base_bps: u16,
    pub melt_max_bps: u16,
    pub floor_minutes: u16,
    pub burn_bps: u16,
    /// In-program dev split of creator fees. 0 when pump.fun fee sharing
    /// already sends the dev share to `dev_wallet` (SPEC 4.5).
    pub dev_fee_bps: u16,
    pub fast_half_life_s: u32,
    pub slow_half_life_s: u32,
    /// Price of the first claim (if the floor is lower).
    pub opening_price: u64,
    /// Absolute minimum price, so the crown can never melt to zero.
    pub min_price: u64,
    /// Most SOL one `buyback_burn` call may spend.
    pub max_buyback_lamports: u64,
    /// Minimum seconds between two `buyback_burn` calls.
    pub buyback_cooldown_s: u32,
}

impl Params {
    pub fn validate(&self) -> Result<()> {
        let ok = self.jump_min_bps >= 10_000
            && self.jump_min_bps <= self.jump_max_bps
            && self.jump_max_bps <= MAX_JUMP_BPS
            && self.melt_min_bps <= self.melt_base_bps
            && self.melt_base_bps <= self.melt_max_bps
            && self.melt_max_bps <= MAX_MELT_BPS
            && self.burn_bps <= MAX_BURN_BPS
            && self.dev_fee_bps <= MAX_DEV_FEE_BPS
            && self.fast_half_life_s > 0
            && self.slow_half_life_s >= self.fast_half_life_s
            && self.min_price > 0
            && self.max_buyback_lamports > 0
            && self.opening_price >= self.min_price;
        require!(ok, crate::CrownError::InvalidParams);
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub mint: Pubkey,
    /// `None` after `lock_config`.
    pub authority: Option<Pubkey>,
    pub dev_wallet: Pubkey,
    /// The coin's canonical PumpSwap pool (exists once it graduates).
    pub pool: Pubkey,
    pub params: Params,
    pub bump: u8,
    pub crown_bump: u8,
    pub vault_bump: u8,
    pub burn_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Crown {
    pub king: Option<Pubkey>,
    pub checkpoint_price: u64,
    pub checkpoint_ts: i64,
    /// Melt in effect since the checkpoint, bps per minute.
    pub melt_bps: u16,
    /// Fee speed, lamports per minute (king's share).
    pub fast_ema: u64,
    pub slow_ema: u64,
    pub last_sync_ts: i64,
    /// Fees paid out since `last_sync_ts` that the EMAs have not seen yet
    /// (several syncs inside the same second).
    pub pending_fees: u64,
    pub reign_started_ts: i64,
    pub takeover_count: u64,
    pub king_fees_this_reign: u64,
    pub total_fees: u64,
    pub total_dev_fees: u64,
    pub total_burn_sol: u64,
    pub last_buyback_ts: i64,
    pub total_tokens_burned: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct PriceView {
    pub price: u64,
    pub floor: u64,
    pub melt_bps: u16,
    pub fast_ema: u64,
    pub slow_ema: u64,
    pub ts: i64,
}
