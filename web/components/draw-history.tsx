"use client";
import { DrawSummary } from "@/lib/stewfi";
import { fmtUsdc, abbrev } from "@/lib/format";
import { statusLabel } from "@/lib/draw-utils";
import { EmptyState } from "@/components/empty-state";

export function DrawHistory({ draws }: { draws: DrawSummary[] }) {
  if (draws.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="text-sm font-semibold text-foreground mb-2">Draw history</div>
        <EmptyState
          icon="🎲"
          title="No draws yet"
          hint="The first weekly draw appears here once the pool runs one."
          className="py-6"
        />
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="text-sm font-semibold text-foreground mb-3">Draw history</div>
      {/* Low-value columns (Pot fed / Winner / Claimed) collapse under `sm` so
          the table never needs horizontal scroll on a phone. */}
      <table className="w-full text-xs text-left">
        <thead>
          <tr className="text-muted-foreground border-b border-border">
            <th className="pb-2 pr-4">Round</th>
            <th className="pb-2 pr-4">Prize (USDC)</th>
            <th className="pb-2 pr-4 hidden sm:table-cell">Pot fed (USDC)</th>
            <th className="pb-2 pr-4 hidden sm:table-cell">Winner</th>
            <th className="pb-2 pr-4">Status</th>
            <th className="pb-2 hidden sm:table-cell">Claimed</th>
          </tr>
        </thead>
        <tbody>
          {draws.map((d) => (
            <tr key={d.round} className="border-b border-border last:border-0">
              <td className="py-2 pr-4 font-mono tabular-nums text-foreground">{d.round}</td>
              <td className="py-2 pr-4 font-mono tabular-nums text-foreground">
                {d.status === "settled" || d.status === "claimed"
                  ? fmtUsdc(d.prizePool)
                  : "—"}
              </td>
              <td className="py-2 pr-4 font-mono tabular-nums text-primary hidden sm:table-cell">
                {d.status === "settled" || d.status === "claimed"
                  ? fmtUsdc(d.growingPotAmount)
                  : "—"}
              </td>
              <td className="py-2 pr-4 font-mono text-muted-foreground hidden sm:table-cell">
                {d.status === "settled" || d.status === "claimed"
                  ? abbrev(d.winner.toBase58())
                  : "—"}
              </td>
              <td className="py-2 pr-4 text-muted-foreground">{statusLabel(d.status)}</td>
              <td className="py-2 text-muted-foreground hidden sm:table-cell">
                {d.status === "settled" || d.status === "claimed"
                  ? d.winnerClaimed
                    ? <span className="text-accent-warm">Yes</span>
                    : <span className="text-muted-foreground">No</span>
                  : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
