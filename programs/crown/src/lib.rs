use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::slot_hashes;
use solana_sha256_hasher::hashv;
use anchor_lang::system_program::{self, Transfer};

pub mod math;
pub mod state;

pub use state::*;

declare_id!("43gLbVEuc1NBg5f8EqD1yL7HMmMTsAPV7Fpb8fev1Bqj");

#[program]
pub mod crown {
    use super::*;

    /// Creates Config, Crown, the fee vault and the burn bucket for `mint`.
    pub fn initialize(ctx: Context<Initialize>, params: Params, dev_wallet: Pubkey) -> Result<()> {
        params.validate()?;
        let now = Clock::get()?.unix_timestamp;

        // The vault and the burn bucket are plain system accounts at PDA
        // addresses. Fund them to rent-exempt so they exist and can receive.
        let rent_min = Rent::get()?.minimum_balance(0);
        for to in [&ctx.accounts.vault, &ctx.accounts.burn_bucket] {
            let missing = rent_min.saturating_sub(to.lamports());
            if missing > 0 {
                system_program::transfer(
                    CpiContext::new(
                        ctx.accounts.system_program.to_account_info(),
                        Transfer {
                            from: ctx.accounts.authority.to_account_info(),
                            to: to.to_account_info(),
                        },
                    ),
                    missing,
                )?;
            }
        }

        let config = &mut ctx.accounts.config;
        config.mint = ctx.accounts.mint.key();
        config.authority = Some(ctx.accounts.authority.key());
        config.dev_wallet = dev_wallet;
        config.params = params;
        config.bump = ctx.bumps.config;
        config.crown_bump = ctx.bumps.crown;
        config.vault_bump = ctx.bumps.vault;
        config.burn_bump = ctx.bumps.burn_bucket;

        let crown = &mut ctx.accounts.crown;
        crown.king = None;
        crown.checkpoint_price = params.opening_price;
        crown.checkpoint_ts = now;
        crown.melt_bps = params.melt_max_bps;
        crown.last_sync_ts = now;
        crown.reign_started_ts = now;
        Ok(())
    }

    /// Changes parameters. Only before `lock_config`.
    pub fn update_config(ctx: Context<Admin>, params: Params, dev_wallet: Pubkey) -> Result<()> {
        params.validate()?;
        let config = &mut ctx.accounts.config;
        config.params = params;
        config.dev_wallet = dev_wallet;
        Ok(())
    }

    /// Removes the authority. Irreversible: nothing can change Config after this.
    pub fn lock_config(ctx: Context<Admin>) -> Result<()> {
        ctx.accounts.config.authority = None;
        emit!(ConfigLocked { mint: ctx.accounts.config.mint });
        Ok(())
    }

    /// Pays everything in the vault to the king, updates fee speed and melt,
    /// and writes a new price checkpoint. Permissionless.
    pub fn sync_fees(ctx: Context<SyncFees>) -> Result<()> {
        let a = ctx.accounts;
        accrue(
            &a.config,
            &mut a.crown,
            &a.vault,
            &a.burn_bucket,
            &a.king,
            &a.dev_wallet,
            &a.system_program,
        )?;
        Ok(())
    }

