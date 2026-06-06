import type { Config } from "tailwindcss";

/**
 * Wired to the Linen Pearl CSS vars in app/globals.css (light `:root` + `.dark`).
 * Mirrors the landing's `@theme inline { --color-x: var(--x) }` mapping
 * (stewfinance-landing/app/globals.css lines 80-106) — in Tailwind v3 the
 * equivalent is referencing the raw `var(--x)` (vars already hold full
 * `oklch(...)` values, so no `oklch(var(--x))` channel wrapping is needed).
 */
const config: Config = {
  // next-themes (attribute="class") toggles `.dark` on <html>; opt into
  // class-based dark variants so `dark:` utilities (e.g. the hero halo blend)
  // follow the chosen theme instead of the OS `prefers-color-scheme`.
  darkMode: "class",
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        card: {
          DEFAULT: "var(--card)",
          foreground: "var(--card-foreground)",
        },
        popover: {
          DEFAULT: "var(--popover)",
          foreground: "var(--popover-foreground)",
        },
        primary: {
          DEFAULT: "var(--primary)",
          foreground: "var(--primary-foreground)",
        },
        secondary: {
          DEFAULT: "var(--secondary)",
          foreground: "var(--secondary-foreground)",
        },
        muted: {
          DEFAULT: "var(--muted)",
          foreground: "var(--muted-foreground)",
        },
        accent: {
          DEFAULT: "var(--accent)",
          foreground: "var(--accent-foreground)",
          warm: "var(--accent-warm)",
        },
        destructive: {
          DEFAULT: "var(--destructive)",
          foreground: "var(--destructive-foreground)",
        },
        border: "var(--border)",
        input: "var(--input)",
        ring: "var(--ring)",
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontFamily: {
        sans: ["var(--font-geist-sans)", "system-ui", "-apple-system", "sans-serif"],
        mono: ["var(--font-geist-mono)", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};
export default config;
