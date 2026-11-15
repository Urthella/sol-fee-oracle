// Runs the real CLI against a fake JSON-RPC server that serves the saved mainnet blocks and the
// RPC's real answers about them, and can be told to misbehave.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import type { Block } from "../src/oracle.ts";
import { budget, isVote, writableAccounts } from "../src/solana.ts";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const fixture = (name: string) => readFileSync(new URL(`fixtures/${name}`, import.meta.url));
const blocks: Block[] = JSON.parse(gunzipSync(fixture("blocks.json.gz")).toString("utf8"));
const rpc: { accounts: string[]; none: Record<string, number>; combined: Record<string, number>; single: Record<string, Record<string, number>> } = JSON.parse(fixture("rpc-fees.json").toString("utf8"));
const SKIPPED = blocks[0].slot + 1;

let feeTampered = false;
let rpcTampered = false;
let rateLimits = 0;
let rpcBroken = false;
const seen: string[] = [];

const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const { method, params } = JSON.parse(body) as { method: string; params: unknown[] };
  seen.push(method);
  if (rateLimits > 0) {
    rateLimits--;
    return void response.writeHead(429, { "retry-after": "1" }).end("slow down");
  }
  const reply = (result: unknown) => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  const error = (code: number, message: string) => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code, message } }));
  if (rpcBroken) return error(-32603, "Internal error");
  if (method === "getSlot") return reply(blocks.at(-1)!.slot + 2);
  if (method === "getBlocks") return reply([blocks[0].slot, SKIPPED, ...blocks.slice(1).map((block) => block.slot)]);
  if (method === "getRecentPrioritizationFees") {
    const accounts = params[0] as string[];
    const answer = !accounts.length ? rpc.none : accounts.length === rpc.accounts.length ? rpc.combined : rpc.single[accounts[0]];
    return reply(Object.entries(answer).map(([slot, fee]) => ({ slot: Number(slot), prioritizationFee: rpcTampered && Number(slot) === blocks[1].slot ? fee + 1 : fee })));
  }
  if (method === "getBlock") {
    const [slot, options] = params as [number, { maxSupportedTransactionVersion?: number }];
    if (options.maxSupportedTransactionVersion !== 1) return error(-32015, "Transaction version (1) is not supported by the requesting client");
    if (slot === SKIPPED) return error(-32007, `Slot ${slot} was skipped, or missing due to ledger jump to recent snapshot`);
    const block = structuredClone(blocks.find((block) => block.slot === slot)!);
    if (feeTampered && slot === blocks[2].slot) block.transactions.find((tx) => !isVote(tx))!.meta!.fee += 1;
    return reply({ transactions: block.transactions });
  }
  error(-32601, "Method not found");
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
server.unref();
const URL_ = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

function run(...args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [MAIN, "--rpc", URL_, "--blocks", "4", ...args], (error, stdout, stderr) => resolve({ code: error ? Number(error.code) : 0, out: stdout + stderr }));
  });
}

/** Nearest-rank percentiles worked out here, over the transactions writing one of the accounts. */
function expected(accounts: string[]) {
  const prices = blocks
    .flatMap((block) => block.transactions)
    .filter((tx) => !isVote(tx) && (!accounts.length || writableAccounts(tx).some((account) => accounts.includes(account))))
    .map((tx) => budget(tx).price)
    .sort((a, b) => a - b);
  const at = (p: number) => prices[Math.ceil((p / 100) * prices.length) - 1];
  return { count: prices.length, percentiles: { p25: at(25), p50: at(50), p75: at(75), p90: at(90), p99: at(99) } };
}

