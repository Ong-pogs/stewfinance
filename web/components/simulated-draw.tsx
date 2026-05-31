"use client";
import { useMemo, useState } from "react";
import { BN } from "@coral-xyz/anchor";
import { fmtUsdc } from "@/lib/format";
import { MOCK_APY } from "@/lib/constants";

export function SimulatedDraw({ poolTotal, myAmount }: { poolTotal: BN | null; myAmount: BN | null }) {
  const [rolling, setRolling] = useState(false);
  const [won, setWon] = useState<boolean | null>(null);

  const weeklyPrize = useMemo(() => {
    if (!poolTotal) return new BN(0);
    // illustrative: pool * APY / 52
    return new BN(Math.floor((Number(poolTotal.toString()) * MOCK_APY) / 52));
  }, [poolTotal]);

  const myOdds = useMemo(() => {
    if (!poolTotal || !myAmount || poolTotal.isZero()) return 0;
    return Number(myAmount.toString()) / Number(poolTotal.toString());
  }, [poolTotal, myAmount]);

  function preview() {
    setRolling(true); setWon(null);
    // purely illustrative weighted coin-flip; not on-chain
    setTimeout(() => { setWon(Math.random() < Math.max(myOdds, 0.0001)); setRolling(false); }, 1200);
  }

  return (
    <div className="rounded-xl border border-purple-800/50 p-5 cauldron-glow">
      <div className="text-sm text-zinc-400">Next weekly prize (illustrative)</div>
      <div className="mt-1 text-3xl font-bold stew-accent">~{fmtUsdc(weeklyPrize)} USDC</div>
      <div className="mt-1 text-sm text-zinc-500">
        Your odds: {(myOdds * 100).toFixed(1)}% · {fmtUsdc(weeklyPrize)} goes to one winner, principal untouched.
      </div>
      <button onClick={preview} disabled={rolling}
        className="mt-4 w-full rounded-lg border border-purple-700 py-2 text-sm">
        {rolling ? "Drawing…" : "Preview the draw (simulated)"}
      </button>
      {won !== null && (
        <p className={`mt-3 text-center font-semibold ${won ? "stew-accent" : "text-zinc-400"}`}>
          {won ? "🏆 You'd win this week!" : "No win this week — your principal is still 100% safe."}
        </p>
      )}
      <p className="mt-2 text-xs text-zinc-600">Simulated. Real draws use on-chain Switchboard VRF (not wired on devnet).</p>
    </div>
  );
}
