/**
 * StewFi off-chain crank — Switchboard On-Demand VRF wrappers (Slice 2a).
 *
 * Public:
 *   - loadSwitchboardProgram(provider, pid?) → Anchor `Program` for the SB On-Demand
 *     program (the SDK needs this; it auto-fetches the IDL on-chain). The optional
 *     `pid` overrides the auto-pick (mainnet on a mainnet fork = surfpool, devnet on
 *     a devnet RPC).
 *   - createRandomness(provider, sbProgram, rngKp, queue, payer?) → sends the SB
 *     `randomness_init` ix (the rng keypair MUST sign — it owns the new account).
 *     Returns the SDK `Randomness` instance + the tx signature so the caller can
 *     persist `rngKp` across commit→reveal.
 *   - commitIx(rng, queue, authority) / revealIx(rng, payer) → thin wrappers
 *     around the SDK's per-instance instruction builders. Both delegated to the
 *     SDK — DO NOT hand-roll them.
 *   - buildCommitAndTriggerV0Tx(provider, rng, queue, triggerDrawIx, operatorKp)
 *     → assembles `[ComputeBudget(set_unit_limit), commitIx, triggerDrawIx]` as
 *     ONE atomic v0 tx, signed by operatorKp.
 *   - buildRevealAndSettleV0Tx(provider, rng, settleDrawIx, operatorKp, opts?) →
 *     assembles `[ComputeBudget(set_unit_limit), revealIx, settleDrawIx]` as ONE
 *     atomic v0 tx. THIS IS LOAD-BEARING: `clock.slot == reveal_slot` is the
 *     on-chain guard, so bundling reveal+settle in one tx is how they share a slot.
 *     On surfpool we skip the real `revealIx` (set `opts.skipReveal = true`) — the
 *     mocked randomness account is already at the bound slot so settle just reads it.
 *   - mockRandomness(connection, rngKp, value, revealSlot) — SURFPOOL ONLY (uses
 *     the `surfnet_setAccount` cheatcode). Writes a 408-byte RandomnessAccountData
 *     directly. Direct port of tests/draw.ts's setMockRandomness. Throws if the RPC
 *     is not a surfpool endpoint (the cheatcode 404s on plain validators).
 *
 * Layout discipline: the byte map this file writes (disc + 408 bytes,
 * reveal_slot @ +144, value @ +152) is the layout the DEPLOYED on-chain
 * Switchboard program publishes via its IDL (verified empirically in
 * tests/draw.ts — settle_draw reads it via `RandomnessAccountData::parse` +
 * `get_value(clock.slot)` and it works). The TS SDK does NOT expose this map
 * directly (it fetches the IDL on-demand and lets Anchor decode), so if the
 * deployed SDK's discriminator ever changes (e.g. a future SB release) the mock
 * here would break — at which point we'd discover via crank2.ts's red, not silent.
 *
 * Ground all SDK calls in the installed package source
 * (node_modules/@switchboard-xyz/on-demand/dist/cjs/accounts/randomness.js). The
 * SDK uses its own Anchor 0.31 alias `@coral-xyz/anchor-31` internally; our calls
 * pass through plain `web3.PublicKey` / `web3.Keypair` / connections, which are
 * interchangeable across Anchor 0.31 majors.
 */
import {
  AddressLookupTableAccount,
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
  Signer,
} from "@solana/web3.js";
import { AnchorProvider } from "@coral-xyz/anchor";

import {
  Randomness,
  AnchorUtils,
} from "@switchboard-xyz/on-demand";

import {
  SWITCHBOARD_ON_DEMAND_PID_MAINNET,
  RANDOMNESS_ACCOUNT_SIZE,
  RANDOMNESS_DISCRIMINATOR,
  RANDOMNESS_OFF_REVEAL_SLOT,
  RANDOMNESS_OFF_VALUE,
} from "./constants";

// ===========================================================================
// SDK Program loader
// ===========================================================================

