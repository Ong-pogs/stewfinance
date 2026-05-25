/**
 * StewFi off-chain operator crank — Slice 1 (the permissionless / read-only
 * foundation): pot keeper (harvest + compound) and a settle DRY-RUN planner.
 *
 * This is a plain-TS library, importable by tests and a future scheduler. Each
 * public function takes the Anchor `Program<Stewfi>` plus the signer to use, so
 * callers control the provider/keypair. The pot keepers build + send the tx with
 * the ComputeBudget + klend refresh prepend (refresh_reserve + refresh_obligation
 * for the POT obligation) that klend requires.
 *
 * NOT in Slice 1 (Slice 2): Switchboard/VRF bundling, the scheduler/run.ts loop,
 * and operator-gated draw txs (trigger_draw / settle_draw). planSettle here is a
 * READ-ONLY dry run that exercises the winner math but sends no transaction.
 */
import {
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
  Keypair,
  Signer,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import { getAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Program, BN } from "@coral-xyz/anchor";
import { Stewfi } from "../../target/types/stewfi";

import {
  KLEND,
  FARMS,
  USDC_MINT,
  LENDING_MARKET,
  LENDING_MARKET_AUTHORITY,
  RESERVE,
  RESERVE_LIQUIDITY_SUPPLY,
  RESERVE_COLLATERAL_MINT,
  RESERVE_DEST_DEPOSIT_COLLATERAL,
  RESERVE_SOURCE_COLLATERAL,
  FARM_COLLATERAL,
  DRAW_TIMEOUT_SECS,
  SETTLE_LEGACY_POSITION_CAP,
  KLEND_COMPUTE_UNIT_LIMIT,
} from "./constants";
import {
  poolConfigPda,
  usdcVaultPda,
  growingPotVaultPda,
  drawPda,
  obligationFarmPda,
} from "./pdas";
import {
  ixRefreshReserve,
  ixRefreshObligation,
  readObligationDepositReserves,
  readObligationCollateral,
} from "./klend";
import {
  fetchAllPositions,
  sortedPositionMetas,
  computeTotalWeight,
  computeWinner,
  PositionEntry,
  WinnerWindow,
} from "./positions";

// Re-export the sub-modules so callers can `import { ... } from "app/crank"`.
export * from "./constants";
export * from "./pdas";
export * from "./klend";
export * from "./positions";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Normalize an Anchor enum object ({pending:{}} etc.) to its lowercase tag. */
function drawStatusTag(status: any): string {
  if (!status || typeof status !== "object") return "unknown";
  const keys = Object.keys(status);
  return keys.length > 0 ? keys[0] : "unknown";
}

/** Read an SPL token account's amount; returns 0n if the account doesn't exist. */
async function tokenAmount(
  program: Program<Stewfi>,
  tokenAccount: PublicKey
): Promise<bigint> {
  try {
    const acc = await getAccount(program.provider.connection, tokenAccount);
    return BigInt(acc.amount.toString());
  } catch {
    return 0n;
  }
}

/** ComputeBudget OBJECT-arg form (tests use {units: ...}, NOT a bare number). */
function computeBudgetIx(units: number = KLEND_COMPUTE_UNIT_LIMIT) {
  return ComputeBudgetProgram.setComputeUnitLimit({ units });
}

// ---------------------------------------------------------------------------
// readPoolState — typed snapshot of PoolConfig (+ current Draw if mid-draw).
// ---------------------------------------------------------------------------
export interface PoolSnapshot {
  poolConfig: PublicKey;
  admin: PublicKey;
  operator: PublicKey;
  ops: PublicKey;
  usdcMint: PublicKey;
  paused: boolean;
  drawInProgress: boolean;
  currentRound: bigint;
  totalPrincipal: bigint;
  pendingWinnings: bigint;
  nextDrawTs: bigint;
  drawInterval: bigint;
  drawAccountsReady: boolean;
  // Kamino main pool
  kaminoObligation: PublicKey;
  kaminoDeposited: bigint;
  // Pot (M5)
  potObligation: PublicKey;
  potPrincipalUsdc: bigint;
  growingPotObligationReady: boolean;
  // Live balances (read at snapshot time)
  usdcVaultBalance: bigint;
  growingPotVaultBalance: bigint;
  /** The current round's Draw, if one is committed/in-progress; else null. */
  currentDraw: DrawSnapshot | null;
}

export interface DrawSnapshot {
  round: bigint;
  status: string;
  randomnessAccount: PublicKey;
  drawTs: bigint;
  committedTs: bigint;
  totalWeight: bigint;
  prizePool: bigint;
  winner: PublicKey;
}

/** Fetch PoolConfig (+ the current Draw if a draw is in progress). */
export async function readPoolState(
  program: Program<Stewfi>,
  mint: PublicKey = USDC_MINT
): Promise<PoolSnapshot> {
  const pc = poolConfigPda(mint, program.programId);
  const cfg = await program.account.poolConfig.fetch(pc);

  const usdcVault = usdcVaultPda(mint, program.programId);
  const growingPotVault = growingPotVaultPda(mint, program.programId);

  let currentDraw: DrawSnapshot | null = null;
  if (cfg.drawInProgress) {
    const draw = drawPda(cfg.currentRound.toString(), program.programId);
    try {
      const d = await program.account.draw.fetch(draw);
      currentDraw = {
        round: BigInt(d.round.toString()),
        status: drawStatusTag(d.status),
        randomnessAccount: d.randomnessAccount as PublicKey,
        drawTs: BigInt(d.drawTs.toString()),
        committedTs: BigInt(d.committedTs.toString()),
        totalWeight: BigInt(d.totalWeight.toString()),
        prizePool: BigInt(d.prizePool.toString()),
        winner: d.winner as PublicKey,
      };
    } catch {
      currentDraw = null;
    }
  }

  return {
    poolConfig: pc,
    admin: cfg.admin as PublicKey,
    operator: cfg.operator as PublicKey,
    ops: cfg.ops as PublicKey,
    usdcMint: cfg.usdcMint as PublicKey,
    paused: cfg.paused,
    drawInProgress: cfg.drawInProgress,
    currentRound: BigInt(cfg.currentRound.toString()),
    totalPrincipal: BigInt(cfg.totalPrincipal.toString()),
    pendingWinnings: BigInt(cfg.pendingWinnings.toString()),
    nextDrawTs: BigInt(cfg.nextDrawTs.toString()),
    drawInterval: BigInt(cfg.drawInterval.toString()),
    drawAccountsReady: cfg.drawAccountsReady,
    kaminoObligation: cfg.kaminoObligation as PublicKey,
    kaminoDeposited: BigInt(cfg.kaminoDeposited.toString()),
    potObligation: cfg.potObligation as PublicKey,
    potPrincipalUsdc: BigInt(cfg.potPrincipalUsdc.toString()),
    growingPotObligationReady: cfg.growingPotObligationReady,
    usdcVaultBalance: await tokenAmount(program, usdcVault),
    growingPotVaultBalance: await tokenAmount(program, growingPotVault),
    currentDraw,
  };
}

// ---------------------------------------------------------------------------
// harvestPot — permissionless full-redeem of the pot position into usdc_vault.
// ---------------------------------------------------------------------------
export interface HarvestResult {
  /** Set when nothing to do (no cTokens) — no tx sent. */
  skipped?: string;
  /** The full cToken balance passed to harvest (when sent). */
  fullCollateral?: bigint;
  /** Net USDC the pot redeem added to usdc_vault (the yield slice). */
  redeemed?: bigint;
  /** Transaction signature, when a tx was sent. */
  sig?: string;
}

/**
 * Permissionless. Run BEFORE trigger_draw each week. Reads the pot's full cToken
 * balance (readObligationCollateral); if 0n, skips (no tx). Otherwise builds
 * ComputeBudget(600k) + refresh_reserve + refresh_obligation(pot) +
 * harvest_growing_pot_yield(fullCollateral) and sends it with `crankKp` (any
 * funded signer — does NOT need to be admin/operator).
 *
 * `redeemed` is measured as the usdc_vault delta (the yield slice the program
 * leaves behind after returning principal to growing_pot_vault).
 */
export async function harvestPot(
  program: Program<Stewfi>,
  crankKp: Signer,
  mint: PublicKey = USDC_MINT
): Promise<HarvestResult> {
  const connection = program.provider.connection;
  const pc = poolConfigPda(mint, program.programId);
  const cfg = await program.account.poolConfig.fetch(pc);
  const potObligation = cfg.potObligation as PublicKey;

  const fullCollateral = await readObligationCollateral(
    connection,
    potObligation
  );
  if (fullCollateral === 0n) {
    return { skipped: "no cTokens" };
  }

  const usdcVault = usdcVaultPda(mint, program.programId);
  const growingPotVault = growingPotVaultPda(mint, program.programId);
  const obligationFarm = obligationFarmPda(potObligation);

  const usdcVaultBefore = await tokenAmount(program, usdcVault);

  const ix = await program.methods
    .harvestGrowingPotYield(new BN(fullCollateral.toString()))
    .accountsPartial({
      poolConfig: pc,
      crank: crankKp.publicKey,
      usdcVault,
      growingPotVault,
      obligation: potObligation,
      lendingMarket: LENDING_MARKET,
      lendingMarketAuthority: LENDING_MARKET_AUTHORITY,
      reserve: RESERVE,
      reserveLiquidityMint: mint,
      reserveSourceCollateral: RESERVE_SOURCE_COLLATERAL,
      reserveCollateralMint: RESERVE_COLLATERAL_MINT,
      reserveLiquiditySupply: RESERVE_LIQUIDITY_SUPPLY,
      collateralTokenProgram: TOKEN_PROGRAM_ID,
      liquidityTokenProgram: TOKEN_PROGRAM_ID,
      instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
      obligationFarmUserState: obligationFarm,
      reserveFarmState: FARM_COLLATERAL,
      farmsProgram: FARMS,
      klendProgram: KLEND,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();

  const depReserves = await readObligationDepositReserves(
    connection,
    potObligation
  );
  const tx = new Transaction()
    .add(computeBudgetIx())
    .add(ixRefreshReserve())
    .add(ixRefreshObligation(potObligation, depReserves))
    .add(ix);

  const sig = await program.provider.sendAndConfirm!(tx, [crankKp], {
    skipPreflight: true,
  });

  const usdcVaultAfter = await tokenAmount(program, usdcVault);
  const redeemed = usdcVaultAfter - usdcVaultBefore;

  return { fullCollateral, redeemed, sig };
}

// ---------------------------------------------------------------------------
// compoundPot — permissionless deposit of the whole growing_pot_vault into klend.
// ---------------------------------------------------------------------------
export interface CompoundResult {
  skipped?: string;
  amount?: bigint;
  sig?: string;
}

/**
 * Permissionless. Reads the growing_pot_vault balance; if 0, skips (no tx).
 * Otherwise builds ComputeBudget(600k) + refresh_reserve + refresh_obligation(pot)
 * + compound_growing_pot and sends it with `crankKp` (any funded signer). The
 * program deposits the ENTIRE pot vault and adds the exact amount to
 * pot_principal_usdc.
 */
export async function compoundPot(
  program: Program<Stewfi>,
  crankKp: Signer,
  mint: PublicKey = USDC_MINT
): Promise<CompoundResult> {
  const connection = program.provider.connection;
  const pc = poolConfigPda(mint, program.programId);
  const cfg = await program.account.poolConfig.fetch(pc);
  const potObligation = cfg.potObligation as PublicKey;

  const growingPotVault = growingPotVaultPda(mint, program.programId);
  const amount = await tokenAmount(program, growingPotVault);
  if (amount === 0n) {
    return { skipped: "empty pot vault" };
  }

  const obligationFarm = obligationFarmPda(potObligation);

  const ix = await program.methods
    .compoundGrowingPot()
    .accountsPartial({
      poolConfig: pc,
      crank: crankKp.publicKey,
      growingPotVault,
      obligation: potObligation,
      lendingMarket: LENDING_MARKET,
      lendingMarketAuthority: LENDING_MARKET_AUTHORITY,
      reserve: RESERVE,
      reserveLiquidityMint: mint,
      reserveLiquiditySupply: RESERVE_LIQUIDITY_SUPPLY,
      reserveCollateralMint: RESERVE_COLLATERAL_MINT,
      reserveDestinationDepositCollateral: RESERVE_DEST_DEPOSIT_COLLATERAL,
      collateralTokenProgram: TOKEN_PROGRAM_ID,
      liquidityTokenProgram: TOKEN_PROGRAM_ID,
      instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
      obligationFarmUserState: obligationFarm,
      reserveFarmState: FARM_COLLATERAL,
      farmsProgram: FARMS,
      klendProgram: KLEND,
    })
    .instruction();

  const depReserves = await readObligationDepositReserves(
    connection,
    potObligation
  );
  const tx = new Transaction()
    .add(computeBudgetIx())
    .add(ixRefreshReserve())
    .add(ixRefreshObligation(potObligation, depReserves))
    .add(ix);

  const sig = await program.provider.sendAndConfirm!(tx, [crankKp], {
    skipPreflight: true,
  });

  return { amount, sig };
}

// ---------------------------------------------------------------------------
// cancelIfStuck — watchdog: permissionless timeout cancel of a stuck draw.
// ---------------------------------------------------------------------------
export interface CancelResult {
  cancelled: boolean;
  reason: string;
  sig?: string;
}

/**
 * Watchdog. If a draw is in progress and `now > committed_ts + DRAW_TIMEOUT`,
 * sends cancel_draw (permissionless, timeout-gated on-chain). Otherwise a no-op.
 * `now` defaults to the chain's block time so the off-chain check matches the
 * on-chain gate; pass an explicit `nowSecs` to override (e.g. in tests).
 */
export async function cancelIfStuck(
  program: Program<Stewfi>,
  anyKp: Signer,
  mint: PublicKey = USDC_MINT,
  nowSecs?: number
): Promise<CancelResult> {
  const connection = program.provider.connection;
  const pc = poolConfigPda(mint, program.programId);
  const cfg = await program.account.poolConfig.fetch(pc);

  if (!cfg.drawInProgress) {
    return { cancelled: false, reason: "no draw in progress" };
  }

  const round = cfg.currentRound;
  const draw = drawPda(round.toString(), program.programId);
  const d = await program.account.draw.fetch(draw);
  const committedTs = Number(d.committedTs.toString());

  let now = nowSecs;
  if (now === undefined) {
    const bt = await connection.getBlockTime(await connection.getSlot());
    now = bt ?? Math.floor(Date.now() / 1000);
  }

  if (now <= committedTs + DRAW_TIMEOUT_SECS) {
    return {
      cancelled: false,
      reason: `draw healthy (now ${now} <= committed_ts ${committedTs} + ${DRAW_TIMEOUT_SECS})`,
    };
  }

  const sig = await program.methods
    .cancelDraw()
    .accountsPartial({
      crank: anyKp.publicKey,
      poolConfig: pc,
      currentDraw: draw,
    })
    .signers([anyKp as Keypair])
    .rpc({ skipPreflight: true });

  return { cancelled: true, reason: "timed out", sig };
}

// ---------------------------------------------------------------------------
// planSettle — READ-ONLY dry run of the settle winner-selection.
// ---------------------------------------------------------------------------
export interface SettlePlan {
  round: bigint;
  /** Number of live positions (== settle remaining_accounts length). */
  positionCount: number;
  /** Off-chain total_weight over the live set at the draw_ts used. */
  totalWeight: bigint;
  /** The remaining_accounts metas the crank WOULD pass to settle_draw. */
  metasLength: number;
  /** draw_ts used for the weight math (on-chain Draw if committed, else `now`). */
  drawTs: bigint;
  /** True if a committed Draw exists for the round (drawTs/total_weight are on-chain). */
  hasCommittedDraw: boolean;
  /**
   * Only set when a committed Draw exists: asserts off-chain total_weight equals
   * the on-chain draw.total_weight. False here is a HARD inconsistency (the crank
   * and chain disagree → settle would fail completeness).
   */
  totalWeightMatchesOnChain?: boolean;
  /** On-chain draw.total_weight when a committed Draw exists. */
  onChainTotalWeight?: bigint;
  /** Winner-window table (ascending canonical order). */
  windows: WinnerWindow[];
  /** True if positionCount exceeds the legacy-tx account budget (I-05 / ALT signal). */
  exceedsLegacyCap: boolean;
  /** Human-readable warnings (cap breach, weight mismatch, no-entries, ...). */
  warnings: string[];
}

/**
 * READ-ONLY dry run of settle. Sends NO transaction. It:
 *   1. fetches all live positions,
 *   2. sorts them ascending (canonical order) and builds the remaining_accounts metas,
 *   3. computes off-chain total_weight,
 *   4. if a committed Draw exists for `round`, uses the ON-CHAIN draw_ts and
 *      ASSERTS off-chain total_weight === on-chain draw.total_weight (the
 *      completeness invariant settle enforces). The winner is NOT computed here
 *      because the VRF value isn't revealed in a dry run — but the ticket math is
 *      exercisable via computeWinner(...) given a hypothetical value (see the
 *      `windows` table + computeWindowForTicket below).
 *   5. flags a HARD WARNING when positionCount > the legacy-tx cap (~50) — the
 *      I-05 ALT signal.
 *
 * If no committed Draw exists for the round, draw_ts falls back to `nowSecs`
 * (chain block time by default) so the plan still produces a representative
 * weight table for monitoring.
 */
export async function planSettle(
  program: Program<Stewfi>,
  round?: number | bigint,
  mint: PublicKey = USDC_MINT,
  nowSecs?: number
): Promise<SettlePlan> {
  const connection = program.provider.connection;
  const pc = poolConfigPda(mint, program.programId);
  const cfg = await program.account.poolConfig.fetch(pc);

  const targetRound =
    round !== undefined ? BigInt(round.toString()) : BigInt(cfg.currentRound.toString());

  const positions = await fetchAllPositions(program);
  const metas = sortedPositionMetas(positions);
  const warnings: string[] = [];

  // Determine draw_ts: prefer the on-chain committed Draw's snapshot.
  let drawTs: bigint;
  let hasCommittedDraw = false;
  let onChainTotalWeight: bigint | undefined;

  const draw = drawPda(targetRound.toString(), program.programId);
  let drawAcc: any = null;
  try {
    drawAcc = await program.account.draw.fetch(draw);
  } catch {
    drawAcc = null;
  }

  if (drawAcc && drawStatusTag(drawAcc.status) === "committed") {
    hasCommittedDraw = true;
    drawTs = BigInt(drawAcc.drawTs.toString());
    onChainTotalWeight = BigInt(drawAcc.totalWeight.toString());
  } else {
    let now = nowSecs;
    if (now === undefined) {
      const bt = await connection.getBlockTime(await connection.getSlot());
      now = bt ?? Math.floor(Date.now() / 1000);
    }
    drawTs = BigInt(now);
  }

  const totalWeight = computeTotalWeight(positions, drawTs);

  // Rebuild the window table at this draw_ts (computeWinner needs a value; use a
  // dummy zero value just to get the window table — the ticket itself is ignored
  // for the plan's windows. We guard against totalWeight==0.).
  let windows: WinnerWindow[] = [];
  if (totalWeight > 0n) {
    windows = computeWinner(
      positions,
      drawTs,
      totalWeight,
      Buffer.alloc(16)
    ).windows;
  } else {
    warnings.push(
      "total_weight is 0 — no positive-weight positions; settle would hit NoEntries"
    );
  }

  let totalWeightMatchesOnChain: boolean | undefined;
  if (hasCommittedDraw && onChainTotalWeight !== undefined) {
    totalWeightMatchesOnChain = totalWeight === onChainTotalWeight;
    if (!totalWeightMatchesOnChain) {
      warnings.push(
        `HARD: off-chain total_weight (${totalWeight}) != on-chain draw.total_weight ` +
          `(${onChainTotalWeight}). settle_draw would fail completeness (IncompletePositionSet).`
      );
    }
  }

  const exceedsLegacyCap = positions.length > SETTLE_LEGACY_POSITION_CAP;
  if (exceedsLegacyCap) {
    warnings.push(
      `WARNING (I-05): ${positions.length} live positions exceeds the legacy-tx ` +
        `account budget (>${SETTLE_LEGACY_POSITION_CAP}). settle_draw MUST use an ` +
        `Address Lookup Table (or chunked accumulator) — a plain legacy/v0 tx will ` +
        `overflow the account limit.`
    );
  }

  return {
    round: targetRound,
    positionCount: positions.length,
    totalWeight,
    metasLength: metas.length,
    drawTs,
    hasCommittedDraw,
    totalWeightMatchesOnChain,
    onChainTotalWeight,
    windows,
    exceedsLegacyCap,
    warnings,
  };
}

/**
 * Helper exposed for callers/tests: given a hypothetical 32-byte VRF value and a
 * committed round's on-chain (drawTs, totalWeight), compute the winner the crank
 * WOULD submit. This is the "ticket math is exercisable given a hypothetical
 * value" half of planSettle — kept separate so the dry run itself sends no tx and
 * makes no assumption about the (unrevealed) value.
 */
export async function computeSettleWinner(
  program: Program<Stewfi>,
  drawTs: bigint,
  totalWeight: bigint,
  valueBytes: Buffer | Uint8Array,
  mint: PublicKey = USDC_MINT
): Promise<ReturnType<typeof computeWinner>> {
  void mint;
  const positions = await fetchAllPositions(program);
  return computeWinner(positions, drawTs, totalWeight, valueBytes);
}

// Type re-exports for ergonomic imports.
export type { PositionEntry, WinnerWindow };
