import Link from "next/link";
import { ReactNode } from "react";

/**
 * Faq — on-theme FAQ for the pitch page.
 *
 * Pure presentation. Mirrors the marketing landing's pattern
 * (`/Project/stewfinance-landing/app/components/Faq.tsx`): native
 * `<details>/<summary>` (accessible, no JS), a `+` icon that rotates 45° on
 * open. Adapted to the app's "Linen Pearl" tokens — `bg-card border-border`
 * items instead of the landing's hairline dividers. Reduced-motion safe:
 * the icon's transition is gated by `motion-safe:`. No contract / odds /
 * tracking changes. Honest copy; the product's banned words stay out.
 */
const FAQS: { q: string; a: ReactNode }[] = [
  {
    q: "Is my money safe?",
    a: (
      <>
        Your principal stays yours and is withdrawable anytime (after a 24-hour
        cooldown). The prize is the pooled yield — never your deposit. Caveat:
        smart-contract risk applies, and on devnet these are test tokens only,
        not real funds.
      </>
    ),
  },
  {
    q: "How is the winner chosen?",
    a: (
      <>
        Your weight = your deposit size × how long you&apos;ve held it. One
        winner per draw, picked on-chain from a Switchboard VRF value — fully
        verifiable. See it for yourself on the{" "}
        <Link
          href="/verify"
          className="rounded font-medium text-foreground underline decoration-border underline-offset-4 transition-colors hover:decoration-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
        >
          verify page
        </Link>
        .
      </>
    ),
  },
  {
    q: "Do referrals or anything change my odds?",
    a: (
      <>
        No. Odds are purely size × time held, computed on-chain — nothing
        off-chain can change them. Referrals only rank you on the board; they
        give no edge in the draw.
      </>
    ),
  },
  {
    q: "What's the Growing Pot?",
    a: (
      <>
        20% of every prize compounds into a pot whose yield feeds future prizes.
        It never pays out directly — it just grows, so the prize grows forever.
      </>
    ),
  },
  {
    q: "How does StewFi make money?",
    a: (
      <>
        An honest, fixed split of each prize: 65% to the winner, 20% to the
        Growing Pot, 10% to the operator, 5% to ops. No hidden cut, and your
        principal is never touched.
      </>
    ),
  },
  {
    q: "Is this gambling?",
    a: (
      <>
        No — it&apos;s no-loss prize savings. Your principal is never at risk:
        you can only win the pooled yield or get your money back.
      </>
    ),
  },
  {
    q: "Is this real money?",
    a: (
      <>
        Not yet — this is a devnet demo running on test tokens, not real funds.
      </>
    ),
  },
];

export function Faq() {
  return (
    <section
      aria-labelledby="faq"
      className="mx-auto max-w-3xl px-6 py-20 sm:py-28"
    >
      <h2
        id="faq"
        className="text-3xl font-semibold tracking-tight sm:text-4xl"
      >
        Questions.
      </h2>
      <p className="mt-4 max-w-xl text-foreground/70">
        The honest answers — what&apos;s safe, how it works, what&apos;s real.
      </p>

      <dl className="mt-10 space-y-3">
        {FAQS.map(({ q, a }) => (
          <details
            key={q}
            className="group rounded-lg border border-border bg-card [&[open]>summary>span:last-child]:rotate-45"
          >
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-lg p-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
              <dt className="text-base font-medium tracking-tight sm:text-lg">
                {q}
              </dt>
              <span
                aria-hidden="true"
                className="grid h-6 w-6 shrink-0 place-items-center text-lg leading-none text-muted-foreground motion-safe:transition-transform motion-safe:duration-200"
              >
                +
              </span>
            </summary>
            <dd className="px-5 pb-5 text-sm leading-relaxed text-foreground/75">
              {a}
            </dd>
          </details>
        ))}
      </dl>
    </section>
  );
}
