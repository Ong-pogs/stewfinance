# StewFi Thin Demo — Design Spec

**Date:** 2026-05-30
**Status:** Approved (founder), pre-implementation
**Owner:** founder + advisor team (Tech/Product/Risk lenses)

## 1. Purpose (the only goal)

A **demand probe**, not a product launch. Put a clickable StewFi in front of 15-20 real people in warm channels and **measure whether anyone actually tries to deposit.** The instrumented funnel — `visit → connect wallet → faucet → real devnet deposit` — and its drop-off rates ARE the deliverable. The founder bypassed Phase-1 validation; this manufactures the demand evidence that was skipped, cheaply, before sinking weeks into live VRF (crank Slice 3) or a $25-40K audit.

**Go/no-go gate:** do any of the 15-20 connect a wallet and sign a deposit. Green → conviction to wire Slice 3 + audit + mainnet. Red → we learned it before spending the runway.

**Explicit non-goal:** proving the yield/lottery mechanic (already proven on surfpool fork), launching to mainnet, handling real money.

## 2. Honest signal ceiling (Risk lens — recorded, not waved away)

A **devnet** deposit uses faucet (fake) USDC. It proves "willing to connect a wallet and sign the deposit motion + the pitch resonates" — it does **not** prove "willing to risk real USDC." That is the structural ceiling of a free probe. A green result must not be over-read as proven real-money demand; it is necessary-but-not-sufficient. Cold-start economics (Pool Party died ~$31K TVL) remain untested by this demo. We accept this ceiling because the alternative (mainnet, real money) requires audit + live VRF + months, defeating the "cheap probe" purpose.

## 3. Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Vercel (shareable https URL)                            │
│  ┌──────────────┐   ┌──────────────────────────────┐    │
│  │  /  pitch     │   │  /app  deposit flow          │    │
│  │  (landing)    │   │  connect→faucet→deposit→pos  │    │
│  └──────────────┘   └──────────────────────────────┘    │
│        │                      │            │             │
│        │ /api/track           │ /api/faucet│             │
│        ▼                      ▼            │             │
│  ┌──────────────┐   ┌──────────────────┐  │             │
│  │ events store  │   │ faucet (mints     │  │ wallet-    │
│  │ (Supabase)    │   │ test-USDC,        │  │ adapter +  │
│  │ funnel        │   │ mint-auth server) │  │ anchor     │
│  └──────────────┘   └──────────────────┘  │ (IDL)      │
└────────────────────────────────────────────┼───────────┘
                                              ▼
                              Solana DEVNET
                              program 8uDmfYPMBaiLLwfZGAnhNaDm48kx19hD8kPdiR7XiRLD
                              (current build, redeployed)
                              + demo test-USDC mint (6 dec)
                              + one pool_config (initialize)
                              NO Kamino, NO VRF on devnet
