use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use kamino_lend::cpi::accounts as klend_accounts;
use kamino_lend::program::KaminoLending;

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

// -----------------------------------------------------------------------------
// M3 — Kamino (klend) integration constants
// -----------------------------------------------------------------------------

/// Vanilla obligation parameters (klend): tag 0, id 0.
/// Vanilla = a plain lending obligation (not Multiply/Lending/Leverage tags).
pub const KAMINO_OBLIGATION_TAG: u8 = 0;
pub const KAMINO_OBLIGATION_ID: u8 = 0;

/// `mode` arg for klend `init_obligation_farms_for_reserve`.
/// 0 = Collateral farm (the USDC reserve's collateral farm); 1 = Debt farm.
pub const KAMINO_FARM_MODE_COLLATERAL: u8 = 0;

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
        // M3 fields start zeroed: no Kamino obligation yet.
        config.kamino_obligation = Pubkey::default();
        config.kamino_deposited = 0;
        config.last_kamino_sync = 0;

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

    // -------------------------------------------------------------------------
    // M3 — Kamino (klend) yield routing
    //
    // The pool's idle USDC (held in usdc_vault) is deployed into Kamino Lend to
    // earn yield between draws. The pool_config PDA is the owner of the klend
    // obligation and PDA-signs every klend CPI.
    //
    // Refresh ordering: klend rejects deposit/withdraw against a stale reserve or
    // obligation. We use "option A" from the research spec — the OFF-CHAIN crank
    // prepends klend `refresh_reserve` + `refresh_obligation` instructions in the
    // SAME transaction, before deposit_to_kamino / withdraw_from_kamino. We do NOT
    // CPI the refreshes from inside StewFi (keeps the instruction lean on CU and
    // account count).
    //
    // Optional klend accounts (anchor-gen note): the `kamino-lend` CPI crate is
    // anchor-gen-generated and DROPS the IDL `optional` flag, so every klend
    // "optional" account is a required `AccountInfo` in the generated struct. To
    // signal "None" to klend, pass the klend PROGRAM account in that slot — klend
    // deserializes an optional account whose key == its own program id as `None`
    // (see anchor-lang `accounts/option.rs`). Callers that want to skip an
    // optional account therefore pass `klend_program` for that account.
    // -------------------------------------------------------------------------

    /// Admin-only, one-time. Stand up the pool's Kamino lending obligation.
    /// Folds two klend CPIs:
    ///   1. `init_user_metadata` — klend requires a per-owner UserMetadata PDA to
    ///      exist before an obligation can be created.
    ///   2. `init_obligation` — creates the Vanilla obligation (tag=0, id=0) owned
    ///      by the pool_config PDA.
    /// Stores the obligation pubkey into PoolConfig.
    pub fn init_kamino_obligation(ctx: Context<InitKaminoObligation>) -> Result<()> {
        let pool_config = &ctx.accounts.pool_config;

        // Caller must be admin.
        require!(
            ctx.accounts.admin.key() == pool_config.admin,
            StewfiError::Unauthorized
        );
        // Idempotency guard — only init once.
        require!(
            pool_config.kamino_obligation == Pubkey::default(),
            StewfiError::KaminoObligationAlreadyInit
        );

        // pool_config PDA signs as obligation owner.
        let mint_key = pool_config.usdc_mint;
        let bump = pool_config.bump;
        let pool_config_seeds: &[&[u8]] = &[b"pool_config", mint_key.as_ref(), &[bump]];
        let signer_seeds: &[&[&[u8]]] = &[pool_config_seeds];

        // --- 1. init_user_metadata -------------------------------------------
        let ium = klend_accounts::InitUserMetadata {
            owner: ctx.accounts.pool_config.to_account_info(),
            fee_payer: ctx.accounts.admin.to_account_info(),
            user_metadata: ctx.accounts.user_metadata.to_account_info(),
            // referrer_user_metadata is optional → pass klend program = None.
            referrer_user_metadata: ctx.accounts.klend_program.to_account_info(),
            rent: ctx.accounts.rent.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        };
        let cpi_ium = CpiContext::new_with_signer(
            ctx.accounts.klend_program.to_account_info(),
            ium,
            signer_seeds,
        );
        // user_lookup_table = default: a LUT is optional metadata for klend's UI;
        // not needed for our crank flow.
        kamino_lend::cpi::init_user_metadata(cpi_ium, Pubkey::default())?;

        // --- 2. init_obligation ----------------------------------------------
        let io = klend_accounts::InitObligation {
            obligation_owner: ctx.accounts.pool_config.to_account_info(),
            fee_payer: ctx.accounts.admin.to_account_info(),
            obligation: ctx.accounts.obligation.to_account_info(),
            lending_market: ctx.accounts.lending_market.to_account_info(),
            // Vanilla obligation: both seed accounts are the default pubkey.
            seed1_account: ctx.accounts.seed1_account.to_account_info(),
            seed2_account: ctx.accounts.seed2_account.to_account_info(),
            owner_user_metadata: ctx.accounts.user_metadata.to_account_info(),
            rent: ctx.accounts.rent.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        };
        let cpi_io = CpiContext::new_with_signer(
            ctx.accounts.klend_program.to_account_info(),
            io,
            signer_seeds,
        );
        kamino_lend::cpi::init_obligation(
            cpi_io,
            kamino_lend::typedefs::InitObligationArgs {
                tag: KAMINO_OBLIGATION_TAG,
                id: KAMINO_OBLIGATION_ID,
            },
        )?;

        // Persist the obligation address for later cranks + downstream milestones.
        let pool_config = &mut ctx.accounts.pool_config;
        pool_config.kamino_obligation = ctx.accounts.obligation.key();

        msg!(
            "Kamino obligation initialized: {}",
            pool_config.kamino_obligation
        );
        Ok(())
    }

    /// Admin-only, one-time per reserve. Create the obligation's farm-user-state
    /// for the USDC reserve's collateral farm via klend
    /// `init_obligation_farms_for_reserve`.
    ///
    /// Why this exists: the mainnet USDC reserve has a NON-default collateral farm
    /// (`reserve.farm_collateral`). klend's v2 deposit/withdraw refresh logic
    /// REQUIRES both farm accounts when the reserve has a farm — passing "None"
    /// for them fails with `FarmAccountsMissing`. So we must create the per-
    /// obligation farm-user-state once, then pass it (plus the reserve farm
    /// state) into every deposit/withdraw crank.
    ///
    /// For a FARMLESS reserve this instruction is unnecessary — callers can skip
    /// it and pass klend-program placeholders for the farm accounts instead.
    pub fn init_kamino_farm(ctx: Context<InitKaminoFarm>) -> Result<()> {
        let pool_config = &ctx.accounts.pool_config;

        require!(
            ctx.accounts.admin.key() == pool_config.admin,
            StewfiError::Unauthorized
        );
        // Obligation must already exist.
        require!(
            pool_config.kamino_obligation != Pubkey::default(),
            StewfiError::KaminoObligationNotInit
        );
        require!(
            ctx.accounts.obligation.key() == pool_config.kamino_obligation,
            StewfiError::WrongKaminoObligation
        );

        // pool_config PDA signs as obligation owner.
        let mint_key = pool_config.usdc_mint;
        let bump = pool_config.bump;
        let pool_config_seeds: &[&[u8]] = &[b"pool_config", mint_key.as_ref(), &[bump]];
        let signer_seeds: &[&[&[u8]]] = &[pool_config_seeds];

        let ix = klend_accounts::InitObligationFarmsForReserve {
            payer: ctx.accounts.admin.to_account_info(),
            owner: ctx.accounts.pool_config.to_account_info(),
            obligation: ctx.accounts.obligation.to_account_info(),
            lending_market_authority: ctx.accounts.lending_market_authority.to_account_info(),
            reserve: ctx.accounts.reserve.to_account_info(),
            reserve_farm_state: ctx.accounts.reserve_farm_state.to_account_info(),
            obligation_farm: ctx.accounts.obligation_farm_user_state.to_account_info(),
            lending_market: ctx.accounts.lending_market.to_account_info(),
            farms_program: ctx.accounts.farms_program.to_account_info(),
            rent: ctx.accounts.rent.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        };
        // NB: init_obligation_farms_for_reserve is a *klend* instruction — klend
        // then CPIs the Farms program internally. The CPI target is klend, not
        // the Farms program (the Farms program is just forwarded as an account).
        let cpi = CpiContext::new_with_signer(
            ctx.accounts.klend_program.to_account_info(),
            ix,
            signer_seeds,
        );
        kamino_lend::cpi::init_obligation_farms_for_reserve(cpi, KAMINO_FARM_MODE_COLLATERAL)?;

        msg!(
            "Kamino obligation farm initialized for reserve {}",
            ctx.accounts.reserve.key()
        );
        Ok(())
    }

    /// Permissionless crank. Move `amount` USDC from usdc_vault into Kamino Lend
    /// via klend `deposit_reserve_liquidity_and_obligation_collateral_v2`.
    ///
    /// Idle USDC starts earning. Collateral (cTokens) is booked straight into the
    /// pool obligation — StewFi does NOT need its own cToken vault for this
    /// combined deposit ix (`placeholder_user_destination_collateral` is None).
    ///
    /// Permissionless is safe: funds only move usdc_vault → klend (still owned by
    /// the pool obligation, whose owner is the pool_config PDA). A griefer cannot
    /// extract value, only deploy idle pool USDC into yield.
    ///
    /// The crank MUST prepend klend `refresh_reserve` + `refresh_obligation` in
    /// the same tx (see module docs).
    ///
    /// Farm accounts: pass the real reserve_farm_state + obligation_farm_user_state
    /// for a reserve that has a collateral farm (mainnet USDC does). For a
    /// farmless reserve, pass the klend program account for both (= None).
    pub fn deposit_to_kamino(ctx: Context<DepositToKamino>, amount: u64) -> Result<()> {
        let pool_config = &ctx.accounts.pool_config;

        require!(!pool_config.paused, StewfiError::PoolPaused);
        require!(amount > 0, StewfiError::InvalidAmount);
        require!(
            pool_config.kamino_obligation != Pubkey::default(),
            StewfiError::KaminoObligationNotInit
        );
        require!(
            ctx.accounts.obligation.key() == pool_config.kamino_obligation,
            StewfiError::WrongKaminoObligation
        );
        require!(
            ctx.accounts.usdc_vault.amount >= amount,
            StewfiError::InsufficientVaultBalance
        );

        // pool_config PDA signs as the obligation owner.
        let mint_key = pool_config.usdc_mint;
        let bump = pool_config.bump;
        let pool_config_seeds: &[&[u8]] = &[b"pool_config", mint_key.as_ref(), &[bump]];
        let signer_seeds: &[&[&[u8]]] = &[pool_config_seeds];

        let deposit_accounts =
            klend_accounts::DepositReserveLiquidityAndObligationCollateralV2DepositAccounts {
                owner: ctx.accounts.pool_config.to_account_info(),
                obligation: ctx.accounts.obligation.to_account_info(),
                lending_market: ctx.accounts.lending_market.to_account_info(),
                lending_market_authority: ctx
                    .accounts
                    .lending_market_authority
                    .to_account_info(),
                reserve: ctx.accounts.reserve.to_account_info(),
                reserve_liquidity_mint: ctx.accounts.reserve_liquidity_mint.to_account_info(),
                reserve_liquidity_supply: ctx
                    .accounts
                    .reserve_liquidity_supply
                    .to_account_info(),
                reserve_collateral_mint: ctx.accounts.reserve_collateral_mint.to_account_info(),
                reserve_destination_deposit_collateral: ctx
                    .accounts
                    .reserve_destination_deposit_collateral
                    .to_account_info(),
                user_source_liquidity: ctx.accounts.usdc_vault.to_account_info(),
                // Optional: not used by the combined ix → pass klend program (= None).
                placeholder_user_destination_collateral: ctx
                    .accounts
                    .klend_program
                    .to_account_info(),
                collateral_token_program: ctx
                    .accounts
                    .collateral_token_program
                    .to_account_info(),
                liquidity_token_program: ctx.accounts.liquidity_token_program.to_account_info(),
                instruction_sysvar_account: ctx
                    .accounts
                    .instruction_sysvar_account
                    .to_account_info(),
            };

        let farms_accounts =
            klend_accounts::DepositReserveLiquidityAndObligationCollateralV2FarmsAccounts {
                obligation_farm_user_state: ctx
                    .accounts
                    .obligation_farm_user_state
                    .to_account_info(),
                reserve_farm_state: ctx.accounts.reserve_farm_state.to_account_info(),
            };

        let cpi_accounts = klend_accounts::DepositReserveLiquidityAndObligationCollateralV2 {
            DepositReserveLiquidityAndObligationCollateralV2deposit_accounts: deposit_accounts,
            DepositReserveLiquidityAndObligationCollateralV2farms_accounts: farms_accounts,
            farms_program: ctx.accounts.farms_program.to_account_info(),
        };

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.klend_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );
        kamino_lend::cpi::deposit_reserve_liquidity_and_obligation_collateral_v2(cpi_ctx, amount)?;

        // Tracking (best-effort principal accounting for downstream milestones).
        let pool_config = &mut ctx.accounts.pool_config;
        pool_config.kamino_deposited = pool_config
            .kamino_deposited
            .checked_add(amount)
            .ok_or(StewfiError::Overflow)?;
        pool_config.last_kamino_sync = Clock::get()?.unix_timestamp;

        msg!("Deposited {} USDC to Kamino", amount);
        Ok(())
    }

    /// Permissionless crank. Redeem `collateral_amount` cTokens from Kamino back
    /// into usdc_vault via klend
    /// `withdraw_obligation_collateral_and_redeem_reserve_collateral_v2`.
    ///
    /// IMPORTANT: `collateral_amount` is in COLLATERAL (cToken) units, NOT USDC.
    /// To drain the position, read the obligation's deposited collateral amount
    /// off-chain and pass it (klend has no u64::MAX sentinel for this ix).
    ///
    /// Permissionless is safe: USDC only flows klend → usdc_vault (PDA-owned). A
    /// griefer can only move funds back into the pool's own vault, never out.
    ///
    /// The crank MUST prepend klend `refresh_reserve` + `refresh_obligation` in
    /// the same tx (see module docs). Farm-account rules match deposit_to_kamino.
    pub fn withdraw_from_kamino(
        ctx: Context<WithdrawFromKamino>,
        collateral_amount: u64,
    ) -> Result<()> {
        let pool_config = &ctx.accounts.pool_config;

        require!(collateral_amount > 0, StewfiError::InvalidAmount);
        require!(
            pool_config.kamino_obligation != Pubkey::default(),
            StewfiError::KaminoObligationNotInit
        );
        require!(
            ctx.accounts.obligation.key() == pool_config.kamino_obligation,
            StewfiError::WrongKaminoObligation
        );

        // pool_config PDA signs as the obligation owner.
        let mint_key = pool_config.usdc_mint;
        let bump = pool_config.bump;
        let pool_config_seeds: &[&[u8]] = &[b"pool_config", mint_key.as_ref(), &[bump]];
        let signer_seeds: &[&[&[u8]]] = &[pool_config_seeds];

        // Measure vault delta to update principal tracking after redeem.
        let vault_before = ctx.accounts.usdc_vault.amount;

        let withdraw_accounts =
            klend_accounts::WithdrawObligationCollateralAndRedeemReserveCollateralV2WithdrawAccounts {
                owner: ctx.accounts.pool_config.to_account_info(),
                obligation: ctx.accounts.obligation.to_account_info(),
                lending_market: ctx.accounts.lending_market.to_account_info(),
                lending_market_authority: ctx
                    .accounts
                    .lending_market_authority
                    .to_account_info(),
                withdraw_reserve: ctx.accounts.reserve.to_account_info(),
                reserve_liquidity_mint: ctx.accounts.reserve_liquidity_mint.to_account_info(),
                reserve_source_collateral: ctx
                    .accounts
                    .reserve_source_collateral
                    .to_account_info(),
                reserve_collateral_mint: ctx.accounts.reserve_collateral_mint.to_account_info(),
                reserve_liquidity_supply: ctx
                    .accounts
                    .reserve_liquidity_supply
                    .to_account_info(),
                user_destination_liquidity: ctx.accounts.usdc_vault.to_account_info(),
                // Optional: not used by the combined ix → pass klend program (= None).
                placeholder_user_destination_collateral: ctx
                    .accounts
                    .klend_program
                    .to_account_info(),
                collateral_token_program: ctx
                    .accounts
                    .collateral_token_program
                    .to_account_info(),
                liquidity_token_program: ctx.accounts.liquidity_token_program.to_account_info(),
                instruction_sysvar_account: ctx
                    .accounts
                    .instruction_sysvar_account
                    .to_account_info(),
            };

        let farms_accounts =
            klend_accounts::WithdrawObligationCollateralAndRedeemReserveCollateralV2FarmsAccounts {
                obligation_farm_user_state: ctx
                    .accounts
                    .obligation_farm_user_state
                    .to_account_info(),
                reserve_farm_state: ctx.accounts.reserve_farm_state.to_account_info(),
            };

        let cpi_accounts =
            klend_accounts::WithdrawObligationCollateralAndRedeemReserveCollateralV2 {
                WithdrawObligationCollateralAndRedeemReserveCollateralV2withdraw_accounts:
                    withdraw_accounts,
                WithdrawObligationCollateralAndRedeemReserveCollateralV2farms_accounts:
                    farms_accounts,
                farms_program: ctx.accounts.farms_program.to_account_info(),
            };

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.klend_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );
        kamino_lend::cpi::withdraw_obligation_collateral_and_redeem_reserve_collateral_v2(
            cpi_ctx,
            collateral_amount,
        )?;

        // Update principal tracking by the USDC actually received.
        ctx.accounts.usdc_vault.reload()?;
        let received = ctx
            .accounts
            .usdc_vault
            .amount
            .checked_sub(vault_before)
            .ok_or(StewfiError::Overflow)?;
        let pool_config = &mut ctx.accounts.pool_config;
        // Saturating: yield can make `received` exceed tracked principal; we never
        // want this to underflow. Principal accounting precision is refined in M4.
        pool_config.kamino_deposited = pool_config.kamino_deposited.saturating_sub(received);
        pool_config.last_kamino_sync = Clock::get()?.unix_timestamp;

        msg!(
            "Withdrew {} cTokens from Kamino ({} USDC received)",
            collateral_amount,
            received
        );
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

