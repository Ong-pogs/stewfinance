/**
 * /icons/192  /icons/512 — generated MASKABLE app icons for the PWA manifest.
 *
 * Dep-free `next/og` render (same engine as /api/og). Maskable means the
 * platform may crop this to a circle/squircle, so the mark sits inside a
 * central "safe zone" (~62% of the canvas) with full-bleed warm-dark padding
 * around it — nothing important reaches the edges. Pure presentation: no chain
 * reads, no logic. The manifest (app/manifest.ts) points its icons here.
 *
 * Only 192 and 512 are served; any other size 404s.
 */
import { ImageResponse } from "next/og";

export const runtime = "edge";

// ── Linen Pearl Dark palette (mirrors globals.css `.dark` tokens) ──
const BG = "#181410"; // warm near-black background
const TAN = "#CBB291"; // warm tan accent (--primary)

const ALLOWED = new Set([192, 512]);

export function GET(
  _req: Request,
  { params }: { params: { size: string } },
) {
  const n = Number.parseInt(params.size, 10);
  if (!ALLOWED.has(n)) {
    return new Response("Not found", { status: 404 });
  }

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
          // subtle pearl halo, kept loose so masking can't clip a hard edge.
          backgroundImage:
            "radial-gradient(circle at 78% 14%, rgba(203,178,145,0.20), rgba(203,178,145,0) 62%)",
          color: TAN,
          // mark sized to ~46% of canvas → comfortably inside the maskable
          // safe zone (centred, ample padding on every side).
          fontSize: `${Math.round(n * 0.46)}px`,
          fontWeight: 800,
          fontFamily: "sans-serif",
          letterSpacing: "-0.03em",
        }}
      >
        S
      </div>
    ),
    { width: n, height: n },
  );
}
