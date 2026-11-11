//! `buyback_burn`: the burn bucket buys the coin on PumpSwap and burns it.
//!
//! This is the only place the program calls pump.fun. Layout facts it relies
//! on (SPEC 4.4 finding 3): the `buy_exact_quote_in_v2` discriminator and its
//! 17 accounts, the canonical pool PDA seeds, and the SPL token account layout.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};
use anchor_lang::system_program::{self, Transfer};

use crate::{state::*, CrownError};

pub const PUMP_PROGRAM_ID: Pubkey = pubkey!("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
pub const PUMP_AMM_PROGRAM_ID: Pubkey = pubkey!("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
pub const WSOL_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
pub const TOKEN_PROGRAM_ID: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const TOKEN_2022_PROGRAM_ID: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

const BUY_EXACT_QUOTE_IN_V2: [u8; 8] = [194, 171, 28, 70, 104, 77, 91, 47];
const TOKEN_IX_BURN: u8 = 8;
const TOKEN_IX_SYNC_NATIVE: u8 = 17;

/// The PumpSwap pool pump.fun creates for `mint` when it graduates:
/// index 0, creator = Pump PDA `["pool-authority", mint]`, quote = wSOL.
pub fn canonical_pool(mint: &Pubkey) -> Pubkey {
    let (authority, _) =
        Pubkey::find_program_address(&[b"pool-authority", mint.as_ref()], &PUMP_PROGRAM_ID);
    Pubkey::find_program_address(
        &[b"pool", &0u16.to_le_bytes(), authority.as_ref(), mint.as_ref(), WSOL_MINT.as_ref()],
        &PUMP_AMM_PROGRAM_ID,
    )
    .0
}

/// Checks `acc` is a token account of `token_program` for `mint` owned by
/// `owner`, and returns its balance.
fn token_balance(
    acc: &AccountInfo,
    token_program: &Pubkey,
    mint: &Pubkey,
    owner: &Pubkey,
) -> Result<u64> {
    require_keys_eq!(*acc.owner, *token_program, CrownError::InvalidTokenAccount);
    let data = acc.try_borrow_data()?;
    require!(data.len() >= 72, CrownError::InvalidTokenAccount);
    require!(data[0..32] == mint.to_bytes(), CrownError::InvalidTokenAccount);
    require!(data[32..64] == owner.to_bytes(), CrownError::InvalidTokenAccount);
    Ok(u64::from_le_bytes(data[64..72].try_into().unwrap()))
}

pub fn buyback_burn(ctx: Context<BuybackBurn>, lamports: u64, min_tokens_out: u64) -> Result<()> {
    let a = ctx.accounts;
    let p = &a.config.params;
    let now = Clock::get()?.unix_timestamp;
    let bucket = a.burn_bucket.key();
    let mint = a.config.mint;

    require!(
        now.saturating_sub(a.crown.last_buyback_ts) >= p.buyback_cooldown_s as i64,
        CrownError::BuybackCooldown
    );
    require!(lamports > 0 && lamports <= p.max_buyback_lamports, CrownError::BuybackTooLarge);
    let spare = a.burn_bucket.lamports().saturating_sub(Rent::get()?.minimum_balance(0));
    require!(lamports <= spare, CrownError::BucketTooSmall);

    // The base token program is whichever one owns the mint.
    let base_program = a.base_token_program.key();
    require!(
        base_program == TOKEN_PROGRAM_ID || base_program == TOKEN_2022_PROGRAM_ID,
        CrownError::InvalidTokenAccount
    );
    require_keys_eq!(*a.mint.owner, base_program, CrownError::InvalidTokenAccount);
    token_balance(&a.bucket_wsol, &TOKEN_PROGRAM_ID, &WSOL_MINT, &bucket)?;
    token_balance(&a.bucket_tokens, &base_program, &mint, &bucket)?;

    let seeds: &[&[u8]] = &[BURN_SEED, mint.as_ref(), &[a.config.burn_bump]];

    // 1. Wrap: move SOL into the bucket's wSOL account and sync it.
    system_program::transfer(
        CpiContext::new_with_signer(
            a.system_program.to_account_info(),
            Transfer { from: a.burn_bucket.to_account_info(), to: a.bucket_wsol.to_account_info() },
            &[seeds],
        ),
        lamports,
    )?;
    invoke_signed(
        &Instruction {
            program_id: TOKEN_PROGRAM_ID,
            accounts: vec![AccountMeta::new(a.bucket_wsol.key(), false)],
            data: vec![TOKEN_IX_SYNC_NATIVE],
        },
        &[a.bucket_wsol.to_account_info()],
        &[],
    )?;
    // Includes any wSOL an earlier buy left over.
    let spend = token_balance(&a.bucket_wsol, &TOKEN_PROGRAM_ID, &WSOL_MINT, &bucket)?;

    // 2. Buy on PumpSwap. Account order is pump.fun's `buy_exact_quote_in_v2`.
    let mut data = BUY_EXACT_QUOTE_IN_V2.to_vec();
    data.extend_from_slice(&spend.to_le_bytes());
    data.extend_from_slice(&min_tokens_out.to_le_bytes());
    let metas = vec![
        AccountMeta::new(a.pool.key(), false),
        AccountMeta::new(bucket, true),
        AccountMeta::new_readonly(a.amm_global_config.key(), false),
        AccountMeta::new_readonly(a.mint.key(), false),
        AccountMeta::new_readonly(a.wsol_mint.key(), false),
        AccountMeta::new(a.bucket_tokens.key(), false),
        AccountMeta::new(a.bucket_wsol.key(), false),
        AccountMeta::new(a.pool_base_token_account.key(), false),
        AccountMeta::new(a.pool_quote_token_account.key(), false),
        AccountMeta::new_readonly(base_program, false),
        AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
        AccountMeta::new_readonly(a.system_program.key(), false),
        AccountMeta::new(a.user_volume_accumulator.key(), false),
        AccountMeta::new_readonly(a.fee_config.key(), false),
        AccountMeta::new(a.buyback_fee_recipient.key(), false),
        AccountMeta::new_readonly(a.amm_event_authority.key(), false),
        AccountMeta::new_readonly(PUMP_AMM_PROGRAM_ID, false),
    ];
    invoke_signed(
        &Instruction { program_id: PUMP_AMM_PROGRAM_ID, accounts: metas, data },
        &[
            a.pool.to_account_info(),
            a.burn_bucket.to_account_info(),
            a.amm_global_config.to_account_info(),
            a.mint.to_account_info(),
            a.wsol_mint.to_account_info(),
            a.bucket_tokens.to_account_info(),
            a.bucket_wsol.to_account_info(),
            a.pool_base_token_account.to_account_info(),
            a.pool_quote_token_account.to_account_info(),
            a.base_token_program.to_account_info(),
            a.quote_token_program.to_account_info(),
            a.system_program.to_account_info(),
            a.user_volume_accumulator.to_account_info(),
            a.fee_config.to_account_info(),
            a.buyback_fee_recipient.to_account_info(),
            a.amm_event_authority.to_account_info(),
            a.pump_amm_program.to_account_info(),
        ],
        &[seeds],
    )?;

    // 3. Burn everything the bucket holds.
    let tokens = token_balance(&a.bucket_tokens, &base_program, &mint, &bucket)?;
    require!(tokens >= min_tokens_out && tokens > 0, CrownError::BuybackTooFewTokens);
    let mut burn = vec![TOKEN_IX_BURN];
    burn.extend_from_slice(&tokens.to_le_bytes());
    invoke_signed(
        &Instruction {
            program_id: base_program,
            accounts: vec![
                AccountMeta::new(a.bucket_tokens.key(), false),
                AccountMeta::new(a.mint.key(), false),
                AccountMeta::new_readonly(bucket, true),
            ],
            data: burn,
        },
        &[
            a.bucket_tokens.to_account_info(),
            a.mint.to_account_info(),
            a.burn_bucket.to_account_info(),
        ],
        &[seeds],
    )?;

    let crown = &mut a.crown;
    crown.last_buyback_ts = now;
    crown.total_tokens_burned = crown.total_tokens_burned.saturating_add(tokens);
    emit!(Burned { sol_in: lamports, tokens_burned: tokens, ts: now });
    Ok(())
}

#[derive(Accounts)]
pub struct BuybackBurn<'info> {
    #[account(seeds = [CONFIG_SEED, config.mint.as_ref()], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [CROWN_SEED, config.mint.as_ref()], bump = config.crown_bump)]
    pub crown: Account<'info, Crown>,
    /// CHECK: PDA checked by seeds; signs the swap and the burn.
    #[account(mut, seeds = [BURN_SEED, config.mint.as_ref()], bump = config.burn_bump)]
    pub burn_bucket: UncheckedAccount<'info>,
    /// CHECK: the coin's mint.
    #[account(mut, address = config.mint)]
    pub mint: UncheckedAccount<'info>,
    /// CHECK: bucket's wSOL token account (checked in the handler).
    #[account(mut)]
    pub bucket_wsol: UncheckedAccount<'info>,
    /// CHECK: bucket's token account for the coin (checked in the handler).
    #[account(mut)]
    pub bucket_tokens: UncheckedAccount<'info>,
    /// CHECK: must be the canonical pool stored at `initialize`. Without this
    /// a caller could route the bucket's SOL into a pool of their own.
    #[account(mut, address = config.pool @ CrownError::WrongPool)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: validated by PumpSwap.
    pub amm_global_config: UncheckedAccount<'info>,
    /// CHECK: address checked.
    #[account(address = WSOL_MINT)]
    pub wsol_mint: UncheckedAccount<'info>,
    /// CHECK: validated by PumpSwap against the pool.
    #[account(mut)]
    pub pool_base_token_account: UncheckedAccount<'info>,
    /// CHECK: validated by PumpSwap against the pool.
    #[account(mut)]
    pub pool_quote_token_account: UncheckedAccount<'info>,
    /// CHECK: must own the mint (checked in the handler).
    pub base_token_program: UncheckedAccount<'info>,
    /// CHECK: address checked.
    #[account(address = TOKEN_PROGRAM_ID)]
    pub quote_token_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: validated by PumpSwap.
    #[account(mut)]
    pub user_volume_accumulator: UncheckedAccount<'info>,
    /// CHECK: validated by PumpSwap.
    pub fee_config: UncheckedAccount<'info>,
    /// CHECK: validated by PumpSwap.
    #[account(mut)]
    pub buyback_fee_recipient: UncheckedAccount<'info>,
    /// CHECK: validated by PumpSwap.
    pub amm_event_authority: UncheckedAccount<'info>,
    /// CHECK: address checked.
    #[account(address = PUMP_AMM_PROGRAM_ID)]
    pub pump_amm_program: UncheckedAccount<'info>,
}

#[event]
pub struct Burned {
    pub sol_in: u64,
    pub tokens_burned: u64,
    pub ts: i64,
}
