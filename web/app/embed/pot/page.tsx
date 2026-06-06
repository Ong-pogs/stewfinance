"use client";
/**
 * /embed/pot — minimal, chrome-less, iframe-able Growing Pot widget.
 *
 * Designed to be dropped into any page via:
 *   <iframe src="https://…/embed/pot" width="320" height="180" …/>
 *
 * It reads the live Growing Pot wallet-less (same read-only AnchorProvider
 * pattern as /verify and /stats) and renders ONLY the number + tagline + a
 * small "Open ↗" link back to the app. No nav, no devnet banner, no footer:
 * the widget is a `fixed inset-0` dark panel, so it fully covers the global
 * chrome the root layout renders, and reads as a standalone card inside an
 * iframe. Forced dark + brand tokens so it looks right regardless of the host
 * page. Pure presentation of a fact the chain already proved — NO contract /
 * odds / tracking changes.
 */
import { useEffect, useState } from "react";
import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { STEWFI_IDL, Stewfi } from "@/lib/idl";
import { readPool } from "@/lib/stewfi";
import { fmtUsdc } from "@/lib/format";
import { RPC_URL } from "@/lib/constants";

// Read on every request (no static caching of a live on-chain value).
export const dynamic = "force-dynamic";

export default function EmbedPotPage() {
  // null = loading; BN = a real read (incl. 0 if the pool is empty).
  const [pot, setPot] = useState<BN | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const conn = new Connection(RPC_URL, "confirmed");
        const provider = new AnchorProvider(
          conn,
          // Read-only: never signs, only satisfies the provider type.
          { publicKey: PublicKey.default } as AnchorProvider["wallet"],
          { commitment: "confirmed" },
        );
        const program = new Program<Stewfi>(STEWFI_IDL, provider);
        const pool = await readPool(program);
        if (!cancelled) setPot((pool?.potPrincipalUsdc as BN) ?? new BN(0));
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Same-origin app link. Falls back to the relative path if window isn't ready.
  const appHref =
    typeof window !== "undefined" ? `${window.location.origin}/app` : "/app";

  return (
    // `dark` forces Linen Pearl Dark tokens regardless of the host page; the
    // fixed inset panel covers the root layout's banner so the iframe is clean.
    <div className="dark">
      <div className="fixed inset-0 flex flex-col items-center justify-center gap-2 overflow-hidden bg-background px-5 py-4 text-center font-sans text-foreground">
        <div className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
          StewFi · Growing Pot
        </div>

        <div className="font-mono tabular-nums leading-none">
          {failed ? (
            <span className="text-base text-muted-foreground">
              pot unavailable
            </span>
          ) : pot === null ? (
            <span className="text-base text-muted-foreground">reading…</span>
          ) : (
            <span className="text-4xl font-bold text-accent-warm">
              {fmtUsdc(pot)}
              <span className="ml-1.5 text-sm font-semibold text-muted-foreground">
                USDC
              </span>
            </span>
          )}
        </div>

        <div className="text-xs text-foreground/80">
          the interest is the prize
        </div>

        <a
          href={appHref}
          target="_blank"
          rel="noreferrer"
          className="mt-0.5 inline-flex items-center gap-1 rounded text-[11px] font-medium text-primary underline decoration-border underline-offset-2 transition-colors hover:text-accent-warm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          Open <span aria-hidden="true">↗</span>
        </a>
      </div>
    </div>
  );
}
