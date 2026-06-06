"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { track } from "@/lib/track";
import { ThemeToggle } from "@/components/theme-toggle";
import { Faq } from "@/components/faq";
import { HowItWorksInteractive } from "@/components/how-it-works-interactive";
import { STEWFI_IDL, Stewfi } from "@/lib/idl";
import { listDraws } from "@/lib/stewfi";
import { fmtUsdc, abbrev } from "@/lib/format";
import { RPC_URL } from "@/lib/constants";

const STEPS = [
  {
    n: "01",
    title: "Deposit USDC",
    body: "Park USDC from your wallet — min 10. Withdraw anytime after a 24-hour cooldown. Your principal is always yours.",
  },
  {
    n: "02",
    title: "The pool earns yield",
    body: "Pooled USDC earns interest while you hold. The yield accumulates in a shared pot, not your wallet.",
  },
  {
    n: "03",
    title: "One winner per week",
    body: "Each week the pooled interest becomes one weighted-random depositor's prize. Principal stays yours, win or lose.",
  },
] as const;

export default function Home() {
  useEffect(() => { track("visit", { props: { page: "/" } }); }, []);
  return (
    <main>
      {/* Hero — the only place that uses the pearl halo + gradient wordmark. */}
      <section className="relative overflow-hidden border-b border-border">
        {/* Single warm pearl halo behind the headline. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-32 right-[-12rem] h-[36rem] w-[36rem] rounded-full opacity-70 blur-3xl mix-blend-multiply dark:opacity-50 dark:mix-blend-screen"
          style={{ background: "var(--gradient-halo)" }}
        />

        {/* Theme toggle — top-right of the pitch/landing hero. */}
        <div className="absolute right-4 top-4 z-10 sm:right-6 sm:top-6">
          <ThemeToggle />
        </div>

        <div className="relative mx-auto max-w-3xl px-6 py-24 text-center sm:py-32">
          <p className="mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-card/60 px-3 py-1 text-xs font-medium text-muted-foreground backdrop-blur">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary" />
            On Solana · devnet demo
          </p>

          <h1 className="mx-auto max-w-3xl text-balance text-4xl font-semibold leading-[1.05] tracking-tight sm:text-6xl">
            <span
              className="bg-clip-text text-transparent"
              style={{ backgroundImage: "var(--gradient-text)" }}
            >
              StewFi
            </span>
            <br />
            A savings account where the interest is the prize.
          </h1>

          <p className="mx-auto mt-6 max-w-2xl text-pretty text-lg leading-relaxed text-foreground/80">
            Deposit USDC. Your principal stays yours. Each week the pooled yield
            becomes one winner&apos;s prize. No loss, all upside.
          </p>

          <WinnerSpotlight />

          <div className="mt-10 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
            <Link
              href="/app"
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-8 py-4 font-semibold text-primary-foreground transition-colors hover:bg-accent-warm"
            >
              Try the demo
              <span aria-hidden="true">→</span>
            </Link>
            <Link
              href="/verify"
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-card/60 px-8 py-4 font-semibold text-foreground backdrop-blur transition-colors hover:border-primary"
            >
              Verify draws
              <span aria-hidden="true">↗</span>
            </Link>
            <Link
              href="/stats"
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-card/60 px-8 py-4 font-semibold text-foreground backdrop-blur transition-colors hover:border-primary"
            >
              Pool stats
              <span aria-hidden="true">↗</span>
            </Link>
          </div>
        </div>
      </section>

      {/* How it works — warm bg-card cards, mirroring the landing tone. */}
      <section
        aria-labelledby="how-it-works"
        className="mx-auto max-w-5xl px-6 py-20 sm:py-28"
      >
        <h2
          id="how-it-works"
          className="text-3xl font-semibold tracking-tight sm:text-4xl"
        >
          How it works.
        </h2>
        <p className="mt-4 max-w-xl text-foreground/70">
          Three moving parts. No locks, no surprise fees on your principal.
        </p>

        <ol className="mt-12 grid gap-6 sm:grid-cols-3">
          {STEPS.map((step) => (
            <li
              key={step.n}
              className="rounded-lg border border-border bg-card p-6"
            >
              <span className="block font-mono text-xs font-medium tracking-wider tabular-nums text-muted-foreground">
                {step.n}
              </span>
              <h3 className="mt-3 text-lg font-semibold tracking-tight">
                {step.title}
              </h3>
              <p className="mt-3 text-sm leading-relaxed text-foreground/75">
                {step.body}
              </p>
            </li>
          ))}
        </ol>
      </section>

      {/* How the winner is picked — interactive size × time explainer. */}
      <div className="border-t border-border">
        <HowItWorksInteractive />
      </div>

      {/* FAQ — honest Q&A, native details/summary, on-theme. */}
      <Faq />
    </main>
  );
}

/**
 * WinnerSpotlight — social-proof of the most recent real winner, in the hero.
 *
 * Reads on-chain with a WALLET-LESS AnchorProvider (same read-only pattern as
 * /verify and /stats), so it works disconnected. Picks the newest settled (or
 * claimed) draw that has a real winner. Renders nothing on no settled draw or
 * any read failure — purely additive, never blocks the hero. Pure presentation
 * of a fact the chain already proved: no contract / odds / tracking changes.
 */
function WinnerSpotlight() {
  const [winner, setWinner] = useState<{ addr: string; amount: BN } | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const conn = new Connection(RPC_URL, "confirmed");
        const provider = new AnchorProvider(
          conn,
          // Read-only: never signs, only satisfies the provider type.
          { publicKey: PublicKey.default } as AnchorProvider["wallet"],
          { commitment: "confirmed" },
        );
        const program = new Program<Stewfi>(STEWFI_IDL, provider);

        // listDraws is sorted by round descending → first real winner is newest.
        const draws = await listDraws(program);
        const latest = draws.find(
          (d) =>
            (d.status === "settled" || d.status === "claimed") &&
            !d.winner.equals(PublicKey.default) &&
            d.winnerAmount.gtn(0),
        );
        if (!cancelled && latest) {
          setWinner({ addr: latest.winner.toBase58(), amount: latest.winnerAmount });
        }
      } catch {
        // Graceful: leave the spotlight unrendered on any read failure.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!winner) return null;

  return (
    <p className="mx-auto mt-6 inline-flex max-w-full flex-wrap items-center justify-center gap-x-1.5 rounded-full border border-border bg-card/60 px-4 py-2 text-sm text-foreground/80 backdrop-blur">
      <span aria-hidden="true">🏆</span>
      <span>Last winner</span>
      <span className="font-mono tabular-nums text-foreground">
        {abbrev(winner.addr)}
      </span>
      <span>won</span>
      <span className="font-mono font-semibold tabular-nums text-accent-warm">
        {fmtUsdc(winner.amount)} USDC
      </span>
      <span className="text-muted-foreground">— principal never moved.</span>
    </p>
  );
}
