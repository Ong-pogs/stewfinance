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

// The link the tweet carries → our /share page (NOT /app directly), so X
// fetches /share's OG metadata and unfurls the branded /api/og card. We keep
// the referral via ?ref= and forward the card params (kind/round/amount/pot).
// The /share "Open the app" CTA preserves ?ref= into /app, so referral
// attribution still lands. `og` kind maps the UI mode onto the image's kinds:
// a "win" stays "win"; a "pre-deposit" share is the "join" card.
function buildShareUrl(props: ShareCardProps): string {
  const origin =
    typeof window !== "undefined" ? window.location.origin : "";
  const kind = props.mode === "win" ? "win" : "join";
  const qs = new URLSearchParams({ kind, ref: props.referralCode });
  if (props.mode === "win") {
    if (props.round !== undefined) qs.set("round", String(props.round));
    if (props.amount !== undefined) qs.set("amount", props.amount);
  }
  return `${origin}/share?${qs.toString()}`;
}

function buildTweetText(props: ShareCardProps): string {
  const shareUrl = buildShareUrl(props);

  if (props.mode === "win") {
    return (
      `Won Round ${props.round ?? "?"} on StewFi 🔮 ${props.amount ?? "?"} USDC — ` +
      `principal never moved, and the pot keeps growing. ${shareUrl}`
    );
  }
  // pre-deposit
  return (
    `Just joined the StewFi pool — save USDC, the interest is the prize, ` +
    `principal stays mine. Pot's at ${props.potUsdc ?? "?"} and climbing 🔮 ${shareUrl}`
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
        className="mt-3 w-full rounded-lg border border-border bg-transparent py-2 text-sm text-foreground transition-colors hover:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        Share on X
      </button>
    </div>
  );
}
