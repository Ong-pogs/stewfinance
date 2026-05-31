/**
 * Devnet smoke test for the DEPLOYED StewFi program.
 *
 * Proves M1 (initialize) + M2 (deposit / top-up / request_withdraw) work against
 * the program live on devnet at 8uDmfYPMBaiLLwfZGAnhNaDm48kx19hD8kPdiR7XiRLD.
 *
 * Funding model (devnet airdrops are rate-limited, so we avoid them):
 *   - id.json (G6emPd5...) is the funded fee-payer AND pool admin / mint authority.
 *   - A fresh ephemeral user keypair is funded by a small SOL transfer from id.json
 *     (enough for ATA rent + a couple of tx fees), NOT by an airdrop.
 *
 * Run: yarn run ts-node scripts/devnet-smoke.ts
 *      (or: node_modules/.bin/ts-node scripts/devnet-smoke.ts)
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
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  LAMPORTS_PER_SOL,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { strict as assert } from "assert";

const PROGRAM_ID = new PublicKey(
  "8uDmfYPMBaiLLwfZGAnhNaDm48kx19hD8kPdiR7XiRLD"
);
const DEVNET = "https://api.devnet.solana.com";
const ONE_USDC = 1_000_000;

function loadKeypair(p: string): Keypair {
  const raw = JSON.parse(
    fs.readFileSync(p.replace("~", os.homedir()), "utf-8")
  );
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function loadIdl(): anchor.Idl {
  const idlPath = path.join(__dirname, "..", "target", "idl", "stewfi.json");
  return JSON.parse(fs.readFileSync(idlPath, "utf-8"));
}

async function main() {
  const connection = new Connection(DEVNET, "confirmed");

  // Admin / fee-payer = the funded devnet keypair.
  const admin = loadKeypair("~/.config/solana/id.json");
  console.log("Admin / fee-payer:", admin.publicKey.toBase58());
  const adminBal = await connection.getBalance(admin.publicKey);
  console.log("Admin balance:", adminBal / LAMPORTS_PER_SOL, "SOL");
  assert(
    adminBal > 0.5 * LAMPORTS_PER_SOL,
    "admin must hold > 0.5 SOL on devnet"
  );

  const wallet = new anchor.Wallet(admin);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  const idl = loadIdl();
  const program = new Program(idl as any, provider) as Program<Stewfi>;
  assert.equal(
    program.programId.toBase58(),
    PROGRAM_ID.toBase58(),
    "IDL program id must match the deployed program"
  );
  console.log("Program id (from IDL):", program.programId.toBase58());

  // ---------------------------------------------------------------------------
  // Fund a fresh ephemeral user via transfer (no airdrop).
  // ---------------------------------------------------------------------------
  const user = Keypair.generate();
  console.log("\nFresh test user:", user.publicKey.toBase58());
  const fundUserSig = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: admin.publicKey,
        toPubkey: user.publicKey,
        lamports: 0.05 * LAMPORTS_PER_SOL, // ATA rent + a few tx fees
      })
    ),
    [admin],
    { commitment: "confirmed" }
  );
  console.log("Funded user 0.05 SOL, sig:", fundUserSig);

  // ---------------------------------------------------------------------------
  // Create a devnet test-USDC mint (6 decimals), admin is mint authority.
  // ---------------------------------------------------------------------------
  const usdcMint = await createMint(
    connection,
    admin,
    admin.publicKey,
    null,
    6
  );
  console.log("\nTest-USDC mint:", usdcMint.toBase58());

  const [poolConfigPda, poolConfigBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_config"), usdcMint.toBuffer()],
    program.programId
  );
  const [usdcVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("usdc_vault"), usdcMint.toBuffer()],
    program.programId
  );
  const [userPositionPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("user_position"), user.publicKey.toBuffer()],
    program.programId
  );
  console.log("PoolConfig PDA:", poolConfigPda.toBase58());
  console.log("USDC vault PDA:", usdcVaultPda.toBase58());

  // ===========================================================================
  // M1 — initialize
  // ===========================================================================
  console.log("\n=== M1: initialize ===");
  const initSig = await program.methods
    .initialize()
    .accountsPartial({
      poolConfig: poolConfigPda,
      usdcVault: usdcVaultPda,
      usdcMint: usdcMint,
      admin: admin.publicKey,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();
  console.log("initialize sig:", initSig);

  const cfg = await program.account.poolConfig.fetch(poolConfigPda);
  assert.equal(cfg.admin.toBase58(), admin.publicKey.toBase58());
  assert.equal(cfg.usdcMint.toBase58(), usdcMint.toBase58());
  assert.equal(cfg.usdcVault.toBase58(), usdcVaultPda.toBase58());
  assert.equal(cfg.paused, false);
  assert.equal(cfg.currentRound.toNumber(), 0);
  assert.equal(cfg.bump, poolConfigBump);
  assert(cfg.usdcVaultBump > 0, "usdc_vault_bump set");
  // M3 fields exist + default on a fresh pool:
  assert.equal(
    cfg.kaminoObligation.toBase58(),
    PublicKey.default.toBase58(),
    "kamino_obligation defaults to Pubkey::default()"
  );
  assert.equal(cfg.kaminoDeposited.toNumber(), 0, "kamino_deposited starts 0");
  console.log("  PoolConfig state OK (admin/mint/vault/paused/round/bump)");
  console.log("  M3 fields present: kamino_obligation=default, kamino_deposited=0");

  // ===========================================================================
  // M2 — deposit / top-up / request_withdraw
  // ===========================================================================
  // Mint test USDC to the user.
  const userAta = await getOrCreateAssociatedTokenAccount(
    connection,
    admin, // fee-payer for ATA creation
    usdcMint,
    user.publicKey
  );
  await mintTo(
    connection,
    admin,
    usdcMint,
    userAta.address,
    admin,
    1_000 * ONE_USDC
  );
  console.log("\nMinted 1,000 test-USDC to user ATA:", userAta.address.toBase58());

  // --- happy-path deposit (100 USDC) ---
  console.log("\n=== M2: deposit 100 USDC ===");
  const vaultBefore = await getAccount(connection, usdcVaultPda).catch(
    () => ({ amount: BigInt(0) } as any)
  );
  const depSig = await program.methods
    .deposit(new BN(100 * ONE_USDC))
    .accountsPartial({
      poolConfig: poolConfigPda,
      userPosition: userPositionPda,
      usdcVault: usdcVaultPda,
      userUsdc: userAta.address,
      user: user.publicKey,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([user])
    .rpc();
  console.log("deposit sig:", depSig);

  let pos = await program.account.userPosition.fetch(userPositionPda);
  assert.equal(pos.user.toBase58(), user.publicKey.toBase58());
  assert.equal(pos.amount.toNumber(), 100 * ONE_USDC, "position amount = 100");
  assert(pos.firstDepositTs.toNumber() > 0, "first_deposit_ts set");
  assert.equal(pos.withdrawRequestedAt.toNumber(), 0, "no withdraw pending");
  const vaultAfter = await getAccount(connection, usdcVaultPda);
  assert.equal(
    Number(vaultAfter.amount - BigInt(vaultBefore.amount)),
    100 * ONE_USDC,
    "vault gained 100 USDC"
  );
  console.log("  UserPosition created, vault gained 100 USDC");

  // --- top-up (+50 USDC -> 150) ---
  console.log("\n=== M2: top-up +50 USDC ===");
  const firstTs = pos.firstDepositTs.toNumber();
  await new Promise((r) => setTimeout(r, 1500)); // let last_deposit_ts diverge
  const topupSig = await program.methods
    .deposit(new BN(50 * ONE_USDC))
    .accountsPartial({
      poolConfig: poolConfigPda,
      userPosition: userPositionPda,
      usdcVault: usdcVaultPda,
      userUsdc: userAta.address,
      user: user.publicKey,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([user])
    .rpc();
  console.log("top-up sig:", topupSig);
  pos = await program.account.userPosition.fetch(userPositionPda);
  assert.equal(pos.amount.toNumber(), 150 * ONE_USDC, "amount now 150");
  assert.equal(
    pos.firstDepositTs.toNumber(),
    firstTs,
    "first_deposit_ts sticky on top-up"
  );
  assert(
    pos.lastDepositTs.toNumber() >= pos.firstDepositTs.toNumber(),
    "last_deposit_ts advanced"
  );
  console.log("  Position topped up to 150 USDC; first_deposit_ts sticky");

  // --- reject deposit below MIN_DEPOSIT (negative test, fresh user) ---
  console.log("\n=== M2: reject deposit below 10 USDC (5 USDC) ===");
  const user2 = Keypair.generate();
  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: admin.publicKey,
        toPubkey: user2.publicKey,
        lamports: 0.03 * LAMPORTS_PER_SOL,
      })
    ),
    [admin],
    { commitment: "confirmed" }
  );
  const user2Ata = await getOrCreateAssociatedTokenAccount(
    connection,
    admin,
    usdcMint,
    user2.publicKey
  );
  await mintTo(connection, admin, usdcMint, user2Ata.address, admin, 100 * ONE_USDC);
  const [user2PosPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("user_position"), user2.publicKey.toBuffer()],
    program.programId
  );
  let rejectedSmall = false;
  try {
    await program.methods
      .deposit(new BN(5 * ONE_USDC))
      .accountsPartial({
        poolConfig: poolConfigPda,
        userPosition: user2PosPda,
        usdcVault: usdcVaultPda,
        userUsdc: user2Ata.address,
        user: user2.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user2])
      .rpc();
  } catch (e: any) {
    rejectedSmall = e.toString().includes("DepositTooSmall");
  }
  assert(rejectedSmall, "5 USDC deposit must be rejected with DepositTooSmall");
  console.log("  Correctly rejected with DepositTooSmall");

  // --- request_withdraw (starts the 24h cooldown; no funds move) ---
  console.log("\n=== M2: request_withdraw ===");
  const reqSig = await program.methods
    .requestWithdraw()
    .accountsPartial({
      userPosition: userPositionPda,
      user: user.publicKey,
    })
    .signers([user])
    .rpc();
  console.log("request_withdraw sig:", reqSig);
  pos = await program.account.userPosition.fetch(userPositionPda);
  assert(
    pos.withdrawRequestedAt.toNumber() > 0,
    "withdraw_requested_at set"
  );
  console.log(
    "  withdraw_requested_at set ->",
    pos.withdrawRequestedAt.toNumber()
  );

  // --- withdraw before cooldown must fail (proves the 24h guard on-chain) ---
  console.log("\n=== M2: withdraw before 24h cooldown must fail ===");
  let cooldownBlocked = false;
  try {
    await program.methods
      .withdraw()
      .accountsPartial({
        poolConfig: poolConfigPda,
        userPosition: userPositionPda,
        usdcVault: usdcVaultPda,
        userUsdc: userAta.address,
        user: user.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user])
      .rpc();
  } catch (e: any) {
    cooldownBlocked = e.toString().includes("WithdrawCooldownActive");
  }
  assert(cooldownBlocked, "withdraw must be blocked by WithdrawCooldownActive");
  console.log("  Correctly blocked with WithdrawCooldownActive (24h guard live)");

  // ===========================================================================
  // M3+ — presence check against the ON-CHAIN IDL (not the local file).
  // This is the real "is the deployed program current?" gate: it reads the IDL
  // actually published on devnet for this program, so a stale deploy cannot pass
  // (the old version read the local target/idl file — a false positive).
  // ===========================================================================
  console.log("\n=== M3+: instruction presence (ON-CHAIN IDL) ===");
  const onChainIdl = await Program.fetchIdl(PROGRAM_ID, provider);
  if (!onChainIdl) {
    throw new Error(
      `No on-chain IDL for ${PROGRAM_ID.toBase58()} on devnet. ` +
        "Run `anchor idl init -f target/idl/stewfi.json` (or devnet-bootstrap) first."
    );
  }
  const norm = (s: string) => s.replace(/_/g, "").toLowerCase();
  const ixNames = onChainIdl.instructions.map((i: any) => norm(i.name));
  const required = [
    "initialize", "deposit", "requestWithdraw", "withdraw",
    "depositToKamino", "withdrawFromKamino", "triggerDraw",
    "settleDraw", "claimDraw", "compoundGrowingPot", "harvestGrowingPotYield",
  ];
  const missing = required.filter((n) => !ixNames.includes(norm(n)));
  if (missing.length) {
    throw new Error(
      `Deployed program's on-chain IDL is missing instructions: ${missing.join(", ")} ` +
        `(stale deploy?). On-chain IDL has ${onChainIdl.instructions.length} instructions.`
    );
  }
  console.log(
    `  On-chain IDL OK — ${onChainIdl.instructions.length} instructions present ` +
      "(all M1–M5 required instructions found on devnet)."
  );

  console.log("\n========================================");
  console.log("DEVNET SMOKE TEST PASSED ✓");
  console.log("  M1 initialize: OK");
  console.log("  M2 deposit / top-up / min-bound / request_withdraw / cooldown-guard: OK");
  console.log("  M3 instructions present in IDL (E2E needs mainnet reserves): OK");
  console.log("========================================");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("\nSMOKE TEST FAILED:");
    console.error(err);
    if (err?.logs) console.error("LOGS:\n" + err.logs.join("\n"));
    process.exit(1);
  }
);
