"use client";
/**
 * Route error boundary (Next.js app router). Reuses LoadError's card — its
 * retry button calls `reset()` to re-render the failing segment. Same top-bar
 * skeleton as /stats and /verify so the page stays branded when things break.
 */
import Link from "next/link";
import { ThemeToggle } from "@/components/theme-toggle";
import { LoadError } from "@/components/empty-state";
import { SiteFooter } from "@/components/site-footer";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
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

      <LoadError
        onRetry={reset}
        message="Something boiled over on this page."
      />

      <div className="mt-4 text-center">
        <Link
          href="/"
          className="rounded text-sm text-primary underline decoration-border underline-offset-2 hover:text-accent-warm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          Back home
        </Link>
      </div>

      {error.digest && (
        <p className="mt-6 text-center font-mono text-[11px] tabular-nums text-muted-foreground">
          Error ref: {error.digest}
        </p>
      )}

      {/* Shared site footer — carries the standing devnet disclaimer */}
      <SiteFooter />
    </main>
  );
}
