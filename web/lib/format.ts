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

/** easeOutCubic — fast then settling; pleasant for a count-up tween. */
export function easeOutCubic(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - c, 3);
}

/**
 * Interpolate `from`→`to` at progress `t` (0..1) with easeOutCubic.
 * Clamps t to [0,1]; t>=1 returns exactly `to` (no float drift on settle).
 */
export function tween(from: number, to: number, t: number): number {
  if (t >= 1) return to;
  if (t <= 0) return from;
  return from + (to - from) * easeOutCubic(t);
}