test("reports percentiles for the accounts, with both checks holding, exit 0", async () => {
  const { code, out } = await run("--json", ...rpc.accounts);
  assert.equal(code, 0, out);
  const report = JSON.parse(out);
  assert.deepEqual(report.slots, blocks.map((block) => block.slot), "the skipped slot is left out");
  const want = expected(rpc.accounts);
  assert.equal(report.matching, want.count);
  assert.deepEqual(report.percentiles, want.percentiles);
  assert.deepEqual(report.feeCheck.mismatches, []);
  assert.deepEqual([report.rpcCheck.compared, report.rpcCheck.mismatches], [3, []]);

  const text = await run(...rpc.accounts);
  assert.equal(text.code, 0, text.out);
  assert.match(text.out, new RegExp(`^3 blocks, slots ${blocks[0].slot} to ${blocks[2].slot}`));
  assert.match(text.out, /write-lock one of the 3 accounts, \d+% of them v1/);
  assert.match(text.out, /check: ([\d,]+) of \1 fees match what the chain charged/);
  assert.match(text.out, /check: the RPC's per-slot minimum matches the blocks on 3 of 3 slots/);
});

test("with no account, every non-vote transaction counts", async () => {
  const { code, out } = await run("--json");
  assert.equal(code, 0, out);
  const report = JSON.parse(out);
  assert.equal(report.matching, report.transactions);
  assert.deepEqual(report.percentiles, expected([]).percentiles);
  assert.equal(report.rpcCheck.compared, 3);
});

test("--blocks takes the latest blocks", async () => {
  const { code, out } = await run("--json", "--blocks", "2", ...rpc.accounts);
  assert.equal(code, 0, out);
  assert.deepEqual(JSON.parse(out).slots, blocks.slice(1).map((block) => block.slot));
});

test("a single account is compared with what the RPC says about it alone", async () => {
  const { code, out } = await run("--cu", "1000000", rpc.accounts[0]);
  assert.equal(code, 0, out);
  assert.match(out, /write-lock the account/);
  assert.match(out, /for 1,000,000 compute units, in lamports: p50/);
});

test("a fee the chain charged differently exits 1 and names the transaction", async () => {
  feeTampered = true;
  try {
    const { code, out } = await run(...rpc.accounts);
    assert.equal(code, 1, out);
    assert.match(out, /check: ([\d,]+) of [\d,]+ fees match/);
    assert.match(out, new RegExp(`slot ${blocks[2].slot} \\w+: expected [\\d,]+, charged [\\d,]+`));
  } finally {
    feeTampered = false;
  }
});

test("an RPC minimum that doesn't come out of the blocks exits 1", async () => {
  rpcTampered = true;
  try {
    const { code, out } = await run(...rpc.accounts);
    assert.equal(code, 1, out);
    const fee = rpc.combined[blocks[1].slot];
    assert.match(out, new RegExp(`slot ${blocks[1].slot}: RPC ${(fee + 1).toLocaleString("en-US")}, blocks ${fee.toLocaleString("en-US")}`));
  } finally {
    rpcTampered = false;
  }
});

test("a rate-limited RPC is asked again", async () => {
  rateLimits = 2;
  seen.length = 0;
  const { code, out } = await run(...rpc.accounts);
  assert.equal(code, 0, out);
  assert.equal(rateLimits, 0);
  assert.equal(seen.filter((method) => method === "getSlot").length, 3, "getSlot was asked three times");
});

test("exits 2 for an RPC error, an unreachable RPC, a bad account or a bad number", async () => {
  rpcBroken = true;
  try {
    const broken = await run();
    assert.equal(broken.code, 2, broken.out);
    assert.match(broken.out, /sol-fee-oracle: getSlot: Internal error \(-32603\)/);
  } finally {
    rpcBroken = false;
  }
  const closed = await new Promise<{ code: number; out: string }>((resolve) =>
    execFile(process.execPath, [MAIN, "--rpc", "http://127.0.0.1:1"], (error, stdout, stderr) => resolve({ code: error ? Number(error.code) : 0, out: stdout + stderr })),
  );
  assert.equal(closed.code, 2, closed.out);
  for (const args of [["abc"], ["0OIl"], ["--blocks", "0"], ["--blocks", "101"], ["--cu", "2000000"]]) {
    const bad = await run(...args);
    assert.equal(bad.code, 2, `${args}: ${bad.out}`);
    assert.match(bad.out, /usage: sol-fee-oracle/);
  }
});
