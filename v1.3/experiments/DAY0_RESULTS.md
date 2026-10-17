# Day-0 custody probe — results (GenLayer Studio Next, chain 61997)

Date: 2026-10-14 · Probe contract: `0xc98d2293caB5E980db586a0beFF8Ac6134cdd6A6` · Test wallet: `0x8F9726eA4aE0B479c6f4D4fB26982F3b44607398`

| Step | Tx | GenVM | Effect observed |
|---|---|---|---|
| deploy | `0xd5384a46a76b6c76a28c0ecf512e41fa47250923daa1218f8b36a460dc916798` | SUCCESS, finalized | contract created |
| deposit 2 GEN | `0x7e15189b…63933d23` | SUCCESS, finalized | contract native balance 0 → 2 GEN |
| move_internal 0.5 GEN | `0x52fa24ab24b99d40775991cdfe7a63d0d5ef51d16f9a4f6effe26946bd1b6380` | SUCCESS, finalized | returned `{"ok": true, ...}`; contract balance unchanged (internal ledger only) |
| withdraw 1 GEN | `0x3b34ad63…1fa23f61` | SUCCESS, finalized, returned `{"ok": true, "paid": ...}` | **no native transfer**: contract balance stays 2 GEN |

## Conclusions

1. **Custody works.** An Intelligent Contract on 61997 can receive and hold GEN.
2. **Internal ledger moves work.** This is the guarded "release" path TrustGate v2 relies on.
3. **Contract → wallet payout does not arrive.** `withdraw` executes successfully and debits the ledger,
   but the `emit_transfer` child message never moves funds. This matches the known Studio Next fee-layer
   issue reported by the Passport project. Because the ledger is debited, the withdrawn amount ends up
   stuck in the contract. Keep the credit+withdraw design, and treat withdraw as unavailable on Studio Next.

## Other findings

- **Header must be followed by a blank line.** If `# { "Depends": ... }` is followed directly by more `#`
  comment lines, the GenVM rejects the contract with `invalid_contract runner malformed`. The deploy
  transaction is still charged and still returns an address. `gen_getContractSchemaForCode` catches this
  for free. `custody_probe.py` was fixed. `contracts/trustgate_vault.py` has the same problem and needs the same fix.
- **Every transaction needs a fee** (`FeeValueMustBeNonZero` otherwise). Policy estimate ≈ 0.1 GEN per tx.
- **Studio Next contract reads (`gen_call`) and write simulations were failing server-side** during the run
  (`Can't reconnect until invalid transaction is rolled back`). Writes still went through. Results above
  are based on receipts and native balances, not on contract reads.
- An earlier run sent 2 GEN to a contract whose deploy had failed (script bug, now fixed: the script stops
  if the deploy or the deposit fails). That 2 GEN is lost.
