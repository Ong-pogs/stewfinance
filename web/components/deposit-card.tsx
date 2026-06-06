"use client";
import { useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { getProgram, deposit } from "@/lib/stewfi";
import { toBaseUnits } from "@/lib/format";
import { MIN_DEPOSIT_UI, MAX_DEPOSIT_UI } from "@/lib/constants";
import { track } from "@/lib/track";
import { useToast } from "@/components/toast";

export function DepositCard({ onDone }: { onDone: () => void }) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const toast = useToast();
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
      if (!r.ok) {
        if (r.error === "rate_limited") {
          toast.info("Faucet on cooldown", {
            description: "You can request test USDC again in about a minute.",
          });
        }
        throw new Error(r.error === "rate_limited" ? "Faucet rate-limited — try again in a minute." : (r.error ?? "faucet failed"));
      }
      track("faucet", { wallet: wallet.publicKey.toBase58() });
      toast.success("Got 100 test USDC", {
        description: "Test-only tokens, minted to your wallet on devnet.",
        txSig: typeof r.sig === "string" ? r.sig : undefined,
      });
    } catch (e) {
      const msg = (e as Error).message;
      setErr(msg);
      if (msg !== "Faucet rate-limited — try again in a minute.") {
        toast.error("Faucet failed", { description: msg });
      }
    }
    finally { setBusy("idle"); }
  }

  async function doDeposit() {
    if (!wallet.publicKey || !wallet.signTransaction) return;
    const n = Number(amount);
    if (n < MIN_DEPOSIT_UI || n > MAX_DEPOSIT_UI) {
      const msg = `Amount must be ${MIN_DEPOSIT_UI}–${MAX_DEPOSIT_UI} USDC`;
      setErr(msg);
      toast.error("Check the amount", { description: msg });
      return;
    }
    setBusy("deposit"); setErr(null);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const program = getProgram(connection, wallet as any);
      track("deposit_submitted", { wallet: wallet.publicKey.toBase58(), props: { amount: n } });
      toast.info("Deposit submitted", { description: "Confirm in your wallet, then waiting for the network…" });
      const sig = await deposit(program, wallet.publicKey, toBaseUnits(n));
      track("deposit_confirmed", { wallet: wallet.publicKey.toBase58(), props: { amount: n } });
      toast.success(`Deposited ${n} USDC`, {
        description: "Your principal stays yours and is always withdrawable.",
        txSig: sig,
      });
      onDone();
    } catch (e) {
      const msg = (e as Error).message;
      setErr(msg);
      toast.error("Deposit failed", { description: msg });
    }
    finally { setBusy("idle"); }
  }

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <button onClick={doFaucet} disabled={busy !== "idle"}
        className="mb-4 w-full rounded-lg border border-border bg-transparent py-2 text-sm text-foreground disabled:opacity-50">
        {busy === "faucet" ? "Minting…" : "1. Get 100 test USDC"}
      </button>
      <label className="text-sm text-muted-foreground">2. Deposit amount (USDC)</label>
      <input value={amount} onChange={(e) => setAmount(e.target.value)} type="number"
        className="mt-1 w-full rounded-lg bg-input border border-border px-3 py-2 font-mono tabular-nums text-foreground" />
      <button onClick={doDeposit} disabled={busy !== "idle"}
        className="mt-3 w-full rounded-lg bg-primary py-3 font-semibold text-primary-foreground disabled:opacity-50">
        {busy === "deposit" ? "Confirming…" : "Deposit"}
      </button>
      {err && <p className="mt-3 text-sm text-destructive">{err}</p>}
    </div>
  );
}
