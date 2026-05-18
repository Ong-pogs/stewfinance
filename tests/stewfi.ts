import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Stewfi } from "../target/types/stewfi";
import {
  createMint,
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

describe("stewfi — M1 (foundation: initialize)", () => {
  // Use whatever provider Anchor.toml points to (localnet by default).
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Stewfi as Program<Stewfi>;
  const connection = provider.connection;

  // Test-scoped state — fresh for each `anchor test` run.
  let admin: Keypair;
  let usdcMint: PublicKey;
  let poolConfigPda: PublicKey;
  let poolConfigBump: number;
  let usdcVaultPda: PublicKey;

  before("set up admin + test USDC mint + derive PDAs", async () => {
    // Generate a fresh admin keypair for this test. NOT the wallet from Anchor.toml —
    // we want each test run reproducible from zero. The provider wallet pays for some
    // infra (validator deploy), but our test admin owns the protocol.
    admin = Keypair.generate();

    // Fund the admin with SOL so they can pay rent on the PDAs we're about to create.
    // On local validator, requestAirdrop is unlimited; on devnet it's rate-limited.
    const airdropSig = await connection.requestAirdrop(
      admin.publicKey,
      2 * LAMPORTS_PER_SOL
    );
    await connection.confirmTransaction(airdropSig, "confirmed");

    // Create a test USDC mint. 6 decimals to match the real USDC mint format.
    // Admin is both payer and mint authority — fine for tests.
    usdcMint = await createMint(
      connection,
      admin, // payer
      admin.publicKey, // mint authority
      null, // freeze authority (none)
      6 // decimals
    );

    // Derive PoolConfig PDA. Must match the seeds in lib.rs exactly.
    [poolConfigPda, poolConfigBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool_config"), usdcMint.toBuffer()],
      program.programId
    );

    // Derive the USDC vault PDA. Same pattern, different seed.
    [usdcVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("usdc_vault"), usdcMint.toBuffer()],
      program.programId
    );
  });

  it("initializes the pool", async () => {
    // Call the on-chain `initialize` instruction. Anchor's `methods` builder reads
    // the IDL and gives us a type-safe RPC call.
    const txSig = await program.methods
      .initialize()
      .accounts({
        poolConfig: poolConfigPda,
        usdcVault: usdcVaultPda,
        usdcMint: usdcMint,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([admin])
      .rpc();

    console.log("    initialize tx:", txSig);

    // Fetch the on-chain PoolConfig back and prove its fields match what we set.
    const config = await program.account.poolConfig.fetch(poolConfigPda);

    assert.equal(
      config.admin.toBase58(),
      admin.publicKey.toBase58(),
      "admin must match the signer"
    );
    assert.equal(
      config.usdcMint.toBase58(),
      usdcMint.toBase58(),
      "usdc_mint must match"
    );
    assert.equal(
      config.usdcVault.toBase58(),
      usdcVaultPda.toBase58(),
      "usdc_vault must match the derived PDA"
    );
    assert.isFalse(config.paused, "paused must default to false");
    assert.equal(
      config.currentRound.toNumber(),
      0,
      "current_round must start at 0"
    );
    assert.equal(
      config.bump,
      poolConfigBump,
      "stored bump must match the derived bump"
    );
  });

  it("rejects re-initialization (init constraint enforces single-init)", async () => {
    // Calling `initialize` again on the same usdc_mint must fail — the `init`
    // constraint in lib.rs rejects existing accounts. This protects us from
    // an attacker calling initialize a second time to overwrite the admin.
    try {
      await program.methods
        .initialize()
        .accounts({
          poolConfig: poolConfigPda,
          usdcVault: usdcVaultPda,
          usdcMint: usdcMint,
          admin: admin.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([admin])
        .rpc();

      assert.fail("Re-initialization should have thrown");
    } catch (err: any) {
      // The error message contains "already in use" when the System Program
      // rejects re-creating an existing account. Different Anchor versions
      // surface this slightly differently, so we check the broad shape.
      const message = err.toString();
      const looksLikeReinitError =
        message.includes("already in use") ||
        message.includes("0x0") ||
        message.toLowerCase().includes("custom program error");
      assert.isTrue(
        looksLikeReinitError,
        `expected re-init failure, got: ${message}`
      );
    }
  });
});
