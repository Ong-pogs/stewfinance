/**
 * StewFi off-chain operator crank — scheduler entrypoint (Slice 2b).
 *
 * A standalone Node script. Reads operator + crank keypairs from env-configured
 * file paths, builds the Anchor `Program<Stewfi>` from the IDL bundled in
 * target/types/stewfi, and runs a polling loop:
 *
 *   1. readPoolState
 *   2. if paused → log + sleep, continue
 *   3. if draw_in_progress AND past timeout → cancelIfStuck (watchdog)
 *   4. if cadence open + accounts ready → runDrawCycle
 *   5. sleep POLL_INTERVAL_MS, repeat
 *
 * NOT a production deploy step in this slice — that's a Slice 3 / hosting
 * decision (long-lived worker on Railway/Fly). This script is the runnable
 * artifact a hosted instance would invoke.
 *
 * Env:
 *   ANCHOR_PROVIDER_URL       (required) RPC endpoint (devnet/mainnet).
 *   ANCHOR_WALLET             (optional) Anchor provider's wallet; defaults to
 *                             OPERATOR_KEYPAIR_PATH so a single env var works.
 *   OPERATOR_KEYPAIR_PATH     (required) Path to operator Keypair JSON (CLI fmt).
 *   CRANK_KEYPAIR_PATH        (optional) Defaults to OPERATOR_KEYPAIR_PATH.
 *   USDC_MINT                 (optional) Defaults to mainnet USDC.
 *   POLL_INTERVAL_MS          (optional) Default 60_000.
 *   ALT_MODE                  (optional) 'auto' | 'always' | 'never' (default 'auto').
 *   ALT_THRESHOLD             (optional) Integer; default 40.
 *   DRY_RUN                   (optional) 'true' → log decisions without sending txs.
 *   RANDOMNESS_KEYPAIR_PATH   (optional) Path to a SB rng Keypair JSON. If
 *                             unset, the script logs a hard warning and skips
 *                             trigger steps (rng account creation is the
 *                             operator's pre-deploy ritual; see README).
 *
 * Logs: one JSON object per line. The harness (Railway/Fly) ingests them as
 * structured events. Use the `level` field for filtering.
 */
import * as fs from "fs";
import { expandHome } from "./paths";

import {
  Connection,
  Keypair,
  PublicKey,
} from "@solana/web3.js";
import {
  AnchorProvider,
  Program,
  Wallet,
} from "@coral-xyz/anchor";

import { Stewfi } from "../../target/types/stewfi";
// IDL is loaded at runtime (avoids needing `resolveJsonModule` in tsconfig,
// which would ripple through every existing test file). The build emits
// target/idl/stewfi.json alongside the .ts type — both come from `anchor build`.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const stewfiIdl: unknown = require("../../target/idl/stewfi.json");

import {
  readPoolState,
  cancelIfStuck,
  runDrawCycle,
  planSettle,
  getClockSysvarUnixTs,
  USDC_MINT,
  DRAW_TIMEOUT_SECS,
  DRAW_INTERVAL_SECS,
} from "./index";

// ===========================================================================
// JSON line logger
// ===========================================================================

type LogLevel = "debug" | "info" | "warn" | "error";

function log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}) {
  // toJSON() handles bigint pubkey, etc. so we stringify manually with a
  // replacer that coerces BigInt / PublicKey to strings.
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields,
  };
  console.log(JSON.stringify(entry, (_k, v) => {
    if (typeof v === "bigint") return v.toString();
    if (v instanceof PublicKey) return v.toBase58();
    return v;
  }));
}

// ===========================================================================
// Env / config
// ===========================================================================

interface CrankConfig {
  rpcUrl: string;
  operatorKp: Keypair;
  crankKp: Keypair;
  usdcMint: PublicKey;
  pollIntervalMs: number;
  altMode: "auto" | "always" | "never";
  altThreshold: number;
  dryRun: boolean;
  randomnessKp: Keypair | null;
}

function readKeypair(filepath: string): Keypair {
  const expanded = expandHome(filepath);
  const raw = fs.readFileSync(expanded, "utf-8");
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr)) {
    throw new Error(`Keypair file ${filepath} is not a JSON array (Solana CLI format)`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(arr));
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`required env var ${name} is not set`);
  }
  return v;
}

