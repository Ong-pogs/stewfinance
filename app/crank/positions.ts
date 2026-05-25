/**
 * StewFi crank — UserPosition fetch, canonical sort, and off-chain winner
 * derivation. Ports of the on-chain settle_draw logic (lib.rs §1000-1059) and
 * the tests/draw.ts helpers (sortedPositionMetas / computeWindows).
 *
 * The crank's job at settle time is to reproduce, off-chain, EXACTLY what the
 * program derives on-chain: sort all live positions ascending by owner `user`,
 * accumulate weight = amount × (draw_ts − first_deposit_ts), and find the window
 * that contains the ticket. The program then re-derives the same thing and
 * rejects any mismatch — so these must match byte-for-byte.
 */
import { PublicKey, AccountMeta } from "@solana/web3.js";
import { Program, BN } from "@coral-xyz/anchor";
import { Stewfi } from "../../target/types/stewfi";
import { userPositionPda } from "./pdas";

/** A live position as the crank sees it (decoded UserPosition + its PDA). */
export interface PositionEntry {
  /** The position PDA address ([b"user_position", owner]). */
  pubkey: PublicKey;
  /** The position owner (UserPosition.user). */
  owner: PublicKey;
  /** Cumulative USDC deposited (UserPosition.amount), base units. */
  amount: bigint;
  /** First-ever deposit timestamp (UserPosition.first_deposit_ts), unix secs. */
  firstDepositTs: bigint;
}

/** A position's weight window [start, start+weight) used in winner selection. */
export interface WinnerWindow {
  pubkey: PublicKey;
  owner: PublicKey;
  /** Cumulative weight BEFORE this position (window start). */
  start: bigint;
  /** This position's weight (window length); 0 means it can never win. */
  weight: bigint;
}

export interface WinnerResult {
  /** Owner of the winning position (null only if no positive-weight windows). */
  winnerOwner: PublicKey | null;
  /** Winning position PDA (null if none). */
  winnerPositionPda: PublicKey | null;
  /** The drawn ticket = u128(value[0..16]) % totalWeight. */
  ticket: bigint;
  /** Full window table (canonical ascending order), for diagnostics. */
  windows: WinnerWindow[];
}

/**
 * Fetch ALL live UserPosition accounts via Anchor's gPA helper. Each entry is the
 * decoded account + its on-chain address. Mirrors program.account.userPosition.all().
 */
export async function fetchAllPositions(
  program: Program<Stewfi>
): Promise<PositionEntry[]> {
  const all = await program.account.userPosition.all();
  return all.map((e) => ({
    pubkey: e.publicKey,
    owner: e.account.user as PublicKey,
    amount: BigInt(e.account.amount.toString()),
    firstDepositTs: BigInt(e.account.firstDepositTs.toString()),
  }));
}

/**
 * The CANONICAL order the program enforces: ascending by the position OWNER's
 * pubkey bytes (UserPosition.user). settle_draw requires strictly-ascending
 * `user` and rejects anything else (PositionsNotSorted). Returns a copy.
 */
export function sortPositionsAscending<T extends { owner: PublicKey }>(
  entries: T[]
): T[] {
  return [...entries].sort((a, b) =>
    Buffer.compare(a.owner.toBuffer(), b.owner.toBuffer())
  );
}

/**
 * Build settle_draw's remaining_accounts: ALL live positions, canonically sorted
 * ascending by owner, each {isSigner:false, isWritable:false} (settle only reads
 * positions). Direct port of tests/draw.ts sortedPositionMetas — but here we map
 * from full PositionEntry objects (or any {owner, pubkey} pair).
 */
export function sortedPositionMetas(
  entries: { owner: PublicKey; pubkey: PublicKey }[]
): AccountMeta[] {
  return sortPositionsAscending(entries).map((e) => ({
    pubkey: e.pubkey,
    isSigner: false,
    isWritable: false,
  }));
}

/**
 * Replicate the on-chain winner derivation (lib.rs §982-1059) off-chain:
 *   1. sort positions ascending by owner,
 *   2. weight = amount × seconds_held where seconds_held = max(0, draw_ts − first_deposit_ts),
 *   3. ticket = u128(valueBytes[0..16] little-endian) % totalWeight,
 *   4. winner = the position whose [cum, cum+weight) window contains the ticket.
 *
 * `drawTs` and `totalWeight` MUST come from the on-chain Draw account (NOT
 * recomputed) — the program snapshots them at commit. weight==0 windows never win.
 */
export function computeWinner(
  positions: PositionEntry[],
  drawTs: bigint,
  totalWeight: bigint,
  valueBytes: Buffer | Uint8Array
): WinnerResult {
  if (totalWeight <= 0n) {
    throw new Error(
      `computeWinner: totalWeight must be > 0 (got ${totalWeight})`
    );
  }
  if (valueBytes.length < 16) {
    throw new Error(
      `computeWinner: need >= 16 random bytes (got ${valueBytes.length})`
    );
  }

  // ticket = u128 LE of value[0..16] % total_weight (matches lib.rs §987-991).
  const first16 = Buffer.from(valueBytes.subarray(0, 16));
  const ticket = new BN(first16, "le").toString();
  const ticketBig = BigInt(ticket) % totalWeight;

  const sorted = sortPositionsAscending(positions);
  let running = 0n;
  const windows: WinnerWindow[] = [];
  let winnerOwner: PublicKey | null = null;
  let winnerPositionPda: PublicKey | null = null;

  for (const p of sorted) {
    const secondsHeld = drawTs - p.firstDepositTs;
    const weight = secondsHeld > 0n ? p.amount * secondsHeld : 0n;
    const start = running;
    running += weight;
    windows.push({ pubkey: p.pubkey, owner: p.owner, start, weight });
    if (weight > 0n && start <= ticketBig && ticketBig < running) {
      winnerOwner = p.owner;
      winnerPositionPda = p.pubkey;
    }
  }

  return { winnerOwner, winnerPositionPda, ticket: ticketBig, windows };
}

/**
 * Off-chain total_weight over a position set, given the on-chain draw_ts. Mirrors
 * the running_weight accumulator in settle_draw. Used by planSettle to assert the
 * crank-derived total matches the on-chain draw.total_weight.
 */
export function computeTotalWeight(
  positions: PositionEntry[],
  drawTs: bigint
): bigint {
  let total = 0n;
  for (const p of positions) {
    const secondsHeld = drawTs - p.firstDepositTs;
    if (secondsHeld > 0n) total += p.amount * secondsHeld;
  }
  return total;
}
