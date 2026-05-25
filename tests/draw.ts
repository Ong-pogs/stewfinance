/**
 * M4 — The Weekly DRAW (Switchboard VRF + weighted winner + prize split) E2E.
 *
 * Runs against a surfpool **offline** simnet (NOT a mainnet fork — the draw
 * logic is independent of Kamino; no real reserve needed). Randomness is MOCKED:
 * we write a `RandomnessAccountData` buffer directly with surfpool's
 * `surfnet_setAccount` cheatcode (data = hex string, owner = Switchboard
 * On-Demand mainnet PID), choosing a known `value` so the weighted winner is
 * deterministic. See .superstack/m4-research.md §6 and m4-buglog.md F0/B*.
 *
 * Slot-binding (the hard part): `settle_draw` calls
 * `RandomnessAccountData::get_value(clock.slot)`, which only returns the value
 * when `clock.slot == reveal_slot`. We PAUSE surfpool's clock (`surfnet_pauseClock`)
 * so the slot is frozen, set `reveal_slot` to the frozen slot, then settle in
 * that slot. A small retry walks nearby slots in case getSlot != the slot the tx
 * observes (offset-robust). Cadence (7-day gate) is jumped with
 * `surfnet_timeTravel({absoluteTimestamp})`.
 *
 * Prereq to run (see package.json `test:draw`):
 *   surfpool start --offline --no-tui --no-deploy --no-studio -a <admin-pubkey>
 *   solana program deploy target/deploy/stewfi.so --url http://127.0.0.1:8899
 */
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Stewfi } from "../target/types/stewfi";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { assert } from "chai";

// Switchboard On-Demand mainnet program id — the owner RandomnessAccountData
// resolves to at runtime (StewFi doesn't enable the `devnet` feature). See
// m4-buglog.md F0c.
const SWITCHBOARD_ON_DEMAND_PID = new PublicKey(
  "SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv"
);
// RandomnessAccountData: 8-byte disc + 400-byte body = 408 bytes.
const RANDOMNESS_DISCRIMINATOR = [10, 66, 229, 135, 220, 239, 217, 114];
const RANDOMNESS_ACCOUNT_SIZE = 408;
// Field byte offsets (post-disc) in the account data buffer.
const OFF_REVEAL_SLOT = 144; // u64 LE
const OFF_VALUE = 152; // [u8; 32]

const ONE_USDC = 1_000_000;

// ---------------------------------------------------------------------------
// surfpool cheatcode helpers
// ---------------------------------------------------------------------------
async function rpc(endpoint: string, method: string, params: any[]): Promise<any> {
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await resp.json();
  if (json.error) {
    throw new Error(`${method} failed: ${JSON.stringify(json.error)}`);
  }
  return json.result;
}

/**
 * Build a RandomnessAccountData buffer with a chosen 32-byte `value` and
 * `reveal_slot`, then write it to `pubkey` via surfnet_setAccount (owner =
 * Switchboard On-Demand PID). `data` is hex-encoded (surfpool's AccountUpdate
 * schema; verified — m4-buglog.md F-surfpool).
 */
async function setMockRandomness(
  endpoint: string,
  pubkey: PublicKey,
  value: Buffer,
  revealSlot: number | bigint
): Promise<void> {
  const buf = Buffer.alloc(RANDOMNESS_ACCOUNT_SIZE);
  Buffer.from(RANDOMNESS_DISCRIMINATOR).copy(buf, 0);
  buf.writeBigUInt64LE(BigInt(revealSlot), OFF_REVEAL_SLOT);
  value.copy(buf, OFF_VALUE, 0, Math.min(32, value.length));
  await rpc(endpoint, "surfnet_setAccount", [
    pubkey.toBase58(),
    {
      lamports: 5_000_000,
      owner: SWITCHBOARD_ON_DEMAND_PID.toBase58(),
      data: buf.toString("hex"),
      executable: false,
    },
  ]);
}

