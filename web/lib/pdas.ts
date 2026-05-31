import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { PROGRAM_ID, USDC_MINT } from "./constants";

export function poolConfigPda(mint: PublicKey = USDC_MINT, programId: PublicKey = PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([Buffer.from("pool_config"), mint.toBuffer()], programId)[0];
}
export function usdcVaultPda(mint: PublicKey = USDC_MINT, programId: PublicKey = PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([Buffer.from("usdc_vault"), mint.toBuffer()], programId)[0];
}
export function userPositionPda(user: PublicKey, programId: PublicKey = PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([Buffer.from("user_position"), user.toBuffer()], programId)[0];
}
export function drawPda(round: number | bigint, programId: PublicKey = PROGRAM_ID) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("draw"), new BN(round.toString()).toArrayLike(Buffer, "le", 8)], programId)[0];
}
