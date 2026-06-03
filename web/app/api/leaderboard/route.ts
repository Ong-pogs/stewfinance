import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export type LeaderboardEntry = {
  ref: string;
  uniqueWallets: number;
};

async function fromSupabase(): Promise<LeaderboardEntry[]> {
  const { data } = await supabaseAdmin!
    .from("demo_events")
    .select("wallet, props")
    .eq("event", "referral_deposit")
    .not("props", "is", null);

  const map = new Map<string, Set<string>>();
  for (const row of data ?? []) {
    const ref: string | undefined = (row.props as Record<string, string>)?.ref;
    if (!ref || !row.wallet) continue;
    if (!map.has(ref)) map.set(ref, new Set());
    map.get(ref)!.add(row.wallet as string);
  }

  return Array.from(map.entries())
    .map(([ref, wallets]) => ({ ref, uniqueWallets: wallets.size }))
    .sort((a, b) => b.uniqueWallets - a.uniqueWallets);
}

async function fromLocal(): Promise<LeaderboardEntry[]> {
  const map = new Map<string, Set<string>>();
  try {
    const raw = await fs.readFile(
      path.join(process.cwd(), ".demo-events.local.jsonl"),
      "utf8",
    );
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      if (row.event !== "referral_deposit") continue;
      const ref: string | undefined = row.props?.ref;
      if (!ref || !row.wallet) continue;
      if (!map.has(ref)) map.set(ref, new Set());
      map.get(ref)!.add(row.wallet as string);
    }
  } catch {
    // no file yet — return empty
  }
  return Array.from(map.entries())
    .map(([ref, wallets]) => ({ ref, uniqueWallets: wallets.size }))
    .sort((a, b) => b.uniqueWallets - a.uniqueWallets);
}

export async function GET() {
  try {
    const entries = supabaseAdmin ? await fromSupabase() : await fromLocal();
    return NextResponse.json({ entries });
  } catch {
    return NextResponse.json({ entries: [] });
  }
}
