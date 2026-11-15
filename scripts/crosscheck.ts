// Runs the oracle live for a few sets of accounts and reports both checks: every fee against what
// the chain charged, and the RPC's getRecentPrioritizationFees against the same blocks. The
// accounts are the ones the latest block writes most, so the comparison isn't all zeros.
//
//   node scripts/crosscheck.ts [RPC_URL] [BLOCKS]

import { analyze, collect } from "../src/oracle.ts";
import { Rpc } from "../src/rpc.ts";
import { isVote, writableAccounts } from "../src/solana.ts";

const rpc = new Rpc(process.argv[2] ?? "https://api.mainnet-beta.solana.com");
const count = Number(process.argv[3] ?? 10);

const { blocks: [latest] } = await collect(rpc, 1, []);
const writes = new Map<string, number>();
for (const tx of latest.transactions) if (!isVote(tx)) for (const account of new Set(writableAccounts(tx))) writes.set(account, (writes.get(account) ?? 0) + 1);
const busiest = [...writes].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([account]) => account);

for (const [label, accounts] of [["no account", []], ["the 3 busiest accounts", busiest], [`the busiest, ${busiest[0]}`, busiest.slice(0, 1)]] as const) {
  const { blocks, rpcFees } = await collect(rpc, count, [...accounts]);
  const report = analyze(blocks, rpcFees, [...accounts]);
  const v1 = report.matching ? Math.round((100 * report.v1) / report.matching) : 0;
  console.log(
    `${label}: ${report.slots.length} blocks, ${report.transactions} transactions, ${report.matching} counted (${v1}% v1); ` +
      `fees ${report.feeCheck.checked - report.feeCheck.mismatches.length}/${report.feeCheck.checked}; ` +
      `RPC minimum ${report.rpcCheck.compared - report.rpcCheck.mismatches.length}/${report.rpcCheck.compared} slots; p50 ${report.percentiles.p50}, RPC median ${report.rpcCheck.median}`,
  );
  for (const miss of [...report.feeCheck.mismatches, ...report.rpcCheck.mismatches].slice(0, 5)) console.log(`  ${JSON.stringify(miss)}`);
}
