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
import { STEWFI_IDL, Stewfi } from "@/lib/idl";
import { readPool, readDraw } from "@/lib/stewfi";
import { drawPda } from "@/lib/pdas";
import { computeTicket } from "@/lib/gamify";
import { fmtUsdc, abbrev } from "@/lib/format";
import { statusLabel } from "@/lib/draw-utils";
import { RPC_URL } from "@/lib/constants";

// ── on-chain explorer links (devnet) ────────────────────────────────────────
function explorerAddr(pubkey: string): string {
  return `https://explorer.solana.com/address/${pubkey}?cluster=devnet`;
}

// ── full settled-draw shape we render ────────────────────────────────────────
type VerifiableDraw = {
  round: number;
  status: string;
  prizePool: BN;
  winner: PublicKey;
  winnerAmount: BN;
  growingPotAmount: BN;
  operatorAmount: BN;
  opsAmount: BN;
  winnerClaimed: boolean;
  drawTs: BN;
  totalWeight: BN;
  randomValue: number[];
  randomnessAccount: PublicKey;
};

/** 32 raw VRF bytes → "0x"-prefixed lowercase hex. */
function toHex(bytes: number[] | Uint8Array): string {
  return (
    "0x" +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}

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
            className="rounded-lg border border-border bg-secondary px-3 py-2 text-sm font-medium text-foreground transition-colors hover:border-primary"
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
            className="underline decoration-border underline-offset-2 hover:text-foreground"
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
    </main>
  );
}

// ── one draw's full fairness proof ───────────────────────────────────────────
function DrawProof({ draw }: { draw: VerifiableDraw }) {
  const ticket = computeTicket(draw.randomValue, draw.totalWeight);
  const valueHex = toHex(draw.randomValue);
  // u128(value[0..16] LE) — shown so the modulo step is fully reproducible.
  const valueU128 = new BN(
    Buffer.from(draw.randomValue.slice(0, 16)),
    "le",
  ).toString();
  const winnerStr = draw.winner.toBase58();

  return (
    <article className="rounded-xl border border-border bg-card p-5">
      {/* Round header + status */}
      <div className="flex items-center justify-between border-b border-border pb-3">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold text-foreground">
            Round{" "}
            <span className="font-mono tabular-nums">{draw.round}</span>
          </span>
          <span className="rounded bg-secondary px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            {statusLabel(draw.status)}
          </span>
        </div>
        <a
          href={explorerAddr(drawPda(draw.round).toBase58())}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-primary underline decoration-border underline-offset-2 hover:text-accent-warm"
        >
          Draw account ↗
        </a>
      </div>

      {/* Prize + winner */}
      <dl className="mt-4 grid grid-cols-2 gap-4 text-sm">
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">
            Prize
          </dt>
          <dd className="mt-1 font-mono tabular-nums text-foreground">
            {fmtUsdc(draw.prizePool)}{" "}
            <span className="text-xs text-muted-foreground">USDC</span>
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">
            Winner
          </dt>
          <dd className="mt-1">
            <a
              href={explorerAddr(winnerStr)}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-foreground underline decoration-border underline-offset-2 hover:text-accent-warm"
            >
              {abbrev(winnerStr)} ↗
            </a>
          </dd>
        </div>
      </dl>

      {/* Prize split 65/20/10/5 */}
      <div className="mt-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          Prize split
        </div>
        <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-4">
          <SplitRow label="Winner 65%" amount={draw.winnerAmount} accent />
          <SplitRow label="Growing pot 20%" amount={draw.growingPotAmount} />
          <SplitRow label="Operator 10%" amount={draw.operatorAmount} />
          <SplitRow label="Ops 5%" amount={draw.opsAmount} />
        </div>
      </div>

      {/* The VRF value */}
      <div className="mt-5 border-t border-border pt-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          Switchboard VRF value (revealed)
        </div>
        <code className="mt-1.5 block break-all rounded-lg bg-secondary px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground">
          {valueHex}
        </code>
        <a
          href={explorerAddr(draw.randomnessAccount.toBase58())}
          target="_blank"
          rel="noreferrer"
          className="mt-1.5 inline-block text-xs text-primary underline decoration-border underline-offset-2 hover:text-accent-warm"
        >
          Randomness account ↗
        </a>
      </div>

      {/* The derivation, step by step */}
      <div className="mt-5 border-t border-border pt-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          How the winner was derived (on-chain)
        </div>
        <ol className="mt-2 space-y-2 text-xs leading-relaxed">
          <li className="flex gap-2">
            <span className="font-mono text-muted-foreground">1.</span>
            <span>
              <span className="text-muted-foreground">total_weight</span> ={" "}
              <span className="font-mono tabular-nums text-foreground">
                {draw.totalWeight.toString()}
              </span>{" "}
              <span className="text-muted-foreground">
                — snapshotted on-chain at commit (Σ amount × seconds held).
              </span>
            </span>
          </li>
          <li className="flex gap-2">
            <span className="font-mono text-muted-foreground">2.</span>
            <span>
              <span className="text-muted-foreground">u128(value[0..16])</span> ={" "}
              <span className="font-mono tabular-nums text-foreground break-all">
                {valueU128}
              </span>{" "}
              <span className="text-muted-foreground">
                — the low 16 bytes of the VRF value, little-endian.
              </span>
            </span>
          </li>
          <li className="flex gap-2">
            <span className="font-mono text-muted-foreground">3.</span>
            <span>
              <span className="text-muted-foreground">ticket</span> ={" "}
              <span className="text-muted-foreground">
                u128(value[0..16]) % total_weight
              </span>{" "}
              ={" "}
              <span className="font-mono tabular-nums font-semibold text-accent-warm">
                {ticket.toString()}
              </span>
            </span>
          </li>
          <li className="flex gap-2">
            <span className="font-mono text-muted-foreground">4.</span>
            <span className="text-foreground/90">
              The winning ticket fell inside{" "}
              <span className="font-mono">{abbrev(winnerStr)}</span>&apos;s weight
              window (their size × time held), so they won. The program proved
              the summed weight of all positions equals{" "}
              <span className="text-muted-foreground">total_weight</span>, so the
              set is complete and the winner is unique.
            </span>
          </li>
        </ol>
      </div>
    </article>
  );
}

function SplitRow({
  label,
  amount,
  accent = false,
}: {
  label: string;
  amount: BN;
  accent?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2 sm:flex-col sm:items-start sm:justify-start">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={`font-mono tabular-nums ${accent ? "font-semibold text-accent-warm" : "text-foreground"}`}
      >
        {fmtUsdc(amount)}
      </span>
    </div>
  );
}
