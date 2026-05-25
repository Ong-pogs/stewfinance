/**
 * StewFi off-chain crank — addresses & byte-layout constants.
 *
 * Slice 1 (this file): the permissionless/read-only foundation of the crank.
 * Every value is ported VERBATIM from the source-of-truth tests:
 *   - klend mainnet constants + obligation byte layout: tests/pot.ts + tests/kamino.ts
 *   - Switchboard PIDs + queues (mainnet & devnet): .superstack/m4-research.md §1
 *
 * The Switchboard constants are UNUSED in Slice 1 (no VRF/scheduler/draw txs) — they
 * are included here so Slice 2 (VRF bundling + scheduler) can import them without
 * re-deriving. Do not delete them.
 */
import { PublicKey } from "@solana/web3.js";

// ===========================================================================
// StewFi program
// ===========================================================================
/** Deployed StewFi program id (Anchor.toml [programs.localnet]). */
export const STEWFI_PROGRAM_ID = new PublicKey(
  "8uDmfYPMBaiLLwfZGAnhNaDm48kx19hD8kPdiR7XiRLD"
);

// ===========================================================================
// klend mainnet constants (byte-verified — tests/kamino.ts §constants,
// tests/pot.ts §constants; see .superstack/m3-buglog.md F6/F7).
// These accounts only exist on a MAINNET FORK (surfpool) or mainnet itself.
// ===========================================================================
export const KLEND = new PublicKey(
  "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"
);
export const FARMS = new PublicKey(
  "FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr"
);
export const USDC_MINT = new PublicKey(
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
);

export const LENDING_MARKET = new PublicKey(
  "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF"
);
export const LENDING_MARKET_AUTHORITY = new PublicKey(
  "9DrvZvyWh1HuAoZxvYWMvkf2XCzryCpGgHqrMjyDWpmo"
);

/** The mainnet USDC reserve (the only reserve StewFi routes into). */
export const RESERVE = new PublicKey(
  "D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59"
);
export const RESERVE_LIQUIDITY_SUPPLY = new PublicKey(
  "Bgq7trRgVMeq33yt235zM2onQ4bRDBsY5EWiTetF4qw6"
);
export const RESERVE_COLLATERAL_MINT = new PublicKey(
  "B8V6WVjPxW1UGwVDfxH2d2r8SyT4cqn7dQRK6XneVa7D"
);
export const RESERVE_DEST_DEPOSIT_COLLATERAL = new PublicKey(
  "3DzjXRfxRm6iejfyyMynR4tScddaanrePJ1NJU2XnPPL"
);
/** reserve.collateral.supply_vault == reserve_source_collateral on withdraw. */
export const RESERVE_SOURCE_COLLATERAL = RESERVE_DEST_DEPOSIT_COLLATERAL;

/** The mainnet USDC reserve's collateral farm (v2 CPIs need the farm accounts). */
export const FARM_COLLATERAL = new PublicKey(
  "JAvnB9AKtgPsTEoKmn24Bq64UMoYcrtWtq42HHBdsPkh"
);
export const SCOPE_PRICES = new PublicKey(
  "3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH"
);

// ---------------------------------------------------------------------------
// klend instruction discriminators (from the embedded IDL — tests/kamino.ts).
// ---------------------------------------------------------------------------
export const DISC_REFRESH_RESERVE = Buffer.from([
  2, 218, 138, 235, 79, 201, 25, 102,
]);
export const DISC_REFRESH_OBLIGATION = Buffer.from([
  33, 132, 147, 228, 151, 192, 72, 89,
]);

// ---------------------------------------------------------------------------
// klend obligation account byte layout (byte-verified — tests/pot.ts §94-97):
//   deposits[] starts at absolute offset 96; each ObligationCollateral is 136
//   bytes; deposit_reserve @ +0, deposited_amount (u64 LE) @ +32. 8 slots max.
// ---------------------------------------------------------------------------
export const OBLIGATION_DEPOSITS_OFFSET = 96;
export const OBLIGATION_COLLATERAL_SIZE = 136;
export const OBLIGATION_MAX_DEPOSITS = 8;

/** The pot uses its OWN obligation (Vanilla tag=0, id=1); main pool is id=0. */
export const KAMINO_MAIN_OBLIGATION_ID = 0;
export const KAMINO_POT_OBLIGATION_ID = 1;

// ===========================================================================
// Switchboard On-Demand — VRF (Slice 2; UNUSED here, kept for forward use).
// RPC-verified 2026-05-25, .superstack/m4-research.md §1 + §8.
// ===========================================================================
export const SWITCHBOARD_ON_DEMAND_PID_MAINNET = new PublicKey(
  "SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv"
);
export const SWITCHBOARD_ON_DEMAND_PID_DEVNET = new PublicKey(
  "Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2"
);
export const SWITCHBOARD_DEFAULT_QUEUE_MAINNET = new PublicKey(
  "A43DyUGA7s8eXPxqEjJY6EBu1KKbNgfxF8h17VAHn13w"
);
export const SWITCHBOARD_DEFAULT_QUEUE_DEVNET = new PublicKey(
  "EYiAmGSdsQTuCw413V5BzaruWuCCSDgTPtBGvLkXHbe7"
);

/** RandomnessAccountData: 8-byte disc + 400-byte body = 408 bytes (tests/draw.ts). */
export const RANDOMNESS_DISCRIMINATOR = [10, 66, 229, 135, 220, 239, 217, 114];
export const RANDOMNESS_ACCOUNT_SIZE = 408;
/** Field byte offsets POST-discriminator in the randomness buffer (tests/draw.ts). */
export const RANDOMNESS_OFF_REVEAL_SLOT = 144; // u64 LE
export const RANDOMNESS_OFF_VALUE = 152; // [u8; 32]

// ===========================================================================
// Crank operational constants
// ===========================================================================
/** Mirrors the on-chain DRAW_TIMEOUT (lib.rs §56): 1 hour, in SECONDS. */
export const DRAW_TIMEOUT_SECS = 60 * 60;
/** Mirrors the on-chain DRAW_INTERVAL (lib.rs §44): 7 days, in SECONDS. */
export const DRAW_INTERVAL_SECS = 7 * 24 * 60 * 60;

/**
 * I-05 settle-tx account budget. settle_draw has 12 fixed accounts; each live
 * UserPosition is one extra remaining-account. A legacy (non-ALT) v0 tx caps at
 * ~51 live positions before it must move to an Address Lookup Table. planSettle
 * raises a hard WARNING at strictly MORE than this many positions. (lib.rs §1002.)
 */
export const SETTLE_LEGACY_POSITION_CAP = 50;

/** CU limit prepended on klend-touching txs (tests use 600k — ComputeBudget OBJECT arg). */
export const KLEND_COMPUTE_UNIT_LIMIT = 600_000;

export const ONE_USDC = 1_000_000n;