/**
 * Load an Anchor `Program` for the Switchboard On-Demand program. The SDK
 * fetches the IDL on-chain via `Program.at(pid, provider)` — so the program
 * MUST be deployed at `pid` on the provider's connection (it is on mainnet,
 * on devnet, AND on a surfpool mainnet fork — verified via deployments shipped
 * with the network in tests/draw.ts).
 *
 * `pid` defaults to mainnet (so surfpool fork-mainnet just works). For a real
 * devnet endpoint, pass `SWITCHBOARD_ON_DEMAND_PID_DEVNET`. `loadProgramFromConnection`
 * does its own devnet auto-detection if you pass `undefined`, but we keep this
 * explicit so the operator pins the right cluster on every call.
 */
export async function loadSwitchboardProgram(
  provider: AnchorProvider,
  pid: PublicKey = SWITCHBOARD_ON_DEMAND_PID_MAINNET
): Promise<any> {
  // The SDK uses its own @coral-xyz/anchor-31 namespace internally; passing
  // our anchor 0.31 provider works because the wallet/connection interfaces
  // are stable across the 0.31 majors (verified in SDK source — it just calls
  // `Program.at(pid, provider)`).
  return AnchorUtils.loadProgramFromProvider(provider as any, pid);
}

// ===========================================================================
// Account creation + commit/reveal instruction builders
// ===========================================================================

export interface CreateRandomnessResult {
  randomness: Randomness;
  rngKp: Keypair;
  sig: string;
}

/**
 * Create a new Switchboard randomness account on-chain (sends `randomness_init`).
 * The `rngKp` MUST be supplied by the caller and persisted across commit→reveal
 * (so the same keypair signs init AND the commit tx if the caller chooses to
 * bundle them — though here we send init standalone for simplicity).
 *
 * The `payer` defaults to the provider's wallet; the wallet pays rent + the
 * SOL ATA reward escrow init. The rng keypair must also sign (it owns the new
 * account). Returns the SDK `Randomness` wrapper so the caller can call
 * `commitIx` / `revealIx` directly.
 */
export async function createRandomness(
  provider: AnchorProvider,
  sbProgram: any,
  rngKp: Keypair,
  queue: PublicKey,
  payer?: PublicKey
): Promise<CreateRandomnessResult> {
  const payerKey = payer ?? provider.wallet.publicKey;
  const [randomness, ix] = await Randomness.create(
    sbProgram,
    rngKp,
    queue,
    payerKey
  );

  // `randomness_init` CPI-creates the rng account; we must include a
  // ComputeBudget bump because SB's init does LUT init too (heavy). The same
  // ComputeBudget value the SDK's commitAndReveal helper uses.
  const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });

  const tx = await asV0Tx(
    provider.connection,
    [cuIx, ix],
    payerKey,
    [rngKp]
  );
  // The provider wallet signs as fee-payer; rngKp is in the v0 sign list.
  tx.sign([rngKp]);
  const signed = await provider.wallet.signTransaction(tx);
  const sig = await provider.connection.sendRawTransaction(
    signed.serialize(),
    { skipPreflight: true }
  );
  const conf = await provider.connection.confirmTransaction(sig, "confirmed");
  if (conf.value.err) {
    let logs = "";
    try {
      const det = await provider.connection.getTransaction(sig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (det?.meta?.logMessages) logs = "\n" + det.meta.logMessages.join("\n");
    } catch {
      /* ignore */
    }
    throw new Error(
      `createRandomness: randomness_init tx ${sig} failed on-chain: ` +
        `${JSON.stringify(conf.value.err)}${logs}`
    );
  }
  return { randomness, rngKp, sig };
}

/** Switchboard commit ix (delegated to the SDK — do NOT hand-roll). */
export async function commitIx(
  randomness: Randomness,
  queue: PublicKey,
  authority?: PublicKey
): Promise<TransactionInstruction> {
  return randomness.commitIx(queue, authority);
}

/**
 * Switchboard reveal ix (delegated to the SDK — do NOT hand-roll).
 *
 * NOTE: The SDK's revealIx makes a live HTTP call to the assigned oracle's
 * gateway (3s sleep + axios POST) AND requires the oracle to be online. On a
 * surfpool fork the oracle is NOT running, so this will fail. For surfpool we
 * skip this entirely (the mocked randomness account already has the value at
 * the bound slot — settle just reads it via `get_value`).
 */
export async function revealIx(
  randomness: Randomness,
  payer?: PublicKey
): Promise<TransactionInstruction> {
  return randomness.revealIx(payer);
}

