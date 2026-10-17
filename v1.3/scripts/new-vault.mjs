// Create a fresh TrustGate vault for the demo agent and make it the active vault.
//
//   node scripts/new-vault.mjs [deposit GEN] [cap GEN]     defaults: 15 GEN deposit, 5 GEN cap
//
// Owner = CUSTODY_TEST_PRIVATE_KEY, agent = VAULT_AGENT_PRIVATE_KEY (both in .env.local, never printed).
// Updates vaultId in experiments/vault_demo_state.json; the previous one is kept in previousVaults.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAccount, createClient } from "genlayer-js";
import { studioDevnet } from "genlayer-js/chains";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE = path.join(ROOT, "experiments", "vault_demo_state.json");
const GEN = 10n ** 18n;
const MANDATE =
  "Buy data or compute services for research. Only refundable or escrowed payments. " +
  "Never pay an address the counterparty supplies at the last minute. Max 5 GEN per commitment.";

const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, ".env.local"), "utf8").split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const deposit = BigInt(Math.round(Number(process.argv[2] ?? 15))) * GEN;
const cap = BigInt(Math.round(Number(process.argv[3] ?? 5))) * GEN;
const state = JSON.parse(fs.readFileSync(STATE, "utf8"));
const owner = createAccount(env.CUSTODY_TEST_PRIVATE_KEY);
const agent = createAccount(env.VAULT_AGENT_PRIVATE_KEY);
const client = createClient({ chain: studioDevnet, account: owner });

const vaultId = `vault-${Date.now()}`;
const e = await client.estimateTransactionFees();
const hash = await client.writeContract({
  address: state.contract, functionName: "create_vault", args: [vaultId, agent.address, MANDATE, cap], value: deposit,
  fees: { distribution: e.distribution, messageAllocations: e.messageAllocations, feeValue: e.feeValue },
});
let tx;
for (let i = 0; i < 120; i++) {
  try {
    tx = await client.getTransaction({ hash });
    if (["ACCEPTED", "FINALIZED"].includes(String(tx?.statusName).toUpperCase())) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 5000));
}
const leader = tx?.consensus_data?.leader_receipt?.[0];
const returned = String(leader?.result?.payload?.readable ?? "");
if (String(leader?.execution_result).toUpperCase() !== "SUCCESS" || !returned.includes("true")) {
  console.error(`create_vault failed: https://explorer-studio-dev.genlayer.com/tx/${hash}\n${returned}`);
  process.exit(1);
}
state.previousVaults = [...(state.previousVaults ?? []), state.vaultId];
state.vaultId = vaultId;
fs.writeFileSync(STATE, JSON.stringify(state, null, 2) + "\n");
console.log(`Vault ${vaultId}: ${deposit / GEN} GEN, cap ${cap / GEN} GEN · https://explorer-studio-dev.genlayer.com/tx/${hash}`);
