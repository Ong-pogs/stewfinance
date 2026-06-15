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
  AccountMeta,
  AddressLookupTableAccount,
  VersionedTransaction,
} from "@solana/web3.js";
import { getAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { AnchorProvider, Program, BN } from "@coral-xyz/anchor";
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
  SWITCHBOARD_DEFAULT_QUEUE_MAINNET,
} from "./constants";
import {
  poolConfigPda,
  usdcVaultPda,
  growingPotVaultPda,
  operatorVaultPda,
  opsVaultPda,
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
import {
  buildCommitAndTriggerV0Tx,
  buildRevealAndSettleV0Tx,
  CommitAndTriggerOpts,
  RevealAndSettleOpts,
  mockRandomness,
  vrfValueForTicket,
} from "./vrf";
import { createPositionsAlt } from "./alt";

// Re-export the sub-modules so callers can `import { ... } from "app/crank"`.
export * from "./constants";
export * from "./pdas";
export * from "./klend";
export * from "./positions";
export * from "./vrf";
export * from "./alt";

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
    } catch (err) {
      // The Draw fetch failed (transient RPC error, or the account isn't
      // readable yet) while draw_in_progress is set. Surface it so the null
      // isn't silent — decideAction routes drawInProgress && !currentDraw to
      // cancelIfStuck (timeout-gated on-chain), rather than skipping blindly.
      console.warn(
        `[crank] readPoolState: Draw fetch failed for round ${cfg.currentRound.toString()} ` +
          `(draw_in_progress=true) — currentDraw=null: ${String(err)}`
      );
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
 * `now` defaults to the Clock sysvar's unix_timestamp so the off-chain check
 * matches the on-chain gate EXACTLY — `cancel_draw` gates on
 * `Clock::get().unix_timestamp`, which `getBlockTime(getSlot())` can lag /
 * disagree with (especially on surfpool with a paused clock). Pass an explicit
 * `nowSecs` to override (e.g. in tests).
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
    try {
      now = await getClockSysvarUnixTs(connection);
    } catch {
      // Fall back only if the sysvar read itself fails.
      const bt = await connection.getBlockTime(await connection.getSlot());
      now = bt ?? Math.floor(Date.now() / 1000);
    }
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
  /**
   * Slice 2b: true when the cycle SHOULD route settle through an ALT. Defaults
   * to the same threshold `exceedsLegacyCap` uses (SETTLE_LEGACY_POSITION_CAP),
   * but `runDrawCycle`'s `opts.alt.threshold` overrides at orchestration time.
   * This is the lib's recommendation; callers can also force `mode: 'always' |
   * 'never'`.
   */
  recommendsAlt: boolean;
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
    // Slice 2b: same threshold as the legacy-cap check by default; the
    // orchestrator (runDrawCycle) may apply a different `opts.alt.threshold`
    // for the actual route decision. Surfacing both lets monitoring decide.
    recommendsAlt: exceedsLegacyCap,
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

// ===========================================================================
// Slice 2a — operator-gated draw txs + full-cycle orchestrator
// ===========================================================================

/**
 * Send a v0 tx via the provider's signer (the SDK gives us a VersionedTransaction
 * that's already signed by the explicit signers we passed; we need ALSO the
 * provider wallet's signature when it's the fee-payer — which is NOT the case
 * here, the operator IS the fee-payer — so we send raw).
 *
 * IMPORTANT: skipPreflight=true means an on-chain revert (e.g. Unauthorized,
 * BadWinnerProof) is NOT caught by preflight — the tx lands and confirms with
 * `value.err` set. `confirmTransaction` does NOT throw on err. We must check
 * the err manually and re-throw with the program logs so the AnchorError name
 * surfaces in the thrown message (buglog B1). Without this, a revert looks
 * indistinguishable from a successful tx to callers.
 */
async function sendV0(
  provider: AnchorProvider,
  tx: VersionedTransaction
): Promise<string> {
  const raw = tx.serialize();
  const sig = await provider.connection.sendRawTransaction(raw, {
    skipPreflight: true,
  });
  // Honor the provider's commitment (Anchor default = "processed"), matching
  // the working .rpc() path in tests/draw.ts. Hardcoding "confirmed" hangs
  // during surfpool pauseClock (block production slows → multi-validator
  // ack misses the 30s confirmTransaction window). See buglog B7.
  const commitment = provider.opts.commitment ?? "processed";
  const conf = await provider.connection.confirmTransaction(sig, commitment);
  if (conf.value.err) {
    // Try to fetch logs so the AnchorError name surfaces. Best-effort —
    // surfpool can lag on getTransaction; the err object is the fallback.
    let logs = "";
    try {
      // Use "confirmed" for the log fetch (NOT the provider's possibly-
      // "processed" commitment) — at processed, surfpool often returns null
      // for getTransaction so the AnchorError name never surfaces. The extra
      // 1–2s wait only fires on the error path. See buglog B7.
      const txDetails = await provider.connection.getTransaction(sig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (txDetails?.meta?.logMessages) {
        logs = "\n" + txDetails.meta.logMessages.join("\n");
      }
    } catch {
      /* ignore */
    }
    const err: any = new Error(
      `tx ${sig} failed on-chain: ${JSON.stringify(conf.value.err)}${logs}`
    );
    err.logs = logs ? logs.trim().split("\n") : undefined;
    throw err;
  }
  return sig;
}

// ---------------------------------------------------------------------------
// triggerDraw — operator-gated. Bundles SB commitIx + StewFi trigger_draw.
// ---------------------------------------------------------------------------

export interface TriggerDrawResult {
  round: bigint;
  drawPda: PublicKey;
  randomnessAccount: PublicKey;
  sig: string;
}

/**
 * Operator-gated. Builds the StewFi `trigger_draw` ix (accounts per
 * tests/draw.ts), bundles it with the Switchboard `commitIx` via
 * `buildCommitAndTriggerV0Tx` (atomic v0), sends with `operatorKp` as
 * fee-payer + crank.
 *
 * On surfpool, pass `opts.skipCommit = true` AND ensure the rng account is
 * pre-mocked (owner = SB On-Demand PID, reveal_slot = 0) via `mockRandomness`.
 * The on-chain trigger_draw only checks owner + reveal_slot==0; no SB queue
 * read is needed in that mode.
 *
 * Pre-conditions (the on-chain `trigger_draw` enforces them — we don't try to
 * pre-check here, but `runDrawCycle` does):
 *   - not paused, draw_accounts_ready, not draw_in_progress
 *   - clock.unix_timestamp >= pool_config.next_draw_ts
 *   - operator == pool_config.operator || pool_config.admin
 *   - vault.amount >= total_principal + pending_winnings (prize > 0) — i.e. the
 *     main pool must be FULLY harvested out of klend before this.
 *
 * Caller MUST persist `randomnessAccount` (== rngKp.publicKey) across to settle.
 */
export async function triggerDraw(
  program: Program<Stewfi>,
  operatorKp: Signer,
  randomness: any /* SDK Randomness instance or {pubkey: PublicKey} */,
  queue: PublicKey = SWITCHBOARD_DEFAULT_QUEUE_MAINNET,
  opts: CommitAndTriggerOpts = {},
  mint: PublicKey = USDC_MINT
): Promise<TriggerDrawResult> {
  const provider = program.provider as AnchorProvider;
  const pc = poolConfigPda(mint, program.programId);
  const cfg = await program.account.poolConfig.fetch(pc);
  const round = BigInt(cfg.currentRound.toString());
  const draw = drawPda(round.toString(), program.programId);
  const usdcVault = usdcVaultPda(mint, program.programId);
  const randomnessAccount: PublicKey = randomness.pubkey;

  const triggerIx = await program.methods
    .triggerDraw()
    .accountsPartial({
      crank: operatorKp.publicKey,
      poolConfig: pc,
      currentDraw: draw,
      usdcVault,
      randomnessAccount,
    })
    .instruction();

  const tx = await buildCommitAndTriggerV0Tx(
    provider,
    randomness,
    queue,
    triggerIx,
    operatorKp,
    opts
  );
  const sig = await sendV0(provider, tx);
  return { round, drawPda: draw, randomnessAccount, sig };
}

// ---------------------------------------------------------------------------
// revealAndSettle — operator-gated. Bundles SB revealIx + StewFi settle_draw.
// ---------------------------------------------------------------------------

export interface SettlePositionPlan {
  /** Sorted ascending-by-owner remaining_accounts metas (settle_draw input). */
  metas: AccountMeta[];
  /** The crank-derived winner position PDA — MUST match on-chain derivation. */
  winnerPositionPda: PublicKey;
  /** The crank-derived winner owner pubkey. */
  winnerOwner: PublicKey;
}

export interface RevealAndSettleResult {
  round: bigint;
  /** Winner pubkey from the on-chain Draw record (post-settle). */
  winner: PublicKey;
  prize: bigint;
  winnerAmount: bigint;
  growingPotAmount: bigint;
  operatorAmount: bigint;
  opsAmount: bigint;
  sig: string;
}

/**
 * Operator-gated. Atomic with the SB reveal (production) or against a
 * mocked-revealed randomness account (surfpool, `opts.skipReveal = true`).
 *
 * `positionPlan` is the FULL sorted set of live position metas + the
 * crank-named winner_position. The on-chain settle re-derives the winner over
 * the SAME set and rejects any mismatch — so the plan MUST be built from
 * `fetchAllPositions` + `computeWinner` using the REVEALED value at the
 * on-chain `draw.draw_ts` and `draw.total_weight`.
 *
 * Retries ±slots on `RandomnessNotResolved` (the slot the tx LANDS in can
 * differ from the slot the crank read by ±1-3 on surfpool; the on-chain
 * `get_value(clock.slot)` is strict). Each retry re-mocks the randomness
 * account at the candidate slot — but we don't do the re-mocking here; it's
 * the caller's responsibility (see `runDrawCycle` on surfpool). For the live
 * path with `skipReveal=false`, the SB `revealIx` sets `reveal_slot = current
 * slot` itself, so the same-tx bundling makes the match automatic — no retry
 * loop needed.
 *
 * If you want the retry-on-RandomnessNotResolved behavior the surfpool tests
 * exercise (where the mocked slot has to match the tx's observed slot), pass
 * an explicit `opts.remockOnRetry` callback that re-writes the mock at the
 * suggested candidate slot before each retry.
 */
export async function revealAndSettle(
  program: Program<Stewfi>,
  operatorKp: Signer,
  round: number | bigint,
  randomness: any /* SDK Randomness instance */,
  positionPlan: SettlePositionPlan,
  opts: RevealAndSettleOpts & {
    /** SURFPOOL ONLY: re-write the mock at the given slot between retries. */
    remockOnRetry?: (candidateSlot: number) => Promise<void>;
    /** Override how many slot offsets the retry walks (default 6). */
    maxRetries?: number;
  } = {},
  mint: PublicKey = USDC_MINT
): Promise<RevealAndSettleResult> {
  // Slice 2b: forward any caller-supplied ALTs to the V0 tx builder. Each
  // retry rebuilds the tx (the settle ix is regenerated for fresh signer
  // hints if needed and `buildRevealAndSettleV0Tx` re-fetches a blockhash),
  // so we pass `addressLookupTableAccounts` through every iteration.
  const provider = program.provider as AnchorProvider;
  const pc = poolConfigPda(mint, program.programId);
  const roundBn = new BN(round.toString());
  const currentDraw = drawPda(roundBn, program.programId);
  const nextDraw = drawPda(roundBn.add(new BN(1)), program.programId);
  const usdcVault = usdcVaultPda(mint, program.programId);
  const growingPotVault = growingPotVaultPda(mint, program.programId);
  const operatorVault = operatorVaultPda(mint, program.programId);
  const opsVault = opsVaultPda(mint, program.programId);
  const randomnessAccount: PublicKey = randomness.pubkey;

  const buildSettleIx = async () =>
    program.methods
      .settleDraw()
      .accountsPartial({
        crank: operatorKp.publicKey,
        poolConfig: pc,
        currentDraw,
        nextDraw,
        randomnessAccount,
        winnerPosition: positionPlan.winnerPositionPda,
        usdcVault,
        growingPotVault,
        operatorVault,
        opsVault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts(positionPlan.metas)
      .instruction();

  const maxRetries = opts.maxRetries ?? 6;
  const offsets = [0, +1, -1, +2, -2, +3, -3];
  let lastErr: any = undefined;

  for (let i = 0; i < Math.min(maxRetries, offsets.length); i++) {
    // For the surfpool remock path: derive the candidate slot from the chain's
    // current clock-sysvar slot. The caller's `remockOnRetry` handles the actual
    // rewrite.
    if (opts.remockOnRetry) {
      const slot = await getClockSysvarSlot(provider.connection);
      await opts.remockOnRetry(slot + offsets[i]);
    }

    const settleIx = await buildSettleIx();
    const tx = await buildRevealAndSettleV0Tx(
      provider,
      randomness,
      settleIx,
      operatorKp,
      {
        skipReveal: opts.skipReveal,
        computeUnits: opts.computeUnits,
        addressLookupTableAccounts: opts.addressLookupTableAccounts,
      }
    );
    try {
      const sig = await sendV0(provider, tx);
      // Success — read the settled outcome.
      const d = await program.account.draw.fetch(currentDraw);
      return {
        round: BigInt(d.round.toString()),
        winner: d.winner as PublicKey,
        prize: BigInt(d.prizePool.toString()),
        winnerAmount: BigInt(d.winnerAmount.toString()),
        growingPotAmount: BigInt(d.growingPotAmount.toString()),
        operatorAmount: BigInt(d.operatorAmount.toString()),
        opsAmount: BigInt(d.opsAmount.toString()),
        sig,
      };
    } catch (err: any) {
      lastErr = err;
      const msg = err?.toString?.() ?? "";
      // Only retry on RandomnessNotResolved (the slot-binding miss). Anything
      // else — BadWinnerProof, PositionsNotSorted, IncompletePositionSet, klend
      // / token errors — is a real failure; surface it.
      if (!msg.includes("RandomnessNotResolved")) throw err;
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// claimDraw — winner-signed claim tx (cheap; included for completeness).
// ---------------------------------------------------------------------------

export interface ClaimResult {
  round: bigint;
  amount: bigint;
  sig: string;
}

/**
 * Winner-signed. Pulls the winner's 65% from `usdc_vault` to their USDC ATA.
 * `winnerKp` must equal `draw.winner` for the given round.
 *
 * `winnerUsdc` defaults to the winner's USDC ATA (computed via SPL ATA helper —
 * the on-chain claim_draw enforces `winner_usdc.owner == winner`).
 */
export async function claimDraw(
  program: Program<Stewfi>,
  winnerKp: Signer,
  round: number | bigint,
  winnerUsdc: PublicKey,
  mint: PublicKey = USDC_MINT
): Promise<ClaimResult> {
  const pc = poolConfigPda(mint, program.programId);
  const usdcVault = usdcVaultPda(mint, program.programId);
  const roundBn = new BN(round.toString());
  const draw = drawPda(roundBn, program.programId);

  const sig = await program.methods
    .claimDraw(roundBn)
    .accountsPartial({
      winner: winnerKp.publicKey,
      poolConfig: pc,
      draw,
      usdcVault,
      winnerUsdc,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([winnerKp as Keypair])
    .rpc({ skipPreflight: true });

  const d = await program.account.draw.fetch(draw);
  return {
    round: BigInt(d.round.toString()),
    amount: BigInt(d.winnerAmount.toString()),
    sig,
  };
}

// ---------------------------------------------------------------------------
// withdrawMainFromKamino — operator helper for the orchestrator's pre-trigger
// full redeem of the main pool's klend position. NOT defensive: assumes the
// obligation has been deposited into (kamino_deposited > 0); on a freshly-
// initialized obligation with no collateral the caller should skip this.
// ---------------------------------------------------------------------------

export interface MainPoolWithdrawResult {
  skipped?: string;
  collateral?: bigint;
  sig?: string;
}

/**
 * Withdraw the FULL main-pool position from klend back into usdc_vault. This
 * is the operator's pre-trigger step: trigger_draw's
 * `vault.amount >= total_principal + pending_winnings` guard will fail with
 * `FundsStillInKamino` if any principal is still in klend.
 *
 * Returns `{skipped}` if the main obligation holds no collateral. Reads the
 * full cToken balance via `readObligationCollateral` and withdraws it.
 */
export async function withdrawMainFromKamino(
  program: Program<Stewfi>,
  operatorKp: Signer,
  mint: PublicKey = USDC_MINT
): Promise<MainPoolWithdrawResult> {
  const connection = program.provider.connection;
  const pc = poolConfigPda(mint, program.programId);
  const cfg = await program.account.poolConfig.fetch(pc);
  const mainObligation = cfg.kaminoObligation as PublicKey;
  if (mainObligation.equals(PublicKey.default)) {
    return { skipped: "main obligation not initialized" };
  }

  const collateral = await readObligationCollateral(connection, mainObligation);
  if (collateral === 0n) {
    return { skipped: "no main-pool collateral" };
  }

  const usdcVault = usdcVaultPda(mint, program.programId);
  const obligationFarm = obligationFarmPda(mainObligation);

  const withdrawIx = await program.methods
    .withdrawFromKamino(new BN(collateral.toString()))
    .accountsPartial({
      poolConfig: pc,
      crank: operatorKp.publicKey,
      usdcVault,
      obligation: mainObligation,
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
    })
    .instruction();

  const depReserves = await readObligationDepositReserves(
    connection,
    mainObligation
  );
  const tx = new Transaction()
    .add(computeBudgetIx())
    .add(ixRefreshReserve())
    .add(ixRefreshObligation(mainObligation, depReserves))
    .add(withdrawIx);

  const sig = await program.provider.sendAndConfirm!(tx, [operatorKp], {
    skipPreflight: true,
  });
  return { collateral, sig };
}

// ---------------------------------------------------------------------------
// runDrawCycle — the full per-draw orchestrator.
// ---------------------------------------------------------------------------

export interface RunDrawCycleOpts {
  /** SDK Randomness instance for this round (caller created + persisted rngKp). */
  randomness: any;
  /** Switchboard queue (mainnet by default; pass the devnet queue if needed). */
  queue?: PublicKey;
  /**
   * Slice 2b: ALT routing for settle.
   *   - `mode: 'auto'`   (default): build an ALT IFF positionCount > threshold.
   *   - `mode: 'always'`: always build an ALT (useful for testing / proving
   *     the ALT path works on any cycle).
   *   - `mode: 'never'`:  never build an ALT (force legacy v0).
   *   - `threshold`: position count above which 'auto' switches on. Default 40
   *     — comfortably below the legacy ~51 cap so we don't cut it close on a
   *     borderline cycle. Above 50 the legacy path would simply revert.
   */
  alt?: {
    mode: "auto" | "always" | "never";
    threshold?: number;
  };
  /**
   * SURFPOOL ONLY hooks. When provided, the orchestrator:
   *   (a) skips the live SB revealIx,
   *   (b) on each revealAndSettle retry, calls `remockOnRetry(slot)` so the
   *       mocked randomness account is re-bound to the slot the next tx will
   *       likely land in,
   *   (c) before the first revealAndSettle attempt, calls `mockReveal()` once
   *       (with the value computed from the on-chain Draw — passed back to the
   *       caller via `mockReveal`'s signature).
   * Production callers leave this undefined and the SB live oracle is used.
   */
  surfpool?: {
    /**
     * Called BEFORE triggerDraw. The caller writes an un-revealed mocked
     * randomness account (reveal_slot=0, owner=SB On-Demand PID) so the
     * on-chain trigger_draw's owner + reveal_slot checks pass without
     * needing to call `createRandomness`/`commitIx` against the live SB
     * program (which fails on surfpool — the SDK's `Randomness.create`
     * needs a recent-slot LUT init that surfpool's slot hashes don't honor;
     * m6-buglog B6).
     */
    setupRandomness: () => Promise<void>;
    /** Called once before the first settle attempt; the caller writes the
     *  mocked REVEALED randomness account (value + initial revealSlot). */
    mockReveal: (drawTs: bigint, totalWeight: bigint) => Promise<{
      value: Buffer;
      winnerPositionPda: PublicKey;
      winnerOwner: PublicKey;
    }>;
    /** Called between revealAndSettle retries to re-bind the mock to `slot`. */
    remockOnRetry: (slot: number) => Promise<void>;
    /**
     * Optional. Called AFTER triggerDraw confirms and BEFORE mockReveal.
     * Use this to pauseClock for the settle phase only — pausing globally
     * before runDrawCycle hangs harvest/withdraw/trigger confirmations
     * (surfpool's clock-pause freezes block production → no new blockhash →
     * confirmTransaction times out). Symmetric `afterSettle` resumes.
     */
    beforeSettle?: () => Promise<void>;
    /** Optional. Called after settle completes (success OR throw). */
    afterSettle?: () => Promise<void>;
  };
}

export interface RunDrawCycleResult {
  round: bigint;
  winner: PublicKey;
  prize: bigint;
  harvestSig?: string;
  withdrawMainSig?: string;
  triggerSig: string;
  settleSig: string;
  compoundSig?: string;
  /** Slice 2b: the ALT address used for settle (when one was built). */
  altAddress?: PublicKey;
  /** Slice 2b: which route the settle tx took (legacy vs ALT-backed v0). */
  settleRoute: "legacy" | "alt";
  warnings: string[];
}

/**
 * The full operator-driven draw cycle (per .superstack/m6-research §arch).
 * Sequence:
 *   1. pre-flight: readPoolState; require !paused && !draw_in_progress &&
 *      now >= next_draw_ts && draw_accounts_ready && growing_pot_obligation_ready.
 *   2. (permissionless) harvestPot — full redeem of pot position; yield lands
 *      in usdc_vault (rides the existing trigger prize formula). Skip-no-op
 *      if returns {skipped}.
 *   3. (operator) withdrawMainFromKamino — full redeem of the main pool, so
 *      trigger's `vault >= total_principal + pending_winnings` guard passes
 *      (FundsStillInKamino otherwise). Skip-no-op if the obligation holds none.
 *   4. (operator) triggerDraw — atomic [commit, trigger_draw].
 *   5. (surfpool) mockReveal — write the revealed randomness account so the
 *      next-tx slot binding works. (Production: SB oracle posts the value
 *      automatically over ~12-30 slots; the live revealIx in step 6 reads it.)
 *   6. (operator) revealAndSettle — atomic [revealIx, settle_draw] (or just
 *      [settle_draw] on surfpool). Retries ±slots on RandomnessNotResolved.
 *   7. (permissionless) compoundPot — re-invest the principal + new 20% escrow.
 *
 * Returns `{round, winner, prize, ...sigs, warnings}`. Honest about anything
 * skipped; throws on the first HARD error (so the operator scheduler can see
 * it and back off).
 */
export async function runDrawCycle(
  program: Program<Stewfi>,
  operatorKp: Signer,
  crankKp: Signer,
  opts: RunDrawCycleOpts,
  mint: PublicKey = USDC_MINT
): Promise<RunDrawCycleResult> {
  const warnings: string[] = [];
  const queue = opts.queue ?? SWITCHBOARD_DEFAULT_QUEUE_MAINNET;

  // -- 1. Pre-flight --------------------------------------------------------
  const snap0 = await readPoolState(program, mint);
  if (snap0.paused) throw new Error("runDrawCycle: pool is paused");
  if (snap0.drawInProgress) {
    throw new Error(
      "runDrawCycle: draw already in progress — call cancelIfStuck or wait for settle"
    );
  }
  if (!snap0.drawAccountsReady) {
    throw new Error("runDrawCycle: draw_accounts_ready is false (init_draw_accounts first)");
  }
  if (!snap0.growingPotObligationReady) {
    throw new Error(
      "runDrawCycle: growing_pot_obligation_ready is false (init_growing_pot_obligation + farm first)"
    );
  }
  // Read the Clock sysvar's unix_timestamp — this is exactly what the program
  // sees in trigger_draw's cadence check. `getBlockTime(getSlot())` can lag /
  // disagree with the Clock sysvar (especially on surfpool with paused clock),
  // so don't use it.
  const now = await getClockSysvarUnixTs(program.provider.connection);
  if (BigInt(now) < snap0.nextDrawTs) {
    throw new Error(
      `runDrawCycle: cadence gate not open — now=${now} < next_draw_ts=${snap0.nextDrawTs}`
    );
  }

  // -- 2. harvestPot (permissionless) ---------------------------------------
  let harvestSig: string | undefined;
  const hr = await harvestPot(program, crankKp, mint);
  if (hr.skipped) warnings.push(`harvestPot skipped: ${hr.skipped}`);
  else harvestSig = hr.sig;

  // -- 3. withdrawMainFromKamino (operator) ---------------------------------
  let withdrawMainSig: string | undefined;
  const wr = await withdrawMainFromKamino(program, operatorKp, mint);
  if (wr.skipped) warnings.push(`withdrawMainFromKamino skipped: ${wr.skipped}`);
  else withdrawMainSig = wr.sig;

  // -- 4. triggerDraw (operator) --------------------------------------------
  // Surfpool: set up the un-revealed mocked rng account first (so the on-chain
  // owner + reveal_slot==0 checks pass without calling the live SB program).
  if (opts.surfpool?.setupRandomness) {
    await opts.surfpool.setupRandomness();
  }
  const trg = await triggerDraw(
    program,
    operatorKp,
    opts.randomness,
    queue,
    { skipCommit: !!opts.surfpool },
    mint
  );

  // -- 5a. Slice 2b: decide ALT vs legacy + (if ALT) build the table BEFORE
  // any clock-pause. createLookupTable + extendLookupTable txs are normal
  // sends — pausing the clock first would freeze block production and hang
  // their confirmations (same shape as the buglog B5 harvest-tx hang).
  //
  // Decide first via the current live position set (sortedPositionMetas);
  // the on-chain settle iterates the SAME set, so this is what gets passed
  // through revealAndSettle below.
  const positions = await fetchAllPositions(program);
  const metas = sortedPositionMetas(positions);
  const altMode = opts.alt?.mode ?? "auto";
  const altThreshold = opts.alt?.threshold ?? 40;
  const altShouldBuild =
    altMode === "always" ||
    (altMode === "auto" && metas.length > altThreshold);

  let altAccount: AddressLookupTableAccount | undefined;
  let altAddress: PublicKey | undefined;
  if (altShouldBuild) {
    const built = await createPositionsAlt(
      program.provider as AnchorProvider,
      operatorKp,
      metas
    );
    altAccount = built.altAccount;
    altAddress = built.altAddress;
  }

  // -- 5b. + 6. mockReveal (surfpool) then revealAndSettle (operator) --------
  // Surfpool only: pause the clock now (the test can swap in pauseClock via
  // beforeSettle), so the settle slot-binding has a stable target.
  if (opts.surfpool?.beforeSettle) {
    await opts.surfpool.beforeSettle();
  }

  const drawAcc = await program.account.draw.fetch(trg.drawPda);
  const drawTs = BigInt(drawAcc.drawTs.toString());
  const totalWeight = BigInt(drawAcc.totalWeight.toString());

  let plan: SettlePositionPlan;
  if (opts.surfpool) {
    // Surfpool: caller computes the value + winner from on-chain (drawTs,
    // totalWeight) and writes the mocked randomness account (sets the initial
    // reveal_slot). The position list + metas were already read above (pre-ALT
    // decision) so we reuse them — the live set hasn't changed between then
    // and now (draw_in_progress freezes deposits/withdraws on-chain).
    const mocked = await opts.surfpool.mockReveal(drawTs, totalWeight);
    plan = {
      metas,
      winnerPositionPda: mocked.winnerPositionPda,
      winnerOwner: mocked.winnerOwner,
    };
  } else {
    // Production: the SB oracle will post the value; the revealIx in the
    // bundled settle tx reads it. The crank computes the winner from the
    // already-revealed value (read post-reveal). Since we send revealIx +
    // settle atomically, the value isn't readable BEFORE the tx — so we
    // compute the winner here from `loadData()` after reveal. But that means
    // we'd need to send reveal first to read, then settle in a second tx,
    // breaking the slot-bind atomicity.
    //
    // Two production designs are valid:
    //   (a) PRE-PRECOMPUTE: the crank reads `randomness.loadData()` AFTER the
    //       oracle posts but BEFORE bundling. The atomic tx is then
    //       [revealIx (no-op if oracle already posted), settle]. This works
    //       because revealIx is idempotent on an already-revealed account.
    //   (b) WAIT-FOR-ORACLE: poll until loadData() returns a non-zero
    //       revealSlot, compute the winner, then send the atomic
    //       [revealIx, settle] tx. The revealIx in the tx is harmless (the
    //       oracle has already posted; SB's revealIx accepts a re-post).
    //
    // Either way the value MUST be readable before we name the winner — and
    // production has a live oracle, so we use (b): wait, compute, then send.
    // For Slice 2a (test-only on surfpool), we keep this branch as a TODO so
    // we don't ship a half-working live path. Devnet exercise is Slice 3.
    throw new Error(
      "runDrawCycle: production (non-surfpool) path is a Slice 3 TODO — " +
        "use `opts.surfpool` for surfpool tests; deploy + run on devnet for the live oracle flow."
    );
  }

  let settled;
  try {
    settled = await revealAndSettle(
      program,
      operatorKp,
      trg.round,
      opts.randomness,
      plan,
      {
        skipReveal: !!opts.surfpool,
        remockOnRetry: opts.surfpool?.remockOnRetry,
        addressLookupTableAccounts: altAccount ? [altAccount] : undefined,
      },
      mint
    );
  } finally {
    // Always run afterSettle (success or throw) so a paused clock gets resumed.
    if (opts.surfpool?.afterSettle) {
      await opts.surfpool.afterSettle();
    }
  }

  // -- 7. compoundPot (permissionless) --------------------------------------
  let compoundSig: string | undefined;
  const cr = await compoundPot(program, crankKp, mint);
  if (cr.skipped) warnings.push(`compoundPot skipped: ${cr.skipped}`);
  else compoundSig = cr.sig;

  return {
    round: trg.round,
    winner: settled.winner,
    prize: settled.prize,
    harvestSig,
    withdrawMainSig,
    triggerSig: trg.sig,
    settleSig: settled.sig,
    compoundSig,
    altAddress,
    settleRoute: altAccount ? "alt" : "legacy",
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Internal — Clock sysvar readers (the program observes Clock::get(); using
// these matches exactly what trigger_draw / settle_draw see at execution time).
// Layout (Clock sysvar, sysvar account data):
//   slot              [0..8]   u64 LE
//   epoch_start_ts    [8..16]  i64 LE
//   epoch             [16..24] u64 LE
//   leader_schedule_epoch [24..32] u64 LE
//   unix_timestamp    [32..40] i64 LE
// ---------------------------------------------------------------------------
const CLOCK_SYSVAR = new PublicKey("SysvarC1ock11111111111111111111111111111111");

async function getClockSysvarSlot(
  connection: import("@solana/web3.js").Connection
): Promise<number> {
  const info = await connection.getAccountInfo(CLOCK_SYSVAR);
  if (!info) throw new Error("Clock sysvar not found");
  return Number(info.data.readBigUInt64LE(0));
}

export async function getClockSysvarUnixTs(
  connection: import("@solana/web3.js").Connection
): Promise<number> {
  const info = await connection.getAccountInfo(CLOCK_SYSVAR);
  if (!info) throw new Error("Clock sysvar not found");
  // unix_timestamp is at offset 32 (i64 LE). For our use it's always positive.
  return Number(info.data.readBigInt64LE(32));
}