// ===========================================================================
// V0 tx assemblers (atomic commit+trigger / reveal+settle)
// ===========================================================================

export interface CommitAndTriggerOpts {
  /**
   * SURFPOOL/TESTING ONLY. When true, the SB `commitIx` is NOT prepended.
   * Use this when the randomness account is fully MOCKED via `mockRandomness`
   * (the on-chain `trigger_draw` only checks owner == SB program + reveal_slot
   * == 0, both of which the mock satisfies). The live SB queue does NOT have
   * to be queryable in this mode. Symmetric with `RevealAndSettleOpts.skipReveal`.
   */
  skipCommit?: boolean;
  computeUnits?: number;
}

/**
 * Build an ATOMIC v0 tx `[ComputeBudget?, commitIx?, triggerDrawIx]`, signed
 * by `operatorKp` as fee-payer + StewFi crank. The Switchboard `commitIx`
 * uses the operator key as authority too (passed via SDK's
 * `commitIx(queue, authority)`).
 *
 * Why atomic: trigger_draw records `randomness_account` in the Draw + sets
 * `draw_in_progress = true`. The SB commit binds the randomness account to
 * `slot - 1` as seed. Bundling them prevents a race where someone else
 * could commit/reveal the same account between trigger and commit.
 *
 * On surfpool (`opts.skipCommit = true`), the commitIx is omitted: the
 * randomness account is fully mocked and there's no live oracle to bind.
 *
 * `computeUnits` defaults to 400_000 (commit ~50k + trigger_draw is light).
 */
export async function buildCommitAndTriggerV0Tx(
  provider: AnchorProvider,
  randomness: Randomness,
  queue: PublicKey,
  triggerDrawIx: TransactionInstruction,
  operatorKp: Signer,
  opts: CommitAndTriggerOpts = {}
): Promise<VersionedTransaction> {
  const cu = opts.computeUnits ?? 400_000;
  const ixs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: cu }),
  ];
  if (!opts.skipCommit) {
    const commit = await randomness.commitIx(queue, operatorKp.publicKey);
    ixs.push(commit);
  }
  ixs.push(triggerDrawIx);
  return asV0Tx(provider.connection, ixs, operatorKp.publicKey, [operatorKp]);
}

export interface RevealAndSettleOpts {
  /**
   * SURFPOOL/TESTING ONLY. When true, the real Switchboard `revealIx` is NOT
   * prepended (the live oracle is unreachable on a fork). The mocked randomness
   * account is assumed to already hold the revealed value at the bound slot
   * (see `mockRandomness`).
   */
  skipReveal?: boolean;
  computeUnits?: number;
  /**
   * Slice 2b: optional Address Lookup Tables to compile into the v0 tx. When
   * supplied, settle_draw's per-position remaining_accounts can resolve through
   * the ALT rather than being inlined — raising the live-position cap from ~51
   * (legacy) toward ~256 (ALT). Omit for the small-N legacy v0 path.
   *
   * The ALT(s) MUST contain every pubkey settle references that we want offloaded
   * (the per-position UserPositions; fixed accounts can stay inline). Build via
   * `createPositionsAlt` over `sortedPositionMetas(...)`.
   */
  addressLookupTableAccounts?: AddressLookupTableAccount[];
}

/**
 * Build an ATOMIC v0 tx `[ComputeBudget?, revealIx?, settleDrawIx]`, signed by
 * `operatorKp` as fee-payer + StewFi crank.
 *
 * LOAD-BEARING: the on-chain settle_draw calls
 * `RandomnessAccountData::get_value(clock.slot)`, which only returns the value
 * when `clock.slot == reveal_slot`. The SB revealIx sets `reveal_slot = current
 * slot`. Bundling reveal+settle in ONE v0 tx is how they share a slot → atomic.
 *
 * On surfpool, set `opts.skipReveal = true`: the mocked randomness account is
 * already at the slot you want and `revealIx` would attempt a live oracle HTTP
 * call that doesn't work on a fork. The atomicity guarantee is preserved
 * because settle still reads the bound-slot value in the same tx.
 *
 * `computeUnits` defaults to 600_000 (settle's prize-split is heavier than the
 * 25-40k CU estimate in m4-research; the legacy-cap test uses 600k too).
 */
