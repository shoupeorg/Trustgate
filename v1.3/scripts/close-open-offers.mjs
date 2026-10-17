// Declines a seller's still-open negotiations on one vault (used when a benchmark case failed on a network
// error after its offer was posted, so it would otherwise count against the 3-open-offers limit).
//
//   node --experimental-strip-types scripts/close-open-offers.mjs <vaultId> [ENV_KEY_NAME=BENCH_SELLER_PRIVATE_KEY]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAccount, createClient } from "genlayer-js";
import { studioDevnet } from "genlayer-js/chains";
import { buildNegotiations } from "../lib/negotiation.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [vaultId, keyName = "BENCH_SELLER_PRIVATE_KEY"] = process.argv.slice(2);
const CONTRACT = process.env.CONTRACT ?? "0x3C61e0C6634d78f6a38efFA6B1872AC11A76f7f3";
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, ".env.local"), "utf8").split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const account = createAccount(env[keyName]);
const client = createClient({ chain: studioDevnet, account });
const res = await fetch(`https://trustgate-v13.shoupeorg.workers.dev/api/vault-feed?contract=${CONTRACT}`);
const book = buildNegotiations((await res.json()).events);
const open = [...book.negotiations.values()].filter((n) => n.vaultId === vaultId && n.seller === account.address.toLowerCase() && n.status === "OPEN" && n.latest.status !== "JUDGING");
console.log(`${open.length} open negotiation(s) to close`);
for (const n of open) {
  const e = await client.estimateTransactionFees();
  const hash = await client.writeContract({ address: CONTRACT, functionName: "decline", args: [n.latest.offerId, "benchmark case failed on a network error; closed"], fees: { distribution: e.distribution, messageAllocations: e.messageAllocations, feeValue: e.feeValue } });
  for (let i = 0; i < 40; i++) {
    const tx = await client.getTransaction({ hash }).catch(() => null);
    if (["ACCEPTED", "FINALIZED"].includes(String(tx?.statusName).toUpperCase())) break;
    await new Promise((r) => setTimeout(r, 4000));
  }
  console.log(`declined ${n.negotiationId}: ${hash}`);
}
