"use client";
import { useEffect, useState } from "react";
import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { abbrev, fmtUsdc } from "@/lib/format";
import { weeksHeld } from "@/lib/gamify";
import type { LeaderboardEntry } from "@/app/api/leaderboard/route";

export type PositionRow = {
  user: PublicKey;
  amount: BN;
  firstDepositTs: BN;
  withdrawRequestedAt: BN;
};

type Tab = "amount" | "weeks" | "referrals";

const TAB_LABELS: Record<Tab, string> = {
  amount: "Top holders",
  weeks: "Longest held",
  referrals: "Referrals",
};

const TOP_N = 10;

export function Leaderboard({
  positions,
  walletPubkey,
}: {
  positions: PositionRow[];
  walletPubkey: PublicKey | null;
}) {
  const [tab, setTab] = useState<Tab>("amount");
  const [refEntries, setRefEntries] = useState<LeaderboardEntry[]>([]);
  const [refLoading, setRefLoading] = useState(false);

  const nowTs = Math.floor(Date.now() / 1000);

  useEffect(() => {
    if (tab !== "referrals") return;
    setRefLoading(true);
    fetch("/api/leaderboard")
      .then((r) => r.json())
      .then((data) => setRefEntries(data.entries ?? []))
      .catch(() => setRefEntries([]))
      .finally(() => setRefLoading(false));
  }, [tab]);

  function isMe(user: PublicKey): boolean {
    if (!walletPubkey) return false;
    return user.equals(walletPubkey);
  }

  function isMyRef(ref: string): boolean {
    if (!walletPubkey) return false;
    return ref === walletPubkey.toBase58();
  }

  // ── Sorted slices ────────────────────────────────────────────────────────

  const byAmount = [...positions]
    .sort((a, b) => b.amount.cmp(a.amount))
    .slice(0, TOP_N);

  const byWeeks = [...positions]
    .sort(
      (a, b) =>
        weeksHeld(b.firstDepositTs, nowTs) -
        weeksHeld(a.firstDepositTs, nowTs),
    )
    .slice(0, TOP_N);

  // ── Render helpers ────────────────────────────────────────────────────────

  function rowClass(mine: boolean) {
    return `flex items-center justify-between py-2 border-b border-border last:border-0 text-sm ${
      mine ? "text-accent-warm font-semibold" : "text-foreground"
    }`;
  }

  function emptyState(msg: string) {
    return <p className="py-4 text-center text-sm text-muted-foreground">{msg}</p>;
  }

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="text-sm font-semibold text-foreground mb-3">Leaderboard</div>

      {/* Tab bar */}
      <div className="flex gap-1 mb-4">
        {(Object.keys(TAB_LABELS) as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 rounded-md py-1 text-xs font-medium transition-colors ${
              tab === t
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      {/* ── Amount tab ── */}
      {tab === "amount" && (
        <div>
          {byAmount.length === 0
            ? emptyState("No deposits yet.")
            : byAmount.map((p, i) => (
                <div key={p.user.toBase58()} className={rowClass(isMe(p.user))}>
                  <span className="flex items-center gap-2">
                    <span className="w-5 text-right text-muted-foreground text-xs tabular-nums">
                      {i + 1}
                    </span>
                    <span className="font-mono">
                      {abbrev(p.user)}
                      {isMe(p.user) && (
                        <span className="ml-1 text-[10px] text-primary">(you)</span>
                      )}
                    </span>
                  </span>
                  <span className="font-mono tabular-nums">{fmtUsdc(p.amount)} USDC</span>
                </div>
              ))}
          <p className="mt-2 text-[10px] text-muted-foreground">
            Ranked by pool balance. Position size and time held determine draw weight — not rank.
          </p>
        </div>
      )}

      {/* ── Weeks tab ── */}
      {tab === "weeks" && (
        <div>
          {byWeeks.length === 0
            ? emptyState("No deposits yet.")
            : byWeeks.map((p, i) => {
                const wks = weeksHeld(p.firstDepositTs, nowTs);
                return (
                  <div key={p.user.toBase58()} className={rowClass(isMe(p.user))}>
                    <span className="flex items-center gap-2">
                      <span className="w-5 text-right text-muted-foreground text-xs tabular-nums">
                        {i + 1}
                      </span>
                      <span className="font-mono">
                        {abbrev(p.user)}
                        {isMe(p.user) && (
                          <span className="ml-1 text-[10px] text-primary">(you)</span>
                        )}
                      </span>
                    </span>
                    <span className="tabular-nums">
                      {wks === 1 ? "1 week" : `${wks} weeks`}
                    </span>
                  </div>
                );
              })}
          <p className="mt-2 text-[10px] text-muted-foreground">
            Ranked by weeks held. Time in pool increases your draw weight on-chain.
          </p>
        </div>
      )}

      {/* ── Referrals tab ── */}
      {tab === "referrals" && (
        <div>
          {refLoading ? (
            <p className="py-4 text-center text-sm text-muted-foreground">Loading…</p>
          ) : refEntries.length === 0 ? (
            emptyState("No referrals recorded yet.")
          ) : (
            refEntries.slice(0, TOP_N).map((e, i) => (
              <div
                key={e.ref}
                className={rowClass(isMyRef(e.ref))}
              >
                <span className="flex items-center gap-2">
                  <span className="w-5 text-right text-muted-foreground text-xs tabular-nums">
                    {i + 1}
                  </span>
                  <span className="font-mono">
                    {abbrev(e.ref)}
                    {isMyRef(e.ref) && (
                      <span className="ml-1 text-[10px] text-primary">(you)</span>
                    )}
                  </span>
                </span>
                <span className="text-muted-foreground">
                  {e.uniqueWallets}{" "}
                  {e.uniqueWallets === 1 ? "depositor brought" : "depositors brought"}
                </span>
              </div>
            ))
          )}
          <p className="mt-2 text-[10px] text-muted-foreground">
            Referrals do not change draw odds — odds are size × time held, on-chain.
          </p>
        </div>
      )}
    </div>
  );
}