    /// Takes the crown at the current price. Fails if that price is above
    /// `max_price`.
    pub fn take_crown<'info>(
        ctx: Context<'_, '_, '_, 'info, TakeCrown<'info>>,
        max_price: u64,
    ) -> Result<()> {
        let a = ctx.accounts;
        // Old king gets fees up to this second, and the checkpoint moves to now.
        let synced = accrue(
            &a.config,
            &mut a.crown,
            &a.vault,
            &a.burn_bucket,
            &a.king,
            &a.dev_wallet,
            &a.system_program,
        )?;
        let p = &a.config.params;
        let now = synced.now;
        let price = a.crown.checkpoint_price;
        require!(price <= max_price, CrownError::PriceAboveMax);

        let old_king = a.crown.king;
        let buyer = a.buyer.key();
        let pay = |to: &AccountInfo<'info>, lamports: u64| -> Result<()> {
            if lamports == 0 {
                return Ok(());
            }
            system_program::transfer(
                CpiContext::new(
                    a.system_program.to_account_info(),
                    Transfer { from: a.buyer.to_account_info(), to: to.clone() },
                ),
                lamports,
            )
        };

        let mut to_burn = math::bps_of(price, p.burn_bps as u32);
        let mut to_old_king = price - to_burn;
        match old_king {
            // First claim: everything is burned.
            None => {
                to_burn = price;
                to_old_king = 0;
            }
            // Self-takeover: the 90% would go from the king to the king.
            Some(k) if k == buyer => {}
            Some(_) => {
                if can_receive(&a.king, to_old_king)? {
                    pay(&a.king.to_account_info(), to_old_king)?;
                } else {
                    to_burn = price;
                    to_old_king = 0;
                }
            }
        }
        pay(&a.burn_bucket.to_account_info(), to_burn)?;

        let jump_bps = random_jump_bps(
            &a.slot_hashes,
            a.crown.takeover_count,
            &buyer,
            p.jump_min_bps,
            p.jump_max_bps,
        )?;
        let new_price = math::bps_of(price, jump_bps).max(synced.floor);

        let crown = &mut a.crown;
        let reign_secs = now.saturating_sub(crown.reign_started_ts).max(0) as u64;
        let old_reign_fees = crown.king_fees_this_reign;
        crown.king = Some(buyer);
        crown.checkpoint_price = new_price;
        crown.checkpoint_ts = now;
        crown.reign_started_ts = now;
        crown.takeover_count += 1;
        crown.king_fees_this_reign = 0;
        crown.total_burn_sol = crown.total_burn_sol.saturating_add(to_burn);

        emit!(CrownTaken {
            new_king: buyer,
            old_king,
            price_paid: price,
            to_old_king,
            to_burn,
            new_price,
            jump_bps,
            reign_secs,
            old_reign_fees,
            takeover_count: crown.takeover_count,
            ts: now,
        });
        Ok(())
    }

    /// Current price, floor, melt and fee speed, as return data. Does not
    /// count fees still sitting in the vault.
    pub fn view_price(ctx: Context<ViewPrice>) -> Result<PriceView> {
        let now = Clock::get()?.unix_timestamp;
        let p = &ctx.accounts.config.params;
        let c = &ctx.accounts.crown;
        let floor = math::floor_price(c.fast_ema, p.floor_minutes, p.min_price);
        Ok(PriceView {
            price: current_price(c, p, now, floor),
            floor,
            melt_bps: c.melt_bps,
            fast_ema: c.fast_ema,
            slow_ema: c.slow_ema,
            ts: now,
        })
    }

    /// TEST ONLY fee source: moves `lamports` from the payer into the vault,
    /// the same way pump.fun's distribute pushes lamports to it. Harmless
    /// (anyone can send SOL to the vault anyway).
    pub fn mock_drop_fees(ctx: Context<MockDropFees>, lamports: u64) -> Result<()> {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            ),
            lamports,
        )
    }
}

// ---------------------------------------------------------------- logic

struct Synced {
    now: i64,
    floor: u64,
}

/// Price at `now` from the stored checkpoint.
fn current_price(c: &Crown, p: &Params, now: i64, floor: u64) -> u64 {
    if c.king.is_none() {
        return p.opening_price.max(floor);
    }
    let secs = now.saturating_sub(c.checkpoint_ts).max(0) as u64;
    math::price_now(c.checkpoint_price, c.melt_bps, secs, floor)
}

/// True if a system transfer of `lamports` to `to` will succeed: the account
/// must end up rent-exempt and must not be executable.
fn can_receive(to: &AccountInfo, lamports: u64) -> Result<bool> {
    let min = Rent::get()?.minimum_balance(to.data_len());
    Ok(!to.executable && to.lamports().saturating_add(lamports) >= min)
}

