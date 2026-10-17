// Deploy a contract to GenLayer Studio Next (chain 61997) with the owner test wallet and record it.
//
//   node scripts/deploy-contract.mjs contracts/trustgate_vault.py vault
//
// Every deployment (old ones too) is kept in experiments/deployments.json.
// The owner key is read from .env.local (CUSTODY_TEST_PRIVATE_KEY) and never printed.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createAccount, createClient } from "genlayer-js";
import { studioDevnet } from "genlayer-js/chains";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOG = path.join(ROOT, "experiments", "deployments.json");
const [file, role] = process.argv.slice(2);
if (!file || !role) throw new Error("Usage: node scripts/deploy-contract.mjs <contract.py> <role>");

const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, ".env.local"), "utf8").split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const client = createClient({ chain: studioDevnet, account: createAccount(env.CUSTODY_TEST_PRIVATE_KEY) });
const code = fs.readFileSync(path.join(ROOT, file), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function retry(fn) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= 4 || !/fetch failed|ECONNRESET|socket|other side closed/i.test(String(e?.details || e?.message))) throw e;
      await sleep(i * 4000);
    }
  }
}

await retry(() => client.getContractSchemaForCode(code)); // free check: never pay for a deploy GenVM would reject
const e = await retry(() => client.estimateTransactionFees());
const hash = await retry(() => client.deployContract({ code, args: [], fees: { distribution: e.distribution, messageAllocations: e.messageAllocations, feeValue: e.feeValue } }));
let tx;
for (let i = 0; i < 120; i++) {
  try {
    tx = await client.getTransaction({ hash });
    if (["ACCEPTED", "FINALIZED", "UNDETERMINED", "CANCELED"].includes(String(tx?.statusName).toUpperCase())) break;
  } catch {}
  await sleep(5000);
}
const leader = tx?.consensus_data?.leader_receipt?.[0];
const address = tx?.data?.contract_address ?? tx?.recipient ?? tx?.to_address;
const ok = String(leader?.execution_result).toUpperCase() === "SUCCESS";
const log = fs.existsSync(LOG) ? JSON.parse(fs.readFileSync(LOG, "utf8")) : [];
log.push({
  role, file, address, tx: hash, ok, chain: studioDevnet.id, at: new Date().toISOString(),
  sha256: crypto.createHash("sha256").update(code).digest("hex"),
});
fs.writeFileSync(LOG, JSON.stringify(log, null, 2) + "\n");
console.log(`${ok ? "Deployed" : "FAILED"} ${role}: ${address} · https://explorer-studio-dev.genlayer.com/tx/${hash}`);
if (!ok) process.exit(1);
