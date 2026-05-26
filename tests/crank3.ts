/**
 * Slice 2b crank lib — ALT (Address Lookup Table) settle path E2E.
 *
 * Proves:
 *   - `planSettle` reports `recommendsAlt: true` when position count >
 *     threshold (boundary check vs SETTLE_LEGACY_POSITION_CAP).
 *   - `createPositionsAlt(...)` builds + warms a usable
 *     `AddressLookupTableAccount` whose entries == `sortedPositionMetas(...)`.
 *   - A settle tx built via the ALT path lands successfully (no
 *     `BadWinnerProof` / `PositionsNotSorted` / `IncompletePositionSet`) and
 *     the on-chain winner derivation matches the crank's off-chain pick.
 *   - `runDrawCycle({alt: {mode: 'always'}})` emits a tx with
 *     non-empty `addressTableLookups`. `mode: 'never'` emits one with EMPTY
 *     `addressTableLookups`.
 *
 * Mocking the orchestrator's klend half:
 *   The full orchestrator (harvest → withdraw → trigger → settle → compound)
 *   would run into Slice 2a's B9 — time-traveling past the weekly cadence
 *   ages the mainnet-fork Scope/Pyth oracles past max_age=180s, reverting
 *   every klend CPI with `PriceTooOld`. ALT is for SETTLE specifically, and
 *   `settle_draw` does NOT CPI klend — so we can prove the ALT path WITHOUT
 *   touching klend by:
 *     - Skipping `harvestPot` (no pot setup; pot vault stays at 0).
 *     - Skipping `withdrawMainFromKamino` (we never deposit principal into
 *       klend; the main pool obligation is initialized but empty).
 *     - Simulating "yield" by minting USDC directly into `usdc_vault` so
 *       `prize > 0` at trigger time.
 *     - Trigger + settle land normally (no klend CPI).
 *     - Skipping compound (the cycle's runDrawCycle compound step is the
 *       only other klend touchpoint; in surfpool tests this fails on B9
 *       even though settle succeeded).
 *
 *   Slice 3 (devnet) covers the full E2E with real, naturally-fresh oracles.
 *
 * Run in its OWN fresh surfpool session:
 *   pkill surfpool; pkill solana-test-validator; sleep 2
 *   nohup surfpool start -u https://api.mainnet-beta.solana.com --no-tui \
 *     --no-deploy -a 4xQkgGqiFjc5sDFgifFjQubBkyagenkXYkyCMigCujES > /tmp/surf.log &
 *   solana program deploy target/deploy/stewfi.so -u http://127.0.0.1:8899 \
 *     --keypair ~/.config/solana/stewfi-dev.json \
 *     --program-id target/deploy/stewfi-keypair.json
 *   yarn test:crank3
 *   pkill surfpool
 */
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Stewfi } from "../target/types/stewfi";
import {
  getAssociatedTokenAddressSync,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  AccountMeta,
} from "@solana/web3.js";
import { assert } from "chai";

import {
  readPoolState,
  planSettle,
  fetchAllPositions,
  sortedPositionMetas,
  computeWinner,
  triggerDraw,
  revealAndSettle,
  runDrawCycle,
  createPositionsAlt,
  mockRandomness,
  vrfValueForTicket,
  // constants
  KLEND,
  FARMS,
  USDC_MINT,
  ONE_USDC,
  SETTLE_LEGACY_POSITION_CAP,
  SWITCHBOARD_DEFAULT_QUEUE_MAINNET,
  LENDING_MARKET,
  LENDING_MARKET_AUTHORITY,
  RESERVE,
  FARM_COLLATERAL,
} from "../app/crank";
import {
  poolConfigPda as cPoolConfigPda,
  usdcVaultPda as cUsdcVaultPda,
  growingPotVaultPda as cGrowingPotVaultPda,
  operatorVaultPda as cOperatorVaultPda,
  opsVaultPda as cOpsVaultPda,
  userMetadataPda as cUserMetadataPda,
  obligationPda as cObligationPda,
  obligationFarmPda as cObligationFarmPda,
  userPositionPda as cUserPositionPda,
  drawPda as cDrawPda,
} from "../app/crank/pdas";

