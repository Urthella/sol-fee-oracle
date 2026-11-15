// Priority fee percentiles from recent blocks. Everything is read from the blocks themselves, and
// two checks run on every block: each transaction's fee must equal what its compute budget says
// it should be, and the RPC's own getRecentPrioritizationFees, which reports one minimum per
// slot, must match that minimum worked out from the same transactions.

import { type Rpc, RpcError } from "./rpc.ts";
import { type Transaction, budget, expectedFee, invokedPrograms, isVote, writableAccounts } from "./solana.ts";

export interface Block {
  slot: number;
  transactions: (Transaction & { transaction: { signatures?: string[] } })[];
}

export const PERCENTILES = [25, 50, 75, 90, 99] as const;

export interface Report {
  accounts: string[];
  /** Programs a counted transaction must invoke, at the top level or from another program. */
  programs: string[];
  slots: number[];
  /** Non-vote transactions in those blocks. */
  transactions: number;
  /** The ones that write-lock one of the accounts, or all of them when no account is given. */
  matching: number;
  v1: number;
  free: number;
  /** Micro-lamports per compute unit, by percentile, over the matching transactions. */
  percentiles: Record<string, number>;
  feeCheck: { checked: number; mismatches: { slot: number; signature?: string; expected: number; charged: number }[] };
  rpcCheck: { compared: number; mismatches: { slot: number; rpc: number; blocks: number }[]; median?: number };
}

/** Nearest-rank percentile of sorted values. */
export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

/**
 * What getRecentPrioritizationFees reports for a slot: the lowest price among the block's non-vote
 * transactions, raised to the lowest price among those writing each given account, where any
 * transaction writes it. Failed transactions count, as they paid.
 */
export function rpcMinimum(transactions: Transaction[], accounts: string[]): number | undefined {
  const priced = transactions.filter((tx) => !isVote(tx)).map((tx) => ({ price: budget(tx).price, writes: new Set(writableAccounts(tx)) }));
  if (!priced.length) return undefined;
  let fee = Math.min(...priced.map((tx) => tx.price));
  for (const account of accounts) {
    const writers = priced.filter((tx) => tx.writes.has(account));
    if (writers.length) fee = Math.max(fee, Math.min(...writers.map((tx) => tx.price)));
  }
  return fee;
}

/** Codes for a slot that has no block to give: skipped, or not kept by this node. */
const NO_BLOCK = new Set([-32004, -32007, -32009]);

/** Reads the latest `count` confirmed blocks and the RPC's fees for the same accounts. */
export async function collect(rpc: Rpc, count: number, accounts: string[]): Promise<{ blocks: Block[]; rpcFees: Map<number, number> }> {
  const tip = await rpc.call<number>("getSlot", [{ commitment: "confirmed" }]);
  const slots = (await rpc.call<number[]>("getBlocks", [Math.max(0, tip - count * 2 - 20), tip, { commitment: "confirmed" }])).slice(-count);
  // Asked before the blocks are read, so its 150-slot window still covers them.
  const fees = await rpc.call<{ slot: number; prioritizationFee: number }[]>("getRecentPrioritizationFees", [accounts]);
  const blocks: Block[] = [];
  for (const slot of slots) {
    try {
      const block = await rpc.call<Omit<Block, "slot">>("getBlock", [slot, { commitment: "confirmed", encoding: "json", transactionDetails: "full", rewards: false, maxSupportedTransactionVersion: 1 }]);
      blocks.push({ slot, transactions: block.transactions });
    } catch (error) {
      if (!(error instanceof RpcError && NO_BLOCK.has(error.code))) throw error;
    }
  }
  return { blocks, rpcFees: new Map(fees.map((fee) => [fee.slot, fee.prioritizationFee])) };
}

