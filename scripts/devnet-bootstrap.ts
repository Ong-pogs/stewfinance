/**
 * One-time devnet bootstrap for the thin demo.
 *  1. create a 6-decimal test-USDC mint (mint authority = a fresh faucet keypair)
 *  2. initialize() the StewFi pool_config seeded by that mint
 *  3. publish the on-chain IDL (idempotent)
 *  4. print env values for web/.env.local
 *
 * Run: ANCHOR_WALLET=~/.config/solana/id.json \
 *      ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *      yarn ts-node scripts/devnet-bootstrap.ts
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import { createMint, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

const PROGRAM_ID = new PublicKey(
  "8uDmfYPMBaiLLwfZGAnhNaDm48kx19hD8kPdiR7XiRLD"
);

function pda(seeds: (Buffer | Uint8Array)[]) {
  return PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
}

// Load the IDL from the file (avoids a resolveJsonModule tsconfig dependency;
// mirrors scripts/devnet-smoke.ts).
function loadIdl(): anchor.Idl {
  return JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "..", "target", "idl", "stewfi.json"),
      "utf-8"
    )
  );
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const admin = (provider.wallet as anchor.Wallet).payer;
  const program = new Program(loadIdl(), provider);

  // 1. faucet authority + test-USDC mint (6 decimals, like real USDC)
  const faucetAuthority = Keypair.generate();
  const mint = await createMint(
    provider.connection,
    admin,
    faucetAuthority.publicKey,
    null,
    6
  );
  console.log("test-USDC mint:", mint.toBase58());

  // 2. initialize the pool (seeded by this mint)
  const poolConfig = pda([Buffer.from("pool_config"), mint.toBuffer()]);
  const usdcVault = pda([Buffer.from("usdc_vault"), mint.toBuffer()]);
  await program.methods
    .initialize()
    .accountsPartial({
      poolConfig,
      usdcVault,
      usdcMint: mint,
      admin: admin.publicKey,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();
  console.log("pool_config:", poolConfig.toBase58());

  // 3. publish IDL (idempotent — ignore "already exists" from Task 1)
  try {
    const { execSync } = require("child_process");
    execSync(
      `anchor idl init ${PROGRAM_ID.toBase58()} -f target/idl/stewfi.json --provider.cluster devnet --provider.wallet ${process.env.ANCHOR_WALLET}`,
      { stdio: "inherit" }
    );
  } catch (e) {
    console.log("idl init skipped (already published):", (e as Error).message);
  }

  // 4. emit env
  const faucetSecret = `[${Array.from(faucetAuthority.secretKey).join(",")}]`;
  fs.writeFileSync(".faucet-authority.json", faucetSecret);
  console.log("\n=== paste into web/.env.local ===");
  console.log(`NEXT_PUBLIC_RPC_URL=https://api.devnet.solana.com`);
  console.log(`NEXT_PUBLIC_PROGRAM_ID=${PROGRAM_ID.toBase58()}`);
  console.log(`NEXT_PUBLIC_USDC_MINT=${mint.toBase58()}`);
  console.log(`FAUCET_MINT_AUTHORITY_SECRET=${faucetSecret}`);
  console.log(
    "(also saved faucet secret to .faucet-authority.json — gitignored)"
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
