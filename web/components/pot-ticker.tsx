"use client";
import { useEffect, useRef, useState } from "react";
import { BN } from "@coral-xyz/anchor";
import { fmtUsdc, tween } from "@/lib/format";
import { potEstimate } from "@/lib/gamify";
import { InfoTooltip } from "@/components/tooltip";

/** Shape we need from the readPool result. */
export type PotTickerPool = {
  potPrincipalUsdc: BN;
  totalPrincipal: BN;
};

const COUNT_UP_MS = 600;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

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

  // Animated base value: tweens from the previous on-chain value to the new one
  // when the pot prop changes, so the integer part counts up smoothly.
  const [animBase, setAnimBase] = useState(realUsdc);
  const animFromRef = useRef(realUsdc); // value shown when the last change began
  const rafRef = useRef<number | null>(null);

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

  // Count-up tween when the on-chain pot value changes.
  useEffect(() => {
    const from = animFromRef.current;
    const to = realUsdc;
    if (from === to) return;

    // Reduced motion → snap to the new value, no tween.
    if (prefersReducedMotion()) {
      animFromRef.current = to;
      setAnimBase(to);
      return;
    }

    const start = Date.now();
    const step = () => {
      const t = (Date.now() - start) / COUNT_UP_MS;
      const v = tween(from, to, t);
      // Keep the "from" ref live so an interrupting value tweens from here, not a stale start.
      animFromRef.current = v;
      setAnimBase(v);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        animFromRef.current = to;
        rafRef.current = null;
      }
    };
    rafRef.current = requestAnimationFrame(step);

    return () => {
      // Interrupted by a newer value: the next tween continues from animFromRef (live).
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [realUsdc]);

  const displayValue = animBase + tail;
  // Split into integer and decimal parts for odometer styling
  const intPart = Math.floor(displayValue).toLocaleString("en-US");
  const decPart = (displayValue % 1).toFixed(6).slice(1); // ".000000"

  const estimatedPrize = potEstimate(pool.totalPrincipal);
  const prizeFmt = fmtUsdc(new BN(estimatedPrize));

  return (
    <div className="rounded-xl border border-border bg-card p-6 cauldron-glow">
      <div className="mb-2 flex items-center gap-1 text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
        Growing Pot
        <InfoTooltip label="Growing Pot">
          20% of every prize compounds here; its yield feeds future prizes — so
          the prize grows over time.
        </InfoTooltip>
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
        <div className="mt-4 flex flex-wrap items-center gap-x-1 border-t border-border pt-3 text-xs text-muted-foreground">
          <span>
            ~<span className="font-mono tabular-nums">{prizeFmt}</span> USDC estimated draw prize this week
          </span>
          <InfoTooltip label="Prize estimate">
            Devnet: prize is test yield injected into the pool, not real Kamino
            yield.
          </InfoTooltip>
          <span className="text-muted-foreground">(illustration only)</span>
        </div>
      )}
    </div>
  );
}
