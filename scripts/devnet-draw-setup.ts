/**
 * Devnet draw setup (one-time / idempotent): arm the draw machinery on the demo
 * pool so a live Switchboard VRF draw can run, and seed a synthetic prize.
 *
 *  1. init_draw_accounts(operator=ops=admin) — creates the round-0 Draw + the
 *     growing_pot / operator / ops vaults, sets draw_accounts_ready, arms cadence.
 *     (admin is used as operator+ops for the devnet demo; trigger/settle accept
 *      admin OR operator, so no separate operator keypair is needed.)
 *  2. set_next_draw_ts(now) — open the draw immediately (init arms it +7 days).
 *  3. ensure >= 1 aged position (creates a controllable demo depositor if none
 *     exist) so total_weight > 0.
 *  4. inject a synthetic prize: mint test-USDC straight into usdc_vault. Devnet
 *     has no Kamino yield, so prize = usdc_vault − total_principal − pending.
 *
 * Run:
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   yarn ts-node scripts/devnet-draw-setup.ts
 */
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  LAMPORTS_PER_SOL,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Stewfi } from "../target/types/stewfi";
import * as fs from "fs";
import * as path from "path";

const PROGRAM_ID = new PublicKey("8uDmfYPMBaiLLwfZGAnhNaDm48kx19hD8kPdiR7XiRLD");
const MINT = new PublicKey("4RZDNG97iQosLLiGCkJFvVH2wcjmf14EXFftdVwre1qJ");
const ONE_USDC = 1_000_000;
const PRIZE_USDC = 20; // synthetic devnet prize injected into usdc_vault

function pda(seeds: (Buffer | Uint8Array)[]) {
  return PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
}
function loadIdl(): anchor.Idl {
  return JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "target", "idl", "stewfi.json"), "utf-8")
  );
}
function loadSecretArray(p: string): Keypair {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf-8")))
  );
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const admin = (provider.wallet as anchor.Wallet).payer;
  const program = new Program(loadIdl() as any, provider) as Program<Stewfi>;
  const conn = provider.connection;

  const poolConfig = pda([Buffer.from("pool_config"), MINT.toBuffer()]);
  const usdcVault = pda([Buffer.from("usdc_vault"), MINT.toBuffer()]);
  const growingPotVault = pda([Buffer.from("growing_pot_vault"), MINT.toBuffer()]);
  const operatorVault = pda([Buffer.from("operator_vault"), MINT.toBuffer()]);
  const opsVault = pda([Buffer.from("ops_vault"), MINT.toBuffer()]);
  const draw0 = pda([Buffer.from("draw"), new BN(0).toArrayLike(Buffer, "le", 8)]);

  // The mint authority for the test-USDC mint (also the faucet authority).
  const faucetAuth = loadSecretArray(
    path.join(__dirname, "..", ".faucet-authority.json")
  );

  // --- 1. init_draw_accounts (idempotent) ----------------------------------
  let cfg: any = await program.account.poolConfig.fetch(poolConfig);
  if (!cfg.drawAccountsReady) {
    await program.methods
      .initDrawAccounts(admin.publicKey, admin.publicKey)
      .accountsPartial({
        poolConfig,
        admin: admin.publicKey,
        usdcMint: MINT,
        currentDraw: draw0,
        growingPotVault,
        operatorVault,
        opsVault,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();
    console.log("init_draw_accounts: done (operator=ops=admin)");
  } else {
    console.log("init_draw_accounts: already initialized (skipping)");
  }

  // --- 2. set_next_draw_ts(now) --------------------------------------------
  const now = Math.floor(Date.now() / 1000);
  await program.methods
    .setNextDrawTs(new BN(now))
    .accountsPartial({ poolConfig, admin: admin.publicKey })
    .rpc();
  console.log("set_next_draw_ts:", now, "(draw open now)");

  // --- 3. ensure >= 1 aged position ----------------------------------------
  let positions = await program.account.userPosition.all();
  if (positions.length === 0) {
    console.log("no positions found — creating a controllable demo depositor");
    const demoPath = path.join(__dirname, "..", ".demo-user.json");
    let demo: Keypair;
    if (fs.existsSync(demoPath)) {
      demo = loadSecretArray(demoPath);
    } else {
      demo = Keypair.generate();
      fs.writeFileSync(demoPath, `[${Array.from(demo.secretKey).join(",")}]`);
    }
    // fund SOL for fees + ATA rent
    await sendAndConfirmTransaction(
      conn,
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: admin.publicKey,
          toPubkey: demo.publicKey,
          lamports: 0.05 * LAMPORTS_PER_SOL,
        })
      ),
      [admin],
      { commitment: "confirmed" }
    );
    // mint test-USDC to the demo user + deposit 50
    const demoAta = await getOrCreateAssociatedTokenAccount(
      conn,
      admin,
      MINT,
      demo.publicKey
    );
    await mintTo(conn, admin, MINT, demoAta.address, faucetAuth, 100 * ONE_USDC);
    const demoPos = pda([Buffer.from("user_position"), demo.publicKey.toBuffer()]);
    await program.methods
      .deposit(new BN(50 * ONE_USDC))
      .accountsPartial({
        poolConfig,
        userPosition: demoPos,
        usdcVault,
        userUsdc: demoAta.address,
        user: demo.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([demo])
      .rpc();
    console.log("demo depositor created + deposited 50 USDC:", demo.publicKey.toBase58());
    console.log("(secret saved to .demo-user.json — gitignored)");
    positions = await program.account.userPosition.all();
  }
  console.log("live positions:", positions.length);

  // --- 4. inject synthetic prize into usdc_vault ---------------------------
  cfg = await program.account.poolConfig.fetch(poolConfig);
  await mintTo(conn, admin, MINT, usdcVault, faucetAuth, PRIZE_USDC * ONE_USDC);
  const vault = await getAccount(conn, usdcVault);
  const totalPrincipal = BigInt(cfg.totalPrincipal.toString());
  const pending = BigInt(cfg.pendingWinnings.toString());
  const prize = vault.amount - totalPrincipal - pending;
  console.log("\n=== draw-ready state ===");
  console.log("usdc_vault balance :", Number(vault.amount) / ONE_USDC, "USDC");
  console.log("total_principal    :", Number(totalPrincipal) / ONE_USDC, "USDC");
  console.log("pending_winnings   :", Number(pending) / ONE_USDC, "USDC");
  console.log("=> prize_pool       :", Number(prize) / ONE_USDC, "USDC");
  console.log("current_round      :", cfg.currentRound.toString());
  console.log("draw_accounts_ready:", cfg.drawAccountsReady);
  if (prize <= 0n) console.log("WARNING: prize <= 0 — trigger_draw will reject (NothingToDraw)");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
