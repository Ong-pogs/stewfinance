/**
 * /share — the URL a StewFi tweet links to.
 *
 * Its ONLY job is to carry Open Graph / Twitter card metadata that points at
 * /api/og (the rendered branded image), so when the tweet unfurls, X shows the
 * card. The visible page is a small human landing ("Your StewFi result — open
 * the app") with a CTA into /app. Pure presentation; no chain reads.
 *
 * Query params (forwarded straight to /api/og):
 *   kind   "win" | "pot" | "join"
 *   round, amount, pot   (per kind)
 *   ref    referral code (preserved into the /app CTA, not part of the image)
 *
 * ⚠️ Unfurl caveat: X's crawler must be able to FETCH the image, so this only
 * produces a real card once the site is public (Vercel). The /api/og route is
 * still directly viewable in a browser locally for verification.
 */
import type { Metadata } from "next";
import Link from "next/link";

type SP = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

type Kind = "win" | "pot" | "join";
function normKind(v: string | undefined): Kind {
  return v === "win" || v === "pot" || v === "join" ? v : "join";
}

// Absolute origin for the image URL. Metadata needs an absolute URL for the
// crawler. Prefer an explicit site URL, fall back to the Vercel-provided host,
// then localhost for local verification.
function siteOrigin(): string {
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

// Build the /api/og querystring from the share params (kind-relevant only).
function ogQuery(sp: SP): string {
  const kind = normKind(first(sp.kind));
  const qs = new URLSearchParams({ kind });
  const round = first(sp.round);
  const amount = first(sp.amount);
  const pot = first(sp.pot);
  if (kind === "win") {
    if (round !== undefined) qs.set("round", round);
    if (amount !== undefined) qs.set("amount", amount);
  } else if (kind === "pot") {
    if (pot !== undefined) qs.set("pot", pot);
  }
  return qs.toString();
}

function headline(sp: SP): { title: string; sub: string } {
  const kind = normKind(first(sp.kind));
  if (kind === "win") {
    return {
      title: `Won Round ${first(sp.round) ?? "?"} on StewFi`,
      sub: `${first(sp.amount) ?? "?"} USDC — principal never moved.`,
    };
  }
  if (kind === "pot") {
    return {
      title: "The Growing Pot on StewFi",
      sub: `${first(sp.pot) ?? "?"} USDC and climbing.`,
    };
  }
  return {
    title: "I joined the StewFi pool",
    sub: "Save USDC — the interest is the prize, principal stays yours.",
  };
}

export async function generateMetadata({
  searchParams,
}: {
  searchParams: SP;
}): Promise<Metadata> {
  const origin = siteOrigin();
  const ogUrl = `${origin}/api/og?${ogQuery(searchParams)}`;
  const { title, sub } = headline(searchParams);

  return {
    metadataBase: new URL(origin),
    title: `${title} — StewFi`,
    description: sub,
    openGraph: {
      title,
      description: sub,
      url: `${origin}/share?${ogQuery(searchParams)}`,
      siteName: "StewFi",
      images: [{ url: ogUrl, width: 1200, height: 630, alt: title }],
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description: sub,
      images: [ogUrl],
    },
  };
}

export default function SharePage({ searchParams }: { searchParams: SP }) {
  const { title, sub } = headline(searchParams);
  const ref = first(searchParams.ref);
  const appHref = ref ? `/app?ref=${encodeURIComponent(ref)}` : "/app";

  return (
    <main className="flex min-h-[80vh] flex-col items-center justify-center px-6 text-center">
      <div className="text-sm font-semibold uppercase tracking-widest text-primary">
        Your StewFi result
      </div>
      <h1 className="mt-3 text-3xl font-bold text-foreground sm:text-4xl">
        {title}
      </h1>
      <p className="mt-3 max-w-md text-base text-muted-foreground">{sub}</p>
      <Link
        href={appHref}
        className="mt-8 rounded-lg bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        Open the app
      </Link>
      <p className="mt-6 max-w-md text-xs text-muted-foreground">
        StewFi is a savings account where the interest is the prize. Devnet demo
        on Solana.
      </p>
    </main>
  );
}
