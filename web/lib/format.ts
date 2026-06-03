import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { USDC_DECIMALS } from "./constants";
const SCALE = 10 ** USDC_DECIMALS;

export function fmtUsdc(baseUnits: BN | bigint | number): string {
  const n = Number(baseUnits.toString()) / SCALE;
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export function toBaseUnits(human: number): BN {
  return new BN(Math.round(human * SCALE));
}

/** Abbreviate a base58 public key as "AAAA…ZZZZ". */
export function abbrev(pubkey: string | PublicKey): string {
  const s = typeof pubkey === "string" ? pubkey : pubkey.toBase58();
  return s.slice(0, 4) + "…" + s.slice(-4);
}
