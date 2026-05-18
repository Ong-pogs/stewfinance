use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

declare_id!("8uDmfYPMBaiLLwfZGAnhNaDm48kx19hD8kPdiR7XiRLD");

#[program]
pub mod stewfi {
    use super::*;

    /// One-time admin-only setup.
    /// Creates the `PoolConfig` PDA (singleton per USDC mint) and a PDA-owned
    /// USDC vault that will hold every depositor's principal.
    /// After this succeeds, the pool exists and is ready to accept deposits (M2).
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let config = &mut ctx.accounts.pool_config;
        config.admin = ctx.accounts.admin.key();
        config.usdc_mint = ctx.accounts.usdc_mint.key();
        config.usdc_vault = ctx.accounts.usdc_vault.key();
        config.paused = false;
        config.current_round = 0;
        config.bump = ctx.bumps.pool_config;

        msg!("StewFi initialized. Admin: {}", config.admin);
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Accounts struct — Anchor's macro generates all the validation logic from these constraints.
// Every account this instruction touches must be declared here.
// ---------------------------------------------------------------------------
#[derive(Accounts)]
pub struct Initialize<'info> {
    /// PoolConfig PDA — singleton, derived from (program_id, "pool_config", usdc_mint).
    /// `init` = create the account, allocate space, mark this program as owner.
    /// Re-calling `initialize` on the same mint will fail (init rejects existing accounts).
    #[account(
        init,
        payer = admin,
        space = 8 + PoolConfig::INIT_SPACE,
        seeds = [b"pool_config", usdc_mint.key().as_ref()],
        bump,
    )]
    pub pool_config: Account<'info, PoolConfig>,

    /// USDC vault — a PDA-owned SPL token account. Holds all deposited USDC.
    /// Authority = pool_config PDA itself, so only this program (signing via the PDA) can move funds.
    /// No private key exists for the PDA; that's the trust-minimization property.
    #[account(
        init,
        payer = admin,
        seeds = [b"usdc_vault", usdc_mint.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = pool_config,
    )]
    pub usdc_vault: Account<'info, TokenAccount>,

    /// The USDC mint this pool accepts deposits in.
    /// On devnet this is a test mint we'll create; on mainnet it's the real USDC mint
    /// (EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v).
    pub usdc_mint: Account<'info, Mint>,

    /// Whoever calls `initialize` becomes the admin and pays the rent for both PDAs above.
    /// In production this should be a Squads multisig pubkey, not a single signer.
    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

// ---------------------------------------------------------------------------
// PoolConfig — on-chain state for the entire pool. Tracked at a known PDA so
// any client can look it up deterministically without knowing a random address.
//
// `#[account]` adds the 8-byte Anchor discriminator (prefix that identifies which
// account type this is — Anchor uses it to type-safely deserialize).
//
// `#[derive(InitSpace)]` makes Anchor compute the byte size of every field at
// compile time so we can write `space = 8 + PoolConfig::INIT_SPACE` above instead
// of hand-counting bytes.
// ---------------------------------------------------------------------------
#[account]
#[derive(InitSpace)]
pub struct PoolConfig {
    /// Admin public key — can pause, configure, eventually be a multisig.
    pub admin: Pubkey,
    /// The USDC mint this pool accepts deposits in.
    pub usdc_mint: Pubkey,
    /// The PDA-owned USDC vault that holds every depositor's principal.
    pub usdc_vault: Pubkey,
    /// Emergency pause flag — blocks deposits + draws when true.
    pub paused: bool,
    /// Round counter — increments after each weekly draw (used in M4).
    pub current_round: u64,
    /// Stored bump for cheap PDA re-derivation in later instructions.
    pub bump: u8,
}
