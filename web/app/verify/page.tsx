"use client";
/**
 * /verify — "Provably fair" verifiable-draw page.
 *
 * StewFi's TRUST differentiator: anyone (no wallet) can verify each settled
 * weekly draw was fair, straight from on-chain data. For each settled/claimed
 * Draw we show the full chain of logic the program enforced:
 *
 *   1. the revealed Switchboard VRF value (random_value, as hex)
 *   2. total_weight (snapshotted on-chain at commit)
 *   3. ticket = u128(value[0..16] little-endian) % total_weight   (recomputed
 *      client-side with `computeTicket`, BN math identical to the program)
 *   4. plain-English: the ticket fell in the winner's weight window
 *      (size × time held)
 *   5. the 65/20/10/5 split
 *
 * Every number links to the Solana devnet explorer (Draw PDA + randomness
 * account). Read-only: uses a wallet-less AnchorProvider, so the page works
 * disconnected. No contract / logic changes — this is pure presentation of
 * facts the chain already proved.
 */
import { useCallback, useEffect, useState } from "react";
import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import Link from "next/link";
import { ThemeToggle } from "@/components/theme-toggle";
import { EmptyState, LoadError } from "@/components/empty-state";
import { DrawProof, type VerifiableDraw } from "@/components/draw-proof";
import { SiteFooter } from "@/components/site-footer";
import { STEWFI_IDL, Stewfi } from "@/lib/idl";
import { readPool, readDraw } from "@/lib/stewfi";
import { RPC_URL } from "@/lib/constants";

export default function VerifyPage() {
  const [draws, setDraws] = useState<VerifiableDraw[] | null>(null);
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

      // Iterate every round 0..current and keep the settled/claimed ones,
      // reading the FULL Draw account per round (listDraws omits some fields).
      const pool = await readPool(program);
      const current = pool ? (pool.currentRound as BN).toNumber() : 0;
      const settled: VerifiableDraw[] = [];
      for (let r = current; r >= 0; r--) {
        const d = await readDraw(program, r);
        if (!d) continue;
        const status = Object.keys(d.status as object)[0];
        if (status !== "settled" && status !== "claimed") continue;
        settled.push({
          round: (d.round as BN).toNumber(),
          status,
          prizePool: d.prizePool as BN,
          winner: d.winner as PublicKey,
          winnerAmount: d.winnerAmount as BN,
          growingPotAmount: (d.growingPotAmount ?? new BN(0)) as BN,
          operatorAmount: (d.operatorAmount ?? new BN(0)) as BN,
          opsAmount: (d.opsAmount ?? new BN(0)) as BN,
          winnerClaimed: d.winnerClaimed as boolean,
          drawTs: d.drawTs as BN,
          totalWeight: d.totalWeight as BN,
          randomValue: Array.from(d.randomValue as number[]),
          randomnessAccount: d.randomnessAccount as PublicKey,
        });
      }
      setDraws(settled);
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
          <span className="bg-[image:--gradient-text] bg-clip-text text-transparent">
            StewFi
          </span>
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
          Provably fair draws.
        </h2>
        <p className="mt-3 max-w-2xl text-pretty text-sm leading-relaxed text-foreground/80">
          Every weekly winner is picked <strong>on-chain</strong> from a
          Switchboard VRF value — no off-chain input can change the odds. Below,
          each settled draw is re-derived from the same public data the program
          used, so you can check the math yourself.
        </p>
      </header>

      {/* Body */}
      {loadError && draws === null ? (
        <LoadError onRetry={load} retrying={retrying} />
      ) : draws === null ? (
        <div className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
          Reading the chain…
        </div>
      ) : draws.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-5">
          <EmptyState
            icon="🔍"
            title="No settled draws yet"
            hint="Once the pool runs its first weekly draw, its full fairness proof appears here."
          />
        </div>
      ) : (
        <div className="space-y-6">
          {draws.map((d) => (
            <DrawProof key={d.round} draw={d} />
          ))}
        </div>
      )}

      {/* Honest caption */}
      <footer className="mt-10 rounded-xl border border-border bg-card/60 p-5 text-xs leading-relaxed text-muted-foreground">
        <p className="font-medium text-foreground/80">How the proof works</p>
        <p className="mt-2">
          Randomness comes from{" "}
          <a
            href="https://docs.switchboard.xyz/product-documentation/randomness"
            target="_blank"
            rel="noreferrer"
            className="rounded underline decoration-border underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            Switchboard On-Demand VRF
          </a>
          . The value is <strong>committed before it is revealed</strong> and is
          slot-bound, so the operator can&apos;t grind it for a favourable
          outcome. At settle, the program reveals the value and derives the
          winner on-chain over every live position; it then checks the summed
          weight equals the committed <code className="font-mono">total_weight</code>,
          so no position can be omitted, injected, or reordered.
        </p>
        <p className="mt-2">
          This is a <strong>devnet</strong> demo: the prize is synthetic
          test-USDC (no real yield on devnet), and the operator is the admin key.
          The fairness mechanism — VRF, on-chain winner derivation, and the
          65/20/10/5 split — is real and runs exactly as shown.
        </p>
      </footer>

      {/* Shared site footer */}
      <SiteFooter />
    </main>
  );
}
// DrawProof / SplitRow moved to @/components/draw-proof (shared with /draw/[round]).
