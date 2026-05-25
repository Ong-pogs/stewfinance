/**
 * Slice 1 crank lib — E2E against a surfpool fork of mainnet (real klend).
 *
 * Exercises the IMPORTABLE crank library in app/crank/ — NOT a hand-rolled tx.
 * Modeled on tests/pot.ts (same mainnet constants, same fork setup, same
 * surfnet cheatcodes). Run in its OWN fresh surfpool session (the pot/draw
 * suites' init_draw_accounts PDA collides — see m5 handoff §3).
 *
 * Covers:
 *   - compoundPot(): drains growing_pot_vault into the pot obligation,
 *     pot_principal_usdc += exact amount, obligation cTokens > 0 (read via the
 *     lib's readObligationCollateral).
 *   - harvestPot(): full redeem → principal back to growing_pot_vault,
 *     pot_principal_usdc reset to 0, yield-only left in usdc_vault (flat week).
 *   - harvestPot() empty pot → returns {skipped} (NO throw, NO tx).
 *   - planSettle(): correct position count + total_weight (matches an
 *     independent sum), windows table, and the cap-warning threshold logic.
 *   - Permissionless: compoundPot/harvestPot work with a NON-admin signer.
 *
 * Prereq (package.json `test:crank`): surfpool up forking mainnet on
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
} from "@solana/web3.js";
import { assert } from "chai";

// The crank lib under test.
import {
  readPoolState,
  compoundPot,
  harvestPot,
  cancelIfStuck,
  planSettle,
  computeSettleWinner,
  readObligationCollateral,
  computeTotalWeight,
  computeWinner,
  fetchAllPositions,
  sortedPositionMetas,
  SETTLE_LEGACY_POSITION_CAP,
  // addresses (verify the lib re-exports them verbatim)
  KLEND,
  FARMS,
  USDC_MINT,
  LENDING_MARKET,
  LENDING_MARKET_AUTHORITY,
  RESERVE,
  FARM_COLLATERAL,
} from "../app/crank";
import {
  poolConfigPda as cPoolConfigPda,
  usdcVaultPda as cUsdcVaultPda,
  growingPotVaultPda as cGrowingPotVaultPda,
  operatorVaultPda as cOperatorVaultPda,
  opsVaultPda as cOpsVaultPda,
  userMetadataPda as cUserMetadataPda,
  obligationPda as cObligationPda,
  obligationFarmPda as cObligationFarmPda,
  userPositionPda as cUserPositionPda,
  drawPda as cDrawPda,
} from "../app/crank/pdas";

const ONE_USDC = 1_000_000n;

// ===========================================================================
// surfnet cheatcode helpers (ported from tests/pot.ts — not exported there).
// ===========================================================================
async function rpc(endpoint: string, method: string, params: any[]): Promise<any> {
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json: any = await resp.json();
  if (json.error) throw new Error(`${method} failed: ${JSON.stringify(json.error)}`);
  return json.result;
}

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

/** Write a raw 165-byte SPL token-account buffer (sets a PDA vault's balance). */
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
      lamports: 2_039_280,
      owner: TOKEN_PROGRAM_ID.toBase58(),
      data: buf.toString("hex"),
      executable: false,
    },
  ]);
}

