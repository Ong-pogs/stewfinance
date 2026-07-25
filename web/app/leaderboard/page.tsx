"use client";
/**
 * /leaderboard — public, wallet-less leaderboard page.
 *
 * Read-only (same wallet-less AnchorProvider pattern as /stats and /verify):
 * fetches every UserPosition + the pool total, then reuses the shared
 * <Leaderboard> component with walletPubkey={null}. Pure presentation —
 * the leaderboard is cosmetic and never affects draw odds.
 */
import { useCallback, useEffect, useState } from "react";
import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import Link from "next/link";
import { ThemeToggle } from "@/components/theme-toggle";
import { LoadError } from "@/components/empty-state";
import { Leaderboard, type PositionRow } from "@/components/leaderboard";
import { SiteFooter } from "@/components/site-footer";
import { STEWFI_IDL, Stewfi } from "@/lib/idl";
import { readPool, readAllPositions } from "@/lib/stewfi";
import { RPC_URL } from "@/lib/constants";

type BoardData = {
  positions: PositionRow[];
  totalPrincipal: BN | null;
};

export default function LeaderboardPage() {
  const [data, setData] = useState<BoardData | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const load = useCallback(async () => {
    setLoadError(false);
    setRetrying(true);
    try {
      const conn = new Connection(RPC_URL, "confirmed");
      const provider = new AnchorProvider(
        conn,
        // Read-only: never signs, only satisfies the provider type.
        { publicKey: PublicKey.default } as AnchorProvider["wallet"],
        { commitment: "confirmed" },
      );
      const program = new Program<Stewfi>(STEWFI_IDL, provider);

      const [pool, positions] = await Promise.all([
        readPool(program),
        readAllPositions(program),
      ]);

      setData({
        positions,
        totalPrincipal: pool ? (pool.totalPrincipal as BN) : null,
      });
    } catch {
      setLoadError(true);
    } finally {
      setRetrying(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      {/* Top bar */}
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">
          <Link
            href="/"
            className="bg-[image:--gradient-text] bg-clip-text text-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            StewFi
          </Link>
        </h1>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Link
            href="/app"
            className="rounded-lg border border-border bg-secondary px-3 py-2 text-sm font-medium text-foreground transition-colors hover:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            Open app
          </Link>
        </div>
      </div>

      {/* Header / intent */}
      <header className="mb-8">
        <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Leaderboard.
        </h2>
        <p className="mt-3 max-w-2xl text-pretty text-sm leading-relaxed text-foreground/80">
          Top savers this season — size and time held, pseudonymous. The
          leaderboard is cosmetic: rank never changes draw odds, which come only
          from position size × time held, enforced on-chain.
        </p>
      </header>

      {/* Body */}
      {loadError && data === null ? (
        <LoadError onRetry={load} retrying={retrying} />
      ) : data === null ? (
        <BoardSkeleton />
      ) : (
        <Leaderboard
          positions={data.positions}
          totalPrincipal={data.totalPrincipal}
          walletPubkey={null}
        />
      )}

      {/* Honest caption */}
      <footer className="mt-10 rounded-xl border border-border bg-card/60 p-5 text-xs leading-relaxed text-muted-foreground">
        <p>
          <strong>Devnet demo.</strong> Positions and pool totals are real
          on-chain reads, but the balances are synthetic test-USDC — not real
          money. The leaderboard is for bragging rights only; nothing here
          changes anyone&apos;s draw odds.
        </p>
      </footer>

      {/* Shared site footer */}
      <SiteFooter />
    </main>
  );
}

// ── loading skeleton shaped like the board ───────────────────────────────────
function BoardSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="animate-pulse rounded-xl border border-border bg-card p-5"
    >
      <div className="mb-3 h-4 w-24 rounded bg-secondary" />
      <div className="mb-4 flex gap-1">
        <div className="h-6 flex-1 rounded-md bg-secondary" />
        <div className="h-6 flex-1 rounded-md bg-secondary" />
        <div className="h-6 flex-1 rounded-md bg-secondary" />
      </div>
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-8 rounded bg-secondary/60" />
        ))}
      </div>
    </div>
  );
}
