/**
 * StewFi crank — Slice 2b: Address Lookup Table (ALT) support for settle_draw.
 *
 * Why ALTs:
 *   I-05 launch gate. `settle_draw` has 12 fixed accounts + one extra
 *   `remainingAccount` per live UserPosition. A legacy / vanilla-v0 tx caps at
 *   ~51 live positions before the tx exceeds Solana's per-tx account budget
 *   (35 readonly + 31 writable, roughly). Address Lookup Tables raise this
 *   ceiling to ~256 (the per-tx limit is no longer the inline-account count;
 *   it's the ALT-referenced account count, which is bounded by the size of an
 *   ALT — 256 entries — and how many ALTs the tx references).
 *
 * What this module does:
 *   - `createPositionsAlt`: build an ALT whose entries are the AccountMeta
 *     pubkeys produced by `sortedPositionMetas(positionMetas)`. Steps:
 *     (1) recentSlot for the ALT init (must be in SlotHashes sysvar — surfpool
 *         can return finalized slots OUTSIDE its local window; we retry +
 *         fall back to `confirmed`, but never silently paper over),
 *     (2) `createLookupTable` tx (authority + payer = the same operator key
 *         the test passes in),
 *     (3) batched `extendLookupTable` (≤30 keys per batch; an extend ix is
 *         tiny but the total tx size grows with `addresses.length × 32 + ix
 *         overhead`),
 *     (4) wait one slot for the ALT to be "warmed" (warmups: the ALT must be
 *         created at slot N and become usable strictly AFTER slot N — Solana's
 *         v0 tx resolver checks `tx.recent_slot > alt.last_extended_slot`).
 *   - `getAddressLookupTableAccount`: re-fetch the ALT as an
 *     `AddressLookupTableAccount` for V0 tx compilation.
 *
 * Returns `{altAddress, altAccount}` ready to feed into
 * `TransactionMessage.compileToV0Message([alt])`.
 *
 * Surfpool note:
 *   surfpool's mainnet fork can return a `getSlot('finalized')` slot that's
 *   OUTSIDE the local SlotHashes sysvar window (m6-crank-slice2a-buglog B6
 *   bit the SB SDK's `Randomness.create` the same way). The lookup-table
 *   program rejects any recent_slot not in SlotHashes with
 *   `InvalidInstructionData ("<slot> is not a recent slot")`. We try
 *   `getSlot('finalized')` first, fall back to `confirmed`, and if BOTH fail
 *   we throw a loud error so the caller can decide (instead of silently
 *   producing a busted ALT).
 */
import {
  PublicKey,
  Keypair,
  Signer,
  Connection,
  AddressLookupTableProgram,
  AddressLookupTableAccount,
  Transaction,
  AccountMeta,
} from "@solana/web3.js";
import { AnchorProvider } from "@coral-xyz/anchor";

/** Max addresses per extendLookupTable tx (each entry is 32 bytes + small overhead). */
const ALT_EXTEND_BATCH_SIZE = 30;
/** How long to wait for the ALT to warm (i.e. usable in a subsequent v0 tx). */
const ALT_WARM_DELAY_MS = 2000;

export interface CreatePositionsAltResult {
  /** The ALT address (PDA of [authority, recentSlot]). */
  altAddress: PublicKey;
  /** The freshly-fetched ALT account, ready for v0 tx compilation. */
  altAccount: AddressLookupTableAccount;
  /** The recent slot used at create time (for diagnostics). */
  recentSlot: number;
  /** The number of entries written (== positionMetas.length). */
  entriesWritten: number;
  /** Tx signatures sent (1 create + N extend). */
  sigs: string[];
}

/**
 * Build an ALT that contains exactly the pubkeys from `positionMetas`. The
 * caller's `authorityKp` is the ALT authority AND payer (matches the typical
 * crank deployment where the operator owns + funds + extends its own ALTs).
 *
 * After creation the ALT is fetched and returned as an
 * `AddressLookupTableAccount` ready to compile into a v0 tx.
 *
 * NOT defensive on input size: passing `positionMetas.length > 256` would
 * overflow the per-ALT entry cap. The caller (planSettle's `recommendsAlt` /
 * `runDrawCycle`) gates this; we throw loudly if exceeded.
 */
