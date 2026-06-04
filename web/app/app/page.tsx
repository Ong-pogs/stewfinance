"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { BN, Program } from "@coral-xyz/anchor";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { ConnectButton } from "@/components/connect-button";
import { DepositCard } from "@/components/deposit-card";
import { PositionCard } from "@/components/position-card";
import { SimulatedDraw } from "@/components/simulated-draw";
import { WithdrawCard } from "@/components/withdraw-card";
import { DrawCard } from "@/components/draw-card";
import { DrawReveal } from "@/components/draw-reveal";
import { ClaimCard } from "@/components/claim-card";
import { DrawHistory } from "@/components/draw-history";
import { ShareCard } from "@/components/share-card";
import { PotTicker } from "@/components/pot-ticker";
import { Leaderboard } from "@/components/leaderboard";
import { TicketsViz } from "@/components/tickets-viz";
import { Badges } from "@/components/badges";
import { SecondaryTabs } from "@/components/secondary-tabs";
import type { PositionRow } from "@/components/leaderboard";
import { getProgram, readPosition, readPool, readCurrentDraw, listDraws, readAllPositions, DrawSummary } from "@/lib/stewfi";
import { fmtUsdc } from "@/lib/format";
import { formatCountdown } from "@/lib/draw-utils";
import { Stewfi } from "@/lib/idl";
import { track } from "@/lib/track";

