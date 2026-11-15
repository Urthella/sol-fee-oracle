// Saves real mainnet data for the --program tests: two recent blocks with their inner instructions
// and read-only lookups, a program that some transactions only reach from another program, and
// what getRecentPrioritizationFees says about that program and about no account at all.
//
//   node scripts/fetch-program-fixtures.ts [RPC_URL]

import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

import type { Block } from "../src/oracle.ts";
import { Rpc } from "../src/rpc.ts";
import { budget, invokedPrograms, isVote } from "../src/solana.ts";

const rpc = new Rpc(process.argv[2] ?? "https://api.mainnet-beta.solana.com");
const tip = await rpc.call<number>("getSlot", [{ commitment: "confirmed" }]);
const slots = (await rpc.call<number[]>("getBlocks", [tip - 20, tip - 2, { commitment: "confirmed" }])).filter((_, i) => i % 6 === 0).slice(0, 2);
const blocks: Block[] = [];
for (const slot of slots) {
  const block = await rpc.call<Omit<Block, "slot">>("getBlock", [slot, { commitment: "confirmed", encoding: "json", transactionDetails: "full", rewards: false, maxSupportedTransactionVersion: 1 }]);
  blocks.push({ slot, transactions: block.transactions });
}

// A program reached both directly and only from other programs, whose median caller paid
// something: the system and token programs are everywhere, so they are left out.
const COMMON = new Set(["11111111111111111111111111111111", "ComputeBudget111111111111111111111111111111", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"]);
const transactions = blocks.flatMap((block) => block.transactions.filter((tx) => !isVote(tx)));
const tally = new Map<string, { direct: number; inner: number; prices: number[] }>();
for (const tx of transactions) {
  const direct = new Set(tx.transaction.message.instructions.map((ix) => tx.transaction.message.accountKeys[ix.programIdIndex]));
  for (const program of invokedPrograms(tx)) {
    if (COMMON.has(program)) continue;
    const entry = tally.get(program) ?? { direct: 0, inner: 0, prices: [] };
    if (direct.has(program)) entry.direct++;
    else entry.inner++;
    entry.prices.push(budget(tx).price);
    tally.set(program, entry);
  }
}
const [program] = [...tally].filter(([, t]) => t.direct >= 3 && t.inner >= 3 && t.prices.sort((a, b) => a - b)[Math.floor(t.prices.length / 2)] > 0).sort((a, b) => b[1].direct + b[1].inner - (a[1].direct + a[1].inner))[0] ?? [];
if (!program) throw new Error("no program fits in these blocks; run it again");

const ask = async (list: string[]) =>
  Object.fromEntries((await rpc.call<{ slot: number; prioritizationFee: number }[]>("getRecentPrioritizationFees", [list])).filter((fee) => slots.includes(fee.slot)).map((fee) => [fee.slot, fee.prioritizationFee]));
const rpcFees = { program, forProgram: await ask([program]), none: await ask([]) };

const trim = (tx: Block["transactions"][number]) => ({
  version: tx.version,
  transaction: {
    signatures: tx.transaction.signatures?.slice(0, 1),
    message: {
      header: tx.transaction.message.header,
      accountKeys: tx.transaction.message.accountKeys,
      instructions: tx.transaction.message.instructions.map(({ programIdIndex, data }) => ({ programIdIndex, data })),
      ...(tx.transaction.message.transactionConfig && { transactionConfig: tx.transaction.message.transactionConfig }),
    },
  },
  meta: tx.meta && {
    fee: tx.meta.fee,
    err: tx.meta.err === null ? null : true,
    loadedAddresses: { writable: tx.meta.loadedAddresses?.writable ?? [], readonly: tx.meta.loadedAddresses?.readonly ?? [] },
    innerInstructions: (tx.meta.innerInstructions ?? []).map((group) => ({ instructions: group.instructions.map(({ programIdIndex }) => ({ programIdIndex })) })),
  },
});
const dir = new URL("../test/fixtures/", import.meta.url);
writeFileSync(new URL("program-blocks.json.gz", dir), gzipSync(JSON.stringify(blocks.map((block) => ({ slot: block.slot, transactions: block.transactions.filter((tx) => !isVote(tx)).map(trim) })))));
writeFileSync(new URL("program-rpc-fees.json", dir), JSON.stringify(rpcFees, null, 1) + "\n");
const { direct, inner } = tally.get(program)!;
console.log(`slots ${slots.join(", ")}; program ${program}, called directly by ${direct} transactions and only from other programs by ${inner}`);
