# StewFi UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Restyle + restructure the StewFi devnet web app (`web/`) to the landing page's "Linen Pearl Dark" palette with a responsive dashboard/column layout — pure presentation, zero on-chain/logic changes.

**Architecture:** Port the landing's dark-mode design tokens (`/Users/ongeeshen/Project/stewfinance-landing`) into `web/app/globals.css` + Geist fonts, then restructure `/app` into a responsive blend (dashboard ≥768px, focused column <768px) that consolidates the 3 redundant draw cards into one and tucks secondary content behind tabs. All existing data reads, `gamify.ts` logic, honesty microcopy, and tracking stay intact.

**Tech Stack:** Next.js 14 App Router, Tailwind, `next/font/google` (Geist), OKLCH CSS vars, vitest.

**Spec:** `docs/superpowers/specs/2026-06-04-ui-redesign-design.md`

**Constraints (every task):** No contract/IDL/logic changes. Keep honesty microcopy + banned-words (lottery/stake/APY) out of user copy. Branch `thin-demo`, local commits, no push, no `Co-Authored-By`. After each task: `cd web && npm run build` clean AND `npx vitest run` green (37 passing — logic untouched).

---

### Task 1: Design tokens + Geist fonts + Tailwind mapping (foundation)

**Files:**
- Read (reference): `/Users/ongeeshen/Project/stewfinance-landing/app/globals.css`, `/Users/ongeeshen/Project/stewfinance-landing/app/layout.tsx`, `/Users/ongeeshen/Project/stewfinance-landing/brand.md`
- Modify: `web/app/globals.css`, `web/tailwind.config.ts`, `web/app/layout.tsx`

- [ ] **Step 1:** Read the three landing reference files to copy the EXACT dark-mode OKLCH token values + the `next/font/google` Geist setup.
- [ ] **Step 2:** In `web/app/globals.css`, replace the current `--stew`/zinc theme + `:root`/dark vars with the Linen Pearl Dark tokens from the spec (`--background` `oklch(0.13 0.015 70)`, `--foreground` `oklch(0.97 0.01 70)`, `--card` `oklch(0.18 0.02 70)`, `--primary` `oklch(0.74 0.05 50)`, `--primary-foreground` `oklch(0.10 0 0)`, `--muted-foreground` `oklch(0.67 0.02 70)`, `--border` `oklch(0.26 0.025 70)`, `--accent-warm` `oklch(0.82 0.06 60)`, `--radius 0.5rem`, `--destructive` `oklch(0.55 0.22 25)`, plus `--gradient-primary`/`--gradient-halo`/`--gradient-text` per spec). Set `body` bg=`--background` fg=`--foreground`.
- [ ] **Step 3:** Recolor the existing keyframes (`cauldron-bubble`, `reveal-burst`, `pot-rise`, `odometer-roll`) from purple to warm (use `--primary`/`--accent-warm` glow at low intensity). Keep the `@media (prefers-reduced-motion: reduce)` guard. Replace `.cauldron-glow` (purple box-shadow) with a subtle warm version `--glow-warm` used ONLY by the pot hero + reveal; remove it from generic card usage in later tasks.
- [ ] **Step 4:** In `web/tailwind.config.ts`, extend `theme.colors` to reference the CSS vars: `background`, `foreground`, `card`, `primary`, `primary-foreground`, `muted`, `muted-foreground`, `border`, `accent-warm`, `destructive` (e.g. `card: "oklch(var(--card))"` pattern OR plain `"var(--card)"` — match how the landing wires Tailwind to its vars; read landing tailwind config). Add `borderRadius` lg/md/sm from `--radius`. Add `fontFamily.sans`/`mono` → the Geist CSS vars.
- [ ] **Step 5:** In `web/app/layout.tsx`, import `GeistSans`/`GeistMono` (or `Geist`, `Geist_Mono` from `next/font/google` exactly as the landing does), apply the font CSS vars to `<html>`/`<body>`, set the base sans font, and a global `tabular-nums` utility convention for `.font-mono`.
- [ ] **Step 6:** `cd web && npm run build` (clean) and `npx vitest run` (37 green). Visual sanity: app is now warm-dark, no magenta.
- [ ] **Step 7:** Commit: `git add web/app/globals.css web/tailwind.config.ts web/app/layout.tsx && git commit -m "feat(ui): Linen Pearl Dark tokens + Geist fonts"`

