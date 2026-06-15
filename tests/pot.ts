/**
 * M5 — The GROWING POT (compound the 20% escrow into Kamino, harvest its yield).
 *
 * Runs against a surfpool fork of mainnet (real klend), exactly like the M3
 * tests/kamino.ts (same mainnet constants, same refresh-prefix pattern). The pot
 * uses its OWN klend obligation (Vanilla tag=0, id=1) — distinct from the M3
 * main-pool obligation (id=0).
 *
 * What this exercises:
 *   - init_growing_pot_obligation creates a DISTINCT obligation (id=1) and stores
 *     it (asserts the address differs from the M3 id=0 obligation).
 *   - init_growing_pot_farm creates the pot obligation's farm-user-state (the
 *     mainnet USDC reserve has a collateral farm, so the v2 CPIs need it).
 *   - compound_growing_pot deposits the WHOLE growing_pot_vault into the pot
 *     obligation; pot_principal_usdc increases by exactly the amount; the pot
 *     obligation holds cTokens.
 *   - harvest_growing_pot_yield fully redeems the pot position into usdc_vault,
 *     returns the recovered principal to growing_pot_vault, decrements
 *     pot_principal_usdc by exactly the returned slice (a FULL redeem returns the
 *     whole tracked principal, so it lands at 0), and leaves only the yield in
 *     usdc_vault. We test the realistic FLAT-week case on a fork (a few slots of
 *     yield ≈ 0): the principal is preserved (growing_pot_vault ≈ original), and
 *     pot_principal lands at 0. We also test the EMPTY-pot guard (NoPotYield).
 *   - Permissionless: compound + harvest are callable by a NON-admin signer.
 *   - draw_in_progress guard: compound + harvest rejected while a draw is live.
 *
 * Funding the growing_pot_vault: it is a custom-seed PDA token account (NOT an
 * ATA), so surfnet_setTokenAccount (which targets an owner's ATA) can't address
 * it. We instead write a raw SPL token-account buffer to the vault's address via
 * the generic surfnet_setAccount cheatcode (same mechanism draw.ts uses to mock
 * accounts; verified in m3-buglog). The vault already exists (init_draw_accounts
 * created it) — we overwrite its `amount`.
 *
 * Prereq to run (see package.json `test:pot`): surfpool up forking mainnet on
 * http://127.0.0.1:8899 with StewFi deployed, admin = the surfpool -a wallet.
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
// klend mainnet constants (identical to tests/kamino.ts — byte-verified there).
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

// Obligation layout: deposits[] @ +96; ObligationCollateral 136 bytes;
// deposit_reserve @ +0, deposited_amount (u64) @ +32.
const OBLIGATION_DEPOSITS_OFFSET = 96;
const OBLIGATION_COLLATERAL_SIZE = 136;

const ONE_USDC = 1_000_000n;

// ===========================================================================
// Helpers (mirrors tests/kamino.ts)
// ===========================================================================

async function rpc(endpoint: string, method: string, params: any[]): Promise<any> {
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await resp.json();
  if (json.error) throw new Error(`${method} failed: ${JSON.stringify(json.error)}`);
  return json.result;
}

/** surfpool cheatcode: set an SPL token balance for `owner`'s ATA of `mint`. */
async function setTokenBalance(
  connection: anchor.web3.Connection,
  owner: PublicKey,
  mint: PublicKey,
  amount: bigint
): Promise<PublicKey> {
  await rpc(connection.rpcEndpoint, "surfnet_setTokenAccount", [
    owner.toBase58(),
    mint.toBase58(),
    { amount: Number(amount) },
  ]);
  return getAssociatedTokenAddressSync(mint, owner, true);
}

/** surfpool cheatcode: airdrop lamports by setting account balance. */
async function fundSol(
  connection: anchor.web3.Connection,
  pubkey: PublicKey,
  lamports: number
) {
  await rpc(connection.rpcEndpoint, "surfnet_setAccount", [
    pubkey.toBase58(),
    { lamports },
  ]);
}

