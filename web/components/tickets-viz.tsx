"use client";
import { useMemo } from "react";
import { BN } from "@coral-xyz/anchor";
import { fmtUsdc } from "@/lib/format";
import { computeOdds } from "@/lib/gamify";

/**
 * TicketsViz — visual "your entries" card.
 *
 * Shows the live weight breakdown (your share vs pool total) and the
 * corresponding odds percentage, derived from the same on-chain formula used
 * in SimulatedDraw.  This card IS the live figure; SimulatedDraw's button
 * remains a clearly labelled simulation preview.
 *
 * Banned words: no "lottery", "stake", "APY" in user-facing copy.
 */
export function TicketsViz({
  myAmount,
  firstDepositTs,
  sumAmount,
  sumAmountFirstTs,
}: {
  myAmount: BN | null;
  firstDepositTs: BN | null;
  sumAmount: BN | null;
  sumAmountFirstTs: BN | null;
}) {
  const nowTs = Math.floor(Date.now() / 1000);

  const odds = useMemo(() => {
    if (!myAmount || !firstDepositTs || !sumAmount || !sumAmountFirstTs) return null;
    return computeOdds({ myAmount, firstDepositTs, sumAmount, sumAmountFirstTs, nowTs });
  }, [myAmount, firstDepositTs, sumAmount, sumAmountFirstTs, nowTs]);

  // Bar fill clamped to 0.5–100% so even tiny odds are visible
  const barFillPct = odds
    ? Math.min(100, Math.max(0.5, odds.oddsPct))
    : 0;

  const ageLabel = useMemo(() => {
    if (!odds) return null;
    const secs = odds.ageSecs;
    if (secs < 3600) return `${Math.floor(secs / 60)}m`;
    if (secs < 86_400) return `${(secs / 3600).toFixed(1)}h`;
    return `${(secs / 86_400).toFixed(1)}d`;
  }, [odds]);

  // Nothing to show before a deposit
  if (!myAmount || myAmount.lten(0)) return null;

  return (
    <div className="rounded-xl border border-zinc-800 p-5">
      <div className="text-sm font-semibold text-zinc-300 mb-3">Your entries</div>

      {/* Weight bar */}
      <div className="mb-3">
        <div className="flex justify-between text-xs text-zinc-500 mb-1">
          <span>Your weight</span>
          <span>Pool weight</span>
        </div>
        <div className="h-3 w-full rounded-full bg-zinc-800 overflow-hidden">
          <div
            className="h-full rounded-full bg-purple-600 transition-all duration-500"
            style={{ width: `${barFillPct}%` }}
          />
        </div>
      </div>

      {/* Odds + breakdown */}
      {odds && (
        <div className="space-y-1">
          <div className="flex items-baseline gap-1.5">
            <span className="text-2xl font-bold stew-accent tabular-nums">
              {odds.oddsPct < 0.1 ? "<0.1" : odds.oddsPct.toFixed(1)}%
            </span>
            <span className="text-xs text-zinc-400">current draw weight share</span>
          </div>

          <div className="text-xs text-zinc-500 font-mono">
            {fmtUsdc(myAmount)} USDC &times; {ageLabel} held
          </div>
        </div>
      )}

      {/* Microcopy */}
      <p className="mt-3 text-[11px] text-zinc-600 leading-snug">
        Your entries climb as your deposit ages — a bigger deposit or longer time
        held means more weight in each draw. Topping up keeps your start time; a
        full withdrawal resets it.
      </p>
      <p className="mt-1 text-[10px] text-zinc-700">
        Live figure — your share shifts as others deposit or withdraw. Odds are
        computed from the real on-chain formula.
      </p>
    </div>
  );
}
