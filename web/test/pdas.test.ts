import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { poolConfigPda, usdcVaultPda, userPositionPda } from "../lib/pdas";

const PID = new PublicKey("8uDmfYPMBaiLLwfZGAnhNaDm48kx19hD8kPdiR7XiRLD");
const MINT = new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
const USER = new PublicKey("11111111111111111111111111111111");

describe("pdas", () => {
  it("pool_config = [b'pool_config', mint]", () => {
    const expected = PublicKey.findProgramAddressSync(
      [Buffer.from("pool_config"), MINT.toBuffer()], PID)[0];
    expect(poolConfigPda(MINT, PID).toBase58()).toBe(expected.toBase58());
  });
  it("usdc_vault = [b'usdc_vault', mint]", () => {
    const expected = PublicKey.findProgramAddressSync(
      [Buffer.from("usdc_vault"), MINT.toBuffer()], PID)[0];
    expect(usdcVaultPda(MINT, PID).toBase58()).toBe(expected.toBase58());
  });
  it("user_position = [b'user_position', user]", () => {
    const expected = PublicKey.findProgramAddressSync(
      [Buffer.from("user_position"), USER.toBuffer()], PID)[0];
    expect(userPositionPda(USER, PID).toBase58()).toBe(expected.toBase58());
  });
});