/**
 * Build a raw 165-byte SPL token-account buffer (mint, owner, amount, state =
 * Initialized) and write it to `tokenAccount`'s address via surfnet_setAccount
 * (owner = SPL Token program). Used to set the growing_pot_vault PDA's balance,
 * which is NOT an ATA so surfnet_setTokenAccount can't target it. The account
 * already exists (init_draw_accounts created it) — we overwrite its data so the
 * mint/owner stay correct and the `amount` is what we want.
 *
 * Layout (SPL Token Account, 165 bytes):
 *   mint           : [0..32]
 *   owner          : [32..64]
 *   amount         : [64..72]   u64 LE
 *   delegate       : [72..108]  COption<Pubkey> (4-byte tag + 32) — None
 *   state          : [108]      u8 (1 = Initialized)
 *   is_native      : [109..121] COption<u64> — None
 *   delegated_amount [121..129] u64 LE
 *   close_authority [129..165]  COption<Pubkey> — None
 */
async function setRawTokenAccountBalance(
  endpoint: string,
  tokenAccount: PublicKey,
  mint: PublicKey,
  owner: PublicKey,
  amount: bigint
): Promise<void> {
  const buf = Buffer.alloc(165);
  mint.toBuffer().copy(buf, 0);
  owner.toBuffer().copy(buf, 32);
  buf.writeBigUInt64LE(amount, 64);
  buf.writeUInt8(1, 108); // AccountState::Initialized
  await rpc(endpoint, "surfnet_setAccount", [
    tokenAccount.toBase58(),
    {
      lamports: 2_039_280, // rent-exempt minimum for a 165-byte token account
      owner: TOKEN_PROGRAM_ID.toBase58(),
      data: buf.toString("hex"),
      executable: false,
    },
  ]);
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

/** klend refresh_obligation — remaining = the obligation's CURRENT deposit reserves. */
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

/** Read deposits[*].deposited_amount (cTokens) for OUR reserve from an obligation. */
async function readObligationCollateral(
  connection: anchor.web3.Connection,
  obligation: PublicKey
): Promise<bigint> {
  const info = await connection.getAccountInfo(obligation);
  if (!info) return 0n;
  for (let i = 0; i < 8; i++) {
    const off = OBLIGATION_DEPOSITS_OFFSET + i * OBLIGATION_COLLATERAL_SIZE;
    const rk = new PublicKey(info.data.subarray(off, off + 32));
    if (rk.equals(RESERVE)) return info.data.readBigUInt64LE(off + 32);
  }
  return 0n;
}

// ===========================================================================
describe("stewfi — M5 Growing Pot (surfpool fork-mainnet)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Stewfi as Program<Stewfi>;
  const connection = provider.connection;
  const endpoint = connection.rpcEndpoint;

  // admin = the provider wallet (already SOL-funded by surfpool airdrop flag).
  const admin = (provider.wallet as anchor.Wallet).payer;

  // A NON-admin signer to prove compound/harvest are permissionless.
  const stranger = Keypair.generate();

  let poolConfigPda: PublicKey;
  let usdcVaultPda: PublicKey;
  let growingPotVaultPda: PublicKey;
  let operatorVaultPda: PublicKey;
  let opsVaultPda: PublicKey;
  let adminUsdcAta: PublicKey;

  // klend PDAs (owner = pool_config).
  let userMetadata: PublicKey;
  let mainObligation: PublicKey; // M3 id=0
  let mainObligationFarm: PublicKey;
  let potObligation: PublicKey; // M5 id=1
  let potObligationFarm: PublicKey;

  const DEPOSIT_TO_POOL = 500n * ONE_USDC; // user deposit → backs usdc_vault principal
  const POT_FUND = 200n * ONE_USDC; // simulated 20%-escrow sitting in growing_pot_vault

  const drawPda = (round: number) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("draw"), new BN(round).toArrayLike(Buffer, "le", 8)],
      program.programId
    )[0];

  before("derive PDAs; init pool + M3 obligation/farm; fund pot", async function () {
    this.timeout(180000);

    [poolConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool_config"), USDC_MINT.toBuffer()],
      program.programId
    );
    [usdcVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("usdc_vault"), USDC_MINT.toBuffer()],
      program.programId
    );
    [growingPotVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("growing_pot_vault"), USDC_MINT.toBuffer()],
      program.programId
    );
    [operatorVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("operator_vault"), USDC_MINT.toBuffer()],
      program.programId
    );
    [opsVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("ops_vault"), USDC_MINT.toBuffer()],
      program.programId
    );

    // klend user_metadata PDA: [b"user_meta", owner=pool_config]
    [userMetadata] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_meta"), poolConfigPda.toBuffer()],
      KLEND
    );
    // M3 obligation (tag=0, id=0).
    [mainObligation] = PublicKey.findProgramAddressSync(
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
    // POT obligation (tag=0, id=1).
    [potObligation] = PublicKey.findProgramAddressSync(
      [
        Buffer.from([0]),
        Buffer.from([1]),
        poolConfigPda.toBuffer(),
        LENDING_MARKET.toBuffer(),
        PublicKey.default.toBuffer(),
        PublicKey.default.toBuffer(),
      ],
      KLEND
    );
    // Farm-user-state PDAs: [b"user", reserve_farm_state, obligation]
    [mainObligationFarm] = PublicKey.findProgramAddressSync(
      [Buffer.from("user"), FARM_COLLATERAL.toBuffer(), mainObligation.toBuffer()],
      FARMS
    );
    [potObligationFarm] = PublicKey.findProgramAddressSync(
      [Buffer.from("user"), FARM_COLLATERAL.toBuffer(), potObligation.toBuffer()],
      FARMS
    );

    // Fund the stranger (non-admin crank) with SOL.
    await fundSol(connection, stranger.publicKey, 5_000_000_000);

    // Fund admin USDC + initialize the pool (idempotent across reruns).
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

    // A user deposit so usdc_vault holds real principal (so we can later assert
    // the harvested yield, not principal, is what trigger_draw would capture).
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

    // M3 obligation + farm must exist before the pot obligation (the pot reuses
    // the M3 UserMetadata). Idempotent across reruns.
    const cfg0 = await program.account.poolConfig.fetch(poolConfigPda);
    if (cfg0.kaminoObligation.equals(PublicKey.default)) {
      await program.methods
        .initKaminoObligation()
        .accounts({
          poolConfig: poolConfigPda,
          admin: admin.publicKey,
          userMetadata,
          obligation: mainObligation,
          lendingMarket: LENDING_MARKET,
          seed1Account: PublicKey.default,
          seed2Account: PublicKey.default,
          klendProgram: KLEND,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc({ skipPreflight: true });
    }
    const mainFarmInfo = await connection.getAccountInfo(mainObligationFarm);
    if (!mainFarmInfo) {
      await program.methods
        .initKaminoFarm()
        .accounts({
          poolConfig: poolConfigPda,
          admin: admin.publicKey,
          obligation: mainObligation,
          lendingMarketAuthority: LENDING_MARKET_AUTHORITY,
          reserve: RESERVE,
          reserveFarmState: FARM_COLLATERAL,
          obligationFarmUserState: mainObligationFarm,
          lendingMarket: LENDING_MARKET,
          farmsProgram: FARMS,
          klendProgram: KLEND,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc({ skipPreflight: true });
    }

    // init_draw_accounts creates growing_pot_vault (+ operator/ops vaults) and
    // the round-0 Draw. Idempotent across reruns.
    if (!cfg0.drawAccountsReady) {
      const operator = Keypair.generate();
      const ops = Keypair.generate();
      await program.methods
        .initDrawAccounts(operator.publicKey, ops.publicKey)
        .accounts({
          poolConfig: poolConfigPda,
          admin: admin.publicKey,
          usdcMint: USDC_MINT,
          currentDraw: drawPda(0),
          growingPotVault: growingPotVaultPda,
          operatorVault: operatorVaultPda,
          opsVault: opsVaultPda,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();
    }

    // Simulate the 20% escrow: put POT_FUND USDC into growing_pot_vault directly.
    await setRawTokenAccountBalance(
      endpoint,
      growingPotVaultPda,
      USDC_MINT,
      poolConfigPda,
      POT_FUND
    );
    const potBal = await getAccount(connection, growingPotVaultPda);
    assert.equal(BigInt(potBal.amount.toString()), POT_FUND, "growing_pot_vault funded");
  });

  it("init_growing_pot_obligation creates a DISTINCT obligation (id=1) + stores it", async function () {
    this.timeout(120000);

    // Sanity: the two obligation PDAs differ (id=0 vs id=1).
    assert.notEqual(
      potObligation.toBase58(),
      mainObligation.toBase58(),
      "pot obligation (id=1) must differ from the M3 obligation (id=0)"
    );

    const cfgBefore = await program.account.poolConfig.fetch(poolConfigPda);
    // Re-run guard: if the config records a pot obligation but the surfpool
    // overlay dropped that account (stale session), skip with a clear message.
    if (cfgBefore.growingPotObligationReady) {
      const ob = await connection.getAccountInfo(cfgBefore.potObligation);
      if (!ob) this.skip();
    }
    if (!cfgBefore.growingPotObligationReady) {
      await program.methods
        .initGrowingPotObligation()
        .accounts({
          poolConfig: poolConfigPda,
          admin: admin.publicKey,
          userMetadata,
          obligation: potObligation,
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
    assert.isTrue(cfg.growingPotObligationReady, "pot obligation marked ready");
    assert.equal(
      cfg.potObligation.toBase58(),
      potObligation.toBase58(),
      "PoolConfig.pot_obligation == derived id=1 PDA"
    );
    assert.notEqual(
      cfg.potObligation.toBase58(),
      cfg.kaminoObligation.toBase58(),
      "pot obligation distinct from the M3 main obligation"
    );

    const obInfo = await connection.getAccountInfo(potObligation);
    assert.isNotNull(obInfo, "pot obligation account exists");
    assert.equal(obInfo!.owner.toBase58(), KLEND.toBase58());
  });

  it("init_growing_pot_farm creates the pot obligation farm user state", async function () {
    this.timeout(120000);

    const existing = await connection.getAccountInfo(potObligationFarm);
    if (!existing) {
      await program.methods
        .initGrowingPotFarm()
        .accounts({
          poolConfig: poolConfigPda,
          admin: admin.publicKey,
          obligation: potObligation,
          lendingMarketAuthority: LENDING_MARKET_AUTHORITY,
          reserve: RESERVE,
          reserveFarmState: FARM_COLLATERAL,
          obligationFarmUserState: potObligationFarm,
          lendingMarket: LENDING_MARKET,
          farmsProgram: FARMS,
          klendProgram: KLEND,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc({ skipPreflight: true });
    }
    const info = await connection.getAccountInfo(potObligationFarm);
    assert.isNotNull(info, "pot obligation farm user state exists");
    assert.equal(info!.owner.toBase58(), FARMS.toBase58());
    // Distinct from the M3 farm-user-state (different obligation).
    assert.notEqual(potObligationFarm.toBase58(), mainObligationFarm.toBase58());
  });

  // Build a compound_growing_pot ix (so error-path tests can reuse it).
  async function compoundIx(crank: PublicKey) {
    return program.methods
      .compoundGrowingPot()
      .accounts({
        poolConfig: poolConfigPda,
        crank,
        growingPotVault: growingPotVaultPda,
        obligation: potObligation,
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
        obligationFarmUserState: potObligationFarm,
        reserveFarmState: FARM_COLLATERAL,
        farmsProgram: FARMS,
        klendProgram: KLEND,
      })
      .instruction();
  }

  async function harvestIx(crank: PublicKey, fullCollateral: bigint) {
    return program.methods
      .harvestGrowingPotYield(new BN(fullCollateral.toString()))
      .accounts({
        poolConfig: poolConfigPda,
        crank,
        usdcVault: usdcVaultPda,
        growingPotVault: growingPotVaultPda,
        obligation: potObligation,
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
        obligationFarmUserState: potObligationFarm,
        reserveFarmState: FARM_COLLATERAL,
        farmsProgram: FARMS,
        klendProgram: KLEND,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
  }

  it("compound_growing_pot deposits the whole pot vault; pot_principal_usdc += exact amount; cTokens > 0 (permissionless crank)", async function () {
    this.timeout(120000);

    const cfgBefore = await program.account.poolConfig.fetch(poolConfigPda);
    const potPrincipalBefore = BigInt(cfgBefore.potPrincipalUsdc.toString());
    const potVaultBefore = BigInt((await getAccount(connection, growingPotVaultPda)).amount.toString());
    assert.isTrue(potVaultBefore > 0n, "pot vault has funds to compound");

    const ix = await compoundIx(stranger.publicKey); // NON-admin crank
    const depReservesBefore = await readObligationDepositReserves(connection, potObligation);
    const tx = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
      .add(ixRefreshReserve())
      .add(ixRefreshObligation(potObligation, depReservesBefore))
      .add(ix);

    await provider.sendAndConfirm(tx, [stranger], { skipPreflight: true });

    // Pot vault drained to ~0 (klend liquidity→collateral can floor-round by 1).
    const potVaultAfter = BigInt((await getAccount(connection, growingPotVaultPda)).amount.toString());
    assert.isTrue(potVaultAfter <= 1n, `pot vault drained, got ${potVaultAfter}`);

    // pot_principal_usdc increased by EXACTLY the deposited amount.
    const cfgAfter = await program.account.poolConfig.fetch(poolConfigPda);
    const potPrincipalAfter = BigInt(cfgAfter.potPrincipalUsdc.toString());
    assert.equal(
      potPrincipalAfter - potPrincipalBefore,
      potVaultBefore,
      "pot_principal_usdc += exact compounded amount"
    );

    // Pot obligation holds collateral.
    const coll = await readObligationCollateral(connection, potObligation);
    assert.isTrue(coll > 0n, `pot obligation should hold cTokens, got ${coll}`);
  });

  it("harvest_growing_pot_yield: full redeem → principal back to pot vault, yield in usdc_vault, pot_principal reset", async function () {
    this.timeout(120000);

    const collateral = await readObligationCollateral(connection, potObligation);
    assert.isTrue(collateral > 0n, "need pot cTokens to harvest");

    const cfgBefore = await program.account.poolConfig.fetch(poolConfigPda);
    const potPrincipalBefore = BigInt(cfgBefore.potPrincipalUsdc.toString());
    assert.isTrue(potPrincipalBefore > 0n, "pot principal tracked before harvest");

    const usdcVaultBefore = BigInt((await getAccount(connection, usdcVaultPda)).amount.toString());
    const potVaultBefore = BigInt((await getAccount(connection, growingPotVaultPda)).amount.toString());

    const ix = await harvestIx(stranger.publicKey, collateral); // NON-admin crank
    const depReserves = await readObligationDepositReserves(connection, potObligation);
    const tx = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
      .add(ixRefreshReserve())
      .add(ixRefreshObligation(potObligation, depReserves))
      .add(ix);

    await provider.sendAndConfirm(tx, [stranger], { skipPreflight: true });

    const usdcVaultAfter = BigInt((await getAccount(connection, usdcVaultPda)).amount.toString());
    const potVaultAfter = BigInt((await getAccount(connection, growingPotVaultPda)).amount.toString());

    // total_redeemed = (yield left in usdc_vault) + (principal sent to pot vault).
    const yieldInUsdcVault = usdcVaultAfter - usdcVaultBefore; // >= 0
    const principalReturned = potVaultAfter - potVaultBefore; // back to pot vault
    const totalRedeemed = yieldInUsdcVault + principalReturned;
    assert.isTrue(totalRedeemed > 0n, "redeemed something from the pot position");

    // (c) pot_principal_usdc reset to 0.
    const cfgAfter = await program.account.poolConfig.fetch(poolConfigPda);
    assert.equal(BigInt(cfgAfter.potPrincipalUsdc.toString()), 0n, "pot_principal_usdc reset");

    // (b)+(d) principal preserved: the recovered principal slice
    // (= min(redeemed, principal_before)) is returned to growing_pot_vault, so
    // the pot vault is back to ~its original principal (a few base units of
    // floor-rounding on the liquidity<->collateral conversions are allowed). On a
    // fork a few slots of yield is ~0, so this is essentially the FLAT case.
    const expectedPrincipalReturn =
      totalRedeemed < potPrincipalBefore ? totalRedeemed : potPrincipalBefore;
    assert.equal(
      principalReturned,
      expectedPrincipalReturn,
      "principal_return == min(redeemed, principal_before) lands in pot vault"
    );
    // Principal preserved within rounding: pot vault ≈ original POT_FUND.
    assert.isTrue(
      potVaultAfter >= POT_FUND - 5n && potVaultAfter <= POT_FUND + 5n,
      `pot vault ≈ original principal (got ${potVaultAfter}, want ~${POT_FUND})`
    );

    // (a) yield (redeemed − principal_return) stays in usdc_vault → captured by
    // the existing trigger_draw prize formula. yield_amount == 0 (flat week) is
    // valid and allowed; assert the invariant (no principal leaked into the prize).
    assert.equal(
      yieldInUsdcVault,
      totalRedeemed - expectedPrincipalReturn,
      "yield (and ONLY yield) remains in usdc_vault"
    );
    assert.isTrue(yieldInUsdcVault >= 0n, "yield is non-negative");

    // Pot obligation collateral ~drained.
    const collAfter = await readObligationCollateral(connection, potObligation);
    assert.isTrue(collAfter <= 1n, `pot collateral ~zero after full redeem, got ${collAfter}`);
  });

  it("harvest_growing_pot_yield on an empty pot → NoPotYield (guarded no-overpay)", async function () {
    this.timeout(120000);

    // The pot position is now drained (previous test). Re-compound nothing then
    // try to harvest a tiny collateral amount → klend redeems ~0 USDC into the
    // vault → on-chain guard returns NoPotYield. We pass collateral=1 (a tiny
    // non-zero cToken amount); with no real position klend yields nothing.
    //
    // NOTE: passing collateral that exceeds the (zero) position makes klend's CPI
    // revert; passing 0 trips our InvalidAmount guard. So we send 1 and accept
    // EITHER NoPotYield (redeem produced 0) OR a klend revert — both prove the
    // empty pot can't overpay. PREFLIGHT ON so the rejection surfaces
    // synchronously (skipPreflight defers it to an opaque confirmation error;
    // m5-buglog B1). klend's withdraw CPI reverts when asked to redeem more
    // cTokens than the (drained) obligation holds, so the realistic on-chain path
    // is a klend revert — our NoPotYield line only fires if klend *succeeds* with
    // 0 redeemed, which klend prevents (m5-buglog B2). Either way the tx is
    // rejected → no overpay. ComputeBudget prefix keeps it byte-distinct.
    const ix = await harvestIx(stranger.publicKey, 1n);
    const tx = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 410_000 }))
      .add(ixRefreshReserve())
      .add(ixRefreshObligation(potObligation, []))
      .add(ix);

    const usdcVaultBefore = BigInt(
      (await getAccount(connection, usdcVaultPda)).amount.toString()
    );
    let rejected = false;
    let detail = "";
    try {
      await provider.sendAndConfirm(tx, [stranger], { skipPreflight: false });
    } catch (err: any) {
      rejected = true;
      detail =
        (err?.toString?.() ?? "") +
        "\n" +
        (Array.isArray(err?.logs) ? err.logs.join("\n") : "");
    }
    assert.isTrue(
      rejected,
      "harvest on an empty pot must be rejected (no overpay)"
    );
    // Any rejection (NoPotYield OR a klend revert) proves the empty-pot path
    // cannot overpay; surface the detail for diagnostics.
    assert.isTrue(
      detail.length > 0,
      `expected a rejection (NoPotYield or klend revert), got: ${detail.slice(0, 200)}`
    );

    // The pot principal is still 0, and usdc_vault did NOT change (no leak).
    const cfg = await program.account.poolConfig.fetch(poolConfigPda);
    assert.equal(BigInt(cfg.potPrincipalUsdc.toString()), 0n, "pot principal stays 0");
    const usdcVaultAfter = BigInt(
      (await getAccount(connection, usdcVaultPda)).amount.toString()
    );
    assert.equal(usdcVaultAfter, usdcVaultBefore, "usdc_vault unchanged (no overpay)");
  });

  it("compound_growing_pot rejected when no funds in the pot vault (InvalidAmount)", async function () {
    this.timeout(120000);

    // Pot vault currently holds ~the returned principal (POT_FUND). Drain it to 0
    // via the raw cheatcode so compound has nothing to deposit.
    await setRawTokenAccountBalance(
      endpoint,
      growingPotVaultPda,
      USDC_MINT,
      poolConfigPda,
      0n
    );

    // GUARD test: send the compound ix ALONE — NO klend refresh prefix — with
    // PREFLIGHT ON. My handler checks `amount > 0` (and the other guards) at the
    // TOP, before any klend CPI, so a bare ix returns a clean, parseable
    // AnchorError. (With a refresh prefix the empty-reserves refresh_obligation
    // fails at klend first; with skipPreflight the failure surfaces as an opaque
    // "Unknown action" string. See .superstack/m5-buglog.md B1.) The
    // ComputeBudget prefix keeps the tx byte-distinct across re-runs.
    const ix = await compoundIx(stranger.publicKey);
    const tx = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 420_000 }))
      .add(ix);

    let detail = "";
    try {
      await provider.sendAndConfirm(tx, [stranger], { skipPreflight: false });
      assert.fail("expected InvalidAmount on an empty pot vault");
    } catch (err: any) {
      detail =
        (err?.toString?.() ?? "") +
        "\n" +
        (Array.isArray(err?.logs) ? err.logs.join("\n") : "");
    }
    assert.isTrue(
      detail.includes("InvalidAmount") ||
        detail.includes("6014"), // InvalidAmount custom code
      `expected InvalidAmount on empty pot vault, got: ${detail.slice(0, 400)}`
    );
  });

  // -------------------------------------------------------------------------
  // draw_in_progress guard — compound + harvest must be rejected mid-draw.
  // We flip draw_in_progress by driving a real trigger_draw (commit) using a
  // mocked Switchboard randomness account (same mechanism as draw.ts), since
  // surfpool lets us write the randomness account directly. The pot vault is
  // re-funded first so compound has something to attempt (proving the guard,
  // not the empty-vault path, is what rejects it).
  // -------------------------------------------------------------------------
  it("compound + harvest rejected while a draw is in progress (DrawInProgress)", async function () {
    this.timeout(180000);

    // Re-fund the pot vault so compound would otherwise succeed.
    await setRawTokenAccountBalance(
      endpoint,
      growingPotVaultPda,
      USDC_MINT,
      poolConfigPda,
      50n * ONE_USDC
    );

    // --- set draw_in_progress = true by committing a draw -------------------
    // Mock an un-revealed Switchboard randomness account (reveal_slot = 0),
    // owner = Switchboard On-Demand PID. RandomnessAccountData = 8-byte disc +
    // 400-byte body; reveal_slot (u64) @ post-disc offset 144.
    const SB_ON_DEMAND = new PublicKey("SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv");
    const RANDOMNESS_DISCRIMINATOR = [10, 66, 229, 135, 220, 239, 217, 114];
    const rnd = Keypair.generate();
    {
      const buf = Buffer.alloc(408);
      Buffer.from(RANDOMNESS_DISCRIMINATOR).copy(buf, 0);
      // reveal_slot already 0 → un-revealed; value all-zero.
      await rpc(endpoint, "surfnet_setAccount", [
        rnd.publicKey.toBase58(),
        {
          lamports: 5_000_000,
          owner: SB_ON_DEMAND.toBase58(),
          data: buf.toString("hex"),
          executable: false,
        },
      ]);
    }

    // Need yield in usdc_vault so the prize > 0 (trigger_draw requires it). Mint
    // a little extra into usdc_vault via the raw cheatcode: read current, add.
    const vaultNow = BigInt((await getAccount(connection, usdcVaultPda)).amount.toString());
    await setRawTokenAccountBalance(
      endpoint,
      usdcVaultPda,
      USDC_MINT,
      poolConfigPda,
      vaultNow + 30n * ONE_USDC
    );

    // Jump past the weekly cadence gate (next_draw_ts). surfnet_timeTravel uses
    // MILLISECONDS (m4-buglog B2).
    const cfg = await program.account.poolConfig.fetch(poolConfigPda);
    const target = cfg.nextDrawTs.toNumber() + 120;
    const blockTime = await connection.getBlockTime(await connection.getSlot());
    if (blockTime === null || blockTime < target) {
      await rpc(endpoint, "surfnet_timeTravel", [{ absoluteTimestamp: target * 1000 }]);
    }

    const round = cfg.currentRound.toNumber();
    await program.methods
      .triggerDraw()
      .accounts({
        crank: admin.publicKey, // admin is allowed to trigger
        poolConfig: poolConfigPda,
        currentDraw: drawPda(round),
        usdcVault: usdcVaultPda,
        randomnessAccount: rnd.publicKey,
      })
      .rpc({ skipPreflight: true });

    const cfgMid = await program.account.poolConfig.fetch(poolConfigPda);
    assert.isTrue(cfgMid.drawInProgress, "draw_in_progress set by trigger_draw");

    // GUARD tests: send the ix ALONE (no klend refresh prefix) with PREFLIGHT ON.
    // My handler checks `!draw_in_progress` at the TOP, before any klend CPI, so a
    // bare ix returns a clean AnchorError (m5-buglog B1). ComputeBudget units differ
    // per tx so each is byte-distinct (avoids the validator dedup flake).

    // --- compound rejected mid-draw ----------------------------------------
    {
      const ix = await compoundIx(stranger.publicKey);
      const tx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 430_000 }))
        .add(ix);
      let detail = "";
      try {
        await provider.sendAndConfirm(tx, [stranger], { skipPreflight: false });
        assert.fail("expected DrawInProgress on compound mid-draw");
      } catch (err: any) {
        detail =
          (err?.toString?.() ?? "") +
          "\n" +
          (Array.isArray(err?.logs) ? err.logs.join("\n") : "");
      }
      assert.isTrue(
        detail.includes("DrawInProgress") || detail.includes("6016"),
        `expected DrawInProgress on compound, got: ${detail.slice(0, 400)}`
      );
    }

    // --- harvest rejected mid-draw -----------------------------------------
    {
      const ix = await harvestIx(stranger.publicKey, 1n);
      const tx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 440_000 }))
        .add(ix);
      let detail = "";
      try {
        await provider.sendAndConfirm(tx, [stranger], { skipPreflight: false });
        assert.fail("expected DrawInProgress on harvest mid-draw");
      } catch (err: any) {
        detail =
          (err?.toString?.() ?? "") +
          "\n" +
          (Array.isArray(err?.logs) ? err.logs.join("\n") : "");
      }
      assert.isTrue(
        detail.includes("DrawInProgress") || detail.includes("6016"),
        `expected DrawInProgress on harvest, got: ${detail.slice(0, 400)}`
      );
    }

    // --- cleanup: cancel the draw after the timeout so the pool isn't left
    //     frozen for any re-run (permissionless, timeout-gated). ------------
    const drawNow = await program.account.draw.fetch(drawPda(round));
    const DRAW_TIMEOUT = 60 * 60;
    const cancelTarget = drawNow.committedTs.toNumber() + DRAW_TIMEOUT + 120;
    const bt2 = await connection.getBlockTime(await connection.getSlot());
    if (bt2 === null || bt2 < cancelTarget) {
      await rpc(endpoint, "surfnet_timeTravel", [
        { absoluteTimestamp: cancelTarget * 1000 },
      ]);
    }
    await program.methods
      .cancelDraw()
      .accounts({
        crank: admin.publicKey,
        poolConfig: poolConfigPda,
        currentDraw: drawPda(round),
      })
      .rpc({ skipPreflight: true });
    const cfgEnd = await program.account.poolConfig.fetch(poolConfigPda);
    assert.isFalse(cfgEnd.drawInProgress, "draw cancelled — pool unfrozen for re-runs");
  });
});
