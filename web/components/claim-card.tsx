"use client";
import { useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { Program } from "@coral-xyz/anchor";
import { Stewfi } from "@/lib/idl";
import { DrawSummary, claimDraw } from "@/lib/stewfi";
import { fmtUsdc } from "@/lib/format";

export function ClaimCard({
  program,
  walletPubkey,
  draws,
  onDone,
}: {
  program: Program<Stewfi> | null;
  walletPubkey: PublicKey | null;
  draws: DrawSummary[];
  onDone: () => void;
}) {
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Find the first settled, unclaimed draw where this wallet is the winner.
  const claimable = walletPubkey
    ? draws.find(
        (d) =>
          d.status === "settled" &&
          !d.winnerClaimed &&
          d.winner.equals(walletPubkey)
      )
    : undefined;

  if (!claimable) return null;

  async function handleClaim() {
    if (!program || !walletPubkey) return;
    setClaiming(true);
    setError(null);
    try {
      await claimDraw(program, walletPubkey, claimable!.round);
      onDone();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setClaiming(false);
    }
  }

  return (
    <div className="rounded-xl border border-primary/50 bg-card p-5">
      <div className="text-sm font-semibold text-accent-warm">
        🏆 You won Round {claimable.round}!
      </div>
      <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-accent-warm">
        {fmtUsdc(claimable.winnerAmount)} USDC
        <span className="ml-2 text-xs font-normal text-muted-foreground">(devnet test prize)</span>
      </div>
      <button
        onClick={handleClaim}
        disabled={claiming}
        className="mt-4 w-full rounded-lg bg-primary py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
      >
        {claiming ? "Claiming…" : `Claim ${fmtUsdc(claimable.winnerAmount)} USDC`}
      </button>
      {error && (
        <p className="mt-2 text-xs text-destructive break-all">{error}</p>
      )}
    </div>
  );
}
