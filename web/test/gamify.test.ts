import { describe, it, expect } from "vitest";
import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { computeOdds, weeksHeld, potEstimate, computeStreak, computeBadges } from "../lib/gamify";
import type { DrawSummary } from "../lib/stewfi";

// ── Regression: computeOdds must reproduce simulated-draw.tsx numbers ────────
// Reference inline code in simulated-draw.tsx (lines 35-45):
//   const totalWeight = new BN(now).mul(sumAmount).sub(sumAmountFirstTs);
//   const myWeight = myAmount.mul(new BN(age));
//   const scaled = myWeight.muln(1_000_000).div(totalWeight).toNumber();
//   myOdds = Math.min(scaled / 1_000_000, 1)   (0..1 fraction)
//
// gamify.ts returns oddsPct (0..100); reference formula × 100 must match.

describe("computeOdds", () => {
  const nowTs = 1_717_000_000; // fixed timestamp for deterministic tests

  // Single depositor — 500 USDC, deposited 14 days ago
  const myAmount = new BN(500_000_000); // 500 USDC in base-units (6 decimals)
  const firstTs = new BN(nowTs - 14 * 86_400);

  // Pool has the same single position (sole depositor → 100 % odds)
  // sumAmountFirstTs = amount × firstTs
  const sumAmount = myAmount;
  const sumAmountFirstTs = myAmount.mul(firstTs);

  it("sole depositor has 100% odds", () => {
    const { oddsPct, ageSecs, myWeight, totalWeight } = computeOdds({
      myAmount,
      firstDepositTs: firstTs,
      sumAmount,
      sumAmountFirstTs,
      nowTs,
    });
    // totalWeight = now * sumAmount - sumAmountFirstTs
    //             = (now - firstTs) * myAmount
    //             = ageSecs * myAmount  → myWeight === totalWeight
    expect(myWeight.toString()).toBe(totalWeight.toString());
    expect(oddsPct).toBeCloseTo(100, 5);
    expect(ageSecs).toBe(14 * 86_400);
  });

  it("regression — matches simulated-draw.tsx inline formula", () => {
    // Introduce a second depositor: 1000 USDC deposited 7 days ago
    const other = new BN(1_000_000_000);
    const otherFirstTs = new BN(nowTs - 7 * 86_400);
    const sumAmt = myAmount.add(other);
    const sumAmtFirstTs = myAmount.mul(firstTs).add(other.mul(otherFirstTs));

    const { oddsPct, ageSecs } = computeOdds({
      myAmount,
      firstDepositTs: firstTs,
      sumAmount: sumAmt,
      sumAmountFirstTs: sumAmtFirstTs,
      nowTs,
    });

    // Reference: simulated-draw.tsx inline computation
    const age = Math.max(0, nowTs - firstTs.toNumber());
    const totalWeightRef = new BN(nowTs).mul(sumAmt).sub(sumAmtFirstTs);
    const myWeightRef = myAmount.mul(new BN(age));
    const scaledRef = myWeightRef.muln(1_000_000).div(totalWeightRef).toNumber();
    const refOddsPct = Math.min(scaledRef / 10_000, 100); // ×100 to match oddsPct

    expect(ageSecs).toBe(age);
    expect(oddsPct).toBeCloseTo(refOddsPct, 8);
  });

  it("returns zero odds when total weight is zero", () => {
    // sumAmount = 0 implies totalWeight ≤ 0
    const { oddsPct, myWeight } = computeOdds({
      myAmount: new BN(100_000_000),
      firstDepositTs: new BN(nowTs),
      sumAmount: new BN(0),
      sumAmountFirstTs: new BN(0),
      nowTs,
    });
    expect(oddsPct).toBe(0);
    expect(myWeight.toNumber()).toBe(0);
  });

  it("ageSecs is floored at 0 when firstTs is in the future", () => {
    const { ageSecs, oddsPct } = computeOdds({
      myAmount,
      firstDepositTs: new BN(nowTs + 1000),
      sumAmount: myAmount,
      sumAmountFirstTs: myAmount.mul(new BN(nowTs + 1000)),
      nowTs,
    });
    expect(ageSecs).toBe(0);
    expect(oddsPct).toBe(0);
  });
});

