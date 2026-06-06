"use client";
import { useEffect, useMemo, useState } from "react";
import { BN } from "@coral-xyz/anchor";
import { projectOdds } from "@/lib/gamify";

/**
 * OddsProjection — a small inline-SVG line chart showing how your draw-weight
 * share is PROJECTED to grow over the next ~14 days IF the pool stays unchanged.
 *
 * HONESTY: the chain stores no odds-history, so this is NOT past data and NOT a
 * guarantee. It holds the pool fixed and ages your deposit forward (weight =
 * amount × time-held), so your share drifts up while the pool stands still. Real
 * odds move as others deposit/withdraw. The label says exactly that.
 *
 * Pure math comes from `projectOdds` (lib/gamify.ts) — the same BN formula as
 * computeOdds, evaluated at future timestamps. No charting dependency: a single
 * <polyline> scaled in viewBox space (mirrors lib/chart.ts's approach).
 *
 * Reduced-motion safe (a one-shot line draw-in is skipped under
 * prefers-reduced-motion). Hidden entirely when there is no position.
 *
 * Banned words (lottery / stake / APY) stay out of all copy.
 */

const DAYS = 14;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function OddsProjection({
  myAmount,
  firstDepositTs,
  sumAmount,
  sumAmountFirstTs,
}: {
  /** Connected wallet's position amount (base units) or null when none. */
  myAmount: BN | null;
  /** Connected wallet's first-deposit timestamp (unix seconds) or null. */
  firstDepositTs: BN | null;
  /** PoolConfig.sumAmount accumulator or null. */
  sumAmount: BN | null;
  /** PoolConfig.sumAmountFirstTs accumulator or null. */
  sumAmountFirstTs: BN | null;
}) {
  // nowTs is captured once at mount so the projection is stable across renders.
  const [nowTs] = useState(() => Math.floor(Date.now() / 1000));

  const series = useMemo(
    () =>
      projectOdds({
        myAmount,
        firstDepositTs,
        sumAmount,
        sumAmountFirstTs,
        nowTs,
        days: DAYS,
      }),
    [myAmount, firstDepositTs, sumAmount, sumAmountFirstTs, nowTs],
  );

  // Draw-in animation: a one-shot reveal, skipped under reduced-motion.
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    if (prefersReducedMotion()) {
      setRevealed(true);
      return;
    }
    const id = requestAnimationFrame(() => setRevealed(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Hide entirely when there is no real position (nothing honest to project).
  const hasPosition = !!myAmount && myAmount.gtn(0);
  if (!hasPosition || series.length < 2) return null;

  const current = series[0].oddsPct;
  const projected = series[series.length - 1].oddsPct;

  // ── viewBox geometry (scales to container via width:100%) ──────────────────
  const VB_W = 600;
  const VB_H = 180;
  const PAD_L = 40; // y-axis labels
  const PAD_R = 10;
  const PAD_TOP = 12;
  const PAD_BOTTOM = 26; // x-axis day labels
  const plotW = VB_W - PAD_L - PAD_R;
  const plotH = VB_H - PAD_TOP - PAD_BOTTOM;
  const baseY = PAD_TOP + plotH;

  // y-scale: top of the plot = the projected max, with a little headroom so the
  // line never touches the ceiling. Floor at a small value to avoid a flat line
  // looking like a divide-by-zero. Bounded at 100.
  const peak = Math.max(...series.map((p) => p.oddsPct));
  const yMax = Math.min(100, Math.max(peak * 1.15, peak + 0.5, 0.5));

  const xFor = (day: number) => PAD_L + (plotW * day) / DAYS;
  const yFor = (pct: number) =>
    baseY - (plotH * Math.max(0, Math.min(yMax, pct))) / yMax;

  const linePts = series.map((p) => `${xFor(p.day)},${yFor(p.oddsPct)}`).join(" ");
  // Area under the line, for a soft fill (closes down to the baseline).
  const areaPts = `${xFor(0)},${baseY} ${linePts} ${xFor(DAYS)},${baseY}`;

  const fmtPct = (v: number) => (v < 0.1 ? "<0.1" : v.toFixed(1));

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Odds projection
        </div>
        <div className="font-mono text-xs tabular-nums text-muted-foreground">
          {fmtPct(current)}% <span aria-hidden="true">→</span>{" "}
          <span className="text-accent-warm">{fmtPct(projected)}%</span> in {DAYS}d
        </div>
      </div>

      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        width="100%"
        role="img"
        aria-label={`Projected draw-weight share over the next ${DAYS} days: from ${fmtPct(
          current,
        )} percent today to about ${fmtPct(
          projected,
        )} percent, assuming the pool stays unchanged.`}
        className="mt-2 block"
      >
        {/* baseline (x-axis) */}
        <line
          x1={PAD_L}
          y1={baseY}
          x2={VB_W - PAD_R}
          y2={baseY}
          className="stroke-border"
          strokeWidth={1}
        />
        {/* y-axis labels: max (top) and 0 (base) */}
        <text
          x={PAD_L - 6}
          y={PAD_TOP + 8}
          textAnchor="end"
          className="fill-muted-foreground font-mono tabular-nums"
          style={{ fontSize: 9 }}
        >
          {fmtPct(yMax)}%
        </text>
        <text
          x={PAD_L - 6}
          y={baseY}
          textAnchor="end"
          className="fill-muted-foreground font-mono tabular-nums"
          style={{ fontSize: 9 }}
        >
          0%
        </text>

        {/* soft area fill under the projection */}
        <polygon points={areaPts} className="fill-accent-warm" opacity={0.08} />

        {/* the projection line — fades in once; under reduced-motion `revealed`
            is set synchronously so it appears immediately with no transition. */}
        <polyline
          points={linePts}
          fill="none"
          className="stroke-accent-warm"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          style={{
            opacity: revealed ? 1 : 0,
            transition: "opacity 500ms ease-out",
          }}
        />

        {/* "today" marker — current odds at day 0 */}
        <circle
          cx={xFor(0)}
          cy={yFor(current)}
          r={3.5}
          className="fill-foreground"
        >
          <title>{`Today — ${fmtPct(current)}% share`}</title>
        </circle>
        <text
          x={xFor(0)}
          y={baseY + 16}
          textAnchor="start"
          className="fill-muted-foreground font-mono tabular-nums"
          style={{ fontSize: 9 }}
        >
          now
        </text>

        {/* projected end marker — day 14 */}
        <circle
          cx={xFor(DAYS)}
          cy={yFor(projected)}
          r={3.5}
          className="fill-accent-warm"
        >
          <title>{`In ${DAYS} days — ~${fmtPct(projected)}% (projection)`}</title>
        </circle>
        <text
          x={xFor(DAYS)}
          y={baseY + 16}
          textAnchor="end"
          className="fill-muted-foreground font-mono tabular-nums"
          style={{ fontSize: 9 }}
        >
          +{DAYS}d
        </text>
      </svg>

      <p className="mt-2 text-[10px] leading-snug text-muted-foreground">
        Projection — assumes the pool stays the same; real odds move as others
        deposit or withdraw. It tracks how your draw-weight share (size × time
        held) drifts as your deposit ages. Not a guarantee and not past data.
      </p>
    </div>
  );
}
