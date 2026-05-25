use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use kamino_lend::cpi::accounts as klend_accounts;
use kamino_lend::program::KaminoLending;
use switchboard_on_demand::accounts::RandomnessAccountData;

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

// -----------------------------------------------------------------------------
// M4 — DRAW (Switchboard VRF + weighted winner + prize split) constants
// -----------------------------------------------------------------------------

/// Weekly draw cadence: 7 days in seconds. The crank can only trigger a draw
/// once `pool_config.next_draw_ts` is reached.
pub const DRAW_INTERVAL: i64 = 7 * 24 * 60 * 60;

/// Prize split — founder's locked numbers (sum = 100%). Expressed as basis
/// points out of 10,000. Winner gets the remainder (65% + any rounding dust) so
/// no lamports are ever lost.
pub const GROWING_POT_BPS: u64 = 2_000; // 20% → growing_pot_vault (M5 sweeps)
pub const OPERATOR_BPS: u64 = 1_000; // 10% → operator_vault
pub const OPS_BPS: u64 = 500; //  5% → ops_vault
// Winner = prize − growing_pot − operator − ops  (≈ 65% + dust)
pub const BPS_DENOMINATOR: u64 = 10_000;

/// Switchboard On-Demand program id (mainnet). `RandomnessAccountData::owner()`
/// resolves to this at runtime unless the `devnet` feature / `SB_ENV=devnet` is
/// set (StewFi enables neither), so this is the owner we expect even on a
/// surfpool mainnet fork. Used as a defense-in-depth owner check in trigger_draw.
pub const SWITCHBOARD_ON_DEMAND_PID: Pubkey =
    pubkey!("SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv");

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
        // M4 fields start zeroed: no principal, no draw, no operator/ops wired.
        config.total_principal = 0;
        config.sum_amount = 0;
        config.sum_amount_first_ts = 0;
        config.draw_in_progress = false;
        config.operator = Pubkey::default();
        config.ops = Pubkey::default();
        config.draw_interval = DRAW_INTERVAL;
        config.next_draw_ts = 0;
        config.draw_accounts_ready = false;

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

        // Weight set must be frozen during a draw's commit→reveal window (M4).
        require!(!pool_config.draw_in_progress, StewfiError::DrawInProgress);

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

        // --- M4 trustless-winner accumulators -------------------------------
        // Maintain on-chain running sums so settle_draw can compute the GLOBAL
        // total_weight without iterating every UserPosition:
        //   total_weight = draw_ts * Σamount − Σ(amount * first_deposit_ts)
        // We track S1 = Σ position.amount and S2 = Σ(position.amount * first_ts).
        // On a top-up only the NEW slice (`amount`) is added, using the
        // position's STICKY first_deposit_ts — so both sums always equal a full
        // re-sum over live positions (first_deposit_ts never changes on top-up).
        let first_ts = user_position.first_deposit_ts;
        let pool_config = &mut ctx.accounts.pool_config;
        pool_config.total_principal = pool_config
            .total_principal
            .checked_add(amount)
            .ok_or(StewfiError::Overflow)?;
        pool_config.sum_amount = pool_config
            .sum_amount
            .checked_add(amount as u128)
            .ok_or(StewfiError::Overflow)?;
        pool_config.sum_amount_first_ts = pool_config
            .sum_amount_first_ts
            .checked_add((amount as u128).checked_mul(first_ts as u128).ok_or(StewfiError::Overflow)?)
            .ok_or(StewfiError::Overflow)?;

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

        // Weight set must be frozen during a draw's commit→reveal window (M4).
        require!(!pool_config.draw_in_progress, StewfiError::DrawInProgress);

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

        // Capture the position's accumulator contribution before it closes.
        let first_ts = user_position.first_deposit_ts;

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

        // --- M4 trustless-winner accumulators -------------------------------
        // Withdraw closes the WHOLE position, so subtract its full contribution
        // from the running sums (the mirror of deposit's add). saturating_sub on
        // the two u128 sums as belt-and-suspenders against any tracking drift —
        // total_principal uses checked_sub since it must stay exact for the prize.
        let pool_config = &mut ctx.accounts.pool_config;
        pool_config.total_principal = pool_config
            .total_principal
            .checked_sub(amount)
            .ok_or(StewfiError::Overflow)?;
        pool_config.sum_amount = pool_config.sum_amount.saturating_sub(amount as u128);
        pool_config.sum_amount_first_ts = pool_config
            .sum_amount_first_ts
            .saturating_sub((amount as u128).saturating_mul(first_ts as u128));

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

    // -------------------------------------------------------------------------
    // M4 — The Weekly DRAW
    //
    // Flow (per .superstack/m4-research.md):
    //   init_draw_accounts (admin, once)  -> create growing_pot/operator/ops
    //                                         vaults, set operator+ops pubkeys,
    //                                         create round-0 Draw, arm cadence.
    //   trigger_draw (operator)           -> atomic w/ switchboard commitIx;
    //                                         snapshot prize + total_weight, lock
    //                                         deposits, record randomness acct.
    //   settle_draw  (operator)           -> atomic w/ switchboard revealIx;
    //                                         slot-bound get_value, TRUSTLESS
    //                                         winner verify, split 65/20/10/5,
    //                                         advance round, unlock deposits.
    //   claim_draw   (winner)             -> winner pulls their 65%.
    //   cancel_draw  (admin)              -> stuck-oracle escape: unlock, reset.
    //
    // Trust model: FULLY TRUSTLESS WINNER. Two on-chain guarantees combine:
    //   (1) total_weight is recomputed ON-CHAIN at commit from
    //       pool_config.{sum_amount, sum_amount_first_ts} (maintained in
    //       deposit/withdraw) — never trusted from the crank.
    //   (2) The winning POSITION is DERIVED ON-CHAIN at settle by iterating every
    //       live UserPosition (passed via remaining_accounts) in canonical order,
    //       accumulating the real cumulative weights, and proving the set is
    //       complete (Σweight == total_weight). The crank supplies no cum_start
    //       and cannot steer the winner. See settle_draw.
    // The only residual trust is Switchboard VRF (unpredictable value, committed
    // before reveal) + Solana itself. Operator-gating remains as cadence control
    // (defense-in-depth), but is NOT the integrity mechanism.
    // -------------------------------------------------------------------------

    /// Admin-only setter for `paused` (fixes audit F-02: `paused` had no setter).
    pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
        let pool_config = &mut ctx.accounts.pool_config;
        require!(
            ctx.accounts.admin.key() == pool_config.admin,
            StewfiError::Unauthorized
        );
        pool_config.paused = paused;
        msg!("Pool paused = {}", paused);
        Ok(())
    }

    /// Admin-only, one-time. Stand up the M4 draw infrastructure:
    ///   - growing_pot_vault / operator_vault / ops_vault (PDA-owned USDC accts)
    ///   - record operator + ops payout pubkeys
    ///   - create the round-0 `Draw` (status Pending, accepting deposits)
    ///   - arm the weekly cadence (`next_draw_ts = now + draw_interval`)
    ///
    /// Kept separate from M1 `initialize` so M1's tested account list is untouched.
    pub fn init_draw_accounts(
        ctx: Context<InitDrawAccounts>,
        operator: Pubkey,
        ops: Pubkey,
    ) -> Result<()> {
        let pool_config = &ctx.accounts.pool_config;
        require!(
            ctx.accounts.admin.key() == pool_config.admin,
            StewfiError::Unauthorized
        );
        require!(
            !pool_config.draw_accounts_ready,
            StewfiError::DrawAccountsAlreadyInit
        );
        require!(
            pool_config.current_round == 0,
            StewfiError::DrawAccountsAlreadyInit
        );

        let clock = Clock::get()?;

        // Round-0 Draw — the steady state that accepts deposits until triggered.
        let draw = &mut ctx.accounts.current_draw;
        draw.round = 0;
        draw.status = DrawStatus::Pending;
        draw.randomness_account = Pubkey::default();
        draw.draw_ts = 0;
        draw.total_weight = 0;
        draw.prize_pool = 0;
        draw.random_value = [0u8; 32];
        draw.winner = Pubkey::default();
        draw.winner_amount = 0;
        draw.growing_pot_amount = 0;
        draw.operator_amount = 0;
        draw.ops_amount = 0;
        draw.winner_claimed = false;
        draw.bump = ctx.bumps.current_draw;

        let pool_config = &mut ctx.accounts.pool_config;
        pool_config.operator = operator;
        pool_config.ops = ops;
        pool_config.growing_pot_vault_bump = ctx.bumps.growing_pot_vault;
        pool_config.operator_vault_bump = ctx.bumps.operator_vault;
        pool_config.ops_vault_bump = ctx.bumps.ops_vault;
        pool_config.next_draw_ts = clock
            .unix_timestamp
            .checked_add(pool_config.draw_interval)
            .ok_or(StewfiError::Overflow)?;
        pool_config.draw_accounts_ready = true;

        msg!(
            "Draw accounts ready. operator={}, ops={}, next_draw_ts={}",
            operator,
            ops,
            pool_config.next_draw_ts
        );
        Ok(())
    }

    /// Operator-gated. Commit the current round to a Switchboard randomness
    /// account and lock the weight set. The crank PREPENDS the Switchboard
    /// `commitIx` in the SAME tx (StewFi does not CPI Switchboard); this ix only
    /// records the randomness account, snapshots the prize + global total_weight,
    /// and flips the round to Committed.
    ///
    /// Snapshotting here (not at settle) pins `draw_ts` and `total_weight` to the
    /// commit moment, so the off-chain crank and on-chain settle use identical
    /// numbers for the winner-window check (see m4-research §9 gotcha-11).
    pub fn trigger_draw(ctx: Context<TriggerDraw>) -> Result<()> {
        let pool_config = &ctx.accounts.pool_config;
        let clock = Clock::get()?;

        require!(!pool_config.paused, StewfiError::PoolPaused);
        require!(
            pool_config.draw_accounts_ready,
            StewfiError::DrawAccountsNotInit
        );
        // Operator-gated (admin or the configured operator may trigger).
        require!(
            ctx.accounts.crank.key() == pool_config.operator
                || ctx.accounts.crank.key() == pool_config.admin,
            StewfiError::Unauthorized
        );
        // Weekly cadence gate.
        require!(
            clock.unix_timestamp >= pool_config.next_draw_ts,
            StewfiError::DrawNotReady
        );
        // Can't start a draw while one is mid-flight.
        require!(!pool_config.draw_in_progress, StewfiError::DrawInProgress);

        // Compute the GLOBAL total_weight ON-CHAIN from the running accumulators:
        //   total_weight = draw_ts * Σamount − Σ(amount * first_deposit_ts)
        let draw_ts = clock.unix_timestamp;
        let total_weight = (draw_ts as u128)
            .checked_mul(pool_config.sum_amount)
            .ok_or(StewfiError::Overflow)?
            .checked_sub(pool_config.sum_amount_first_ts)
            .ok_or(StewfiError::Overflow)?;
        require!(total_weight > 0, StewfiError::NoEntries);

        // Snapshot the prize: usdc_vault minus principal minus prizes still owed
        // to past unclaimed winners (those sit in usdc_vault until claim_draw).
        // The crank must fully harvest Kamino into usdc_vault before triggering.
        let vault_amount = ctx.accounts.usdc_vault.amount;
        let owed = pool_config
            .total_principal
            .checked_add(pool_config.pending_winnings)
            .ok_or(StewfiError::Overflow)?;
        require!(vault_amount >= owed, StewfiError::FundsStillInKamino);
        let prize = vault_amount
            .checked_sub(owed)
            .ok_or(StewfiError::Overflow)?;
        require!(prize > 0, StewfiError::NothingToDraw);

        // Validate the randomness account is a real, un-revealed On-Demand acct.
        require!(
            *ctx.accounts.randomness_account.owner == SWITCHBOARD_ON_DEMAND_PID,
            StewfiError::InvalidRandomnessAccount
        );
        let randomness_data =
            RandomnessAccountData::parse(ctx.accounts.randomness_account.data.borrow())
                .map_err(|_| StewfiError::InvalidRandomnessAccount)?;
        // Single-use: reject an already-revealed (replayed) randomness account.
        require!(
            randomness_data.reveal_slot == 0,
            StewfiError::RandomnessAlreadyRevealed
        );

        // Record + lock.
        let draw = &mut ctx.accounts.current_draw;
        require!(
            draw.status == DrawStatus::Pending,
            StewfiError::InvalidDrawStatus
        );
        draw.randomness_account = ctx.accounts.randomness_account.key();
        draw.draw_ts = draw_ts;
        draw.total_weight = total_weight;
        draw.prize_pool = prize;
        draw.status = DrawStatus::Committed;

        let pool_config = &mut ctx.accounts.pool_config;
        pool_config.draw_in_progress = true;

        msg!(
            "Draw committed for round {}. prize={} total_weight={} draw_ts={}",
            draw.round,
            prize,
            total_weight,
            draw_ts
        );
        Ok(())
    }

    /// Operator-gated. Atomic with the Switchboard `revealIx` (same tx). Reads
    /// the revealed value slot-bound (`get_value(clock.slot)`), determines the
    /// winner FULLY ON-CHAIN by iterating every live position, splits the prize
    /// 65/20/10/5, advances the round, and unlocks deposits.
    ///
    /// remaining_accounts: ALL live `UserPosition`s for the pool, in CANONICAL
    /// order — ascending by `user` pubkey. The crank passes them; the program
    /// does NOT trust their order or completeness blindly — it verifies both.
    ///
    /// Trustless verify (the winner is DERIVED, not supplied):
    ///   1. ticket `t = u128(value[0..16]) % draw.total_weight` (total_weight is
    ///      the on-chain accumulator snapshot from commit — not a crank input).
    ///   2. Iterate remaining_accounts: each must be a real `UserPosition` owned
    ///      by THIS program (Account::try_from checks owner + discriminator), at
    ///      its canonical PDA `[b"user_position", user]`, in STRICTLY ascending
    ///      `user` order (rejects dups / reorderings / omissions of ordering).
    ///      Accumulate `running_weight += amount × (draw_ts − first_deposit_ts)`
    ///      and track each position's `[cum_before, cum_before + weight)` window.
    ///   3. COMPLETENESS: `running_weight == draw.total_weight`. Because
    ///      draw_in_progress froze the weight set at commit, the live positions
    ///      ARE the accumulator's set — so equality proves the passed set is
    ///      exactly that set (operator can't omit/add/reorder).
    ///   4. The winner is the position whose window contains `t`; require the
    ///      passed `winner_position` == that derived winner.
    /// There is no `winner_cum_start` input to forge: the cumulative offset is
    /// computed on-chain from the real positions. A malicious operator cannot
    /// steer the win — the only freedom (the VRF value) is committed before the
    /// reveal, and Switchboard guarantees it's unpredictable at commit time.
    pub fn settle_draw<'info>(
        ctx: Context<'_, '_, 'info, 'info, SettleDraw<'info>>,
    ) -> Result<()> {
        let pool_config = &ctx.accounts.pool_config;
        let clock = Clock::get()?;

        // Operator-gating stays as defense-in-depth (cadence control), but it is
        // NO LONGER the integrity mechanism — the on-chain winner derivation is.
        require!(
            ctx.accounts.crank.key() == pool_config.operator
                || ctx.accounts.crank.key() == pool_config.admin,
            StewfiError::Unauthorized
        );
        require!(pool_config.draw_in_progress, StewfiError::InvalidDrawStatus);

        let draw = &ctx.accounts.current_draw;
        require!(
            draw.status == DrawStatus::Committed,
            StewfiError::InvalidDrawStatus
        );
        // The randomness account must be the one committed for this round.
        require!(
            ctx.accounts.randomness_account.key() == draw.randomness_account,
            StewfiError::InvalidRandomnessAccount
        );

        // --- read the revealed value, slot-bound (secure) -------------------
        let value = {
            let randomness_data =
                RandomnessAccountData::parse(ctx.accounts.randomness_account.data.borrow())
                    .map_err(|_| StewfiError::InvalidRandomnessAccount)?;
            // get_value returns the bytes IFF clock.slot == reveal_slot; the
            // crank bundles revealIx in this same tx so the slots match.
            randomness_data
                .get_value(clock.slot)
                .map_err(|_| StewfiError::RandomnessNotResolved)?
        };

        // --- trustless winner DERIVATION (on-chain, over real positions) ----
        let total_weight = draw.total_weight;
        require!(total_weight > 0, StewfiError::NoEntries);
        // ticket is always < total_weight (modulo total_weight, which is > 0), so
        // a complete position set always contains exactly one winning window.
        let ticket = u128::from_le_bytes(
            value[0..16]
                .try_into()
                .map_err(|_| StewfiError::BadWinnerProof)?,
        ) % total_weight;
        let draw_ts = draw.draw_ts;
        let expected_winner = ctx.accounts.winner_position.key();
        let program_id = ctx.program_id;

        let mut running_weight: u128 = 0;
        let mut last_user: Option<Pubkey> = None;
        let mut derived_winner: Option<Pubkey> = None;

        // Iterate ALL live positions, in canonical ascending-`user` order.
        for info in ctx.remaining_accounts.iter() {
            // (a) Real UserPosition owned by this program (owner + 8-byte
            //     discriminator checked) — rejects spoofed / foreign accounts.
            let position: Account<UserPosition> = Account::try_from(info)
                .map_err(|_| StewfiError::BadPositionAccount)?;

            // (b) Canonical PDA: the account must live at [b"user_position", user]
            //     with its own stored bump — pins `user` to the real address so a
            //     forged `user` field can't sneak in.
            let expected_pda = Pubkey::create_program_address(
                &[b"user_position", position.user.as_ref(), &[position.bump]],
                program_id,
            )
            .map_err(|_| StewfiError::BadPositionAccount)?;
            require!(
                info.key() == expected_pda,
                StewfiError::BadPositionAccount
            );

            // (c) Strictly ascending `user` — rejects duplicates AND fixes a
            //     single canonical ordering both crank and chain agree on.
            if let Some(prev) = last_user {
                require!(position.user > prev, StewfiError::PositionsNotSorted);
            }
            last_user = Some(position.user);

            // (d) On-chain window: weight = amount × seconds_held. A position
            //     deposited at exactly draw_ts (or, defensively, "after") has
            //     seconds_held <= 0 → weight 0 → empty window, can't win.
            let seconds_held = draw_ts.saturating_sub(position.first_deposit_ts);
            let weight: u128 = if seconds_held > 0 {
                (position.amount as u128)
                    .checked_mul(seconds_held as u128)
                    .ok_or(StewfiError::Overflow)?
            } else {
                0
            };

            let cum_before = running_weight;
            running_weight = running_weight
                .checked_add(weight)
                .ok_or(StewfiError::Overflow)?;

            // The winner is the position whose window [cum_before, cum_before+weight)
            // contains the ticket. weight==0 windows are empty and never match.
            if weight > 0 && cum_before <= ticket && ticket < running_weight {
                // At most one window can contain the ticket (windows are disjoint
                // and contiguous); record it. Don't break — we must finish the
                // loop to prove completeness via the running_weight total below.
                derived_winner = Some(position.key());
            }
        }

        // COMPLETENESS: the summed weight of the passed set must equal the
        // on-chain total_weight snapshotted at commit. Since draw_in_progress
        // froze deposits/withdraws since commit, the live set == the accumulator
        // set, so equality proves the passed set is EXACTLY that set — the
        // operator cannot omit a position (sum falls short), inject a fake one
        // (try_from / PDA check rejects it), or reorder it (ascending check).
        require!(
            running_weight == total_weight,
            StewfiError::IncompletePositionSet
        );

        // The derived winner must exist (guaranteed when the set is complete and
        // total_weight > 0) and must equal the passed winner_position account.
        let derived_winner = derived_winner.ok_or(StewfiError::BadWinnerProof)?;
        require!(
            derived_winner == expected_winner,
            StewfiError::BadWinnerProof
        );

        // --- prize split (dust → winner; see m4-research §8) ----------------
        let prize = draw.prize_pool;
        let growing_pot = mul_div_bps(prize, GROWING_POT_BPS)?;
        let operator_cut = mul_div_bps(prize, OPERATOR_BPS)?;
        let ops_cut = mul_div_bps(prize, OPS_BPS)?;
        let winner_amount = prize
            .checked_sub(growing_pot)
            .and_then(|v| v.checked_sub(operator_cut))
            .and_then(|v| v.checked_sub(ops_cut))
            .ok_or(StewfiError::Overflow)?;

        // PDA-signed transfers from usdc_vault (authority = pool_config).
        let mint_key = pool_config.usdc_mint;
        let bump = pool_config.bump;
        let pool_config_seeds: &[&[u8]] = &[b"pool_config", mint_key.as_ref(), &[bump]];
        let signer_seeds: &[&[&[u8]]] = &[pool_config_seeds];

        transfer_from_vault(
            &ctx.accounts.token_program,
            ctx.accounts.usdc_vault.to_account_info(),
            ctx.accounts.growing_pot_vault.to_account_info(),
            ctx.accounts.pool_config.to_account_info(),
            signer_seeds,
            growing_pot,
        )?;
        transfer_from_vault(
            &ctx.accounts.token_program,
            ctx.accounts.usdc_vault.to_account_info(),
            ctx.accounts.operator_vault.to_account_info(),
            ctx.accounts.pool_config.to_account_info(),
            signer_seeds,
            operator_cut,
        )?;
        transfer_from_vault(
            &ctx.accounts.token_program,
            ctx.accounts.usdc_vault.to_account_info(),
            ctx.accounts.ops_vault.to_account_info(),
            ctx.accounts.pool_config.to_account_info(),
            signer_seeds,
            ops_cut,
        )?;
        // Winner's 65% stays in usdc_vault, recorded for a later claim_draw.

        // --- record outcome + advance round ---------------------------------
        let winner_pubkey = ctx.accounts.winner_position.user;
        let draw = &mut ctx.accounts.current_draw;
        draw.random_value = value;
        draw.winner = winner_pubkey;
        draw.winner_amount = winner_amount;
        draw.growing_pot_amount = growing_pot;
        draw.operator_amount = operator_cut;
        draw.ops_amount = ops_cut;
        draw.status = DrawStatus::Settled;

        let next_round = ctx
            .accounts
            .current_draw
            .round
            .checked_add(1)
            .ok_or(StewfiError::Overflow)?;

        // Initialize the next round's Draw (Pending, accepting deposits).
        let next_draw = &mut ctx.accounts.next_draw;
        next_draw.round = next_round;
        next_draw.status = DrawStatus::Pending;
        next_draw.randomness_account = Pubkey::default();
        next_draw.draw_ts = 0;
        next_draw.total_weight = 0;
        next_draw.prize_pool = 0;
        next_draw.random_value = [0u8; 32];
        next_draw.winner = Pubkey::default();
        next_draw.winner_amount = 0;
        next_draw.growing_pot_amount = 0;
        next_draw.operator_amount = 0;
        next_draw.ops_amount = 0;
        next_draw.winner_claimed = false;
        next_draw.bump = ctx.bumps.next_draw;

        let pool_config = &mut ctx.accounts.pool_config;
        pool_config.current_round = next_round;
        pool_config.draw_in_progress = false;
        pool_config.pending_winnings = pool_config
            .pending_winnings
            .checked_add(winner_amount)
            .ok_or(StewfiError::Overflow)?;
        pool_config.next_draw_ts = clock
            .unix_timestamp
            .checked_add(pool_config.draw_interval)
            .ok_or(StewfiError::Overflow)?;

        msg!(
            "Draw round {} settled. winner={} prize={} (winner {} / pot {} / op {} / ops {})",
            next_round - 1,
            winner_pubkey,
            prize,
            winner_amount,
            growing_pot,
            operator_cut,
            ops_cut
        );
        Ok(())
    }

    /// Winner pulls their 65%. The prize was held in usdc_vault since settle.
    pub fn claim_draw(ctx: Context<ClaimDraw>, _round: u64) -> Result<()> {
        let pool_config = &ctx.accounts.pool_config;
        let draw = &ctx.accounts.draw;
        let amount = draw.winner_amount;
        require!(amount > 0, StewfiError::NothingToDraw);

        let mint_key = pool_config.usdc_mint;
        let bump = pool_config.bump;
        let pool_config_seeds: &[&[u8]] = &[b"pool_config", mint_key.as_ref(), &[bump]];
        let signer_seeds: &[&[&[u8]]] = &[pool_config_seeds];

        let cpi_accounts = Transfer {
            from: ctx.accounts.usdc_vault.to_account_info(),
            to: ctx.accounts.winner_usdc.to_account_info(),
            authority: ctx.accounts.pool_config.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );
        token::transfer(cpi_ctx, amount)?;

        let draw = &mut ctx.accounts.draw;
        draw.winner_claimed = true;
        draw.status = DrawStatus::Claimed;

        let pool_config = &mut ctx.accounts.pool_config;
        pool_config.pending_winnings = pool_config.pending_winnings.saturating_sub(amount);

        msg!(
            "Winner {} claimed {} USDC from round {}",
            ctx.accounts.winner.key(),
            amount,
            draw.round
        );
        Ok(())
    }

    /// Admin escape hatch if the oracle never reveals: unlock deposits and reset
    /// the current round back to Pending so a fresh randomness account can be
    /// committed. No funds move (nothing was distributed yet).
    pub fn cancel_draw(ctx: Context<CancelDraw>) -> Result<()> {
        let pool_config = &ctx.accounts.pool_config;
        require!(
            ctx.accounts.admin.key() == pool_config.admin,
            StewfiError::Unauthorized
        );
        require!(pool_config.draw_in_progress, StewfiError::InvalidDrawStatus);

        let draw = &mut ctx.accounts.current_draw;
        require!(
            draw.status == DrawStatus::Committed,
            StewfiError::InvalidDrawStatus
        );
        draw.status = DrawStatus::Pending;
        draw.randomness_account = Pubkey::default();
        draw.draw_ts = 0;
        draw.total_weight = 0;
        draw.prize_pool = 0;

        let pool_config = &mut ctx.accounts.pool_config;
        pool_config.draw_in_progress = false;

        msg!("Draw cancelled for round {}", ctx.accounts.current_draw.round);
        Ok(())
    }
}

