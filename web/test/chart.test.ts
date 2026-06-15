import { describe, it, expect } from "vitest";
import { BN } from "@coral-xyz/anchor";
import {
  barHeight,
  chartMax,
  cumulativePotFeed,
  type ChartPoint,
} from "../lib/chart";

const pt = (round: number, prize: number, potFeed: number): ChartPoint => ({
  round,
  prize: new BN(prize),
  potFeed: new BN(potFeed),
});

describe("barHeight", () => {
  const MAX_PX = 100;

  it("scales value/max linearly to pixels", () => {
    expect(barHeight(new BN(100), new BN(100), MAX_PX)).toBeCloseTo(100, 5);
    expect(barHeight(new BN(50), new BN(100), MAX_PX)).toBeCloseTo(50, 5);
    expect(barHeight(new BN(25), new BN(100), MAX_PX)).toBeCloseTo(25, 5);
  });

  it("returns 0 when max is zero or negative (no divide-by-zero)", () => {
    expect(barHeight(new BN(10), new BN(0), MAX_PX)).toBe(0);
    expect(barHeight(new BN(10), new BN(-5), MAX_PX)).toBe(0);
  });

  it("returns 0 for a zero or negative value", () => {
    expect(barHeight(new BN(0), new BN(100), MAX_PX)).toBe(0);
    expect(barHeight(new BN(-1), new BN(100), MAX_PX)).toBe(0);
  });

  it("gives a tiny-but-real value at least minPx so it stays visible", () => {
    // 1 / 1_000_000 of max → would round to ~0px without the floor.
    const h = barHeight(new BN(1), new BN(1_000_000), MAX_PX, 2);
    expect(h).toBe(2);
  });

  it("clamps a value larger than max to maxPx", () => {
    expect(barHeight(new BN(200), new BN(100), MAX_PX)).toBe(MAX_PX);
  });

  it("never exceeds maxPx even when maxPx < minPx (clamp wins over the floor)", () => {
    // A tiny-but-real value would normally floor to minPx (2), but with a
    // maxPx of 1 the [0,maxPx] contract must still hold → result is 1, not 2.
    const h = barHeight(new BN(1), new BN(1_000_000), 1, 2);
    expect(h).toBe(1);
  });

  it("handles the round-0 case: prize + its 20% pot feed share one scale", () => {
    // Round-0 prize ~20 USDC, pot feed = 20% = 4 USDC (base-units, 6 dp).
    const prize = new BN(20_000_000);
    const potFeed = new BN(4_000_000);
    const max = chartMax([{ round: 0, prize, potFeed }]);
    expect(barHeight(prize, max, MAX_PX)).toBeCloseTo(100, 5); // prize == max
    expect(barHeight(potFeed, max, MAX_PX)).toBeCloseTo(20, 5); // 20% of max
  });
});

describe("chartMax", () => {
  it("returns 0 for an empty list", () => {
    expect(chartMax([]).toString()).toBe("0");
  });

  it("picks the single largest of all prizes and pot feeds", () => {
    const points = [pt(0, 20, 4), pt(1, 35, 7), pt(2, 10, 2)];
    expect(chartMax(points).toString()).toBe("35");
  });

  it("can be driven by a pot feed if it exceeds every prize", () => {
    const points = [pt(0, 5, 99)];
    expect(chartMax(points).toString()).toBe("99");
  });
});

describe("cumulativePotFeed", () => {
  it("is 0 for an empty list", () => {
    expect(cumulativePotFeed([]).toString()).toBe("0");
  });

  it("sums growingPotAmount across rounds", () => {
    const points = [pt(0, 20, 4), pt(1, 35, 7), pt(2, 10, 2)];
    expect(cumulativePotFeed(points).toString()).toBe("13");
  });

  it("is order-independent (addition is commutative)", () => {
    const asc = [pt(0, 20, 4), pt(1, 35, 7), pt(2, 10, 2)];
    const desc = [pt(2, 10, 2), pt(1, 35, 7), pt(0, 20, 4)];
    expect(cumulativePotFeed(asc).toString()).toBe(
      cumulativePotFeed(desc).toString(),
    );
  });
});
