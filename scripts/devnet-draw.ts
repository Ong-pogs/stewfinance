/**
 * StewFi — run / resume ONE live Switchboard On-Demand VRF draw on devnet.
 *
 * Resumable: if the current round is already Committed (draw_in_progress), it
 * skips create+commit+trigger and goes straight to reveal+settle using the
 * randomness account recorded on the Draw.
 *
 * Pool-member derivation: UserPosition PDAs are keyed by USER (not pool), so
 * program.account.userPosition.all() can return positions from other pools
 * (e.g. throwaway smoke-test pools). We recover THIS pool's exact member set by
 * selecting the subset whose summed weight == the on-chain draw.total_weight
 * (snapshotted at commit from the pool's own accumulators). For the real product
 * with a single pool this subset == all positions.
 *
 * Run:
 *   TS_NODE_COMPILER_OPTIONS='{"target":"es2020","lib":["es2020"]}' \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   yarn ts-node scripts/devnet-draw.ts
 */
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  ComputeBudgetProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Randomness } from "@switchboard-xyz/on-demand";
import { Stewfi } from "../target/types/stewfi";
import {
  loadSwitchboardProgram,
  createRandomness,
  buildCommitAndTriggerV0Tx,
} from "../app/crank/vrf";
import {
  fetchAllPositions,
  computeWinner,
  sortedPositionMetas,
  PositionEntry,
} from "../app/crank/positions";
import {
  SWITCHBOARD_ON_DEMAND_PID_DEVNET,
  SWITCHBOARD_DEFAULT_QUEUE_DEVNET,
} from "../app/crank/constants";
import * as fs from "fs";
import * as path from "path";

const PROGRAM_ID = new PublicKey("8uDmfYPMBaiLLwfZGAnhNaDm48kx19hD8kPdiR7XiRLD");
const MINT = new PublicKey("4RZDNG97iQosLLiGCkJFvVH2wcjmf14EXFftdVwre1qJ");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const pda = (s: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(s, PROGRAM_ID)[0];
const drawPda = (round: number | bigint) =>
  pda([Buffer.from("draw"), new BN(round.toString()).toArrayLike(Buffer, "le", 8)]);
const loadIdl = () =>
  JSON.parse(fs.readFileSync(path.join(__dirname, "..", "target", "idl", "stewfi.json"), "utf-8"));

/**
 * Recover THIS pool's member set: the subset whose weights sum to total_weight.
 *
 * The on-chain settle only checks Σweight == total_weight (a SUM), so two
 * distinct subsets that happen to share that sum (e.g. positions with equal
 * amount + equal first_deposit_ts → equal weight) are BOTH accepted on-chain —
 * but only one is the real pool. Returning the wrong subset would pay a foreign
 * winner. So we scan the WHOLE space: if a second distinct subset also matches,
 * the membership is ambiguous and we refuse to guess.
 */
export function selectPoolSubset(all: PositionEntry[], drawTs: bigint, totalWeight: bigint): PositionEntry[] {
  const wt = all.map((p) => {
    const held = drawTs - p.firstDepositTs;
    return { p, w: held > 0n ? p.amount * held : 0n };
  });
  const n = wt.length;
  if (n > 22) throw new Error(`too many positions (${n}) for subset search`);
  let match: PositionEntry[] | null = null;
  for (let mask = 1; mask < 1 << n; mask++) {
    let sum = 0n;
    const subset: PositionEntry[] = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) { sum += wt[i].w; subset.push(wt[i].p); }
    if (sum === totalWeight) {
      if (match !== null) {
        throw new Error("ambiguous pool membership: multiple position subsets match total_weight — cannot safely reconstruct; use a fresh single-pool deployment");
      }
      match = subset;
    }
  }
  if (match === null) {
    throw new Error(`no subset of ${n} positions sums to total_weight ${totalWeight}`);
  }
  return match;
}

