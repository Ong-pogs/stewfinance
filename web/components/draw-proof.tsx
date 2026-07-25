"use client";
/**
 * Shared fairness-proof card for one settled draw. Rendered on /verify (every
 * settled draw) and /draw/[round] (single-draw permalink). Pure presentation
 * of facts the chain already proved — the caller does the reading.
 */
import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { drawPda } from "@/lib/pdas";
import { computeTicket } from "@/lib/gamify";
import { fmtUsdc, abbrev } from "@/lib/format";
import { statusLabel } from "@/lib/draw-utils";

// ── on-chain explorer links (devnet) ────────────────────────────────────────
function explorerAddr(pubkey: string): string {
  return `https://explorer.solana.com/address/${pubkey}?cluster=devnet`;
}

// ── full settled-draw shape we render ────────────────────────────────────────
export type VerifiableDraw = {
  round: number;
  status: string;
  prizePool: BN;
  winner: PublicKey;
  winnerAmount: BN;
  growingPotAmount: BN;
  operatorAmount: BN;
  opsAmount: BN;
  winnerClaimed: boolean;
  drawTs: BN;
  totalWeight: BN;
  randomValue: number[];
  randomnessAccount: PublicKey;
};

/** 32 raw VRF bytes → "0x"-prefixed lowercase hex. */
function toHex(bytes: number[] | Uint8Array): string {
  return (
    "0x" +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}

// ── one draw's full fairness proof ───────────────────────────────────────────
export function DrawProof({ draw }: { draw: VerifiableDraw }) {
  const ticket = computeTicket(draw.randomValue, draw.totalWeight);
  const valueHex = toHex(draw.randomValue);
  // u128(value[0..16] LE) — shown so the modulo step is fully reproducible.
  const valueU128 = new BN(
    Buffer.from(draw.randomValue.slice(0, 16)),
    "le",
  ).toString();
  const winnerStr = draw.winner.toBase58();

  return (
    <article className="rounded-xl border border-border bg-card p-5">
      {/* Round header + status */}
      <div className="flex items-center justify-between border-b border-border pb-3">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold text-foreground">
            Round{" "}
            <span className="font-mono tabular-nums">{draw.round}</span>
          </span>
          <span className="rounded bg-secondary px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            {statusLabel(draw.status)}
          </span>
        </div>
        <a
          href={explorerAddr(drawPda(draw.round).toBase58())}
          target="_blank"
          rel="noreferrer"
          className="rounded text-xs text-primary underline decoration-border underline-offset-2 hover:text-accent-warm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
        >
          Draw account ↗
        </a>
      </div>

      {/* Prize + winner */}
      <dl className="mt-4 grid grid-cols-2 gap-4 text-sm">
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">
            Prize
          </dt>
          <dd className="mt-1 font-mono tabular-nums text-foreground">
            {fmtUsdc(draw.prizePool)}{" "}
            <span className="text-xs text-muted-foreground">USDC</span>
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">
            Winner
          </dt>
          <dd className="mt-1">
            <a
              href={explorerAddr(winnerStr)}
              target="_blank"
              rel="noreferrer"
              className="rounded font-mono text-foreground underline decoration-border underline-offset-2 hover:text-accent-warm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
            >
              {abbrev(winnerStr)} ↗
            </a>
          </dd>
        </div>
      </dl>

      {/* Prize split 65/20/10/5 */}
      <div className="mt-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          Prize split
        </div>
        <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-4">
          <SplitRow label="Winner 65%" amount={draw.winnerAmount} accent />
          <SplitRow label="Growing pot 20%" amount={draw.growingPotAmount} />
          <SplitRow label="Operator 10%" amount={draw.operatorAmount} />
          <SplitRow label="Ops 5%" amount={draw.opsAmount} />
        </div>
      </div>

      {/* The VRF value */}
      <div className="mt-5 border-t border-border pt-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          Switchboard VRF value (revealed)
        </div>
        <code className="mt-1.5 block break-all rounded-lg bg-secondary px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground">
          {valueHex}
        </code>
        <a
          href={explorerAddr(draw.randomnessAccount.toBase58())}
          target="_blank"
          rel="noreferrer"
          className="mt-1.5 inline-block rounded text-xs text-primary underline decoration-border underline-offset-2 hover:text-accent-warm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
        >
          Randomness account ↗
        </a>
      </div>

      {/* The derivation, step by step */}
      <div className="mt-5 border-t border-border pt-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          How the winner was derived (on-chain)
        </div>
        <ol className="mt-2 space-y-2 text-xs leading-relaxed">
          <li className="flex gap-2">
            <span className="font-mono text-muted-foreground">1.</span>
            <span>
              <span className="text-muted-foreground">total_weight</span> ={" "}
              <span className="font-mono tabular-nums text-foreground">
                {draw.totalWeight.toString()}
              </span>{" "}
              <span className="text-muted-foreground">
                — snapshotted on-chain at commit (Σ amount × seconds held).
              </span>
            </span>
          </li>
          <li className="flex gap-2">
            <span className="font-mono text-muted-foreground">2.</span>
            <span>
              <span className="text-muted-foreground">u128(value[0..16])</span> ={" "}
              <span className="font-mono tabular-nums text-foreground break-all">
                {valueU128}
              </span>{" "}
              <span className="text-muted-foreground">
                — the low 16 bytes of the VRF value, little-endian.
              </span>
            </span>
          </li>
          <li className="flex gap-2">
            <span className="font-mono text-muted-foreground">3.</span>
            <span>
              <span className="text-muted-foreground">ticket</span> ={" "}
              <span className="text-muted-foreground">
                u128(value[0..16]) % total_weight
              </span>{" "}
              ={" "}
              <span className="font-mono tabular-nums font-semibold text-accent-warm">
                {ticket.toString()}
              </span>
            </span>
          </li>
          <li className="flex gap-2">
            <span className="font-mono text-muted-foreground">4.</span>
            <span className="text-foreground/90">
              The winning ticket fell inside{" "}
              <span className="font-mono">{abbrev(winnerStr)}</span>&apos;s weight
              window (their size × time held), so they won. The program proved
              the summed weight of all positions equals{" "}
              <span className="text-muted-foreground">total_weight</span>, so the
              set is complete and the winner is unique.
            </span>
          </li>
        </ol>
      </div>
    </article>
  );
}

export function SplitRow({
  label,
  amount,
  accent = false,
}: {
  label: string;
  amount: BN;
  accent?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2 sm:flex-col sm:items-start sm:justify-start">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={`font-mono tabular-nums ${accent ? "font-semibold text-accent-warm" : "text-foreground"}`}
      >
        {fmtUsdc(amount)}
      </span>
    </div>
  );
}
