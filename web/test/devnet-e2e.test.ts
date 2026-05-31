import { describe, it, expect, beforeAll } from "vitest";
import { AnchorProvider, Wallet, BN } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotent, mintTo, getAccount, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import fs from "fs";
import os from "os";
import path from "path";
import { getProgram, deposit, readPosition } from "../lib/stewfi";
import { USDC_MINT, RPC_URL } from "../lib/constants";

// Skips unless RUN_DEVNET_E2E=1 (needs a funded devnet keypair + bootstrapped pool).
const RUN = process.env.RUN_DEVNET_E2E === "1";

describe.runIf(RUN)("devnet e2e: faucet -> deposit -> read back", () => {
  let program: ReturnType<typeof getProgram>;
  let user: Keypair;
  beforeAll(async () => {
    const conn = new Connection(RPC_URL, "confirmed");
    user = Keypair.generate();

    // Fund user via transfer from admin keypair (avoids airdrop rate limits).
    const adminPath = path.join(os.homedir(), ".config", "solana", "id.json");
    const admin = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(fs.readFileSync(adminPath, "utf8")))
    );
    const fundTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: admin.publicKey,
        toPubkey: user.publicKey,
        lamports: 0.05 * LAMPORTS_PER_SOL, // ATA rent + tx fees
      })
    );
    await sendAndConfirmTransaction(conn, fundTx, [admin], { commitment: "confirmed" });

    program = getProgram(conn, new Wallet(user));
    // mint test-USDC to the user using the faucet authority
    const faucet = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(fs.readFileSync("../.faucet-authority.json", "utf8"))));
    const ata = await createAssociatedTokenAccountIdempotent(conn, user, USDC_MINT, user.publicKey);
    await mintTo(conn, user, USDC_MINT, ata, faucet, 100_000_000); // 100 USDC
  });

  it("a real deposit lands on-chain", async () => {
    await deposit(program, user.publicKey, new BN(10_000_000)); // 10 USDC
    const pos = await readPosition(program, user.publicKey);
    expect(pos).not.toBeNull();
    expect(pos!.amount.toString()).toBe("10000000");
  });
});
