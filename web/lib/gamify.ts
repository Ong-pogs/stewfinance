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
 * Project how your draw-weight share grows over the coming days IF the pool
 * stays unchanged.
 *
 * This is a PROJECTION, not history — the chain stores no odds-history. The
 * reasoning: your weight = amount × (ts − first_deposit_ts), so as your deposit
 * ages your weight rises; meanwhile the pool's total weight also rises with ts.
 * Net effect for a position older than the pool average is that your share
 * drifts up over time. We hold `myAmount`, `sumAmount`, and `sumAmountFirstTs`
 * FIXED (the "pool stays the same" assumption) and only advance `ts`.
 *
 * Uses the exact same BN math as `computeOdds` at each future timestamp:
 *   future ts   = nowTs + d × 86400          (d = 0..days)
 *   myWeight    = myAmount × (ts − firstDepositTs)
 *   totalWeight = ts × sumAmount − sumAmountFirstTs
 *   odds        = myWeight ÷ totalWeight     (clamped 0..100)
 *
 * No BigInt literals (web tsconfig target rejects them). Null-safe: any missing
 * field, a non-positive `days`, or no position → empty array.
 *
 * @returns one point per day, `{ day: 0..days, oddsPct: 0..100 }`.
 */
export function projectOdds({
  myAmount,
  firstDepositTs,
  sumAmount,
  sumAmountFirstTs,
  nowTs,
  days,
}: {
  myAmount: BN | null | undefined;
  firstDepositTs: BN | null | undefined;
  sumAmount: BN | null | undefined;
  sumAmountFirstTs: BN | null | undefined;
  nowTs: number; // unix seconds
  days: number; // project this many days forward (inclusive of day 0)
}): { day: number; oddsPct: number }[] {
  if (!myAmount || !firstDepositTs || !sumAmount || !sumAmountFirstTs) return [];
  if (!Number.isFinite(days) || days < 0) return [];
  // No real position → flat zeros across the horizon (caller hides the chart).
  if (myAmount.lten(0)) {
    return Array.from({ length: days + 1 }, (_, d) => ({ day: d, oddsPct: 0 }));
  }

  const out: { day: number; oddsPct: number }[] = [];
  for (let d = 0; d <= days; d++) {
    const { oddsPct } = computeOdds({
      myAmount,
      firstDepositTs,
      sumAmount,
      sumAmountFirstTs,
      nowTs: nowTs + d * 86_400,
    });
    out.push({ day: d, oddsPct });
  }
  return out;
}

/**
 * Illustrative size × time odds for the "how the winner is picked" explainer.
 *
 * Same SHAPE as the on-chain formula `computeOdds` uses:
 *   weight = deposit_size × time_held   (here: USDC × days, plain numbers)
 *   odds   = your weight ÷ (your weight + Σ others' weights)
 *
 * This is intentionally a plain-number version against a fixed SAMPLE pool —
 * it is for an honest *illustration only* (the real odds come from the live
 * on-chain pool via `computeOdds`). Values are small and bounded, so JS
 * numbers are exact here. No BN, no chain reads.
 *
 * @param mySize    your deposit in USDC (e.g. 10..5000)
 * @param myDays    days held (e.g. 0..30)
 * @param others    the fixed sample depositors { size (USDC), days }
 * @returns myWeight, totalWeight (you + others), and oddsPct (0..100)
 */
export function illustrativeOdds(
  mySize: number,
  myDays: number,
  others: { size: number; days: number }[],
): { myWeight: number; totalWeight: number; oddsPct: number } {
  const myWeight = Math.max(0, mySize) * Math.max(0, myDays);
  const othersWeight = others.reduce(
    (acc, o) => acc + Math.max(0, o.size) * Math.max(0, o.days),
    0,
  );
  const totalWeight = myWeight + othersWeight;
  const oddsPct = totalWeight <= 0 ? 0 : (myWeight / totalWeight) * 100;
  return { myWeight, totalWeight, oddsPct };
}

/**
 * Compute the winning ticket EXACTLY as the on-chain program does.
 *
 * Mirrors programs/stewfi/src/lib.rs settle_draw (and app/crank/positions.ts
 * computeWinner):
 *   ticket = u128(random_value[0..16] little-endian) % total_weight
 *
 * The winner is then the position whose cumulative-weight window
 * [cum_before, cum_before + weight) contains this ticket, where each position's
 * weight = amount × (draw_ts − first_deposit_ts). This helper computes only the
 * ticket — the windowing is read straight from the settled Draw account
 * (`winner`) since the chain already proved it.
 *
 * Uses BN throughout (no BigInt literals — the web tsconfig target rejects
 * them). `new BN(buf, "le")` is always non-negative, so `.mod()` is safe.
 *
 * @param randomValue the 32 revealed VRF bytes from the Draw account
 * @param totalWeight the on-chain total_weight snapshotted at commit
 * @returns the winning ticket as a BN (0 ≤ ticket < totalWeight), or 0 when
 *          totalWeight ≤ 0 (no entries) — callers should guard on that.
 */
