/**
 * /manifest.webmanifest — PWA manifest (Next 14 metadata route).
 *
 * Makes StewFi installable (Add to Home Screen / desktop install) and sets the
 * standalone app-window chrome. Icons point at the generated icon routes
 * (app/icon, app/icons/[size]) so there are no static PNGs to maintain.
 *
 * Copy keeps the banned words (lottery / stake / APY) OUT.
 */
import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "StewFi — save USDC, the interest is the prize",
    short_name: "StewFi",
    description:
      "A savings account where the interest is the prize. Your principal stays yours; the pooled interest becomes a weekly prize. Devnet demo.",
    // Installs open straight into the product, not the marketing landing.
    start_url: "/app",
    display: "standalone",
    theme_color: "#181410",
    background_color: "#181410",
    icons: [
      // Browser/tab + general-purpose mark (full-bleed, generated at /icon).
      {
        src: "/icon",
        sizes: "48x48",
        type: "image/png",
        purpose: "any",
      },
      // Maskable variants for Android/Chromium adaptive icons (safe-zone padded).
      {
        src: "/icons/192",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icons/512",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
      // Plain "any" at install sizes so platforms without maskable support
      // still get a high-res icon.
      {
        src: "/icons/192",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/512",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
    ],
  };
}
