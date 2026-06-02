"use client";
import { useCallback, useEffect, useState } from "react";
import { BN, Program } from "@coral-xyz/anchor";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { ConnectButton } from "@/components/connect-button";
import { DepositCard } from "@/components/deposit-card";
import { PositionCard } from "@/components/position-card";
import { SimulatedDraw } from "@/components/simulated-draw";
import { WithdrawCard } from "@/components/withdraw-card";
import { DrawCard } from "@/components/draw-card";
import { ClaimCard } from "@/components/claim-card";
import { DrawHistory } from "@/components/draw-history";
import { getProgram, readPosition, readPool, readCurrentDraw, listDraws, DrawSummary } from "@/lib/stewfi";
import { Stewfi } from "@/lib/idl";
import { track } from "@/lib/track";

export default function AppPage() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [amount, setAmount] = useState<BN | null>(null);
  const [poolTotal, setPoolTotal] = useState<BN | null>(null);
  const [nextDrawTs, setNextDrawTs] = useState<BN | null>(null);
  const [firstTs, setFirstTs] = useState<BN | null>(null);
  const [sumAmount, setSumAmount] = useState<BN | null>(null);
  const [sumAmtFirstTs, setSumAmtFirstTs] = useState<BN | null>(null);
  const [currentDraw, setCurrentDraw] = useState<Awaited<ReturnType<typeof readCurrentDraw>>>(null);
  const [draws, setDraws] = useState<DrawSummary[]>([]);
  const [program, setProgram] = useState<Program<Stewfi> | null>(null);

  useEffect(() => { track("visit", { props: { page: "/app" } }); }, []);

  const refresh = useCallback(async () => {
    if (!wallet.publicKey) { setAmount(null); return; }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prog = getProgram(connection, wallet as any);
    setProgram(prog);
    const [pos, pool, draw, allDraws] = await Promise.all([
      readPosition(prog, wallet.publicKey),
      readPool(prog),
      readCurrentDraw(prog),
      listDraws(prog),
    ]);
    setAmount(pos ? (pos.amount as BN) : null);
    setFirstTs(pos ? (pos.firstDepositTs as BN) : null);
    setPoolTotal(pool ? (pool.totalPrincipal as BN) : null);
    setSumAmount(pool ? (pool.sumAmount as BN) : null);
    setSumAmtFirstTs(pool ? (pool.sumAmountFirstTs as BN) : null);
    setNextDrawTs(pool ? (pool.nextDrawTs as BN) : null);
    setCurrentDraw(draw);
    setDraws(allDraws);
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

          {/* Live draw card — reads on-chain; graceful null when no draw accounts yet */}
          <DrawCard
            draw={currentDraw
              ? {
                  round: (currentDraw.round as BN).toNumber(),
                  status: Object.keys(currentDraw.status as object)[0],
                  prizePool: currentDraw.prizePool as BN,
                  drawTs: currentDraw.drawTs as BN,
                }
              : null}
            nextDrawTs={nextDrawTs}
            poolTotal={poolTotal}
          />

          {/* Claim banner — only visible if connected wallet won a settled draw */}
          <ClaimCard
            program={program}
            walletPubkey={wallet.publicKey}
            draws={draws}
            onDone={refresh}
          />

          {/* Simulated draw — odds explainer, kept as "preview your odds" */}
          <SimulatedDraw
            poolTotal={poolTotal}
            myAmount={amount}
            firstDepositTs={firstTs}
            sumAmount={sumAmount}
            sumAmountFirstTs={sumAmtFirstTs}
          />

          {/* Draw history table */}
          <DrawHistory draws={draws} />
        </div>
      )}
    </main>
  );
}
