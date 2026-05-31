"use client";
import { useCallback, useEffect, useState } from "react";
import { BN } from "@coral-xyz/anchor";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { ConnectButton } from "@/components/connect-button";
import { DepositCard } from "@/components/deposit-card";
import { PositionCard } from "@/components/position-card";
import { SimulatedDraw } from "@/components/simulated-draw";
import { WithdrawCard } from "@/components/withdraw-card";
import { getProgram, readPosition, readPool } from "@/lib/stewfi";
import { track } from "@/lib/track";

export default function AppPage() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [amount, setAmount] = useState<BN | null>(null);
  const [poolTotal, setPoolTotal] = useState<BN | null>(null);

  useEffect(() => { track("visit", { props: { page: "/app" } }); }, []);

  const refresh = useCallback(async () => {
    if (!wallet.publicKey) { setAmount(null); return; }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const program = getProgram(connection, wallet as any);
    const [pos, pool] = await Promise.all([readPosition(program, wallet.publicKey), readPool(program)]);
    setAmount(pos ? (pos.amount as BN) : null);
    setPoolTotal(pool ? (pool.totalPrincipal as BN) : null);
  }, [connection, wallet]);

  useEffect(() => { refresh(); }, [refresh]);

  return (
    <main className="mx-auto max-w-md px-6 py-12">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">StewFi <span className="stew-accent">demo</span></h1>
        <ConnectButton />
      </div>
      {!wallet.connected ? (
        <p className="text-zinc-400">Connect a wallet to try a deposit.</p>
      ) : (
        <div className="space-y-5">
          <PositionCard amount={amount} poolTotal={poolTotal} />
          {!amount && <DepositCard onDone={refresh} />}
          {amount && <WithdrawCard onDone={refresh} />}
          <SimulatedDraw poolTotal={poolTotal} myAmount={amount} />
        </div>
      )}
    </main>
  );
}
