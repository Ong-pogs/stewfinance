/** Read-only: diagnose settle's IncompletePositionSet — compare the on-chain
 * total_weight to the sum over all globally-fetched UserPositions. */
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { Stewfi } from "../target/types/stewfi";
import * as fs from "fs";
import * as path from "path";

const PROGRAM_ID = new PublicKey("8uDmfYPMBaiLLwfZGAnhNaDm48kx19hD8kPdiR7XiRLD");
const MINT = new PublicKey("4RZDNG97iQosLLiGCkJFvVH2wcjmf14EXFftdVwre1qJ");
const pda = (s: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(s, PROGRAM_ID)[0];
const loadIdl = () => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "target", "idl", "stewfi.json"), "utf-8"));

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = new Program(loadIdl() as any, provider) as Program<Stewfi>;
  const poolConfig = pda([Buffer.from("pool_config"), MINT.toBuffer()]);
  const cfg: any = await program.account.poolConfig.fetch(poolConfig);
  const round = Number(cfg.currentRound.toString());
  const draw: any = await program.account.draw.fetch(pda([Buffer.from("draw"), new BN(round).toArrayLike(Buffer, "le", 8)]));
  const drawTs = BigInt(draw.drawTs.toString());
  const totalWeight = BigInt(draw.totalWeight.toString());

  console.log("pool total_principal :", (Number(cfg.totalPrincipal) / 1e6).toFixed(2), "USDC");
  console.log("pool sum_amount      :", cfg.sumAmount.toString());
  console.log("pool sum_amt_first_ts:", cfg.sumAmountFirstTs.toString());
  console.log("draw status          :", Object.keys(draw.status)[0]);
  console.log("draw draw_ts         :", drawTs.toString());
  console.log("draw total_weight    :", totalWeight.toString());
  console.log("draw_in_progress     :", cfg.drawInProgress);

  const all = await program.account.userPosition.all();
  let sumAmt = 0n, sumWeight = 0n;
  console.log(`\nglobal UserPositions: ${all.length}`);
  for (const e of all) {
    const amt = BigInt((e.account.amount as BN).toString());
    const fts = BigInt((e.account.firstDepositTs as BN).toString());
    const held = drawTs - fts;
    const w = held > 0n ? amt * held : 0n;
    sumAmt += amt;
    sumWeight += w;
    console.log(`  ${(e.account.user as PublicKey).toBase58().slice(0, 8)}… amt=${(Number(amt) / 1e6).toFixed(1)} first_ts=${fts} held=${held} w=${w}`);
  }
  console.log(`\nsum(amount) over global = ${(Number(sumAmt) / 1e6).toFixed(2)} USDC  vs pool total_principal ${(Number(cfg.totalPrincipal) / 1e6).toFixed(2)}`);
  console.log(`sum(weight) over global = ${sumWeight}  vs draw.total_weight ${totalWeight}`);
  console.log(sumWeight === totalWeight ? "MATCH ✓" : `MISMATCH ✗ (diff ${sumWeight - totalWeight})`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