export function analyze(blocks: Block[], rpcFees: Map<number, number>, accounts: string[], programs: string[] = []): Report {
  const wanted = new Set(accounts);
  const invoked = new Set(programs);
  const prices: number[] = [];
  let transactions = 0;
  let v1 = 0;
  const feeCheck: Report["feeCheck"] = { checked: 0, mismatches: [] };
  const rpcCheck: Report["rpcCheck"] = { compared: 0, mismatches: [] };
  const rpcValues: number[] = [];

  for (const block of blocks) {
    for (const tx of block.transactions) {
      if (isVote(tx) || !tx.meta) continue;
      transactions++;
      feeCheck.checked++;
      const expected = expectedFee(tx);
      if (expected !== tx.meta.fee) feeCheck.mismatches.push({ slot: block.slot, signature: tx.transaction.signatures?.[0], expected, charged: tx.meta.fee });
      if (wanted.size && !writableAccounts(tx).some((account) => wanted.has(account))) continue;
      if (invoked.size && ![...invokedPrograms(tx)].some((program) => invoked.has(program))) continue;
      prices.push(budget(tx).price);
      if (tx.version === 1) v1++;
    }
    const rpc = rpcFees.get(block.slot);
    const ours = rpcMinimum(block.transactions, accounts);
    if (rpc === undefined || ours === undefined) continue;
    rpcCheck.compared++;
    rpcValues.push(rpc);
    if (rpc !== ours) rpcCheck.mismatches.push({ slot: block.slot, rpc, blocks: ours });
  }
  prices.sort((a, b) => a - b);
  rpcValues.sort((a, b) => a - b);
  if (rpcValues.length) rpcCheck.median = percentile(rpcValues, 50);
  return {
    accounts,
    programs,
    slots: blocks.map((block) => block.slot),
    transactions,
    matching: prices.length,
    v1,
    free: prices.filter((price) => price === 0).length,
    percentiles: Object.fromEntries(PERCENTILES.map((p) => [`p${p}`, percentile(prices, p)])),
    feeCheck,
    rpcCheck,
  };
}

/** 0 when both checks hold, 1 when this tool's reading disagrees with the chain or the RPC. */
export const exitCode = (report: Report) => (report.feeCheck.mismatches.length || report.rpcCheck.mismatches.length ? 1 : 0);

const number = (n: number) => n.toLocaleString("en-US");
const share = (part: number, whole: number) => `${whole ? Math.round((100 * part) / whole) : 0}%`;

export function describe(report: Report, computeUnits: number): string {
  const { slots, percentiles, feeCheck, rpcCheck } = report;
  const which = (n: number, noun: string) => (n === 1 ? `the ${noun}` : `one of the ${n} ${noun}s`);
  const scope =
    [report.accounts.length ? `write-lock ${which(report.accounts.length, "account")}` : "", report.programs.length ? `invoke ${which(report.programs.length, "program")}` : ""].filter(Boolean).join(" and ") ||
    "are counted";
  const lines = [
    `${slots.length} blocks, slots ${slots[0]} to ${slots.at(-1)}`,
    `  ${number(report.transactions)} non-vote transactions; ${number(report.matching)} ${scope}, ${share(report.v1, report.matching)} of them v1`,
    `  priority fee, micro-lamports per compute unit: ${PERCENTILES.map((p) => `p${p} ${number(percentiles[`p${p}`])}`).join(" · ")}`,
    `  for ${number(computeUnits)} compute units, in lamports: ${[50, 75, 90].map((p) => `p${p} ${number(Math.ceil((percentiles[`p${p}`] * computeUnits) / 1_000_000))}`).join(" · ")}`,
    `  ${share(report.free, report.matching)} paid no priority fee`,
  ];
  if (rpcCheck.median !== undefined) lines.push(`  getRecentPrioritizationFees for the same slots: ${number(rpcCheck.median)} at the median, since it reports each slot's cheapest transaction`);
  lines.push(`  check: ${number(feeCheck.checked - feeCheck.mismatches.length)} of ${number(feeCheck.checked)} fees match what the chain charged`);
  for (const miss of feeCheck.mismatches.slice(0, 5)) lines.push(`    slot ${miss.slot} ${miss.signature ?? ""}: expected ${number(miss.expected)}, charged ${number(miss.charged)}`);
  lines.push(`  check: the RPC's per-slot minimum matches the blocks on ${rpcCheck.compared - rpcCheck.mismatches.length} of ${rpcCheck.compared} slots`);
  for (const miss of rpcCheck.mismatches.slice(0, 5)) lines.push(`    slot ${miss.slot}: RPC ${number(miss.rpc)}, blocks ${number(miss.blocks)}`);
  return lines.join("\n");
}
