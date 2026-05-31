"use client";
import { BN } from "@coral-xyz/anchor";
import { fmtUsdc } from "@/lib/format";

export function PositionCard({ amount, poolTotal }: { amount: BN | null; poolTotal: BN | null }) {
  if (!amount) return null;
  return (
    <div className="rounded-xl border border-zinc-800 p-5">
      <div className="text-sm text-zinc-400">Your position</div>
      <div className="mt-1 text-3xl font-bold">{fmtUsdc(amount)} <span className="text-base text-zinc-400">USDC</span></div>
      {poolTotal && <div className="mt-2 text-sm text-zinc-500">Pool total: {fmtUsdc(poolTotal)} USDC</div>}
    </div>
  );
}
