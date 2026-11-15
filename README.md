# sol-fee-oracle

What priority fee do Solana transactions that write your accounts pay right now? `sol-fee-oracle`
reads the latest blocks from any RPC, stock nodes included, and reports the price percentiles for
the transactions that write-lock the accounts you give it, or for all of them.

It reads v1 transactions, which set their fee in a new place. It also checks itself against the
chain on every run:

- every transaction's fee must equal what its compute budget says it should be;
- the RPC's own `getRecentPrioritizationFees` must come out of the same blocks.

If either check disagrees, it exits 1, so a change in Solana's fee rules shows up instead of
quietly skewing the numbers.

## Why

`getRecentPrioritizationFees` is the one fee method every RPC has, and it reports a single
minimum per slot: the cheapest transaction that wrote your accounts. Some transaction almost
always pays nothing, so the answer is mostly 0. In the run below, the median transaction paid
134 micro-lamports per compute unit while the method's median was 0. Percentile estimates exist,
but as hosted APIs: Helius, Triton, QuickNode and others. Triton's open-source version needs a
patched validator.

In November 2026, a large share of mainnet transactions are **v1**, and v1 doesn't use
`ComputeBudget` instructions for its fee. The fee goes in `message.transactionConfig`, and
`priorityFee` there is a total in lamports, not a price per compute unit. In the blocks checked
here, 37% to 66% of the transactions counted were v1. Estimators that read only
`SetComputeUnitPrice` see those as free. Even a v1 transaction that carries a
`SetComputeUnitPrice` instruction is charged by `transactionConfig`: one with a "price 0"
instruction paid a priority fee of 5,958,383 lamports.

## Quick start

Needs Node 24 or later, and nothing else.

```sh
git clone https://github.com/Urthella/sol-fee-oracle && cd sol-fee-oracle
node src/main.ts
```

```text
10 blocks, slots 469731643 to 469731652
  2,557 non-vote transactions; 2,557 are counted, 37% of them v1
  priority fee, micro-lamports per compute unit: p25 0 · p50 134 · p75 100,000 · p90 2,696,319 · p99 71,839,449
  for 200,000 compute units, in lamports: p50 27 · p75 20,000 · p90 539,264
  45% paid no priority fee
  getRecentPrioritizationFees for the same slots: 0 at the median, since it reports each slot's cheapest transaction
  check: 2,557 of 2,557 fees match what the chain charged
  check: the RPC's per-slot minimum matches the blocks on 10 of 10 slots
```

Give account addresses to count only the transactions that write-lock one of them, such as a pool
you trade against. Write-locks are what Solana's scheduler contends on, and they're what
`getRecentPrioritizationFees` filters by.

```sh
node src/main.ts --rpc https://your-rpc.example --blocks 20 POOL_ADDRESS
```

- `--rpc URL` picks the RPC, by default the public mainnet one. Public RPCs rate-limit `getBlock`;
  the tool waits and asks again, but a private RPC is much faster.
- `--blocks N` sets how many of the latest confirmed blocks to read: 10 by default, up to 100.
- `--cu UNITS` sets the compute units for the line in lamports: 200,000 by default.
- `--json` prints the report as JSON.

Exit codes: 0 when both checks hold, 1 when one doesn't, 2 when something went wrong.

## What it does

1. **Reads the latest blocks** with `getBlock`, asking for v1 transactions: an RPC refuses to
   return a block holding them unless the client says it can read them.
2. **Reads each transaction's compute budget**, leaving out votes:
   - **legacy and v0:** the price comes from `SetComputeUnitPrice` and the limit from
     `SetComputeUnitLimit`. Without a limit, each instruction gets 200,000 compute units, or
     3,000 for a builtin program such as System or ComputeBudget itself (SIMD-0170). The total
     is capped at 1.4 million;
   - **v1:** both come from `transactionConfig`. The price per compute unit is the priority fee
     in micro-lamports divided by the limit, rounded down as the RPC rounds it.
3. **Counts the transactions** that write-lock one of the accounts, from the message header and the
   writable lookups, or all non-vote ones, and gives nearest-rank percentiles of their price.
4. **Checks every fee**: 5,000 lamports per signature, including the signatures inside Ed25519,
   secp256k1 and secp256r1 precompile instructions, plus the priority fee, must equal the fee the
   block says was charged.
5. **Checks the RPC**: for each slot it also reported, `getRecentPrioritizationFees` must equal
   the lowest price among the block's non-vote transactions, raised to the lowest price among
   those writing each account. Failed transactions count, as they paid.

## How it's checked

- **Real blocks.** Three mainnet blocks and the RPC's answers about them were saved by
  [`scripts/fetch-fixtures.ts`](scripts/fetch-fixtures.ts):
  - all three versions are there, along with transactions that leave the limit to its default;
  - every non-vote transaction's fee reconciles;
  - the RPC's minimums come out of the blocks for no account, for each of three accounts, and
    for all three together. The accounts were picked so the minimums aren't zero;
  - paying v1 transactions are charged by `transactionConfig`, even when they carry a
    `SetComputeUnitPrice` instruction with another price.
- **The rules on their own**, with instruction data built by hand: Bitcoin's base58 test vectors,
  the header's writable accounts, explicit and default limits, the 1.4M cap, v1's rounding,
  precompile signatures, and the RPC's minimum with failed and v1 transactions.
- **End to end.** The CLI runs against a fake JSON-RPC server serving the saved blocks:
  - the percentiles match ones worked out in the test;
  - a skipped slot is left out, and `--blocks` takes the latest blocks;
  - a fee the chain charged differently, or an RPC minimum that doesn't come out of the blocks,
    exits 1 and names the slot;
  - a 429 is waited out;
  - RPC errors, an unreachable RPC, a bad address and bad numbers exit 2.
- **Mutation testing.** Thirty-three deliberate bugs were planted one at a time, and the tests
  caught every one.
- **Live**, with `npm run crosscheck`. On 2026-11-15, for no account, the three accounts the latest
  block wrote most, and the busiest of them, over 10 blocks each:
  - all 8,717 fees matched what the chain charged;
  - the RPC's minimum matched the blocks on 30 of 30 slots;
  - the median price was 2,070 to 3,221 micro-lamports per compute unit, while
    `getRecentPrioritizationFees` gave 0 at the median every time.

## Limits

- It counts write-locks as the message declares them, which is how the RPC's fee cache counted
  them in every slot compared. If the two ever differ for an account, the RPC check says so.
- The default-limit rule and the list of builtins follow Agave as of November 2026. If either
  changes, the fee check is what notices.
- Percentiles describe what landed, failures included. Transactions that never made it into a
  block aren't seen.
- It reads blocks one at a time, to stay within public RPCs' rate limits.

## License

MIT
