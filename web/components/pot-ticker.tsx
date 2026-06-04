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
    <div className="rounded-xl border border-border bg-card p-6 cauldron-glow">
      <div className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground mb-2">
        The pot grows forever
      </div>

      <div
        className={`flex items-baseline gap-0.5 font-mono tabular-nums ${risen ? "animate-pot-rise" : "opacity-0"}`}
      >
        <span className="text-5xl font-bold text-accent-warm leading-none">
          {intPart}
        </span>
        <span className="text-3xl font-bold text-accent-warm/70 leading-none">
          {decPart}
        </span>
        <span className="ml-1.5 text-sm font-semibold text-muted-foreground">USDC</span>
      </div>

      <div className="mt-2 flex items-center gap-1.5">
        <span className="text-xs text-muted-foreground">
          and climbing — the interest is the prize
        </span>
        <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground leading-tight">
          live estimate
        </span>
      </div>

      {estimatedPrize > 0 && (
        <div className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground">
          ~<span className="font-mono tabular-nums">{prizeFmt}</span> USDC estimated draw prize this week
          <span className="ml-1 text-muted-foreground/60">(illustration only)</span>
        </div>
      )}
    </div>
  );
}
