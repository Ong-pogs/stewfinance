import { describe, it, expect } from "vitest";
import { formatCountdown, statusLabel } from "../lib/draw-utils";

describe("formatCountdown", () => {
  it("returns 0:00:00:00 for zero or negative", () => {
    expect(formatCountdown(0)).toBe("0:00:00:00");
    expect(formatCountdown(-5)).toBe("0:00:00:00");
  });

  it("formats seconds only", () => {
    expect(formatCountdown(45)).toBe("0:00:00:45");
  });

  it("formats minutes and seconds", () => {
    expect(formatCountdown(90)).toBe("0:00:01:30");
  });

  it("formats hours", () => {
    expect(formatCountdown(3661)).toBe("0:01:01:01");
  });

  it("formats days", () => {
    // 2 days + 1 hour + 2 minutes + 3 seconds
    const secs = 2 * 86400 + 1 * 3600 + 2 * 60 + 3;
    expect(formatCountdown(secs)).toBe("2:01:02:03");
  });
});

describe("statusLabel", () => {
  it("maps known statuses", () => {
    expect(statusLabel("pending")).toBe("Pending");
    expect(statusLabel("committed")).toBe("Committed");
    expect(statusLabel("settled")).toBe("Settled");
    expect(statusLabel("claimed")).toBe("Claimed");
  });

  it("returns the raw string for unknowns", () => {
    expect(statusLabel("unknown")).toBe("unknown");
  });
});
