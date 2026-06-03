import { promises as fs } from "fs";
import path from "path";
import { supabaseAdmin } from "@/lib/supabase";

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
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      if (row.event in out) out[row.event]++;
      if (row.event === "deposit_confirmed" && row.wallet) wallets.add(row.wallet);
    }
  } catch {}
  return { out, uniqueDepositors: wallets.size };
}

export default async function Dashboard() {
  const { out, uniqueDepositors } = supabaseAdmin ? await countsFromSupabase() : await countsFromLocal();
  return (
    <main className="mx-auto max-w-lg px-6 py-12">
      <h1 className="text-2xl font-bold">Funnel {!supabaseAdmin && <span className="text-xs text-zinc-500">(local sink)</span>}</h1>
      <table className="mt-6 w-full text-left">
        <tbody>
          {Object.entries(out).map(([k, v]) => (
            <tr key={k} className="border-b border-zinc-800">
              <td className="py-2 text-zinc-400">{k}</td>
              <td className="py-2 text-right font-mono">{v}</td>
            </tr>
          ))}
          <tr><td className="py-2 font-semibold">unique depositors</td>
              <td className="py-2 text-right font-mono stew-accent">{uniqueDepositors}</td></tr>
        </tbody>
      </table>
      <p className="mt-4 text-xs text-zinc-600">The go/no-go number is unique depositors out of ~15–20 shared.</p>
    </main>
  );
}
