use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("8uDmfYPMBaiLLwfZGAnhNaDm48kx19hD8kPdiR7XiRLD");

// =============================================================================
// Constants
// =============================================================================

/// Minimum deposit: 10 USDC (USDC has 6 decimals).
pub const MIN_DEPOSIT: u64 = 10_000_000;

/// Maximum total deposit per wallet per round: 5,000 USDC.
/// Whale cap — keeps the small-depositor feel in v0.
pub const MAX_DEPOSIT_PER_WALLET: u64 = 5_000_000_000;

/// Withdraw cooldown: 24 hours in seconds.
/// User must call request_withdraw, wait 24h, then withdraw.
/// Yotta-shape trust posture — no hard lock, but enough buffer to detect anomalies.
pub const WITHDRAW_COOLDOWN: i64 = 24 * 60 * 60;

// =============================================================================
// Program
// =============================================================================

#[program]
pub mod stewfi {
    use super::*;

    // -------------------------------------------------------------------------
    // M1 — Foundation
    // -------------------------------------------------------------------------

    /// One-time admin-only setup.
    /// Creates PoolConfig PDA (singleton per usdc_mint) and the PDA-owned USDC vault.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let config = &mut ctx.accounts.pool_config;
        config.admin = ctx.accounts.admin.key();
        config.usdc_mint = ctx.accounts.usdc_mint.key();
        config.usdc_vault = ctx.accounts.usdc_vault.key();
        config.paused = false;
        config.current_round = 0;
        config.bump = ctx.bumps.pool_config;
        config.usdc_vault_bump = ctx.bumps.usdc_vault;

        msg!("StewFi initialized. Admin: {}", config.admin);
        Ok(())
    }

    // -------------------------------------------------------------------------
    // M2 — Deposit / Request-Withdraw / Withdraw
    // -------------------------------------------------------------------------

    /// Deposit USDC into the pool.
    /// First call creates the user's UserPosition; subsequent calls top it up.
    /// Bounds: amount >= MIN_DEPOSIT and cumulative <= MAX_DEPOSIT_PER_WALLET.
    /// Blocked if pool is paused OR if user already requested a withdraw.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        let pool_config = &ctx.accounts.pool_config;
        let user_position = &mut ctx.accounts.user_position;
        let clock = Clock::get()?;

        // Pool must be active
        require!(!pool_config.paused, StewfiError::PoolPaused);

        // Per-deposit minimum
        require!(amount >= MIN_DEPOSIT, StewfiError::DepositTooSmall);

        // Cumulative ceiling per wallet
        let new_total = user_position
            .amount
            .checked_add(amount)
            .ok_or(StewfiError::Overflow)?;
        require!(
            new_total <= MAX_DEPOSIT_PER_WALLET,
            StewfiError::DepositTooLarge
        );

        // Can't top up while a withdraw is pending
        require!(
            user_position.withdraw_requested_at == 0,
            StewfiError::WithdrawAlreadyRequested
        );

        // Transfer USDC: user_usdc → pool's usdc_vault
        let cpi_accounts = Transfer {
            from: ctx.accounts.user_usdc.to_account_info(),
            to: ctx.accounts.usdc_vault.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
        );
        token::transfer(cpi_ctx, amount)?;

        // Update position (idempotent: works for fresh-init or top-up)
        user_position.user = ctx.accounts.user.key();
        user_position.amount = new_total;
        if user_position.first_deposit_ts == 0 {
            user_position.first_deposit_ts = clock.unix_timestamp;
        }
        user_position.last_deposit_ts = clock.unix_timestamp;
        user_position.bump = ctx.bumps.user_position;

        Ok(())
    }

    /// Mark that the user wants to withdraw — starts the 24h cooldown timer.
    /// No funds move. Just sets withdraw_requested_at = now.
    pub fn request_withdraw(ctx: Context<RequestWithdraw>) -> Result<()> {
        let user_position = &mut ctx.accounts.user_position;
        let clock = Clock::get()?;

        require!(user_position.amount > 0, StewfiError::NoDeposit);
        require!(
            user_position.withdraw_requested_at == 0,
            StewfiError::WithdrawAlreadyRequested
        );

        user_position.withdraw_requested_at = clock.unix_timestamp;
        Ok(())
    }

    /// Execute the withdraw — requires (1) request was made, (2) 24h elapsed.
    /// Transfers full position back to user and closes the UserPosition account.
    pub fn withdraw(ctx: Context<Withdraw>) -> Result<()> {
        let pool_config = &ctx.accounts.pool_config;
        let user_position = &ctx.accounts.user_position;
        let clock = Clock::get()?;

        require!(
            user_position.withdraw_requested_at > 0,
            StewfiError::WithdrawNotRequested
        );

        let elapsed = clock
            .unix_timestamp
            .checked_sub(user_position.withdraw_requested_at)
            .ok_or(StewfiError::Overflow)?;
        require!(
            elapsed >= WITHDRAW_COOLDOWN,
            StewfiError::WithdrawCooldownActive
        );

        let amount = user_position.amount;
        require!(amount > 0, StewfiError::NoDeposit);

        // PDA-signed transfer: only the pool_config PDA can sign for the vault.
        // We construct the seed slices manually for the signer.
        let mint_key = pool_config.usdc_mint;
        let bump = pool_config.bump;
        let pool_config_seeds: &[&[u8]] = &[b"pool_config", mint_key.as_ref(), &[bump]];
        let signer_seeds: &[&[&[u8]]] = &[pool_config_seeds];

        let cpi_accounts = Transfer {
            from: ctx.accounts.usdc_vault.to_account_info(),
            to: ctx.accounts.user_usdc.to_account_info(),
            authority: ctx.accounts.pool_config.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );
        token::transfer(cpi_ctx, amount)?;

        // UserPosition closes via `close = user` constraint — rent refunded to user.
        Ok(())
    }
}

