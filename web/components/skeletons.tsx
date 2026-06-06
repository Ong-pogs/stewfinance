"use client";
/**
 * Loading skeletons — token-driven shimmer placeholders shown while the first
 * on-chain `refresh()` is in flight, so the UI never flashes empty/zero values.
 *
 * `.skeleton` (defined in globals.css) provides the warm shimmer and is
 * `prefers-reduced-motion` safe (it falls back to a static block).
 */

/** A single shimmer block. Pass Tailwind sizing via `className`. */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden="true" className={`skeleton ${className}`} />;
}

/** Pot hero placeholder — mirrors PotTicker's box + big number layout. */
export function PotHeroSkeleton() {
  return (
    <div className="rounded-xl border border-border bg-card p-6">
      <Skeleton className="h-3 w-40" />
      <Skeleton className="mt-3 h-12 w-64" />
      <Skeleton className="mt-3 h-3 w-52" />
      <div className="mt-4 border-t border-border pt-3">
        <Skeleton className="h-3 w-48" />
      </div>
    </div>
  );
}

/** "Your position" placeholder — mirrors PositionCard. */
export function PositionSkeleton() {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="mt-2 h-8 w-40" />
      <Skeleton className="mt-3 h-3 w-36" />
    </div>
  );
}

/** "This week's draw" placeholder — mirrors ThisWeek's header + prize + countdown. */
export function ThisWeekSkeleton() {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-center justify-between">
        <Skeleton className="h-3 w-28" />
        <Skeleton className="h-5 w-20 rounded-full" />
      </div>
      <Skeleton className="mt-3 h-3 w-16" />
      <Skeleton className="mt-3 h-8 w-44" />
      <div className="mt-5">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="mt-2 h-7 w-40" />
      </div>
    </div>
  );
}

/** Leaderboard placeholder — a few shimmer rows under the title. */
export function LeaderboardSkeleton() {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <Skeleton className="h-4 w-28" />
      <div className="mt-4 space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex items-center justify-between">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-3 w-20" />
          </div>
        ))}
      </div>
    </div>
  );
}