---

### Task 2: `/app` responsive blend layout + secondary tabs shell

**Files:**
- Create: `web/components/secondary-tabs.tsx`
- Modify: `web/app/app/page.tsx`

- [ ] **Step 1:** Create `web/components/secondary-tabs.tsx` — a client component with 3 tabs (Leaderboard / Badges / History) and `useState` active tab; renders the passed children panels (`<Leaderboard/>`, `<Badges/>`, `<DrawHistory/>`) one at a time. Tabs styled to tokens (active = `bg-primary text-primary-foreground`, inactive = bordered muted). On desktop the active panel may use its own internal 2-col.
- [ ] **Step 2:** Restructure the connected view in `web/app/app/page.tsx` into the responsive blend (keep ALL existing state + `refresh()` data fetching unchanged): (1) top bar — wordmark (gradient-text) + `<ConnectButton/>`; (2) Pot hero full-width (`<PotTicker/>` + a "Next draw" countdown line); (3) core row `grid gap-4 md:grid-cols-2` — left = position zone (`<PositionCard/>` + deposit/withdraw + pre-deposit share), right = draw slot (for now render the existing `<DrawCard/>` + `<ClaimCard/>` + `<DrawReveal/>` + win-share here; consolidation is Task 3); (4) `<SecondaryTabs>` hosting Leaderboard/Badges/DrawHistory. Remove the old flat `space-y-5` stack of those 3 secondary cards (now in tabs).
- [ ] **Step 3:** `cd web && npm run build` clean + `npx vitest run` green. Visual: pot is hero, two-column core on desktop, single column on phone, secondary in tabs.
- [ ] **Step 4:** Commit: `git add web/components/secondary-tabs.tsx web/app/app/page.tsx && git commit -m "feat(ui): responsive blend layout + secondary tabs on /app"`

---

### Task 3: Consolidate the 3 draw/odds cards into one "This week's draw"

**Files:**
- Create: `web/components/this-week.tsx`
- Modify: `web/app/app/page.tsx`
- (Reduce/absorb) `web/components/tickets-viz.tsx`, `web/components/simulated-draw.tsx`

- [ ] **Step 1:** Create `web/components/this-week.tsx` merging the *logic* of DrawCard (status/prize/countdown from the live Draw), TicketsViz (live odds via `computeOdds` from `lib/gamify.ts`), and SimulatedDraw (the "preview a draw" simulation). One card: status chip (brewing/settled), prize, your-odds % + weight bar, and a small secondary "Preview a draw" toggle that reveals the simulation result inline (not its own card). Import the same data the three used; do NOT change `computeOdds` or any draw read. Keep the honesty caption ("odds = size × time held, on-chain").
- [ ] **Step 2:** In `web/app/app/page.tsx`, replace the draw-slot's `DrawCard` + `TicketsViz` + `SimulatedDraw` with `<ThisWeek ...props/>` (pass the already-loaded pool/draw/position BNs). Keep `ClaimCard`/`DrawReveal`/win-share in/near the draw slot.
- [ ] **Step 3:** Delete `tickets-viz.tsx` and `simulated-draw.tsx` IF fully absorbed (and remove their imports), OR keep as internal sub-pieces imported only by `this-week.tsx`. Ensure no dangling imports.
- [ ] **Step 4:** `cd web && npm run build` clean + `npx vitest run` green (the `gamify.test.ts` regression-lock for `computeOdds` must still pass — proves the odds logic is unchanged).
- [ ] **Step 5:** Commit: `git add -A web/components web/app/app/page.tsx && git commit -m "feat(ui): consolidate draw + odds + preview into one This Week card"`

---

### Task 4: Component restyle pass (tokens, button hierarchy, mobile)

**Files (modify):** `web/components/pot-ticker.tsx`, `position-card.tsx`, `deposit-card.tsx`, `withdraw-card.tsx`, `claim-card.tsx`, `share-card.tsx`, `draw-reveal.tsx`, `leaderboard.tsx`, `badges.tsx`, `draw-history.tsx`, `devnet-banner.tsx`, `connect-button.tsx`, `this-week.tsx`; `web/app/globals.css` (wallet-adapter override)

