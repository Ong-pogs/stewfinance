import { NextRequest, NextResponse } from "next/server";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotent, mintTo } from "@solana/spl-token";

const FAUCET_AMOUNT = Math.round(Number(process.env.FAUCET_AMOUNT ?? "100") * 1_000_000); // 6 dec
if (!Number.isFinite(FAUCET_AMOUNT) || FAUCET_AMOUNT <= 0) {
  throw new Error("bad FAUCET_AMOUNT");
}
const SOL_TOPUP_THRESHOLD = 10_000_000; // 0.01 SOL — below this, top the wallet up
const SOL_TOPUP_AMOUNT = 20_000_000; // 0.02 SOL — enough for rent + a few txs
const seen = new Map<string, number>(); // wallet -> last mint ms (per-instance rate limit)

export async function POST(req: NextRequest) {
  try {
    const { wallet } = await req.json();
    if (typeof wallet !== "string" || !wallet) {
      return NextResponse.json({ ok: false, error: "invalid_wallet" }, { status: 400 });
    }
    const last = seen.get(wallet) ?? 0;
    if (Date.now() - last < 60_000) {
      return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
    }
    // Reserve the rate-limit slot synchronously, before any await, so concurrent
    // same-wallet requests can't all pass the 60s gate and double-mint (TOCTOU).
    seen.set(wallet, Date.now());
    let user: PublicKey;
    try {
      user = new PublicKey(wallet);
    } catch {
      seen.delete(wallet); // roll back: no mint happened
      return NextResponse.json({ ok: false, error: "invalid_wallet" }, { status: 400 });
    }
    const conn = new Connection(process.env.NEXT_PUBLIC_RPC_URL!, "confirmed");
    const mint = new PublicKey(process.env.NEXT_PUBLIC_USDC_MINT!);
    const authority = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(process.env.FAUCET_MINT_AUTHORITY_SECRET!)));

    // Give a little SOL too if the wallet is low (rent + tx fees). Devnet
    // requestAirdrop is rate-limited and flaky, so fund directly from the
    // faucet authority via SystemProgram.transfer. Best-effort: a transfer
    // failure must NOT block the USDC mint below.
    let solSig: string | null = null;
    try {
      const bal = await conn.getBalance(user);
      if (bal < SOL_TOPUP_THRESHOLD) {
        const tx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: authority.publicKey,
            toPubkey: user,
            lamports: SOL_TOPUP_AMOUNT,
          }),
        );
        solSig = await conn.sendTransaction(tx, [authority]);
        await conn.confirmTransaction(solSig, "confirmed");
      }
    } catch {
      // swallow — USDC mint is the primary purpose of the faucet
      solSig = null;
    }

    const ata = await createAssociatedTokenAccountIdempotent(conn, authority, mint, user);
    const sig = await mintTo(conn, authority, mint, ata, authority, FAUCET_AMOUNT);
    seen.set(wallet, Date.now());
    return NextResponse.json({ ok: true, sig, solSig });
  } catch {
    return NextResponse.json({ ok: false, error: "faucet_failed" }, { status: 500 });
  }
}
