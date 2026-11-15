// Three real mainnet blocks and what the RPC said about them, saved by scripts/fetch-fixtures.ts:
// every fee must reconcile, and the RPC's per-slot minimums must come out of the blocks.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";

import { type Block, analyze, rpcMinimum } from "../src/oracle.ts";
import { COMPUTE_BUDGET, base58, budget, expectedFee, isVote } from "../src/solana.ts";

const fixture = (name: string) => readFileSync(new URL(`fixtures/${name}`, import.meta.url));
const blocks: Block[] = JSON.parse(gunzipSync(fixture("blocks.json.gz")).toString("utf8"));
const rpc: { accounts: string[]; none: Record<string, number>; combined: Record<string, number>; single: Record<string, Record<string, number>> } = JSON.parse(fixture("rpc-fees.json").toString("utf8"));
const transactions = blocks.flatMap((block) => block.transactions.filter((tx) => !isVote(tx)));

test("the blocks hold all three transaction versions, and limits both set and defaulted", () => {
  const versions = new Map<string, number>();
  for (const tx of transactions) versions.set(String(tx.version), (versions.get(String(tx.version)) ?? 0) + 1);
  for (const version of ["legacy", "0", "1"]) assert.ok((versions.get(version) ?? 0) > 20, `${version}: ${versions.get(version)}`);
  const sets = (tx: Block["transactions"][number], kind: number) =>
    tx.transaction.message.instructions.some((ix) => tx.transaction.message.accountKeys[ix.programIdIndex] === COMPUTE_BUDGET && base58(ix.data)[0] === kind);
  const defaulted = transactions.filter((tx) => tx.version !== 1 && sets(tx, 3) && !sets(tx, 2));
  assert.ok(defaulted.length > 5, `${defaulted.length} priced transactions leave the limit to its default`);
});

test("every real transaction's fee is what its compute budget says", () => {
  const off = transactions.filter((tx) => expectedFee(tx) !== tx.meta!.fee).map((tx) => [tx.version, expectedFee(tx), tx.meta!.fee]);
  assert.deepEqual(off, []);
  assert.ok(transactions.length > 1000, `${transactions.length} transactions`);
});

test("the RPC's per-slot minimums come out of the blocks, for no account, each account and all three", () => {
  for (const block of blocks) {
    assert.equal(rpcMinimum(block.transactions, []), rpc.none[block.slot], `slot ${block.slot}, no account`);
    assert.equal(rpcMinimum(block.transactions, rpc.accounts), rpc.combined[block.slot], `slot ${block.slot}, all accounts`);
    for (const account of rpc.accounts) assert.equal(rpcMinimum(block.transactions, [account]), rpc.single[account][block.slot], `slot ${block.slot}, ${account}`);
  }
  assert.ok(Object.values(rpc.combined).every((fee) => fee > 0), "the accounts' minimums aren't all zero, so the comparison means something");
});

test("a v1 transaction pays what transactionConfig says, even beside its own SetComputeUnitPrice", () => {
  const paying = transactions.filter((tx) => tx.version === 1 && budget(tx).priorityFee > 0);
  assert.ok(paying.length > 50, `${paying.length} paying v1 transactions`);
  const instructionPrice = (tx: Block["transactions"][number]) => {
    const { accountKeys, instructions } = tx.transaction.message;
    const ix = instructions.find((ix) => accountKeys[ix.programIdIndex] === COMPUTE_BUDGET && base58(ix.data)[0] === 3);
    return ix && Number(base58(ix.data).readBigUInt64LE(1));
  };
  const contradicted = paying.filter((tx) => instructionPrice(tx) !== undefined && instructionPrice(tx) !== budget(tx).price);
  assert.ok(contradicted.length > 0, "some carry an instruction with another price");
  for (const tx of contradicted) assert.equal(tx.meta!.fee, expectedFee(tx), `charged by transactionConfig, not the instruction's ${instructionPrice(tx)}`);
});

test("the report over the real blocks has both checks holding", () => {
  const report = analyze(blocks, new Map(Object.entries(rpc.combined).map(([slot, fee]) => [Number(slot), fee])), rpc.accounts);
  assert.equal(report.feeCheck.mismatches.length, 0);
  assert.deepEqual({ compared: report.rpcCheck.compared, mismatches: report.rpcCheck.mismatches }, { compared: 3, mismatches: [] });
  assert.equal(report.transactions, transactions.length);
  assert.ok(report.matching > 0 && report.matching < report.transactions);
  assert.ok(report.percentiles.p50 >= report.percentiles.p25 && report.percentiles.p99 >= report.percentiles.p90);
});