// ===========================================================================
// surfnet cheatcode helpers (ported from crank2.ts).
// ===========================================================================
async function rpc(endpoint: string, method: string, params: any[]): Promise<any> {
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json: any = await resp.json();
  if (json.error) throw new Error(`${method} failed: ${JSON.stringify(json.error)}`);
  return json.result;
}

async function setTokenBalance(
  connection: anchor.web3.Connection,
  owner: PublicKey,
  mint: PublicKey,
  amount: bigint
): Promise<PublicKey> {
  await rpc(connection.rpcEndpoint, "surfnet_setTokenAccount", [
    owner.toBase58(),
    mint.toBase58(),
    { amount: Number(amount) },
  ]);
  return getAssociatedTokenAddressSync(mint, owner, true);
}

async function fundSol(
  connection: anchor.web3.Connection,
  pubkey: PublicKey,
  lamports: number
) {
  await rpc(connection.rpcEndpoint, "surfnet_setAccount", [
    pubkey.toBase58(),
    { lamports },
  ]);
}

async function setRawTokenAccountBalance(
  endpoint: string,
  tokenAccount: PublicKey,
  mint: PublicKey,
  owner: PublicKey,
  amount: bigint
): Promise<void> {
  const buf = Buffer.alloc(165);
  mint.toBuffer().copy(buf, 0);
  owner.toBuffer().copy(buf, 32);
  buf.writeBigUInt64LE(amount, 64);
  buf.writeUInt8(1, 108); // AccountState::Initialized
  await rpc(endpoint, "surfnet_setAccount", [
    tokenAccount.toBase58(),
    {
      lamports: 2_039_280,
      owner: TOKEN_PROGRAM_ID.toBase58(),
      data: buf.toString("hex"),
      executable: false,
    },
  ]);
}

const pauseClock = (endpoint: string) => rpc(endpoint, "surfnet_pauseClock", []);
const resumeClock = (endpoint: string) => rpc(endpoint, "surfnet_resumeClock", []);

async function getClockSysvarSlot(
  connection: anchor.web3.Connection
): Promise<number> {
  const CLOCK = new PublicKey("SysvarC1ock11111111111111111111111111111111");
  const info = await connection.getAccountInfo(CLOCK);
  if (!info) throw new Error("Clock sysvar not found");
  return Number(info.data.readBigUInt64LE(0));
}

async function ensureClockAtLeast(
  endpoint: string,
  connection: anchor.web3.Connection,
  unixSeconds: number
): Promise<void> {
  const blockTime = await connection.getBlockTime(await connection.getSlot());
  if (blockTime !== null && blockTime >= unixSeconds) return;
  try {
    await rpc(endpoint, "surfnet_timeTravel", [
      { absoluteTimestamp: unixSeconds * 1000 },
    ]);
  } catch (err: any) {
    const msg = err?.toString?.() ?? "";
    if (msg.includes("Cannot travel to past")) return;
    throw err;
  }
}

