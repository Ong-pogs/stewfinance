import { describe, it, expect } from "vitest";
import { BN } from "@coral-xyz/anchor";
import { fmtUsdc, toBaseUnits, easeOutCubic, tween } from "../lib/format";

describe("format", () => {
  it("fmtUsdc base units -> human", () => {
    expect(fmtUsdc(new BN(10_000_000))).toBe("10.00");
    expect(fmtUsdc(new BN(1_234_560))).toBe("1.23");
    expect(fmtUsdc(new BN(0))).toBe("0.00");
  });
  it("toBaseUnits human -> base units", () => {
    expect(toBaseUnits(10).toString()).toBe("10000000");
    expect(toBaseUnits(0.5).toString()).toBe("500000");
  });
});

describe("count-up tween", () => {
  it("easeOutCubic clamps and hits endpoints", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(-1)).toBe(0); // clamped
    expect(easeOutCubic(2)).toBe(1); // clamped
    // Eased: out-cubic is past the midpoint at t=0.5.
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
  });
  it("tween settles exactly on the target at t>=1", () => {
    expect(tween(100, 250, 1)).toBe(250);
    expect(tween(100, 250, 1.5)).toBe(250);
  });
  it("tween starts at the source at t<=0", () => {
    expect(tween(100, 250, 0)).toBe(100);
    expect(tween(100, 250, -0.2)).toBe(100);
  });
  it("tween is monotonic increasing between endpoints", () => {
    const a = tween(0, 100, 0.25);
    const b = tween(0, 100, 0.75);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(b).toBeLessThan(100);
  });
});
