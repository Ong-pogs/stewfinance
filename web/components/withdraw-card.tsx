"use client";
import { useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { getProgram, requestWithdraw, withdraw, readPosition } from "@/lib/stewfi";
import { track } from "@/lib/track";
import { useToast } from "@/components/toast";
import { InfoTooltip } from "@/components/tooltip";

export function WithdrawCard({ onDone }: { onDone: () => void }) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function act() {
    if (!wallet.publicKey) return;
    setBusy(true); setMsg(null);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const program = getProgram(connection, wallet as any);
      const pos = await readPosition(program, wallet.publicKey);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const requestedAt = pos ? Number((pos.withdrawRequestedAt as any).toString()) : 0;
      if (!requestedAt) {
        const sig = await requestWithdraw(program, wallet.publicKey);
        track("withdraw_requested", { wallet: wallet.publicKey.toBase58() });
        setMsg("Withdrawal requested. 24h cooldown, then withdraw. (Demo: cooldown is real on-chain.)");
        toast.success("Withdrawal requested", {
          description: "24h cooldown, then complete the withdrawal. Principal is safe throughout.",
          txSig: sig,
        });
      } else {
        const sig = await withdraw(program, wallet.publicKey);
        track("withdraw_completed", { wallet: wallet.publicKey.toBase58() });
        setMsg("Withdrawn. Principal returned in full.");
        toast.success("Withdrawn", {
          description: "Your principal was returned in full.",
          txSig: sig,
        });
        onDone();
      }
    } catch (e) {
      const m = (e as Error).message;
      setMsg(m);
      toast.error("Withdrawal failed", { description: m });
    }
    finally { setBusy(false); }
  }

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-foreground">
        Withdraw
        <InfoTooltip label="Cooldown">
          After you request a withdrawal there&apos;s a 24h wait, then your full
          principal is withdrawable.
        </InfoTooltip>
      </div>
      <button onClick={act} disabled={busy}
        className="w-full rounded-lg border border-border bg-transparent py-2 text-sm text-foreground transition-colors hover:border-primary disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
        {busy ? "Working…" : "Request / complete withdrawal"}
      </button>
      <p className="mt-2 text-xs text-muted-foreground">No-loss: your full principal is always withdrawable (24h cooldown).</p>
      {msg && <p className="mt-2 text-sm text-muted-foreground">{msg}</p>}
    </div>
  );
}
