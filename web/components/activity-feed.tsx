"use client";
import { useEffect, useMemo, useState } from "react";
import { DrawSummary } from "@/lib/stewfi";
import { abbrev, fmtUsdc } from "@/lib/format";
import { EmptyState } from "@/components/empty-state";
import type { ActivityEvent } from "@/app/api/activity/route";

/**
 * ActivityFeed — pool-wide "Recent activity" social-proof list.
 *
 * Merges two REAL sources, newest-first, pseudonymously:
 *   (a) settled draws from `listDraws` → "Round N — 🏆 abbrev(winner) won X USDC"
 *   (b) confirmed deposits from /api/activity → "abbrev(wallet) joined the pool"
 *
 * Honest by construction: the chain does NOT store per-round participant lists,
 * so we never invent "who was in a draw". Wins come from the on-chain winner
 * field; joins come from real wallet-tagged tracked deposit events. EmptyState
 * when there is genuinely nothing to show.
 *
 * Banned words (lottery / stake / APY) stay out of all copy.
 */

type Item = {
  key: string;
  ts: number; // unix seconds, for sort
  icon: string;
  text: React.ReactNode;
};

function timeAgo(ts: number): string {
  const secs = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86_400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86_400)}d ago`;
}

export function ActivityFeed({ draws }: { draws: DrawSummary[] }) {
  const [deposits, setDeposits] = useState<ActivityEvent[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/activity")
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setDeposits(data.events ?? []);
      })
      .catch(() => {
        if (!cancelled) setDeposits([]);
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];

    // (a) Settled / claimed draws → winner lines.
    for (const d of draws) {
      if (d.status !== "settled" && d.status !== "claimed") continue;
      out.push({
        key: `draw-${d.round}`,
        ts: d.drawTs.toNumber(),
        icon: "🏆",
        text: (
          <>
            <span className="font-medium text-foreground">Round {d.round}</span>
            {" — "}
            <span className="font-mono">{abbrev(d.winner.toBase58())}</span> won{" "}
            <span className="font-mono tabular-nums text-accent-warm">
              {fmtUsdc(d.winnerAmount)} USDC
            </span>
          </>
        ),
      });
    }

    // (b) Tracked deposit/win events → join lines.
    for (let i = 0; i < deposits.length; i++) {
      const e = deposits[i];
      const ts = Math.floor(new Date(e.created_at).getTime() / 1000);
      if (e.event === "deposit_confirmed") {
        out.push({
          key: `dep-${i}-${e.created_at}`,
          ts: Number.isFinite(ts) ? ts : 0,
          icon: "🫕",
          text: (
            <>
              <span className="font-mono">
                {e.wallet ? abbrev(e.wallet) : "Someone"}
              </span>{" "}
              joined the pool
            </>
          ),
        });
      } else {
        // Defensive: any win/claim-type tracked event the sink may carry.
        out.push({
          key: `evt-${i}-${e.created_at}`,
          ts: Number.isFinite(ts) ? ts : 0,
          icon: "🏆",
          text: (
            <>
              <span className="font-mono">
                {e.wallet ? abbrev(e.wallet) : "Someone"}
              </span>{" "}
              claimed a prize
            </>
          ),
        });
      }
    }

    return out.sort((a, b) => b.ts - a.ts).slice(0, 20);
  }, [draws, deposits]);

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="mb-3 text-sm font-semibold text-foreground">
        Recent activity
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon="🫧"
          title={loaded ? "No activity yet" : "Loading…"}
          hint={
            loaded
              ? "Winners and new deposits show up here as the pool comes alive."
              : undefined
          }
          className="py-6"
        />
      ) : (
        <ul className="space-y-0">
          {items.map((it) => (
            <li
              key={it.key}
              className="flex items-center justify-between gap-3 border-b border-border py-2.5 text-sm last:border-0"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span aria-hidden="true" className="shrink-0 opacity-80">
                  {it.icon}
                </span>
                <span className="truncate text-foreground/90">{it.text}</span>
              </span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {timeAgo(it.ts)}
              </span>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-3 text-[10px] leading-snug text-muted-foreground">
        Wallets are abbreviated. Wins are on-chain; joins are tracked deposits.
        The pool doesn&apos;t store who was in each draw, so this isn&apos;t a
        full participation log.
      </p>
    </div>
  );
}
