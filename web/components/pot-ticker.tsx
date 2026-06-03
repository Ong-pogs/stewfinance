"use client";
import { useEffect, useRef, useState } from "react";
import { BN } from "@coral-xyz/anchor";
import { fmtUsdc } from "@/lib/format";
import { potEstimate } from "@/lib/gamify";

/** Shape we need from the readPool result. */
export type PotTickerPool = {
  potPrincipalUsdc: BN;
  totalPrincipal: BN;
};

export function PotTicker({ pool }: { pool: PotTickerPool }) {
  // Cosmetic fractional tail: starts at the real anchored value and drifts
  // upward by ~$0.000001 per second so the display feels live.
  // The integer part is always anchored to the on-chain value.
  const realUsdc = pool.potPrincipalUsdc.toNumber() / 1_000_000;
  const potPrincipalStr = pool.potPrincipalUsdc.toString();
  const [tail, setTail] = useState(0); // fractional offset in USDC
  const startRef = useRef(Date.now());
  const riseApplied = useRef(false);
  const [risen, setRisen] = useState(false);

  useEffect(() => {
    startRef.current = Date.now();
    setTail(0);
    // Trigger entrance animation once per mount
    if (!riseApplied.current) {
      riseApplied.current = true;
      requestAnimationFrame(() => setRisen(true));
    }

    const id = setInterval(() => {
      const elapsed = (Date.now() - startRef.current) / 1000;
      // ~$0.0000011/s — purely cosmetic, labelled "live estimate"
      setTail(elapsed * 0.0000011);
    }, 1000);
    return () => clearInterval(id);
  }, [potPrincipalStr]);

  const displayValue = realUsdc + tail;
  // Split into integer and decimal parts for odometer styling
  const intPart = Math.floor(displayValue).toLocaleString("en-US");
  const decPart = (displayValue % 1).toFixed(6).slice(1); // ".000000"

  const estimatedPrize = potEstimate(pool.totalPrincipal);
  const prizeFmt = fmtUsdc(new BN(estimatedPrize));

  return (
    <div className="rounded-xl border border-purple-800/50 p-5 cauldron-glow">
      <div className="text-xs font-medium uppercase tracking-widest text-purple-400 mb-1">
        The pot grows forever
      </div>

      <div
        className={`flex items-baseline gap-0.5 ${risen ? "animate-pot-rise" : "opacity-0"}`}
      >
        <span className="text-4xl font-bold tabular-nums text-white leading-none">
          {intPart}
        </span>
        <span className="text-2xl font-bold tabular-nums text-purple-300 leading-none">
          {decPart}
        </span>
        <span className="ml-1 text-sm font-semibold text-purple-400">USDC</span>
      </div>

      <div className="mt-1 flex items-center gap-1.5">
        <span className="text-xs text-zinc-500">
          Pot: {fmtUsdc(pool.potPrincipalUsdc)} USDC and climbing
        </span>
        <span className="rounded bg-purple-900/50 px-1 py-0.5 text-[10px] text-purple-400 leading-tight">
          live estimate
        </span>
      </div>

      {estimatedPrize > 0 && (
        <div className="mt-3 border-t border-zinc-800 pt-3 text-xs text-zinc-400">
          ~{prizeFmt} USDC estimated draw prize this week
          <span className="ml-1 text-zinc-600">(illustration only)</span>
        </div>
      )}
    </div>
  );
}
