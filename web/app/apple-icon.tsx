/**
 * /apple-icon — generated iOS home-screen icon (Next 14 metadata convention).
 *
 * Dep-free `next/og` render (same engine as /api/og), 180×180 per Apple's
 * touch-icon spec. Pure presentation — no chain reads, no logic. iOS does NOT
 * apply maskable safe-area padding, so this is the full-bleed branded tile
 * (the manifest 192/512 maskable variants live in /icons/[size]).
 *
 * Mark: a tan "S" on a warm near-black tile with a subtle pearl halo
 * ("Linen Pearl Dark"), matching the OG card and favicon.
 */
import { ImageResponse } from "next/og";

export const runtime = "edge";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

// ── Linen Pearl Dark palette (mirrors globals.css `.dark` tokens) ──
const BG = "#181410"; // warm near-black background
const TAN = "#CBB291"; // warm tan accent (--primary)

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: "100%",
          height: "100%",
          backgroundColor: BG,
          // the one allowed pearl halo, top-right (matches the OG card).
          backgroundImage:
            "radial-gradient(circle at 78% 12%, rgba(203,178,145,0.22), rgba(203,178,145,0) 60%)",
          color: TAN,
          fontSize: "120px",
          fontWeight: 800,
          fontFamily: "sans-serif",
          letterSpacing: "-0.03em",
        }}
      >
        S
      </div>
    ),
    { ...size },
  );
}