// =============================================================================
// M4 — internal helpers
// =============================================================================

/// `value * bps / 10_000` with checked arithmetic.
fn mul_div_bps(value: u64, bps: u64) -> Result<u64> {
    value
        .checked_mul(bps)
        .ok_or(StewfiError::Overflow)?
        .checked_div(BPS_DENOMINATOR)
        .ok_or(StewfiError::Overflow.into())
}

/// PDA-signed `token::transfer` from the pool's usdc_vault to a destination.
/// Skips the CPI when `amount == 0` (avoids a no-op CPI / possible zero-transfer
/// quirks). authority is the pool_config PDA. Takes `AccountInfo`s so callers can
/// pass Box<Account<..>> fields (boxed to keep the SettleDraw stack frame small).
fn transfer_from_vault<'info>(
    token_program: &Program<'info, Token>,
    from: AccountInfo<'info>,
    to: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    signer_seeds: &[&[&[u8]]],
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let cpi_accounts = Transfer {
        from,
        to,
        authority,
    };
    let cpi_ctx =
        CpiContext::new_with_signer(token_program.to_account_info(), cpi_accounts, signer_seeds);
    token::transfer(cpi_ctx, amount)
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
    /// PoolConfig — mutable: deposit maintains the M4 principal + weight
    /// accumulators (total_principal, sum_amount, sum_amount_first_ts).
    #[account(
        mut,
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
    /// PoolConfig — mutable: withdraw maintains the M4 principal + weight
    /// accumulators (subtracts the closed position's full contribution).
    #[account(
        mut,
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

