"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { illustrativeOdds } from "@/lib/gamify";

/**
 * HowItWorksInteractive — a hands-on "how the winner is picked" explainer.
 *
 * Two sliders (your deposit USDC, time held in days) play against a small,
 * FIXED sample pool of illustrative other depositors. As you drag, we live-
 * compute your weight (= size × time), the total pool weight (you + sample
 * others), and your odds % (your weight ÷ total) — with a horizontal bar.
 *
 * Honesty: this is an ILLUSTRATION against a sample pool. Real odds come from
 * the live on-chain pool (the same size × time formula — see /verify). The
 * math here uses `illustrativeOdds` from lib/gamify.ts (unit-tested), which
 * mirrors the shape of the on-chain `computeOdds`.
 *
 * Pure presentation: no contract / on-chain / computeOdds / tracking changes.
 * Reduced-motion safe — the slider is the interaction; bar/number transitions
 * are gated by `motion-safe:`. Banned words (lottery / stake / APY) stay out.
 */

// ── Fixed sample pool — a few illustrative "other depositors" ────────────────
// Deliberately varied so neither lever alone dominates: a big-but-fresh whale,
// a steady mid holder, and a small long-term holder.
const SAMPLE_POOL: { label: string; size: number; days: number }[] = [
  { label: "Whale, just joined", size: 2000, days: 3 }, // weight 6000
  { label: "Steady holder", size: 400, days: 18 },      // weight 7200
  { label: "Small + patient", size: 80, days: 30 },     // weight 2400
];

// Slider bounds (per spec).
const DEPOSIT_MIN = 10;
const DEPOSIT_MAX = 5000;
const DAYS_MIN = 0;
const DAYS_MAX = 30;

// Defaults — a modest position so both levers visibly matter when dragged.
const DEFAULT_DEPOSIT = 500;
const DEFAULT_DAYS = 7;

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}

const fmtInt = (n: number) =>
  Math.round(n).toLocaleString("en-US", { maximumFractionDigits: 0 });

