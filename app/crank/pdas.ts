/**
 * StewFi crank — PDA derivations.
 *
 * One helper per PDA. StewFi seeds are mint-scoped (the usdc_mint is part of the
 * seed) — ported from tests/pot.ts / tests/draw.ts / tests/kamino.ts. The klend
 * PDAs (user_metadata, obligation, obligation-farm) are owned by the pool_config
 * PDA and live under the klend / Farms program ids.
 *
 * All helpers take the relevant program id / mint explicitly so the lib stays
 * decoupled from any single Program instance. Defaults match the deployed StewFi
 * program and mainnet USDC for convenience.
 */
import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  STEWFI_PROGRAM_ID,
  USDC_MINT,
  KLEND,
  FARMS,
  LENDING_MARKET,
  FARM_COLLATERAL,
} from "./constants";

// ---------------------------------------------------------------------------
// StewFi PDAs (seeds are [b"<name>", usdc_mint]).
// ---------------------------------------------------------------------------
export function poolConfigPda(
  mint: PublicKey = USDC_MINT,
  programId: PublicKey = STEWFI_PROGRAM_ID
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool_config"), mint.toBuffer()],
    programId
  )[0];
}

export function usdcVaultPda(
  mint: PublicKey = USDC_MINT,
  programId: PublicKey = STEWFI_PROGRAM_ID
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("usdc_vault"), mint.toBuffer()],
    programId
  )[0];
}

export function growingPotVaultPda(
  mint: PublicKey = USDC_MINT,
  programId: PublicKey = STEWFI_PROGRAM_ID
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("growing_pot_vault"), mint.toBuffer()],
    programId
  )[0];
}

export function operatorVaultPda(
  mint: PublicKey = USDC_MINT,
  programId: PublicKey = STEWFI_PROGRAM_ID
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("operator_vault"), mint.toBuffer()],
    programId
  )[0];
}

export function opsVaultPda(
  mint: PublicKey = USDC_MINT,
  programId: PublicKey = STEWFI_PROGRAM_ID
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("ops_vault"), mint.toBuffer()],
    programId
  )[0];
}

/** A user's position PDA: [b"user_position", user]. */
export function userPositionPda(
  user: PublicKey,
  programId: PublicKey = STEWFI_PROGRAM_ID
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("user_position"), user.toBuffer()],
    programId
  )[0];
}

/** A round's Draw PDA: [b"draw", round.to_le_bytes(8)]. */
export function drawPda(
  round: number | bigint | string | BN,
  programId: PublicKey = STEWFI_PROGRAM_ID
): PublicKey {
  const roundBn = round instanceof BN ? round : new BN(round.toString());
  return PublicKey.findProgramAddressSync(
    [Buffer.from("draw"), roundBn.toArrayLike(Buffer, "le", 8)],
    programId
  )[0];
}

// ---------------------------------------------------------------------------
// klend PDAs (owner = pool_config; program = KLEND / FARMS).
// ---------------------------------------------------------------------------

/** klend user_metadata PDA: [b"user_meta", owner=pool_config]. */
export function userMetadataPda(
  poolConfig: PublicKey,
  klendProgram: PublicKey = KLEND
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("user_meta"), poolConfig.toBuffer()],
    klendProgram
  )[0];
}

/**
 * klend Vanilla obligation PDA:
 *   [ [tag=0], [id], owner=pool_config, lending_market, seed1=default, seed2=default ]
 * `id` is part of the seeds, so id=0 (main pool) and id=1 (pot) are distinct PDAs.
 * Verified empirically on the fork (tests/pot.ts §319-341).
 */
export function obligationPda(
  id: number,
  poolConfig: PublicKey,
  lendingMarket: PublicKey = LENDING_MARKET,
  klendProgram: PublicKey = KLEND
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from([0]), // tag (Vanilla)
      Buffer.from([id]), // id
      poolConfig.toBuffer(),
      lendingMarket.toBuffer(),
      PublicKey.default.toBuffer(),
      PublicKey.default.toBuffer(),
    ],
    klendProgram
  )[0];
}

/** Farm-user-state PDA: [b"user", reserve_farm_state, obligation]. */
export function obligationFarmPda(
  obligation: PublicKey,
  reserveFarmState: PublicKey = FARM_COLLATERAL,
  farmsProgram: PublicKey = FARMS
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("user"), reserveFarmState.toBuffer(), obligation.toBuffer()],
    farmsProgram
  )[0];
}
