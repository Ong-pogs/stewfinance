/**
 * /icon — generated browser/tab favicon (Next 14 metadata icon convention).
 *
 * Dep-free: rendered with `next/og` `ImageResponse` (same engine as /api/og)
 * so there are no static PNG assets to maintain and the mark stays on-brand.
 * Pure presentation — no chain reads, no logic.
 *
 * Mark: a tan "S" on a warm near-black rounded tile ("Linen Pearl Dark").
 * 48px is large enough that browsers can downscale crisply for the tab.
 */
import { ImageResponse } from "next/og";

export const runtime = "edge";

// Browsers request this at a few sizes; one source at 48 downscales cleanly.
export const size = { width: 48, height: 48 };
export const contentType = "image/png";

// ── Linen Pearl Dark palette (mirrors globals.css `.dark` tokens) ──
const BG = "#181410"; // warm near-black background
const TAN = "#CBB291"; // warm tan accent (--primary)

export default function Icon() {
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
          borderRadius: "10px",
          color: TAN,
          fontSize: "34px",
          fontWeight: 800,
          fontFamily: "sans-serif",
          letterSpacing: "-0.02em",
        }}
      >
        S
      </div>
    ),
    { ...size },
  );
}