/// The shared core of `sync_fees` and `take_crown`.
fn accrue<'info>(
    config: &Account<'info, Config>,
    crown: &mut Account<'info, Crown>,
    vault: &AccountInfo<'info>,
    burn_bucket: &AccountInfo<'info>,
    king: &AccountInfo<'info>,
    dev_wallet: &AccountInfo<'info>,
    system_program: &Program<'info, System>,
) -> Result<Synced> {
    let p = &config.params;
    let now = Clock::get()?.unix_timestamp;
    if let Some(k) = crown.king {
        require_keys_eq!(king.key(), k, CrownError::WrongKing);
    }

    // The vault only ever holds unpaid fees on top of its rent minimum.
    let delta = vault.lamports().saturating_sub(Rent::get()?.minimum_balance(0));
    let mut to_dev = math::bps_of(delta, p.dev_fee_bps as u32);
    let mut to_king = delta - to_dev;
    let mut to_burn = 0u64;

    let mint = config.mint;
    let seeds: &[&[u8]] = &[VAULT_SEED, mint.as_ref(), &[config.vault_bump]];
    let pay = |to: &AccountInfo<'info>, lamports: u64| -> Result<()> {
        if lamports == 0 {
            return Ok(());
        }
        system_program::transfer(
            CpiContext::new_with_signer(
                system_program.to_account_info(),
                Transfer { from: vault.clone(), to: to.clone() },
                &[seeds],
            ),
            lamports,
        )
    };

    // A recipient that cannot take the transfer (emptied below rent) must not
    // be able to block syncs and takeovers: its share is burned instead.
    if to_dev > 0 && !can_receive(dev_wallet, to_dev)? {
        to_burn += to_dev;
        to_dev = 0;
    }
    pay(dev_wallet, to_dev)?;

    // The EMAs track the king's share whether or not there is a king yet.
    let fee_income = to_king;
    if crown.king.is_some() && can_receive(king, to_king)? {
        pay(king, to_king)?;
    } else {
        to_burn += to_king;
        to_king = 0;
    }
    pay(burn_bucket, to_burn)?;

    // Price at this instant under the melt that was in effect until now.
    let old_floor = math::floor_price(crown.fast_ema, p.floor_minutes, p.min_price);
    let price = current_price(crown, p, now, old_floor);

    crown.pending_fees = crown.pending_fees.saturating_add(fee_income);
    let dt = now.saturating_sub(crown.last_sync_ts);
    if dt > 0 {
        let rate = math::inst_rate(crown.pending_fees, dt as u64);
        crown.fast_ema = math::ema_step(crown.fast_ema, rate, dt as u64, p.fast_half_life_s as u64);
        crown.slow_ema = math::ema_step(crown.slow_ema, rate, dt as u64, p.slow_half_life_s as u64);
        crown.pending_fees = 0;
        crown.last_sync_ts = now;
    }

    let floor = math::floor_price(crown.fast_ema, p.floor_minutes, p.min_price);
    crown.melt_bps = math::melt_bps(
        crown.fast_ema,
        crown.slow_ema,
        p.melt_min_bps,
        p.melt_base_bps,
        p.melt_max_bps,
    );
    crown.checkpoint_price = if crown.king.is_some() {
        price.max(floor)
    } else {
        p.opening_price.max(floor)
    };
    crown.checkpoint_ts = now;
    crown.king_fees_this_reign = crown.king_fees_this_reign.saturating_add(to_king);
    crown.total_fees = crown.total_fees.saturating_add(fee_income);
    crown.total_dev_fees = crown.total_dev_fees.saturating_add(to_dev);
    crown.total_burn_sol = crown.total_burn_sol.saturating_add(to_burn);

    emit!(FeesSynced {
        delta,
        to_king,
        to_dev,
        to_burn,
        fast_ema: crown.fast_ema,
        slow_ema: crown.slow_ema,
        melt_bps: crown.melt_bps,
        floor,
        price: crown.checkpoint_price,
        ts: now,
    });
    Ok(Synced { now, floor })
}

/// V1 randomness: newest slot hash + takeover count + buyer. A validator can
/// bias it slightly (SPEC 2.4).
fn random_jump_bps(
    slot_hashes: &AccountInfo,
    takeover_count: u64,
    buyer: &Pubkey,
    min: u32,
    max: u32,
) -> Result<u32> {
    let data = slot_hashes.try_borrow_data()?;
    // Layout: u64 count, then (u64 slot, [u8; 32] hash) newest first.
    let newest = data.get(8..48).unwrap_or(&[]);
    let h = hashv(&[newest, &takeover_count.to_le_bytes(), buyer.as_ref()]);
    let r = u64::from_le_bytes(h.to_bytes()[..8].try_into().unwrap());
    Ok(min + (r % (max - min + 1) as u64) as u32)
}

