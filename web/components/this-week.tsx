"use client";
import { useEffect, useMemo, useState } from "react";
import { BN } from "@coral-xyz/anchor";
import { fmtUsdc } from "@/lib/format";
import { formatCountdown, statusLabel, isDrawSoon } from "@/lib/draw-utils";
import { computeOdds } from "@/lib/gamify";
import { InfoTooltip } from "@/components/tooltip";

/**
 * "Draw day" escalation threshold. When the draw is `pending` AND its
 * next_draw_ts is within this many seconds, the card switches from the calm
 * state to a prominent live-countdown hype state. 6 hours.
 */
const DRAW_SOON_THRESHOLD_SECS = 6 * 3600;

/**
 * ThisWeek — the single "this week's draw" card.
 *
 * Consolidates the former DrawCard (status / prize / countdown), TicketsViz
 * (live odds % + weight bar from `computeOdds`), and SimulatedDraw (the
 * "preview a draw" Math.random-vs-odds simulation) into ONE card. Same logic,
 * one presentation:
 *   - status chip + prize + countdown   (was DrawCard)
 *   - live odds % + weight bar           (was TicketsViz — same `computeOdds` call)
 *   - "Preview a draw" expandable toggle (was SimulatedDraw — inline, labelled simulated)
 *
 * No odds math changes here — `computeOdds` from lib/gamify.ts is the single
 * source of truth and is called with the exact same inputs TicketsViz used.
 *
 * Banned words: no "lottery", "stake", "APY" in user-facing copy.
 */

type DrawData = {
  round: number;
  status: string;
  prizePool: BN;
  drawTs: BN;
} | null;

const STATUS_COLOR: Record<string, string> = {
  pending:   "bg-secondary text-muted-foreground",
  committed: "bg-secondary text-accent-warm",
  settled:   "bg-secondary text-accent-warm",
  claimed:   "bg-secondary text-muted-foreground",
};

