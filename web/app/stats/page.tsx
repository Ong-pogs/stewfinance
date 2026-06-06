"use client";
/**
 * /stats — pool-wide transparency dashboard.
 *
 * Read-only, works disconnected (wallet-less AnchorProvider, same pattern as
 * /verify). Pure presentation of facts already on-chain — NO contract, odds,
 * or tracking changes.
 *
 * Shows:
 *   1. Headline tiles from `readPool`: TVL (total_principal), Growing Pot
 *      (pot_principal_usdc), current round, # of pool members (poolMemberSubset
 *      over readAllPositions so strays are excluded), pending winnings.
 *   2. A lightweight INLINE SVG bar chart (no charting dep) of the prize per
 *      settled round, with a stacked "fed the pot" (growingPotAmount) segment.
 *   3. A "Pot growth" readout: cumulative growing-pot contributions over rounds.
 *   4. EmptyState (live tiles only) when there are no settled draws.
 */
import { useCallback, useEffect, useState } from "react";
import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import Link from "next/link";
import { ThemeToggle } from "@/components/theme-toggle";
import { EmptyState, LoadError } from "@/components/empty-state";
import { STEWFI_IDL, Stewfi } from "@/lib/idl";
import { readPool, listDraws, readAllPositions } from "@/lib/stewfi";
import { poolMemberSubset } from "@/lib/gamify";
import { fmtUsdc } from "@/lib/format";
import {
  barHeight,
  chartMax,
  cumulativePotFeed,
  type ChartPoint,
} from "@/lib/chart";
import { RPC_URL } from "@/lib/constants";

// ── what the page renders (a snapshot the chain already proved) ──────────────
type StatsData = {
  tvl: BN;
  growingPot: BN;
  currentRound: number;
  members: number;
  pendingWinnings: BN;
  // settled rounds, ascending by round (oldest → newest, left → right on chart)
  points: ChartPoint[];
};