// ── weeksHeld ─────────────────────────────────────────────────────────────────
describe("weeksHeld", () => {
  const base = 1_700_000_000;

  it("returns 0 for age < 1 week", () => {
    expect(weeksHeld(new BN(base), base + 604_799)).toBe(0);
  });

  it("returns 1 at exactly 1 week", () => {
    expect(weeksHeld(new BN(base), base + 604_800)).toBe(1);
  });

  it("returns 2 at exactly 2 weeks", () => {
    expect(weeksHeld(new BN(base), base + 2 * 604_800)).toBe(2);
  });

  it("returns 0 when nowTs < firstDepositTs (floor at 0)", () => {
    expect(weeksHeld(new BN(base + 1000), base)).toBe(0);
  });

  it("returns 52 after 1 year", () => {
    expect(weeksHeld(new BN(base), base + 52 * 604_800)).toBe(52);
  });
});

// ── potEstimate ───────────────────────────────────────────────────────────────
describe("potEstimate", () => {
  it("returns a positive integer for a non-zero pool", () => {
    const estimate = potEstimate(new BN(1_000_000_000_000)); // 1M USDC
    expect(estimate).toBeGreaterThan(0);
    expect(Number.isInteger(estimate)).toBe(true);
  });

  it("returns 0 for an empty pool", () => {
    expect(potEstimate(new BN(0))).toBe(0);
  });
});

// ── computeStreak ─────────────────────────────────────────────────────────────

// Helper: build a DrawSummary fixture
const ZERO_KEY = new PublicKey("11111111111111111111111111111111");

function makeDraw(round: number, drawTs: number): DrawSummary {
  return {
    round,
    status: "settled",
    prizePool: new BN(1_000_000),
    winner: ZERO_KEY,
    winnerAmount: new BN(650_000),
    winnerClaimed: false,
    drawTs: new BN(drawTs),
    growingPotAmount: new BN(200_000),
  };
}

describe("computeStreak", () => {
  const depositTs = 1_700_000_000; // base deposit timestamp

  // Draws: one before deposit (should be excluded) + three after
  const draws: DrawSummary[] = [
    makeDraw(1, depositTs - 86_400),      // before deposit — excluded
    makeDraw(2, depositTs + 604_800),     // 1 week after — counts
    makeDraw(3, depositTs + 2 * 604_800), // 2 weeks after — counts
    makeDraw(4, depositTs + 3 * 604_800), // 3 weeks after — counts
  ];

  const nowTs = depositTs + 5 * 604_800; // 5 weeks after deposit

  it("fresh deposit (no draws yet) returns zeros but active", () => {
    const pos = {
      amount: new BN(100_000_000),
      firstDepositTs: new BN(nowTs - 60), // just deposited
      withdrawRequestedAt: new BN(0),
    };
    const result = computeStreak([], pos, nowTs);
    expect(result.drawsHeldThrough).toBe(0);
    expect(result.weeksHeld).toBe(0);
    expect(result.active).toBe(true);
  });

  it("counts only settled draws at or after firstDepositTs", () => {
    const pos = {
      amount: new BN(100_000_000),
      firstDepositTs: new BN(depositTs),
      withdrawRequestedAt: new BN(0),
    };
    const result = computeStreak(draws, pos, nowTs);
    expect(result.drawsHeldThrough).toBe(3); // draws 2,3,4 after deposit
  });

  it("weeksHeld matches expected floor division", () => {
    const pos = {
      amount: new BN(100_000_000),
      firstDepositTs: new BN(depositTs),
      withdrawRequestedAt: new BN(0),
    };
    const result = computeStreak(draws, pos, nowTs);
    expect(result.weeksHeld).toBe(5); // 5 * 604800 secs held
  });

  it("withdraw-requested: active=false, drawsHeldThrough=0", () => {
    const pos = {
      amount: new BN(100_000_000),
      firstDepositTs: new BN(depositTs),
      withdrawRequestedAt: new BN(depositTs + 86_400), // non-zero = withdraw requested
    };
    const result = computeStreak(draws, pos, nowTs);
    expect(result.active).toBe(false);
    expect(result.drawsHeldThrough).toBe(0);
  });

  it("null position returns all zeros and inactive", () => {
    const result = computeStreak(draws, null, nowTs);
    expect(result.drawsHeldThrough).toBe(0);
    expect(result.weeksHeld).toBe(0);
    expect(result.active).toBe(false);
  });
});

// ── computeBadges ─────────────────────────────────────────────────────────────

