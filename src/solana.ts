// What a transaction in a getBlock response (encoding "json") says about fees: the accounts it
// write-locks, its compute unit price, and the fee the chain should have charged for it.
//
// Legacy and v0 transactions set their price and limit with ComputeBudget instructions. v1
// transactions carry them in message.transactionConfig instead, with priorityFee as a total in
// lamports rather than a price per compute unit.

export const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
export const VOTE = "Vote111111111111111111111111111111111111111";
const PRECOMPILES = new Set(["Ed25519SigVerify111111111111111111111111111", "KeccakSecp256k11111111111111111111111111111", "Secp256r1SigVerify1111111111111111111111111"]);
/** Programs whose instructions get 3,000 compute units by default rather than 200,000 (SIMD-0170). */
const BUILTINS = new Set([
  COMPUTE_BUDGET,
  VOTE,
  "11111111111111111111111111111111",
  "BPFLoader1111111111111111111111111111111111",
  "BPFLoader2111111111111111111111111111111111",
  "BPFLoaderUpgradeab1e11111111111111111111111",
  "LoaderV411111111111111111111111111111111111",
  "ZkE1Gama1Proof11111111111111111111111111111",
  ...PRECOMPILES,
]);
const LAMPORTS_PER_SIGNATURE = 5_000;
const MAX_COMPUTE_UNITS = 1_400_000;

export interface Transaction {
  version: "legacy" | 0 | 1;
  transaction: {
    message: {
      header: { numRequiredSignatures: number; numReadonlySignedAccounts: number; numReadonlyUnsignedAccounts: number };
      accountKeys: string[];
      instructions: { programIdIndex: number; data: string }[];
      transactionConfig?: { computeUnitLimit: number | null; priorityFee: number | null };
    };
  };
  meta: {
    fee: number;
    err: unknown;
    loadedAddresses?: { writable: string[]; readonly?: string[] };
    innerInstructions?: { instructions: { programIdIndex: number }[] }[];
  } | null;
}

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58(text: string): Buffer {
  let n = 0n;
  for (const c of text) {
    const digit = ALPHABET.indexOf(c);
    if (digit < 0) throw new Error(`not base58: ${text}`);
    n = n * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  for (; n > 0n; n >>= 8n) bytes.unshift(Number(n & 0xffn));
  for (const c of text) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}

export const isVote = (tx: Transaction) => tx.transaction.message.accountKeys.includes(VOTE);

/** The accounts a transaction write-locks: writable signers, writable non-signers, and writable lookups. */
export function writableAccounts(tx: Transaction): string[] {
  const { header, accountKeys } = tx.transaction.message;
  const signers = header.numRequiredSignatures;
  const statics = accountKeys.filter((_, i) => (i < signers ? i < signers - header.numReadonlySignedAccounts : i < accountKeys.length - header.numReadonlyUnsignedAccounts));
  return [...statics, ...(tx.meta?.loadedAddresses?.writable ?? [])];
}

/**
 * Every program a transaction invokes, at the top level or from another program. Instructions
 * index into the static keys followed by the writable and then the read-only lookups.
 */
export function invokedPrograms(tx: Transaction): Set<string> {
  const { accountKeys, instructions } = tx.transaction.message;
  const keys = [...accountKeys, ...(tx.meta?.loadedAddresses?.writable ?? []), ...(tx.meta?.loadedAddresses?.readonly ?? [])];
  const inner = (tx.meta?.innerInstructions ?? []).flatMap((group) => group.instructions);
  return new Set([...instructions, ...inner].map((instruction) => keys[instruction.programIdIndex]));
}

export interface Budget {
  /** Compute units the transaction asked for, which is what the priority fee is charged on. */
  limit: number;
  /** The priority fee in lamports. */
  priorityFee: number;
  /** Micro-lamports per compute unit, rounded down for v1 as the RPC's fee cache does. */
  price: number;
}

/** A transaction's compute budget. */
export function budget(tx: Transaction): Budget {
  const { accountKeys, instructions, transactionConfig } = tx.transaction.message;
  if (tx.version === 1) {
    const limit = transactionConfig?.computeUnitLimit ?? 0;
    const priorityFee = transactionConfig?.priorityFee ?? 0;
    return { limit, priorityFee, price: limit ? Math.floor((priorityFee * 1_000_000) / limit) : 0 };
  }
  let price = 0;
  let limit: number | undefined;
  let defaultLimit = 0;
  for (const instruction of instructions) {
    const program = accountKeys[instruction.programIdIndex];
    defaultLimit += BUILTINS.has(program) ? 3_000 : 200_000;
    if (program !== COMPUTE_BUDGET) continue;
    const data = base58(instruction.data);
    if (data[0] === 2 && data.length >= 5) limit = data.readUInt32LE(1); // SetComputeUnitLimit
    if (data[0] === 3 && data.length >= 9) price = Number(data.readBigUInt64LE(1)); // SetComputeUnitPrice
  }
  limit = Math.min(limit ?? defaultLimit, MAX_COMPUTE_UNITS);
  return { limit, priorityFee: Math.ceil((price * limit) / 1_000_000), price };
}

/** The fee the chain should charge: 5,000 lamports per signature, precompiles' included, plus the priority fee. */
export function expectedFee(tx: Transaction): number {
  const { header, accountKeys, instructions } = tx.transaction.message;
  let signatures = header.numRequiredSignatures;
  for (const instruction of instructions) {
    if (PRECOMPILES.has(accountKeys[instruction.programIdIndex])) signatures += base58(instruction.data)[0] ?? 0;
  }
  return signatures * LAMPORTS_PER_SIGNATURE + budget(tx).priorityFee;
}
