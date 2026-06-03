import { BN } from "@coral-xyz/anchor";
import { MOCK_APY } from "./constants";

/**
 * Compute weight-based draw odds.
 *
 * Mirrors the on-chain winner math (programs/stewfi/src/lib.rs, settle_draw):
 *   per-user weight = amount × (draw_ts − first_deposit_ts)
 *   total_weight    = draw_ts × Σamount − Σ(amount × first_ts)
 *   odds            = your weight ÷ total weight
 *
 * We use `nowTs` as the stand-in for draw_ts so the odds shown are "if the
 * draw happened now".  This is the single source of truth — extracted from
 * simulated-draw.tsx so both components share identical math.
 */
export function computeOdds({
  myAmount,
  firstDepositTs,
  sumAmount,
  sumAmountFirstTs,
  nowTs,
}: {
  myAmount: BN;
  firstDepositTs: BN;
  sumAmount: BN;
  sumAmountFirstTs: BN;
  nowTs: number; // unix seconds
}): {
  myWeight: BN;
  totalWeight: BN;
  oddsPct: number; // 0..100
  ageSecs: number;
} {
  const ageSecs = Math.max(0, nowTs - firstDepositTs.toNumber());
  const totalWeight = new BN(nowTs).mul(sumAmount).sub(sumAmountFirstTs);
  if (totalWeight.lten(0)) {
    return { myWeight: new BN(0), totalWeight: new BN(0), oddsPct: 0, ageSecs };
  }
  const myWeight = myAmount.mul(new BN(ageSecs));
  // ratio with precision: myWeight * 1e6 / totalWeight → 0..1e6
  const scaled = myWeight.muln(1_000_000).div(totalWeight).toNumber();
  const oddsPct = Math.min(scaled / 10_000, 100); // convert to 0..100
  return { myWeight, totalWeight, oddsPct, ageSecs };
}

/**
 * Number of complete weeks a position has been held.
 * Floor division: weeksHeld(ts, ts + 7*86400 - 1) === 0
 *                 weeksHeld(ts, ts + 7*86400)     === 1
 */
export function weeksHeld(firstDepositTs: BN, nowTs: number): number {
  const ageSecs = Math.max(0, nowTs - firstDepositTs.toNumber());
  return Math.floor(ageSecs / 604_800);
}

/**
 * Cosmetic prize-this-week estimate.
 * Uses MOCK_APY / 52 — clearly an illustration, not a guarantee.
 * Label it "~" and "estimated" in all UI strings.
 */
export function potEstimate(poolTotalPrincipal: BN): number {
  return Math.floor((poolTotalPrincipal.toNumber() * MOCK_APY) / 52);
}
