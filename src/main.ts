#!/usr/bin/env node
// sol-fee-oracle: what priority fee do transactions that write these accounts pay right now?
// Reads the latest blocks from any Solana RPC, v1 transactions included, and reports price
// percentiles. Every transaction's fee is checked against what the chain charged, and the RPC's
// getRecentPrioritizationFees against the same blocks; exits 1 if either disagrees, 2 on errors.

import { parseArgs } from "node:util";

import { analyze, collect, describe, exitCode } from "./oracle.ts";
import { Rpc } from "./rpc.ts";
import { base58 } from "./solana.ts";

const USAGE = "usage: sol-fee-oracle [--rpc URL] [--blocks N] [--cu UNITS] [--json] [--program ID]... [ACCOUNT]...";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    rpc: { type: "string", default: "https://api.mainnet-beta.solana.com" },
    blocks: { type: "string", default: "10" },
    cu: { type: "string", default: "200000" },
    json: { type: "boolean" },
    program: { type: "string", multiple: true, default: [] },
    help: { type: "boolean", short: "h" },
  },
});

const blocks = Number(values.blocks);
const computeUnits = Number(values.cu);
const bad = [
  !Number.isInteger(blocks) || blocks < 1 || blocks > 100 ? `--blocks must be 1 to 100: ${values.blocks}` : "",
  !Number.isInteger(computeUnits) || computeUnits < 1 || computeUnits > 1_400_000 ? `--cu must be 1 to 1,400,000: ${values.cu}` : "",
  positionals.length > 128 ? "at most 128 accounts, as getRecentPrioritizationFees takes" : "",
  ...[...positionals, ...values.program].map((address) => {
    try {
      return base58(address).length === 32 ? "" : `not an address: ${address}`;
    } catch {
      return `not an address: ${address}`;
    }
  }),
].filter(Boolean);

if (values.help) {
  console.error(USAGE);
} else if (bad.length) {
  console.error([...bad, USAGE].join("\n"));
  process.exitCode = 2;
} else {
  try {
    const { blocks: read, rpcFees } = await collect(new Rpc(values.rpc), blocks, positionals);
    if (!read.length) throw new Error("the RPC returned no blocks");
    const report = analyze(read, rpcFees, positionals, values.program);
    console.log(values.json ? JSON.stringify(report, null, 2) : describe(report, computeUnits));
    // Not process.exit(): it can trip a libuv assertion on Windows.
    process.exitCode = exitCode(report);
  } catch (error) {
    console.error(`sol-fee-oracle: ${(error as Error).message}`);
    process.exitCode = 2;
  }
}
