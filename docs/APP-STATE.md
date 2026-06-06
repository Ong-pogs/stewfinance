# StewFi — Current State of the App (review doc)

_Snapshot 2026-06-07. Self-contained so another Claude can review cold and propose features. Devnet only; branch `thin-demo`; local, not pushed._

## 1. What it is
StewFi is a **no-loss prize savings** dApp on Solana. You deposit USDC; your principal stays yours and is withdrawable; the pooled **yield** becomes a **weekly prize** drawn to one winner via on-chain VRF. A **Growing Pot** takes 20% of each prize and compounds, so "the prize grows forever." Positioning = "a savings account where the interest is the prize." Audience = small-bag CT degens (anon-X). Banned words in copy: lottery / stake / APY.

**Winner fairness (the core mechanic):** weight = `deposit_amount × (draw_ts − first_deposit_ts)` — **size × time held**. Winner = weighted-random by that, picked **on-chain** from a Switchboard VRF value. No off-chain input can change odds.

## 2. Status — what's real
- **Full loop works LIVE on devnet:** deposit → withdraw (24h cooldown) → **real Switchboard VRF weekly draw → weighted winner → 65/20/10/5 split → claim**. Round 0 settled for real (winner `738qzq7a…`).
- Frontend: Next.js 14 app, premium "Linen Pearl Dark" design, full gamification layer.
- Build clean, 37 unit tests green.

## 3. Architecture
- **On-chain program** (`programs/stewfi/src/lib.rs`, Anchor 0.31): 22 instructions. Program id `8uDmfYPMBaiLLwfZGAnhNaDm48kx19hD8kPdiR7XiRLD` (devnet, full build deployed + on-chain IDL published).
- **Off-chain crank** (`app/crank/`, TS): pot keeper, VRF wrappers, draw orchestrator, scheduler. Slices 1/2a/2b shipped; live draw runs via `scripts/devnet-draw.ts` (Slice-3 auto-scheduler still manual).
- **Web app** (`web/`, Next 14 App Router + Tailwind v3 + wallet-adapter): the demo UI.

## 4. On-chain program (key facts)
- **Accounts:** `PoolConfig` (per-mint PDA: total_principal, sum_amount + sum_amount_first_ts accumulators, current_round, next_draw_ts, pot_principal_usdc, operator/ops, draw_interval=7d, pending_winnings). `UserPosition` (**per-user PDA — NOT per-pool**: amount, first_deposit_ts (sticky), last_deposit_ts, withdraw_requested_at). `Draw` (per-round PDA: status, draw_ts, total_weight, prize_pool, random_value, winner, winner/growing_pot/operator/ops amounts, winner_claimed).
- **Draw lifecycle:** init_draw_accounts → trigger_draw (commit VRF + snapshot prize/total_weight, lock) → settle_draw (reveal VRF + derive winner on-chain over all positions + split) → claim_draw (winner pulls 65%). cancel_draw (1h timeout recovery).
- **Milestones:** M1 init, M2 deposit/withdraw, M3 Kamino yield (mainnet-only), M4 VRF draw + audit fixes (M-01/M-02/L-01/L-02 closed), M5 Growing Pot. `overflow-checks=true`. Admin `set_next_draw_ts` + accepts the devnet Switchboard PID (added for the live devnet draw).