/** Build an un-revealed (reveal_slot = 0) randomness account for commit. */
async function setUnrevealedRandomness(
  endpoint: string,
  pubkey: PublicKey
): Promise<void> {
  await setMockRandomness(endpoint, pubkey, Buffer.alloc(32), 0);
}

const pauseClock = (endpoint: string) => rpc(endpoint, "surfnet_pauseClock", []);
const resumeClock = (endpoint: string) => rpc(endpoint, "surfnet_resumeClock", []);

/**
 * Build the `remaining_accounts` list settle_draw needs: ALL live UserPosition
 * PDAs, in the CANONICAL order the program enforces — ascending by the position
 * OWNER's pubkey (the `user` field). The crank derives this off-chain; here we
 * sort by each owner's pubkey bytes and map to the position PDA. Each entry is
 * non-signer, writable=false (settle only reads positions).
 */
function sortedPositionMetas(
  entries: { owner: PublicKey; pos: PublicKey }[]
): { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] {
  return [...entries]
    .sort((a, b) => Buffer.compare(a.owner.toBuffer(), b.owner.toBuffer()))
    .map((e) => ({ pubkey: e.pos, isSigner: false, isWritable: false }));
}

/**
 * Read the Clock sysvar's `slot` field — exactly what the program observes via
 * `Clock::get().slot`. This is NOT the same as the `getSlot()` RPC, which lags
 * by ~30 slots on surfpool (m4-buglog.md B5). Use THIS for reveal_slot binding.
 */
async function getClockSysvarSlot(
  connection: anchor.web3.Connection
): Promise<number> {
  const CLOCK = new PublicKey("SysvarC1ock11111111111111111111111111111111");
  const info = await connection.getAccountInfo(CLOCK);
  if (!info) throw new Error("Clock sysvar not found");
  return Number(info.data.readBigUInt64LE(0));
}

/**
 * Run settle_draw with deterministic slot-binding: pause the clock, read the
 * Clock-sysvar slot, mock the revealed randomness with reveal_slot == that slot
 * (walking a small ± window for safety), submit settle, then resume the clock.
 * Throws the underlying error if it's anything other than the slot mismatch.
 */
async function settleWithSlotBinding(
  program: Program<Stewfi>,
  connection: anchor.web3.Connection,
  endpoint: string,
  randomnessPk: PublicKey,
  vrfValue: Buffer,
  buildSettle: () => any // returns a MethodsBuilder ready to .rpc()
): Promise<void> {
  await pauseClock(endpoint);
  try {
    const base = await getClockSysvarSlot(connection);
    let lastErr: any;
    for (const candidate of [base, base + 1, base - 1, base + 2, base + 3, base - 2]) {
      if (candidate < 0) continue;
      await setMockRandomness(endpoint, randomnessPk, vrfValue, candidate);
      try {
        await buildSettle().rpc();
        return;
      } catch (err: any) {
        lastErr = err;
        if (!err.toString().includes("RandomnessNotResolved")) throw err;
      }
    }
    throw lastErr;
  } finally {
    await resumeClock(endpoint);
  }
}
/**
 * Ensure the on-chain clock is at least `unixSeconds`. NOTE: surfnet_timeTravel's
 * `absoluteTimestamp` is in MILLISECONDS (the on-chain Clock.unix_timestamp is
 * seconds) — see m4-buglog.md B2 — so we ×1000. surfpool refuses to travel to a
 * PAST time, so we no-op if the clock is already at/after the target.
 */
async function ensureClockAtLeast(
  endpoint: string,
  connection: anchor.web3.Connection,
  unixSeconds: number
): Promise<void> {
  const blockTime = await connection.getBlockTime(await connection.getSlot());
  if (blockTime !== null && blockTime >= unixSeconds) return; // already past
  await rpc(endpoint, "surfnet_timeTravel", [
    { absoluteTimestamp: unixSeconds * 1000 },
  ]);
}

// ---------------------------------------------------------------------------