// -----------------------------------------------------------------------------
// M4 — Draw account contexts
// -----------------------------------------------------------------------------

#[derive(Accounts)]
pub struct SetPaused<'info> {
    #[account(
        mut,
        seeds = [b"pool_config", pool_config.usdc_mint.as_ref()],
        bump = pool_config.bump,
    )]
    pub pool_config: Account<'info, PoolConfig>,

    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct InitDrawAccounts<'info> {
    #[account(
        mut,
        seeds = [b"pool_config", pool_config.usdc_mint.as_ref()],
        bump = pool_config.bump,
    )]
    pub pool_config: Account<'info, PoolConfig>,

    #[account(mut)]
    pub admin: Signer<'info>,

    /// USDC mint (must match the pool's). Used to seed the vault PDAs.
    #[account(address = pool_config.usdc_mint @ StewfiError::WrongMint)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    /// Round-0 Draw — the steady state that accepts deposits until triggered.
    #[account(
        init,
        payer = admin,
        space = 8 + Draw::INIT_SPACE,
        seeds = [b"draw", 0u64.to_le_bytes().as_ref()],
        bump,
    )]
    pub current_draw: Box<Account<'info, Draw>>,

    /// 20% Growing-Pot escrow (M5 sweeps). PDA-owned USDC account.
    #[account(
        init,
        payer = admin,
        seeds = [b"growing_pot_vault", usdc_mint.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = pool_config,
    )]
    pub growing_pot_vault: Box<Account<'info, TokenAccount>>,

    /// 10% operator escrow. PDA-owned USDC account.
    #[account(
        init,
        payer = admin,
        seeds = [b"operator_vault", usdc_mint.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = pool_config,
    )]
    pub operator_vault: Box<Account<'info, TokenAccount>>,

    /// 5% ops escrow. PDA-owned USDC account.
    #[account(
        init,
        payer = admin,
        seeds = [b"ops_vault", usdc_mint.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = pool_config,
    )]
    pub ops_vault: Box<Account<'info, TokenAccount>>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct TriggerDraw<'info> {
    /// Operator or admin (checked in the handler).
    pub crank: Signer<'info>,

    #[account(
        mut,
        seeds = [b"pool_config", pool_config.usdc_mint.as_ref()],
        bump = pool_config.bump,
    )]
    pub pool_config: Account<'info, PoolConfig>,

    /// Current round's Draw (must be Pending).
    #[account(
        mut,
        seeds = [b"draw", pool_config.current_round.to_le_bytes().as_ref()],
        bump = current_draw.bump,
    )]
    pub current_draw: Account<'info, Draw>,

    /// The pool's USDC vault — read for the prize snapshot.
    #[account(
        seeds = [b"usdc_vault", pool_config.usdc_mint.as_ref()],
        bump = pool_config.usdc_vault_bump,
    )]
    pub usdc_vault: Account<'info, TokenAccount>,

    /// The Switchboard randomness account (committed off-chain in the same tx).
    /// CHECK: parsed via RandomnessAccountData; owner + un-revealed verified.
    pub randomness_account: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct SettleDraw<'info> {
    /// Operator or admin (checked in the handler).
    #[account(mut)]
    pub crank: Signer<'info>,

    #[account(
        mut,
        seeds = [b"pool_config", pool_config.usdc_mint.as_ref()],
        bump = pool_config.bump,
    )]
    pub pool_config: Box<Account<'info, PoolConfig>>,

    /// Current round's Draw (must be Committed).
    #[account(
        mut,
        seeds = [b"draw", pool_config.current_round.to_le_bytes().as_ref()],
        bump = current_draw.bump,
    )]
    pub current_draw: Box<Account<'info, Draw>>,

    /// Next round's Draw, created here (Pending).
    #[account(
        init,
        payer = crank,
        space = 8 + Draw::INIT_SPACE,
        seeds = [
            b"draw",
            pool_config
                .current_round
                .checked_add(1)
                .ok_or(StewfiError::Overflow)?
                .to_le_bytes()
                .as_ref()
        ],
        bump,
    )]
    pub next_draw: Box<Account<'info, Draw>>,

    /// The committed randomness account (key checked == current_draw.randomness_account).
    /// CHECK: parsed via RandomnessAccountData; value read slot-bound.
    pub randomness_account: UncheckedAccount<'info>,

    /// The winner position. Anchor verifies it's a real UserPosition at its
    /// canonical PDA. The handler does NOT trust this is the winner — it derives
    /// the winner on-chain by iterating ALL live positions (passed via
    /// remaining_accounts, ascending by `user`) and requires this account ==
    /// the derived winner. Used here so the prize-split + Draw.winner record can
    /// reference the winner's wallet directly. See settle_draw.
    ///
    /// remaining_accounts (NOT in this struct): every live `UserPosition` for the
    /// pool, ordered ascending by `user` pubkey. Required for the trustless
    /// winner derivation + completeness check.
    #[account(
        seeds = [b"user_position", winner_position.user.as_ref()],
        bump = winner_position.bump,
    )]
    pub winner_position: Box<Account<'info, UserPosition>>,

    /// The pot (winner's 65% stays here; 20/10/5 leave here).
    #[account(
        mut,
        seeds = [b"usdc_vault", pool_config.usdc_mint.as_ref()],
        bump = pool_config.usdc_vault_bump,
    )]
    pub usdc_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [b"growing_pot_vault", pool_config.usdc_mint.as_ref()],
        bump = pool_config.growing_pot_vault_bump,
    )]
    pub growing_pot_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [b"operator_vault", pool_config.usdc_mint.as_ref()],
        bump = pool_config.operator_vault_bump,
    )]
    pub operator_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [b"ops_vault", pool_config.usdc_mint.as_ref()],
        bump = pool_config.ops_vault_bump,
    )]
    pub ops_vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(round: u64)]
