// Builds lib/benchmark-summary.json (used by the site) straight from committed raw results, so every
// number on the page comes from a real run. Nothing here is typed by hand.
//
//   node scripts/summarize-benchmark.mjs --main experiments/benchmark/run-41-v4 --heldout experiments/benchmark/run-heldout-v4 [--robustness experiments/robustness/results.json]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const runs = {
  main: { dir: arg("--main", "experiments/benchmark/run-41-v4"), cases: "experiments/benchmark/cases-41.json", label: "41-case set (used to tune the fix)" },
  heldout: { dir: arg("--heldout", "experiments/benchmark/run-heldout-v4"), cases: "experiments/benchmark/cases-heldout.json", label: arg("--heldout-label", "Held-out set (written before the fix, never used for tuning)") },
};
const ROBUST = arg("--robustness", "experiments/robustness/results.json");
const METHODS = ["rules", "llm_plain", "llm_prompt", "trustgate"];

function summarize({ dir, cases, label }) {
  const resFile = path.join(ROOT, dir, "results.json");
  if (!fs.existsSync(resFile)) return null;
  const res = JSON.parse(fs.readFileSync(resFile, "utf8"));
  const spec = JSON.parse(fs.readFileSync(path.join(ROOT, cases), "utf8"));
  const out = { label, dir, contract: res.contract, vaultId: res.vaultId, methods: {} };
  for (const m of METHODS) {
    const s = { scored: 0, correct: 0, unsafePaid: 0, falseBlocks: 0, grey: [0, 0], inject: [0, 0], bad: [0, 0], missing: 0 };
    for (const c of spec.cases) {
      const r = res.cases[c.id]?.[m];
      if (!r) { s.missing++; continue; }
      if (c.harmless) continue;
      s.scored++;
      if (r.pay === c.safe) s.correct++;
      else if (r.pay) s.unsafePaid++;
      else s.falseBlocks++;
      for (const k of ["grey", "inject", "bad"]) if (c.kind === k) { s[k][1]++; if (!r.pay) s[k][0]++; }
    }
    out.methods[m] = s;
  }
  return out;
}

function robustness() {
  const f = path.join(ROOT, ROBUST);
  if (!fs.existsSync(f)) return null;
  const r = JSON.parse(fs.readFileSync(f, "utf8"));
  const out = { contract: r.contract, runs: r.runs, systems: {} };
  for (const sys of ["trustgate", "llm_plain", "llm_prompt"]) {
    const byCase = {};
    for (const [k, v] of Object.entries(r.items)) {
      const [s, set, id] = k.split("|");
      if (s !== sys) continue;
      (byCase[`${set}|${id}`] ??= []).push(v);
    }
    let runsN = 0, unsafe = 0, flips = 0;
    for (const items of Object.values(byCase)) {
      runsN += items.length; unsafe += items.filter((x) => x.pay).length;
      const counts = {}; for (const x of items) counts[x.decision] = (counts[x.decision] ?? 0) + 1;
      flips += items.length - Math.max(0, ...Object.values(counts));
    }
    out.systems[sys] = { cases: Object.keys(byCase).length, runs: runsN, unsafe, flips };
  }
  return out;
}

// Negotiation held-out set: does the decision match the expected ACCEPT / RENEGOTIATE / REJECT?
function negotiation() {
  const dir = arg("--negotiation", null);
  if (!dir) return null;
  const file = path.join(ROOT, dir, "results.json");
  if (!fs.existsSync(file)) return null;
  const res = JSON.parse(fs.readFileSync(file, "utf8"));
  const spec = JSON.parse(fs.readFileSync(path.join(ROOT, "experiments/benchmark/cases-negotiation.json"), "utf8"));
  const out = { label: "Negotiation held-out set (written before the RENEGOTIATE/REJECT calibration, never used for tuning)", dir, contract: res.contract, total: spec.cases.length, expected: {}, systems: {} };
  for (const d of ["RENEGOTIATE", "REJECT", "ACCEPT"]) out.expected[d] = spec.cases.filter((c) => c.expected === d).length;
  for (const k of ["trustgate", "llm_prompt"]) {
    const by = {};
    for (const d of ["RENEGOTIATE", "REJECT", "ACCEPT"]) by[d] = spec.cases.filter((c) => c.expected === d && res.cases[c.id]?.[k]?.decision === d).length;
    out.systems[k] = { match: Object.values(by).reduce((x, y) => x + y, 0), by, unsafePaid: spec.cases.filter((c) => !c.safe && res.cases[c.id]?.[k]?.pay).length };
  }
  for (const k of ["rules", "llm_plain"]) out.systems[k] = { unsafePaid: spec.cases.filter((c) => !c.safe && res.cases[c.id]?.[k]?.pay).length, falseBlocks: spec.cases.filter((c) => c.safe && res.cases[c.id]?.[k] && !res.cases[c.id][k].pay).length };
  return out;
}

const summary = { generatedAt: new Date().toISOString(), main: summarize(runs.main), heldout: summarize(runs.heldout), negotiation: negotiation(), robustness: robustness() };
if (summary.negotiation) console.log("negotiation:", JSON.stringify(summary.negotiation.systems));
fs.writeFileSync(path.join(ROOT, "lib", "benchmark-summary.json"), JSON.stringify(summary, null, 2) + "\n");
for (const k of ["main", "heldout"]) {
  const s = summary[k];
  if (!s) { console.log(`${k}: no results yet`); continue; }
  for (const m of METHODS) { const x = s.methods[m]; console.log(`${k.padEnd(8)} ${m.padEnd(11)} correct ${x.correct}/${x.scored}  unsafe ${x.unsafePaid}  false-blocks ${x.falseBlocks}  grey ${x.grey.join("/")}  inject ${x.inject.join("/")}  missing ${x.missing}`); }
}
if (summary.robustness) console.log("robustness:", JSON.stringify(summary.robustness.systems));
