import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { supabaseAdmin } from "@/lib/supabase";

const ALLOWED = new Set([
  "visit", "connect", "faucet", "deposit_submitted", "deposit_confirmed",
  "withdraw_requested", "withdraw_completed",
]);
const LOCAL_SINK = path.join(process.cwd(), ".demo-events.local.jsonl");

export async function POST(req: NextRequest) {
  try {
    const { event, sessionId, wallet, props } = await req.json();
    if (!ALLOWED.has(event)) return NextResponse.json({ ok: false }, { status: 400 });
    const row = {
      event, session_id: sessionId ?? null, wallet: wallet ?? null,
      props: props ?? null, created_at: new Date().toISOString(),
    };
    if (supabaseAdmin) {
      await supabaseAdmin.from("demo_events").insert(row);
    } else {
      await fs.appendFile(LOCAL_SINK, JSON.stringify(row) + "\n");
    }
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: true }); // never break UX on tracking failure
  }
}
