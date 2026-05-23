/**
 * M3 — Kamino (klend) yield routing E2E.
 *
 * Runs against a surfpool fork of mainnet (see .superstack/m3-research.md §6).
 * Uses the REAL mainnet USDC mint so the real klend USDC reserve + Scope oracle
 * "just work" against live forked state.
 *
 * Funding: surfpool cheatcode `surfnet_setTokenAccount(owner, mint, {amount})`
 * sets an ATA balance directly (resolves research UNVERIFIED #6).
 *
 * Refresh ordering: we use "option A" — the test builds a multi-ix transaction
 * that prepends klend `refresh_reserve` + `refresh_obligation` BEFORE the StewFi
 * deposit/withdraw crank (the program does NOT CPI the refreshes itself).
 *
 * Prereq to run: surfpool must be up forking mainnet on http://127.0.0.1:8899:
 *   surfpool start -u https://api.mainnet-beta.solana.com --no-tui --no-deploy \
 *     -a <admin-pubkey>
 * and StewFi deployed to it. The npm script `test:kamino` (added in package.json)
 * wires ANCHOR_PROVIDER_URL/ANCHOR_WALLET for this.
 */
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Stewfi } from "../target/types/stewfi";
import {
  getAssociatedTokenAddressSync,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  TransactionInstruction,
  Transaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { assert } from "chai";

// ===========================================================================
// klend mainnet constants (all byte-verified from the forked reserve struct;
// see .superstack/m3-buglog.md F6/F7).
// ===========================================================================
const KLEND = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const FARMS = new PublicKey("FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr");
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

const LENDING_MARKET = new PublicKey(
  "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF"
);
const LENDING_MARKET_AUTHORITY = new PublicKey(
  "9DrvZvyWh1HuAoZxvYWMvkf2XCzryCpGgHqrMjyDWpmo"
);
const RESERVE = new PublicKey("D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59");
const RESERVE_LIQUIDITY_SUPPLY = new PublicKey(
  "Bgq7trRgVMeq33yt235zM2onQ4bRDBsY5EWiTetF4qw6"
);
const RESERVE_COLLATERAL_MINT = new PublicKey(
  "B8V6WVjPxW1UGwVDfxH2d2r8SyT4cqn7dQRK6XneVa7D"
);
const RESERVE_DEST_DEPOSIT_COLLATERAL = new PublicKey(
  "3DzjXRfxRm6iejfyyMynR4tScddaanrePJ1NJU2XnPPL"
);
// reserve.collateral.supply_vault == reserve_source_collateral on withdraw.
const RESERVE_SOURCE_COLLATERAL = RESERVE_DEST_DEPOSIT_COLLATERAL;
const FARM_COLLATERAL = new PublicKey(
  "JAvnB9AKtgPsTEoKmn24Bq64UMoYcrtWtq42HHBdsPkh"
);
const SCOPE_PRICES = new PublicKey(
  "3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH"
);

// klend instruction discriminators (from the embedded IDL).
const DISC_REFRESH_RESERVE = Buffer.from([2, 218, 138, 235, 79, 201, 25, 102]);
const DISC_REFRESH_OBLIGATION = Buffer.from([
  33, 132, 147, 228, 151, 192, 72, 89,
]);

// Obligation account layout (byte-verified from IDL): deposits[] starts at
// absolute offset 96; each ObligationCollateral is 136 bytes; deposit_reserve
// @ +0, deposited_amount (u64) @ +32.
const OBLIGATION_DEPOSITS_OFFSET = 96;
const OBLIGATION_COLLATERAL_SIZE = 136;

// ===========================================================================
// Helpers
// ===========================================================================

/** surfpool cheatcode: set an SPL token balance for `owner`'s ATA of `mint`. */
async function setTokenBalance(
  connection: anchor.web3.Connection,
  owner: PublicKey,
  mint: PublicKey,
  amount: bigint
): Promise<PublicKey> {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "surfnet_setTokenAccount",
    params: [owner.toBase58(), mint.toBase58(), { amount: Number(amount) }],
  };
  const resp = await fetch(connection.rpcEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await resp.json();
  if (json.error) {
    throw new Error("surfnet_setTokenAccount failed: " + JSON.stringify(json.error));
  }
  return getAssociatedTokenAddressSync(mint, owner, true);
}

/** surfpool cheatcode: airdrop lamports by setting account balance. */
async function fundSol(
  connection: anchor.web3.Connection,
  pubkey: PublicKey,
  lamports: number
) {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "surfnet_setAccount",
    params: [pubkey.toBase58(), { lamports }],
  };
  const resp = await fetch(connection.rpcEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await resp.json();
  if (json.error) throw new Error("surfnet_setAccount failed: " + JSON.stringify(json.error));
}

/** klend refresh_reserve (Scope oracle path; pyth/switchboard = None). */
function ixRefreshReserve(): TransactionInstruction {
  return new TransactionInstruction({
    programId: KLEND,
    keys: [
      { pubkey: RESERVE, isSigner: false, isWritable: true },
      { pubkey: LENDING_MARKET, isSigner: false, isWritable: false },
      { pubkey: KLEND, isSigner: false, isWritable: false }, // pyth_oracle = None
      { pubkey: KLEND, isSigner: false, isWritable: false }, // switchboard_price = None
      { pubkey: KLEND, isSigner: false, isWritable: false }, // switchboard_twap = None
      { pubkey: SCOPE_PRICES, isSigner: false, isWritable: false }, // scope_prices
    ],
    data: DISC_REFRESH_RESERVE,
  });
}

/**
 * klend refresh_obligation. remaining_accounts MUST equal the obligation's
 * CURRENTLY booked deposit reserves (then borrow reserves [none], referrers
 * [none]). klend cross-checks the count against the obligation's state, so a
 * fresh (empty) obligation needs ZERO remaining reserves; after the first
 * deposit books collateral it needs [USDC reserve]. Pass that list in.
 */
function ixRefreshObligation(
  obligation: PublicKey,
  depositReserves: PublicKey[]
): TransactionInstruction {
  return new TransactionInstruction({
    programId: KLEND,
    keys: [
      { pubkey: LENDING_MARKET, isSigner: false, isWritable: false },
      { pubkey: obligation, isSigner: false, isWritable: true },
      ...depositReserves.map((r) => ({
        pubkey: r,
        isSigner: false,
        isWritable: true,
      })),
    ],
    data: DISC_REFRESH_OBLIGATION,
  });
}

/** Read the obligation's currently-booked deposit reserves (non-default slots). */
async function readObligationDepositReserves(
  connection: anchor.web3.Connection,
  obligation: PublicKey
): Promise<PublicKey[]> {
  const info = await connection.getAccountInfo(obligation);
  if (!info) return [];
  const out: PublicKey[] = [];
  for (let i = 0; i < 8; i++) {
    const off = OBLIGATION_DEPOSITS_OFFSET + i * OBLIGATION_COLLATERAL_SIZE;
    const rk = new PublicKey(info.data.subarray(off, off + 32));
    const amt = info.data.readBigUInt64LE(off + 32);
    if (!rk.equals(PublicKey.default) && amt > 0n) out.push(rk);
  }
  return out;
}

/** Read deposits[0].deposited_amount (cTokens) from the obligation account. */
async function readObligationCollateral(
  connection: anchor.web3.Connection,
  obligation: PublicKey
): Promise<bigint> {
  const info = await connection.getAccountInfo(obligation);
  if (!info) return 0n;
  const base = OBLIGATION_DEPOSITS_OFFSET; // deposits[0]
  // deposit_reserve @ +0
  const reserveKey = new PublicKey(info.data.subarray(base, base + 32));
  if (!reserveKey.equals(RESERVE)) {
    // deposits[0] empty or different reserve — scan all 8 slots for our reserve.
    for (let i = 0; i < 8; i++) {
      const off = OBLIGATION_DEPOSITS_OFFSET + i * OBLIGATION_COLLATERAL_SIZE;
      const rk = new PublicKey(info.data.subarray(off, off + 32));
      if (rk.equals(RESERVE)) {
        return info.data.readBigUInt64LE(off + 32);
      }
    }
    return 0n;
  }
  return info.data.readBigUInt64LE(base + 32);
}

// ===========================================================================
describe("stewfi — M3 Kamino yield routing (surfpool fork-mainnet)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Stewfi as Program<Stewfi>;
  const connection = provider.connection;

  // admin = the provider wallet (already SOL-funded by surfpool airdrop flag).
  const admin = (provider.wallet as anchor.Wallet).payer;

  let poolConfigPda: PublicKey;
  let usdcVaultPda: PublicKey;
  let adminUsdcAta: PublicKey;

  // klend PDAs (owner = pool_config).
  let userMetadata: PublicKey;
  let obligation: PublicKey;
  let obligationFarmUserState: PublicKey;

  const ONE_USDC = 1_000_000n;
  const DEPOSIT_TO_POOL = 500n * ONE_USDC; // user deposits 500 USDC into StewFi
  const DEPOSIT_TO_KAMINO = 300n * ONE_USDC; // crank routes 300 USDC into klend

  before("derive PDAs, init pool, fund + user deposit", async function () {
    this.timeout(120000);

    [poolConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool_config"), USDC_MINT.toBuffer()],
      program.programId
    );
    [usdcVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("usdc_vault"), USDC_MINT.toBuffer()],
      program.programId
    );

    // klend user_metadata PDA: [b"user_meta", owner=pool_config]
    [userMetadata] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_meta"), poolConfigPda.toBuffer()],
      KLEND
    );
    // klend Vanilla obligation PDA:
    //   [ [tag=0], [id=0], owner=pool_config, market, seed1=default, seed2=default ]
    [obligation] = PublicKey.findProgramAddressSync(
      [
        Buffer.from([0]),
        Buffer.from([0]),
        poolConfigPda.toBuffer(),
        LENDING_MARKET.toBuffer(),
        PublicKey.default.toBuffer(),
        PublicKey.default.toBuffer(),
      ],
      KLEND
    );
    // klend obligation farm user state PDA: [b"user", reserve_farm_state, obligation]
    [obligationFarmUserState] = PublicKey.findProgramAddressSync(
      [Buffer.from("user"), FARM_COLLATERAL.toBuffer(), obligation.toBuffer()],
      FARMS
    );

    // Fund admin USDC and initialize the pool (idempotent across reruns).
    adminUsdcAta = await setTokenBalance(
      connection,
      admin.publicKey,
      USDC_MINT,
      2000n * ONE_USDC
    );

    const existing = await connection.getAccountInfo(poolConfigPda);
    if (!existing) {
      await program.methods
        .initialize()
        .accounts({
          poolConfig: poolConfigPda,
          usdcVault: usdcVaultPda,
          usdcMint: USDC_MINT,
          admin: admin.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();
    }

    // User deposits into StewFi so the vault has USDC to route into klend.
    // (We reuse admin as the depositing user for simplicity — the deposit ix
    //  just needs a funded USDC owner; M3 routing is owner-agnostic.)
    const [userPositionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_position"), admin.publicKey.toBuffer()],
      program.programId
    );
    const posInfo = await connection.getAccountInfo(userPositionPda);
    if (!posInfo) {
      await program.methods
        .deposit(new BN(DEPOSIT_TO_POOL.toString()))
        .accounts({
          poolConfig: poolConfigPda,
          userPosition: userPositionPda,
          usdcVault: usdcVaultPda,
          userUsdc: adminUsdcAta,
          user: admin.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
    }
  });

  it("init_kamino_obligation creates the obligation + stores it in PoolConfig", async function () {
    this.timeout(120000);

    const cfgBefore = await program.account.poolConfig.fetch(poolConfigPda);
    // Re-run guard: if PoolConfig already records an obligation but surfpool's
    // local overlay dropped that account (happens across stale sessions — the
    // program correctly refuses to re-init), skip with a clear message instead
    // of a confusing assert. Run from a FRESH surfpool session for a clean pass.
    if (!cfgBefore.kaminoObligation.equals(PublicKey.default)) {
      const ob = await connection.getAccountInfo(cfgBefore.kaminoObligation);
      if (!ob) {
        this.skip(); // stale surfpool overlay — restart surfpool to re-run M3
      }
    }
    if (cfgBefore.kaminoObligation.equals(PublicKey.default)) {
      await program.methods
        .initKaminoObligation()
        .accounts({
          poolConfig: poolConfigPda,
          admin: admin.publicKey,
          userMetadata,
          obligation,
          lendingMarket: LENDING_MARKET,
          seed1Account: PublicKey.default,
          seed2Account: PublicKey.default,
          klendProgram: KLEND,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc({ skipPreflight: true });
    }

    const cfg = await program.account.poolConfig.fetch(poolConfigPda);
    assert.equal(
      cfg.kaminoObligation.toBase58(),
      obligation.toBase58(),
      "PoolConfig.kamino_obligation should equal the derived obligation PDA"
    );

    // klend obligation account must now exist + be owned by klend.
    const obInfo = await connection.getAccountInfo(obligation);
    assert.isNotNull(obInfo, "obligation account should exist");
    assert.equal(obInfo!.owner.toBase58(), KLEND.toBase58());
  });

  it("init_kamino_farm creates the obligation farm user state", async function () {
    this.timeout(120000);

    const existing = await connection.getAccountInfo(obligationFarmUserState);
    if (!existing) {
      await program.methods
        .initKaminoFarm()
        .accounts({
          poolConfig: poolConfigPda,
          admin: admin.publicKey,
          obligation,
          lendingMarketAuthority: LENDING_MARKET_AUTHORITY,
          reserve: RESERVE,
          reserveFarmState: FARM_COLLATERAL,
          obligationFarmUserState,
          lendingMarket: LENDING_MARKET,
          farmsProgram: FARMS,
          klendProgram: KLEND,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc({ skipPreflight: true });
    }

    const info = await connection.getAccountInfo(obligationFarmUserState);
    assert.isNotNull(info, "obligation farm user state should exist");
    assert.equal(info!.owner.toBase58(), FARMS.toBase58());
  });

  it("deposit_to_kamino routes USDC into the reserve (with refresh prefix)", async function () {
    this.timeout(120000);

    const vaultBefore = await getAccount(connection, usdcVaultPda);

    const depositIx = await program.methods
      .depositToKamino(new BN(DEPOSIT_TO_KAMINO.toString()))
      .accounts({
        poolConfig: poolConfigPda,
        crank: admin.publicKey,
        usdcVault: usdcVaultPda,
        obligation,
        lendingMarket: LENDING_MARKET,
        lendingMarketAuthority: LENDING_MARKET_AUTHORITY,
        reserve: RESERVE,
        reserveLiquidityMint: USDC_MINT,
        reserveLiquiditySupply: RESERVE_LIQUIDITY_SUPPLY,
        reserveCollateralMint: RESERVE_COLLATERAL_MINT,
        reserveDestinationDepositCollateral: RESERVE_DEST_DEPOSIT_COLLATERAL,
        collateralTokenProgram: TOKEN_PROGRAM_ID,
        liquidityTokenProgram: TOKEN_PROGRAM_ID,
        instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
        obligationFarmUserState,
        reserveFarmState: FARM_COLLATERAL,
        farmsProgram: FARMS,
        klendProgram: KLEND,
      })
      .instruction();

    // refresh_obligation needs the obligation's CURRENT deposit reserves. On the
    // first deposit the obligation is empty → pass none.
    const depReservesBefore = await readObligationDepositReserves(
      connection,
      obligation
    );
    const tx = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
      .add(ixRefreshReserve())
      .add(ixRefreshObligation(obligation, depReservesBefore))
      .add(depositIx);

    await provider.sendAndConfirm(tx, [], { skipPreflight: true });

    // The pool vault should have dropped by ~the deposited amount. klend's
    // liquidity→collateral conversion can floor-round by 1 base unit depending
    // on the reserve's live exchange rate (which drifts across mainnet-fork
    // snapshots), so allow a 1-unit tolerance rather than exact equality.
    const vaultAfter = await getAccount(connection, usdcVaultPda);
    const drop = vaultBefore.amount - vaultAfter.amount;
    assert.isTrue(
      drop <= DEPOSIT_TO_KAMINO && drop >= DEPOSIT_TO_KAMINO - 1n,
      `usdc_vault should drop by ~${DEPOSIT_TO_KAMINO} (got ${drop})`
    );

    // The obligation should now hold collateral (cTokens) for the USDC reserve.
    const coll = await readObligationCollateral(connection, obligation);
    assert.isTrue(
      coll > 0n,
      `obligation should hold collateral after deposit, got ${coll}`
    );

    // PoolConfig tracking updated.
    const cfg = await program.account.poolConfig.fetch(poolConfigPda);
    assert.equal(
      BigInt(cfg.kaminoDeposited.toString()),
      DEPOSIT_TO_KAMINO,
      "kamino_deposited tracking should equal routed amount"
    );
    assert.isTrue(cfg.lastKaminoSync.toNumber() > 0);
  });

  it("withdraw_from_kamino redeems collateral back into the vault (with refresh prefix)", async function () {
    this.timeout(120000);

    const collateral = await readObligationCollateral(connection, obligation);
    assert.isTrue(collateral > 0n, "need collateral to withdraw");

    const vaultBefore = await getAccount(connection, usdcVaultPda);

    const withdrawIx = await program.methods
      .withdrawFromKamino(new BN(collateral.toString()))
      .accounts({
        poolConfig: poolConfigPda,
        crank: admin.publicKey,
        usdcVault: usdcVaultPda,
        obligation,
        lendingMarket: LENDING_MARKET,
        lendingMarketAuthority: LENDING_MARKET_AUTHORITY,
        reserve: RESERVE,
        reserveLiquidityMint: USDC_MINT,
        reserveSourceCollateral: RESERVE_SOURCE_COLLATERAL,
        reserveCollateralMint: RESERVE_COLLATERAL_MINT,
        reserveLiquiditySupply: RESERVE_LIQUIDITY_SUPPLY,
        collateralTokenProgram: TOKEN_PROGRAM_ID,
        liquidityTokenProgram: TOKEN_PROGRAM_ID,
        instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
        obligationFarmUserState,
        reserveFarmState: FARM_COLLATERAL,
        farmsProgram: FARMS,
        klendProgram: KLEND,
      })
      .instruction();

    // At withdraw time the obligation holds the USDC reserve as a deposit.
    const depReserves = await readObligationDepositReserves(connection, obligation);
    const tx = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
      .add(ixRefreshReserve())
      .add(ixRefreshObligation(obligation, depReserves))
      .add(withdrawIx);

    await provider.sendAndConfirm(tx, [], { skipPreflight: true });

    const vaultAfter = await getAccount(connection, usdcVaultPda);
    const received = vaultAfter.amount - vaultBefore.amount;
    // We withdrew all collateral, so the vault should have grown back by ~the
    // routed principal (yield over a few slots is negligible). Allow a few base
    // units of floor-rounding on the liquidity<->collateral conversions.
    assert.isTrue(
      received >= DEPOSIT_TO_KAMINO - 5n,
      `vault should regain ~the routed principal, got ${received}`
    );

    // Obligation collateral should be ~drained.
    const collAfter = await readObligationCollateral(connection, obligation);
    assert.isTrue(
      collAfter <= 1n,
      `obligation collateral should be ~zero after full withdraw, got ${collAfter}`
    );
  });
});
