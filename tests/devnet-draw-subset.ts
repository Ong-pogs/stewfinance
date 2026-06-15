/**
 * Unit tests for scripts/devnet-draw.ts `selectPoolSubset` (Bug 5).
 *
 * The on-chain settle only checks Σweight == total_weight (a SUM), so two
 * distinct equal-weight position subsets both satisfy it on-chain. The crank
 * must NOT silently pick one — it must throw on ambiguity rather than risk
 * paying a foreign winner.
 *
 * Pure unit test — no RPC / validator needed. Importing the script does NOT run
 * its main() (guarded by require.main === module). Run:
 *   yarn ts-mocha -p ./tsconfig.json tests/devnet-draw-subset.ts
 */
import { expect } from "chai";
import { Keypair } from "@solana/web3.js";
import { selectPoolSubset } from "../scripts/devnet-draw";
import { PositionEntry } from "../app/crank/positions";

// Helper: build a PositionEntry. weight = amount * (drawTs - firstDepositTs).
function pos(amount: bigint, firstDepositTs: bigint): PositionEntry {
  const kp = Keypair.generate().publicKey;
  return {
    pubkey: kp,
    owner: kp,
    amount,
    firstDepositTs,
  };
}

const DRAW_TS = 1000n;

describe("selectPoolSubset — pool membership reconstruction (Bug 5)", () => {
  it("returns the unique subset whose weights sum to total_weight", () => {
    // Two pools mixed: pool A = {p0,p1}, foreign B = {p2}.
    // weights at draw_ts=1000: p0 = 10*(1000-900)=1000, p1 = 20*(1000-800)=4000,
    //                          p2 = 7*(1000-500)=3500.
    // total_weight for pool A = 5000; no other subset sums to 5000 → unique.
    const p0 = pos(10n, 900n); // w = 1000
    const p1 = pos(20n, 800n); // w = 4000
    const p2 = pos(7n, 500n); // w = 3500 (foreign pool)
    const out = selectPoolSubset([p0, p1, p2], DRAW_TS, 5000n);
    const owners = new Set(out.map((p) => p.pubkey.toBase58()));
    expect(owners.has(p0.pubkey.toBase58())).to.equal(true);
    expect(owners.has(p1.pubkey.toBase58())).to.equal(true);
    expect(owners.has(p2.pubkey.toBase58())).to.equal(false);
    expect(out.length).to.equal(2);
  });

  it("preserves the single-pool fallback: full set sums to total_weight", () => {
    // The real product case: one pool, all positions belong to it.
    const p0 = pos(10n, 900n); // w = 1000
    const p1 = pos(20n, 800n); // w = 4000
    const out = selectPoolSubset([p0, p1], DRAW_TS, 5000n);
    expect(out.length).to.equal(2);
  });

  it("THROWS when two distinct subsets share the same total_weight (ambiguous)", () => {
    // Four equal-weight positions: amount=10, firstDepositTs=900 → each w=1000.
    // total_weight = 2000 is satisfied by {p0,p1}, {p0,p2}, {p1,p3}, ... — many
    // distinct 2-subsets. The crank cannot safely pick one.
    const ps = [
      pos(10n, 900n),
      pos(10n, 900n),
      pos(10n, 900n),
      pos(10n, 900n),
    ];
    expect(() => selectPoolSubset(ps, DRAW_TS, 2000n)).to.throw(
      /ambiguous pool membership/
    );
  });

  it("throws when no subset sums to total_weight", () => {
    const p0 = pos(10n, 900n); // w = 1000
    const p1 = pos(20n, 800n); // w = 4000
    expect(() => selectPoolSubset([p0, p1], DRAW_TS, 99999n)).to.throw(
      /no subset/
    );
  });

  it("keeps the n>22 guard", () => {
    const many = Array.from({ length: 23 }, () => pos(1n, 900n));
    expect(() => selectPoolSubset(many, DRAW_TS, 1n)).to.throw(
      /too many positions/
    );
  });
});
