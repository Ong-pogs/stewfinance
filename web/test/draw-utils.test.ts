import { describe, it, expect } from "vitest";
import { formatCountdown, statusLabel, isDrawSoon } from "../lib/draw-utils";

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

describe("isDrawSoon", () => {
  const NOW = 1_000_000;
  const SIX_HOURS = 6 * 3600;

  it("is true when the draw is within the threshold", () => {
    expect(isDrawSoon(NOW + 3600, NOW, SIX_HOURS)).toBe(true); // 1h out
    expect(isDrawSoon(NOW + SIX_HOURS, NOW, SIX_HOURS)).toBe(true); // exactly at threshold
    expect(isDrawSoon(NOW + 1, NOW, SIX_HOURS)).toBe(true); // 1s out
  });

  it("is false when the draw is beyond the threshold", () => {
    expect(isDrawSoon(NOW + SIX_HOURS + 1, NOW, SIX_HOURS)).toBe(false);
    expect(isDrawSoon(NOW + 7 * 86400, NOW, SIX_HOURS)).toBe(false); // a week out
  });

  it("is false when the draw time is now or already past", () => {
    expect(isDrawSoon(NOW, NOW, SIX_HOURS)).toBe(false); // exactly now
    expect(isDrawSoon(NOW - 1, NOW, SIX_HOURS)).toBe(false); // 1s overdue
    expect(isDrawSoon(NOW - 3600, NOW, SIX_HOURS)).toBe(false); // long overdue
  });

  it("is false for a missing or non-positive timestamp", () => {
    expect(isDrawSoon(null, NOW, SIX_HOURS)).toBe(false);
    expect(isDrawSoon(undefined, NOW, SIX_HOURS)).toBe(false);
    expect(isDrawSoon(0, NOW, SIX_HOURS)).toBe(false);
    expect(isDrawSoon(-5, NOW, SIX_HOURS)).toBe(false);
  });
});
