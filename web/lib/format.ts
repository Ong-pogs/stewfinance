import { BN } from "@coral-xyz/anchor";
import { USDC_DECIMALS } from "./constants";
const SCALE = 10 ** USDC_DECIMALS;

export function fmtUsdc(baseUnits: BN | bigint | number): string {
  const n = Number(baseUnits.toString()) / SCALE;
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export function toBaseUnits(human: number): BN {
  return new BN(Math.round(human * SCALE));
}