// -----------------------------------------------------------------------------
// M3 — Kamino account contexts
//
// klend-validated accounts are typed `UncheckedAccount` — klend enforces their
// correctness internally (has_one / address constraints on the reserve, market,
// obligation, vaults, mints). StewFi only owns the constraints that protect ITS
// invariants (admin gating, obligation == pool_config.kamino_obligation, the
// usdc_vault PDA). The klend program is typed `Program<KaminoLending>` so Anchor
// verifies it and so it can double as the "None" sentinel for optional accounts.
// -----------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitKaminoObligation<'info> {
    #[account(
        mut,
        seeds = [b"pool_config", pool_config.usdc_mint.as_ref()],
        bump = pool_config.bump,
    )]
    pub pool_config: Account<'info, PoolConfig>,

    #[account(mut)]
    pub admin: Signer<'info>,

    /// klend UserMetadata PDA `[b"user_meta", pool_config]` — created by the CPI.
    /// CHECK: validated + initialized by klend `init_user_metadata`.
    #[account(mut)]
    pub user_metadata: UncheckedAccount<'info>,

    /// klend obligation PDA — created by the CPI.
    /// CHECK: validated + initialized by klend `init_obligation`.
    #[account(mut)]
    pub obligation: UncheckedAccount<'info>,

    /// CHECK: the klend lending market; validated by klend.
    pub lending_market: UncheckedAccount<'info>,

    /// Vanilla obligation seed account #1 — must be the default pubkey.
    /// CHECK: klend derives the obligation PDA from this; we pin it to default.
    #[account(address = Pubkey::default())]
    pub seed1_account: UncheckedAccount<'info>,

    /// Vanilla obligation seed account #2 — must be the default pubkey.
    /// CHECK: klend derives the obligation PDA from this; we pin it to default.
    #[account(address = Pubkey::default())]
    pub seed2_account: UncheckedAccount<'info>,

    pub klend_program: Program<'info, KaminoLending>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct InitKaminoFarm<'info> {
    #[account(
        seeds = [b"pool_config", pool_config.usdc_mint.as_ref()],
        bump = pool_config.bump,
    )]
    pub pool_config: Account<'info, PoolConfig>,

    #[account(mut)]
    pub admin: Signer<'info>,

    /// CHECK: the pool obligation; checked == pool_config.kamino_obligation.
    #[account(mut)]
    pub obligation: UncheckedAccount<'info>,

    /// CHECK: klend market authority PDA; validated by klend.
    pub lending_market_authority: UncheckedAccount<'info>,

    /// CHECK: the USDC reserve; validated by klend.
    #[account(mut)]
    pub reserve: UncheckedAccount<'info>,

    /// CHECK: the reserve's collateral farm state; validated by klend/farms.
    #[account(mut)]
    pub reserve_farm_state: UncheckedAccount<'info>,

    /// klend obligation-farm-user-state PDA — created by the CPI.
    /// CHECK: validated + initialized by klend `init_obligation_farms_for_reserve`.
    #[account(mut)]
    pub obligation_farm_user_state: UncheckedAccount<'info>,

    /// CHECK: the klend lending market; validated by klend.
    pub lending_market: UncheckedAccount<'info>,

    /// CHECK: the Kamino Farms program; validated by klend CPI.
    pub farms_program: UncheckedAccount<'info>,

    pub klend_program: Program<'info, KaminoLending>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct DepositToKamino<'info> {
    #[account(
        mut,
        seeds = [b"pool_config", pool_config.usdc_mint.as_ref()],
        bump = pool_config.bump,
    )]
    pub pool_config: Account<'info, PoolConfig>,

    /// Anyone can crank this.
    pub crank: Signer<'info>,

    /// The pool's USDC vault (PDA-owned) = klend `user_source_liquidity`.
    #[account(
        mut,
        seeds = [b"usdc_vault", pool_config.usdc_mint.as_ref()],
        bump = pool_config.usdc_vault_bump,
    )]
    pub usdc_vault: Account<'info, TokenAccount>,

    /// CHECK: pool obligation; checked == pool_config.kamino_obligation.
    #[account(mut)]
    pub obligation: UncheckedAccount<'info>,

    /// CHECK: klend lending market; validated by klend.
    pub lending_market: UncheckedAccount<'info>,

    /// CHECK: klend market authority PDA; validated by klend.
    pub lending_market_authority: UncheckedAccount<'info>,

    /// CHECK: USDC reserve; validated by klend.
    #[account(mut)]
    pub reserve: UncheckedAccount<'info>,

    /// CHECK: reserve liquidity mint (USDC); validated by klend.
    pub reserve_liquidity_mint: UncheckedAccount<'info>,

    /// CHECK: reserve liquidity supply vault; validated by klend.
    #[account(mut)]
    pub reserve_liquidity_supply: UncheckedAccount<'info>,

    /// CHECK: reserve collateral (cToken) mint; validated by klend.
    #[account(mut)]
    pub reserve_collateral_mint: UncheckedAccount<'info>,

    /// CHECK: reserve collateral supply vault (deposit dest); validated by klend.
    #[account(mut)]
    pub reserve_destination_deposit_collateral: UncheckedAccount<'info>,

    /// CHECK: SPL Token program for collateral side; validated by klend.
    pub collateral_token_program: UncheckedAccount<'info>,

    /// CHECK: token program for the liquidity (USDC) mint; validated by klend.
    pub liquidity_token_program: UncheckedAccount<'info>,

    /// CHECK: the Instructions sysvar; validated by klend (address-checked there).
    pub instruction_sysvar_account: UncheckedAccount<'info>,

    /// CHECK: obligation farm user state, OR klend program for None (farmless).
    #[account(mut)]
    pub obligation_farm_user_state: UncheckedAccount<'info>,

    /// CHECK: reserve collateral farm state, OR klend program for None (farmless).
    #[account(mut)]
    pub reserve_farm_state: UncheckedAccount<'info>,

    /// CHECK: the Kamino Farms program; validated by klend CPI.
    pub farms_program: UncheckedAccount<'info>,

    pub klend_program: Program<'info, KaminoLending>,
}

