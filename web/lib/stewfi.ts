import { AnchorProvider, Program, BN } from "@coral-xyz/anchor";
import { Connection, PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { STEWFI_IDL, Stewfi } from "./idl";
import { USDC_MINT } from "./constants";
import { poolConfigPda, usdcVaultPda, userPositionPda } from "./pdas";

export type AnchorWallet = AnchorProvider["wallet"];

export function getProgram(connection: Connection, wallet: AnchorWallet): Program<Stewfi> {
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  return new Program(STEWFI_IDL, provider);
}

export async function readPool(program: Program<Stewfi>) {
  try {
    return await program.account.poolConfig.fetch(poolConfigPda());
  } catch { return null; }
}

export async function readPosition(program: Program<Stewfi>, user: PublicKey) {
  try {
    return await program.account.userPosition.fetch(userPositionPda(user));
  } catch { return null; }
}

export async function readAllPositions(program: Program<Stewfi>) {
  const all = await program.account.userPosition.all();
  return all.map((a) => ({ user: a.account.user as PublicKey, amount: a.account.amount as BN }));
}

export async function deposit(program: Program<Stewfi>, user: PublicKey, amount: BN): Promise<string> {
  const userUsdc = getAssociatedTokenAddressSync(USDC_MINT, user);
  return program.methods.deposit(amount).accountsPartial({
    poolConfig: poolConfigPda(),
    userPosition: userPositionPda(user),
    usdcVault: usdcVaultPda(),
    userUsdc,
    user,
    systemProgram: SystemProgram.programId,
    tokenProgram: TOKEN_PROGRAM_ID,
  }).rpc();
}

export async function requestWithdraw(program: Program<Stewfi>, user: PublicKey): Promise<string> {
  return program.methods.requestWithdraw().accountsPartial({
    userPosition: userPositionPda(user), user,
  }).rpc();
}

export async function withdraw(program: Program<Stewfi>, user: PublicKey): Promise<string> {
  const userUsdc = getAssociatedTokenAddressSync(USDC_MINT, user);
  return program.methods.withdraw().accountsPartial({
    poolConfig: poolConfigPda(),
    userPosition: userPositionPda(user),
    usdcVault: usdcVaultPda(),
    userUsdc, user,
    tokenProgram: TOKEN_PROGRAM_ID,
  }).rpc();
}