pub struct ClaimDraw<'info> {
    #[account(mut)]
    pub winner: Signer<'info>,

    #[account(
        mut,
        seeds = [b"pool_config", pool_config.usdc_mint.as_ref()],
        bump = pool_config.bump,
    )]
    pub pool_config: Box<Account<'info, PoolConfig>>,

    /// The won round's Draw — must be Settled, winner matches, not yet claimed.
    #[account(
        mut,
        seeds = [b"draw", round.to_le_bytes().as_ref()],
        bump = draw.bump,
        constraint = draw.status == DrawStatus::Settled @ StewfiError::InvalidDrawStatus,
        constraint = draw.winner == winner.key() @ StewfiError::BadWinnerProof,
        constraint = !draw.winner_claimed @ StewfiError::InvalidDrawStatus,
    )]
    pub draw: Box<Account<'info, Draw>>,

    #[account(
        mut,
        seeds = [b"usdc_vault", pool_config.usdc_mint.as_ref()],
        bump = pool_config.usdc_vault_bump,
    )]
    pub usdc_vault: Box<Account<'info, TokenAccount>>,

    /// Winner's USDC token account.
    #[account(
        mut,
        constraint = winner_usdc.mint == pool_config.usdc_mint @ StewfiError::WrongMint,
        constraint = winner_usdc.owner == winner.key() @ StewfiError::WrongOwner,
    )]
    pub winner_usdc: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CancelDraw<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [b"pool_config", pool_config.usdc_mint.as_ref()],
        bump = pool_config.bump,
    )]
    pub pool_config: Account<'info, PoolConfig>,

    #[account(
        mut,
        seeds = [b"draw", pool_config.current_round.to_le_bytes().as_ref()],
        bump = current_draw.bump,
    )]
    pub current_draw: Account<'info, Draw>,
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
    /// Running principal deployed into Kamino (best-effort; deploy hint only).
    pub kamino_deposited: u64,
    /// Unix ts of the last deposit_to_kamino / withdraw_from_kamino crank.
    pub last_kamino_sync: i64,
    // ---- M4 (Draw) ----
    /// Exact sum of all live UserPosition.amount. Maintained in deposit (+) /
    /// withdraw (−). Authoritative principal for the prize formula
    /// (prize = usdc_vault − total_principal − pending_winnings).
    pub total_principal: u64,
    /// Trustless-winner accumulator S1 = Σ live position.amount (u128).
    pub sum_amount: u128,
    /// Trustless-winner accumulator S2 = Σ (position.amount × first_deposit_ts) (u128).
    /// total_weight at a draw = draw_ts × sum_amount − sum_amount_first_ts.
    pub sum_amount_first_ts: u128,
    /// Sum of settled-but-unclaimed winner prizes still sitting in usdc_vault.
    /// Excluded from the prize so a pending prize isn't re-drawn as "yield".
    pub pending_winnings: u64,
    /// True between trigger_draw (commit) and settle_draw/cancel_draw. Blocks
    /// deposit/withdraw so the weight set can't shift mid-draw.
    pub draw_in_progress: bool,
    /// Operator payout wallet (receives 10% via operator_vault sweep). Also the
    /// non-admin signer allowed to trigger/settle draws.
    pub operator: Pubkey,
    /// Ops payout wallet (receives 5% via ops_vault sweep).
    pub ops: Pubkey,
    /// Seconds between draws (set to DRAW_INTERVAL at init; weekly).
    pub draw_interval: i64,
    /// Earliest unix ts the next draw may be triggered.
    pub next_draw_ts: i64,
    /// True once init_draw_accounts has run (vaults + round-0 Draw exist).
    pub draw_accounts_ready: bool,
    /// Stored bumps for the M4 PDA vaults.
    pub growing_pot_vault_bump: u8,
    pub operator_vault_bump: u8,
    pub ops_vault_bump: u8,
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