#[derive(Accounts)]
pub struct WithdrawFromKamino<'info> {
    #[account(
        mut,
        seeds = [b"pool_config", pool_config.usdc_mint.as_ref()],
        bump = pool_config.bump,
    )]
    pub pool_config: Account<'info, PoolConfig>,

    /// Anyone can crank this.
    pub crank: Signer<'info>,

    /// The pool's USDC vault (PDA-owned) = klend `user_destination_liquidity`.
    #[account(
        mut,
        seeds = [b"usdc_vault", pool_config.usdc_mint.as_ref()],
        bump = pool_config.usdc_vault_bump,
    )]
    pub usdc_vault: Account<'info, TokenAccount>,

    /// CHECK: pool obligation; checked == pool_config.kamino_obligation.
    #[account(mut)]
    pub obligation: UncheckedAccount<'info>,

    /// CHECK: klend lending market; validated by klend.
    pub lending_market: UncheckedAccount<'info>,

    /// CHECK: klend market authority PDA; validated by klend.
    pub lending_market_authority: UncheckedAccount<'info>,

    /// CHECK: USDC reserve; validated by klend.
    #[account(mut)]
    pub reserve: UncheckedAccount<'info>,

    /// CHECK: reserve liquidity mint (USDC); validated by klend.
    pub reserve_liquidity_mint: UncheckedAccount<'info>,

    /// CHECK: reserve collateral supply vault (withdraw source); validated by klend.
    #[account(mut)]
    pub reserve_source_collateral: UncheckedAccount<'info>,

    /// CHECK: reserve collateral (cToken) mint; validated by klend.
    #[account(mut)]
    pub reserve_collateral_mint: UncheckedAccount<'info>,

    /// CHECK: reserve liquidity supply vault; validated by klend.
    #[account(mut)]
    pub reserve_liquidity_supply: UncheckedAccount<'info>,

    /// CHECK: SPL Token program for collateral side; validated by klend.
    pub collateral_token_program: UncheckedAccount<'info>,

    /// CHECK: token program for the liquidity (USDC) mint; validated by klend.
    pub liquidity_token_program: UncheckedAccount<'info>,

    /// CHECK: the Instructions sysvar; validated by klend (address-checked there).
    pub instruction_sysvar_account: UncheckedAccount<'info>,

    /// CHECK: obligation farm user state, OR klend program for None (farmless).
    #[account(mut)]
    pub obligation_farm_user_state: UncheckedAccount<'info>,

    /// CHECK: reserve collateral farm state, OR klend program for None (farmless).
    #[account(mut)]
    pub reserve_farm_state: UncheckedAccount<'info>,

    /// CHECK: the Kamino Farms program; validated by klend CPI.
    pub farms_program: UncheckedAccount<'info>,

    pub klend_program: Program<'info, KaminoLending>,
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
    // ---- M3 (Kamino) ----
    /// The pool's klend obligation. Pubkey::default() until init_kamino_obligation.
    pub kamino_obligation: Pubkey,
    /// Running principal deployed into Kamino (best-effort; refined in M4).
    pub kamino_deposited: u64,
    /// Unix ts of the last deposit_to_kamino / withdraw_from_kamino crank.
    pub last_kamino_sync: i64,
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
    // ---- M3 (Kamino) ----
    #[msg("Only the admin may call this instruction")]
    Unauthorized,
    #[msg("Kamino obligation has already been initialized")]
    KaminoObligationAlreadyInit,
    #[msg("Kamino obligation has not been initialized yet")]
    KaminoObligationNotInit,
    #[msg("Provided obligation does not match the pool's Kamino obligation")]
    WrongKaminoObligation,
    #[msg("Amount must be greater than zero")]
    InvalidAmount,
    #[msg("USDC vault balance is insufficient for this deposit")]
    InsufficientVaultBalance,
}