// ---------------------------------------------------------------- accounts

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: the pump.fun token mint; only used as a seed.
    pub mint: UncheckedAccount<'info>,
    #[account(init, payer = authority, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED, mint.key().as_ref()], bump)]
    pub config: Account<'info, Config>,
    #[account(init, payer = authority, space = 8 + Crown::INIT_SPACE, seeds = [CROWN_SEED, mint.key().as_ref()], bump)]
    pub crown: Account<'info, Crown>,
    /// CHECK: system account at a PDA; receives creator fees.
    #[account(mut, seeds = [VAULT_SEED, mint.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: system account at a PDA; holds SOL waiting for buyback-and-burn.
    #[account(mut, seeds = [BURN_SEED, mint.key().as_ref()], bump)]
    pub burn_bucket: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Admin<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED, config.mint.as_ref()],
        bump = config.bump,
        constraint = config.authority == Some(authority.key()) @ CrownError::ConfigLocked,
    )]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct SyncFees<'info> {
    #[account(seeds = [CONFIG_SEED, config.mint.as_ref()], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [CROWN_SEED, config.mint.as_ref()], bump = config.crown_bump)]
    pub crown: Account<'info, Crown>,
    /// CHECK: PDA checked by seeds.
    #[account(mut, seeds = [VAULT_SEED, config.mint.as_ref()], bump = config.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: PDA checked by seeds.
    #[account(mut, seeds = [BURN_SEED, config.mint.as_ref()], bump = config.burn_bump)]
    pub burn_bucket: UncheckedAccount<'info>,
    /// CHECK: must be `crown.king` when there is one (checked in `accrue`);
    /// ignored otherwise.
    #[account(mut)]
    pub king: UncheckedAccount<'info>,
    /// CHECK: address checked against Config.
    #[account(mut, address = config.dev_wallet)]
    pub dev_wallet: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct TakeCrown<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED, config.mint.as_ref()], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [CROWN_SEED, config.mint.as_ref()], bump = config.crown_bump)]
    pub crown: Account<'info, Crown>,
    /// CHECK: PDA checked by seeds.
    #[account(mut, seeds = [VAULT_SEED, config.mint.as_ref()], bump = config.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: PDA checked by seeds.
    #[account(mut, seeds = [BURN_SEED, config.mint.as_ref()], bump = config.burn_bump)]
    pub burn_bucket: UncheckedAccount<'info>,
    /// CHECK: the current king (checked in `accrue`); ignored on first claim.
    #[account(mut)]
    pub king: UncheckedAccount<'info>,
    /// CHECK: address checked against Config.
    #[account(mut, address = config.dev_wallet)]
    pub dev_wallet: UncheckedAccount<'info>,
    /// CHECK: address checked.
    #[account(address = slot_hashes::ID)]
    pub slot_hashes: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ViewPrice<'info> {
    #[account(seeds = [CONFIG_SEED, config.mint.as_ref()], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(seeds = [CROWN_SEED, config.mint.as_ref()], bump = config.crown_bump)]
    pub crown: Account<'info, Crown>,
}

#[derive(Accounts)]
pub struct MockDropFees<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED, config.mint.as_ref()], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// CHECK: PDA checked by seeds.
    #[account(mut, seeds = [VAULT_SEED, config.mint.as_ref()], bump = config.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

// ---------------------------------------------------------------- events

#[event]
pub struct CrownTaken {
    pub new_king: Pubkey,
    pub old_king: Option<Pubkey>,
    pub price_paid: u64,
    pub to_old_king: u64,
    pub to_burn: u64,
    pub new_price: u64,
    pub jump_bps: u32,
    pub reign_secs: u64,
    pub old_reign_fees: u64,
    pub takeover_count: u64,
    pub ts: i64,
}

#[event]
pub struct FeesSynced {
    pub delta: u64,
    pub to_king: u64,
    pub to_dev: u64,
    pub to_burn: u64,
    pub fast_ema: u64,
    pub slow_ema: u64,
    pub melt_bps: u16,
    pub floor: u64,
    pub price: u64,
    pub ts: i64,
}

#[event]
pub struct ConfigLocked {
    pub mint: Pubkey,
}

#[error_code]
pub enum CrownError {
    #[msg("Parameters out of range")]
    InvalidParams,
    #[msg("Config is locked or signer is not the authority")]
    ConfigLocked,
    #[msg("Current price is above max_price")]
    PriceAboveMax,
    #[msg("King account does not match the current king")]
    WrongKing,
}
