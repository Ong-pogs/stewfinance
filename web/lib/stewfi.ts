import { AnchorProvider, Program, BN } from "@coral-xyz/anchor";
import { Connection, PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { STEWFI_IDL, Stewfi } from "./idl";
import { USDC_MINT } from "./constants";
import { poolConfigPda, usdcVaultPda, userPositionPda, drawPda } from "./pdas";

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
  return all.map((a) => ({
    user: a.account.user as PublicKey,
    amount: a.account.amount as BN,
    firstDepositTs: a.account.firstDepositTs as BN,
    withdrawRequestedAt: a.account.withdrawRequestedAt as BN,
  }));
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

// ── Draw helpers ──────────────────────────────────────────────────────────────

export type DrawSummary = {
  round: number;
  status: string;
  prizePool: BN;
  winner: PublicKey;
  winnerAmount: BN;
  winnerClaimed: boolean;
  drawTs: BN;
  growingPotAmount: BN;
};

/** Fetch a single Draw account by round number. Returns null if not yet created. */
export async function readDraw(program: Program<Stewfi>, round: number) {
  try {
    return await program.account.draw.fetch(drawPda(round));
  } catch { return null; }
}

/** Fetch the Draw for the pool's current round. Returns null if account doesn't exist. */
export async function readCurrentDraw(program: Program<Stewfi>) {
  try {
    const pool = await readPool(program);
    if (!pool) return null;
    const currentRound = (pool.currentRound as BN).toNumber();
    return await readDraw(program, currentRound);
  } catch { return null; }
}

/** Return all Draw accounts sorted by round descending. Returns [] if none exist. */
export async function listDraws(program: Program<Stewfi>): Promise<DrawSummary[]> {
  try {
    const all = await program.account.draw.all();
    return all
      .map((a) => ({
        round: (a.account.round as BN).toNumber(),
        status: Object.keys(a.account.status as object)[0],
        prizePool: a.account.prizePool as BN,
        winner: a.account.winner as PublicKey,
        winnerAmount: a.account.winnerAmount as BN,
        winnerClaimed: a.account.winnerClaimed as boolean,
        drawTs: a.account.drawTs as BN,
        growingPotAmount: (a.account.growingPotAmount ?? new BN(0)) as BN,
      }))
      .sort((a, b) => b.round - a.round);
  } catch { return []; }
}

/** Send the claim_draw instruction for the given round. Returns the tx signature. */
export async function claimDraw(program: Program<Stewfi>, winner: PublicKey, round: number): Promise<string> {
  const winnerUsdc = getAssociatedTokenAddressSync(USDC_MINT, winner);
  return program.methods.claimDraw(new BN(round)).accountsPartial({
    winner,
    poolConfig: poolConfigPda(),
    draw: drawPda(round),
    usdcVault: usdcVaultPda(),
    winnerUsdc,
    tokenProgram: TOKEN_PROGRAM_ID,
  }).rpc();
}