describe("stewfi — M4 DRAW (surfpool offline + mock randomness)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Stewfi as Program<Stewfi>;
  const connection = provider.connection;
  const endpoint = connection.rpcEndpoint;

  // admin = provider wallet (surfpool-airdropped).
  const admin = (provider.wallet as anchor.Wallet).payer;

  // Operator + ops payout wallets.
  const operator = Keypair.generate();
  const ops = Keypair.generate();

  let usdcMint: PublicKey;
  let poolConfigPda: PublicKey;
  let usdcVaultPda: PublicKey;
  let growingPotVaultPda: PublicKey;
  let operatorVaultPda: PublicKey;
  let opsVaultPda: PublicKey;

  // Two users with different amounts + deposit times → different weights.
  // userA deposits FIRST (older first_deposit_ts → more seconds_held) and MORE.
  let userA: Keypair;
  let userB: Keypair;
  let userAUsdc: PublicKey;
  let userBUsdc: PublicKey;
  let userAPos: PublicKey;
  let userBPos: PublicKey;

  const drawPda = (round: number) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("draw"), new BN(round).toArrayLike(Buffer, "le", 8)],
      program.programId
    )[0];

  before("set up pool, users, deposits, draw accounts", async function () {
    this.timeout(120000);

    // Fund operator/ops/users with SOL.
    for (const kp of [operator, ops]) {
      const sig = await connection.requestAirdrop(kp.publicKey, LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, "confirmed");
    }

    usdcMint = await createMint(connection, admin, admin.publicKey, null, 6);

    [poolConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool_config"), usdcMint.toBuffer()],
      program.programId
    );
    [usdcVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("usdc_vault"), usdcMint.toBuffer()],
      program.programId
    );
    [growingPotVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("growing_pot_vault"), usdcMint.toBuffer()],
      program.programId
    );
    [operatorVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("operator_vault"), usdcMint.toBuffer()],
      program.programId
    );
    [opsVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("ops_vault"), usdcMint.toBuffer()],
      program.programId
    );

    await program.methods
      .initialize()
      .accounts({
        poolConfig: poolConfigPda,
        usdcVault: usdcVaultPda,
        usdcMint,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    // --- users + deposits (userA first/more, userB later/less) -------------
    userA = Keypair.generate();
    userB = Keypair.generate();
    for (const kp of [userA, userB]) {
      const sig = await connection.requestAirdrop(kp.publicKey, LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, "confirmed");
    }
    userAUsdc = (
      await getOrCreateAssociatedTokenAccount(connection, admin, usdcMint, userA.publicKey)
    ).address;
    userBUsdc = (
      await getOrCreateAssociatedTokenAccount(connection, admin, usdcMint, userB.publicKey)
    ).address;
    await mintTo(connection, admin, usdcMint, userAUsdc, admin, 5_000 * ONE_USDC);
    await mintTo(connection, admin, usdcMint, userBUsdc, admin, 5_000 * ONE_USDC);

    [userAPos] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_position"), userA.publicKey.toBuffer()],
      program.programId
    );
    [userBPos] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_position"), userB.publicKey.toBuffer()],
      program.programId
    );

    // userA deposits 1000 USDC FIRST.
    await program.methods
      .deposit(new BN(1000 * ONE_USDC))
      .accounts({
        poolConfig: poolConfigPda,
        userPosition: userAPos,
        usdcVault: usdcVaultPda,
        userUsdc: userAUsdc,
        user: userA.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([userA])
      .rpc();

    // Small delay so userB's first_deposit_ts is strictly later.
    await new Promise((r) => setTimeout(r, 1500));

    // userB deposits 500 USDC LATER.
    await program.methods
      .deposit(new BN(500 * ONE_USDC))
      .accounts({
        poolConfig: poolConfigPda,
        userPosition: userBPos,
        usdcVault: usdcVaultPda,
        userUsdc: userBUsdc,
        user: userB.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([userB])
      .rpc();
  });

  it("init_draw_accounts creates vaults + round-0 Draw + arms cadence", async function () {
    this.timeout(60000);
    await program.methods
      .initDrawAccounts(operator.publicKey, ops.publicKey)
      .accounts({
        poolConfig: poolConfigPda,
        admin: admin.publicKey,
        usdcMint,
        currentDraw: drawPda(0),
        growingPotVault: growingPotVaultPda,
        operatorVault: operatorVaultPda,
        opsVault: opsVaultPda,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const cfg = await program.account.poolConfig.fetch(poolConfigPda);
    assert.equal(cfg.operator.toBase58(), operator.publicKey.toBase58());
    assert.equal(cfg.ops.toBase58(), ops.publicKey.toBase58());
    assert.isTrue(cfg.drawAccountsReady);
    assert.isAbove(cfg.nextDrawTs.toNumber(), 0);
    // total_principal should equal 1500 USDC from the two deposits.
    assert.equal(cfg.totalPrincipal.toNumber(), 1500 * ONE_USDC);

    const draw0 = await program.account.draw.fetch(drawPda(0));
    assert.equal(draw0.round.toNumber(), 0);
    assert.deepEqual(draw0.status, { pending: {} });

    // The three escrow vaults exist with zero balance.
    for (const v of [growingPotVaultPda, operatorVaultPda, opsVaultPda]) {
      const acc = await getAccount(connection, v);
      assert.equal(Number(acc.amount), 0);
    }
  });

  it("set_paused toggles paused (audit F-02 fix)", async function () {
    this.timeout(30000);
    await program.methods
      .setPaused(true)
      .accounts({ poolConfig: poolConfigPda, admin: admin.publicKey })
      .rpc();
    let cfg = await program.account.poolConfig.fetch(poolConfigPda);
    assert.isTrue(cfg.paused);

    await program.methods
      .setPaused(false)
      .accounts({ poolConfig: poolConfigPda, admin: admin.publicKey })
      .rpc();
    cfg = await program.account.poolConfig.fetch(poolConfigPda);
    assert.isFalse(cfg.paused);
  });

  it("trigger_draw rejected before next_draw_ts (cadence gate)", async function () {
    this.timeout(60000);
    const rnd = Keypair.generate();
    await setUnrevealedRandomness(endpoint, rnd.publicKey);
    try {
      await program.methods
        .triggerDraw()
        .accounts({
          crank: operator.publicKey,
          poolConfig: poolConfigPda,
          currentDraw: drawPda(0),
          usdcVault: usdcVaultPda,
          randomnessAccount: rnd.publicKey,
        })
        .signers([operator])
        .rpc();
      assert.fail("expected DrawNotReady");
    } catch (err: any) {
      assert.include(err.toString(), "DrawNotReady");
    }
  });

  // -------------------------------------------------------------------------
  // The end-to-end happy path: simulate yield, jump time, trigger, mock-reveal,
  // settle, assert weighted winner + 65/20/10/5 split + round advance + claim.
  // -------------------------------------------------------------------------
  let randomnessKp: Keypair;
  let prizeAtCommit: number;
  // The VRF value for the happy path is COMPUTED at settle time so the ticket
  // deterministically lands in userA's on-chain cumulative window (regardless of
  // the random ascending-pubkey sort order the program uses). See the settle test.

  /**
   * Replicate the program's on-chain winner derivation off-chain (the crank's
   * job): sort live positions ascending by owner pubkey, accumulate
   * weight = amount × (draw_ts − first_deposit_ts), and return each position's
   * [cumBefore, cumBefore+weight) window. Mirrors settle_draw exactly.
   */
  async function computeWindows(drawRound: number) {
    const draw = await program.account.draw.fetch(drawPda(drawRound));
    const drawTs = BigInt(draw.drawTs.toString());
    const entries = [
      { owner: userA.publicKey, pos: userAPos },
      { owner: userB.publicKey, pos: userBPos },
    ].sort((a, b) => Buffer.compare(a.owner.toBuffer(), b.owner.toBuffer()));
    let running = 0n;
    const windows: { owner: PublicKey; pos: PublicKey; start: bigint; weight: bigint }[] = [];
    for (const e of entries) {
      const p = await program.account.userPosition.fetch(e.pos);
      const secs = drawTs - BigInt(p.firstDepositTs.toString());
      const weight = secs > 0n ? BigInt(p.amount.toString()) * secs : 0n;
      windows.push({ owner: e.owner, pos: e.pos, start: running, weight });
      running += weight;
    }
    return { windows, total: running, totalWeight: BigInt(draw.totalWeight.toString()) };
  }

  /** Build a 32-byte VRF value whose ticket = (u128 LE of [0..16]) % total == target. */
  function vrfValueForTicket(target: bigint): Buffer {
    const buf = Buffer.alloc(32);
    buf.writeBigUInt64LE(target & 0xffffffffffffffffn, 0);
    buf.writeBigUInt64LE((target >> 64n) & 0xffffffffffffffffn, 8);
    return buf;
  }

  it("trigger_draw commits the round (after simulating yield + time jump)", async function () {
    this.timeout(120000);

    // Simulate harvested yield: mint 30 USDC straight into the usdc_vault so
    // prize = vault − principal − pending = 30 USDC. (Stands in for a Kamino
    // harvest; the draw is yield-source-agnostic.)
    await mintTo(connection, admin, usdcMint, usdcVaultPda, admin, 30 * ONE_USDC);

    // Jump past the weekly cadence gate.
    const cfg = await program.account.poolConfig.fetch(poolConfigPda);
    await ensureClockAtLeast(endpoint, connection, cfg.nextDrawTs.toNumber() + 60);

    randomnessKp = Keypair.generate();
    await setUnrevealedRandomness(endpoint, randomnessKp.publicKey);

    await program.methods
      .triggerDraw()
      .accounts({
        crank: operator.publicKey,
        poolConfig: poolConfigPda,
        currentDraw: drawPda(0),
        usdcVault: usdcVaultPda,
        randomnessAccount: randomnessKp.publicKey,
      })
      .signers([operator])
      .rpc();

    const draw = await program.account.draw.fetch(drawPda(0));
    assert.deepEqual(draw.status, { committed: {} });
    assert.equal(
      draw.randomnessAccount.toBase58(),
      randomnessKp.publicKey.toBase58()
    );
    assert.equal(draw.prizePool.toNumber(), 30 * ONE_USDC, "prize = 30 USDC yield");
    assert.isTrue(draw.totalWeight.gt(new BN(0)), "total_weight computed on-chain");
    prizeAtCommit = draw.prizePool.toNumber();

    const cfgAfter = await program.account.poolConfig.fetch(poolConfigPda);
    assert.isTrue(cfgAfter.drawInProgress, "deposits locked during draw");
  });

  it("deposit/withdraw blocked while draw in progress", async function () {
    this.timeout(60000);
    try {
      await program.methods
        .deposit(new BN(10 * ONE_USDC))
        .accounts({
          poolConfig: poolConfigPda,
          userPosition: userBPos,
          usdcVault: usdcVaultPda,
          userUsdc: userBUsdc,
          user: userB.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([userB])
        .rpc();
      assert.fail("expected DrawInProgress");
    } catch (err: any) {
      assert.include(err.toString(), "DrawInProgress");
    }
  });

  it("settle_draw picks the weighted winner + splits 65/20/10/5 + advances round", async function () {
    this.timeout(120000);

    // The winner is now DERIVED ON-CHAIN from the full position set — there is
    // no winner_cum_start arg to pass. The program orders positions ascending by
    // owner pubkey and accumulates real weights; the winner is whichever window
    // contains the ticket. We replicate that off-chain (the crank's job), pick a
    // ticket INSIDE userA's window, and craft a VRF value yielding that ticket —
    // so userA deterministically wins regardless of the random pubkey sort.
    const { windows, total } = await computeWindows(0);
    const aWin = windows.find((w) => w.pos.equals(userAPos))!;
    assert.isTrue(aWin.weight > 0n, "userA has positive weight");
    // ticket = middle of userA's window → unambiguously inside it.
    const ticket = aWin.start + aWin.weight / 2n;
    assert.isTrue(ticket < total, "ticket within total weight");
    const vrfValue = vrfValueForTicket(ticket);

    const winnerPos = userAPos;
    const positions = sortedPositionMetas([
      { owner: userA.publicKey, pos: userAPos },
      { owner: userB.publicKey, pos: userBPos },
    ]);

    // Slot-binding via the shared helper (pause clock, bind reveal_slot to the
    // Clock-sysvar slot, settle, resume). Ticket crafted to land in userA's window.
    await settleWithSlotBinding(
      program,
      connection,
      endpoint,
      randomnessKp.publicKey,
      vrfValue,
      () =>
        program.methods
          .settleDraw()
          .accounts({
            crank: operator.publicKey,
            poolConfig: poolConfigPda,
            currentDraw: drawPda(0),
            nextDraw: drawPda(1),
            randomnessAccount: randomnessKp.publicKey,
            winnerPosition: winnerPos,
            usdcVault: usdcVaultPda,
            growingPotVault: growingPotVaultPda,
            operatorVault: operatorVaultPda,
            opsVault: opsVaultPda,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .remainingAccounts(positions)
          .signers([operator])
    );

    // --- assert the split math (prize = 30 USDC) -------------------------
    const prize = prizeAtCommit;
    const growingPot = Math.floor((prize * 2000) / 10000); // 20%
    const operatorCut = Math.floor((prize * 1000) / 10000); // 10%
    const opsCut = Math.floor((prize * 500) / 10000); //  5%
    const winnerAmount = prize - growingPot - operatorCut - opsCut; // 65% + dust

    const draw = await program.account.draw.fetch(drawPda(0));
    assert.deepEqual(draw.status, { settled: {} });
    assert.equal(
      draw.winner.toBase58(),
      userA.publicKey.toBase58(),
      "weighted winner is userA (largest + longest-held)"
    );
    assert.equal(draw.winnerAmount.toNumber(), winnerAmount, "winner 65% + dust");
    assert.equal(draw.growingPotAmount.toNumber(), growingPot, "pot 20%");
    assert.equal(draw.operatorAmount.toNumber(), operatorCut, "operator 10%");
    assert.equal(draw.opsAmount.toNumber(), opsCut, "ops 5%");

    // --- assert the vaults actually received their slices ----------------
    const potBal = await getAccount(connection, growingPotVaultPda);
    const opBal = await getAccount(connection, operatorVaultPda);
    const opsBal = await getAccount(connection, opsVaultPda);
    assert.equal(Number(potBal.amount), growingPot, "growing_pot_vault got 20%");
    assert.equal(Number(opBal.amount), operatorCut, "operator_vault got 10%");
    assert.equal(Number(opsBal.amount), opsCut, "ops_vault got 5%");

    // --- round advanced + next Draw created + unlocked -------------------
    const cfg = await program.account.poolConfig.fetch(poolConfigPda);
    assert.equal(cfg.currentRound.toNumber(), 1, "round advanced to 1");
    assert.isFalse(cfg.drawInProgress, "deposits unlocked after settle");
    assert.equal(
      cfg.pendingWinnings.toNumber(),
      winnerAmount,
      "winner prize tracked as pending until claimed"
    );

    const draw1 = await program.account.draw.fetch(drawPda(1));
    assert.equal(draw1.round.toNumber(), 1);
    assert.deepEqual(draw1.status, { pending: {} });

    // --- winner's 65% still sits in usdc_vault (claimable) --------------
    // vault = principal(1500) + winner_amount(unclaimed) after 20/10/5 left.
    const vault = await getAccount(connection, usdcVaultPda);
    assert.equal(
      Number(vault.amount),
      1500 * ONE_USDC + winnerAmount,
      "usdc_vault = principal + unclaimed winner prize"
    );
  });

  it("claim_draw pays the winner their 65%", async function () {
    this.timeout(60000);
    const draw = await program.account.draw.fetch(drawPda(0));
    const winnerAmount = draw.winnerAmount.toNumber();

    const winnerAtaBefore = await getAccount(connection, userAUsdc);

    await program.methods
      .claimDraw(new BN(0))
      .accounts({
        winner: userA.publicKey,
        poolConfig: poolConfigPda,
        draw: drawPda(0),
        usdcVault: usdcVaultPda,
        winnerUsdc: userAUsdc,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([userA])
      .rpc();

    const winnerAtaAfter = await getAccount(connection, userAUsdc);
    assert.equal(
      Number(winnerAtaAfter.amount - winnerAtaBefore.amount),
      winnerAmount,
      "winner received their 65%"
    );

    const drawAfter = await program.account.draw.fetch(drawPda(0));
    assert.deepEqual(drawAfter.status, { claimed: {} });
    assert.isTrue(drawAfter.winnerClaimed);

    const cfg = await program.account.poolConfig.fetch(poolConfigPda);
    assert.equal(cfg.pendingWinnings.toNumber(), 0, "pending winnings cleared");

    // Vault back to exactly principal.
    const vault = await getAccount(connection, usdcVaultPda);
    assert.equal(Number(vault.amount), 1500 * ONE_USDC, "vault back to principal");
  });

  it("claim_draw rejects a non-winner", async function () {
    this.timeout(60000);
    // (Round 0 already claimed; status is Claimed, not Settled → also guarded.
    //  Use userB against round 0 to prove the winner-mismatch / status guard.)
    try {
      await program.methods
        .claimDraw(new BN(0))
        .accounts({
          winner: userB.publicKey,
          poolConfig: poolConfigPda,
          draw: drawPda(0),
          usdcVault: usdcVaultPda,
          winnerUsdc: userBUsdc,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([userB])
        .rpc();
      assert.fail("expected claim by non-winner to fail");
    } catch (err: any) {
      const s = err.toString();
      assert.isTrue(
        s.includes("BadWinnerProof") || s.includes("InvalidDrawStatus"),
        `expected winner/status guard, got: ${s}`
      );
    }
  });

  // -------------------------------------------------------------------------
  // Round 1: the SECURITY test — prove an operator CANNOT rig the winner.
  //
  // This is the test that was missing. The old hole: settle_draw trusted an
  // operator-supplied `winner_cum_start`, so the operator could set it = ticket
  // and steer the win to ANY funded position. That arg is gone; the winner is
  // now DERIVED on-chain from the full position set + a completeness check.
  // Two exploit attempts, BOTH must be rejected:
  //   (A) pass a NON-winning position as winner_position (complete set) → the
  //       on-chain-derived winner won't match it → BadWinnerProof.
  //   (B) pass the TRUE winner but an INCOMPLETE remaining_accounts set (omit a
  //       position) → summed weight < total_weight → IncompletePositionSet.
  // -------------------------------------------------------------------------
  it("settle_draw rejects an operator trying to rig the winner (closes the trust hole)", async function () {
    this.timeout(120000);

    // Trigger round 1. Need fresh yield + time jump.
    await mintTo(connection, admin, usdcMint, usdcVaultPda, admin, 20 * ONE_USDC);
    const cfg = await program.account.poolConfig.fetch(poolConfigPda);
    await ensureClockAtLeast(endpoint, connection, cfg.nextDrawTs.toNumber() + 60);

    const rnd = Keypair.generate();
    await setUnrevealedRandomness(endpoint, rnd.publicKey);
    await program.methods
      .triggerDraw()
      .accounts({
        crank: operator.publicKey,
        poolConfig: poolConfigPda,
        currentDraw: drawPda(1),
        usdcVault: usdcVaultPda,
        randomnessAccount: rnd.publicKey,
      })
      .signers([operator])
      .rpc();

    // Compute the TRUE winner for round 1: craft a ticket inside userA's window,
    // so the honest result is userA. The operator will try to make userB win.
    const { windows, total } = await computeWindows(1);
    const aWin = windows.find((w) => w.pos.equals(userAPos))!;
    const ticket = aWin.start + aWin.weight / 2n; // squarely in userA's window
    const vrfValue = vrfValueForTicket(ticket);
    const fullPositions = sortedPositionMetas([
      { owner: userA.publicKey, pos: userAPos },
      { owner: userB.publicKey, pos: userBPos },
    ]);

    // --- Exploit A: claim the NON-winner (userB) with a COMPLETE set --------
    // This is exactly the old attack ("steer the win"). On-chain derivation says
    // userA → mismatch → BadWinnerProof. settleWithSlotBinding walks slots until
    // the reveal resolves, so the rethrown error is the real winner-proof error.
    let sawBadProof = false;
    try {
      await settleWithSlotBinding(
        program,
        connection,
        endpoint,
        rnd.publicKey,
        vrfValue,
        () =>
          program.methods
            .settleDraw()
            .accounts({
              crank: operator.publicKey,
              poolConfig: poolConfigPda,
              currentDraw: drawPda(1),
              nextDraw: drawPda(2),
              randomnessAccount: rnd.publicKey,
              winnerPosition: userBPos, // WRONG winner — userA truly won
              usdcVault: usdcVaultPda,
              growingPotVault: growingPotVaultPda,
              operatorVault: operatorVaultPda,
              opsVault: opsVaultPda,
              tokenProgram: TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .remainingAccounts(fullPositions)
            .signers([operator])
      );
      assert.fail("settle_draw let the operator pick a non-winner");
    } catch (err: any) {
      assert.include(
        err.toString(),
        "BadWinnerProof",
        "expected BadWinnerProof when operator names the wrong winner"
      );
      sawBadProof = true;
    }
    assert.isTrue(sawBadProof, "Exploit A (steer winner) must be rejected");

    // --- Exploit B: TRUE winner but INCOMPLETE set (omit userB) -------------
    // Dropping a position makes summed weight < total_weight → completeness fails.
    const onlyUserA = sortedPositionMetas([
      { owner: userA.publicKey, pos: userAPos },
    ]);
    let sawIncomplete = false;
    try {
      await settleWithSlotBinding(
        program,
        connection,
        endpoint,
        rnd.publicKey,
        vrfValue,
        () =>
          program.methods
            .settleDraw()
            .accounts({
              crank: operator.publicKey,
              poolConfig: poolConfigPda,
              currentDraw: drawPda(1),
              nextDraw: drawPda(2),
              randomnessAccount: rnd.publicKey,
              winnerPosition: userAPos, // correct winner...
              usdcVault: usdcVaultPda,
              growingPotVault: growingPotVaultPda,
              operatorVault: operatorVaultPda,
              opsVault: opsVaultPda,
              tokenProgram: TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .remainingAccounts(onlyUserA) // ...but the set is incomplete
            .signers([operator])
      );
      assert.fail("settle_draw accepted an incomplete position set");
    } catch (err: any) {
      assert.include(
        err.toString(),
        "IncompletePositionSet",
        "expected IncompletePositionSet when a live position is omitted"
      );
      sawIncomplete = true;
    }
    assert.isTrue(sawIncomplete, "Exploit B (incomplete set) must be rejected");
  });

  it("cancel_draw unlocks a stuck round (admin escape hatch)", async function () {
    this.timeout(60000);
    // Round 1 is still Committed (the bogus settle above failed). Admin cancels.
    await program.methods
      .cancelDraw()
      .accounts({
        admin: admin.publicKey,
        poolConfig: poolConfigPda,
        currentDraw: drawPda(1),
      })
      .rpc();

    const draw = await program.account.draw.fetch(drawPda(1));
    assert.deepEqual(draw.status, { pending: {} });
    assert.equal(draw.randomnessAccount.toBase58(), PublicKey.default.toBase58());

    const cfg = await program.account.poolConfig.fetch(poolConfigPda);
    assert.isFalse(cfg.drawInProgress, "draw_in_progress cleared by cancel");

    // Deposits work again after cancel.
    await program.methods
      .deposit(new BN(10 * ONE_USDC))
      .accounts({
        poolConfig: poolConfigPda,
        userPosition: userBPos,
        usdcVault: usdcVaultPda,
        userUsdc: userBUsdc,
        user: userB.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([userB])
      .rpc();
    const cfg2 = await program.account.poolConfig.fetch(poolConfigPda);
    assert.equal(cfg2.totalPrincipal.toNumber(), 1510 * ONE_USDC);
  });
});
