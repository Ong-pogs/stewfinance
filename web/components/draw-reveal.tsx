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
      <div className="rounded-xl border border-yellow-800/50 p-5 animate-cauldron-bubble">
        <div className="flex items-center gap-3">
          <span className="text-2xl" aria-hidden="true">🔮</span>
          <div>
            <div className="text-sm font-semibold text-yellow-300">The cauldron is drawing…</div>
            <div className="text-xs text-zinc-400 mt-0.5">
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
        <div className="animate-reveal-burst rounded-xl border border-yellow-500/70 bg-yellow-950/30 p-5 cauldron-glow">
          <div className="text-xs font-semibold uppercase tracking-wider text-yellow-400 mb-1">
            You won Round {draw.round}
          </div>
          <div className="text-3xl font-bold text-yellow-300">
            {winnerAmt} <span className="text-base font-normal text-zinc-300">USDC</span>
          </div>
          <p className="mt-2 text-xs text-zinc-400">
            20% fed the pot → <span className="text-purple-300 font-semibold">{potFed} USDC</span> and growing
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
      <div className="animate-reveal-burst rounded-xl border border-zinc-700 p-5">
        <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1">
          Round {draw.round} result
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-xl font-bold text-zinc-200">{winnerAmt}</span>
          <span className="text-sm text-zinc-400">USDC won by {winnerDisplay}</span>
        </div>
        <p className="mt-2 text-xs text-zinc-500">
          20% fed the pot → <span className="text-purple-400">{potFed} USDC</span> and growing
        </p>
      </div>
    );
  }

  return null;
}
