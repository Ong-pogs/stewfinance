import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import type { DrawSummary } from "./stewfi";

/**
 * Pure, dependency-light helpers for the winner-spotlight carousel.
 *
 * No React, no DOM — so they unit-test cleanly. The carousel rotates through
 * real settled/claimed winners read from `listDraws`; these functions pick the
 * eligible winners and handle index wrapping. Pure presentation of facts the
 * chain already proved — NO contract / odds / tracking changes.
 */

/** One slide: a real, settled winner. amount is base-units USDC (6 dp). */
export type WinnerSlide = {
  round: number;
  winner: PublicKey;
  amount: BN;
};

/**
 * From the full draw list, keep only draws that are a genuine, settled win:
 *   - status settled or claimed,
 *   - a real winner (not the default/zero pubkey),
 *   - a positive winner amount.
 * Returns them newest-round-first (listDraws is already round-desc, but we
 * re-sort defensively so callers don't depend on input order).
 */
export function selectWinners(draws: DrawSummary[]): WinnerSlide[] {
  return draws
    .filter(
      (d) =>
        (d.status === "settled" || d.status === "claimed") &&
        !d.winner.equals(PublicKey.default) &&
        d.winnerAmount.gtn(0),
    )
    .sort((a, b) => b.round - a.round)
    .map((d) => ({ round: d.round, winner: d.winner, amount: d.winnerAmount }));
}

/**
 * Wrap an arbitrary index into [0, n) with toroidal (cyclic) semantics, so a
 * next/prev step past either end lands on the opposite end.
 *
 * Returns 0 for a non-positive length (an empty carousel has no valid index),
 * and handles negative indices via a double-modulo so -1 → n-1.
 */
export function wrapIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return ((index % length) + length) % length;
}
