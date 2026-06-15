"use client";
import { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { getProgram, deposit } from "@/lib/stewfi";
import { toBaseUnits } from "@/lib/format";
import { MIN_DEPOSIT_UI, MAX_DEPOSIT_UI, USDC_MINT } from "@/lib/constants";
import { track } from "@/lib/track";
import { useToast } from "@/components/toast";

export function DepositCard({ onDone }: { onDone: () => void }) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const toast = useToast();
  const [amount, setAmount] = useState("50");
  const [busy, setBusy] = useState<"idle" | "faucet" | "deposit">("idle");
  const [err, setErr] = useState<string | null>(null);
  // Connected wallet's test-USDC balance (UI units). null = not yet read.
  const [balance, setBalance] = useState<number | null>(null);

  // Read the connected wallet's test-USDC ATA balance. Never throws:
  // no ATA / RPC hiccup → balance 0 so the UI degrades gracefully.
  const refreshBalance = useCallback(async () => {
    if (!wallet.publicKey) {
      setBalance(null);
      return;
    }
    try {
      const ata = getAssociatedTokenAddressSync(USDC_MINT, wallet.publicKey);
      const res = await connection.getTokenAccountBalance(ata);
      setBalance(res.value.uiAmount ?? 0);
    } catch {
      // Most common cause: the ATA doesn't exist yet (never received USDC).
      setBalance(0);
    }
  }, [connection, wallet.publicKey]);

  useEffect(() => {
    let cancelled = false;
    // Guard against an account switch: if the wallet changes while this read is
    // in flight, drop the stale result instead of showing the prior wallet's
    // USDC balance (and wrongly enabling Max). Mirrors the sibling fetch effects.
    (async () => {
      if (!wallet.publicKey) {
        if (!cancelled) setBalance(null);
        return;
      }
      try {
        const ata = getAssociatedTokenAddressSync(USDC_MINT, wallet.publicKey);
        const res = await connection.getTokenAccountBalance(ata);
        if (!cancelled) setBalance(res.value.uiAmount ?? 0);
      } catch {
        // Most common cause: the ATA doesn't exist yet (never received USDC).
        if (!cancelled) setBalance(0);
      }
    })();
    return () => { cancelled = true; };
  }, [connection, wallet.publicKey]);

  const canMax = balance !== null && balance >= MIN_DEPOSIT_UI;
  function setMax() {
    if (balance === null) return;
    const target = Math.min(balance, MAX_DEPOSIT_UI);
    // Trim to whole-cent precision to match USDC's 6-decimal base units.
    setAmount(String(Math.floor(target * 100) / 100));
    setErr(null);
  }

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
      refreshBalance();
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
      refreshBalance();
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
        className="mb-4 w-full rounded-lg border border-border bg-transparent py-2 text-sm text-foreground transition-colors hover:border-primary disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
        {busy === "faucet" ? "Minting…" : "1. Get 100 test USDC"}
      </button>
      <div className="flex items-baseline justify-between">
        <label className="text-sm text-muted-foreground">2. Deposit amount (USDC)</label>
        <span className="text-xs text-muted-foreground">
          Balance:{" "}
          <span className="font-mono tabular-nums text-foreground">
            {balance === null ? "—" : balance.toLocaleString("en-US", { maximumFractionDigits: 2 })}
          </span>{" "}
          USDC
        </span>
      </div>
      <div className="relative mt-1">
        <input value={amount} onChange={(e) => setAmount(e.target.value)} type="number"
          aria-label="Deposit amount in USDC"
          className="w-full rounded-lg bg-input border border-border px-3 py-2 pr-16 font-mono tabular-nums text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background" />
        <button
          type="button"
          onClick={setMax}
          disabled={!canMax || busy !== "idle"}
          title={canMax ? undefined : "get test USDC first"}
          aria-label="Set deposit to maximum balance"
          className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md border border-border bg-transparent px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background">
          Max
        </button>
      </div>
      {balance !== null && !canMax && (
        <p className="mt-1 text-xs text-muted-foreground">get test USDC first</p>
      )}
      <button onClick={doDeposit} disabled={busy !== "idle"}
        className="mt-3 w-full rounded-lg bg-primary py-3 font-semibold text-primary-foreground disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
        {busy === "deposit" ? "Confirming…" : "Deposit"}
      </button>
      {err && <p className="mt-3 text-sm text-destructive">{err}</p>}
    </div>
  );
}
