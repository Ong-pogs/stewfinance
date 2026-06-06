"use client";
/**
 * WinnerCarousel — social-proof carousel of recent real winners.
 *
 * Reads on-chain with a WALLET-LESS AnchorProvider (same read-only pattern as
 * /verify, /stats, and the old hero spotlight), so it works disconnected.
 * Rotates through every settled/claimed draw that has a real winner
 * (round, abbrev(winner), winnerAmount), newest first.
 *
 * Behaviour:
 *   - Auto-advances every ~5s; PAUSES on hover and on keyboard focus.
 *   - Manual control via prev/next arrows and per-slide dots.
 *   - Respects prefers-reduced-motion: NO auto-advance, no slide transition —
 *     shows a static slide + working dots/arrows so it's still browsable.
 *   - Renders nothing if there are no settled winners or any read fails
 *     (purely additive; never blocks the hero).
 *
 * Pure presentation of facts the chain already proved — NO contract / odds /
 * tracking changes.
 */
import { useCallback, useEffect, useState } from "react";
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { STEWFI_IDL, Stewfi } from "@/lib/idl";
import { listDraws } from "@/lib/stewfi";
import { fmtUsdc, abbrev } from "@/lib/format";
import { selectWinners, wrapIndex, type WinnerSlide } from "@/lib/carousel";
import { RPC_URL } from "@/lib/constants";

const ADVANCE_MS = 5000;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function WinnerCarousel({ className = "" }: { className?: string }) {
  const [slides, setSlides] = useState<WinnerSlide[] | null>(null);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(false);

  // Detect reduced-motion once on mount (client-only).
  useEffect(() => {
    setReduced(prefersReducedMotion());
  }, []);

  // Wallet-less read of the real winners.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const conn = new Connection(RPC_URL, "confirmed");
        const provider = new AnchorProvider(
          conn,
          // Read-only: never signs, only satisfies the provider type.
          { publicKey: PublicKey.default } as AnchorProvider["wallet"],
          { commitment: "confirmed" },
        );
        const program = new Program<Stewfi>(STEWFI_IDL, provider);
        const winners = selectWinners(await listDraws(program));
        if (!cancelled) setSlides(winners);
      } catch {
        // Graceful: leave it unrendered on any read failure.
        if (!cancelled) setSlides([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const count = slides?.length ?? 0;

  const go = useCallback(
    (delta: number) => setIndex((i) => wrapIndex(i + delta, count)),
    [count],
  );

  // Auto-advance: only when motion is allowed, not paused, and >1 slide.
  useEffect(() => {
    if (reduced || paused || count <= 1) return;
    const id = setInterval(() => {
      setIndex((i) => wrapIndex(i + 1, count));
    }, ADVANCE_MS);
    return () => clearInterval(id);
  }, [reduced, paused, count]);

  // Keep the index valid if the slide set shrinks (defensive).
  const safeIndex = wrapIndex(index, count);

  // Nothing to show (no settled winners, still loading, or read failed).
  if (slides === null || count === 0) return null;

  const active = slides[safeIndex];

  return (
    <section
      aria-roledescription="carousel"
      aria-label="Recent winners"
      className={`mx-auto mt-8 w-full max-w-md ${className}`}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
    >
      <div className="rounded-2xl border border-border bg-card/70 p-5 text-left backdrop-blur">
        {/* Header row */}
        <div className="mb-3 flex items-center justify-between">
          <span className="inline-flex items-center gap-1.5 text-xs font-medium uppercase tracking-widest text-muted-foreground">
            <span aria-hidden="true">🏆</span> Recent winners
          </span>
          {count > 1 && (
            <span className="font-mono text-[11px] tabular-nums text-muted-foreground/70">
              {safeIndex + 1}/{count}
            </span>
          )}
        </div>

        {/* Slide */}
        <div
          aria-live="polite"
          aria-atomic="true"
          className="flex items-center gap-3"
        >
          {count > 1 && (
            <button
              type="button"
              onClick={() => go(-1)}
              aria-label="Previous winner"
              className="shrink-0 rounded-full border border-border bg-secondary px-2.5 py-1.5 text-sm text-foreground transition-colors hover:border-primary"
            >
              <span aria-hidden="true">←</span>
            </button>
          )}

          <div className="min-w-0 flex-1 text-center">
            <div className="font-mono text-2xl font-bold tabular-nums leading-none text-accent-warm">
              {fmtUsdc(active.amount)}
              <span className="ml-1.5 text-sm font-semibold text-muted-foreground">
                USDC
              </span>
            </div>
            <div className="mt-2 text-sm text-foreground/80">
              <span className="font-mono tabular-nums text-foreground">
                {abbrev(active.winner)}
              </span>{" "}
              won round{" "}
              <span className="font-mono tabular-nums text-foreground">
                {active.round}
              </span>
            </div>
          </div>

          {count > 1 && (
            <button
              type="button"
              onClick={() => go(1)}
              aria-label="Next winner"
              className="shrink-0 rounded-full border border-border bg-secondary px-2.5 py-1.5 text-sm text-foreground transition-colors hover:border-primary"
            >
              <span aria-hidden="true">→</span>
            </button>
          )}
        </div>

        {/* Dots */}
        {count > 1 && (
          <div className="mt-4 flex items-center justify-center gap-1.5">
            {slides.map((s, i) => (
              <button
                key={s.round}
                type="button"
                onClick={() => setIndex(i)}
                aria-label={`Show winner ${i + 1} of ${count}`}
                aria-current={i === safeIndex ? "true" : undefined}
                className={`h-1.5 rounded-full transition-all ${
                  i === safeIndex
                    ? "w-5 bg-accent-warm"
                    : "w-1.5 bg-border hover:bg-muted-foreground"
                }`}
              />
            ))}
          </div>
        )}

        {/* Honest caption */}
        <p className="mt-3 text-center text-[11px] leading-snug text-muted-foreground">
          Real on-chain winners — principal never moved.
        </p>
      </div>
    </section>
  );
}
