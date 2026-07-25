/**
 * Custom 404 — branded, on-theme, same page skeleton as /stats and /verify.
 * Server component: EmptyState + ThemeToggle are client components and render
 * fine from here (no props that need to cross the boundary).
 */
import Link from "next/link";
import { ThemeToggle } from "@/components/theme-toggle";
import { EmptyState } from "@/components/empty-state";
import { SiteFooter } from "@/components/site-footer";

export default function NotFound() {
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

      {/* Centered 404 card */}
      <div className="rounded-xl border border-border bg-card p-8">
        <div className="text-center font-mono text-xs tabular-nums text-muted-foreground">
          404
        </div>
        <EmptyState
          icon="🍲"
          title="This page slipped out of the pot."
          hint="The address doesn't match anything here — it may have moved, or never existed."
        />
        <div className="flex flex-wrap items-center justify-center gap-3 pb-2">
          <Link
            href="/"
            className="rounded-lg border border-border bg-secondary px-4 py-2 text-sm font-medium text-foreground transition-colors hover:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
          >
            Back home
          </Link>
          <Link
            href="/app"
            className="rounded text-sm text-primary underline decoration-border underline-offset-2 hover:text-accent-warm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
          >
            Open the app
          </Link>
        </div>
      </div>

      {/* Shared site footer — carries the standing devnet disclaimer */}
      <SiteFooter />
    </main>
  );
}
