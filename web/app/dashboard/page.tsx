import { promises as fs } from "fs";
import path from "path";
import { supabaseAdmin } from "@/lib/supabase";
import { parseEventLine } from "@/lib/events";

export const dynamic = "force-dynamic";

const EVENTS = [
  "visit", "connect", "faucet", "deposit_submitted",
  "deposit_confirmed", "withdraw_requested", "withdraw_completed",
  "share_clicked", "referral_visit", "referral_deposit",
];

async function countsFromSupabase() {
  const out: Record<string, number> = {};
  for (const e of EVENTS) {
    const { count } = await supabaseAdmin!
      .from("demo_events").select("*", { count: "exact", head: true }).eq("event", e);
    out[e] = count ?? 0;
  }
  const { data } = await supabaseAdmin!
    .from("demo_events").select("wallet").eq("event", "deposit_confirmed").not("wallet", "is", null);
  return { out, uniqueDepositors: new Set((data ?? []).map((r) => r.wallet)).size };
}

async function countsFromLocal() {
  const out: Record<string, number> = Object.fromEntries(EVENTS.map((e) => [e, 0]));
  const wallets = new Set<string>();
  try {
    const raw = await fs.readFile(path.join(process.cwd(), ".demo-events.local.jsonl"), "utf8");
    for (const line of raw.split("\n")) {
      const row = parseEventLine(line);
      if (!row) continue;
      const event = row.event as string;
      if (event in out) out[event]++;
      if (event === "deposit_confirmed" && row.wallet) wallets.add(row.wallet as string);
    }
  } catch {}
  return { out, uniqueDepositors: wallets.size };
}

export default async function Dashboard() {
  const { out, uniqueDepositors } = supabaseAdmin ? await countsFromSupabase() : await countsFromLocal();
  return (
    <main className="mx-auto max-w-lg px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">
        Funnel{" "}
        {!supabaseAdmin && (
          <span className="text-xs font-normal text-muted-foreground">(local sink)</span>
        )}
      </h1>
      <div className="mt-6 overflow-hidden rounded-lg border border-border bg-card">
        <table className="w-full text-left">
          <tbody>
            {Object.entries(out).map(([k, v]) => (
              <tr key={k} className="border-b border-border last:border-b-0">
                <td className="px-4 py-2.5 text-sm text-muted-foreground">{k}</td>
                <td className="px-4 py-2.5 text-right font-mono tabular-nums text-foreground">{v}</td>
              </tr>
            ))}
            <tr className="border-t border-border bg-secondary/40">
              <td className="px-4 py-3 text-sm font-semibold text-foreground">unique depositors</td>
              <td className="px-4 py-3 text-right font-mono text-lg font-bold tabular-nums text-accent-warm">{uniqueDepositors}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="mt-4 text-xs text-muted-foreground">The go/no-go number is unique depositors out of ~15–20 shared.</p>
    </main>
  );
}
