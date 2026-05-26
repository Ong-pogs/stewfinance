# StewFi off-chain operator crank

The off-chain orchestrator that drives each StewFi weekly draw cycle.

`app/crank/` is a plain-TS library + a scheduler entrypoint. It is what a hosted
worker (Railway / Fly long-lived process) runs to:

1. **Harvest the growing pot** (permissionless) — fold last week's yield into
   the prize.
2. **Withdraw the main pool from Kamino** (operator) — bring USDC back into
   `usdc_vault` so `trigger_draw`'s `vault >= total_principal + pending_winnings`
   guard passes.
3. **Trigger the draw** (operator) — bundled with a Switchboard VRF commit ix.
4. **Reveal + settle** (operator) — atomic with the Switchboard reveal ix
   (slot-bound).
5. **Compound the pot** (permissionless) — re-invest principal + new escrow.
6. **Watchdog** — `cancelIfStuck` if a draw is stranded past its timeout.

## Slice 2b additions

- **Address Lookup Tables for settle** (`app/crank/alt.ts`) — raises the live
  position cap from ~51 (legacy tx) toward ~256 (ALT-backed v0). The
  orchestrator can be told to `'auto'` (default, threshold = 40), `'always'`
  build an ALT, or `'never'` use one.
- **Scheduler / CLI** (`app/crank/run.ts`) — the long-lived worker entrypoint
  this README documents.

## Running the scheduler

```
yarn crank:start
```

That's the headless command for a hosted worker. Set the env vars below in
your hosting platform's secret store and point at the keypair JSON paths.

### Env vars

| Var                       | Required | Default                     | Notes                                                        |
| ------------------------- | -------- | --------------------------- | ------------------------------------------------------------ |
| `ANCHOR_PROVIDER_URL`     | yes      | —                           | RPC endpoint (devnet or mainnet).                            |
| `OPERATOR_KEYPAIR_PATH`   | yes      | —                           | Path to the operator's Keypair JSON (Solana CLI array fmt).  |
| `CRANK_KEYPAIR_PATH`      | no       | = `OPERATOR_KEYPAIR_PATH`   | Optional separate keypair for the permissionless steps.      |
| `USDC_MINT`               | no       | mainnet USDC                | Override if running on devnet with a different USDC mint.    |
| `POLL_INTERVAL_MS`        | no       | `60000`                     | Between-cycle sleep. Must be ≥ 1000.                         |
| `ALT_MODE`                | no       | `auto`                      | `auto` \| `always` \| `never`. See below.                    |
| `ALT_THRESHOLD`           | no       | `40`                        | Above this position count, `auto` builds an ALT.             |
| `DRY_RUN`                 | no       | `false`                     | `true` → log decisions without sending any txs.              |
| `RANDOMNESS_KEYPAIR_PATH` | no       | unset                       | SB rng keypair (see Slice 3 note below).                     |

### ALT mode semantics

`settle_draw` has 12 fixed accounts + one extra remaining-account per live
UserPosition. A legacy v0 tx caps at ~51 live positions; above that the tx
exceeds the per-tx account budget and reverts.

- `ALT_MODE=auto` (default) — build an ALT only when `positionCount >
  ALT_THRESHOLD`. The threshold defaults to 40, comfortably under the legacy
  cap so the auto path doesn't cut it close.
- `ALT_MODE=always` — always build an ALT. Useful for testing the ALT path
  on small position sets (no functional downside; just extra cost +
  ALT_EXTEND_BATCH_SIZE extend txs per cycle).
- `ALT_MODE=never` — force the legacy path. Will revert above the cap.

### Where keys live

In production, mount your keypair JSON files into the worker's container as
read-only secrets — never bake them into the image. Suggested patterns:

- **Railway:** add the keypair JSON as a multi-line env-var "secret file"
  mounted at `/etc/secrets/operator.json`, set `OPERATOR_KEYPAIR_PATH=/etc/secrets/operator.json`.
- **Fly:** `fly secrets set OPERATOR_KEYPAIR_JSON=...` and use a tiny shim
  that writes `$OPERATOR_KEYPAIR_JSON` to `/tmp/op.json` before launching;
  point `OPERATOR_KEYPAIR_PATH` there.

Whatever hosting you pick: **do not check keypair JSON into git.** The
`.gitignore` at the repo root already excludes anything under `~/.config`
and the standard `*.json` keypair conventions.

### Logs

One JSON object per line (`console.log(JSON.stringify(...))`). Fields:

- `ts`         — ISO timestamp.
- `level`      — `debug` | `info` | `warn` | `error`.
- `msg`        — short human-readable summary.
- plus arbitrary structured context fields (sigs, slots, error strings, ...).

Filter / index whatever your hosting platform supports (Railway has built-in
log search; Fly forwards to Vector → wherever you want).

### Graceful shutdown

`SIGINT` / `SIGTERM` set a `shuttingDown` flag. The current cycle (if mid-run)
finishes; the loop then exits cleanly. No partial-state hangs.

## Slice 3 wire-up (NOT in 2b)

The scheduler currently logs `"runDrawCycle production path is Slice 3"` when
the cadence is open AND non-dry-run AND a randomness keypair is set. This is
intentional — the production reveal-wait path in `runDrawCycle` (the non-
`opts.surfpool` branch) requires the Switchboard SDK to be reachable on the
live cluster. The surfpool buglog B6 / B9 explain why this only works on
devnet/mainnet, not surfpool.

When Slice 3 lands:

1. The scheduler will call `runDrawCycle(program, operator, crank, {randomness, alt})`
   directly (no surfpool hook).
2. `runDrawCycle`'s production branch will poll `randomness.loadData()` until
   the oracle's `revealSlot > 0`, compute the winner off-chain from the
   revealed value, then send atomic `[revealIx, settle]`.

Until then, run the scheduler with `DRY_RUN=true` to exercise the loop +
watchdog + ALT route logic against a real cluster without sending state-
changing txs. Devnet smoke testing (real SB oracle, fresh prices) is the
Slice 3 milestone.

## Library API (for tests + future callers)

```ts
import {
  readPoolState,
  harvestPot,
  compoundPot,
  cancelIfStuck,
  planSettle,
  triggerDraw,
  revealAndSettle,
  claimDraw,
  withdrawMainFromKamino,
  runDrawCycle,
  // Slice 2b:
  createPositionsAlt,
  getAddressLookupTableAccount,
} from "../app/crank";
```

See `app/crank/index.ts` for the typed signatures and JSDoc.
