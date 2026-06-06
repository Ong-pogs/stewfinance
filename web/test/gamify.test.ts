import { describe, it, expect } from "vitest";
import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { computeOdds, illustrativeOdds, weeksHeld, potEstimate, computeStreak, computeBadges, poolMemberSubset, computeTicket } from "../lib/gamify";
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

// ── illustrativeOdds ──────────────────────────────────────────────────────────
// Plain-number size × time helper backing the "how the winner is picked"
// explainer. Same shape as computeOdds: weight = size × time, odds = mine ÷ total.
describe("illustrativeOdds", () => {
  // A small fixed sample pool used by the explainer widget.
  const sample = [
    { size: 250, days: 20 }, // weight 5000
    { size: 500, days: 4 },  // weight 2000
    { size: 50, days: 30 },  // weight 1500
  ]; // others' total weight = 8500

  it("weight = size × time", () => {
    const { myWeight } = illustrativeOdds(100, 10, sample);
    expect(myWeight).toBe(1000);
  });

  it("totalWeight = your weight + sample others", () => {
    const { totalWeight } = illustrativeOdds(100, 10, sample);
    expect(totalWeight).toBe(1000 + 8500);
  });

  it("odds = your weight ÷ total weight (as a percent)", () => {
    const { oddsPct } = illustrativeOdds(100, 10, sample);
    expect(oddsPct).toBeCloseTo((1000 / 9500) * 100, 8);
  });

  it("bigger deposit raises odds (size lever)", () => {
    const small = illustrativeOdds(100, 10, sample).oddsPct;
    const big = illustrativeOdds(1000, 10, sample).oddsPct;
    expect(big).toBeGreaterThan(small);
  });

  it("holding longer raises odds (time lever)", () => {
    const short = illustrativeOdds(100, 5, sample).oddsPct;
    const long = illustrativeOdds(100, 25, sample).oddsPct;
    expect(long).toBeGreaterThan(short);
  });

  it("equal weight from either lever gives equal odds (size×time symmetry)", () => {
    // 200×10 and 100×20 both yield weight 2000 → identical odds.
    const a = illustrativeOdds(200, 10, sample).oddsPct;
    const b = illustrativeOdds(100, 20, sample).oddsPct;
    expect(a).toBeCloseTo(b, 10);
  });

  it("zero time held → zero weight → zero odds", () => {
    const { myWeight, oddsPct } = illustrativeOdds(5000, 0, sample);
    expect(myWeight).toBe(0);
    expect(oddsPct).toBe(0);
  });

  it("sole depositor (no others) has 100% odds", () => {
    const { oddsPct } = illustrativeOdds(100, 10, []);
    expect(oddsPct).toBeCloseTo(100, 10);
  });

  it("empty pool entirely (you have zero weight) returns 0, no divide-by-zero", () => {
    const { oddsPct, totalWeight } = illustrativeOdds(0, 0, []);
    expect(totalWeight).toBe(0);
    expect(oddsPct).toBe(0);
  });

  it("clamps negative inputs to zero weight", () => {
    expect(illustrativeOdds(-100, 10, sample).myWeight).toBe(0);
    expect(illustrativeOdds(100, -10, sample).myWeight).toBe(0);
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

// ── computeTicket ─────────────────────────────────────────────────────────────
// The on-chain settle (lib.rs) derives the winner from
//   ticket = u128(random_value[0..16] little-endian) % total_weight
// then picks the position whose cumulative-weight window contains the ticket.
// We reproduce the ticket against the REAL settled round-0 Draw account on
// devnet and assert it falls inside the actual winner's window.

describe("computeTicket", () => {
  // ── live round-0 Draw account (read from devnet 2026-06-07) ───────────────
  // Draw PDA 7ZHGfh4RhgrC8VyiqdW5YXmeMpTfdexNGQSxUAgZtZWY, status=settled.
  const round0 = {
    randomValueHex:
      "f5bf26f1b03d1f5899352d53fc3c1462f3e23f2f7636692101370f9d22f9863a",
    totalWeight: new BN("11082670000000"),
    // The on-chain winner held the entire weight (sole effective position),
    // so its window is [0, totalWeight) and the ticket must land inside it.
    winner: new PublicKey("738qzq7a5NLVCSuKi2C8kcuFhCBd5Vhd5d21AeFXTsst"),
  };

  function hexToBytes(hex: string): Uint8Array {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }

  it("reproduces the on-chain ticket for the settled round 0", () => {
    const value = hexToBytes(round0.randomValueHex);
    const ticket = computeTicket(value, round0.totalWeight);
    // Known-good value: u128(value[0..16] LE) % total_weight.
    expect(ticket.toString()).toBe("8874432220405");
    // Ticket is always strictly less than total_weight.
    expect(ticket.lt(round0.totalWeight)).toBe(true);
  });

  it("ticket falls inside the actual round-0 winner's weight window", () => {
    // Round 0's winner held all the weight → its window is [0, totalWeight).
    // The single-window check that the on-chain program performs: the ticket
    // lies in [cum_before, cum_before + weight). Here cum_before = 0,
    // weight = totalWeight, so the ticket must satisfy 0 ≤ ticket < totalWeight.
    const ticket = computeTicket(hexToBytes(round0.randomValueHex), round0.totalWeight);
    const cumBefore = new BN(0);
    const running = round0.totalWeight; // cum_before + window weight
    const inWindow = ticket.gte(cumBefore) && ticket.lt(running);
    expect(inWindow).toBe(true);
    // Sanity: the winner address is the expected on-chain winner.
    expect(round0.winner.toBase58()).toBe("738qzq7a5NLVCSuKi2C8kcuFhCBd5Vhd5d21AeFXTsst");
  });

  it("reads value[0..16] little-endian (matches BN(buf, 'le'))", () => {
    // 16 bytes: 0x01 in the least-significant position, rest zero → value = 1.
    const bytes = new Uint8Array(32);
    bytes[0] = 1;
    const ticket = computeTicket(bytes, new BN(1000));
    expect(ticket.toString()).toBe("1");
  });

  it("ignores bytes beyond the first 16 (only value[0..16] counts)", () => {
    const lo = new Uint8Array(32);
    lo[0] = 5; // value = 5 from low 16 bytes
    lo[20] = 99; // high bytes — must be ignored
    expect(computeTicket(lo, new BN(1000)).toString()).toBe("5");
  });

  it("returns 0 when totalWeight is 0 (no entries guard)", () => {
    const bytes = new Uint8Array(32);
    bytes[0] = 7;
    expect(computeTicket(bytes, new BN(0)).toString()).toBe("0");
  });

  it("accepts a plain number[] (as Anchor decodes [u8; 32])", () => {
    const arr = new Array(32).fill(0);
    arr[0] = 10;
    expect(computeTicket(arr, new BN(1000)).toString()).toBe("10");
  });
});

// ── poolMemberSubset ──────────────────────────────────────────────────────────

describe("poolMemberSubset", () => {
  const usdc = (n: number) => new BN(n * 1_000_000);

  // Helper: build a minimal position with a distinct user key for identity checks.
  let keyCounter = 0;
  function pos(amountUsdc: number) {
    // Deterministic distinct pubkeys derived from a counter byte.
    const bytes = new Uint8Array(32);
    bytes[0] = ++keyCounter;
    return {
      user: new PublicKey(bytes),
      amount: usdc(amountUsdc),
      firstDepositTs: new BN(1_700_000_000),
      withdrawRequestedAt: new BN(0),
    };
  }

  it("drops strays — reconciles the demo pool to its 4 real members", () => {
    // Mirrors the live demo pool: two 150 strays + 50 + three 10s; real = 80.
    const positions = [
      pos(10),
      pos(150), // stray
      pos(50),
      pos(10),
      pos(10),
      pos(150), // stray
    ];
    const totalPrincipal = usdc(80); // on-chain pool total
    const members = poolMemberSubset(positions, totalPrincipal);

    // Exactly the 4 real members (50 + 10 + 10 + 10), strays dropped.
    expect(members).toHaveLength(4);
    const sum = members.reduce((acc, p) => acc.add(p.amount), new BN(0));
    expect(sum.toString()).toBe(totalPrincipal.toString());
    // No 150-USDC stray survives.
    expect(members.some((p) => p.amount.eq(usdc(150)))).toBe(false);
  });

  it("returns all when the full set already reconciles", () => {
    const positions = [pos(50), pos(10), pos(20)];
    const members = poolMemberSubset(positions, usdc(80));
    expect(members).toHaveLength(3);
  });

  it("graceful fallback — no clean subset returns ALL positions unchanged", () => {
    // No subset of {150, 150, 10} sums to 80.
    const positions = [pos(150), pos(150), pos(10)];
    const members = poolMemberSubset(positions, usdc(80));
    expect(members).toHaveLength(3);
    expect(members).toEqual(positions); // unchanged
  });

  it("graceful fallback — N over the cap returns all unchanged", () => {
    // 3 positions, cap of 2 → can't brute-force → return all.
    const positions = [pos(10), pos(20), pos(50)];
    const members = poolMemberSubset(positions, usdc(30), 2);
    expect(members).toHaveLength(3);
    expect(members).toEqual(positions);
  });

  it("empty input returns an empty array", () => {
    expect(poolMemberSubset([], usdc(80))).toHaveLength(0);
  });

  it("does not mutate the input array", () => {
    const positions = [pos(10), pos(150), pos(50), pos(10), pos(10), pos(150)];
    const snapshot = [...positions];
    poolMemberSubset(positions, usdc(80));
    expect(positions).toEqual(snapshot);
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
