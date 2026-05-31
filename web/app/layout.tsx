import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "@/components/providers";
import { DevnetBanner } from "@/components/devnet-banner";

export const metadata: Metadata = {
  title: "StewFi — save USDC, the interest is the prize",
  description: "A savings account where the interest is the prize. Devnet demo.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-zinc-950 text-zinc-100 antialiased">
        <Providers>
          <DevnetBanner />
          {children}
        </Providers>
      </body>
    </html>
  );
}
