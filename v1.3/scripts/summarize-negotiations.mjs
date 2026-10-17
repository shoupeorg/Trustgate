// Writes experiments/negotiation-demo/README.md: every two-agent run (kept as published, including
// the ones that went wrong), with contract, outcome, verdicts and transaction links.
//
//   node scripts/summarize-negotiations.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "experiments", "negotiation-demo");
const TX = "https://explorer-studio-dev.genlayer.com/tx/";
const V6 = "0x3C61e0C6634d78f6a38efFA6B1872AC11A76f7f3";
const state = JSON.parse(fs.readFileSync(path.join(DIR, "state.json"), "utf8"));
const first = JSON.parse(fs.readFileSync(path.join(DIR, "state-first-negotiation-contract.json"), "utf8"));
const NOTES = {
  "reneg-accept-2026-10-15T07-40-56-561Z": "First buyer prompt: the buyer judged the mandate itself and withdrew before asking TrustGate. Buyer prompt changed afterwards (policy is TrustGate's job).",
  "seller-refuses-2026-10-15T07-41-55-016Z": "First buyer prompt: same as above, the buyer withdrew before asking TrustGate.",
  "seller-refuses-2026-10-15T07-47-13-976Z": "Invalid as a demonstration: the demo vault had run low (5 GEN deposited, 3.5 GEN already paid out), so v1 was blocked by the vault_balance hard limit, not judged. Vault topped up by 6 GEN afterwards.",
  "reneg-accept-2026-10-15T07-55-25-047Z": "Retry for a RENEGOTIATE on v1: the seller agent wrote compliant terms from the start, so no negotiation was needed.",
  "reneg-accept-2026-10-15T07-56-45-958Z": "Second retry: same, ACCEPT on v1. Retries on the v5 contract stopped here.",
  "reneg-accept-2026-10-15T09-14-46-049Z": "v6 attempt 1: compliant terms from the start, ACCEPT on v1.",
  "reneg-accept-2026-10-15T09-15-37-509Z": "v6 attempt 2: same.",
  "reneg-accept-2026-10-15T09-16-41-988Z": "v6 attempt 3: RENEGOTIATE, the seller agent signed the counterproposal word for word, then ACCEPT. This is the requested RENEGOTIATE → seller signs → ACCEPT case.",
  "seller-refuses-2026-10-15T09-19-29-854Z": "v6 attempt 1: the buyer agent withdrew before requesting.",
  "seller-refuses-2026-10-15T09-20-26-680Z": "v6 attempt 2: RENEGOTIATE; the seller refused the safer terms (countered with the same non-refundable terms); the buyer withdrew. Deal died.",
};
const runs = fs.readdirSync(DIR).filter((f) => f.endsWith(".json") && !f.startsWith("state")).sort().map((f) => ({ name: f.replace(/\.json$/, ""), ...JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")) }));
const verdicts = (r) => (r.steps ?? []).filter((s) => s.who === "GenLayer validators").map((s) => `[${s.what.replace(/^verdict on /, "")}](${TX}${s.tx})`).join(" → ") || "none";
const topUps = [...(first.topUps ?? []).map((t) => ({ ...t, vault: first.vaultId })), ...(state.topUps ?? []).map((t) => ({ ...t, vault: state.vaultId }))];
const lines = [
  "# Two-agent negotiations on GenLayer (TrustGate V1.3)", "",
  `Current: contract \`${state.contract}\` (v6 rules), public demo vault \`${state.vaultId}\`. Earlier runs used the first negotiation contract \`${first.contract}\` (v5 rules, vault \`${first.vaultId}\`). Buyer agent \`${state.buyer}\` · seller agent \`${state.seller}\`.`,
  `Mandate: *${state.mandate}*`, "",
  "Each run is two separate AI agents with no human in the loop (both think with GenLayer's model via `contracts/agent_brain.py`); GenLayer validators judge every request. Every run is kept, including the ones that went wrong.", "",
  "| Run | Contract | Scenario | Outcome | Verdicts | Note |", "|---|---|---|---|---|---|",
  ...runs.map((r) => `| [${r.name}](${r.name}.md) | ${r.contract === V6 ? "v6 (current)" : "v5 negotiation"} | ${r.scenario} | **${r.outcome ?? "unfinished"}** | ${verdicts(r)} | ${NOTES[r.name] ?? ""} |`),
  "", "Vault top-ups:", ...topUps.map((t) => `- ${t.vault}: ${t.amount_gen} GEN · [tx](${TX}${t.tx}) · ${t.why}`), "",
];
fs.writeFileSync(path.join(DIR, "README.md"), lines.join("\n"));
console.log(`${runs.length} runs summarized`);
