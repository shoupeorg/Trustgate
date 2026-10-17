// Writes the README headline and benchmark block from lib/benchmark-summary.json (which is built
// from committed raw results by scripts/summarize-benchmark.mjs). Replaces the text between
// <!-- HEADLINE:START/END --> and <!-- BENCH:START/END --> markers.
//
//   node scripts/render-readme.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const S = JSON.parse(fs.readFileSync(path.join(ROOT, "lib", "benchmark-summary.json"), "utf8"));
const R = (run, link) => run && `[${run.label}](${run.dir}/results.md)${link ? "" : ""}`;
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "-");

function onchainTable(run) {
  if (!run) return "";
  const row = (name, m) => `| ${name} | ${m.correct}/${m.scored} | **${m.unsafePaid}** | ${m.grey[0]}/${m.grey[1]} | ${m.inject[0]}/${m.inject[1]} | ${m.falseBlocks} |`;
  return [
    `**${R(run)}**`, "",
    "| On-chain option | Correct | Unsafe payments made | Grey cases caught | Judge-targeted injections caught | Safe requests blocked |",
    "|---|---|---|---|---|---|",
    row("Normal smart contract (hard-coded rules)", run.methods.rules),
    row("**TrustGate on GenLayer**", run.methods.trustgate),
    "",
  ].join("\n");
}
function offchainTable(run) {
  if (!run) return "";
  const row = (name, m) => m ? `| ${name} | ${m.correct}/${m.scored} | ${m.unsafePaid} | ${m.grey[0]}/${m.grey[1]} | ${m.inject[0]}/${m.inject[1]} | ${m.falseBlocks} |` : "";
  return [
    `**${R(run)}**`, "",
    "| System | Correct | Unsafe payments made | Grey caught | Injections caught | Safe requests blocked |",
    "|---|---|---|---|---|---|",
    row("Single AI model, plain prompt (private server)", run.methods.llm_plain),
    row("Single AI model, TrustGate's prompt (private server)", run.methods.llm_prompt),
    row("TrustGate on GenLayer (reference)", run.methods.trustgate),
    "",
  ].filter((l) => l !== "").join("\n") + "\n";
}

const head = S.heldout ?? S.main;
const headline = head
  ? `> **Without GenLayer, the blockchain approved ${head.methods.rules.unsafePaid} unsafe payment${head.methods.rules.unsafePaid === 1 ? "" : "s"}. With GenLayer, ${head.methods.trustgate.unsafePaid}.**\n> ${head.label}: the same ${head.methods.rules.scored} requests checked by a normal smart contract with hard-coded rules and by TrustGate on GenLayer. Details in [Benchmark](#benchmark).`
  : "";

const rob = S.robustness;
const robTable = rob ? [
  `**Robustness:** every grey and judge-targeted injection case (both sets), ${rob.runs} runs each. Unsafe ACCEPT rate = runs where funds would move; flip rate = runs that differ from the case's most common answer. ([per case](experiments/robustness/results.md))`, "",
  "| System | Runs | Unsafe ACCEPT rate | Flip rate |", "|---|---|---|---|",
  ...[["trustgate", "TrustGate on GenLayer"], ["llm_plain", "Single AI model, plain prompt"], ["llm_prompt", "Single AI model, TrustGate's prompt"]].map(([k, n]) => { const x = rob.systems[k]; return x ? `| ${n} | ${x.runs} | ${x.unsafe} (${pct(x.unsafe, x.runs)}) | ${x.flips} (${pct(x.flips, x.runs)}) |` : ""; }),
  "",
].join("\n") : "";

