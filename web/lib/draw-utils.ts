/** Formats a seconds-remaining value into D:HH:MM:SS. */
export function formatCountdown(secs: number): string {
  if (secs <= 0) return "0:00:00:00";
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return `${d}:${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * True when the next draw is imminent: in the future but within `thresholdSecs`.
 *
 * Pure helper for the "draw day" hype state. Returns false when the time is
 * already past (≤ now) — a fired/overdue draw is not "soon" — and false for a
 * non-positive or missing timestamp. Inputs are unix seconds.
 */
export function isDrawSoon(
  nextDrawTs: number | null | undefined,
  nowTs: number,
  thresholdSecs: number,
): boolean {
  if (!nextDrawTs || nextDrawTs <= 0) return false;
  const secsLeft = nextDrawTs - nowTs;
  return secsLeft > 0 && secsLeft <= thresholdSecs;
}

/** Human-readable label for the DrawStatus Anchor enum key. */
export function statusLabel(status: string): string {
  switch (status) {
    case "pending":   return "Pending";
    case "committed": return "Committed";
    case "settled":   return "Settled";
    case "claimed":   return "Claimed";
    default:          return status;
  }
}
