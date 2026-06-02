"use client";
import { DrawSummary } from "@/lib/stewfi";
import { fmtUsdc } from "@/lib/format";
import { statusLabel } from "@/lib/draw-utils";

function abbrev(pubkey: string): string {
  return pubkey.slice(0, 4) + "…" + pubkey.slice(-4);
}

export function DrawHistory({ draws }: { draws: DrawSummary[] }) {
  if (draws.length === 0) {
    return (
      <div className="rounded-xl border border-zinc-800 p-5">
        <div className="text-sm font-semibold text-zinc-300 mb-2">Draw history</div>
        <p className="text-sm text-zinc-500">No draws recorded yet.</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-zinc-800 p-5">
      <div className="text-sm font-semibold text-zinc-300 mb-3">Draw history</div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs text-left">
          <thead>
            <tr className="text-zinc-500 border-b border-zinc-800">
              <th className="pb-2 pr-4">Round</th>
              <th className="pb-2 pr-4">Prize (USDC)</th>
              <th className="pb-2 pr-4">Winner</th>
              <th className="pb-2 pr-4">Status</th>
              <th className="pb-2">Claimed</th>
            </tr>
          </thead>
          <tbody>
            {draws.map((d) => (
              <tr key={d.round} className="border-b border-zinc-800/50 last:border-0">
                <td className="py-2 pr-4 font-mono text-zinc-300">{d.round}</td>
                <td className="py-2 pr-4 font-mono text-zinc-200">
                  {d.status === "settled" || d.status === "claimed"
                    ? fmtUsdc(d.prizePool)
                    : "—"}
                </td>
                <td className="py-2 pr-4 font-mono text-zinc-400">
                  {d.status === "settled" || d.status === "claimed"
                    ? abbrev(d.winner.toBase58())
                    : "—"}
                </td>
                <td className="py-2 pr-4 text-zinc-400">{statusLabel(d.status)}</td>
                <td className="py-2 text-zinc-400">
                  {d.status === "settled" || d.status === "claimed"
                    ? d.winnerClaimed
                      ? <span className="text-green-400">Yes</span>
                      : <span className="text-yellow-400">No</span>
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
