/**
 * StewFi crank — klend refresh builders + obligation readers.
 *
 * DIRECT ports of the helpers in tests/kamino.ts / tests/pot.ts. These are
 * load-bearing for every klend-touching crank tx: the program does NOT CPI the
 * refreshes itself, so the crank MUST prepend refresh_reserve + refresh_obligation
 * (with the obligation's CURRENT deposit reserves) before compound/harvest.
 */
import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  KLEND,
  RESERVE,
  LENDING_MARKET,
  SCOPE_PRICES,
  DISC_REFRESH_RESERVE,
  DISC_REFRESH_OBLIGATION,
  OBLIGATION_DEPOSITS_OFFSET,
  OBLIGATION_COLLATERAL_SIZE,
  OBLIGATION_MAX_DEPOSITS,
} from "./constants";

/**
 * klend refresh_reserve for the USDC reserve (Scope oracle path; pyth/switchboard
 * passed as None == the klend program id). Direct port of tests/pot.ts.
 */
export function ixRefreshReserve(): TransactionInstruction {
  return new TransactionInstruction({
    programId: KLEND,
    keys: [
      { pubkey: RESERVE, isSigner: false, isWritable: true },
      { pubkey: LENDING_MARKET, isSigner: false, isWritable: false },
      { pubkey: KLEND, isSigner: false, isWritable: false }, // pyth_oracle = None
      { pubkey: KLEND, isSigner: false, isWritable: false }, // switchboard_price = None
      { pubkey: KLEND, isSigner: false, isWritable: false }, // switchboard_twap = None
      { pubkey: SCOPE_PRICES, isSigner: false, isWritable: false }, // scope_prices
    ],
    data: DISC_REFRESH_RESERVE,
  });
}

/**
 * klend refresh_obligation. remaining_accounts MUST equal the obligation's
 * CURRENTLY booked deposit reserves — klend cross-checks the count against the
 * obligation's state, so a fresh (empty) obligation needs ZERO remaining reserves;
 * after the first deposit books collateral it needs [USDC reserve]. Get this list
 * from readObligationDepositReserves and pass it through. Direct port of
 * tests/pot.ts.
 */
export function ixRefreshObligation(
  obligation: PublicKey,
  depositReserves: PublicKey[]
): TransactionInstruction {
  return new TransactionInstruction({
    programId: KLEND,
    keys: [
      { pubkey: LENDING_MARKET, isSigner: false, isWritable: false },
      { pubkey: obligation, isSigner: false, isWritable: true },
      ...depositReserves.map((r) => ({
        pubkey: r,
        isSigner: false,
        isWritable: true,
      })),
    ],
    data: DISC_REFRESH_OBLIGATION,
  });
}

/**
 * Read the obligation's currently-BOOKED deposit reserves (non-default slots,
 * regardless of amount). Empty obligation → []; after a deposit → [USDC RESERVE].
 *
 * IMPORTANT: after a full withdraw, klend leaves the slot with `deposit_reserve`
 * still set to USDC + `deposited_amount = 0`. refresh_obligation cross-checks the
 * count against the obligation's BOOKED slots (not non-zero ones), so the slot
 * must still be passed even when its amount is 0 — otherwise refresh reverts.
 * (Filtering on `amount > 0` was the Slice 2a B8 bug: the showcase's compound-
 * after-harvest path emptied the slot, the filter returned [], refresh mismatched.)
 * Direct port of tests/pot.ts with the amount filter dropped.
 */
export async function readObligationDepositReserves(
  connection: Connection,
  obligation: PublicKey
): Promise<PublicKey[]> {
  const info = await connection.getAccountInfo(obligation);
  if (!info) return [];
  const out: PublicKey[] = [];
  for (let i = 0; i < OBLIGATION_MAX_DEPOSITS; i++) {
    const off = OBLIGATION_DEPOSITS_OFFSET + i * OBLIGATION_COLLATERAL_SIZE;
    const rk = new PublicKey(info.data.subarray(off, off + 32));
    if (!rk.equals(PublicKey.default)) out.push(rk);
  }
  return out;
}

/**
 * Read deposits[*].deposited_amount (the pot's full cToken balance) for OUR USDC
 * reserve from an obligation. Returns 0n if the obligation doesn't exist or holds
 * no USDC-reserve collateral. Direct port of tests/pot.ts (scans all 8 slots).
 */
export async function readObligationCollateral(
  connection: Connection,
  obligation: PublicKey
): Promise<bigint> {
  const info = await connection.getAccountInfo(obligation);
  if (!info) return 0n;
  for (let i = 0; i < OBLIGATION_MAX_DEPOSITS; i++) {
    const off = OBLIGATION_DEPOSITS_OFFSET + i * OBLIGATION_COLLATERAL_SIZE;
    const rk = new PublicKey(info.data.subarray(off, off + 32));
    if (rk.equals(RESERVE)) return info.data.readBigUInt64LE(off + 32);
  }
  return 0n;
}