export default function AppPage() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [amount, setAmount] = useState<BN | null>(null);
  const [poolTotal, setPoolTotal] = useState<BN | null>(null);
  const [nextDrawTs, setNextDrawTs] = useState<BN | null>(null);
  const [firstTs, setFirstTs] = useState<BN | null>(null);
  const [withdrawRequestedAt, setWithdrawRequestedAt] = useState<BN | null>(null);
  const [sumAmount, setSumAmount] = useState<BN | null>(null);
  const [sumAmtFirstTs, setSumAmtFirstTs] = useState<BN | null>(null);
  const [currentDraw, setCurrentDraw] = useState<Awaited<ReturnType<typeof readCurrentDraw>>>(null);
  const [draws, setDraws] = useState<DrawSummary[]>([]);
  const [program, setProgram] = useState<Program<Stewfi> | null>(null);
  const [justDeposited, setJustDeposited] = useState(false);
  const [positions, setPositions] = useState<PositionRow[]>([]);
  const [pool, setPool] = useState<Awaited<ReturnType<typeof readPool>>>(null);
  const [showReveal, setShowReveal] = useState(false);
  const [heroSecsLeft, setHeroSecsLeft] = useState<number>(0);
  const prevDrawStatusRef = useRef<string | null>(null);

  // Track page visit and capture referral code on mount (first-touch only).
  useEffect(() => {
    track("visit", { props: { page: "/app" } });
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const ref = params.get("ref");
      if (ref && !localStorage.getItem("stew_ref")) {
        localStorage.setItem("stew_ref", ref);
        track("referral_visit", { props: { ref } });
      }
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!wallet.publicKey) { setAmount(null); return; }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prog = getProgram(connection, wallet as any);
    setProgram(prog);
    const [pos, poolData, draw, allDraws, allPositions] = await Promise.all([
      readPosition(prog, wallet.publicKey),
      readPool(prog),
      readCurrentDraw(prog),
      listDraws(prog),
      readAllPositions(prog),
    ]);
    setAmount(pos ? (pos.amount as BN) : null);
    setFirstTs(pos ? (pos.firstDepositTs as BN) : null);
    setWithdrawRequestedAt(pos ? (pos.withdrawRequestedAt as BN) : null);
    setPoolTotal(poolData ? (poolData.totalPrincipal as BN) : null);
    setSumAmount(poolData ? (poolData.sumAmount as BN) : null);
    setSumAmtFirstTs(poolData ? (poolData.sumAmountFirstTs as BN) : null);
    setNextDrawTs(poolData ? (poolData.nextDrawTs as BN) : null);
    setCurrentDraw(draw);
    setDraws(allDraws);
    setPositions(allPositions as PositionRow[]);
    setPool(poolData);
  }, [connection, wallet]);

  useEffect(() => { refresh(); }, [refresh]);

  // Detect committed → settled transition and surface DrawReveal prominently.
  useEffect(() => {
    const newStatus = currentDraw
      ? Object.keys(currentDraw.status as object)[0]
      : null;
    if (prevDrawStatusRef.current === "committed" && newStatus === "settled") {
      setShowReveal(true);
    }
    prevDrawStatusRef.current = newStatus;
  }, [currentDraw]);

  // Live "Next draw in" countdown for the pot hero (same source as DrawCard).
  useEffect(() => {
    if (!nextDrawTs) { setHeroSecsLeft(0); return; }
    const target = nextDrawTs.toNumber();
    function tick() {
      setHeroSecsLeft(Math.max(0, target - Math.floor(Date.now() / 1000)));
    }
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [nextDrawTs]);

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      {/* (a) Top bar — wordmark + wallet */}
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">
          <span className="bg-[image:--gradient-text] bg-clip-text text-transparent">StewFi</span>
        </h1>
        <ConnectButton />
      </div>
      {!wallet.connected ? (
        <p className="text-zinc-400">Connect a wallet to try a deposit.</p>
      ) : (
        <div className="space-y-6">
          {/* (b) Pot hero — full width */}
          {pool && (
            <div>
              <PotTicker
                pool={{
                  potPrincipalUsdc: (pool.potPrincipalUsdc as BN) ?? new BN(0),
                  totalPrincipal: (pool.totalPrincipal as BN) ?? new BN(0),
                }}
              />
              {nextDrawTs && nextDrawTs.gtn(0) && (
                <div className="mt-3 text-sm text-muted-foreground">
                  {heroSecsLeft > 0 ? (
                    <>Next draw in <span className="font-mono tabular-nums">{formatCountdown(heroSecsLeft)}</span></>
                  ) : (
                    "Draw ready"
                  )}
                </div>
              )}
            </div>
          )}

          {/* (c) Core row — position zone | draw slot */}
          <div className="grid gap-4 md:grid-cols-2">
            {/* LEFT — your position */}
            <div className="space-y-4">
              <PositionCard amount={amount} poolTotal={poolTotal} />
              {!amount && (
                <DepositCard
                  onDone={() => {
                    // Fire referral_deposit if this wallet came via a referral link.
                    const ref =
                      typeof window !== "undefined"
                        ? localStorage.getItem("stew_ref")
                        : null;
                    if (ref && wallet.publicKey) {
                      track("referral_deposit", {
                        wallet: wallet.publicKey.toBase58(),
                        props: { ref },
                      });
                    }
                    setJustDeposited(true);
                    refresh();
                  }}
                />
              )}
              {/* Pre-deposit share card — shown briefly after a confirmed deposit */}
              {justDeposited && wallet.publicKey && (
                <ShareCard
                  mode="pre-deposit"
                  potUsdc={poolTotal ? fmtUsdc(poolTotal) : undefined}
                  referralCode={wallet.publicKey.toBase58()}
                  wallet={wallet.publicKey.toBase58()}
                />
              )}
              {amount && <WithdrawCard onDone={refresh} />}
            </div>

            {/* RIGHT — draw slot (consolidated in a later task) */}
            <div className="space-y-4">
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

              {/* Draw reveal — brewing/settled panel for current draw */}
              {currentDraw && wallet.publicKey && (() => {
                const drawStatus = Object.keys(currentDraw.status as object)[0];
                // Always show for committed/settled; for settled also respect the
                // showReveal prominence flag (set on committed→settled transition).
                if (drawStatus === "committed" || drawStatus === "settled" || showReveal) {
                  const revealDraw: import("@/lib/stewfi").DrawSummary = {
                    round: (currentDraw.round as BN).toNumber(),
                    status: drawStatus,
                    prizePool: currentDraw.prizePool as BN,
                    winner: currentDraw.winner as import("@solana/web3.js").PublicKey,
                    winnerAmount: currentDraw.winnerAmount as BN,
                    winnerClaimed: currentDraw.winnerClaimed as boolean,
                    drawTs: currentDraw.drawTs as BN,
                    growingPotAmount: (currentDraw.growingPotAmount ?? new BN(0)) as BN,
                  };
                  return (
                    <DrawReveal
                      draw={revealDraw}
                      walletPubkey={wallet.publicKey}
                      potUsdc={pool ? fmtUsdc(pool.potPrincipalUsdc as BN) : "0.00"}
                      referralCode={wallet.publicKey.toBase58()}
                    />
                  );
                }
                return null;
              })()}

              {/* Claim banner — only visible if connected wallet won a settled draw */}
              <ClaimCard
                program={program}
                walletPubkey={wallet.publicKey}
                draws={draws}
                onDone={refresh}
              />
              {/* Win share card — shown when the connected wallet has a claimable win */}
              {wallet.publicKey && (() => {
                const claimable = draws.find(
                  (d) =>
                    d.status === "settled" &&
                    !d.winnerClaimed &&
                    d.winner.equals(wallet.publicKey!),
                );
                return claimable ? (
                  <ShareCard
                    mode="win"
                    round={claimable.round}
                    amount={fmtUsdc(claimable.winnerAmount)}
                    referralCode={wallet.publicKey!.toBase58()}
                    wallet={wallet.publicKey!.toBase58()}
                  />
                ) : null;
              })()}

              {/* Simulated draw — odds explainer, kept as "preview your odds" */}
              <SimulatedDraw
                poolTotal={poolTotal}
                myAmount={amount}
                firstDepositTs={firstTs}
                sumAmount={sumAmount}
                sumAmountFirstTs={sumAmtFirstTs}
              />

              {/* Live entries card — real on-chain odds formula, distinct from SimulatedDraw preview */}
              <TicketsViz
                myAmount={amount}
                firstDepositTs={firstTs}
                sumAmount={sumAmount}
                sumAmountFirstTs={sumAmtFirstTs}
              />
            </div>
          </div>

          {/* (d) Secondary — Leaderboard / Badges / History in tabs */}
          <SecondaryTabs
            leaderboard={
              <Leaderboard
                positions={positions}
                walletPubkey={wallet.publicKey ?? null}
              />
            }
            badges={
              <Badges
                amount={amount}
                firstDepositTs={firstTs}
                withdrawRequestedAt={withdrawRequestedAt}
                walletPubkey={wallet.publicKey ?? null}
                draws={draws}
              />
            }
            history={<DrawHistory draws={draws} />}
          />
        </div>
      )}
    </main>
  );
}
