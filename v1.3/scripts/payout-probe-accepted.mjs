// Payout investigation, part 2: a probe whose transfer is emitted on ACCEPTED (not FINALIZED),
// withdrawn with an explicit Internal message allocation (onAcceptance: true).
//
//   node scripts/payout-probe-accepted.mjs
//
// Uses the E2E owner wallet (E2E_OWNER_PRIVATE_KEY). Appends to experiments/payouts.json.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAccount, createClient, encodeInternalMessageFeeParams } from "genlayer-js";
import { studioDevnet } from "genlayer-js/chains";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOG = path.join(ROOT, "experiments", "payouts.json");
const RPC = studioDevnet.rpcUrls.default.http[0];
const GEN = 10n ** 18n;
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, ".env.local"), "utf8").split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const account = createAccount(env.E2E_OWNER_PRIVATE_KEY);
const client = createClient({ chain: studioDevnet, account });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rpc = async (m, p) => (await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) })).json()).result;
const bal = async (a) => BigInt(await rpc("eth_getBalance", [a, "latest"]));
const plainFees = async () => { const e = await client.estimateTransactionFees(); return { distribution: e.distribution, messageAllocations: e.messageAllocations, feeValue: e.feeValue }; };

async function waitTx(hash) {
  for (let i = 0; i < 120; i++) {
    try {
      const tx = await client.getTransaction({ hash });
      if (["FINALIZED", "UNDETERMINED", "CANCELED"].includes(String(tx?.statusName).toUpperCase())) return tx;
    } catch {}
    await sleep(5000);
  }
  throw new Error(`timeout ${hash}`);
}

const code = fs.readFileSync(path.join(ROOT, "experiments", "custody_probe_accepted.py"), "utf8");
await client.getContractSchemaForCode(code);
const deployHash = await client.deployContract({ code, args: [], fees: await plainFees() });
const dtx = await waitTx(deployHash);
const probe = dtx?.data?.contract_address ?? dtx?.recipient;
console.log(`probe ${probe} (${dtx.consensus_data?.leader_receipt?.[0]?.execution_result})`);

const depHash = await client.writeContract({ address: probe, functionName: "deposit", args: [], value: GEN / 5n, fees: await plainFees() });
await waitTx(depHash);

const amount = GEN / 10n;
const messageAllocations = [{
  messageType: 1, onAcceptance: true, recipient: account.address, callKey: "0x" + "00".repeat(32), budget: GEN / 20n,
  feeParams: encodeInternalMessageFeeParams({ leaderTimeunitsAllocation: 100n, validatorTimeunitsAllocation: 200n, appealRounds: 0n, executionBudgetPerRound: GEN / 100n, rotations: [0n], maxPriceGenPerTimeUnit: 2n, storageFeeMaxGasPrice: 300000000n, receiptFeeMaxGasPrice: 300000000n }),
}];
const e = await client.estimateTransactionFees({ messageAllocations });
const probeBefore = await bal(probe);
const walletBefore = await bal(account.address);
const wHash = await client.writeContract({ address: probe, functionName: "withdraw", args: [amount], fees: { distribution: e.distribution, messageAllocations: e.messageAllocations ?? messageAllocations, feeValue: e.feeValue } });
const wtx = await waitTx(wHash);
await sleep(45000);
const probeAfter = await bal(probe);
const walletAfter = await bal(account.address);
const raw = (await rpc("sim_getTransactionsForAddress", [probe])).find((t) => t.hash === wHash);
const leader = raw?.consensus_data?.leader_receipt?.[0];
const result = {
  mode: "probe-on-accepted + internal allocation (onAcceptance)", chain: studioDevnet.id, at: new Date().toISOString(), probe, deployTx: deployHash, depositTx: depHash, withdrawTx: wHash,
  status: wtx.statusName, execution: leader?.execution_result, error: leader?.execution_result === "SUCCESS" ? null : String(leader?.result?.payload ?? raw?.consensus_data?.leader_receipt?.[0]?.genvm_result?.stderr ?? "").slice(-300),
  messageAllocationsCount: raw?.data?.message_allocations_count,
  pendingTransactions: (leader?.pending_transactions ?? []).map((p) => ({ on: p.on, value: p.value, address: p.address })),
  triggeredTransactions: raw?.triggered_transactions ?? [],
  messageRefund: raw?.data?.fee_accounting?.refunds?.[0]?.message ?? null,
  probeDelta: String(probeAfter - probeBefore), walletDelta: String(walletAfter - walletBefore),
  payoutArrived: probeBefore - probeAfter >= amount,
};
const log = fs.existsSync(LOG) ? JSON.parse(fs.readFileSync(LOG, "utf8")) : [];
log.push(result);
fs.writeFileSync(LOG, JSON.stringify(log, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
