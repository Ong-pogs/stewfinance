import { describe, it, expect } from "vitest";
import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { selectWinners, wrapIndex } from "../lib/carousel";
import type { DrawSummary } from "../lib/stewfi";

// A real-ish winner pubkey (any non-default key works).
const WINNER = new PublicKey("738qzq7aZ7nE7vH9pQ2c8sJxZ9oXqHq1tQ6dWkR5mNp");

const draw = (over: Partial<DrawSummary>): DrawSummary => ({
  round: 0,
  status: "settled",
  prizePool: new BN(20_000_000),
  winner: WINNER,
  winnerAmount: new BN(13_000_000),
  winnerClaimed: false,
  drawTs: new BN(0),
  growingPotAmount: new BN(4_000_000),
  ...over,
});

describe("selectWinners", () => {
  it("keeps settled and claimed draws with a real positive winner", () => {
    const out = selectWinners([
      draw({ round: 0, status: "settled" }),
      draw({ round: 1, status: "claimed" }),
    ]);
    expect(out.map((w) => w.round)).toEqual([1, 0]); // newest first
  });

  it("drops pending/committed draws", () => {
    const out = selectWinners([
      draw({ round: 0, status: "pending" }),
      draw({ round: 1, status: "committed" }),
      draw({ round: 2, status: "settled" }),
    ]);
    expect(out.map((w) => w.round)).toEqual([2]);
  });

  it("drops draws with the default (zero) winner", () => {
    const out = selectWinners([
      draw({ round: 0, winner: PublicKey.default }),
      draw({ round: 1 }),
    ]);
    expect(out.map((w) => w.round)).toEqual([1]);
  });

  it("drops draws with a zero winner amount", () => {
    const out = selectWinners([
      draw({ round: 0, winnerAmount: new BN(0) }),
      draw({ round: 1 }),
    ]);
    expect(out.map((w) => w.round)).toEqual([1]);
  });

  it("returns [] for no eligible winners (round 0 still pending)", () => {
    expect(selectWinners([draw({ round: 0, status: "pending" })])).toEqual([]);
    expect(selectWinners([])).toEqual([]);
  });

  it("includes round 0 when it is settled (the live devnet case)", () => {
    const out = selectWinners([draw({ round: 0, status: "settled" })]);
    expect(out).toHaveLength(1);
    expect(out[0].round).toBe(0);
    expect(out[0].amount.toString()).toBe("13000000");
  });

  it("re-sorts to newest-first regardless of input order", () => {
    const out = selectWinners([
      draw({ round: 1 }),
      draw({ round: 3 }),
      draw({ round: 2 }),
    ]);
    expect(out.map((w) => w.round)).toEqual([3, 2, 1]);
  });
});

describe("wrapIndex", () => {
  it("returns the index unchanged when in range", () => {
    expect(wrapIndex(0, 3)).toBe(0);
    expect(wrapIndex(2, 3)).toBe(2);
  });

  it("wraps past the end back to the start", () => {
    expect(wrapIndex(3, 3)).toBe(0);
    expect(wrapIndex(4, 3)).toBe(1);
  });

  it("wraps a negative index to the end (prev from slide 0)", () => {
    expect(wrapIndex(-1, 3)).toBe(2);
    expect(wrapIndex(-2, 3)).toBe(1);
  });

  it("returns 0 for a non-positive length", () => {
    expect(wrapIndex(0, 0)).toBe(0);
    expect(wrapIndex(5, 0)).toBe(0);
    expect(wrapIndex(2, -1)).toBe(0);
  });

  it("handles a single slide (always index 0)", () => {
    expect(wrapIndex(0, 1)).toBe(0);
    expect(wrapIndex(1, 1)).toBe(0);
    expect(wrapIndex(-1, 1)).toBe(0);
  });
});