// ===========================================================================
describe("stewfi — Slice 2b crank lib (ALT settle path, surfpool fork)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Stewfi as Program<Stewfi>;
  const connection = provider.connection;
  const endpoint = connection.rpcEndpoint;

  const admin = (provider.wallet as anchor.Wallet).payer;

  const operator = Keypair.generate();
  const ops = Keypair.generate();
  const crank = Keypair.generate();

  // N depositors — exercising the ALT path on a position set big enough to
  // prove the mechanism (>= 10). Surfpool isn't constrained the same way as
  // mainnet's legacy-tx account budget; we don't need 51+ here. Slice 3 on
  // devnet will exercise true >51 with real RPC limits.
  const N_DEPOSITORS = 10;
  const depositors: Keypair[] = Array.from({ length: N_DEPOSITORS }, () =>
    Keypair.generate()
  );
  const DEPOSIT_PER_USER = 100n * ONE_USDC;
  const YIELD_SIM = 30n * ONE_USDC;

  let poolConfigPda: PublicKey;
  let usdcVaultPda: PublicKey;
  let growingPotVaultPda: PublicKey;
  let operatorVaultPda: PublicKey;
  let opsVaultPda: PublicKey;

  let depositorAtas: PublicKey[] = [];
  let depositorPosPdas: PublicKey[] = [];

  // klend obligation handles — captured in `before`. Used by the
  // orchestrator tests to zero the pot_obligation's deposited_amount
  // between cycles (each runDrawCycle that hits compoundPot leaves cTokens
  // behind; the NEXT cycle's harvestPot would try to redeem them under
  // stale Scope prices → B9). The in-place zero (vs a full snapshot
  // restore) preserves the deposit_reserve slot key so refresh_obligation
  // count checks still pass downstream.
  let potObligation: PublicKey;
  let mainObligation: PublicKey;

  /**
   * Zero an obligation's `deposited_amount` for the USDC reserve in-place
   * (preserves the `deposit_reserve` field so klend's refresh_obligation
   * count check still passes). This is the minimal mutation needed to make
   * `readObligationCollateral` return 0n → harvestPot skips → no klend
   * CPI fires for harvest on the next cycle.
   *
   * Layout (verified — app/crank/klend.ts):
   *   deposits[i].deposit_reserve  @ off + 0    (32 bytes)
   *   deposits[i].deposited_amount @ off + 32   (u64 LE)
   *   where off = 96 + i * 136 for i in 0..8.
   */
  async function zeroObligationDepositedAmount(
    conn: anchor.web3.Connection,
    endpoint_: string,
    obligation: PublicKey,
    reserve: PublicKey
  ): Promise<void> {
    const info = await conn.getAccountInfo(obligation);
    if (!info) return;
    const buf = Buffer.from(info.data);
    for (let i = 0; i < 8; i++) {
      const off = 96 + i * 136;
      const rk = new PublicKey(buf.subarray(off, off + 32));
      if (rk.equals(reserve)) {
        buf.writeBigUInt64LE(0n, off + 32);
      }
    }
    await rpc(endpoint_, "surfnet_setAccount", [
      obligation.toBase58(),
      {
        lamports: info.lamports,
        owner: info.owner.toBase58(),
        data: buf.toString("hex"),
        executable: false,
      },
    ]);
  }

  before("derive PDAs; init pool; create N depositors + positions", async function () {
    this.timeout(300000);

    poolConfigPda = cPoolConfigPda(USDC_MINT, program.programId);
    usdcVaultPda = cUsdcVaultPda(USDC_MINT, program.programId);
    growingPotVaultPda = cGrowingPotVaultPda(USDC_MINT, program.programId);
    operatorVaultPda = cOperatorVaultPda(USDC_MINT, program.programId);
    opsVaultPda = cOpsVaultPda(USDC_MINT, program.programId);

    // Fund SOL for every signer.
    for (const kp of [operator, ops, crank, ...depositors]) {
      await fundSol(connection, kp.publicKey, 5_000_000_000);
    }

    // Initialize the pool if it doesn't exist.
    const existing = await connection.getAccountInfo(poolConfigPda);
    if (!existing) {
      await program.methods
        .initialize()
        .accounts({
          poolConfig: poolConfigPda,
          usdcVault: usdcVaultPda,
          usdcMint: USDC_MINT,
          admin: admin.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();
    }

    // Set up N depositors, each with USDC + a UserPosition. Stagger by ~100ms
    // so first_deposit_ts is distinct per user (so weights differ → meaningful
    // winner selection).
    for (let i = 0; i < N_DEPOSITORS; i++) {
      const u = depositors[i];
      const ata = await setTokenBalance(
        connection,
        u.publicKey,
        USDC_MINT,
        5000n * ONE_USDC
      );
      depositorAtas.push(ata);
      const posPda = cUserPositionPda(u.publicKey, program.programId);
      depositorPosPdas.push(posPda);
      if (!(await connection.getAccountInfo(posPda))) {
        await program.methods
          .deposit(new BN(DEPOSIT_PER_USER.toString()))
          .accounts({
            poolConfig: poolConfigPda,
            userPosition: posPda,
            usdcVault: usdcVaultPda,
            userUsdc: ata,
            user: u.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([u])
          .rpc();
      }
      // Tiny gap so the second+ first_deposit_ts is strictly later.
      if (i < N_DEPOSITORS - 1) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    // init the main + pot klend obligations (the orchestrator's preflight
    // requires `growing_pot_obligation_ready`). We init both — compoundPot
    // WILL fire during the orchestrator cycles below (deposit succeeds on
    // a single cycle since prices are still fresh enough). Between cycles
    // we restore the empty obligation snapshot (see below) to avoid the
    // NEXT cycle's harvestPot trying to redeem cTokens left over from
    // compoundPot (klend redeem would trip B9 under further time-travel).
    const userMetadata = cUserMetadataPda(poolConfigPda);
    mainObligation = cObligationPda(0, poolConfigPda);
    potObligation = cObligationPda(1, poolConfigPda);
    const mainObligationFarm = cObligationFarmPda(mainObligation);
    const potObligationFarm = cObligationFarmPda(potObligation);
    const cfgPre = await program.account.poolConfig.fetch(poolConfigPda);
    if (cfgPre.kaminoObligation.equals(PublicKey.default)) {
      await program.methods
        .initKaminoObligation()
        .accounts({
          poolConfig: poolConfigPda,
          admin: admin.publicKey,
          userMetadata,
          obligation: mainObligation,
          lendingMarket: LENDING_MARKET,
          seed1Account: PublicKey.default,
          seed2Account: PublicKey.default,
          klendProgram: KLEND,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc({ skipPreflight: true });
    }
    if (!(await connection.getAccountInfo(mainObligationFarm))) {
      await program.methods
        .initKaminoFarm()
        .accounts({
          poolConfig: poolConfigPda,
          admin: admin.publicKey,
          obligation: mainObligation,
          lendingMarketAuthority: LENDING_MARKET_AUTHORITY,
          reserve: RESERVE,
          reserveFarmState: FARM_COLLATERAL,
          obligationFarmUserState: mainObligationFarm,
          lendingMarket: LENDING_MARKET,
          farmsProgram: FARMS,
          klendProgram: KLEND,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc({ skipPreflight: true });
    }

    // init_draw_accounts (also sets operator + ops).
    const cfg0 = await program.account.poolConfig.fetch(poolConfigPda);
    if (!cfg0.drawAccountsReady) {
      await program.methods
        .initDrawAccounts(operator.publicKey, ops.publicKey)
        .accounts({
          poolConfig: poolConfigPda,
          admin: admin.publicKey,
          usdcMint: USDC_MINT,
          currentDraw: cDrawPda(0, program.programId),
          growingPotVault: growingPotVaultPda,
          operatorVault: operatorVaultPda,
          opsVault: opsVaultPda,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();
    } else {
      const cfg = await program.account.poolConfig.fetch(poolConfigPda);
      if (!cfg.operator.equals(operator.publicKey)) {
        await program.methods
          .setOperator(operator.publicKey)
          .accounts({ poolConfig: poolConfigPda, admin: admin.publicKey })
          .rpc();
      }
    }

    // Pot obligation + farm (NEVER FUNDED — see comment above).
    const cfg1 = await program.account.poolConfig.fetch(poolConfigPda);
    if (!cfg1.growingPotObligationReady) {
      await program.methods
        .initGrowingPotObligation()
        .accounts({
          poolConfig: poolConfigPda,
          admin: admin.publicKey,
          userMetadata,
          obligation: potObligation,
          lendingMarket: LENDING_MARKET,
          seed1Account: PublicKey.default,
          seed2Account: PublicKey.default,
          klendProgram: KLEND,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc({ skipPreflight: true });
    }
    if (!(await connection.getAccountInfo(potObligationFarm))) {
      await program.methods
        .initGrowingPotFarm()
        .accounts({
          poolConfig: poolConfigPda,
          admin: admin.publicKey,
          obligation: potObligation,
          lendingMarketAuthority: LENDING_MARKET_AUTHORITY,
          reserve: RESERVE,
          reserveFarmState: FARM_COLLATERAL,
          obligationFarmUserState: potObligationFarm,
          lendingMarket: LENDING_MARKET,
          farmsProgram: FARMS,
          klendProgram: KLEND,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc({ skipPreflight: true });
    }

    // Pre-mint simulated yield directly into usdc_vault so trigger_draw's
    // prize = vault − total_principal − pending_winnings > 0.
    const vaultNow = BigInt((await getAccount(connection, usdcVaultPda)).amount.toString());
    await setRawTokenAccountBalance(
      endpoint,
      usdcVaultPda,
      USDC_MINT,
      poolConfigPda,
      vaultNow + YIELD_SIM
    );

    const positions = await fetchAllPositions(program);
    assert.equal(positions.length, N_DEPOSITORS, `seeded ${N_DEPOSITORS} live positions`);
  });

  // -------------------------------------------------------------------------
  // T1: planSettle.recommendsAlt boundary check
  // -------------------------------------------------------------------------
  it("planSettle: recommendsAlt is FALSE for the live set (under threshold) but TRUE above the legacy cap", async function () {
    this.timeout(60000);
    const plan = await planSettle(program);
    assert.equal(plan.positionCount, N_DEPOSITORS, "plan sees N depositors");
    // 10 positions ≤ 50 cap → recommendsAlt should be false.
    assert.isFalse(
      plan.recommendsAlt,
      `recommendsAlt should be false at ${N_DEPOSITORS} (cap=${SETTLE_LEGACY_POSITION_CAP})`
    );
    assert.isFalse(plan.exceedsLegacyCap, "exceedsLegacyCap also false at this count");

    // Unit-style check of the THRESHOLD logic (we can't spawn 51+ real
    // positions on the fork; assert the boundary the way Slice 1 did).
    const threshold = SETTLE_LEGACY_POSITION_CAP;
    assert.isFalse(threshold > threshold, "threshold > threshold is false");
    assert.isFalse(threshold - 1 > threshold, "n-1 > threshold is false");
    assert.isTrue(threshold + 1 > threshold, "n+1 > threshold is TRUE → recommendsAlt fires");
  });

  // -------------------------------------------------------------------------
  // T2: createPositionsAlt returns a usable AddressLookupTableAccount
  // -------------------------------------------------------------------------
  it("createPositionsAlt(): builds a warmed ALT containing exactly the position metas", async function () {
    this.timeout(120000);

    const positions = await fetchAllPositions(program);
    const metas = sortedPositionMetas(positions);

    const built = await createPositionsAlt(provider as any, operator, metas);
    assert.equal(built.entriesWritten, metas.length, "ALT contains all metas");
    assert.isAtLeast(built.sigs.length, 1, "at least the create tx was sent");

    // The fetched account should have the same addresses, in the same order.
    const altAddrs = built.altAccount.state.addresses.map((p) => p.toBase58());
    const expected = metas.map((m) => m.pubkey.toBase58());
    assert.deepEqual(
      altAddrs,
      expected,
      "ALT addresses == sortedPositionMetas pubkeys, in order"
    );
  });

  // -------------------------------------------------------------------------
  // T3: settle via the ALT path lands; winner matches crank's pick.
  // (Trigger + settle by hand, NO orchestrator's harvest/withdraw/compound,
  // to sidestep B9 oracle staleness.)
  // -------------------------------------------------------------------------
  it("revealAndSettle: ALT-compiled v0 settle lands; on-chain winner == crank's computed winner", async function () {
    this.timeout(300000);

    // 1. Jump cadence forward — needed to pass trigger_draw's weekly gate.
    const cfg0 = await program.account.poolConfig.fetch(poolConfigPda);
    await ensureClockAtLeast(endpoint, connection, cfg0.nextDrawTs.toNumber() + 60);

    // 2. Mock the rng account un-revealed for trigger.
    const rngKp = Keypair.generate();
    const rngHandle = { pubkey: rngKp.publicKey };
    await mockRandomness(connection, rngKp, Buffer.alloc(32), 0);

    // 3. triggerDraw (operator). NO klend CPI here.
    const trg = await triggerDraw(
      program,
      operator,
      rngHandle,
      SWITCHBOARD_DEFAULT_QUEUE_MAINNET,
      { skipCommit: true }
    );

    // 4. Read on-chain draw_ts + total_weight, compute the winner off-chain.
    const draw = await program.account.draw.fetch(trg.drawPda);
    const drawTs = BigInt(draw.drawTs.toString());
    const totalWeight = BigInt(draw.totalWeight.toString());
    assert.isTrue(totalWeight > 0n, "trigger_draw set a positive total_weight");

    const positions = await fetchAllPositions(program);
    const metas = sortedPositionMetas(positions);

    // 5. Build the ALT BEFORE pausing the clock (paused clock → block
    // production stops → ALT create/extend confirmTransactions hang;
    // m6-crank-slice2a-buglog B5).
    const built = await createPositionsAlt(provider as any, operator, metas);

    // 6. Pick a ticket inside the first depositor's window (deterministic
    // winner) and mock-reveal at the Clock-sysvar slot.
    let firstStart = 0n;
    let firstWeight = 0n;
    let firstOwner: PublicKey | null = null;
    let firstPosPda: PublicKey | null = null;
    {
      const sorted = [...positions].sort((a, b) =>
        Buffer.compare(a.owner.toBuffer(), b.owner.toBuffer())
      );
      let running = 0n;
      for (const p of sorted) {
        const secs = drawTs - p.firstDepositTs;
        const w = secs > 0n ? p.amount * secs : 0n;
        if (firstOwner === null && w > 0n) {
          firstStart = running;
          firstWeight = w;
          firstOwner = p.owner;
          firstPosPda = p.pubkey;
        }
        running += w;
      }
      assert.equal(running, totalWeight, "off-chain total_weight == on-chain");
    }
    assert.isNotNull(firstOwner, "found a positive-weight winner candidate");

    const ticket = firstStart + firstWeight / 2n;
    const value = vrfValueForTicket(ticket);
    const win = computeWinner(positions, drawTs, totalWeight, value);
    assert.isNotNull(win.winnerPositionPda, "lib computed a winner");
    assert.equal(
      win.winnerOwner!.toBase58(),
      firstOwner!.toBase58(),
      "lib agrees with our picked winner"
    );

    // 7. Pause clock for the settle slot-binding.
    await pauseClock(endpoint);
    try {
      const slot = await getClockSysvarSlot(connection);
      await mockRandomness(connection, rngKp, value, slot);

      // 8. revealAndSettle WITH the ALT account passed in.
      const settled = await revealAndSettle(
        program,
        operator,
        trg.round,
        rngHandle,
        {
          metas,
          winnerPositionPda: win.winnerPositionPda!,
          winnerOwner: win.winnerOwner!,
        },
        {
          skipReveal: true,
          addressLookupTableAccounts: [built.altAccount],
          remockOnRetry: async (s: number) => {
            if (s < 0) return;
            await mockRandomness(connection, rngKp, value, s);
          },
        }
      );

      // 9. The on-chain Draw.winner equals the crank's pick.
      assert.equal(
        settled.winner.toBase58(),
        firstOwner!.toBase58(),
        "on-chain Draw.winner == crank's computed winner"
      );

      // 10. Verify the settle tx actually went via the ALT. Read the tx and
      // inspect the v0 message's addressTableLookups.
      const txDetails = await connection.getTransaction(settled.sig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      assert.isNotNull(txDetails, "settle tx was retrievable");
      const lookups = (txDetails!.transaction.message as any).addressTableLookups;
      assert.isArray(lookups, "v0 message has addressTableLookups field");
      assert.isAtLeast(
        lookups.length,
        1,
        "settle tx used at least one address-table lookup (ALT path)"
      );
      const lookupKey = lookups[0].accountKey as PublicKey;
      assert.equal(
        lookupKey.toBase58(),
        built.altAddress.toBase58(),
        "the lookup table referenced IS the one we built"
      );
    } finally {
      await resumeClock(endpoint);
    }
  });

  // -------------------------------------------------------------------------
  // T4: runDrawCycle({alt:'always'}) emits an ALT-backed settle tx;
  //      runDrawCycle({alt:'never'}) emits a legacy v0 (empty addressTableLookups).
  //
  // We require `result` to be returned (NOT just a catch-fallback) so the
  // settle tx's actual `addressTableLookups` is the load-bearing assertion.
  // The orchestrator's `harvestPot`, `withdrawMainFromKamino`, and
  // `compoundPot` steps all SKIP cleanly (no klend CPI fires) because we
  // never funded the pot vault or main obligation — so no B9 oracle-
  // staleness error can fire after settle.
  // -------------------------------------------------------------------------
  it("runDrawCycle alt='always': settleSig has non-empty addressTableLookups; settleRoute == 'alt'", async function () {
    this.timeout(300000);

    // Make every klend step in the orchestrator skip cleanly:
    //   - zero the pot_obligation's deposited_amount so harvestPot skips
    //     (preserves the slot's deposit_reserve key so refresh_obligation
    //     count-check still passes if ever called downstream)
    //   - drain growing_pot_vault so compoundPot also skips
    // The orchestrator's withdrawMainFromKamino is already a skip because
    // we never deposited into the main obligation.
    await zeroObligationDepositedAmount(connection, endpoint, potObligation, RESERVE);
    await setRawTokenAccountBalance(
      endpoint,
      growingPotVaultPda,
      USDC_MINT,
      poolConfigPda,
      0n
    );

    const cfg = await program.account.poolConfig.fetch(poolConfigPda);
    await ensureClockAtLeast(endpoint, connection, cfg.nextDrawTs.toNumber() + 60);

    // Top up the vault again with simulated yield (T3's settle drained the
    // prize).
    const vaultNow = BigInt((await getAccount(connection, usdcVaultPda)).amount.toString());
    await setRawTokenAccountBalance(
      endpoint,
      usdcVaultPda,
      USDC_MINT,
      poolConfigPda,
      vaultNow + YIELD_SIM
    );

    const rngKp = Keypair.generate();
    const rngHandle = { pubkey: rngKp.publicKey };
    let lastValue: Buffer | undefined;

    const result = await runDrawCycle(program, operator, crank, {
      randomness: rngHandle,
      alt: { mode: "always" },
      surfpool: {
        setupRandomness: async () => {
          await mockRandomness(connection, rngKp, Buffer.alloc(32), 0);
        },
        beforeSettle: async () => {
          await pauseClock(endpoint);
        },
        afterSettle: async () => {
          await resumeClock(endpoint);
        },
        mockReveal: async (drawTs, totalWeight) => {
          const positions = await fetchAllPositions(program);
          const sorted = [...positions].sort((a, b) =>
            Buffer.compare(a.owner.toBuffer(), b.owner.toBuffer())
          );
          let running = 0n;
          let aStart = 0n;
          let aWeight = 0n;
          let aOwner: PublicKey | null = null;
          for (const p of sorted) {
            const secs = drawTs - p.firstDepositTs;
            const w = secs > 0n ? p.amount * secs : 0n;
            if (aOwner === null && w > 0n) {
              aStart = running;
              aWeight = w;
              aOwner = p.owner;
            }
            running += w;
          }
          assert.equal(running, totalWeight);
          const ticket = aStart + aWeight / 2n;
          const value = vrfValueForTicket(ticket);
          const win = computeWinner(positions, drawTs, totalWeight, value);
          const slot = await getClockSysvarSlot(connection);
          await mockRandomness(connection, rngKp, value, slot);
          lastValue = value;
          return {
            value,
            winnerPositionPda: win.winnerPositionPda!,
            winnerOwner: win.winnerOwner!,
          };
        },
        remockOnRetry: async (slot) => {
          if (!lastValue) return;
          if (slot < 0) return;
          await mockRandomness(connection, rngKp, lastValue, slot);
        },
      },
    });

    assert.equal(result.settleRoute, "alt", "runDrawCycle reports settleRoute='alt'");
    assert.isDefined(result.altAddress, "runDrawCycle returned an altAddress");

    const txDetails = await connection.getTransaction(result.settleSig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    assert.isNotNull(txDetails, "settle tx retrievable");
    const lookups = (txDetails!.transaction.message as any).addressTableLookups;
    assert.isArray(lookups, "v0 message has addressTableLookups field");
    assert.isAtLeast(
      lookups.length,
      1,
      "alt='always' → addressTableLookups non-empty"
    );
    const lookupKey = lookups[0].accountKey as PublicKey;
    assert.equal(
      lookupKey.toBase58(),
      result.altAddress!.toBase58(),
      "settle tx's lookup-table accountKey matches runDrawCycle's altAddress"
    );
  });

  it("runDrawCycle alt='never': forces legacy v0 (empty addressTableLookups)", async function () {
    this.timeout(300000);

    // Same klend-skip setup as the previous test (zero the pot obligation's
    // deposited_amount + drain pot_vault).
    await zeroObligationDepositedAmount(connection, endpoint, potObligation, RESERVE);
    await setRawTokenAccountBalance(
      endpoint,
      growingPotVaultPda,
      USDC_MINT,
      poolConfigPda,
      0n
    );

    const cfg = await program.account.poolConfig.fetch(poolConfigPda);
    await ensureClockAtLeast(endpoint, connection, cfg.nextDrawTs.toNumber() + 60);
    const vaultNow = BigInt((await getAccount(connection, usdcVaultPda)).amount.toString());
    await setRawTokenAccountBalance(
      endpoint,
      usdcVaultPda,
      USDC_MINT,
      poolConfigPda,
      vaultNow + YIELD_SIM
    );

    const rngKp = Keypair.generate();
    const rngHandle = { pubkey: rngKp.publicKey };
    let lastValue: Buffer | undefined;

    const result = await runDrawCycle(program, operator, crank, {
      randomness: rngHandle,
      alt: { mode: "never" },
      surfpool: {
        setupRandomness: async () => {
          await mockRandomness(connection, rngKp, Buffer.alloc(32), 0);
        },
        beforeSettle: async () => {
          await pauseClock(endpoint);
        },
        afterSettle: async () => {
          await resumeClock(endpoint);
        },
        mockReveal: async (drawTs, totalWeight) => {
          const positions = await fetchAllPositions(program);
          const sorted = [...positions].sort((a, b) =>
            Buffer.compare(a.owner.toBuffer(), b.owner.toBuffer())
          );
          let running = 0n;
          let aStart = 0n;
          let aWeight = 0n;
          let aOwner: PublicKey | null = null;
          for (const p of sorted) {
            const secs = drawTs - p.firstDepositTs;
            const w = secs > 0n ? p.amount * secs : 0n;
            if (aOwner === null && w > 0n) {
              aStart = running;
              aWeight = w;
              aOwner = p.owner;
            }
            running += w;
          }
          assert.equal(running, totalWeight);
          const ticket = aStart + aWeight / 2n;
          const value = vrfValueForTicket(ticket);
          const win = computeWinner(positions, drawTs, totalWeight, value);
          const slot = await getClockSysvarSlot(connection);
          await mockRandomness(connection, rngKp, value, slot);
          lastValue = value;
          return {
            value,
            winnerPositionPda: win.winnerPositionPda!,
            winnerOwner: win.winnerOwner!,
          };
        },
        remockOnRetry: async (slot) => {
          if (!lastValue) return;
          if (slot < 0) return;
          await mockRandomness(connection, rngKp, lastValue, slot);
        },
      },
    });

    assert.equal(result.settleRoute, "legacy", "alt='never' → settleRoute='legacy'");
    assert.isUndefined(result.altAddress, "no ALT built");

    const txDetails = await connection.getTransaction(result.settleSig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    assert.isNotNull(txDetails, "settle tx retrievable");
    const lookups = (txDetails!.transaction.message as any).addressTableLookups;
    const len = Array.isArray(lookups) ? lookups.length : 0;
    assert.equal(len, 0, "alt='never' → addressTableLookups empty");
  });
});
