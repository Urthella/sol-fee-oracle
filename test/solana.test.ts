import assert from "node:assert/strict";
import { test } from "node:test";

import { percentile, rpcMinimum } from "../src/oracle.ts";
import { COMPUTE_BUDGET, type Transaction, VOTE, base58, budget, expectedFee, writableAccounts } from "../src/solana.ts";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** A base58 encoder of the test's own, to build instruction data. */
function encode(bytes: Buffer): string {
  let n = BigInt(`0x${bytes.toString("hex") || "0"}`);
  let out = "";
  for (; n > 0n; n /= 58n) out = ALPHABET[Number(n % 58n)] + out;
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out;
}
const price = (microLamports: number) => {
  const data = Buffer.alloc(9);
  data[0] = 3;
  data.writeBigUInt64LE(BigInt(microLamports), 1);
  return encode(data);
};
const limit = (units: number) => {
  const data = Buffer.alloc(5);
  data[0] = 2;
  data.writeUInt32LE(units, 1);
  return encode(data);
};

const PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const SYSTEM = "11111111111111111111111111111111";
const ED25519 = "Ed25519SigVerify111111111111111111111111111";

/** A legacy transaction calling the given programs; a fee payer signs. */
function legacy(programs: { program: string; data?: string }[], fee = 0, extra: Partial<Transaction> = {}): Transaction {
  const keys = ["Payer111111111111111111111111111111111111111", "Pool1111111111111111111111111111111111111111", ...new Set(programs.map((p) => p.program))];
  return {
    version: "legacy",
    transaction: {
      message: {
        header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: keys.length - 2 },
        accountKeys: keys,
        instructions: programs.map(({ program, data = "1" }) => ({ programIdIndex: keys.indexOf(program), data })),
      },
    },
    meta: { fee, err: null, loadedAddresses: { writable: [] } },
    ...extra,
  };
}
const v1 = (computeUnitLimit: number | null, priorityFee: number | null, err: unknown = null): Transaction => ({
  version: 1,
  transaction: {
    message: {
      header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 },
      accountKeys: ["Payer111111111111111111111111111111111111111", "Pool1111111111111111111111111111111111111111", PROGRAM],
      instructions: [{ programIdIndex: 2, data: "1" }],
      transactionConfig: { computeUnitLimit, priorityFee },
    },
  },
  meta: { fee: 5000 + (priorityFee ?? 0), err, loadedAddresses: { writable: [] } },
});

test("base58 decodes Bitcoin's test vectors", () => {
  assert.equal(base58("").toString("hex"), "");
  assert.equal(base58("2g").toString("hex"), "61");
  assert.equal(base58("a3gV").toString("hex"), "626262");
  assert.equal(base58("2cFupjhnEsSn59qHXstmK2ffpLv2").toString(), "simply a long string");
  assert.equal(base58("1NS17iag9jJgTHD1VXjvLCEnZuQ3rJDE9L").toString("hex"), "00eb15231dfceb60925886b67d065299925915aeb172c06647");
  assert.equal(base58("111").toString("hex"), "000000");
  assert.equal(base58(SYSTEM).length, 32, "the system program is 32 zero bytes");
  assert.throws(() => base58("0OIl"), /not base58/);
});

test("writable accounts follow the header, plus writable lookups", () => {
  const tx: Transaction = {
    version: 0,
    transaction: { message: { header: { numRequiredSignatures: 2, numReadonlySignedAccounts: 1, numReadonlyUnsignedAccounts: 1 }, accountKeys: ["A", "B", "C", "D", "E"], instructions: [] } },
    meta: { fee: 0, err: null, loadedAddresses: { writable: ["F"] } },
  };
  assert.deepEqual(writableAccounts(tx), ["A", "C", "D", "F"]);
});

