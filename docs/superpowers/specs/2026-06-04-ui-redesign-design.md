# StewFi Web App — UI/UX Redesign (Linen Pearl Dark)

## Context
The StewFi devnet web app (`web/`) grew organically (thin demo → draw layer → gamification) into a generic **dark zinc + bright magenta-purple** theme with **cauldron-glow everywhere** and a **13-card vertical stack** on `/app`, with three cards (DrawCard, TicketsViz, SimulatedDraw) all answering "what's the draw / my odds." Meanwhile the marketing **landing page** (`/Users/ongeeshen/Project/stewfinance-landing`) has a deliberate, premium **"Linen Pearl"** design system (warm paper, warm-brown type, Geist fonts, restraint — "the only calm page in their feed"). The founder wants the app to (a) adopt the landing's palette and (b) be genuinely better-designed.

**Decisions (founder, brainstormed 2026-06-04, mockups in `stewfinance-hq/mockups/01-03`):**
1. **Theme = Linen Pearl _Dark_** (the landing's derived dark mode — warm near-black + warm-brown accents). Drops magenta-purple + the constant glow.
2. **Layout = responsive "blend"** — dashboard on desktop (≥768px), focused single column on phone (<768px). One component set, breakpoint-driven.
3. **Dark-only** for now (tokens support a light toggle later).

**Constraints (non-negotiable):**
- **Pure restyle + restructure. ZERO contract/program changes, ZERO on-chain logic changes.** Only `web/` presentation + component composition.
- **Honesty preserved**: nothing claims to change odds; referral disclaimer stays; pot tail cosmetic+labelled. **Banned words** (lottery/stake/APY) stay out of user copy.
- Everything on branch `thin-demo`, local commits, no push, no `Co-Authored-By`.

## Design tokens — Linen Pearl Dark
Port the landing's **dark-mode** tokens verbatim. Source of truth: `/Users/ongeeshen/Project/stewfinance-landing/app/globals.css` (OKLCH custom properties) + `layout.tsx` (Geist fonts via `next/font/google`) + `brand.md` (philosophy). Implementer should READ those and copy the dark `:root`/`.dark` values. Key values:

```css
/* web/app/globals.css — replace the --stew/zinc theme with: */
--background: oklch(0.13 0.015 70);     /* warm near-black  ~#181410 */
--foreground: oklch(0.97 0.01 70);      /* warm off-white   ~#F4EFE7 */
--card: oklch(0.18 0.02 70);            /* warm dark surface ~#241E17 */
--card-foreground: oklch(0.97 0.01 70);
--primary: oklch(0.74 0.05 50);         /* warm tan accent  ~#CBB291 */
--primary-foreground: oklch(0.10 0 0);  /* near-black on tan */
--secondary: oklch(0.22 0.03 70);       /* ~#2e2920 */
--muted: oklch(0.20 0.02 70);
--muted-foreground: oklch(0.67 0.02 70);/* warm gray text   ~#A2937C */
--accent-warm: oklch(0.82 0.06 60);     /* brighter tan for big numbers ~#D8C3A0 */
--border: oklch(0.26 0.025 70);         /* ~#383026 */
--input: oklch(0.18 0.02 70);
--ring: oklch(0.74 0.05 50);
--radius: 0.5rem;                        /* 8px base; sm/md/lg/xl scale per landing */
--destructive: oklch(0.55 0.22 25);     /* errors */
/* gradients (hero/CTA only): */
--gradient-primary: linear-gradient(135deg,#6B5A47,#5A4838,#4D3D2E);
--gradient-halo: conic-gradient(from 0deg,#4a3a28,#5a452f,#553f2c,#4a3a28); /* dark pearl, screen-blend */
--gradient-text: linear-gradient(90deg,#CBB291,#D8C3A0);
```
- **Typography:** add Geist Sans + Geist Mono via `next/font/google` in `web/app/layout.tsx` (mirror the landing). `font-variant-numeric: tabular-nums` on ALL numeric displays (amounts, countdowns, odds, addresses). Type scale: display (pot) ~34–40px mono; section labels 11px uppercase tracked; body 14px; caption 12px. Map Tailwind theme colors to the CSS vars (replace the current zinc/purple usage app-wide).
- **Motion:** keep purposeful only — number odometer roll, draw-reveal burst/brew, pot-rise. Remove `.cauldron-glow` from general cards; the **one** pearl halo lives on the pot hero. Keep the `prefers-reduced-motion` guard.
- **Borders/shadows:** ultra-subtle 1px `--border`; no heavy glows. Elevation via surface color + border, like the landing.

## Layout — responsive blend (`web/app/app/page.tsx`)
Connected view, in DOM order; CSS grid/flex reflows at `md`:
1. **Top bar**: StewFi wordmark (gradient-text) + themed wallet pill.
2. **Pot hero** (full width): the one big mono number (`--accent-warm`), "and climbing — the interest is the prize", single pearl halo, a thin divider, "Next draw in D:HH:MM:SS" (live).
3. **Core row** — `md:grid-cols-2`, stacks on phone:
   - **Your position**: balance (mono), inline odds %, primary **Deposit** (filled tan) + secondary **Withdraw** (ghost). Pre-deposit share surfaces here after a confirmed deposit.
   - **This week's draw** (consolidates DrawCard + TicketsViz + SimulatedDraw): status chip (brewing/settled), prize, your odds %, weight bar; a small "preview a draw" toggle (the old SimulatedDraw simulation) as a secondary affordance, not its own card. When settled & you won → claim + win-share surface here; draw-reveal animation plays here.
4. **Secondary tabs** (one panel replacing 3 stacked cards): **Leaderboard / Badges / History**. Leaderboard goes 2-col on desktop.

Empty/disconnected state: a proper hero with the pitch line + a prominent Connect, not a bare sentence.

## Component map (rename/compose, no logic change)
- `pot-ticker.tsx` → hero treatment (warm, single halo, biggest number).
- **NEW `this-week.tsx`** (or restyle `draw-card.tsx` to absorb): merges DrawCard + TicketsViz live-odds + SimulatedDraw preview. Keep all three components' *logic* (import `computeOdds`, the draw reads, the sim toggle) — just present as one card. Old `tickets-viz.tsx`/`simulated-draw.tsx` may be reduced to internal pieces of this-week or deleted if fully absorbed.
- `position-card.tsx` + `deposit-card.tsx` + `withdraw-card.tsx` → "Your position" zone with proper button hierarchy.
- **NEW `secondary-tabs.tsx`**: tabbed wrapper hosting `leaderboard.tsx`, `badges.tsx`, `draw-history.tsx` (restyled to tokens; history must not horizontal-scroll on mobile — stack/condense).
- `claim-card.tsx` + `share-card.tsx` + `draw-reveal.tsx` → restyle warm; surface within the draw zone contextually.
- `devnet-banner.tsx` → subtle warm strip (not brand/primary color), clearly a notice.
- `connect-button.tsx` → theme the wallet-adapter button to match (CSS override for `.wallet-adapter-button`).
- All `globals.css` keyframes retained but recolored warm.

## Pitch page (`web/app/page.tsx`) + dashboard (`web/app/dashboard/page.tsx`)
- Pitch: restyle to match the landing's hero closely (gradient-text wordmark, pearl halo, the 3-step "how it works" as warm cards, primary CTA → `/app`). Reuse landing copy patterns; keep banned-words clean.
- Dashboard: restyle the funnel table to tokens (tabular-nums, subtle borders). No logic change.

## Scope / non-goals
- No new features, no contract/IDL changes, no new tracking events. Pure visual + structural.
- Dark-only (no light toggle this pass).
- Keep all existing on-chain reads, gamify.ts logic, honesty microcopy, referral tracking intact.

## Verification
- `cd web && npm run build` clean; `cd web && npx vitest run` still green (37 — logic untouched).
- Manual: `PORT=3007 npm run start`, view `/`, `/app`, `/dashboard` at desktop AND phone widths (DevTools responsive) — confirm: pot is clearly hero; only ONE draw/odds card; secondary content is tabbed; warm palette throughout, no magenta-purple, no glow spam; buttons have clear primary/secondary; numbers are mono tabular; no mobile horizontal scroll; connect button themed; reduced-motion respected.
- Honesty audit: `grep -riE "lottery|stake|APY" web/components web/app` → only dev comments; referral odds-disclaimer still present.
