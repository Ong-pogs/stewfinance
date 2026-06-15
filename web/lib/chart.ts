import { BN } from "@coral-xyz/anchor";

/**
 * Tiny, dependency-free helpers for the inline SVG prize-history chart on
 * /stats. Pure functions only — no React, no DOM — so they unit-test cleanly.
 *
 * BN throughout (the web tsconfig target rejects BigInt literals). All sizing
 * is computed against the larger of `prizePool` and `growingPotAmount` so the
 * two stacked/paired series share one honest y-scale.
 */

/** One round's two bar values (base-units), already ordered for display. */
export type ChartPoint = {
  round: number;
  prize: BN;
  potFeed: BN;
};

/**
 * Pixel height (0..maxPx) for `value` given the chart's `max` value.
 *
 * - Guards a zero/negative max → 0 (avoids divide-by-zero; degrades to a flat
 *   baseline rather than NaN).
 * - A non-zero value always gets at least `minPx` so a tiny-but-real bar stays
 *   visible next to a large one (the round-0 pot feed is 20% of the prize).
 * - Clamps to [0, maxPx].
 */
export function barHeight(
  value: BN,
  max: BN,
  maxPx: number,
  minPx = 2,
): number {
  if (max.lten(0)) return 0;
  if (value.lten(0)) return 0;
  // ratio = value / max in [0,1], computed with 1e6 precision via BN.
  const scaled = value.muln(1_000_000).div(max).toNumber() / 1_000_000;
  const px = scaled * maxPx;
  // Floor to minPx FIRST so a tiny-but-real bar stays visible, then clamp to
  // [0, maxPx] LAST so the documented upper bound always holds (even when
  // maxPx < minPx, where flooring-after-clamping would overshoot maxPx).
  const floored = px < minPx ? minPx : px;
  return Math.max(0, Math.min(maxPx, floored));
}

/**
 * The y-scale max across all points: the single largest of every prize and
 * every pot-feed value. Returns 0 for an empty list (caller shows EmptyState).
 */
export function chartMax(points: ChartPoint[]): BN {
  let max = new BN(0);
  for (const p of points) {
    if (p.prize.gt(max)) max = p.prize;
    if (p.potFeed.gt(max)) max = p.potFeed;
  }
  return max;
}

/**
 * Cumulative sum of `growingPotAmount` ("fed the pot") across all points —
 * the "pot grows forever" readout. Order-independent (addition is
 * commutative), so it doesn't matter whether points are asc/desc by round.
 */
export function cumulativePotFeed(points: ChartPoint[]): BN {
  return points.reduce((acc, p) => acc.add(p.potFeed), new BN(0));
}
