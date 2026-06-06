"use client";
import { useEffect, useMemo, useState } from "react";
import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { DrawSummary } from "@/lib/stewfi";
import { abbrev, fmtUsdc } from "@/lib/format";
import { computeOdds, weeksHeld } from "@/lib/gamify";
import { EmptyState } from "@/components/empty-state";
import type { ActivityEvent } from "@/app/api/activity/route";

/**
 * YourActivity — a personal panel for the connected wallet.
 *
 * Shows ONLY what is real for this wallet:
 *   - Your wins: settled/claimed draws where `winner == you` (with claim state).
 *   - Your current entry: amount + weeks held + live draw-weight share.
 *   - Your recent deposits: your wallet's confirmed deposit events from the sink.
 *
 * Honest by construction: the chain does NOT record which rounds you entered
 * (settle only stores the winner), so we never show "draws you were in". We
 * surface wins, your live position, and your own tracked deposits — nothing
 * invented. EmptyState when you have no position and no activity.
 *
 * Banned words (lottery / stake / APY) stay out of all copy.
 */

function timeAgo(iso: string): string {
  const ts = Math.floor(new Date(iso).getTime() / 1000);
  if (!Number.isFinite(ts)) return "";
  const secs = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86_400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86_400)}d ago`;
}

export function YourActivity({
  walletPubkey,
  amount,
  firstDepositTs,
  sumAmount,
  sumAmountFirstTs,
  draws,
}: {
  walletPubkey: PublicKey | null;
  /** Connected wallet's position amount (base units) or null when none. */
  amount: BN | null;
  /** Connected wallet's first-deposit timestamp (unix seconds) or null. */
  firstDepositTs: BN | null;
  /** PoolConfig.sumAmount accumulator or null. */
  sumAmount: BN | null;
  /** PoolConfig.sumAmountFirstTs accumulator or null. */
  sumAmountFirstTs: BN | null;
  /** All draws (from listDraws) — filtered here to this wallet's wins. */
  draws: DrawSummary[];
}) {
  const [myDeposits, setMyDeposits] = useState<ActivityEvent[]>([]);

  // Fetch the same /api/activity feed and keep only THIS wallet's deposits.
  useEffect(() => {
    if (!walletPubkey) {
      setMyDeposits([]);
      return;
    }
    const me = walletPubkey.toBase58();
    let cancelled = false;
    fetch("/api/activity")
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        const mine = (data.events ?? []).filter(
          (e: ActivityEvent) =>
            e.event === "deposit_confirmed" && e.wallet === me,
        );
        setMyDeposits(mine);
      })
      .catch(() => {
        if (!cancelled) setMyDeposits([]);
      });
    return () => {
      cancelled = true;
    };
  }, [walletPubkey]);

  const nowTs = Math.floor(Date.now() / 1000);

  const myWins = useMemo(() => {
    if (!walletPubkey) return [];
    return draws.filter(
      (d) =>
        (d.status === "settled" || d.status === "claimed") &&
        d.winner.equals(walletPubkey),
    );
  }, [draws, walletPubkey]);

  const odds = useMemo(() => {
    if (!amount || !firstDepositTs || !sumAmount || !sumAmountFirstTs)
      return null;
    return computeOdds({
      myAmount: amount,
      firstDepositTs,
      sumAmount,
      sumAmountFirstTs,
      nowTs,
    });
  }, [amount, firstDepositTs, sumAmount, sumAmountFirstTs, nowTs]);

  const hasPosition = !!amount && amount.gtn(0);
  const wks = firstDepositTs ? weeksHeld(firstDepositTs, nowTs) : 0;

  const isEmpty = !hasPosition && myWins.length === 0 && myDeposits.length === 0;

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="mb-3 text-sm font-semibold text-foreground">
        Your activity
      </div>

      {!walletPubkey ? (
        <EmptyState
          icon="👛"
          title="Connect to see your activity"
          hint="Your wins, entry, and deposits appear here once connected."
          className="py-6"
        />
      ) : isEmpty ? (
        <EmptyState
          icon="🫕"
          title="No activity yet"
          hint="Make your first deposit to start your entry."
          className="py-6"
        />
      ) : (
        <div className="space-y-5">
          {/* ── Your current entry ── */}
          {hasPosition && (
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Your entry
              </div>
              <div className="mt-1 font-mono text-2xl font-bold tabular-nums text-foreground">
                {fmtUsdc(amount!)}{" "}
                <span className="text-sm font-normal text-muted-foreground">
                  USDC
                </span>
              </div>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span className="tabular-nums">
                  {wks === 1 ? "1 week held" : `${wks} weeks held`}
                </span>
                {odds && (
                  <span className="tabular-nums">
                    {odds.oddsPct < 0.1 ? "<0.1" : odds.oddsPct.toFixed(1)}%
                    {" current draw weight share"}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* ── Your wins ── */}
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Your wins
            </div>
            {myWins.length === 0 ? (
              <p className="mt-1 text-sm text-muted-foreground">
                No wins yet — the longer you hold, the more weight you carry.
              </p>
            ) : (
              <ul className="mt-1 space-y-0">
                {myWins.map((d) => (
                  <li
                    key={d.round}
                    className="flex items-center justify-between gap-3 border-b border-border py-2 text-sm last:border-0"
                  >
                    <span className="flex items-center gap-2">
                      <span aria-hidden="true" className="opacity-80">
                        🏆
                      </span>
                      <span className="text-foreground/90">Round {d.round}</span>
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="font-mono tabular-nums text-accent-warm">
                        {fmtUsdc(d.winnerAmount)} USDC
                      </span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                          d.winnerClaimed
                            ? "bg-secondary text-muted-foreground"
                            : "bg-secondary text-accent-warm"
                        }`}
                      >
                        {d.winnerClaimed ? "Claimed" : "Claimable"}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* ── Your recent deposits ── */}
          {myDeposits.length > 0 && (
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Your recent deposits
              </div>
              <ul className="mt-1 space-y-0">
                {myDeposits.slice(0, 5).map((e, i) => (
                  <li
                    key={`${e.created_at}-${i}`}
                    className="flex items-center justify-between gap-3 border-b border-border py-2 text-sm last:border-0"
                  >
                    <span className="flex items-center gap-2">
                      <span aria-hidden="true" className="opacity-80">
                        🫕
                      </span>
                      <span className="font-mono text-foreground/90">
                        {e.wallet ? abbrev(e.wallet) : "you"}
                      </span>
                    </span>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {timeAgo(e.created_at)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <p className="mt-4 text-[10px] leading-snug text-muted-foreground">
        Wins and your entry are read on-chain. Deposits come from tracked events.
        The pool doesn&apos;t store which rounds you entered, so past entries
        aren&apos;t listed — only wins, your live entry, and your deposits.
      </p>
    </div>
  );
}
