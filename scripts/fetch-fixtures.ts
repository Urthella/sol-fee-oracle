// Saves real mainnet data for the offline tests: three recent blocks, trimmed to the fields the
// tool reads, and what getRecentPrioritizationFees said for the same slots about the accounts
// those blocks write most, one at a time and together. The RPC only remembers 150 slots, so both
// are fetched in one go.
//
//   node scripts/fetch-fixtures.ts [RPC_URL]

import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

import { type Block, rpcMinimum } from "../src/oracle.ts";
import { Rpc } from "../src/rpc.ts";
import { type Transaction, isVote, writableAccounts } from "../src/solana.ts";

const rpc = new Rpc(process.argv[2] ?? "https://api.mainnet-beta.solana.com");
const dir = new URL("../test/fixtures/", import.meta.url);

const tip = await rpc.call<number>("getSlot", [{ commitment: "confirmed" }]);
const slots = (await rpc.call<number[]>("getBlocks", [tip - 30, tip - 2, { commitment: "confirmed" }])).filter((_, i) => i % 6 === 0).slice(0, 3);
const blocks: Block[] = [];
for (const slot of slots) {
  const block = await rpc.call<Omit<Block, "slot">>("getBlock", [slot, { commitment: "confirmed", encoding: "json", transactionDetails: "full", rewards: false, maxSupportedTransactionVersion: 1 }]);
  blocks.push({ slot, transactions: block.transactions });
}

// Accounts written in every block whose cheapest writer still paid something in most of them, so
// the RPC's answers aren't all zero; busiest first.
const counts = new Map<string, number>();
for (const block of blocks) for (const tx of block.transactions) if (!isVote(tx)) for (const account of new Set(writableAccounts(tx))) counts.set(account, (counts.get(account) ?? 0) + 1);
const paying = (account: string) => blocks.filter((block) => (rpcMinimum(block.transactions, [account]) ?? 0) > 0).length;
const accounts = [...counts]
  .sort((a, b) => b[1] - a[1])
  .map(([account]) => account)
  .filter((account) => blocks.every((block) => block.transactions.some((tx) => !isVote(tx) && writableAccounts(tx).includes(account))) && paying(account) >= 2)
  .slice(0, 3);

const ask = async (list: string[]) => {
  const fees = await rpc.call<{ slot: number; prioritizationFee: number }[]>("getRecentPrioritizationFees", [list]);
  return Object.fromEntries(fees.filter((fee) => slots.includes(fee.slot)).map((fee) => [fee.slot, fee.prioritizationFee]));
};
const rpcFees = { accounts, none: await ask([]), combined: await ask(accounts), single: Object.fromEntries(await Promise.all(accounts.map(async (account) => [account, await ask([account])]))) };

// Keep every non-vote transaction and a few votes, with only the fields the tool reads.
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
  meta: tx.meta && { fee: tx.meta.fee, err: tx.meta.err === null ? null : true, loadedAddresses: { writable: tx.meta.loadedAddresses?.writable ?? [] } },
});
const trimmed = blocks.map((block) => ({
  slot: block.slot,
  transactions: [...block.transactions.filter(isVote).slice(0, 3), ...block.transactions.filter((tx: Transaction) => !isVote(tx))].map(trim),
}));
writeFileSync(new URL("blocks.json.gz", dir), gzipSync(JSON.stringify(trimmed)));
writeFileSync(new URL("rpc-fees.json", dir), JSON.stringify(rpcFees, null, 1) + "\n");
console.log(`slots ${slots.join(", ")}; ${trimmed.reduce((n, b) => n + b.transactions.length, 0)} transactions; accounts ${accounts.join(", ")}`);