function loadConfig(): CrankConfig {
  const rpcUrl = requireEnv("ANCHOR_PROVIDER_URL");
  const operatorKpPath = requireEnv("OPERATOR_KEYPAIR_PATH");
  const operatorKp = readKeypair(operatorKpPath);

  const crankKpPath = process.env.CRANK_KEYPAIR_PATH;
  const crankKp = crankKpPath ? readKeypair(crankKpPath) : operatorKp;

  const usdcMintStr = process.env.USDC_MINT;
  const usdcMint = usdcMintStr ? new PublicKey(usdcMintStr) : USDC_MINT;

  const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS ?? "60000");
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 1000) {
    throw new Error(`POLL_INTERVAL_MS must be >= 1000 (got ${pollIntervalMs})`);
  }

  const altModeRaw = (process.env.ALT_MODE ?? "auto").toLowerCase();
  if (!["auto", "always", "never"].includes(altModeRaw)) {
    throw new Error(`ALT_MODE must be auto|always|never (got '${altModeRaw}')`);
  }
  const altMode = altModeRaw as "auto" | "always" | "never";
  const altThreshold = Number(process.env.ALT_THRESHOLD ?? "40");
  if (!Number.isFinite(altThreshold) || altThreshold < 0) {
    throw new Error(`ALT_THRESHOLD must be a non-negative integer (got ${altThreshold})`);
  }

  const dryRun = (process.env.DRY_RUN ?? "false").toLowerCase() === "true";

  const rngKpPath = process.env.RANDOMNESS_KEYPAIR_PATH;
  const randomnessKp = rngKpPath ? readKeypair(rngKpPath) : null;

  return {
    rpcUrl,
    operatorKp,
    crankKp,
    usdcMint,
    pollIntervalMs,
    altMode,
    altThreshold,
    dryRun,
    randomnessKp,
  };
}

// ===========================================================================
// Provider + program setup
// ===========================================================================

function buildProgram(cfg: CrankConfig): Program<Stewfi> {
  const connection = new Connection(cfg.rpcUrl, "confirmed");
  const wallet = new Wallet(cfg.operatorKp);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  // The IDL is bundled with the build — `target/idl/stewfi.json`. Anchor
  // 0.31's Program constructor takes (idl, provider) and reads the address
  // out of `idl.address`.
  // Cast to satisfy strict TS — the bundled IDL JSON is wider than the
  // `Stewfi` typed shape Anchor's generic accepts (the typed `Stewfi` is the
  // distilled IdlType the macros emit; the JSON has extra metadata fields).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Program(stewfiIdl as any, provider) as Program<Stewfi>;
}

// ===========================================================================
// One-cycle decision: skip / cancel / runDrawCycle
// ===========================================================================

type CycleAction =
  | { kind: "skip"; reason: string }
  | { kind: "cancel"; reason: string }
  | { kind: "run"; reason: string };

async function decideAction(
  program: Program<Stewfi>,
  cfg: CrankConfig
): Promise<CycleAction> {
  const snap = await readPoolState(program, cfg.usdcMint);

  if (snap.paused) {
    return { kind: "skip", reason: "paused" };
  }

  if (snap.drawInProgress) {
    // Watchdog: timeout-cancel if past committed_ts + DRAW_TIMEOUT. Use the
    // Clock sysvar's unix_timestamp — on-chain `cancel_draw` gates on
    // `Clock::get().unix_timestamp`, which `getBlockTime(getSlot())` can lag /
    // disagree with. Fall back to block time / Date.now() only if the sysvar
    // read itself fails.
    const draw = snap.currentDraw;
    if (draw) {
      let nowSecs: number;
      try {
        nowSecs = await getClockSysvarUnixTs(program.provider.connection);
      } catch {
        const nowBt = await program.provider.connection.getBlockTime(
          await program.provider.connection.getSlot()
        );
        nowSecs = nowBt ?? Math.floor(Date.now() / 1000);
      }
      const now = BigInt(nowSecs);
      if (now > draw.committedTs + BigInt(DRAW_TIMEOUT_SECS)) {
        return {
          kind: "cancel",
          reason: `draw stuck past timeout (committed_ts=${draw.committedTs}, now=${now}, timeout=${DRAW_TIMEOUT_SECS}s)`,
        };
      }
    }
    return { kind: "skip", reason: "draw in progress (within timeout window)" };
  }

  if (!snap.drawAccountsReady) {
    return { kind: "skip", reason: "draw_accounts_ready=false (admin init pending)" };
  }
  if (!snap.growingPotObligationReady) {
    return {
      kind: "skip",
      reason: "growing_pot_obligation_ready=false (admin init pending)",
    };
  }

  // Cadence gate — use block time as a proxy for the Clock sysvar; the
  // orchestrator's pre-flight re-reads the sysvar directly before sending.
  const nowBt = await program.provider.connection.getBlockTime(
    await program.provider.connection.getSlot()
  );
  const now = BigInt(nowBt ?? Math.floor(Date.now() / 1000));
  if (now < snap.nextDrawTs) {
    const remaining = snap.nextDrawTs - now;
    return {
      kind: "skip",
      reason: `cadence not yet open (next_draw_ts=${snap.nextDrawTs}, now=${now}, ~${remaining}s remaining)`,
    };
  }

  return { kind: "run", reason: "cadence open + ready" };
}

// ===========================================================================
// Main loop
// ===========================================================================

let shuttingDown = false;