export function ThisWeek({
  draw,
  nextDrawTs,
  poolTotal,
  myAmount,
  firstDepositTs,
  sumAmount,
  sumAmountFirstTs,
}: {
  /** Live draw (status/prize/round/drawTs) or null when no draw accounts exist yet. */
  draw: DrawData;
  /** Unix seconds. From PoolConfig.nextDrawTs. Null when pool not yet initialised. */
  nextDrawTs: BN | null;
  /** PoolConfig.totalPrincipal — gates the "prize accumulating" copy. */
  poolTotal: BN | null;
  /** Connected wallet's position amount (base units) or null. */
  myAmount: BN | null;
  /** Connected wallet's first-deposit timestamp (unix seconds) or null. */
  firstDepositTs: BN | null;
  /** PoolConfig.sumAmount accumulator or null. */
  sumAmount: BN | null;
  /** PoolConfig.sumAmountFirstTs accumulator or null. */
  sumAmountFirstTs: BN | null;
}) {
  // ── Countdown (was DrawCard) ──────────────────────────────────────────────
  const [secsLeft, setSecsLeft] = useState<number>(0);
  useEffect(() => {
    if (!nextDrawTs) { setSecsLeft(0); return; }
    const target = nextDrawTs.toNumber();
    function tick() {
      setSecsLeft(Math.max(0, target - Math.floor(Date.now() / 1000)));
    }
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [nextDrawTs]);

  // ── "Draw day" hype state ─────────────────────────────────────────────────
  // Escalate ONLY while the draw is pending (pre-commit) AND within the
  // threshold. committed/settled/claimed keep their existing brewing/reveal
  // handling untouched. `secsLeft` ticks every second, so this re-evaluates
  // live and falls back to calm the moment the threshold/status no longer holds.
  const isPending = draw?.status === "pending";
  const drawSoon =
    isPending &&
    secsLeft > 0 &&
    isDrawSoon(
      nextDrawTs ? nextDrawTs.toNumber() : null,
      Math.floor(Date.now() / 1000),
      DRAW_SOON_THRESHOLD_SECS,
    );

  // Prize estimate: snapshotted prizePool once a draw is committed/settled/claimed.
  const prizeSnapped =
    draw && (draw.status === "committed" || draw.status === "settled" || draw.status === "claimed")
      ? draw.prizePool
      : null;
  const hasPool = !!poolTotal && poolTotal.gtn(0);

  // ── Live odds (was TicketsViz — identical `computeOdds` call/inputs) ───────
  const nowTs = Math.floor(Date.now() / 1000);
  const odds = useMemo(() => {
    if (!myAmount || !firstDepositTs || !sumAmount || !sumAmountFirstTs) return null;
    return computeOdds({ myAmount, firstDepositTs, sumAmount, sumAmountFirstTs, nowTs });
  }, [myAmount, firstDepositTs, sumAmount, sumAmountFirstTs, nowTs]);

  // Bar fill clamped to 0.5–100% so even tiny odds are visible.
  const barFillPct = odds ? Math.min(100, Math.max(0.5, odds.oddsPct)) : 0;

  const ageLabel = useMemo(() => {
    if (!odds) return null;
    const secs = odds.ageSecs;
    if (secs < 3600) return `${Math.floor(secs / 60)}m`;
    if (secs < 86_400) return `${(secs / 3600).toFixed(1)}h`;
    return `${(secs / 86_400).toFixed(1)}d`;
  }, [odds]);

  const hasDeposit = !!myAmount && myAmount.gtn(0);

  // ── Preview a draw (was SimulatedDraw — Math.random vs live odds) ──────────
  const [showPreview, setShowPreview] = useState(false);
  const [rolling, setRolling] = useState(false);
  const [won, setWon] = useState<boolean | null>(null);

  // Use the same live odds fraction (0..1) the real formula produces.
  const myOddsFraction = odds ? odds.oddsPct / 100 : 0;

  function preview() {
    setRolling(true);
    setWon(null);
    // Purely illustrative weighted coin-flip; not on-chain.
    setTimeout(() => {
      setWon(Math.random() < Math.max(myOddsFraction, 0.0001));
      setRolling(false);
    }, 1200);
  }

  return (
    <div
      className={`rounded-[--radius] border bg-card p-5 ${
        drawSoon
          ? "border-accent-warm animate-cauldron-bubble"
          : "border-border"
      }`}
    >
      {/* Header — title + status chip */}
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">This week&apos;s draw</div>
        {draw ? (
          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_COLOR[draw.status] ?? "bg-secondary text-muted-foreground"}`}>
            {statusLabel(draw.status)}
          </span>
        ) : (
          <span className="rounded-full px-2 py-0.5 text-xs font-semibold bg-secondary text-muted-foreground">
            No draws yet
          </span>
        )}
      </div>

      {/* Prize (was DrawCard) */}
      {draw ? (
        <>
          <div className="mt-1 text-xs text-muted-foreground">Round {draw.round}</div>
          {prizeSnapped ? (
            <div className="mt-2">
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                Prize pool
                <InfoTooltip label="Prize estimate">
                  Devnet: prize is test yield injected into the pool, not real
                  Kamino yield.
                </InfoTooltip>
              </div>
              <div className="text-3xl font-bold text-accent-warm font-mono tabular-nums">
                {fmtUsdc(prizeSnapped)} USDC
                {(draw.status === "settled" || draw.status === "claimed") && (
                  <span className="ml-2 text-xs font-normal text-muted-foreground">(devnet test prize)</span>
                )}
              </div>
            </div>
          ) : (
            <div className="mt-2 text-sm text-muted-foreground">
              {hasPool
                ? "Prize accumulating — funded by injected test yield (devnet)"
                : "Awaiting first deposit"}
            </div>
          )}
        </>
      ) : (
        <div className="mt-3 text-sm text-muted-foreground">
          No draws yet — the first weekly draw opens once the pool is live.
        </div>
      )}

      {/* Countdown (was DrawCard) — escalates to a "draw day" state when soon */}
      {nextDrawTs && nextDrawTs.gtn(0) && (
        <div className="mt-4">
          {drawSoon && (
            <p className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-secondary px-2.5 py-1 text-xs font-semibold text-accent-warm">
              <span aria-hidden="true">⏳</span> Draw day — closing soon
            </p>
          )}
          <div className="text-xs text-muted-foreground mb-1">
            {secsLeft > 0 ? "Next draw in" : "Draw ready"}
          </div>
          <div
            className={`font-mono tabular-nums font-bold ${
              drawSoon ? "text-4xl text-accent-warm" : "text-2xl text-foreground"
            }`}
          >
            {secsLeft > 0 ? formatCountdown(secsLeft) : "0:00:00:00"}
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">D:HH:MM:SS</div>
          {drawSoon && (
            <p className="mt-2 text-xs leading-snug text-foreground/80">
              {hasDeposit
                ? "You're in this week's draw — your weight keeps climbing as your deposit ages. Deposits stay open until the draw commits."
                : "Deposit before the draw commits to be in this week's prize. Your principal is never at risk."}
            </p>
          )}
        </div>
      )}

      {/* Your odds + weight bar (was TicketsViz — same computeOdds output) */}
      {hasDeposit && (
        <div className="mt-5 border-t border-border pt-4">
          <div className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-foreground">
            Your odds
            <InfoTooltip label="Your odds">
              Your chance = your weight ÷ everyone&apos;s weight. Weight =
              deposit size × time held. Nothing else changes it.
            </InfoTooltip>
          </div>

          {/* Weight bar */}
          <div className="mb-3">
            <div className="flex justify-between text-xs text-muted-foreground mb-1">
              <span>Your weight</span>
              <span>Pool weight</span>
            </div>
            <div className="h-3 w-full rounded-full bg-secondary overflow-hidden">
              <div
                className="h-full rounded-full bg-primary transition-all duration-500"
                style={{ width: `${barFillPct}%` }}
              />
            </div>
          </div>

          {odds && (
            <div className="space-y-1">
              <div className="flex items-baseline gap-1.5">
                <span className="text-2xl font-bold text-accent-warm font-mono tabular-nums">
                  {odds.oddsPct < 0.1 ? "<0.1" : odds.oddsPct.toFixed(1)}%
                </span>
                <span className="text-xs text-muted-foreground">current draw weight share</span>
              </div>
              <div className="text-xs text-muted-foreground font-mono tabular-nums">
                {fmtUsdc(myAmount!)} USDC &times; {ageLabel} held
              </div>
            </div>
          )}

          {/* Honesty caption — single clean instance (odds = size × time held, on-chain) */}
          <p className="mt-3 text-[11px] text-muted-foreground leading-snug">
            Odds = deposit size × time held, computed from the real on-chain formula.
            Your entries climb as your deposit ages — a bigger deposit or longer time
            held means more weight. Topping up keeps your start time; a full withdrawal
            resets it. Your share shifts as others deposit or withdraw. Principal is
            never at risk.
          </p>

          {/* Secondary "Preview a draw" toggle (was SimulatedDraw — inline, labelled simulated) */}
          <button
            type="button"
            onClick={() => setShowPreview((v) => !v)}
            aria-expanded={showPreview}
            className="mt-3 rounded text-xs font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
          >
            {showPreview ? "Hide preview" : "Preview a draw (simulated)"}
          </button>

          {showPreview && (
            <div className="mt-3 rounded-[--radius] border border-border bg-secondary/40 p-3">
              <button
                type="button"
                onClick={preview}
                disabled={rolling}
                className="w-full rounded-[--radius] border border-border py-2 text-sm text-foreground transition-colors hover:border-primary disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
              >
                {rolling ? "Drawing…" : "Roll a simulated draw"}
              </button>
              {won !== null && (
                <p className={`mt-3 text-center text-sm font-semibold ${won ? "text-accent-warm" : "text-muted-foreground"}`}>
                  {won
                    ? "🏆 You'd win this week!"
                    : "No win this week — your principal is still 100% safe."}
                </p>
              )}
              <p className="mt-2 text-[10px] text-muted-foreground">
                Simulated. Uses your real on-chain odds, but the roll here is a local
                coin-flip — real draws use Switchboard VRF (not wired on devnet).
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
