import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * Read-only recent-activity feed.
 *
 * Returns the most recent ~N tracked sink events that make sense as social
 * proof — confirmed deposits plus any win/claim events if the sink happens to
 * carry them. This NEVER writes (the write path stays /api/track) and NEVER
 * errors the UX: any failure returns `{ events: [] }`.
 *
 * Honesty note: the chain does NOT store per-round participant lists, so this
 * feed is built only from real, wallet-tagged tracked events — not invented
 * participation history.
 *
 * Branching mirrors /api/leaderboard and /app/dashboard exactly: Supabase when
 * configured, else the local `.demo-events.local.jsonl` sink.
 */

const LIMIT = 20;

// Event types we surface as activity. `deposit_confirmed` is the real,
// wallet-tagged join signal; win/claim names are included defensively in case
// the sink ever carries them (it doesn't today — no logic change to /api/track).
const ACTIVITY_EVENTS = new Set([
  "deposit_confirmed",
  "win",
  "claim",
  "draw_won",
  "claim_confirmed",
]);

export type ActivityEvent = {
  event: string;
  wallet: string | null;
  props: Record<string, unknown> | null;
  created_at: string;
};

async function fromSupabase(): Promise<ActivityEvent[]> {
  const { data } = await supabaseAdmin!
    .from("demo_events")
    .select("event, wallet, props, created_at")
    .in("event", Array.from(ACTIVITY_EVENTS))
    .order("created_at", { ascending: false })
    .limit(LIMIT);

  return (data ?? []).map((r) => ({
    event: r.event as string,
    wallet: (r.wallet as string | null) ?? null,
    props: (r.props as Record<string, unknown> | null) ?? null,
    created_at: r.created_at as string,
  }));
}

async function fromLocal(): Promise<ActivityEvent[]> {
  const rows: ActivityEvent[] = [];
  try {
    const raw = await fs.readFile(
      path.join(process.cwd(), ".demo-events.local.jsonl"),
      "utf8",
    );
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      if (!ACTIVITY_EVENTS.has(row.event)) continue;
      rows.push({
        event: row.event as string,
        wallet: (row.wallet as string | null) ?? null,
        props: (row.props as Record<string, unknown> | null) ?? null,
        created_at: (row.created_at as string) ?? new Date(0).toISOString(),
      });
    }
  } catch {
    // no file yet — return empty
  }
  // Newest first, then cap.
  return rows
    .sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    )
    .slice(0, LIMIT);
}

export async function GET() {
  try {
    const events = supabaseAdmin ? await fromSupabase() : await fromLocal();
    return NextResponse.json({ events });
  } catch {
    return NextResponse.json({ events: [] });
  }
}
