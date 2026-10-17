// Payout investigation: does withdraw() deliver GEN to the wallet when the transaction carries a
// budget for the child transfer message?
//
//   node scripts/payout-test.mjs <none|pool|alloc> [amount GEN] [--chain studio|bradbury]
//
// none  - fees as before (no message budget)            -> baseline
// pool  - distribution.totalMessageFees > 0 (mode 1)     -> messages draw from a pool
// alloc - explicit messageAllocations for the transfer   -> mode 2
//
// Uses the E2E owner wallet (E2E_OWNER_PRIVATE_KEY): owner_reclaim from one of its vaults, then
// withdraw. Records balances before/after and the receipt's message fields in experiments/payouts.json.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAccount, createClient, encodeExternalMessageFeeParams, encodeInternalMessageFeeParams } from "genlayer-js";
import { studioDevnet } from "genlayer-js/chains";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOG = path.join(ROOT, "experiments", "payouts.json");
const [mode = "pool", amountArg = "0.1"] = process.argv.slice(2);
const CONTRACT = "0xcc4A54239cdfaa491d2C6Ba2E755b269c8D71347";
const RPC = studioDevnet.rpcUrls.default.http[0];
const GEN = 10n ** 18n;
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, ".env.local"), "utf8").split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const account = createAccount(env.E2E_OWNER_PRIVATE_KEY);
const client = createClient({ chain: studioDevnet, account });
const amount = BigInt(Math.round(Number(amountArg) * 1e6)) * (GEN / 1_000_000n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rpc = async (m, p) => (await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) })).json()).result;
const bal = async (a) => BigInt(await rpc("eth_getBalance", [a, "latest"]));

async function waitTx(hash) {
  for (let i = 0; i < 120; i++) {
    const txs = await rpc("sim_getTransactionsForAddress", [CONTRACT]).catch(() => null);
    const tx = txs?.find((t) => t.hash === hash);
    if (tx && ["ACCEPTED", "FINALIZED", "UNDETERMINED", "CANCELED"].includes(String(tx.status).toUpperCase()) && (tx.status === "FINALIZED" || i > 60)) return tx;
    await sleep(5000);
  }
  throw new Error(`timeout ${hash}`);
}

async function feesFor(kind) {
  if (kind === "none") {
    const e = await client.estimateTransactionFees();
    return { distribution: e.distribution, messageAllocations: e.messageAllocations, feeValue: e.feeValue };
  }
  if (kind === "pool") {
    const e = await client.estimateTransactionFees({ totalMessageFees: GEN / 20n }); // 0.05 GEN pool
    return { distribution: e.distribution, messageAllocations: e.messageAllocations, feeValue: e.feeValue };
  }
  // alloc: one Internal message (GenVM emit_transfer to an address), unnamed call key, triggered on
  // finalization, with its own fee budget. ALLOC_TYPE=external tries the External variant instead.
  const external = process.env.ALLOC_TYPE === "external";
  const messageAllocations = [{
    messageType: external ? 0 : 1,
    onAcceptance: false,
    recipient: account.address,
    callKey: "0x" + "00".repeat(32),
    budget: GEN / 20n,
    feeParams: external
      ? encodeExternalMessageFeeParams({ gasLimit: 100000n, maxGasPrice: 10n ** 12n })
      : encodeInternalMessageFeeParams({ leaderTimeunitsAllocation: 100n, validatorTimeunitsAllocation: 200n, appealRounds: 0n, executionBudgetPerRound: GEN / 100n, rotations: [0n], maxPriceGenPerTimeUnit: 2n, storageFeeMaxGasPrice: 300000000n, receiptFeeMaxGasPrice: 300000000n }),
  }];
  const e = await client.estimateTransactionFees({ messageAllocations });
  return { distribution: e.distribution, messageAllocations: e.messageAllocations ?? messageAllocations, feeValue: e.feeValue };
}
void encodeInternalMessageFeeParams;

// Find a vault owned by this wallet with funds (from history), reclaim `amount`, then withdraw.
const txs = await rpc("sim_getTransactionsForAddress", [CONTRACT]);
const mine = txs.filter((t) => t.from_address.toLowerCase() === account.address.toLowerCase());
const { abi } = await import("genlayer-js");
const vaultIds = mine.map((t) => {
  try {
    const d = abi.calldata.decode(Uint8Array.from(Buffer.from(t.data.calldata, "base64")));
    const o = d instanceof Map ? Object.fromEntries(d) : d;
    return o[""] === "create_vault" ? o.args[0] : null;
  } catch {
    return null;
  }
}).filter(Boolean);
if (!vaultIds.length) throw new Error("E2E owner has no vault; run the E2E test first");
const vaultId = vaultIds[0];

const e0 = await client.estimateTransactionFees();
const reclaimHash = await client.writeContract({ address: CONTRACT, functionName: "owner_reclaim", args: [vaultId, amount], fees: { distribution: e0.distribution, messageAllocations: e0.messageAllocations, feeValue: e0.feeValue } });
const reclaim = await waitTx(reclaimHash);
console.log(`reclaim ${reclaim.status} ${reclaim.consensus_data?.leader_receipt?.[0]?.execution_result}`);

const walletBefore = await bal(account.address);
const contractBefore = await bal(CONTRACT);
const fees = await feesFor(mode);
const hash = await client.writeContract({ address: CONTRACT, functionName: "withdraw", args: [amount], fees });
const tx = await waitTx(hash);
await sleep(30000);
const walletAfter = await bal(account.address);
const contractAfter = await bal(CONTRACT);
const leader = tx.consensus_data?.leader_receipt?.[0];
const result = {
  mode, chain: studioDevnet.id, at: new Date().toISOString(), amount: amountArg, vaultId, reclaimTx: reclaimHash, withdrawTx: hash,
  status: tx.status, execution: leader?.execution_result,
  messageAllocationsCount: tx.data?.message_allocations_count, totalMessageFees: String(tx.data?.fees_distribution?.totalMessageFees ?? tx.data?.fees_distribution?.total_message_fees ?? ""),
  pendingTransactions: (leader?.pending_transactions ?? []).map((p) => ({ on: p.on, value: p.value, address: p.address })),
  triggeredTransactions: tx.triggered_transactions ?? [],
  feeAccountingStatus: tx.data?.fee_accounting?.status,
  contractDelta: String(contractAfter - contractBefore),
  walletDelta: String(walletAfter - walletBefore),
  payoutArrived: contractBefore - contractAfter >= amount,
};
const log = fs.existsSync(LOG) ? JSON.parse(fs.readFileSync(LOG, "utf8")) : [];
log.push(result);
fs.writeFileSync(LOG, JSON.stringify(log, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