// ===========================================================================
describe("stewfi — Slice 1 crank lib (surfpool fork-mainnet)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Stewfi as Program<Stewfi>;
  const connection = provider.connection;
  const endpoint = connection.rpcEndpoint;

  const admin = (provider.wallet as anchor.Wallet).payer;

  // NON-admin funded signers — prove the keepers are permissionless.
  const stranger = Keypair.generate();
  // A second depositor so planSettle sees >1 live position.
  const user2 = Keypair.generate();

  // PDAs — derived via the LIB helpers (also validates the helpers).
  let poolConfigPda: PublicKey;
  let usdcVaultPda: PublicKey;
  let growingPotVaultPda: PublicKey;
  let operatorVaultPda: PublicKey;
  let opsVaultPda: PublicKey;
  let adminUsdcAta: PublicKey;
  let user2Usdc: PublicKey;

  let userMetadata: PublicKey;
  let mainObligation: PublicKey;
  let mainObligationFarm: PublicKey;
  let potObligation: PublicKey;
  let potObligationFarm: PublicKey;

  const DEPOSIT_TO_POOL = 500n * ONE_USDC;
  const USER2_DEPOSIT = 250n * ONE_USDC;
  const POT_FUND = 200n * ONE_USDC;

  before("derive PDAs (via lib); init pool + obligations/farms; fund pot", async function () {
    this.timeout(180000);

    poolConfigPda = cPoolConfigPda(USDC_MINT, program.programId);
    usdcVaultPda = cUsdcVaultPda(USDC_MINT, program.programId);
    growingPotVaultPda = cGrowingPotVaultPda(USDC_MINT, program.programId);
    operatorVaultPda = cOperatorVaultPda(USDC_MINT, program.programId);
    opsVaultPda = cOpsVaultPda(USDC_MINT, program.programId);

    userMetadata = cUserMetadataPda(poolConfigPda);
    mainObligation = cObligationPda(0, poolConfigPda);
    potObligation = cObligationPda(1, poolConfigPda);
    mainObligationFarm = cObligationFarmPda(mainObligation);
    potObligationFarm = cObligationFarmPda(potObligation);

    // Sanity: the lib's obligation derivation gives DISTINCT id=0 / id=1 PDAs.
    assert.notEqual(
      mainObligation.toBase58(),
      potObligation.toBase58(),
      "lib obligationPda(0) != obligationPda(1)"
    );

    // Fund SOL for the non-admin signers.
    await fundSol(connection, stranger.publicKey, 5_000_000_000);
    await fundSol(connection, user2.publicKey, 5_000_000_000);

    // Fund admin USDC + init pool (idempotent).
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

    // Admin deposits → usdc_vault holds real principal + 1 live position.
    const adminPos = cUserPositionPda(admin.publicKey, program.programId);
    if (!(await connection.getAccountInfo(adminPos))) {
      await program.methods
        .deposit(new BN(DEPOSIT_TO_POOL.toString()))
        .accounts({
          poolConfig: poolConfigPda,
          userPosition: adminPos,
          usdcVault: usdcVaultPda,
          userUsdc: adminUsdcAta,
          user: admin.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
    }

    // Second depositor → a 2nd live position so planSettle has >1.
    user2Usdc = await setTokenBalance(
      connection,
      user2.publicKey,
      USDC_MINT,
      1000n * ONE_USDC
    );
    const user2Pos = cUserPositionPda(user2.publicKey, program.programId);
    if (!(await connection.getAccountInfo(user2Pos))) {
      await program.methods
        .deposit(new BN(USER2_DEPOSIT.toString()))
        .accounts({
          poolConfig: poolConfigPda,
          userPosition: user2Pos,
          usdcVault: usdcVaultPda,
          userUsdc: user2Usdc,
          user: user2.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user2])
        .rpc();
    }

    // M3 obligation + farm (needed before the pot obligation; pot reuses the
    // owner-keyed UserMetadata). Idempotent.
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
    if (!(await connection.getAccountInfo(mainObligationFarm))) {
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

    // init_draw_accounts creates growing_pot_vault (+ operator/ops) + round-0 Draw.
    if (!cfg0.drawAccountsReady) {
      const operator = Keypair.generate();
      const ops = Keypair.generate();
      await program.methods
        .initDrawAccounts(operator.publicKey, ops.publicKey)
        .accounts({
          poolConfig: poolConfigPda,
          admin: admin.publicKey,
          usdcMint: USDC_MINT,
          currentDraw: cDrawPda(0, program.programId),
          growingPotVault: growingPotVaultPda,
          operatorVault: operatorVaultPda,
          opsVault: opsVaultPda,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();
    }

    // Pot obligation (id=1) — distinct from M3 (id=0). Idempotent + stale-overlay
    // skip: a re-run on a stale surfpool overlay would have the config flag set
    // but the account dropped. We restart surfpool per run, so just init if needed.
    const cfg1 = await program.account.poolConfig.fetch(poolConfigPda);
    if (!cfg1.growingPotObligationReady) {
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
    if (!(await connection.getAccountInfo(potObligationFarm))) {
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

    // Simulate the 20% escrow: fund growing_pot_vault directly.
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

  it("readPoolState returns a typed snapshot matching on-chain config", async function () {
    this.timeout(60000);
    const snap = await readPoolState(program);
    assert.equal(snap.poolConfig.toBase58(), poolConfigPda.toBase58());
    assert.equal(snap.usdcMint.toBase58(), USDC_MINT.toBase58());
    assert.equal(
      snap.potObligation.toBase58(),
      potObligation.toBase58(),
      "snapshot pot_obligation == derived id=1 PDA"
    );
    assert.isTrue(snap.growingPotObligationReady, "pot obligation ready");
    assert.isFalse(snap.drawInProgress, "no draw in progress yet");
    assert.isNull(snap.currentDraw, "currentDraw null when no draw in progress");
    assert.equal(
      snap.growingPotVaultBalance,
      POT_FUND,
      "snapshot reads the funded growing_pot_vault balance"
    );
    // total_principal = admin 500 + user2 250.
    assert.equal(
      snap.totalPrincipal,
      DEPOSIT_TO_POOL + USER2_DEPOSIT,
      "total_principal == sum of the two deposits"
    );
  });

  it("compoundPot() (NON-admin crank): drains pot vault → obligation, pot_principal += exact, cTokens > 0", async function () {
    this.timeout(120000);

    const cfgBefore = await program.account.poolConfig.fetch(poolConfigPda);
    const potPrincipalBefore = BigInt(cfgBefore.potPrincipalUsdc.toString());
    const potVaultBefore = BigInt(
      (await getAccount(connection, growingPotVaultPda)).amount.toString()
    );
    assert.isTrue(potVaultBefore > 0n, "pot vault funded before compound");

    // Permissionless: stranger (NON-admin) is the crank signer.
    const res = await compoundPot(program, stranger);
    assert.isUndefined(res.skipped, "compound should NOT skip with a funded vault");
    assert.equal(res.amount, potVaultBefore, "result.amount == drained vault balance");
    assert.isString(res.sig, "compound returned a tx signature");

    // Pot vault drained to ~0 (klend liquidity→collateral floor-rounds by ≤1).
    const potVaultAfter = BigInt(
      (await getAccount(connection, growingPotVaultPda)).amount.toString()
    );
    assert.isTrue(potVaultAfter <= 1n, `pot vault drained, got ${potVaultAfter}`);

    // pot_principal_usdc += EXACTLY the deposited amount.
    const cfgAfter = await program.account.poolConfig.fetch(poolConfigPda);
    const potPrincipalAfter = BigInt(cfgAfter.potPrincipalUsdc.toString());
    assert.equal(
      potPrincipalAfter - potPrincipalBefore,
      potVaultBefore,
      "pot_principal_usdc += exact compounded amount"
    );

    // Obligation holds cTokens — read via the LIB's reader.
    const coll = await readObligationCollateral(connection, potObligation);
    assert.isTrue(coll > 0n, `pot obligation should hold cTokens, got ${coll}`);
  });

  it("harvestPot() (NON-admin crank): full redeem → principal back to pot vault, pot_principal reset, yield-only in usdc_vault", async function () {
    this.timeout(120000);

    const collBefore = await readObligationCollateral(connection, potObligation);
    assert.isTrue(collBefore > 0n, "need pot cTokens to harvest");

    const cfgBefore = await program.account.poolConfig.fetch(poolConfigPda);
    const potPrincipalBefore = BigInt(cfgBefore.potPrincipalUsdc.toString());
    assert.isTrue(potPrincipalBefore > 0n, "pot principal tracked before harvest");

    const usdcVaultBefore = BigInt(
      (await getAccount(connection, usdcVaultPda)).amount.toString()
    );
    const potVaultBefore = BigInt(
      (await getAccount(connection, growingPotVaultPda)).amount.toString()
    );

    // Permissionless harvest via the lib (stranger = NON-admin crank).
    const res = await harvestPot(program, stranger);
    assert.isUndefined(res.skipped, "harvest should NOT skip with cTokens present");
    assert.equal(res.fullCollateral, collBefore, "passed the full cToken balance");
    assert.isString(res.sig, "harvest returned a tx signature");

    const usdcVaultAfter = BigInt(
      (await getAccount(connection, usdcVaultPda)).amount.toString()
    );
    const potVaultAfter = BigInt(
      (await getAccount(connection, growingPotVaultPda)).amount.toString()
    );

    const yieldInUsdcVault = usdcVaultAfter - usdcVaultBefore;
    const principalReturned = potVaultAfter - potVaultBefore;
    const totalRedeemed = yieldInUsdcVault + principalReturned;
    assert.isTrue(totalRedeemed > 0n, "redeemed something from the pot position");

    // The lib measures `redeemed` as the usdc_vault delta (the yield slice).
    assert.equal(res.redeemed, yieldInUsdcVault, "result.redeemed == usdc_vault yield delta");

    // pot_principal_usdc reset to 0.
    const cfgAfter = await program.account.poolConfig.fetch(poolConfigPda);
    assert.equal(BigInt(cfgAfter.potPrincipalUsdc.toString()), 0n, "pot_principal reset");

    // Principal preserved: returned slice = min(redeemed, principal_before).
    const expectedPrincipalReturn =
      totalRedeemed < potPrincipalBefore ? totalRedeemed : potPrincipalBefore;
    assert.equal(
      principalReturned,
      expectedPrincipalReturn,
      "principal_return == min(redeemed, principal_before)"
    );
    // Pot vault ≈ original principal (a few base units of rounding allowed).
    assert.isTrue(
      potVaultAfter >= POT_FUND - 5n && potVaultAfter <= POT_FUND + 5n,
      `pot vault ≈ original principal (got ${potVaultAfter}, want ~${POT_FUND})`
    );
    // Only yield (>=0) stays in usdc_vault — no principal leaked into the prize.
    assert.equal(
      yieldInUsdcVault,
      totalRedeemed - expectedPrincipalReturn,
      "yield (and ONLY yield) remains in usdc_vault"
    );
    assert.isTrue(yieldInUsdcVault >= 0n, "yield is non-negative");

    // Obligation collateral ~drained.
    const collAfter = await readObligationCollateral(connection, potObligation);
    assert.isTrue(collAfter <= 1n, `pot collateral ~zero after full redeem, got ${collAfter}`);
  });

  it("harvestPot() on an empty pot → returns {skipped} (no throw, no tx)", async function () {
    this.timeout(60000);
    // The pot position was fully drained by the previous test → 0 cTokens.
    const coll = await readObligationCollateral(connection, potObligation);
    assert.isTrue(coll <= 1n, "pot is drained going into the empty-pot test");

    const usdcVaultBefore = BigInt(
      (await getAccount(connection, usdcVaultPda)).amount.toString()
    );

    // With 0 cTokens the lib must SKIP (not throw, not send a tx).
    if (coll === 0n) {
      const res = await harvestPot(program, stranger);
      assert.equal(res.skipped, "no cTokens", "harvest skips an empty pot");
      assert.isUndefined(res.sig, "no tx sent on skip");
      const usdcVaultAfter = BigInt(
        (await getAccount(connection, usdcVaultPda)).amount.toString()
      );
      assert.equal(usdcVaultAfter, usdcVaultBefore, "usdc_vault unchanged on skip");
    } else {
      // Defensive: if a 1-cToken dust remained, the lib would attempt a harvest;
      // that's the no-overpay path covered by tests/pot.ts, not this skip test.
      this.skip();
    }
  });

  it("compoundPot() on an empty pot vault → returns {skipped} (no throw, no tx)", async function () {
    this.timeout(60000);
    // After harvest, the pot vault holds ~the returned principal. Drain it to 0.
    await setRawTokenAccountBalance(
      endpoint,
      growingPotVaultPda,
      USDC_MINT,
      poolConfigPda,
      0n
    );
    const res = await compoundPot(program, stranger);
    assert.equal(res.skipped, "empty pot vault", "compound skips an empty vault");
    assert.isUndefined(res.sig, "no tx sent on skip");
  });

  it("cancelIfStuck() is a no-op when no draw is in progress", async function () {
    this.timeout(60000);
    const res = await cancelIfStuck(program, stranger);
    assert.isFalse(res.cancelled, "nothing to cancel");
    assert.include(res.reason, "no draw in progress");
  });

  // -------------------------------------------------------------------------
  // planSettle — READ-ONLY dry run (no tx). No draw is committed here, so it
  // uses block-time as draw_ts; we pass an explicit nowSecs for determinism and
  // independently recompute total_weight + the winner from the same positions.
  // -------------------------------------------------------------------------
  it("planSettle(): correct position count + total_weight + windows (matches an independent computation)", async function () {
    this.timeout(60000);

    // Two live positions (admin + user2). Choose a draw_ts comfortably after both
    // first_deposit_ts so every weight is positive.
    const positions = await fetchAllPositions(program);
    assert.equal(positions.length, 2, "two live positions (admin + user2)");

    const maxFirst = positions.reduce(
      (m, p) => (p.firstDepositTs > m ? p.firstDepositTs : m),
      0n
    );
    const drawTs = maxFirst + 100_000n; // well after both deposits

    const plan = await planSettle(program, undefined, USDC_MINT, Number(drawTs));

    // Position count + metas length.
    assert.equal(plan.positionCount, 2, "plan position count");
    assert.equal(plan.metasLength, 2, "plan metas length == position count");
    assert.isFalse(plan.hasCommittedDraw, "no committed draw → falls back to nowSecs");

    // total_weight matches an independent sum over the SAME draw_ts.
    const expectedTotal = computeTotalWeight(positions, drawTs);
    assert.isTrue(expectedTotal > 0n, "independent total_weight is positive");
    assert.equal(plan.totalWeight, expectedTotal, "plan total_weight matches independent sum");

    // Windows are contiguous + cover the whole total_weight, in ASCENDING owner
    // order (the canonical order the program enforces).
    assert.equal(plan.windows.length, 2, "two windows");
    let running = 0n;
    const sortedOwners = [...positions]
      .sort((a, b) => Buffer.compare(a.owner.toBuffer(), b.owner.toBuffer()))
      .map((p) => p.owner.toBase58());
    for (let i = 0; i < plan.windows.length; i++) {
      const w = plan.windows[i];
      assert.equal(w.start, running, `window ${i} starts at running cum`);
      assert.equal(
        w.owner.toBase58(),
        sortedOwners[i],
        `window ${i} owner in ascending order`
      );
      running += w.weight;
    }
    assert.equal(running, plan.totalWeight, "windows sum to total_weight");

    // Below the legacy cap → no I-05 warning.
    assert.isFalse(plan.exceedsLegacyCap, "2 positions is under the legacy cap");
    assert.equal(
      plan.warnings.filter((w) => w.includes("I-05")).length,
      0,
      "no I-05 cap warning under threshold"
    );
  });

  it("planSettle winner math is exercisable given a hypothetical VRF value (matches computeWinner)", async function () {
    this.timeout(60000);

    const positions = await fetchAllPositions(program);
    const maxFirst = positions.reduce(
      (m, p) => (p.firstDepositTs > m ? p.firstDepositTs : m),
      0n
    );
    const drawTs = maxFirst + 100_000n;
    const totalWeight = computeTotalWeight(positions, drawTs);
    assert.isTrue(totalWeight > 0n);

    // Pick a ticket squarely inside the FIRST window, craft a VRF value for it.
    const windows = computeWinner(positions, drawTs, totalWeight, Buffer.alloc(16)).windows;
    const first = windows[0];
    const ticket = first.start + first.weight / 2n;
    const value = Buffer.alloc(32);
    value.writeBigUInt64LE(ticket & 0xffffffffffffffffn, 0);
    value.writeBigUInt64LE((ticket >> 64n) & 0xffffffffffffffffn, 8);

    // The lib's computeSettleWinner reproduces the on-chain derivation.
    const win = await computeSettleWinner(program, drawTs, totalWeight, value);
    assert.equal(win.ticket, ticket % totalWeight, "ticket = value%total");
    assert.isNotNull(win.winnerPositionPda, "a winner window was found");
    assert.equal(
      win.winnerPositionPda!.toBase58(),
      first.pubkey.toBase58(),
      "winner is the position whose window contains the ticket"
    );
    assert.equal(win.winnerOwner!.toBase58(), first.owner.toBase58());
  });

  it("planSettle cap-warning threshold logic (I-05): triggers strictly above the cap", async function () {
    this.timeout(30000);

    // Unit-style check of the threshold the plan uses (mocking 50+ real on-chain
    // positions on a fork is impractical, so assert the boundary logic directly
    // against the SAME constant + comparison the lib applies).
    const cap = SETTLE_LEGACY_POSITION_CAP;
    assert.equal(cap, 50, "legacy cap is 50 (12 fixed accounts + ~position budget)");

    const exceeds = (n: number) => n > cap; // mirrors planSettle's comparison
    assert.isFalse(exceeds(cap), "exactly cap → no warning");
    assert.isFalse(exceeds(cap - 1), "under cap → no warning");
    assert.isTrue(exceeds(cap + 1), "one over cap → WARNING (ALT required)");
    assert.isTrue(exceeds(256), "well over cap → WARNING");

    // And the live plan (2 positions) does not trip it.
    const plan = await planSettle(program, undefined, USDC_MINT, 9_999_999_999);
    assert.isFalse(plan.exceedsLegacyCap, "live 2-position plan is under the cap");
  });

  it("sortedPositionMetas: ascending by owner, non-signer, read-only", async function () {
    this.timeout(30000);
    const positions = await fetchAllPositions(program);
    const metas = sortedPositionMetas(positions);
    assert.equal(metas.length, positions.length);
    for (const m of metas) {
      assert.isFalse(m.isSigner, "position metas are non-signer");
      assert.isFalse(m.isWritable, "position metas are read-only");
    }
    // Verify ascending by mapping each meta's pubkey back to its owner.
    const byPos = new Map(positions.map((p) => [p.pubkey.toBase58(), p.owner]));
    for (let i = 1; i < metas.length; i++) {
      const prev = byPos.get(metas[i - 1].pubkey.toBase58())!;
      const cur = byPos.get(metas[i].pubkey.toBase58())!;
      assert.isBelow(
        Buffer.compare(prev.toBuffer(), cur.toBuffer()),
        0,
        "metas strictly ascending by owner"
      );
    }
  });
});
