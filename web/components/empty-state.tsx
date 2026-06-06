"use client";
/**
 * Small on-theme empty / error states. Used in place of bare one-line "none
 * yet" text and to surface a gentle inline read-failure with a retry button.
 */

/** A centered icon/emoji + one calm line. Optional small sub-line. */
export function EmptyState({
  icon,
  title,
  hint,
  className = "",
}: {
  icon: string;
  title: string;
  hint?: string;
  className?: string;
}) {
  return (
    <div className={`flex flex-col items-center justify-center py-8 text-center ${className}`}>
      <div aria-hidden="true" className="text-2xl opacity-70">{icon}</div>
      <div className="mt-2 text-sm font-medium text-foreground/90">{title}</div>
      {hint && <div className="mt-1 max-w-xs text-xs leading-snug text-muted-foreground">{hint}</div>}
    </div>
  );
}

/** Gentle inline "couldn't load" with a retry button calling onRetry. */
export function LoadError({
  onRetry,
  retrying = false,
  message = "Couldn't load the latest on-chain data.",
}: {
  onRetry: () => void;
  retrying?: boolean;
  message?: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-6 text-center">
      <div aria-hidden="true" className="text-2xl opacity-70">⚠️</div>
      <div className="mt-2 text-sm font-medium text-foreground/90">{message}</div>
      <div className="mt-1 text-xs text-muted-foreground">
        The devnet RPC can be flaky — try again.
      </div>
      <button
        type="button"
        onClick={onRetry}
        disabled={retrying}
        className="mt-4 rounded-lg border border-border bg-secondary px-4 py-2 text-sm font-medium text-foreground transition-colors hover:border-primary disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
      >
        {retrying ? "Retrying…" : "Retry"}
      </button>
    </div>
  );
}
