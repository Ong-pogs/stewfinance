"use client";
import { useEffect, useState } from "react";
import { BN } from "@coral-xyz/anchor";
import { fmtUsdc } from "@/lib/format";
import { formatCountdown, statusLabel } from "@/lib/draw-utils";

export { formatCountdown, statusLabel };

type DrawData = {
  round: number;
  status: string;
  prizePool: BN;
  drawTs: BN;
} | null;

const STATUS_COLOR: Record<string, string> = {
  pending:   "bg-zinc-800 text-zinc-300",
  committed: "bg-yellow-900/50 text-yellow-300",
  settled:   "bg-green-900/50 text-green-300",
  claimed:   "bg-purple-900/50 text-purple-300",
};

export function DrawCard({
  draw,
  nextDrawTs,
  poolTotal,
}: {
  draw: DrawData;
  /** Unix seconds. From PoolConfig.nextDrawTs. Null when pool not yet initialised. */
  nextDrawTs: BN | null;
  /** PoolConfig.totalPrincipal — used for illustrative prize estimate when no draw exists. */
  poolTotal: BN | null;
}) {
  const [secsLeft, setSecsLeft] = useState<number>(0);

  useEffect(() => {
    if (!nextDrawTs) { setSecsLeft(0); return; }
    const target = nextDrawTs.toNumber();
    function tick() {
      const diff = target - Math.floor(Date.now() / 1000);
      setSecsLeft(Math.max(0, diff));
    }
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [nextDrawTs]);

  // Prize estimate: use snapshotted prizePool if committed/settled/claimed,
  // otherwise show nothing (pending + no devnet yield yet).
  const prizeSnapped =
    draw && (draw.status === "committed" || draw.status === "settled" || draw.status === "claimed")
      ? draw.prizePool
      : null;

  const hasPool = !!poolTotal && poolTotal.gtn(0);

  return (
    <div className="rounded-xl border border-purple-800/50 p-5 cauldron-glow">
      <div className="flex items-center justify-between">
        <div className="text-sm text-zinc-400">This week&apos;s draw</div>
        {draw ? (
          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_COLOR[draw.status] ?? "bg-zinc-800 text-zinc-300"}`}>
            {statusLabel(draw.status)}
          </span>
        ) : (
          <span className="rounded-full px-2 py-0.5 text-xs font-semibold bg-zinc-800 text-zinc-500">
            No draws yet
          </span>
        )}
      </div>

      {draw ? (
        <>
          <div className="mt-1 text-xs text-zinc-500">Round {draw.round}</div>
          {prizeSnapped ? (
            <div className="mt-2">
              <div className="text-xs text-zinc-400">Prize pool</div>
              <div className="text-3xl font-bold stew-accent">
                {fmtUsdc(prizeSnapped)} USDC
                {(draw.status === "settled" || draw.status === "claimed") && (
                  <span className="ml-2 text-xs font-normal text-zinc-500">(devnet test prize)</span>
                )}
              </div>
            </div>
          ) : (
            <div className="mt-2 text-sm text-zinc-400">
              {hasPool
                ? "Prize accumulating — funded by injected test yield (devnet)"
                : "Awaiting first deposit"}
            </div>
          )}
        </>
      ) : (
        <div className="mt-3 text-sm text-zinc-400">
          No draws yet — the first weekly draw opens once the pool is live.
        </div>
      )}

      {/* Countdown */}
      {nextDrawTs && nextDrawTs.gtn(0) && (
        <div className="mt-4">
          <div className="text-xs text-zinc-500 mb-1">
            {secsLeft > 0 ? "Next draw in" : "Draw ready"}
          </div>
          <div className="font-mono text-2xl font-bold text-zinc-200">
            {secsLeft > 0 ? formatCountdown(secsLeft) : "00:00:00:00"}
          </div>
          <div className="text-xs text-zinc-600 mt-0.5">D:HH:MM:SS</div>
        </div>
      )}
    </div>
  );
}
