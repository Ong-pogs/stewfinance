import { describe, it, expect } from "vitest";
import { BN } from "@coral-xyz/anchor";
import { computeOdds, weeksHeld, potEstimate } from "../lib/gamify";

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
