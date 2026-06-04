"use client";
import { PublicKey } from "@solana/web3.js";
import { DrawSummary } from "@/lib/stewfi";
import { fmtUsdc, abbrev } from "@/lib/format";
import { ShareCard } from "@/components/share-card";

type DrawRevealProps = {
  draw: DrawSummary | null;
  walletPubkey: PublicKey | null;
  potUsdc: string;
  referralCode: string;
};

export function DrawReveal({ draw, walletPubkey, potUsdc, referralCode }: DrawRevealProps) {
  if (!draw) return null;

  const status = draw.status;

  // Brewing / committed state ─────────────────────────────────────────────────
  if (status === "committed") {
    return (
      <div className="rounded-xl border border-border bg-card p-5 animate-cauldron-bubble">
        <div className="flex items-center gap-3">
          <span className="text-2xl" aria-hidden="true">🔮</span>
          <div>
            <div className="text-sm font-semibold text-accent-warm">The cauldron is drawing…</div>
            <div className="text-xs text-muted-foreground mt-0.5">
              Round {draw.round} — brewing your result on-chain
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Settled / claimed state ───────────────────────────────────────────────────
  if (status === "settled" || status === "claimed") {
    const isWinner =
      walletPubkey !== null && draw.winner.equals(walletPubkey);

    const potFed = fmtUsdc(draw.growingPotAmount);
    const winnerDisplay = abbrev(draw.winner.toBase58());
    const winnerAmt = fmtUsdc(draw.winnerAmount);

    if (isWinner) {
      // Gold / elevated variant for the connected winner
      return (
        <div className="animate-reveal-burst rounded-xl border border-primary/60 bg-card p-5 cauldron-glow">
          <div className="text-xs font-semibold uppercase tracking-wider text-accent-warm mb-1">
            You won Round {draw.round}
          </div>
          <div className="text-3xl font-bold font-mono tabular-nums text-accent-warm">
            {winnerAmt} <span className="text-base font-normal text-muted-foreground">USDC</span>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            20% fed the pot → <span className="text-primary font-semibold font-mono tabular-nums">{potFed} USDC</span> and growing
          </p>
          <div className="mt-4">
            <ShareCard
              mode="win"
              round={draw.round}
              amount={winnerAmt}
              potUsdc={potUsdc}
              referralCode={referralCode}
              wallet={walletPubkey?.toBase58()}
            />
          </div>
        </div>
      );
    }

    // Compact variant for non-winners
    return (
      <div className="animate-reveal-burst rounded-xl border border-border bg-card p-5">
        <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">
          Round {draw.round} result
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-xl font-bold font-mono tabular-nums text-foreground">{winnerAmt}</span>
          <span className="text-sm text-muted-foreground">USDC won by <span className="font-mono">{winnerDisplay}</span></span>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          20% fed the pot → <span className="text-primary font-mono tabular-nums">{potFed} USDC</span> and growing
        </p>
      </div>
    );
  }

  return null;
}
