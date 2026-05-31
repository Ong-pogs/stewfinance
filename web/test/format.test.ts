import { describe, it, expect } from "vitest";
import { BN } from "@coral-xyz/anchor";
import { fmtUsdc, toBaseUnits } from "../lib/format";

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
