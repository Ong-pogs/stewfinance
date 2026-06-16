/**
 * Non-destructive on-chain verification of BUG-8 fix (set_next_draw_ts back-date guard).
 *
 * Attempts to set next_draw_ts 1 day in the PAST. The deployed program must
 * reject it with StewfiError::BackdatedTimestamp (6037). Because the tx fails,
 * no state changes — we also assert nextDrawTs is unchanged after the attempt.
 *
 * Run:
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   yarn ts-node scripts/verify-backdate.ts
 */
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { Stewfi } from "../target/types/stewfi";
import * as fs from "fs";
import * as path from "path";

const PROGRAM_ID = new PublicKey("8uDmfYPMBaiLLwfZGAnhNaDm48kx19hD8kPdiR7XiRLD");
const MINT = new PublicKey("4RZDNG97iQosLLiGCkJFvVH2wcjmf14EXFftdVwre1qJ");

function pda(seeds: (Buffer | Uint8Array)[]) {
  return PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
}
function loadIdl(): anchor.Idl {
  return JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "target", "idl", "stewfi.json"), "utf-8")
  );
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const admin = (provider.wallet as anchor.Wallet).payer!;
  const program = new Program(loadIdl() as any, provider) as Program<Stewfi>;
  const poolConfig = pda([Buffer.from("pool_config"), MINT.toBuffer()]);

  const cfg: any = await program.account.poolConfig.fetch(poolConfig);
  const now = Math.floor(Date.now() / 1000);
  const backdated = now - 86400; // 1 day in the past
  console.log(
    "current nextDrawTs:", cfg.nextDrawTs.toString(),
    "| now:", now,
    "| backdated attempt:", backdated
  );

  let rejected = false;
  let errInfo = "";
  try {
    await program.methods
      .setNextDrawTs(new BN(backdated))
      .accountsPartial({ poolConfig, admin: admin.publicKey })
      .rpc();
  } catch (e: any) {
    rejected = true;
    const code = e?.error?.errorCode?.code ?? e?.errorCode?.code ?? "";
    const num = e?.error?.errorCode?.number ?? e?.errorCode?.number ?? "";
    errInfo = `${code} (${num})`;
  }

  const cfgAfter: any = await program.account.poolConfig.fetch(poolConfig);
  const unchanged = cfg.nextDrawTs.toString() === cfgAfter.nextDrawTs.toString();

  console.log(JSON.stringify({
    backdatedRejected: rejected,
    error: errInfo,
    expected: "BackdatedTimestamp (6037)",
    nextDrawTsUnchanged: unchanged,
  }, null, 2));

  const pass = rejected && errInfo.includes("BackdatedTimestamp") && unchanged;
  console.log(pass ? "PASS: back-date guard live on-chain, state unchanged" : "FAIL");
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