export async function buildRevealAndSettleV0Tx(
  provider: AnchorProvider,
  randomness: Randomness,
  settleDrawIx: TransactionInstruction,
  operatorKp: Signer,
  opts: RevealAndSettleOpts = {}
): Promise<VersionedTransaction> {
  const cu = opts.computeUnits ?? 600_000;
  const ixs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: cu }),
  ];
  if (!opts.skipReveal) {
    const reveal = await randomness.revealIx(operatorKp.publicKey);
    ixs.push(reveal);
  }
  ixs.push(settleDrawIx);
  return asV0Tx(
    provider.connection,
    ixs,
    operatorKp.publicKey,
    [operatorKp],
    opts.addressLookupTableAccounts
  );
}

// ===========================================================================
// surfpool-only: mock a revealed RandomnessAccountData
// ===========================================================================

/**
 * SURFPOOL ONLY. Build a RandomnessAccountData buffer with `value` and
 * `revealSlot` set, and write it to `rngKp.publicKey` via `surfnet_setAccount`
 * (owner = Switchboard On-Demand mainnet PID). Direct port of
 * tests/draw.ts's `setMockRandomness`.
 *
 * Throws (loudly, with a descriptive message) if the cheatcode is rejected —
 * which it WILL be on a plain `solana-test-validator` or a live cluster. This
 * is the only safe way to skip the live oracle.
 *
 * The 408-byte size + discriminator + offset map is the layout the on-chain
 * Switchboard program expects (verified empirically — tests/draw.ts settles
 * against settle_draw's `RandomnessAccountData::parse` + `get_value` using
 * this exact buffer). If the deployed SDK version ever ships a different
 * layout, this would fail loudly (settle would reject with a parse error).
 */
export async function mockRandomness(
  connection: Connection,
  rngKp: Keypair,
  value: Buffer,
  revealSlot: number | bigint
): Promise<void> {
  const buf = Buffer.alloc(RANDOMNESS_ACCOUNT_SIZE);
  Buffer.from(RANDOMNESS_DISCRIMINATOR).copy(buf, 0);
  buf.writeBigUInt64LE(BigInt(revealSlot), RANDOMNESS_OFF_REVEAL_SLOT);
  value.copy(buf, RANDOMNESS_OFF_VALUE, 0, Math.min(32, value.length));

  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "surfnet_setAccount",
    params: [
      rngKp.publicKey.toBase58(),
      {
        lamports: 5_000_000,
        owner: SWITCHBOARD_ON_DEMAND_PID_MAINNET.toBase58(),
        data: buf.toString("hex"),
        executable: false,
      },
    ],
  };
  const resp = await fetch(connection.rpcEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json: any = await resp.json();
  if (json.error) {
    throw new Error(
      `mockRandomness: surfnet_setAccount failed (likely not a surfpool RPC — ` +
        `mockRandomness is for surfpool ONLY): ${JSON.stringify(json.error)}`
    );
  }
}

/**
 * Build a 32-byte VRF value whose ticket = (u128 LE of [0..16]) % total
 * resolves to `target`. Used by the orchestrator and tests to construct a
 * deterministic-winner mock on surfpool. (Pure helper; not used in production.)
 */
export function vrfValueForTicket(target: bigint): Buffer {
  const MASK = 0xffffffffffffffffn;
  const buf = Buffer.alloc(32);
  buf.writeBigUInt64LE(target & MASK, 0);
  buf.writeBigUInt64LE((target >> 64n) & MASK, 8);
  return buf;
}

// ===========================================================================
// Internal: compile v0 tx (the standard recipe — no external deps)
// ===========================================================================

async function asV0Tx(
  connection: Connection,
  ixs: TransactionInstruction[],
  payer: PublicKey,
  signers: Signer[],
  addressLookupTableAccounts?: AddressLookupTableAccount[]
): Promise<VersionedTransaction> {
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  // Slice 2b: when ALTs are provided, compileToV0Message moves any matching
  // pubkeys out of the inline static account-keys list and into the ALT
  // lookup section, raising the per-tx account ceiling toward ~256.
  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message(addressLookupTableAccounts);
  const tx = new VersionedTransaction(msg);
  if (signers.length > 0) tx.sign(signers);
  return tx;
}