export function HowItWorksInteractive() {
  const [deposit, setDeposit] = useState(DEFAULT_DEPOSIT);
  const [days, setDays] = useState(DEFAULT_DAYS);

  const { myWeight, totalWeight, oddsPct } = useMemo(
    () => illustrativeOdds(deposit, days, SAMPLE_POOL),
    [deposit, days],
  );

  // Bar fill clamped to 0.5–100% so even tiny shares stay visible.
  const barFill = totalWeight > 0 ? clamp(oddsPct, 0.5, 100) : 0;

  const oddsLabel =
    oddsPct <= 0 ? "0" : oddsPct < 0.1 ? "<0.1" : oddsPct.toFixed(1);

  // "What-if" chips nudge the sliders to spotlight each lever.
  const chips: { label: string; apply: () => void }[] = [
    {
      label: "Bigger deposit",
      apply: () => setDeposit((d) => clamp(d * 2, DEPOSIT_MIN, DEPOSIT_MAX)),
    },
    {
      label: "Hold longer",
      apply: () => setDays((d) => clamp(d + 10, DAYS_MIN, DAYS_MAX)),
    },
    {
      label: "Reset",
      apply: () => {
        setDeposit(DEFAULT_DEPOSIT);
        setDays(DEFAULT_DAYS);
      },
    },
  ];

  return (
    <section
      aria-labelledby="how-winner"
      className="mx-auto max-w-3xl px-6 py-20 sm:py-28"
    >
      <h2
        id="how-winner"
        className="text-3xl font-semibold tracking-tight sm:text-4xl"
      >
        How the winner is picked.
      </h2>
      <p className="mt-4 max-w-xl text-foreground/70">
        Your weight = deposit size × time held. Drag the sliders to see how each
        lever moves your share of the draw.
      </p>

      <div className="mt-10 rounded-lg border border-border bg-card p-6 sm:p-8">
        {/* Honesty banner */}
        <p className="mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-secondary/50 px-3 py-1 text-xs font-medium text-muted-foreground">
          <span
            aria-hidden="true"
            className="inline-block h-1.5 w-1.5 rounded-full bg-primary"
          />
          Illustration with a sample pool — your real odds depend on the live
          pool.
        </p>

        {/* ── Sliders ──────────────────────────────────────────────────── */}
        <div className="space-y-7">
          {/* Deposit slider */}
          <div>
            <div className="flex items-baseline justify-between">
              <label
                htmlFor="hiw-deposit"
                className="text-sm font-medium text-foreground"
              >
                Your deposit
              </label>
              <span className="font-mono text-base font-semibold tabular-nums text-foreground">
                {fmtInt(deposit)}{" "}
                <span className="text-xs font-normal text-muted-foreground">
                  USDC
                </span>
              </span>
            </div>
            <input
              id="hiw-deposit"
              type="range"
              min={DEPOSIT_MIN}
              max={DEPOSIT_MAX}
              step={10}
              value={deposit}
              onChange={(e) => setDeposit(Number(e.target.value))}
              aria-valuetext={`${fmtInt(deposit)} USDC`}
              className="mt-2 w-full accent-primary"
            />
            <div className="mt-1 flex justify-between font-mono text-[11px] tabular-nums text-muted-foreground">
              <span>{DEPOSIT_MIN}</span>
              <span>{fmtInt(DEPOSIT_MAX)} USDC</span>
            </div>
          </div>

          {/* Time-held slider */}
          <div>
            <div className="flex items-baseline justify-between">
              <label
                htmlFor="hiw-days"
                className="text-sm font-medium text-foreground"
              >
                Time held
              </label>
              <span className="font-mono text-base font-semibold tabular-nums text-foreground">
                {days}{" "}
                <span className="text-xs font-normal text-muted-foreground">
                  {days === 1 ? "day" : "days"}
                </span>
              </span>
            </div>
            <input
              id="hiw-days"
              type="range"
              min={DAYS_MIN}
              max={DAYS_MAX}
              step={1}
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              aria-valuetext={`${days} ${days === 1 ? "day" : "days"}`}
              className="mt-2 w-full accent-primary"
            />
            <div className="mt-1 flex justify-between font-mono text-[11px] tabular-nums text-muted-foreground">
              <span>{DAYS_MIN}d</span>
              <span>{DAYS_MAX}d</span>
            </div>
          </div>
        </div>

        {/* What-if chips */}
        <div className="mt-6 flex flex-wrap gap-2">
          {chips.map((c) => (
            <button
              key={c.label}
              type="button"
              onClick={c.apply}
              className="rounded-full border border-border bg-secondary/40 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-primary hover:text-foreground"
            >
              {c.label}
            </button>
          ))}
        </div>

        {/* ── Live results ─────────────────────────────────────────────── */}
        <div className="mt-8 border-t border-border pt-6">
          {/* Weight math row */}
          <div className="grid grid-cols-3 gap-3 text-center">
            <div className="rounded-lg bg-secondary/40 p-3">
              <div className="text-[11px] text-muted-foreground">
                Your weight
              </div>
              <div className="mt-1 font-mono text-lg font-semibold tabular-nums text-foreground">
                {fmtInt(myWeight)}
              </div>
              <div className="text-[10px] text-muted-foreground">
                {fmtInt(deposit)} × {days}
              </div>
            </div>
            <div className="rounded-lg bg-secondary/40 p-3">
              <div className="text-[11px] text-muted-foreground">
                Pool weight
              </div>
              <div className="mt-1 font-mono text-lg font-semibold tabular-nums text-foreground">
                {fmtInt(totalWeight)}
              </div>
              <div className="text-[10px] text-muted-foreground">
                you + {SAMPLE_POOL.length} others
              </div>
            </div>
            <div className="rounded-lg bg-secondary/40 p-3">
              <div className="text-[11px] text-muted-foreground">Your odds</div>
              <div className="mt-1 font-mono text-lg font-semibold tabular-nums text-accent-warm">
                {oddsLabel}%
              </div>
              <div className="text-[10px] text-muted-foreground">
                weight ÷ total
              </div>
            </div>
          </div>

          {/* Odds bar */}
          <div className="mt-5">
            <div className="mb-1 flex items-baseline justify-between text-xs text-muted-foreground">
              <span>Your share of the draw</span>
              <span className="font-mono tabular-nums text-accent-warm">
                {oddsLabel}%
              </span>
            </div>
            <div
              className="h-3 w-full overflow-hidden rounded-full bg-secondary"
              role="img"
              aria-label={`Your illustrative share of the draw: ${oddsLabel} percent`}
            >
              <div
                className="h-full rounded-full bg-primary motion-safe:transition-all motion-safe:duration-300"
                style={{ width: `${barFill}%` }}
              />
            </div>
          </div>
        </div>

        {/* Honesty caption */}
        <p className="mt-6 text-[11px] leading-relaxed text-muted-foreground">
          A <span className="font-medium text-foreground">bigger deposit</span>{" "}
          OR a{" "}
          <span className="font-medium text-foreground">longer time held</span>{" "}
          means more weight — nothing else changes your odds. One winner per
          draw is picked on-chain from a Switchboard VRF value, fully
          verifiable. The sample pool above is illustrative; your real odds
          depend on the live pool of depositors. See the real draw math on the{" "}
          <Link
            href="/verify"
            className="font-medium text-foreground underline decoration-border underline-offset-4 transition-colors hover:decoration-primary"
          >
            verify page
          </Link>
          .
        </p>
      </div>
    </section>
  );
}