## 5. Frontend
- **Pages:** `/` pitch (landing hero + last-winner spotlight + FAQ + **interactive fairness explainer**), `/app` the product (connected funnel), `/dashboard` funnel analytics, **`/verify`** (provably-fair: VRF value → ticket derivation → winner per round, explorer links), **`/stats`** (TVL + Growing Pot + members tiles + inline-SVG prize-history chart), **`/share`** (OG-unfurl page for shared wins/pot). API: `/api/faucet`, `/api/track`, `/api/leaderboard`, `/api/activity`, **`/api/og`** (branded 1200×630 share image, win/pot/join).
- **Deposit UX:** wallet test-USDC balance + "Max" button; pot-ticker count-up on value change. Draw card escalates to a "draw day" hype/countdown when the draw is ≤6h out.
- **Personal/extras:** badges show **progress bars** (current/target); your-activity has an **odds-projection** chart (honest "assumes pool unchanged"); app is **installable (PWA)** — generated branded icons, manifest, offline app-shell (SW bypasses `/api` so on-chain data stays fresh).
- **`/app` layout (responsive blend):** Pot hero → 2-col core (Your position + Deposit/Withdraw | This-week draw) on desktop, single column on phone → tabbed Leaderboard / Badges / History.
- **Components** (`web/components/`): pot-ticker, this-week (consolidated draw+odds+sim-preview), position-card, deposit-card, withdraw-card, claim-card, share-card (win + pre-deposit X intents), draw-reveal (cauldron animation), leaderboard, badges, draw-history, secondary-tabs (Leaderboard/Badges/History/Activity), devnet-banner, connect-button, **toast** (in-house toasts + explorer links), **skeletons**, **empty-state** (+ retry), **theme-toggle**/**theme-provider** (light/dark), **activity-feed** + **your-activity**. Extra API: `/api/activity` (recent events). `gamify.ts` gained `poolMemberSubset`.
- **Lib** (`web/lib/`): `stewfi.ts` (program client: readPool/readPosition/readDraw/readCurrentDraw/listDraws/readAllPositions/deposit/withdraw/claimDraw — all `.accountsPartial`), `gamify.ts` (computeOdds/weeksHeld/potEstimate/computeStreak/computeBadges, unit-tested), `pdas.ts`, `format.ts`, `draw-utils.ts`, `track.ts`, `supabase.ts`, `constants.ts`, `idl.ts`.

## 6. Design system — "Linen Pearl Dark"
Ported from the marketing landing (`/Project/stewfinance-landing`). Warm near-black surfaces, warm-brown/tan accents (OKLCH tokens in `web/app/globals.css`), Geist Sans/Mono + tabular-nums on all numbers, 8px radius, subtle borders, one pearl halo on the pot hero, purposeful motion only (reveal/odometer/pot-rise) with `prefers-reduced-motion` guard. No magenta-purple, no glow spam. Spec: `docs/superpowers/specs/2026-06-04-ui-redesign-design.md`.

## 7. ⚠️ What's REAL vs SYNTHETIC on devnet (honesty)
- **Real:** deposits, withdrawals, the VRF draw + winner selection + prize split + claim, weight/odds math, all the on-chain reads the UI shows.
- **Synthetic / caveats:**
  - **Prize/yield is synthetic** — devnet has no Kamino, so the prize is test-USDC minted into the vault, not real yield. Labelled "estimate/illustration."
  - **Operator = admin** (`id.json`) on devnet; no separate operator custody.
  - **Leaderboard** — `UserPosition` is per-user (not per-pool), so `readAllPositions()` returns global positions incl. smoke-test strays. **Now filtered (2026-06-07)** via `poolMemberSubset` (reconciles to `total_principal`) → shows only this pool's real members, with a graceful fallback + honest footer if it can't reconcile. (The per-user-not-per-pool design remains; a fresh launch pool or pool-scoped UserPosition is the long-term fix.)
  - **Faucet SOL** — **hardened (2026-06-07)**: funds users' SOL via transfer from the faucet authority (not the flaky airdrop); authority topped to ~1.1 SOL (top up again before a 15-20 probe).
  - **Auto-scheduler** not wired — draws fire via a manual operator script, not a cron.
  - **Pre-mainnet gates (untouched):** external audit (Sec3 ~$25-40K), legal/geoblock, real Kamino yield wiring, real-money go-live. These are deliberately out of scope on devnet.

## 8. Known gaps / limitations (review targets)
- ✅ **Closed 2026-06-07:** tx toasts + loading skeletons + on-theme empty/error+retry states; light/dark toggle; your-activity + recent-activity feed; leaderboard pollution filtered; faucet-SOL hardened.
- Referral = tracking only (no real on-chain odds-boost — that needs a contract change to be honest).
- No per-round participation history (chain stores only the winner) → "draws you were in" not reconstructable on-chain (your-activity shows wins + position only, honestly captioned).
- Connect flow is the stock wallet-adapter modal (themed but basic).
- No persistent dev server from Claude's side (process reaping) — run locally to view.
- Auto-scheduler still manual (Task 11); pre-mainnet gates (audit/legal/Kamino/real-money) untouched.

## 9. File map (start here)
- On-chain: `programs/stewfi/src/lib.rs`
- Crank: `app/crank/{index,run,vrf,positions,constants,pdas}.ts`
- Scripts: `scripts/{devnet-bootstrap,devnet-draw-setup,devnet-draw,devnet-smoke,devnet-draw-diag}.ts`
- Web: `web/app/{page,app/page,dashboard/page}.tsx`, `web/components/*`, `web/lib/*`, `web/app/globals.css`
- Docs: `docs/superpowers/specs/*` (designs), `docs/superpowers/plans/*` (build plans), this file.

## 10. How to run
```
cd /Users/ongeeshen/Project/stewfinance/web && npm run build && PORT=3007 npm run start
# → http://localhost:3007  (/, /app, /dashboard).  Phantom set to Devnet.
# Faucet button mints test-USDC; deposit is a real signed devnet tx.
cd /Users/ongeeshen/Project/stewfinance/web && npx vitest run   # 37 tests
```
Run a live draw: re-arm `scripts/devnet-draw-setup.ts` then `scripts/devnet-draw.ts` (see those files' headers).

## 11. Candidate features to consider (menu — pick what to build)
_(✅ shipped 2026-06-07: toasts+skeletons; light/dark toggle; recent-activity + your-activity; leaderboard filter; faucet hardening; deposit balance+Max; pot count-up; **/verify provably-fair page**; **/stats page + prize chart**; draw-day hype state; pitch winner spotlight.)_
_(✅ also 2026-06-07: FAQ; OG share image + /share unfurl; interactive explainer; badge progress bars; odds-projection chart; PWA/installable.)_
**UX / polish:** richer themed connect modal; in-app "?" tooltips; full keyboard/a11y pass.
**Engagement / retention:** streak reminders/notifications; deeper personal stats history.
**Social / viral:** referral dashboard polish; embeddable pot widget; winner-spotlight carousel.
**Infra / launch:** auto-scheduler (cron draws); Supabase wiring + Vercel deploy; fresh launch pool; _(contract)_ pool-scoped UserPosition; _(contract)_ real referral odds-boost.

## 12. Strategic context (the part features don't fix)
The engine + UI are strong and proven, but **demand is unvalidated — zero real users have touched it.** The open gates that no feature closes: **distribution** (who are the first 15-20 + what channel — warm channels were dropped, audience is anon-X but no list), cold-start (Pool Party shipped this exact product and died ~$31K TVL), legal posture (pre-mainnet), and a security audit before real money. The highest-leverage next move remains a demand probe; features improve the probe's conversion but don't replace it. Decisions log: `stewfinance-hq/startup/decisions.md`; open questions: `…/open-questions.md`.