const bench = [
  "Every number below is generated from committed raw results (`lib/benchmark-summary.json`, built by `scripts/summarize-benchmark.mjs`).",
  "",
  "### On-chain: a normal smart contract vs. TrustGate on GenLayer",
  "",
  "Both keep the money on-chain with nobody in control. The difference is whether the contract understands the deal. **Grey** cases pass every hard-coded rule and keyword check (a payout wallet \"updated this morning\", escrow the seller controls, refunds \"at the vendor's discretion\"). **Judge-targeted injections** try to order the reviewer to approve.",
  "",
  onchainTable(S.heldout),
  onchainTable(S.main),
  "The held-out set was written and committed before the false-block fix and never used for tuning; it is the result that counts. These cases show behaviour, not a precise accuracy; we wrote them ourselves. In the 41-case set, limit-03 (a 0 GEN, harmless case) is not scored for any method, and on the negotiation contract TrustGate could not even be asked: the contract refuses 0 GEN offers.",
  "",
  ...(S.negotiation ? (() => { const n = S.negotiation; const tg = n.systems.trustgate; return [
    `**[${n.label}](${n.dir}/results.md)**: does GenLayer give the decision a careful owner expects?`, "",
    "| Expected decision | Cases | TrustGate on GenLayer | Normal smart contract |", "|---|---|---|---|",
    `| RENEGOTIATE (fixable terms) | ${n.expected.RENEGOTIATE} | ${tg.by.RENEGOTIATE}/${n.expected.RENEGOTIATE} | cannot renegotiate |`,
    `| REJECT | ${n.expected.REJECT} | ${tg.by.REJECT}/${n.expected.REJECT} | cannot judge |`,
    `| ACCEPT | ${n.expected.ACCEPT} | ${tg.by.ACCEPT}/${n.expected.ACCEPT} | — |`,
    `| **Unsafe payments made** | | **${tg.unsafePaid}** | **${n.systems.rules.unsafePaid}** |`, "",
  ]; })() : []),
  "",
  "### Off-chain comparison: a centralized AI gate on a private server (what you'd build without GenLayer)",
  "",
  "A single AI model on a private server reaches similar accuracy, but it cannot hold funds without an owner, so it is not an on-chain alternative.",
  "",
  offchainTable(S.heldout),
  offchainTable(S.main),
  robTable,
  "### Earlier runs (kept as published)",
  "",
  "- [Held-out on the first negotiation contract (v5 rules)](experiments/benchmark/run-heldout-negotiation/results.md) (TrustGate 31/31, 0 unsafe) · [run-41-v5](experiments/benchmark/run-41-v5/results.md) (38/40) · [Held-out on the v5 one-sided contract](experiments/benchmark/run-heldout-v5/results.md) (TrustGate 31/31, 0 unsafe) · [Fix diagnosis of the 4 false blocks](experiments/benchmark/false-block-diagnosis.json) · [run-41-v4](experiments/benchmark/run-41-v4/results.md) (first fix) · [run-41-v3](experiments/benchmark/run-41-v3/results.md) (before the fix: TrustGate 36/40, 4 safe blocked) · [allowlist variant](experiments/benchmark/run-41-v3-allowlist/results.md) (extra false-block test, not GenLayer-measuring) · [run-41](experiments/benchmark/run-41/results.md) · [first 20-case run](experiments/benchmark/results.md)",
  "",
].join("\n");

for (const file of ["README.md", "docs/TrustGate_V1.3_Overview.md"]) {
  let text = fs.readFileSync(path.join(ROOT, file), "utf8").replace(/\r\n/g, "\n");
  // Links in the overview are relative to docs/.
  const fix = (body) => (file.startsWith("docs/") ? body.replace(/\]\((experiments|lib)\//g, "](../$1/") : body);
  const put = (name, body) => {
    const re = new RegExp(`<!-- ${name}:START -->[\\s\\S]*?<!-- ${name}:END -->`);
    if (!re.test(text)) throw new Error(`markers ${name} missing in ${file}`);
    text = text.replace(re, () => `<!-- ${name}:START -->\n${fix(body)}\n<!-- ${name}:END -->`);
  };
  put("HEADLINE", headline);
  put("BENCH", bench);
  fs.writeFileSync(path.join(ROOT, file), text);
  console.log(`${file}: headline and benchmark updated from lib/benchmark-summary.json`);
}
