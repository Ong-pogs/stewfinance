/**
 * /legal — terms, privacy, and disclaimer in plain language.
 *
 * Static server component (no hooks, no chain reads). Three anchor sections
 * (#terms, #privacy, #disclaimer) with a small nav at the top. Copy follows
 * the product's honest-microcopy rule: devnet demo, synthetic test-USDC, not
 * real money — and describes only what the code actually does (see
 * lib/track.ts and app/api/track/route.ts for the tracking facts).
 */
import type { Metadata } from "next";
import Link from "next/link";
import { ThemeToggle } from "@/components/theme-toggle";
import { SiteFooter } from "@/components/site-footer";

export const metadata: Metadata = {
  title: "Legal — StewFi",
  description:
    "Terms, privacy, and disclaimer for the StewFi devnet demo — in plain language.",
};

const SECTIONS = [
  { id: "terms", label: "Terms" },
  { id: "privacy", label: "Privacy" },
  { id: "disclaimer", label: "Disclaimer" },
] as const;

export default function LegalPage() {
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
          Legal.
        </h2>
        <p className="mt-3 max-w-2xl text-pretty text-sm leading-relaxed text-foreground/80">
          The short, honest version. StewFi is a <strong>devnet demo</strong>{" "}
          running on synthetic test-USDC — not real money — so this page is
          plain language, not a wall of legalese.
        </p>
        <nav aria-label="Legal sections" className="mt-5 flex flex-wrap gap-2">
          {SECTIONS.map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              className="rounded-lg border border-border bg-secondary px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              {s.label}
            </a>
          ))}
        </nav>
      </header>

      <div className="space-y-6">
        {/* ── Terms ──────────────────────────────────────────────────────── */}
        <section
          id="terms"
          aria-labelledby="terms-heading"
          className="scroll-mt-6 rounded-xl border border-border bg-card p-5 sm:p-6"
        >
          <h3
            id="terms-heading"
            className="text-lg font-semibold tracking-tight"
          >
            Terms of use.
          </h3>
          <p className="mt-2 text-sm leading-relaxed text-foreground/75">
            By using StewFi you accept the following — all of it is also
            visible in the app itself:
          </p>
          <ul className="mt-4 space-y-3 text-sm leading-relaxed text-foreground/75">
            <li>
              <strong className="text-foreground">
                This is a devnet demo.
              </strong>{" "}
              Every balance, deposit, and prize is synthetic test-USDC on
              Solana devnet. Nothing here is real money, and nothing you
              deposit or win has monetary value.
            </li>
            <li>
              <strong className="text-foreground">
                No guarantee of service.
              </strong>{" "}
              The demo may pause, reset, or shut down at any time, without
              notice and without compensation.
            </li>
            <li>
              <strong className="text-foreground">Non-custodial.</strong> Funds
              move only when you sign a transaction from your own wallet. We
              never hold your keys and never take custody — deposits sit in
              the on-chain program&apos;s vault, and only your wallet can
              withdraw them.
            </li>
            <li>
              <strong className="text-foreground">
                Withdrawals have a 24-hour cooldown.
              </strong>{" "}
              After you request a withdrawal, your funds unlock 24 hours
              later. Your principal is never used for prizes.
            </li>
            <li>
              <strong className="text-foreground">Deposit limits.</strong>{" "}
              Minimum 10, maximum 5,000 test-USDC per wallet.
            </li>
            <li>
              <strong className="text-foreground">The weekly draw.</strong>{" "}
              Once a week, one depositor wins the pooled yield, picked
              on-chain from a Switchboard VRF value. Every prize splits the
              same fixed way: 65% winner, 20% Growing Pot, 10% operator, 5%
              ops. Check any draw&apos;s math yourself on the{" "}
              <Link
                href="/verify"
                className="rounded font-medium text-foreground underline decoration-border underline-offset-2 transition-colors hover:decoration-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
              >
                verify page
              </Link>
              .
            </li>
          </ul>
        </section>

        {/* ── Privacy ────────────────────────────────────────────────────── */}
        <section
          id="privacy"
          aria-labelledby="privacy-heading"
          className="scroll-mt-6 rounded-xl border border-border bg-card p-5 sm:p-6"
        >
          <h3
            id="privacy-heading"
            className="text-lg font-semibold tracking-tight"
          >
            Privacy.
          </h3>
          <p className="mt-2 text-sm leading-relaxed text-foreground/75">
            Here is everything we actually collect — no fine print:
          </p>
          <ul className="mt-4 space-y-3 text-sm leading-relaxed text-foreground/75">
            <li>
              <strong className="text-foreground">
                Anonymous funnel events.
              </strong>{" "}
              When you visit, connect a wallet, deposit, withdraw, or share,
              we log that event with a random session id — to a Supabase
              table, or to a local file when the demo runs without one. It
              exists to count whether the demo works, nothing else.
            </li>
            <li>
              <strong className="text-foreground">
                Two localStorage keys.
              </strong>{" "}
              A random session id, and the first referral code you arrived
              with (used only to rank the referral board — it never changes
              your odds). Clear your browser storage and both are gone.
            </li>
            <li>
              <strong className="text-foreground">Wallet addresses.</strong>{" "}
              Your address is public on-chain data by nature of Solana.
              Deposit and withdraw events may include it so the funnel adds
              up.
            </li>
            <li>
              <strong className="text-foreground">
                What we don&apos;t do.
              </strong>{" "}
              No emails collected, no tracking cookies, no third-party ads or
              analytics.
            </li>
          </ul>
        </section>

        {/* ── Disclaimer ─────────────────────────────────────────────────── */}
        <section
          id="disclaimer"
          aria-labelledby="disclaimer-heading"
          className="scroll-mt-6 rounded-xl border border-border bg-card p-5 sm:p-6"
        >
          <h3
            id="disclaimer-heading"
            className="text-lg font-semibold tracking-tight"
          >
            Disclaimer.
          </h3>
          <ul className="mt-4 space-y-3 text-sm leading-relaxed text-foreground/75">
            <li>
              <strong className="text-foreground">
                Not financial advice.
              </strong>{" "}
              Nothing on this site is investment, legal, or tax advice.
            </li>
            <li>
              <strong className="text-foreground">
                It&apos;s a prize draw.
              </strong>{" "}
              The prize is the pooled yield, and one weighted-random depositor
              wins each week. You may hold for a long time and never win —
              the design only protects your principal, not a payout.
            </li>
            <li>
              <strong className="text-foreground">
                Smart-contract risk applies.
              </strong>{" "}
              Even with test tokens, on-chain programs can have bugs.
            </li>
            <li>
              <strong className="text-foreground">
                It can end at any time.
              </strong>{" "}
              This is a demo: availability, balances, and the pool itself may
              stop existing without notice.
            </li>
          </ul>
        </section>
      </div>

      <footer className="mt-10 text-xs leading-relaxed text-muted-foreground">
        <p>
          Last updated July 25, 2026. Questions about how the product itself
          works? The{" "}
          <Link
            href="/#faq"
            className="rounded underline decoration-border underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            FAQ
          </Link>{" "}
          covers those.
        </p>
      </footer>

      {/* Shared site footer */}
      <SiteFooter />
    </main>
  );
}