test("legacy and v0 budgets come from ComputeBudget instructions", () => {
  const explicit = budget(legacy([{ program: COMPUTE_BUDGET, data: limit(150_000) }, { program: COMPUTE_BUDGET, data: price(1_000_001) }, { program: PROGRAM }]));
  assert.deepEqual(explicit, { limit: 150_000, priorityFee: 150_001, price: 1_000_001 }, "150,000.15 lamports rounds up");
  assert.deepEqual(budget(legacy([{ program: PROGRAM }])), { limit: 200_000, priorityFee: 0, price: 0 }, "no price is free");
  assert.equal(budget(legacy([{ program: COMPUTE_BUDGET, data: limit(5_000_000) }, { program: PROGRAM }])).limit, 1_400_000, "capped at 1.4M");
  assert.equal(budget(legacy([{ program: COMPUTE_BUDGET, data: price(5_000_000_000) }, { program: PROGRAM }])).price, 5_000_000_000, "a price past 32 bits");
});

test("without a limit, builtins get 3,000 compute units each and other programs 200,000", () => {
  const tx = legacy([{ program: COMPUTE_BUDGET, data: price(5) }, { program: PROGRAM }, { program: SYSTEM }, { program: PROGRAM }]);
  assert.equal(budget(tx).limit, 3_000 + 200_000 + 3_000 + 200_000);
  assert.equal(budget(tx).priorityFee, 3, "5 micro-lamports on 406,000 units rounds up to 3 lamports");
  const many = legacy(Array.from({ length: 8 }, () => ({ program: PROGRAM })));
  assert.equal(budget(many).limit, 1_400_000);
});

test("v1 budgets come from transactionConfig, with priorityFee in lamports", () => {
  assert.deepEqual(budget(v1(300_000, 1_000)), { limit: 300_000, priorityFee: 1_000, price: 3_333 }, "the price rounds down");
  assert.deepEqual(budget(v1(300_000, null)), { limit: 300_000, priorityFee: 0, price: 0 });
  assert.deepEqual(budget(v1(null, 50)), { limit: 0, priorityFee: 50, price: 0 });
});

test("the expected fee counts signatures in precompile instructions", () => {
  const signatures = Buffer.from([2, 0]);
  const tx = legacy([{ program: ED25519, data: encode(signatures) }, { program: COMPUTE_BUDGET, data: limit(10_000) }, { program: COMPUTE_BUDGET, data: price(100_000) }]);
  assert.equal(expectedFee(tx), 3 * 5_000 + 1_000);
  assert.equal(expectedFee(v1(200_000, 777)), 5_777);
});

test("nearest-rank percentiles", () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.deepEqual([25, 50, 75, 90, 99].map((p) => percentile(values, p)), [3, 5, 8, 9, 10]);
  assert.equal(percentile([7], 50), 7);
  assert.equal(percentile([], 50), 0);
});

test("the RPC's minimum: the block's cheapest, raised to each account's cheapest writer, failures and v1 included", () => {
  const writes = (pool: string, tx: Transaction): Transaction => ({ ...tx, transaction: { ...tx.transaction, message: { ...tx.transaction.message, accountKeys: tx.transaction.message.accountKeys.map((key) => (key.startsWith("Pool") ? pool : key)) } } });
  const vote: Transaction = { ...legacy([{ program: VOTE }]), meta: { fee: 5000, err: null } };
  const block = [vote, legacy([{ program: COMPUTE_BUDGET, data: price(10) }, { program: PROGRAM }]), writes("PoolA", v1(300_000, 1_000)), writes("PoolA", v1(300_000, 2_000, { failed: true })), writes("PoolA", v1(300_000, 999, { failed: true })), writes("PoolB", v1(300_000, 3_000))];
  assert.equal(rpcMinimum(block, []), 10, "the block's cheapest non-vote transaction");
  assert.equal(rpcMinimum(block, ["PoolA"]), 3_330, "999 lamports on 300,000 units, from a failed v1 transaction");
  assert.equal(rpcMinimum(block, ["PoolA", "PoolB"]), 10_000, "the higher of the two accounts' minimums");
  assert.equal(rpcMinimum(block, ["Elsewhere"]), 10, "an account nobody wrote leaves the block's minimum");
  assert.equal(rpcMinimum([vote], []), undefined, "only votes");
});
