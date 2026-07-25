import Link from "next/link";

/**
 * Shared site footer — compact nav + the standing devnet disclaimer.
 * Server-component-safe (no hooks). Sits inside each page's width container,
 * so it inherits the page's max-width and horizontal padding.
 */
const NAV_LINKS = [
  { href: "/", label: "Home" },
  { href: "/app", label: "App" },
  { href: "/stats", label: "Pool stats" },
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/verify", label: "Verify draws" },
  { href: "/#faq", label: "FAQ" },
  { href: "/legal", label: "Legal" },
] as const;

export function SiteFooter() {
  return (
    <footer className="mt-16 border-t border-border pt-6 text-xs text-muted-foreground">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-baseline sm:justify-between">
        <nav aria-label="Footer" className="flex flex-wrap gap-x-4 gap-y-2">
          {NAV_LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="rounded transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              {l.label}
            </Link>
          ))}
        </nav>
        <p className="shrink-0 leading-relaxed">
          Devnet demo — synthetic test-USDC, not real money.
        </p>
      </div>
    </footer>
  );
}
