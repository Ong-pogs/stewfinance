import type { Metadata, Viewport } from "next";
// Geist Sans + Geist Mono — same typeface + same CSS var names
// (--font-geist-sans / --font-geist-mono) the landing wires via
// next/font/google. The app is on Next 14 (no Geist in next/font yet), so
// we source the identical fonts from the official `geist` package.
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";
import { Providers } from "@/components/providers";
import { DevnetBanner } from "@/components/devnet-banner";
import { RegisterSW } from "@/components/register-sw";

export const metadata: Metadata = {
  title: "StewFi — save USDC, the interest is the prize",
  description: "A savings account where the interest is the prize. Devnet demo.",
  // Next auto-links app/manifest.ts, but declaring it keeps the <link> explicit
  // and lets us add the PWA / iOS-install metadata in one place.
  manifest: "/manifest.webmanifest",
  // iOS standalone (Add to Home Screen) chrome: dark status bar that blends
  // into the warm near-black background, title under the icon.
  appleWebApp: {
    capable: true,
    title: "StewFi",
    statusBarStyle: "black-translucent",
  },
};

// In Next 14, theme-color belongs on the `viewport` export (not `metadata`).
// Matches the Linen Pearl Dark background so installed/standalone chrome blends.
export const viewport: Viewport = {
  themeColor: "#181410",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      // next-themes sets the theme class on <html> before hydration; suppress
      // the resulting server/client className mismatch warning (no FOUC).
      suppressHydrationWarning
      className={`${GeistSans.variable} ${GeistMono.variable}`}
    >
      <body className="min-h-screen bg-background text-foreground font-sans antialiased">
        <Providers>
          <DevnetBanner />
          {children}
          <RegisterSW />
        </Providers>
      </body>
    </html>
  );
}
