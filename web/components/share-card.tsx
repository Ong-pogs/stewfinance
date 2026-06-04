"use client";
import { track } from "@/lib/track";

export type ShareCardProps = {
  mode: "win" | "pre-deposit";
  round?: number;
  amount?: string;  // formatted USDC string, e.g. "1,234.56"
  potUsdc?: string; // formatted pot size string, e.g. "9,876.54"
  referralCode: string; // connected wallet base58
  wallet?: string;
};

function buildTweetText(props: ShareCardProps): string {
  const refUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/app?ref=${props.referralCode}`
      : `/app?ref=${props.referralCode}`;

  if (props.mode === "win") {
    return (
      `Won Round ${props.round ?? "?"} on StewFi 🔮 ${props.amount ?? "?"} USDC — ` +
      `principal never moved, and the pot keeps growing. ${refUrl}`
    );
  }
  // pre-deposit
  return (
    `Just joined the StewFi pool — save USDC, the interest is the prize, ` +
    `principal stays mine. Pot's at ${props.potUsdc ?? "?"} and climbing 🔮 ${refUrl}`
  );
}

export function ShareCard(props: ShareCardProps) {
  function handleShare() {
    track("share_clicked", {
      wallet: props.wallet,
      props: { kind: props.mode, round: props.round },
    });
    const text = buildTweetText(props);
    const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  const heading =
    props.mode === "win"
      ? "Share your win"
      : "Tell a friend about the pool";

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="text-sm font-semibold text-foreground">{heading}</div>
      <p className="mt-1 text-xs text-muted-foreground">
        Referrals rank you on the board — they don&apos;t change draw odds (odds are
        size × time held, on-chain).
      </p>
      <button
        onClick={handleShare}
        className="mt-3 w-full rounded-lg border border-border bg-transparent py-2 text-sm text-foreground"
      >
        Share on X
      </button>
    </div>
  );
}
