"use client";
/**
 * /draw/[round] — permalink for one draw's fairness proof.
 *
 * Same wallet-less read pattern as /verify, but for a single round, so a
 * winner (or a sceptic) can link straight to the proof of that draw. Invalid
 * round params 404; rounds that don't exist or haven't settled yet get an
 * honest empty state instead of a fake proof.
 */
import { useCallback, useEffect, useState } from "react";
import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ThemeToggle } from "@/components/theme-toggle";
import { EmptyState, LoadError } from "@/components/empty-state";
import { DrawProof, type VerifiableDraw } from "@/components/draw-proof";
import { SiteFooter } from "@/components/site-footer";
import { STEWFI_IDL, Stewfi } from "@/lib/idl";
import { readDraw } from "@/lib/stewfi";
import { statusLabel } from "@/lib/draw-utils";
import { RPC_URL } from "@/lib/constants";

/** "3" → 3; anything not a plain non-negative integer → null (404). */
function parseRound(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

type DrawState =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "unsettled"; status: string }
  | { kind: "ready"; draw: VerifiableDraw };

export default function DrawPermalinkPage({
  params,
}: {
  params: { round: string };
}) {
  const round = parseRound(params.round);
  const [state, setState] = useState<DrawState>({ kind: "loading" });
  const [loadError, setLoadError] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const load = useCallback(async () => {
    if (round === null) return;
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

      const d = await readDraw(program, round);
      if (!d) {
        setState({ kind: "missing" });
        return;
      }
      const status = Object.keys(d.status as object)[0];
      if (status !== "settled" && status !== "claimed") {
        setState({ kind: "unsettled", status });
        return;
      }
      setState({
        kind: "ready",
        draw: {
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
        },
      });
    } catch {
      setLoadError(true);
    } finally {
      setRetrying(false);
    }
  }, [round]);

  useEffect(() => {
    load();
  }, [load]);

  if (round === null) notFound();

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      {/* Top bar */}
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">
          <Link
            href="/"
            className="rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <span className="bg-[image:--gradient-text] bg-clip-text text-transparent">
              StewFi
            </span>
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
          Round <span className="font-mono tabular-nums">{round}</span>.
        </h2>
        <p className="mt-3 max-w-2xl text-pretty text-sm leading-relaxed text-foreground/80">
          This draw&apos;s full fairness proof, re-derived from the same
          on-chain data the program used.{" "}
          <Link
            href="/verify"
            className="rounded text-primary underline decoration-border underline-offset-2 hover:text-accent-warm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            All draws
          </Link>
        </p>
      </header>

      {/* Body */}
      {loadError && state.kind === "loading" ? (
        <LoadError onRetry={load} retrying={retrying} />
      ) : state.kind === "loading" ? (
        <div className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
          Reading the chain…
        </div>
      ) : state.kind === "missing" ? (
        <div className="rounded-xl border border-border bg-card p-5">
          <EmptyState
            icon="🔍"
            title={`No draw for round ${round} yet`}
            hint="Nothing on-chain for this round so far. Once the pool runs and settles it, the full fairness proof appears here."
          />
        </div>
      ) : state.kind === "unsettled" ? (
        <div className="rounded-xl border border-border bg-card p-5">
          <EmptyState
            icon="🎲"
            title={`Round ${round} hasn't settled yet`}
            hint={`This draw is ${statusLabel(state.status).toLowerCase()} on-chain — the winner isn't derived until settle. Check back once it settles.`}
          />
        </div>
      ) : (
        <DrawProof draw={state.draw} />
      )}

      {/* Honest caption */}
      <footer className="mt-10 rounded-xl border border-border bg-card/60 p-5 text-xs leading-relaxed text-muted-foreground">
        <p>
          Randomness comes from Switchboard On-Demand VRF — committed before it
          is revealed — and the winner is derived on-chain. This is a{" "}
          <strong>devnet</strong> demo: the prize is synthetic test-USDC, not
          real money.
        </p>
      </footer>

      {/* Shared site footer */}
      <SiteFooter />
    </main>
  );
}
