/**
 * /api/og — dynamic branded share-card IMAGE (1200×630).
 *
 * Renders a "Linen Pearl Dark" Open Graph card with `next/og` so a shared
 * StewFi link unfurls a real visual on X (and anywhere else that reads OG
 * tags). Pure presentation — no chain reads, no logic. The /share page points
 * its og:image / twitter:image at this route; share-card.tsx links the tweet
 * to /share so X fetches the card.
 *
 * Querystring params (all optional, all strings):
 *   kind   "win" | "pot" | "join"   (default "join")
 *   round  round number             (win)
 *   amount USDC won, formatted      (win)
 *   pot    pot size, formatted      (pot)
 *
 * Copy per kind (banned words — lottery / stake / APY — kept OUT):
 *   win  → "Won Round {round} · {amount} USDC · principal never moved"
 *   pot  → "The Growing Pot · {pot} USDC and climbing"
 *   join → "I joined the StewFi pool · the interest is the prize"
 *
 * NOTE: OG unfurl on X only works once the site is public (X can't fetch
 * localhost). Hitting this route directly in a browser renders the card
 * locally for verification.
 */
import { ImageResponse } from "next/og";

// Edge builds cleanly on Next 14 for next/og and is the recommended runtime
// (lowest cold-start, no node-only deps used here).
export const runtime = "edge";

// ── Linen Pearl Dark palette (mirrors web/app/globals.css `.dark` tokens) ──
const BG = "#181410"; //  warm near-black background
const SURFACE = "#241E17"; //  warm dark card surface
const TEXT = "#F4EFE7"; //  warm off-white
const MUTED = "#A2937C"; //  warm gray
const TAN = "#CBB291"; //  warm tan accent (--primary)
const TAN_BRIGHT = "#D8C3A0"; //  brighter tan for the big number
const BORDER = "#3A3127"; //  subtle warm border

type Kind = "win" | "pot" | "join";

function content(
  kind: Kind,
  round: string | null,
  amount: string | null,
  pot: string | null,
) {
  // eyebrow = small label, big = the headline number, sub = the line under it
  if (kind === "win") {
    return {
      eyebrow: `WON ROUND ${round ?? "?"}`,
      big: `${amount ?? "?"}`,
      unit: "USDC",
      sub: "principal never moved",
    };
  }
  if (kind === "pot") {
    return {
      eyebrow: "THE GROWING POT",
      big: `${pot ?? "?"}`,
      unit: "USDC",
      sub: "and climbing",
    };
  }
  // join
  return {
    eyebrow: "I JOINED THE STEWFI POOL",
    big: "the interest",
    unit: "is the prize",
    sub: "save USDC · principal stays yours",
  };
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const rawKind = (searchParams.get("kind") ?? "join").toLowerCase();
  const kind: Kind =
    rawKind === "win" || rawKind === "pot" || rawKind === "join"
      ? (rawKind as Kind)
      : "join";
  const round = searchParams.get("round");
  const amount = searchParams.get("amount");
  const pot = searchParams.get("pot");

  const c = content(kind, round, amount, pot);
  // "join" uses a smaller headline (it's words, not a number).
  const bigSize = kind === "join" ? 116 : 168;

  const res = new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          width: "1200px",
          height: "630px",
          backgroundColor: BG,
          // warm pearl halo, top-right — the one allowed glow. Satori's CSS
          // parser is strict on radial-gradient: use the simple
          // `circle at <pos>` form (no two-value size, no negative offset).
          backgroundImage:
            "radial-gradient(circle at 82% 6%, rgba(203,178,145,0.20), rgba(203,178,145,0) 55%)",
          padding: "72px 80px",
          fontFamily: "sans-serif",
        }}
      >
        {/* Header: wordmark */}
        <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: "56px",
              height: "56px",
              borderRadius: "14px",
              backgroundColor: SURFACE,
              border: `1px solid ${BORDER}`,
              fontSize: "30px",
            }}
          >
            🔮
          </div>
          <div
            style={{
              display: "flex",
              fontSize: "40px",
              fontWeight: 700,
              letterSpacing: "-0.01em",
              color: TEXT,
            }}
          >
            Stew<span style={{ color: TAN }}>Fi</span>
          </div>
        </div>

        {/* Body: eyebrow + big number + sub */}
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              display: "flex",
              fontSize: "30px",
              fontWeight: 600,
              letterSpacing: "0.14em",
              color: TAN,
            }}
          >
            {c.eyebrow}
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: "20px",
              marginTop: "18px",
            }}
          >
            <div
              style={{
                display: "flex",
                fontSize: `${bigSize}px`,
                fontWeight: 800,
                letterSpacing: "-0.03em",
                color: TAN_BRIGHT,
                fontVariantNumeric: "tabular-nums",
                lineHeight: 1,
              }}
            >
              {c.big}
            </div>
            <div
              style={{
                display: "flex",
                fontSize: "48px",
                fontWeight: 500,
                color: MUTED,
              }}
            >
              {c.unit}
            </div>
          </div>
          <div
            style={{
              display: "flex",
              marginTop: "24px",
              fontSize: "40px",
              fontWeight: 500,
              color: TEXT,
            }}
          >
            {c.sub}
          </div>
        </div>

        {/* Footer: tagline */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderTop: `1px solid ${BORDER}`,
            paddingTop: "28px",
          }}
        >
          <div style={{ display: "flex", fontSize: "28px", color: MUTED }}>
            A savings account where the interest is the prize.
          </div>
          <div style={{ display: "flex", fontSize: "24px", color: TAN }}>
            on Solana
          </div>
        </div>
      </div>
    ),
    { width: 1200, height: 630 },
  );

  // Cards are deterministic for a given querystring → cache hard at the
  // edge/CDN, with stale-while-revalidate so X's crawler is always fast.
  // `.set()` (not the constructor `headers`) overwrites next/og's default
  // Cache-Control instead of appending a second value.
  res.headers.set(
    "Cache-Control",
    "public, immutable, no-transform, max-age=86400, s-maxage=86400, stale-while-revalidate=604800",
  );
  return res;
}