```

## 4. On-chain (devnet) — reuses the program as-is, no Rust changes

The current program's `deposit` / `request_withdraw` / `withdraw` (M1/M2) are pure SPL-transfer + `UserPosition` accounting. **They touch no Kamino and no Draw account** (verified in `lib.rs`). So they run standalone on devnet with zero program changes.

Setup (one-time, scripted):
1. **Redeploy current build to devnet.** The live devnet binary is a stale M1/M2-only build (446,880 B) missing M3-M5; `scripts/devnet-smoke.ts` false-positives by reading the local IDL. Upgrade the program at `8uDmf…` using its current **upgrade authority = `~/.config/solana/id.json`** (holds ~7.35 SOL). This closes the stale-deploy open-question as a side effect.
2. **Create a demo test-USDC mint**, 6 decimals (so `MIN_DEPOSIT = 10_000_000` displays as "10 USDC"). Mint authority held by a dedicated demo keypair, kept **server-side only**.
3. **`initialize`** one `pool_config` seeded by that mint (creates the PDA-owned `usdc_vault`). Admin = `id.json`.
4. **Publish on-chain IDL** (`anchor idl init`) so chain-fetch clients work.
5. **Skip** all `init_kamino_*`, `init_draw_accounts`, `init_growing_pot_*` — not needed for the deposit probe.

Program constants in play (unchanged): `MIN_DEPOSIT` 10 USDC, `MAX_DEPOSIT_PER_WALLET` 5,000 USDC, `WITHDRAW_COOLDOWN` 24h, `DRAW_INTERVAL` 7d.

Config hygiene: add `[programs.devnet]` + a devnet provider profile to `Anchor.toml`; pin the canonical keypair (`id.json` = upgrade authority + pool admin for the demo); write the init runbook in `migrations/` (currently the empty Anchor stub).

## 5. Components (each independently testable)

| # | Component | Does | Depends on | Priority |
|---|-----------|------|-----------|----------|
| C1 | Devnet deploy + init script | redeploy program, create mint, `initialize`, publish IDL, print addresses to a `.env.local` template | anchor CLI, id.json | P0 |
| C2 | Program client (`web/lib/stewfi.ts`) | typed wrapper over IDL: `deposit(amount)`, `requestWithdraw()`, `withdraw()`, `readPool()`, `readPosition(wallet)`, PDA derivations | `target/types/stewfi.ts`, anchor, wallet-adapter | P0 |
| C3 | Web app shell | Next.js App Router, Tailwind, shadcn/ui, wallet-adapter provider (Phantom/Solflare), devnet RPC, cauldron/purple brand (light) | — | P0 |
| C4 | `/app` deposit flow | connect → "Faucet 100 devUSDC" → amount input (min 10) → deposit (real signed tx) → show on-chain position + pool total | C2, C3, C5 | P0 |
| C5 | Faucet (`/api/faucet`) | serverless route: mints N test-USDC to a wallet; mint-auth secret in env (never client); rate-limit per wallet+IP | C1 mint | P0 |
| C6 | Instrumentation (`/api/track` + store) | record funnel events {event, sessionId, wallet?, ts}; events: `visit, connect, faucet, deposit_submitted, deposit_confirmed, withdraw_*`; deposits cross-checked against on-chain truth (`getProgramAccounts` UserPosition count) | Supabase (or Vercel KV) | P0 |
| C7 | `/` pitch page | the value prop, "A savings account where the interest is the prize", clear "devnet preview / not real money" banner, CTA → `/app` | C3 | P0 |
| C8 | Simulated draw + pot viz | client-only: pool total, your weight, countdown to Sunday 12:00 UTC, illustrative prize = poolTotal × mockAPY ÷ 52, "preview the draw" weighted-random animation. Labeled illustrative. | C2 reads | P1 |
| C9 | Withdraw UX | `request_withdraw` + `withdraw` with honest 24h cooldown countdown — sells the no-loss/get-principal-back trust promise | C2 | P1 |

## 6. Data flow — the deposit (the load-bearing path)

1. User lands `/` → `track(visit)`.
2. `/app`, clicks Connect → wallet-adapter → `track(connect, wallet)`.
3. "Faucet" → `POST /api/faucet {wallet}` → server mints 100 test-USDC (idempotent-ish, rate-limited) → `track(faucet, wallet)`.
4. Enters amount ≥ 10, "Deposit" → C2 builds `deposit(amount)` ix (creates ATA if needed, derives `pool_config` + `usdc_vault` + `user_position` PDAs) → wallet signs → `track(deposit_submitted)`.
5. On confirmation → read `user_position` back from chain → render position + updated pool total → `track(deposit_confirmed)`. **This event = the demand signal.**

## 7. Error handling

- Wrong network → detect cluster, prompt "switch to devnet."
- Faucet rate-limited / fails → clear message, retry; never block connect tracking.
- Deposit below MIN / above MAX → client-validate before signing; surface the AnchorError name on revert (verify-don't-trust: surface real error, not opaque string).
- No funds for rent/fees → faucet also airdrops a little devnet SOL if wallet balance is ~0.
- All `/api/track` failures are swallowed client-side (instrumentation must never break UX), but logged server-side.

## 8. Testing

- **C1:** devnet smoke — after init, fetch the deployed program's on-chain IDL and assert the M5 instruction set is present (fixes the current false-positive that reads the local file); assert `pool_config` exists with the demo mint.
- **C2/C4:** a scripted devnet E2E — faucet → deposit 10 → read back `UserPosition.amount == 10_000_000` → `request_withdraw` → (wait/cooldown bypass note) → `withdraw` → position closed. Run against real devnet (verify-don't-trust; no mocks).
- Existing M1/M2 `tests/stewfi.ts` (11, local validator) already cover deposit/withdraw logic — not re-implemented.
- Manual: full funnel click-through on the deployed Vercel URL from a fresh wallet before sharing.

## 9. Deploy / sharing

- Vercel project, env: `NEXT_PUBLIC_RPC_URL` (Helius devnet or public devnet), `NEXT_PUBLIC_PROGRAM_ID`, `NEXT_PUBLIC_USDC_MINT`, server-only `FAUCET_MINT_AUTHORITY_SECRET`, `SUPABASE_*`.
- Output: one https URL + a funnel dashboard (simple read of the events store) to watch the 15-20.

## 10. Location & scope

- Code lives in the `stewfinance` repo under `web/` (consumes the IDL; not the local-only brain dir). Deploy/init scripts extend `migrations/` + `scripts/`.
- **Devnet only. Zero real money. No audit, no geo-block, no indexer, no mainnet, no real yield, no leaderboard.** (YAGNI for a probe.)

## 11. Open items folded from the audit

- Closes open-question "stale devnet deployment + false-positive smoke test" (C1).
- Does **not** touch the 2 Slice-3 founder calls (operator keypair, VRF greenlight) — deliberately deferred; the probe runs without them.
