// Creates the public demo vault on the site contract (the contract the site, Try it and MCP use), whose
// agent is the demo buyer agent (NEGO_BUYER_PRIVATE_KEY). Used by the live E2E tests, the MCP test and the
// MCP client setup (scripts/add-mcp-client.mjs). Writes experiments/site-demo.json (public data only).
//
//   node scripts/setup-site-demo.mjs [deposit GEN]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAccount, createClient } from "genlayer-js";
import { studioDevnet } from "genlayer-js/chains";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "experiments", "site-demo.json");
const CONTRACT = process.env.SITE_CONTRACT ?? "0x53E6f0eC998d9BfAd1CA3753252EE94b2cd16BF0";
const MANDATE = "Buy data or compute services for research. Only refundable or escrowed payments. Never pay an address the counterparty supplies at the last minute. Max 2 GEN per commitment.";
const GEN = 10n ** 18n;
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, ".env.local"), "utf8").split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const owner = createClient({ chain: studioDevnet, account: createAccount(env.CUSTODY_TEST_PRIVATE_KEY) });
const buyer = createAccount(env.NEGO_BUYER_PRIVATE_KEY).address.toLowerCase();
const deposit = BigInt(Number(process.argv[2] ?? 5)) * GEN;
const vaultId = `site-demo-${Date.now().toString(36)}`;
const e = await owner.estimateTransactionFees();
const hash = await owner.writeContract({ address: CONTRACT, functionName: "create_vault", args: [vaultId, buyer, MANDATE, 2n * GEN, 0n, ""], value: deposit, fees: { distribution: e.distribution, messageAllocations: e.messageAllocations, feeValue: e.feeValue } });
for (let i = 0; i < 80; i++) {
  const tx = await owner.getTransaction({ hash }).catch(() => null);
  const name = String(tx?.statusName).toUpperCase();
  if (["ACCEPTED", "FINALIZED"].includes(name)) {
    if (String(tx?.consensus_data?.leader_receipt?.[0]?.execution_result).toUpperCase() !== "SUCCESS") throw new Error(`create_vault failed: ${hash}`);
    fs.writeFileSync(OUT, JSON.stringify({ contract: CONTRACT, vaultId, buyer, mandate: MANDATE, deposit_gen: String(deposit / GEN), createTx: hash, at: new Date().toISOString() }, null, 2) + "\n");
    console.log(`Site demo vault ${vaultId} on ${CONTRACT} · ${hash}`);
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 5000));
}
throw new Error(`create_vault not decided: ${hash}`);