- [ ] **Step 1:** Restyle every component above from the old zinc/purple/glow classes to the new tokens: surfaces `bg-card border-border`, text `text-foreground`/`text-muted-foreground`, numbers `font-mono tabular-nums`, accents `text-[--accent-warm]`/`text-primary`. Button hierarchy: **primary** = `bg-primary text-primary-foreground` (Deposit, Claim), **secondary** = ghost bordered (Withdraw, Preview), no two same-weight buttons competing. `pot-ticker` = hero treatment (biggest number, single warm halo). Remove `.cauldron-glow` from all except pot hero + draw-reveal.
- [ ] **Step 2:** `draw-history.tsx`: make it NOT horizontally scroll on mobile — drop low-value columns on small screens (`hidden sm:table-cell`) or switch to a stacked list under `sm`. Keep tabular-nums.
- [ ] **Step 3:** `devnet-banner.tsx`: subtle warm notice strip (`bg-secondary text-muted-foreground border-b border-border`), not primary-colored. `connect-button.tsx`: add a `globals.css` override for `.wallet-adapter-button` to match token button styling (bg, radius, font).
- [ ] **Step 4:** `cd web && npm run build` clean + `npx vitest run` green.
- [ ] **Step 5:** Commit: `git add -A web && git commit -m "feat(ui): restyle all components to Linen Pearl tokens + button hierarchy + mobile history"`

---

### Task 5: Pitch page, dashboard, disconnected state

**Files (modify):** `web/app/page.tsx` (pitch), `web/app/dashboard/page.tsx`, `web/app/app/page.tsx` (disconnected branch)

- [ ] **Step 1:** Restyle `web/app/page.tsx` to mirror the landing hero: gradient-text "StewFi" wordmark, a single pearl halo, the headline ("A savings account where the interest is the prize"), the 3-step "how it works" as warm `bg-card` cards, primary CTA → `/app`. Reuse landing copy tone; keep banned-words clean.
- [ ] **Step 2:** Restyle `web/app/dashboard/page.tsx` funnel table to tokens (subtle borders, `font-mono tabular-nums`, warm header). No logic change.
- [ ] **Step 3:** Replace the bare disconnected `/app` line (`Connect a wallet to try a deposit.`) with a proper hero: the pitch line + the live Growing-Pot number (read pool even when disconnected if cheap, else a static teaser) + a prominent themed Connect.
- [ ] **Step 4:** `cd web && npm run build` clean + `npx vitest run` green.
- [ ] **Step 5:** Commit: `git add -A web/app && git commit -m "feat(ui): restyle pitch + dashboard + /app disconnected hero"`

---

### Task 6: Responsive QA + honesty audit + final polish

**Files:** any of the above as needed.

- [ ] **Step 1:** `cd web && npm run build` (clean) + `npx vitest run` (37 green).
- [ ] **Step 2:** Responsive check (reason through / DevTools): at ≥768px the core row is 2-col + leaderboard 2-col; at <768px everything stacks; no horizontal scroll anywhere (esp. history); pot is unmistakably the hero; exactly ONE draw/odds card; secondary content is tabbed. Fix any breakpoint issues.
- [ ] **Step 3:** Verify `prefers-reduced-motion` disables transforms; verify no magenta-purple remains (`grep -rn "purple\|--stew\|zinc-" web/components web/app | grep -v "node_modules"` → expect near-zero; convert stragglers).
- [ ] **Step 4:** Honesty audit: `grep -riE "lottery|stake|APY" web/components web/app` → only dev comments; confirm the referral odds-disclaimer is still rendered.
- [ ] **Step 5:** Commit any fixes: `git add -A web && git commit -m "fix(ui): responsive + theme cleanup + honesty audit"`

---

## Self-Review notes
- **Spec coverage:** tokens+fonts (T1), responsive blend+tabs (T2), draw consolidation (T3), full component restyle incl devnet-banner/connect/history-mobile (T4), pitch+dashboard+disconnected (T5), QA+honesty+responsive (T6) — all spec sections mapped.
- **No logic change:** every task keeps `computeOdds`/draw reads/tracking; `gamify.test.ts` + `draw-utils.test.ts` are the regression guard (must stay 37 green each task).
- **Honesty:** disclaimer + banned-word audit in T3 (caption) + T6.
