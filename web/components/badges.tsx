"use client";
import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { computeBadges } from "@/lib/gamify";
import type { DrawSummary } from "@/lib/stewfi";
import type { Badge } from "@/lib/gamify";

/**
 * Badges — cosmetic achievement labels derived from on-chain facts.
 *
 * Earned badges are highlighted; unearned are dimmed with a descriptive hint.
 * Badges are DESCRIPTIVE ONLY — they never grant or imply changed draw weight.
 */
export function Badges({
  amount,
  firstDepositTs,
  withdrawRequestedAt,
  walletPubkey,
  draws,
}: {
  amount: BN | null;
  firstDepositTs: BN | null;
  withdrawRequestedAt: BN | null;
  walletPubkey: PublicKey | null;
  draws: DrawSummary[];
}) {
  if (!amount || !firstDepositTs) return null;

  const position = {
    amount,
    firstDepositTs,
    withdrawRequestedAt: withdrawRequestedAt ?? new BN(0),
    user: walletPubkey ?? undefined,
  };

  const badges: Badge[] = computeBadges(position, draws, null);

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="text-sm font-semibold text-foreground mb-3">Achievements</div>
      <div className="grid grid-cols-2 gap-2">
        {badges.map((badge) => (
          <BadgePill key={badge.id} badge={badge} />
        ))}
      </div>
      <p className="mt-3 text-[10px] text-muted-foreground leading-snug">
        Achievements are descriptive labels over on-chain facts — they do not change
        your draw weight or entries.
      </p>
    </div>
  );
}

function BadgePill({ badge }: { badge: Badge }) {
  if (badge.earned) {
    return (
      <div
        className="rounded-lg border border-primary/50 bg-secondary px-3 py-2"
        title={badge.hint}
      >
        <div className="text-xs font-semibold text-accent-warm">{badge.label}</div>
        <div className="mt-0.5 text-[10px] text-muted-foreground leading-snug">{badge.hint}</div>
      </div>
    );
  }

  const pct =
    badge.target > 0 ? Math.min(100, Math.round((badge.current / badge.target) * 100)) : 0;

  return (
    <div
      className="rounded-lg border border-border bg-card px-3 py-2"
      title={badge.hint}
    >
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-xs font-semibold text-muted-foreground">{badge.label}</div>
        <div className="text-[10px] font-medium tabular-nums text-muted-foreground/80">
          {badge.current} / {badge.target}
        </div>
      </div>
      <div className="mt-0.5 text-[10px] text-muted-foreground/70 leading-snug">{badge.hint}</div>
      <div
        className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-secondary"
        role="progressbar"
        aria-valuenow={badge.current}
        aria-valuemin={0}
        aria-valuemax={badge.target}
        aria-label={`${badge.label}: ${badge.current} of ${badge.target}`}
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out motion-reduce:transition-none"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
