"use client";
import { BN } from "@coral-xyz/anchor";
import { fmtUsdc } from "@/lib/format";

export function PositionCard({ amount, poolTotal }: { amount: BN | null; poolTotal: BN | null }) {
  if (!amount) return null;
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="text-sm text-muted-foreground">Your position</div>
      <div className="mt-1 text-3xl font-bold font-mono tabular-nums text-foreground">{fmtUsdc(amount)} <span className="text-base font-normal text-muted-foreground">USDC</span></div>
      {poolTotal && <div className="mt-2 text-sm text-muted-foreground">Pool total: <span className="font-mono tabular-nums">{fmtUsdc(poolTotal)}</span> USDC</div>}
    </div>
  );
}