export default function StatsPage() {
  const [data, setData] = useState<StatsData | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const load = useCallback(async () => {
    setLoadError(false);
    setRetrying(true);
    try {
      const conn = new Connection(RPC_URL, "confirmed");
      const provider = new AnchorProvider(
        conn,
        // Read-only: never signs, only satisfies the provider type.
        { publicKey: PublicKey.default } as AnchorProvider["wallet"],
        { commitment: "confirmed" },
      );
      const program = new Program<Stewfi>(STEWFI_IDL, provider);

      const [pool, draws, allPositions] = await Promise.all([
        readPool(program),
        listDraws(program),
        readAllPositions(program),
      ]);

      const tvl = pool ? (pool.totalPrincipal as BN) : new BN(0);
      const growingPot = pool ? (pool.potPrincipalUsdc as BN) : new BN(0);
      const currentRound = pool ? (pool.currentRound as BN).toNumber() : 0;
      const pendingWinnings = pool ? (pool.pendingWinnings as BN) : new BN(0);

      // Real member count: subset of global positions that reconciles to TVL.
      const members = poolMemberSubset(allPositions, tvl).length;

      // Settled/claimed draws → chart points, ascending by round.
      const points: ChartPoint[] = draws
        .filter((d) => d.status === "settled" || d.status === "claimed")
        .map((d) => ({
          round: d.round,
          prize: d.prizePool,
          potFeed: d.growingPotAmount,
        }))
        .sort((a, b) => a.round - b.round);

      setData({ tvl, growingPot, currentRound, members, pendingWinnings, points });
    } catch {
      setLoadError(true);
    } finally {
      setRetrying(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      {/* Top bar */}
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">
          <span className="bg-[image:--gradient-text] bg-clip-text text-transparent">
            StewFi
          </span>
        </h1>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Link
            href="/app"
            className="rounded-lg border border-border bg-secondary px-3 py-2 text-sm font-medium text-foreground transition-colors hover:border-primary"
          >
            Open app
          </Link>
        </div>
      </div>

      {/* Header / intent */}
      <header className="mb-8">
        <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Pool stats.
        </h2>
        <p className="mt-3 max-w-2xl text-pretty text-sm leading-relaxed text-foreground/80">
          A live, read-only view of the whole pool, straight from on-chain data.
          The <strong>Growing Pot</strong> takes a 20% slice of every prize and
          compounds — so the prize grows forever.
        </p>
      </header>

      {/* Body */}
      {loadError && data === null ? (
        <LoadError onRetry={load} retrying={retrying} />
      ) : data === null ? (
        <div className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
          Reading the chain…
        </div>
      ) : (
        <div className="space-y-8">
          {/* 1. Headline tiles */}
          <section
            aria-label="Pool headline stats"
            className="grid grid-cols-2 gap-3 sm:grid-cols-3"
          >
            <Tile label="TVL" value={`${fmtUsdc(data.tvl)}`} unit="USDC" accent />
            <Tile
              label="Growing Pot"
              value={`${fmtUsdc(data.growingPot)}`}
              unit="USDC"
              accent
            />
            <Tile label="Current round" value={String(data.currentRound)} mono />
            <Tile label="Pool members" value={String(data.members)} mono />
            <Tile
              label="Pending winnings"
              value={`${fmtUsdc(data.pendingWinnings)}`}
              unit="USDC"
            />
          </section>

          {/* 2 + 3. Prize history chart + pot-growth readout, or EmptyState */}
          {data.points.length === 0 ? (
            <div className="rounded-xl border border-border bg-card p-5">
              <EmptyState
                icon="📈"
                title="No settled draws yet"
                hint="Once the pool runs its first weekly draw, the prize history and pot-growth chart appear here."
              />
            </div>
          ) : (
            <>
              <PrizeHistory points={data.points} />
              <PotGrowth points={data.points} />
            </>
          )}
        </div>
      )}

      {/* Honest caption (once) */}
      <footer className="mt-10 rounded-xl border border-border bg-card/60 p-5 text-xs leading-relaxed text-muted-foreground">
        <p>
          <strong>Devnet demo.</strong> Deposits, withdrawals, the VRF draw,
          winner selection, the prize split, and every number above are real
          on-chain reads. The prize itself is synthetic test-USDC — devnet has no
          real yield source — so prize sizes here are an illustration, not a
          guarantee.
        </p>
      </footer>
    </main>
  );
}

// ── headline tile ────────────────────────────────────────────────────────────
function Tile({
  label,
  value,
  unit,
  accent = false,
  mono = false,
}: {
  label: string;
  value: string;
  unit?: string;
  accent?: boolean;
  mono?: boolean;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div
        className={`mt-1.5 font-mono tabular-nums ${
          mono ? "text-xl" : "text-xl sm:text-2xl"
        } ${accent ? "font-semibold text-accent-warm" : "text-foreground"}`}
      >
        {value}
        {unit && (
          <span className="ml-1 text-xs font-normal text-muted-foreground">
            {unit}
          </span>
        )}
      </div>
    </div>
  );
}

// ── 2. inline SVG bar chart (no charting dependency) ─────────────────────────
//
// One stacked bar per settled round: a primary "prize" segment with a darker
// "fed the pot" (growingPotAmount) segment stacked at its base. Pure viewBox +
// width:100% so it scales responsively; renders fine with a single data point.
// Reduced-motion safe — no animation is required for the chart to read.
function PrizeHistory({ points }: { points: ChartPoint[] }) {
  // viewBox coordinate space (not pixels — the SVG scales to its container).
  const VB_W = 600;
  const VB_H = 220;
  const PAD_X = 36; // room for the y-axis label
  const PAD_TOP = 12;
  const PAD_BOTTOM = 28; // room for the x-axis round labels
  const plotW = VB_W - PAD_X;
  const plotH = VB_H - PAD_TOP - PAD_BOTTOM;
  const baseY = PAD_TOP + plotH;

  const max = chartMax(points);
  const n = points.length;
  // Bar slot width with a slice of gap; a single point gets a comfortable bar.
  const slot = plotW / n;
  const barW = Math.min(48, slot * 0.6);

  return (
    <section
      aria-label="Prize per settled round"
      className="rounded-xl border border-border bg-card p-5"
    >
      <div className="mb-1 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-foreground">Prize history</h3>
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <Legend swatch="text-accent-warm" label="Prize" />
          <Legend swatch="text-primary" label="Fed the pot (20%)" />
        </div>
      </div>

      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        width="100%"
        role="img"
        aria-label={`Bar chart of the prize for ${n} settled round${
          n === 1 ? "" : "s"
        }.`}
        className="block"
      >
        {/* baseline (x-axis) */}
        <line
          x1={PAD_X}
          y1={baseY}
          x2={VB_W}
          y2={baseY}
          className="stroke-border"
          strokeWidth={1}
        />
        {/* y-axis max label (top) */}
        <text
          x={PAD_X - 6}
          y={PAD_TOP + 8}
          textAnchor="end"
          className="fill-muted-foreground font-mono tabular-nums"
          style={{ fontSize: 9 }}
        >
          {fmtUsdc(max)}
        </text>
        <text
          x={PAD_X - 6}
          y={baseY}
          textAnchor="end"
          className="fill-muted-foreground font-mono tabular-nums"
          style={{ fontSize: 9 }}
        >
          0
        </text>

        {points.map((p, i) => {
          const cx = PAD_X + slot * i + slot / 2;
          const x = cx - barW / 2;
          const prizeH = barHeight(p.prize, max, plotH);
          const potH = barHeight(p.potFeed, max, plotH);
          // Stack: pot feed sits at the base, prize stacks on top of it. We
          // draw the prize as the FULL prize height (it is the headline value)
          // and overlay the pot-feed slice at the bottom so the 20% reads as a
          // distinct band within the same bar.
          const prizeY = baseY - prizeH;
          const potY = baseY - potH;
          return (
            <g key={p.round}>
              {/* full prize bar */}
              <rect
                x={x}
                y={prizeY}
                width={barW}
                height={prizeH}
                rx={3}
                className="fill-accent-warm"
              >
                <title>
                  {`Round ${p.round} — prize ${fmtUsdc(p.prize)} USDC`}
                </title>
              </rect>
              {/* pot-feed band at the base of the same bar */}
              <rect
                x={x}
                y={potY}
                width={barW}
                height={potH}
                rx={3}
                className="fill-primary"
              >
                <title>
                  {`Round ${p.round} — fed the pot ${fmtUsdc(
                    p.potFeed,
                  )} USDC`}
                </title>
              </rect>
              {/* x-axis round label */}
              <text
                x={cx}
                y={baseY + 16}
                textAnchor="middle"
                className="fill-muted-foreground font-mono tabular-nums"
                style={{ fontSize: 9 }}
              >
                R{p.round}
              </text>
            </g>
          );
        })}
      </svg>

      <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
        Each bar is one round&apos;s prize; the darker band at its base is the
        20% slice that fed the Growing Pot.
      </p>
    </section>
  );
}

function Legend({ swatch, label }: { swatch: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <svg width={10} height={10} aria-hidden="true">
        <rect width={10} height={10} rx={2} className={`fill-current ${swatch}`} />
      </svg>
      {label}
    </span>
  );
}

// ── 3. "Pot growth" readout — cumulative growing-pot contributions ───────────
function PotGrowth({ points }: { points: ChartPoint[] }) {
  const cumulative = cumulativePotFeed(points);
  return (
    <section
      aria-label="Cumulative pot growth"
      className="rounded-xl border border-border bg-card p-5"
    >
      <h3 className="text-sm font-semibold text-foreground">Pot growth</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Total fed to the Growing Pot across {points.length} settled round
        {points.length === 1 ? "" : "s"} — it only ever climbs.
      </p>
      <div className="mt-3 font-mono text-2xl font-semibold tabular-nums text-accent-warm sm:text-3xl">
        {fmtUsdc(cumulative)}
        <span className="ml-1 text-sm font-normal text-muted-foreground">
          USDC
        </span>
      </div>
    </section>
  );
}
