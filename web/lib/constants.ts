import { PublicKey } from "@solana/web3.js";
// Fallbacks = the live devnet demo values, so Node/vitest contexts work without
// Next's .env injection; the browser uses the build-injected NEXT_PUBLIC_* values.
export const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_PROGRAM_ID ?? "8uDmfYPMBaiLLwfZGAnhNaDm48kx19hD8kPdiR7XiRLD"
);
export const USDC_MINT = new PublicKey(
  process.env.NEXT_PUBLIC_USDC_MINT ?? "4RZDNG97iQosLLiGCkJFvVH2wcjmf14EXFftdVwre1qJ"
);
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? "https://api.devnet.solana.com";
export const USDC_DECIMALS = 6;
export const MIN_DEPOSIT_UI = 10;
export const MAX_DEPOSIT_UI = 5000;
export const DRAW_INTERVAL_SECS = 7 * 24 * 60 * 60;
export const MOCK_APY = 0.06;
