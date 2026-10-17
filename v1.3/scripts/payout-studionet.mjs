// Payout comparison on GenLayer Studionet (chain 61999): the same custody probe as the Day-0 test.
// Deploy, deposit 1 GEN, withdraw 0.5 GEN (plain fees; then with an Internal message allocation
// if the plain one does not arrive), and check whether the GEN leaves the contract.
//
//   node scripts/payout-studionet.mjs
//
// Owner key: CUSTODY_TEST_PRIVATE_KEY (same address on both chains). Appends to experiments/payouts.json.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAccount, createClient, encodeInternalMessageFeeParams } from "genlayer-js";
import { studionet } from "genlayer-js/chains";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOG = path.join(ROOT, "experiments", "payouts.json");
const RPC = studionet.rpcUrls.default.http[0];
const GEN = 10n ** 18n;
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, ".env.local"), "utf8").split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const account = createAccount(env.CUSTODY_TEST_PRIVATE_KEY);
const client = createClient({ chain: studionet, account });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rpc = async (m, p) => (await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) })).json()).result;
const bal = async (a) => BigInt(await rpc("eth_getBalance", [a, "latest"]));

async function fees(messageAllocations) {
  try {
    const e = await client.estimateTransactionFees(messageAllocations ? { messageAllocations } : undefined);
    return { distribution: e.distribution, messageAllocations: e.messageAllocations ?? messageAllocations, feeValue: e.feeValue };
  } catch {
    return undefined; // gasless network: no fee object needed
  }
}
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
const leaderOf = (tx) => tx?.consensus_data?.leader_receipt?.[0] ?? tx?.consensus_data?.leader_receipt;

const code = fs.readFileSync(path.join(ROOT, "experiments", "custody_probe.py"), "utf8");
const deployHash = await client.deployContract({ code, args: [], fees: await fees() });
const dtx = await waitTx(deployHash);
const probe = dtx?.data?.contract_address ?? dtx?.recipient;
console.log(`probe ${probe} on 61999 (${leaderOf(dtx)?.execution_result}) deploy ${deployHash}`);
const depositHash = await client.writeContract({ address: probe, functionName: "deposit", args: [], value: GEN, fees: await fees() });
const dep = await waitTx(depositHash);
console.log(`deposit ${leaderOf(dep)?.execution_result}, contract holds ${Number(await bal(probe)) / 1e18} GEN`);

async function attempt(label, messageAllocations) {
  const amount = GEN / 4n;
  const probeBefore = await bal(probe);
  const walletBefore = await bal(account.address);
  const hash = await client.writeContract({ address: probe, functionName: "withdraw", args: [amount], fees: await fees(messageAllocations) });
  const tx = await waitTx(hash);
  let probeAfter = probeBefore;
  for (let i = 0; i < 12 && probeAfter === probeBefore; i++) {
    await sleep(10000);
    probeAfter = await bal(probe);
  }
  const walletAfter = await bal(account.address);
  const leader = leaderOf(tx);
  const result = {
    mode: `studionet: ${label}`, chain: studionet.id, at: new Date().toISOString(), probe, deployTx: deployHash, depositTx: depositHash, withdrawTx: hash,
    status: tx.statusName, execution: leader?.execution_result,
    pendingTransactions: (leader?.pending_transactions ?? []).map((p) => ({ on: p.on, value: String(p.value), address: p.address })),
    triggeredTransactions: tx.triggered_transactions ?? [],
    probeDelta: String(probeAfter - probeBefore), walletDelta: String(walletAfter - walletBefore),
    payoutArrived: probeBefore - probeAfter >= amount,
  };
  const log = fs.existsSync(LOG) ? JSON.parse(fs.readFileSync(LOG, "utf8")) : [];
  log.push(result);
  fs.writeFileSync(LOG, JSON.stringify(log, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
  return result.payoutArrived;
}

const plainArrived = await attempt("plain fees", undefined);
if (!plainArrived) {
  await attempt("internal message allocation", [{
    messageType: 1, onAcceptance: false, recipient: account.address, callKey: "0x" + "00".repeat(32), budget: GEN / 20n,
    feeParams: encodeInternalMessageFeeParams({ leaderTimeunitsAllocation: 100n, validatorTimeunitsAllocation: 200n, appealRounds: 0n, executionBudgetPerRound: GEN / 100n, rotations: [0n], maxPriceGenPerTimeUnit: 2n, storageFeeMaxGasPrice: 300000000n, receiptFeeMaxGasPrice: 300000000n }),
  }]);
}