export async function createPositionsAlt(
  provider: AnchorProvider,
  authorityKp: Signer,
  positionMetas: AccountMeta[]
): Promise<CreatePositionsAltResult> {
  const connection = provider.connection;

  if (positionMetas.length === 0) {
    throw new Error("createPositionsAlt: positionMetas is empty (nothing to put in the ALT)");
  }
  if (positionMetas.length > 256) {
    throw new Error(
      `createPositionsAlt: ${positionMetas.length} entries exceeds the ALT max of 256 per table`
    );
  }

  const addresses: PublicKey[] = positionMetas.map((m) => m.pubkey);

  // -- 1. + 2. recent slot + create the ALT --------------------------------
  // The LUT program checks SlotHashes at EXECUTE time. There's a small race
  // between `getSlot('confirmed')` and the create tx landing where the slot
  // we fetched can age out of SlotHashes. Retry a few times with a fresh
  // slot if the LUT program reverts with "is not a recent slot".
  let altAddress: PublicKey | undefined;
  let recentSlot = 0;
  const sigs: string[] = [];
  let lastErr: any;
  for (let attempt = 0; attempt < 4; attempt++) {
    recentSlot = await pickRecentSlot(connection);
    const [createIx, addr] = AddressLookupTableProgram.createLookupTable({
      authority: authorityKp.publicKey,
      payer: authorityKp.publicKey,
      recentSlot,
    });
    altAddress = addr;
    const tx = new Transaction().add(createIx);
    try {
      const sig = await provider.sendAndConfirm!(tx, [authorityKp as Keypair], {
        skipPreflight: false, // surface the "not a recent slot" error LOUDLY
        commitment: "confirmed",
      });
      sigs.push(sig);
      lastErr = undefined;
      break;
    } catch (err: any) {
      lastErr = err;
      const msg = err?.toString?.() ?? "";
      // Only retry on the SlotHashes-window edge case. Any other revert
      // (insufficient funds, signature issues, ...) is a real failure.
      if (!msg.includes("is not a recent slot")) throw err;
      // Tiny backoff to let the chain produce a new block (and a fresher
      // slot enter SlotHashes).
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  if (lastErr) throw lastErr;
  if (!altAddress) {
    throw new Error("createPositionsAlt: ALT create failed silently (no error captured)");
  }

  // -- 3. extend in batches -------------------------------------------------
  for (let i = 0; i < addresses.length; i += ALT_EXTEND_BATCH_SIZE) {
    const batch = addresses.slice(i, i + ALT_EXTEND_BATCH_SIZE);
    const extendIx = AddressLookupTableProgram.extendLookupTable({
      lookupTable: altAddress,
      authority: authorityKp.publicKey,
      payer: authorityKp.publicKey,
      addresses: batch,
    });
    const tx = new Transaction().add(extendIx);
    const sig = await provider.sendAndConfirm!(tx, [authorityKp as Keypair], {
      skipPreflight: false,
      commitment: "confirmed",
    });
    sigs.push(sig);
  }

  // -- 4. wait for the ALT to warm (v0 tx must have recent_slot > alt.last_extended_slot)
  await new Promise((r) => setTimeout(r, ALT_WARM_DELAY_MS));

  const altAccount = await getAddressLookupTableAccount(connection, altAddress);

  return {
    altAddress,
    altAccount,
    recentSlot,
    entriesWritten: addresses.length,
    sigs,
  };
}

/**
 * Fetch an ALT account. Throws (with a clear message) if the ALT doesn't
 * exist — distinguishing "table not yet warmed" (rare; ALT_WARM_DELAY_MS
 * usually covers it) from "wrong address" (most likely cause of a miss).
 */
export async function getAddressLookupTableAccount(
  connection: Connection,
  altAddress: PublicKey
): Promise<AddressLookupTableAccount> {
  const resp = await connection.getAddressLookupTable(altAddress);
  if (!resp.value) {
    throw new Error(
      `getAddressLookupTableAccount: ALT ${altAddress.toBase58()} not found ` +
        `(either wrong address or not yet propagated — the warm delay was too short)`
    );
  }
  return resp.value;
}

/**
 * Pick a recent slot that is BOTH (a) actually finalized/confirmed and (b) in
 * the SlotHashes sysvar's local window. The lookup-table program checks
 * SlotHashes at execute time and rejects anything outside its window with
 * `InvalidInstructionData` + log "<slot> is not a recent slot".
 *
 * Order: `confirmed` FIRST, then `finalized` fallback. On surfpool a
 * "finalized" slot can be OUTSIDE the local SlotHashes window (buglog B1 /
 * Slice 2a B6) — getting it produces a tx-time revert. `confirmed` tracks
 * the CURRENT chain slot more closely and is more likely to be inside
 * SlotHashes. On healthy mainnet/devnet either commitment lands in the
 * window (the last ~512 slots).
 *
 * We do NOT silently swallow the failure — if both commitment tiers return
 * slots outside SlotHashes the caller's create tx will revert loudly with
 * the lookup-table program's error in the logs (we send with
 * `skipPreflight: false`).
 */
async function pickRecentSlot(connection: Connection): Promise<number> {
  let lastErr: any;
  for (const commitment of ["confirmed", "finalized"] as const) {
    try {
      const slot = await connection.getSlot(commitment);
      return slot;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `pickRecentSlot: could not getSlot at confirmed or finalized: ${lastErr}`
  );
}