// =============================================================================
// Accounts structs (Anchor's #[derive(Accounts)] macro)
// =============================================================================

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + PoolConfig::INIT_SPACE,
        seeds = [b"pool_config", usdc_mint.key().as_ref()],
        bump,
    )]
    pub pool_config: Account<'info, PoolConfig>,

    #[account(
        init,
        payer = admin,
        seeds = [b"usdc_vault", usdc_mint.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = pool_config,
    )]
    pub usdc_vault: Account<'info, TokenAccount>,

    pub usdc_mint: Account<'info, Mint>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    /// PoolConfig — read-only here (we check `paused`, `usdc_mint`).
    #[account(
        seeds = [b"pool_config", pool_config.usdc_mint.as_ref()],
        bump = pool_config.bump,
    )]
    pub pool_config: Account<'info, PoolConfig>,

    /// UserPosition PDA: created on first deposit, updated on subsequent ones.
    /// `init_if_needed` lets a single instruction handle both — protected by our
    /// bounds checks (MAX_DEPOSIT_PER_WALLET) so reinit-style attacks can't grow
    /// the position past the cap.
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + UserPosition::INIT_SPACE,
        seeds = [b"user_position", user.key().as_ref()],
        bump,
    )]
    pub user_position: Account<'info, UserPosition>,

    /// The pool's USDC vault (PDA-owned).
    #[account(
        mut,
        seeds = [b"usdc_vault", pool_config.usdc_mint.as_ref()],
        bump = pool_config.usdc_vault_bump,
    )]
    pub usdc_vault: Account<'info, TokenAccount>,

    /// User's USDC token account. Must match the mint + be owned by user.
    #[account(
        mut,
        constraint = user_usdc.mint == pool_config.usdc_mint @ StewfiError::WrongMint,
        constraint = user_usdc.owner == user.key() @ StewfiError::WrongOwner,
    )]
    pub user_usdc: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RequestWithdraw<'info> {
    #[account(
        mut,
        seeds = [b"user_position", user.key().as_ref()],
        bump = user_position.bump,
        constraint = user_position.user == user.key() @ StewfiError::WrongOwner,
    )]
    pub user_position: Account<'info, UserPosition>,

    pub user: Signer<'info>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(
        seeds = [b"pool_config", pool_config.usdc_mint.as_ref()],
        bump = pool_config.bump,
    )]
    pub pool_config: Account<'info, PoolConfig>,

    /// UserPosition closes back to user (rent refund) on success.
    #[account(
        mut,
        close = user,
        seeds = [b"user_position", user.key().as_ref()],
        bump = user_position.bump,
        constraint = user_position.user == user.key() @ StewfiError::WrongOwner,
    )]
    pub user_position: Account<'info, UserPosition>,

    #[account(
        mut,
        seeds = [b"usdc_vault", pool_config.usdc_mint.as_ref()],
        bump = pool_config.usdc_vault_bump,
    )]
    pub usdc_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_usdc.mint == pool_config.usdc_mint @ StewfiError::WrongMint,
        constraint = user_usdc.owner == user.key() @ StewfiError::WrongOwner,
    )]
    pub user_usdc: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

// =============================================================================
// State accounts
// =============================================================================

#[account]
#[derive(InitSpace)]
pub struct PoolConfig {
    pub admin: Pubkey,
    pub usdc_mint: Pubkey,
    pub usdc_vault: Pubkey,
    pub paused: bool,
    pub current_round: u64,
    pub bump: u8,
    pub usdc_vault_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct UserPosition {
    /// Wallet owner of this position.
    pub user: Pubkey,
    /// Cumulative USDC deposited (sum of all top-ups, never paid out partially).
    pub amount: u64,
    /// First-ever deposit timestamp (for duration-weighted entries in M4).
    pub first_deposit_ts: i64,
    /// Most recent deposit/top-up timestamp.
    pub last_deposit_ts: i64,
    /// 0 if no pending withdraw; else timestamp of request_withdraw call.
    pub withdraw_requested_at: i64,
    /// Stored bump for cheap re-derivation.
    pub bump: u8,
}

// =============================================================================
// Errors
// =============================================================================

#[error_code]
pub enum StewfiError {
    #[msg("Deposit amount is below the minimum (10 USDC)")]
    DepositTooSmall,
    #[msg("Deposit would exceed the maximum per wallet (5,000 USDC)")]
    DepositTooLarge,
    #[msg("Pool is currently paused")]
    PoolPaused,
    #[msg("A withdraw has already been requested for this position")]
    WithdrawAlreadyRequested,
    #[msg("No pending withdraw request — call request_withdraw first")]
    WithdrawNotRequested,
    #[msg("24-hour cooldown has not elapsed since withdraw request")]
    WithdrawCooldownActive,
    #[msg("No active deposit on this position")]
    NoDeposit,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Token account mint does not match the pool's USDC mint")]
    WrongMint,
    #[msg("Token account is not owned by the signer")]
    WrongOwner,
}
