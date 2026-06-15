/**
 * Pure helpers for reading tracked demo events from the local JSONL sink.
 *
 * These exist so route handlers and the dashboard parse event lines the same,
 * tolerant way, and so the behavior is unit-testable without filesystem I/O.
 */

/**
 * Parse a single JSONL line into an object, or return `null` if it is blank or
 * malformed. Callers should skip `null` rather than aborting the whole loop —
 * one bad line must never drop later valid lines.
 */
export function parseEventLine(line: string): Record<string, unknown> | null {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/**
 * Read the referral `ref` from a tracked-event row, tolerant of how `track()`
 * nests its second argument.
 *
 * `track(event, { wallet, props: { ref } })` sends the entire 2nd arg as
 * `props`, so the stored row ends up with `row.props = { wallet, props: { ref } }`
 * — the real ref lives at `row.props.props.ref`. Older/flat rows may carry it
 * directly at `row.props.ref`. This handles both shapes.
 */
export function readRef(row: { props?: unknown } | null | undefined): string | undefined {
  const props = row?.props as Record<string, unknown> | undefined;
  const nested = props?.props as Record<string, unknown> | undefined;
  const ref = (nested ?? props)?.ref;
  return typeof ref === "string" ? ref : undefined;
}
