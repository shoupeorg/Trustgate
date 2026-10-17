# Payout investigation: contract → wallet transfers on Studio Next (chain 61997)

**Question:** `withdraw()` executes successfully, but the GEN never reaches the wallet. Is that our code, the SDK, or the network?

**Short answer:** on Studio Next the transfer message is created but never executed, with or without a fee budget for it. We did not find a client-side fix. The feature stays, and the site labels released funds as *credited to the payee inside the vault*.

Raw results: [`payouts.json`](payouts.json). Scripts: [`scripts/payout-test.mjs`](../scripts/payout-test.mjs), [`scripts/payout-probe-accepted.mjs`](../scripts/payout-probe-accepted.mjs).

## What we tried

| # | Attempt | Withdraw tx | Execution | Message allocation | Transfer message | Result |
|---|---|---|---|---|---|---|
| 1 | Plain fees, as the site and SDK send by default (E2E run) | `0x52f59504…93ed` | SUCCESS | none (`message_allocations_count: 0`, `totalMessageFees: 0`) | created (`pending_transactions`: 0.3 GEN, `on: finalized`) | **not executed**, `triggered_transactions: []`, contract balance unchanged |
| 2 | Message fee **pool** (`totalMessageFees: 0.05 GEN`, mode 1) | `0x6fddfd73…09de` | **ERROR** | pool only | none | GenVM: `Mode1MessageFeesRequireGenVMPerEmissionSupport: fee-bearing GenVM messages require a message allocation tree` |
| 3 | Explicit **External** allocation | (reverted before submission, EVM tx `0x4173e814…25e2`) | — | External | — | Consensus contract: `ExternalAllocationInvalid` (a GenVM transfer is an Internal message) |
| 4 | Explicit **Internal** allocation: recipient = wallet, unnamed call key, `onAcceptance: false`, budget 0.05 GEN (mode 2) | `0x4391d5ea…4b95` | SUCCESS | **1** (`totalMessageFees: 0.05 GEN`) | created (0.1 GEN, `on: finalized`) | **not executed**: `triggered_transactions: []`, the 0.05 GEN message budget was **refunded in full**, contract balance unchanged |
| 5 | Probe variant that emits the transfer **on ACCEPTED** (`emit_transfer(..., on="accepted")`) + Internal allocation with `onAcceptance: true` | `0x837b25db…0c1a` (probe `0xa6AAaFe6…0AB4`) | **ERROR** | 1 | rejected by GenVM | `EmitInternalMessage` → `SystemError: 2: inval` |
| 6 | Newer `genlayer-js` / `@genlayer/transaction-kit` | — | — | — | — | None exist: we already use the latest published versions (genlayer-js 2.0.0-rc.1, transaction-kit 0.1.0-rc.2). |
| 7 | Same probe on **Bradbury testnet (chain 4221)** for comparison | — | — | — | — | **Not run**: we have no Bradbury test GEN. Its faucet needs a browser and human checks we cannot do for you. If you send test GEN to `0x8F9726eA4aE0B479c6f4D4fB26982F3b44607398` on Bradbury, `scripts/payout-test.mjs` can be pointed at it. |
| 8 | Same probe on **Studionet (chain 61999)**, where Passport said payouts worked (190 test GEN were sent there for this test) | `0x6e221eca…909e`, `0x31046831…2ac6` | — | plain and Internal allocation | — | **Inconclusive**: every transaction in this run (deploy `0xb1bd9968…9a6a`, deposit `0x54bec754…9b1b`, both withdraws) finalized as `NO_MAJORITY` with **zero round validators**, so no contract code ran. Studionet had no active validators at test time. |

Earlier evidence: the Day-0 probe on the first contract (`withdraw` tx `0x3b34ad63…1fa23f61`) behaved like attempt 1. See [`DAY0_RESULTS.md`](DAY0_RESULTS.md).

## Reading of the evidence

- Our contract does emit the transfer correctly. The message shows up with the right value and recipient.
- Without an allocation, the message has no budget. With a correct Internal allocation, it has a budget, and that budget is refunded unused. In both cases Studio Next never creates or runs the child transaction.
- Emitting on acceptance is rejected by GenVM itself.
- A notice in the Studio Dev web UI (seen by the project owner on 2026-10-14) says support for token transfers and contract-to-contract interactions "will be added in future updates". That is consistent with everything above.
- This matches what the Passport project reported on 61997 (`fee no_matching_allocation`). Their code moved funds on Studio (61999).

## What the product does about it

- Released funds are **credited to the payee inside the vault** (`credits` ledger). The guarded decision is fully on-chain and enforced.
- The **Withdraw** button stays, with a warning next to it saying the transfer may not arrive on Studio Next.
- The site, README and feed say "credited to the payee inside the vault", never "released to the payee's wallet". The limitation is shown at the top of the page and next to each vault, not only at the bottom.
