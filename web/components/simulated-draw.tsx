"use client";
import { useMemo, useState } from "react";
import { BN } from "@coral-xyz/anchor";
import { fmtUsdc } from "@/lib/format";
import { MOCK_APY } from "@/lib/constants";

// Mirrors the on-chain winner math (programs/stewfi/src/lib.rs, settle_draw):
//   per-user weight = amount × (draw_ts − first_deposit_ts)      // size × time held
//   total_weight    = draw_ts × Σamount − Σ(amount × first_ts)   // from PoolConfig accumulators
//   odds            = your weight ÷ total weight
// We use `now` as the stand-in for draw_ts so the odds shown are "if the draw happened now".
export function SimulatedDraw({
  poolTotal,
  myAmount,
  firstDepositTs,
  sumAmount,
  sumAmountFirstTs,
}: {
  poolTotal: BN | null;
  myAmount: BN | null;
  firstDepositTs: BN | null;
  sumAmount: BN | null;
  sumAmountFirstTs: BN | null;
}) {
  const [rolling, setRolling] = useState(false);
  const [won, setWon] = useState<boolean | null>(null);

  const weeklyPrize = useMemo(() => {
    if (!poolTotal) return new BN(0);
    // illustrative: pool * APY / 52
    return new BN(Math.floor((Number(poolTotal.toString()) * MOCK_APY) / 52));
  }, [poolTotal]);

  // Real weight-based odds, computed with BN (the accumulators overflow JS floats).
  const { myOdds, ageSecs } = useMemo(() => {
    const now = Math.floor(Date.now() / 1000);
    const age =
      firstDepositTs ? Math.max(0, now - firstDepositTs.toNumber()) : 0;
    if (!myAmount || !sumAmount || !sumAmountFirstTs) return { myOdds: 0, ageSecs: age };
    const totalWeight = new BN(now).mul(sumAmount).sub(sumAmountFirstTs);
    if (totalWeight.lten(0)) return { myOdds: 0, ageSecs: age };
    const myWeight = myAmount.mul(new BN(age));
    // ratio with precision: myWeight * 1e6 / totalWeight  ->  0..1e6
    const scaled = myWeight.muln(1_000_000).div(totalWeight).toNumber();
    return { myOdds: Math.min(scaled / 1_000_000, 1), ageSecs: age };
  }, [myAmount, firstDepositTs, sumAmount, sumAmountFirstTs]);

  const heldLabel =
    ageSecs < 3600
      ? `${Math.floor(ageSecs / 60)}m`
      : ageSecs < 86400
        ? `${(ageSecs / 3600).toFixed(1)}h`
        : `${(ageSecs / 86400).toFixed(1)}d`;

  function preview() {
    setRolling(true);
    setWon(null);
    // purely illustrative weighted coin-flip; not on-chain
    setTimeout(() => {
      setWon(Math.random() < Math.max(myOdds, 0.0001));
      setRolling(false);
    }, 1200);
  }

  return (
    <div className="rounded-xl border border-purple-800/50 p-5 cauldron-glow">
      <div className="text-sm text-zinc-400">Next weekly prize (illustrative)</div>
      <div className="mt-1 text-3xl font-bold stew-accent">~{fmtUsdc(weeklyPrize)} USDC</div>

      {/* How odds work — always visible so users understand before depositing */}
      <div className="mt-3 rounded-lg bg-zinc-900/60 border border-zinc-800 p-3 text-xs text-zinc-400">
        <div className="font-semibold text-zinc-300">How the winner is picked</div>
        <p className="mt-1">
          Each week one depositor wins the pooled interest. Your chance ={" "}
          <span className="text-zinc-200">your weight ÷ everyone&apos;s weight</span>.
        </p>
        <p className="mt-1">
          <span className="stew-accent font-semibold">Weight = deposit size × time held.</span>{" "}
          Deposit more, or leave it parked longer, and your odds climb. Topping up keeps your
          start time; a full withdraw resets it. Principal is never at risk.
        </p>
      </div>

      {myAmount && (
        <div className="mt-3 text-sm text-zinc-300">
          Your weight: <span className="font-mono">{fmtUsdc(myAmount)} USDC × {heldLabel} held</span>
          {" → "}
          <span className="stew-accent font-semibold">{(myOdds * 100).toFixed(1)}% chance</span> this week
          <div className="mt-0.5 text-xs text-zinc-500">
            Live estimate — your share moves as others deposit or withdraw, and as all deposits
            age. New players start near 0% and ramp up. One winner per draw.
          </div>
        </div>
      )}

      <button
        onClick={preview}
        disabled={rolling || !myAmount}
        className="mt-4 w-full rounded-lg border border-purple-700 py-2 text-sm disabled:opacity-50"
      >
        {rolling ? "Drawing…" : "Preview the draw (simulated)"}
      </button>
      {won !== null && (
        <p className={`mt-3 text-center font-semibold ${won ? "stew-accent" : "text-zinc-400"}`}>
          {won
            ? "🏆 You'd win this week!"
            : "No win this week — your principal is still 100% safe."}
        </p>
      )}
      <p className="mt-2 text-xs text-zinc-600">
        Odds are computed with the real on-chain formula. The draw itself is simulated here — real
        draws use Switchboard VRF (not wired on devnet).
      </p>
    </div>
  );
}