async function sendV0(conn: anchor.web3.Connection, ixs: TransactionInstruction[], payer: Keypair, label: string): Promise<string> {
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([payer]);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  const conf = await conn.confirmTransaction(sig, "confirmed");
  if (conf.value.err) {
    const det = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    throw new Error(`${label} ${sig} failed: ${JSON.stringify(conf.value.err)}\n${det?.meta?.logMessages?.join("\n") ?? ""}`);
  }
  return sig;
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const conn = provider.connection;
  const operatorKp = (provider.wallet as anchor.Wallet).payer;
  const program = new Program(loadIdl() as any, provider) as Program<Stewfi>;
  const sbProgram = await loadSwitchboardProgram(provider, SWITCHBOARD_ON_DEMAND_PID_DEVNET);

  const poolConfig = pda([Buffer.from("pool_config"), MINT.toBuffer()]);
  const usdcVault = pda([Buffer.from("usdc_vault"), MINT.toBuffer()]);
  const growingPotVault = pda([Buffer.from("growing_pot_vault"), MINT.toBuffer()]);
  const operatorVault = pda([Buffer.from("operator_vault"), MINT.toBuffer()]);
  const opsVault = pda([Buffer.from("ops_vault"), MINT.toBuffer()]);

  const cfg: any = await program.account.poolConfig.fetch(poolConfig);
  const round = Number(cfg.currentRound.toString());
  const currentDraw = drawPda(round);
  const nextDraw = drawPda(round + 1);
  let draw: any = await program.account.draw.fetch(currentDraw);
  const committed = Object.keys(draw.status)[0] === "committed";
  console.log("round", round, "status", Object.keys(draw.status)[0], "draw_in_progress", cfg.drawInProgress);

  let randomness: Randomness;
  if (committed) {
    console.log("[resume] using committed randomness", draw.randomnessAccount.toBase58());
    randomness = new Randomness(sbProgram, draw.randomnessAccount);
  } else {
    console.log("[1] createRandomness on devnet queue");
    const rngKp = Keypair.generate();
    ({ randomness } = await createRandomness(provider, sbProgram, rngKp, SWITCHBOARD_DEFAULT_QUEUE_DEVNET));
    console.log("    randomness", rngKp.publicKey.toBase58());
    console.log("[2] commit + trigger_draw");
    const triggerIx = await program.methods.triggerDraw().accountsPartial({
      crank: operatorKp.publicKey, poolConfig, currentDraw, usdcVault, randomnessAccount: rngKp.publicKey,
    }).instruction();
    const txA = await buildCommitAndTriggerV0Tx(provider, randomness, SWITCHBOARD_DEFAULT_QUEUE_DEVNET, triggerIx, operatorKp, { skipCommit: false });
    const sigA = await conn.sendRawTransaction(txA.serialize(), { skipPreflight: false });
    const confA = await conn.confirmTransaction(sigA, "confirmed");
    if (confA.value.err) {
      const det = await conn.getTransaction(sigA, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      throw new Error(`commit+trigger failed: ${JSON.stringify(confA.value.err)}\n${det?.meta?.logMessages?.join("\n")}`);
    }
    console.log("    TX-A", sigA);
    draw = await program.account.draw.fetch(currentDraw);
  }

  const drawTs = BigInt(draw.drawTs.toString());
  const totalWeight = BigInt(draw.totalWeight.toString());
  console.log("    draw_ts", drawTs.toString(), "total_weight", totalWeight.toString(), "prize", (Number(draw.prizePool) / 1e6).toFixed(2), "USDC");

  console.log("[3] waiting for oracle reveal…");
  let revealIxObj: TransactionInstruction | null = null;
  for (let i = 0; i < 25; i++) {
    try { revealIxObj = await randomness.revealIx(operatorKp.publicKey); break; }
    catch (e) { console.log(`    not ready (${i + 1}): ${(e as Error).message.slice(0, 110)}`); await sleep(3000); }
  }
  if (!revealIxObj) throw new Error("oracle never resolved");
  const value = Buffer.from(revealIxObj.data.subarray(revealIxObj.data.length - 32));
  console.log("    value", value.toString("hex"));

  const all = await fetchAllPositions(program);
  const positions = selectPoolSubset(all, drawTs, totalWeight);
  console.log(`[4] pool members: ${positions.length} of ${all.length} global positions`);
  const winner = computeWinner(positions, drawTs, totalWeight, value);
  if (!winner.winnerPositionPda) throw new Error("computeWinner found no winner");
  console.log("    winner", winner.winnerOwner!.toBase58(), "ticket", winner.ticket.toString());

  console.log("[5] reveal + settle_draw");
  const settleIx = await program.methods.settleDraw().accountsPartial({
    crank: operatorKp.publicKey, poolConfig, currentDraw, nextDraw,
    randomnessAccount: draw.randomnessAccount, winnerPosition: winner.winnerPositionPda,
    usdcVault, growingPotVault, operatorVault, opsVault,
    tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).remainingAccounts(sortedPositionMetas(positions)).instruction();
  const sigB = await sendV0(conn, [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), revealIxObj, settleIx], operatorKp, "reveal+settle");
  console.log("    TX-B", sigB);

  const settled: any = await program.account.draw.fetch(currentDraw);
  console.log("\n=== DRAW SETTLED ===");
  console.log("round         :", round);
  console.log("status        :", Object.keys(settled.status)[0]);
  console.log("winner        :", settled.winner.toBase58());
  console.log("winner_amount :", (Number(settled.winnerAmount) / 1e6).toFixed(2), "USDC (65%)");
  console.log("growing_pot   :", (Number(settled.growingPotAmount) / 1e6).toFixed(2), "USDC (20%)");
  console.log("operator      :", (Number(settled.operatorAmount) / 1e6).toFixed(2), "USDC (10%)");
  console.log("ops           :", (Number(settled.opsAmount) / 1e6).toFixed(2), "USDC (5%)");
  if (Object.keys(settled.status)[0] !== "settled") throw new Error("not settled");
  console.log("\n✓ LIVE SWITCHBOARD VRF DRAW SUCCEEDED ON DEVNET");
}

// Run only when invoked directly (not when imported for testing, e.g. the
// selectPoolSubset unit test) — matches the require.main guard in run.ts.
if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => { console.error("\nDRAW FAILED:\n", e); process.exit(1); });
}