export function computeTicket(
  randomValue: Uint8Array | number[],
  totalWeight: BN,
): BN {
  if (totalWeight.lten(0)) return new BN(0);
  // Read the low 16 bytes (value[0..16]) as a little-endian u128.
  const bytes = Buffer.from(Array.from(randomValue).slice(0, 16));
  const value = new BN(bytes, "le");
  return value.mod(totalWeight);
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

// ── poolMemberSubset ──────────────────────────────────────────────────────────

/**
 * Recover THIS pool's real member set from a list of `UserPosition`s.
 *
 * `UserPosition` PDAs are keyed per-USER (not per-pool), so a global read can
 * include stray positions from other (e.g. old smoke-test) pools. We recover
 * the true member set by selecting the subset whose `amount` values sum EXACTLY
 * to the pool's on-chain `totalPrincipal`. This mirrors how
 * `scripts/devnet-draw.ts` reconciles members against the on-chain accumulator
 * (there it sums weights to `total_weight`; here we sum principal amounts to
 * `totalPrincipal`).
 *
 * Brute-force subset-sum (O(2^n)) is fine for the small N we ever read here.
 *
 * Graceful fallback — returns ALL positions unchanged when:
 *   - N exceeds the cap (CAP, default 22), or
 *   - no exact subset sums to totalPrincipal, or
 *   - the subset-sum is AMBIGUOUS (2+ distinct subsets sum to the target).
 *
 * Ambiguity matters: with colliding `amount` values multiple distinct subsets
 * can sum to `totalPrincipal`, and returning the first one found can drop real
 * members / keep strays. Since the only callers are DISPLAY-only (leaderboard,
 * member-count stats), we degrade gracefully rather than guess: a unique match
 * is trusted, anything else falls back to returning all positions.
 *
 * Pure function. Returns a new array (never mutates the input).
 */
const POOL_SUBSET_CAP = 22;

export function poolMemberSubset<T extends { amount: BN }>(
  positions: T[],
  totalPrincipal: BN,
  cap: number = POOL_SUBSET_CAP,
): T[] {
  const n = positions.length;
  // Trivial cases: empty, or the whole set already reconciles.
  if (n === 0) return [...positions];

  // Fast path: the full set already sums to the target → all are members.
  const fullSum = positions.reduce((acc, p) => acc.add(p.amount), new BN(0));
  if (fullSum.eq(totalPrincipal)) return [...positions];

  // Too many to brute-force → graceful fallback (return all unchanged).
  if (n > cap) return [...positions];

  // Scan ALL non-empty subsets and collect the distinct masks that match. A
  // target of 0 with a non-empty pool would only match the empty subset, so we
  // leave it to the fallback below.
  let matchMask = -1;
  let matchCount = 0;
  for (let mask = 1; mask < 1 << n; mask++) {
    let sum = new BN(0);
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) sum = sum.add(positions[i].amount);
    }
    if (sum.eq(totalPrincipal)) {
      matchMask = mask;
      matchCount++;
      // Two distinct subsets match → ambiguous; stop and fall back.
      if (matchCount > 1) break;
    }
  }

  // Exactly one distinct subset matches → trust it.
  if (matchCount === 1) {
    const subset: T[] = [];
    for (let i = 0; i < n; i++) {
      if (matchMask & (1 << i)) subset.push(positions[i]);
    }
    return subset;
  }

  // 0 matches (no clean subset) OR 2+ matches (ambiguous) → graceful fallback.
  return [...positions];
}

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
  /** Progress toward earning: how far along the user is (capped at target for display). */
  current: number;
  /** Progress toward earning: the threshold that earns the badge. */
  target: number;
};

type PoolLike = { totalPrincipal: BN } | null | undefined;

/**
 * Return descriptive badges derived from on-chain facts.
 * Badges NEVER grant or imply changed draw weight — they are cosmetic labels only.
 *
 * IDs / conditions (earned) + progress (current/target, capped for display):
 *   first_pour       amount > 0                                  (1 / 1)
 *   slow_cooker      weeksHeld >= 4                              (weeksHeld / 4)
 *   pot_feeder       connected wallet won ≥1 settled draw        (wins / 1)
 *   held_through_5   drawsHeldThrough >= 5                       (drawsHeldThrough / 5)
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

  // pot_feeder: wallet address of current position appears as winner in settled draws.
  // We derive this from the draws list; the caller must pass draws that include the winner field.
  const myAddr = (position as { user?: { toString(): string } } & PositionLike)?.user?.toString();
  const wins = !myAddr
    ? 0
    : draws.filter((d) => d.status === "settled" && d.winner.toString() === myAddr).length;

  // Honest progress mapping from REAL data only. `current` is capped at `target`
  // for display so a bar never overflows; earned badges read current === target.
  const HELD_THROUGH_TARGET = 5;
  const SLOW_COOKER_TARGET = 4;

  const withProgress = (
    badge: Omit<Badge, "current" | "target">,
    rawCurrent: number,
    target: number,
  ): Badge => ({
    ...badge,
    current: Math.min(Math.max(0, rawCurrent), target),
    target,
  });

  return [
    withProgress(
      {
        id: "first_pour",
        label: "First Pour",
        earned: hasDeposit,
        hint: "Made your first deposit into the pool.",
      },
      hasDeposit ? 1 : 0,
      1,
    ),
    withProgress(
      {
        id: "slow_cooker",
        label: "Slow Cooker",
        earned: streak.weeksHeld >= SLOW_COOKER_TARGET,
        hint: "Held through 4+ weeks — your entries keep climbing.",
      },
      streak.weeksHeld,
      SLOW_COOKER_TARGET,
    ),
    withProgress(
      {
        id: "pot_feeder",
        label: "Pot Feeder",
        earned: wins >= 1,
        hint: "Won at least one weekly draw — a share went to the growing pot too.",
      },
      wins,
      1,
    ),
    withProgress(
      {
        id: "held_through_5",
        label: "Held Through 5",
        earned: streak.drawsHeldThrough >= HELD_THROUGH_TARGET,
        hint: "Position stayed open through 5 or more weekly draws.",
      },
      streak.drawsHeldThrough,
      HELD_THROUGH_TARGET,
    ),
  ];
}
