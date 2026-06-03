import { BN } from "@coral-xyz/anchor";
import { MOCK_APY } from "./constants";
import type { DrawSummary } from "./stewfi";

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

// ── Position type (subset used by streak/badges) ──────────────────────────────

export type PositionLike = {
  amount: BN;
  firstDepositTs: BN;
  withdrawRequestedAt: BN;
};

// ── computeStreak ─────────────────────────────────────────────────────────────

/**
 * Derive a streak from on-chain data only.
 *
 * drawsHeldThrough: count of settled draws whose drawTs ≥ position.firstDepositTs
 *                   while the position was open (withdrawRequestedAt === 0).
 * weeksHeld:        full weeks from firstDepositTs to nowTs (uses weeksHeld()).
 * active:           position is open and non-zero (withdrawRequestedAt === 0 && amount > 0).
 *
 * Returns null-safe zeros when position is null/undefined.
 */
export function computeStreak(
  draws: DrawSummary[],
  position: PositionLike | null | undefined,
  nowTs: number,
): { drawsHeldThrough: number; weeksHeld: number; active: boolean } {
  if (!position || position.amount.lten(0)) {
    return { drawsHeldThrough: 0, weeksHeld: 0, active: false };
  }

  const active = position.withdrawRequestedAt.eqn(0) && position.amount.gtn(0);
  const weeks = weeksHeld(position.firstDepositTs, nowTs);

  // Count settled draws that occurred after the deposit and while position is open.
  let drawsHeldThrough = 0;
  if (active) {
    const depositTs = position.firstDepositTs.toNumber();
    for (const d of draws) {
      if (d.status === "settled" && d.drawTs.toNumber() >= depositTs) {
        drawsHeldThrough++;
      }
    }
  }

  return { drawsHeldThrough, weeksHeld: weeks, active };
}

// ── Badge type + computeBadges ────────────────────────────────────────────────

export type Badge = {
  id: string;
  label: string;
  earned: boolean;
  hint: string;
};

type PoolLike = { totalPrincipal: BN } | null | undefined;

/**
 * Return descriptive badges derived from on-chain facts.
 * Badges NEVER grant or imply changed draw weight — they are cosmetic labels only.
 *
 * IDs / conditions:
 *   first_pour       amount > 0
 *   slow_cooker      weeksHeld >= 4
 *   pot_feeder       connected wallet won ≥1 settled draw in `draws`
 *   held_through_5   drawsHeldThrough >= 5
 */
export function computeBadges(
  position: PositionLike | null | undefined,
  draws: DrawSummary[],
  pool: PoolLike,
  allPositions?: PositionLike[],
): Badge[] {
  void pool;        // reserved for future pool-wide badges; suppresses unused-var lint
  void allPositions;

  const nowTs = Math.floor(Date.now() / 1000);
  const streak = computeStreak(draws, position, nowTs);

  const hasDeposit = !!position && position.amount.gtn(0);

  // pot_feeder: wallet address of current position appears as winner in any settled draw.
  // We derive this from the draws list; the caller must pass draws that include the winner field.
  const wonADraw = draws.some(
    (d) =>
      d.status === "settled" &&
      !!position &&
      // DrawSummary.winner is a PublicKey; compare via toString()
      d.winner.toString() === (position as { user?: { toString(): string } } & PositionLike).user?.toString(),
  );

  return [
    {
      id: "first_pour",
      label: "First Pour",
      earned: hasDeposit,
      hint: "Made your first deposit into the pool.",
    },
    {
      id: "slow_cooker",
      label: "Slow Cooker",
      earned: streak.weeksHeld >= 4,
      hint: "Held through 4+ weeks — your entries keep climbing.",
    },
    {
      id: "pot_feeder",
      label: "Pot Feeder",
      earned: wonADraw,
      hint: "Won at least one weekly draw — a share went to the growing pot too.",
    },
    {
      id: "held_through_5",
      label: "Held Through 5",
      earned: streak.drawsHeldThrough >= 5,
      hint: "Position stayed open through 5 or more weekly draws.",
    },
  ];
}