async function cycle(program: Program<Stewfi>, cfg: CrankConfig): Promise<void> {
  const action = await decideAction(program, cfg);

  if (action.kind === "skip") {
    log("debug", "skip cycle", { reason: action.reason });
    return;
  }

  if (action.kind === "cancel") {
    log("warn", "watchdog: cancelling stuck draw", { reason: action.reason });
    if (cfg.dryRun) {
      log("info", "dry run — would cancelIfStuck", {});
      return;
    }
    try {
      const res = await cancelIfStuck(program, cfg.crankKp, cfg.usdcMint);
      log("info", "cancelIfStuck result", {
        cancelled: res.cancelled,
        reason: res.reason,
        sig: res.sig,
      });
    } catch (err) {
      log("error", "cancelIfStuck failed", { error: String(err) });
    }
    return;
  }

  // action.kind === "run"
  log("info", "cadence open — preparing draw cycle", { reason: action.reason });

  // Surface what planSettle thinks we're about to do (count, recommendsAlt).
  try {
    const plan = await planSettle(program, undefined, cfg.usdcMint);
    log("info", "planSettle dry run", {
      positionCount: plan.positionCount,
      totalWeight: plan.totalWeight,
      drawTs: plan.drawTs,
      exceedsLegacyCap: plan.exceedsLegacyCap,
      recommendsAlt: plan.recommendsAlt,
      warnings: plan.warnings,
    });
  } catch (err) {
    log("warn", "planSettle failed (continuing)", { error: String(err) });
  }

  if (cfg.dryRun) {
    log("info", "dry run — would runDrawCycle (skipping send)", {
      altMode: cfg.altMode,
      altThreshold: cfg.altThreshold,
    });
    return;
  }

  if (!cfg.randomnessKp) {
    log("error", "RANDOMNESS_KEYPAIR_PATH not set — cannot trigger draw", {
      hint: "the operator must pre-create + persist a Switchboard randomness keypair (see README)",
    });
    return;
  }

  // Production runDrawCycle: requires the Switchboard SDK Randomness instance.
  // For Slice 2b we surface that this is a Slice 3 wire-up step (the
  // production reveal-wait path lives in runDrawCycle's else branch and
  // currently throws — see app/crank/index.ts §runDrawCycle production
  // comment). The scheduler still drives the loop, logging the decision; the
  // actual SB SDK plumbing lands in Slice 3 alongside devnet deploy.
  log("warn", "runDrawCycle production path is Slice 3 (waiting on devnet wire-up)", {
    note: "the loop, watchdog, ALT route decision, and dry-run mode are exercised; the live trigger+settle bundling depends on the SB oracle being reachable on devnet.",
  });
  log("info", "would call runDrawCycle", {
    altMode: cfg.altMode,
    altThreshold: cfg.altThreshold,
  });
  // Intentionally no actual send. runDrawCycle is called from tests/crank3.ts
  // with the surfpool mock-VRF hooks; on devnet (Slice 3) the production
  // branch will be wired in.
  void runDrawCycle; // touch the import so tree-shaking doesn't drop it
}

async function loop(program: Program<Stewfi>, cfg: CrankConfig): Promise<void> {
  log("info", "starting crank loop", {
    rpc: cfg.rpcUrl,
    operator: cfg.operatorKp.publicKey.toBase58(),
    crank: cfg.crankKp.publicKey.toBase58(),
    usdcMint: cfg.usdcMint.toBase58(),
    pollIntervalMs: cfg.pollIntervalMs,
    altMode: cfg.altMode,
    altThreshold: cfg.altThreshold,
    dryRun: cfg.dryRun,
    randomnessKpSet: !!cfg.randomnessKp,
  });

  while (!shuttingDown) {
    try {
      await cycle(program, cfg);
    } catch (err) {
      // Loop-level catch: any uncaught error in cycle (network, RPC down)
      // logs + sleeps; we never crash the loop. The operator restarts only
      // on SIGINT/SIGTERM.
      log("error", "cycle failed (continuing)", { error: String(err) });
    }
    if (shuttingDown) break;
    await sleep(cfg.pollIntervalMs);
  }
  log("info", "loop exited cleanly", {});
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ===========================================================================
// Entrypoint + graceful shutdown
// ===========================================================================

function installSignalHandlers(): void {
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      if (shuttingDown) return; // ignore re-entry
      log("info", "shutdown signal received — exiting after current cycle", {
        signal: sig,
      });
      shuttingDown = true;
    });
  }
}

async function main(): Promise<void> {
  installSignalHandlers();
  const cfg = loadConfig();
  const program = buildProgram(cfg);
  await loop(program, cfg);
  // Normal exit (loop returned because shuttingDown was set).
  process.exit(0);
}

// Run only when invoked directly (not when imported for testing).
if (require.main === module) {
  main().catch((err) => {
    log("error", "fatal", { error: String(err) });
    process.exit(1);
  });
}

export { main, loadConfig, buildProgram, decideAction, cycle };
