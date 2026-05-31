import { NextRequest, NextResponse } from "next/server";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotent, mintTo } from "@solana/spl-token";

const FAUCET_AMOUNT = Number(process.env.FAUCET_AMOUNT ?? "100") * 1_000_000; // 6 dec
const seen = new Map<string, number>(); // wallet -> last mint ms (per-instance rate limit)

export async function POST(req: NextRequest) {
  try {
    const { wallet } = await req.json();
    const user = new PublicKey(wallet);
    const last = seen.get(wallet) ?? 0;
    if (Date.now() - last < 60_000) {
      return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
    }
    const conn = new Connection(process.env.NEXT_PUBLIC_RPC_URL!, "confirmed");
    const mint = new PublicKey(process.env.NEXT_PUBLIC_USDC_MINT!);
    const authority = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(process.env.FAUCET_MINT_AUTHORITY_SECRET!)));
    // give a little SOL too if the wallet is empty (rent + fees)
    const bal = await conn.getBalance(user);
    if (bal < 5_000_000) {
      try { await conn.confirmTransaction(await conn.requestAirdrop(user, 50_000_000)); } catch {}
    }
    const ata = await createAssociatedTokenAccountIdempotent(conn, authority, mint, user);
    const sig = await mintTo(conn, authority, mint, ata, authority, FAUCET_AMOUNT);
    seen.set(wallet, Date.now());
    return NextResponse.json({ ok: true, sig });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