/// Per-round draw state (PDA `[b"draw", round.to_le_bytes()]`).
#[account]
#[derive(InitSpace)]
pub struct Draw {
    /// Which round this draw represents.
    pub round: u64,
    /// State-machine position.
    pub status: DrawStatus,
    /// Switchboard randomness account committed for this round (default until commit).
    pub randomness_account: Pubkey,
    /// Timestamp pinned at commit; used for the winner's seconds_held at settle.
    pub draw_ts: i64,
    /// Global total weight snapshotted at commit (on-chain, trustless).
    pub total_weight: u128,
    /// Prize (USDC) snapshotted at commit = vault − principal − pending_winnings.
    pub prize_pool: u64,
    /// The 32 revealed VRF bytes (zero until settle).
    pub random_value: [u8; 32],
    /// Winner wallet (default until settle).
    pub winner: Pubkey,
    /// Winner's 65% (+ dust), held in usdc_vault until claim_draw.
    pub winner_amount: u64,
    /// 20% routed to growing_pot_vault at settle.
    pub growing_pot_amount: u64,
    /// 10% routed to operator_vault at settle.
    pub operator_amount: u64,
    /// 5% routed to ops_vault at settle.
    pub ops_amount: u64,
    /// Whether the winner has claimed their prize.
    pub winner_claimed: bool,
    /// PDA bump.
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum DrawStatus {
    /// Draw account exists for this round, accepting deposits (steady state).
    Pending,
    /// Randomness committed; awaiting the oracle reveal (off-chain).
    Committed,
    /// Winner picked + 20/10/5 distributed; 65% awaiting winner claim.
    Settled,
    /// Winner has claimed — terminal.
    Claimed,
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
    // ---- M4 (Draw) ----
    #[msg("A draw is in progress — deposits/withdrawals are locked")]
    DrawInProgress,
    #[msg("Draw accounts have already been initialized")]
    DrawAccountsAlreadyInit,
    #[msg("Draw accounts have not been initialized yet")]
    DrawAccountsNotInit,
    #[msg("It is not yet time for the next draw")]
    DrawNotReady,
    #[msg("Draw is not in the expected state for this action")]
    InvalidDrawStatus,
    #[msg("No eligible entries (total weight is zero)")]
    NoEntries,
    #[msg("Funds are still in Kamino — harvest into the vault before drawing")]
    FundsStillInKamino,
    #[msg("No prize to draw (vault has no yield over principal)")]
    NothingToDraw,
    #[msg("Randomness account is invalid or not a Switchboard On-Demand account")]
    InvalidRandomnessAccount,
    #[msg("Randomness account has already been revealed (single-use)")]
    RandomnessAlreadyRevealed,
    #[msg("Randomness has not been revealed for the current slot")]
    RandomnessNotResolved,
    #[msg("Winner proof failed: the claimed winner does not match the VRF result")]
    BadWinnerProof,
    #[msg("A passed position account is not a valid UserPosition for this pool")]
    BadPositionAccount,
    #[msg("Positions must be passed in strictly ascending order by user pubkey")]
    PositionsNotSorted,
    #[msg("Passed position set is incomplete: summed weight != snapshot total_weight")]
    IncompletePositionSet,
}
