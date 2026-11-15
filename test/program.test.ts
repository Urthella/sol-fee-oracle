// Two real mainnet blocks with inner instructions, a program that some transactions only reach
// from other programs, and what getRecentPrioritizationFees said about it, saved by
// scripts/fetch-program-fixtures.ts.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";

import { type Block, analyze, percentile, rpcMinimum } from "../src/oracle.ts";
import { budget, expectedFee, invokedPrograms, writableAccounts } from "../src/solana.ts";

const fixture = (name: string) => readFileSync(new URL(`fixtures/${name}`, import.meta.url));
const blocks: Block[] = JSON.parse(gunzipSync(fixture("program-blocks.json.gz")).toString("utf8"));
const rpc: { program: string; forProgram: Record<string, number>; none: Record<string, number> } = JSON.parse(fixture("program-rpc-fees.json").toString("utf8"));
const transactions = blocks.flatMap((block) => block.transactions);
const calls = (tx: Block["transactions"][number]) => invokedPrograms(tx).has(rpc.program);
const callsDirectly = (tx: Block["transactions"][number]) => tx.transaction.message.instructions.some((ix) => tx.transaction.message.accountKeys[ix.programIdIndex] === rpc.program);

test("some transactions reach the program only from other programs", () => {
  const direct = transactions.filter(callsDirectly).length;
  const inner = transactions.filter((tx) => calls(tx) && !callsDirectly(tx)).length;
  assert.ok(direct >= 3 && inner >= 3, `${direct} direct, ${inner} only from other programs`);
});

test("--program counts every transaction that invokes it", () => {
  const report = analyze(blocks, new Map(), [], [rpc.program]);
  assert.equal(report.matching, transactions.filter(calls).length);
  assert.deepEqual(report.feeCheck.mismatches, [], "the fees reconcile in these blocks too");
  const prices = transactions.filter(calls).map((tx) => budget(tx).price).sort((a, b) => a - b);
  assert.equal(report.percentiles.p50, percentile(prices, 50));
});

test("the RPC only sees a program through transactions that list it as writable", () => {
  for (const block of blocks) {
    assert.equal(rpcMinimum(block.transactions, [rpc.program]), rpc.forProgram[block.slot], `slot ${block.slot}`);
    const listing = block.transactions.filter((tx) => writableAccounts(tx).includes(rpc.program));
    const callers = block.transactions.filter(calls);
    assert.ok(listing.length < callers.length / 10, `slot ${block.slot}: ${listing.length} of ${callers.length} callers list it as writable`);
    if (!listing.length) assert.equal(rpc.forProgram[block.slot], rpc.none[block.slot], "with none, the answer is the block's minimum");
  }
  const median = percentile(transactions.filter(calls).map((tx) => budget(tx).price).sort((a, b) => a - b), 50);
  assert.ok(Object.values(rpc.forProgram).some((fee) => fee !== median), "the RPC's answers aren't what the callers paid");
  for (const tx of transactions) assert.equal(expectedFee(tx), tx.meta!.fee);
});
