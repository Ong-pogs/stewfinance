import type { Metadata } from "next";
// Geist Sans + Geist Mono — same typeface + same CSS var names
// (--font-geist-sans / --font-geist-mono) the landing wires via
// next/font/google. The app is on Next 14 (no Geist in next/font yet), so
// we source the identical fonts from the official `geist` package.
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";
import { Providers } from "@/components/providers";
import { DevnetBanner } from "@/components/devnet-banner";

export const metadata: Metadata = {
  title: "StewFi — save USDC, the interest is the prize",
  description: "A savings account where the interest is the prize. Devnet demo.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${GeistSans.variable} ${GeistMono.variable}`}
    >
      <body className="min-h-screen bg-background text-foreground font-sans antialiased">
        <Providers>
          <DevnetBanner />
          {children}
        </Providers>
      </body>
    </html>
  );
}