describe("computeBadges", () => {
  const depositTs = 1_700_000_000;
  const myKey = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

  // A draw won by myKey
  const wonDraw: DrawSummary = {
    round: 1,
    status: "settled",
    prizePool: new BN(1_000_000),
    winner: myKey,
    winnerAmount: new BN(650_000),
    winnerClaimed: false,
    drawTs: new BN(depositTs + 604_800),
    growingPotAmount: new BN(200_000),
  };

  // A draw won by someone else
  const otherDraw: DrawSummary = {
    ...wonDraw,
    winner: ZERO_KEY,
  };

  it("first_pour is earned when amount > 0", () => {
    const pos = { amount: new BN(100_000_000), firstDepositTs: new BN(depositTs), withdrawRequestedAt: new BN(0), user: myKey };
    const badges = computeBadges(pos, [], null);
    expect(badges.find((b) => b.id === "first_pour")?.earned).toBe(true);
  });

  it("first_pour is NOT earned with zero amount", () => {
    const pos = { amount: new BN(0), firstDepositTs: new BN(depositTs), withdrawRequestedAt: new BN(0) };
    const badges = computeBadges(pos, [], null);
    expect(badges.find((b) => b.id === "first_pour")?.earned).toBe(false);
  });

  it("slow_cooker earned at exactly 4 weeks", () => {
    const nowTs = depositTs + 4 * 604_800;
    // computeBadges uses Date.now() internally; instead, test via weeksHeld indirectly
    // by setting firstDepositTs far enough in the past relative to a known "now".
    // We inject via firstDepositTs that is exactly 4 weeks ago from a stable reference.
    const fourWeeksAgo = Math.floor(Date.now() / 1000) - 4 * 604_800;
    const pos = { amount: new BN(100_000_000), firstDepositTs: new BN(fourWeeksAgo), withdrawRequestedAt: new BN(0) };
    const badges = computeBadges(pos, [], null);
    expect(badges.find((b) => b.id === "slow_cooker")?.earned).toBe(true);
    void nowTs; // suppress unused
  });

  it("slow_cooker NOT earned at 3 weeks", () => {
    const threeWeeksAgo = Math.floor(Date.now() / 1000) - 3 * 604_800 + 60; // just under 4 weeks
    const pos = { amount: new BN(100_000_000), firstDepositTs: new BN(threeWeeksAgo), withdrawRequestedAt: new BN(0) };
    const badges = computeBadges(pos, [], null);
    expect(badges.find((b) => b.id === "slow_cooker")?.earned).toBe(false);
  });

  it("pot_feeder earned when connected wallet won a draw", () => {
    const pos = { amount: new BN(100_000_000), firstDepositTs: new BN(depositTs), withdrawRequestedAt: new BN(0), user: myKey };
    const badges = computeBadges(pos, [wonDraw], null);
    expect(badges.find((b) => b.id === "pot_feeder")?.earned).toBe(true);
  });

  it("pot_feeder NOT earned when another wallet won", () => {
    const pos = { amount: new BN(100_000_000), firstDepositTs: new BN(depositTs), withdrawRequestedAt: new BN(0), user: myKey };
    const badges = computeBadges(pos, [otherDraw], null);
    expect(badges.find((b) => b.id === "pot_feeder")?.earned).toBe(false);
  });

  it("held_through_5 earned when 5+ draws held through", () => {
    const pos = { amount: new BN(100_000_000), firstDepositTs: new BN(depositTs), withdrawRequestedAt: new BN(0), user: myKey };
    const fiveDraws = Array.from({ length: 6 }, (_, i) =>
      makeDraw(i + 1, depositTs + (i + 1) * 604_800),
    );
    const badges = computeBadges(pos, fiveDraws, null);
    expect(badges.find((b) => b.id === "held_through_5")?.earned).toBe(true);
  });

  it("held_through_5 NOT earned with only 4 draws", () => {
    const pos = { amount: new BN(100_000_000), firstDepositTs: new BN(depositTs), withdrawRequestedAt: new BN(0), user: myKey };
    const fourDraws = Array.from({ length: 4 }, (_, i) =>
      makeDraw(i + 1, depositTs + (i + 1) * 604_800),
    );
    const badges = computeBadges(pos, fourDraws, null);
    expect(badges.find((b) => b.id === "held_through_5")?.earned).toBe(false);
  });

  it("null position: all badges unearned", () => {
    const badges = computeBadges(null, [wonDraw], null);
    expect(badges.every((b) => !b.earned)).toBe(true);
  });
});
