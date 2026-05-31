"use client";
import { useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { getProgram, deposit } from "@/lib/stewfi";
import { toBaseUnits } from "@/lib/format";
import { MIN_DEPOSIT_UI, MAX_DEPOSIT_UI } from "@/lib/constants";
import { track } from "@/lib/track";

export function DepositCard({ onDone }: { onDone: () => void }) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [amount, setAmount] = useState("50");
  const [busy, setBusy] = useState<"idle" | "faucet" | "deposit">("idle");
  const [err, setErr] = useState<string | null>(null);

  async function doFaucet() {
    if (!wallet.publicKey) return;
    setBusy("faucet"); setErr(null);
    try {
      const r = await fetch("/api/faucet", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet: wallet.publicKey.toBase58() }),
      }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error ?? "faucet failed");
      track("faucet", { wallet: wallet.publicKey.toBase58() });
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy("idle"); }
  }

  async function doDeposit() {
    if (!wallet.publicKey || !wallet.signTransaction) return;
    const n = Number(amount);
    if (n < MIN_DEPOSIT_UI || n > MAX_DEPOSIT_UI) {
      setErr(`Amount must be ${MIN_DEPOSIT_UI}–${MAX_DEPOSIT_UI} USDC`); return;
    }
    setBusy("deposit"); setErr(null);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const program = getProgram(connection, wallet as any);
      track("deposit_submitted", { wallet: wallet.publicKey.toBase58(), props: { amount: n } });
      await deposit(program, wallet.publicKey, toBaseUnits(n));
      track("deposit_confirmed", { wallet: wallet.publicKey.toBase58(), props: { amount: n } });
      onDone();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy("idle"); }
  }

  return (
    <div className="rounded-xl border border-zinc-800 p-5">
      <button onClick={doFaucet} disabled={busy !== "idle"}
        className="mb-4 w-full rounded-lg border border-purple-700 py-2 text-sm">
        {busy === "faucet" ? "Minting…" : "1. Get 100 test USDC"}
      </button>
      <label className="text-sm text-zinc-400">2. Deposit amount (USDC)</label>
      <input value={amount} onChange={(e) => setAmount(e.target.value)} type="number"
        className="mt-1 w-full rounded-lg bg-zinc-900 border border-zinc-700 px-3 py-2" />
      <button onClick={doDeposit} disabled={busy !== "idle"}
        className="stew-bg mt-3 w-full rounded-lg py-3 font-semibold text-white disabled:opacity-50">
        {busy === "deposit" ? "Confirming…" : "Deposit"}
      </button>
      {err && <p className="mt-3 text-sm text-red-400">{err}</p>}
    </div>
  );
}
