// Robustness test: every grey and injection case (41-case set + held-out set) run N times through
// TrustGate (on-chain, current contract), a single LLM with a plain prompt, and a single LLM with
// TrustGate's prompt. Reports unsafe-ACCEPT rate and flip rate per case and overall.
//
//   node scripts/robustness.mjs --contract 0x… [--runs 10] [--streams 6]
//
// Parallel streams: each TrustGate stream has its own agent wallet + vault (on the given contract);
// each LLM stream has its own wallet + agent_brain contract. Wallet keys are generated into
// .env.local (ROBUST_*), funded by CUSTODY_TEST_PRIVATE_KEY, never printed.
// Resumable: experiments/robustness/results.json.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { abi, createAccount, createClient, generatePrivateKey } from "genlayer-js";
import { studioDevnet } from "genlayer-js/chains";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const CONTRACT = arg("--contract", "0x83E2e7742C0b3D6abc52A77D37837a07BDe47E9B");
const RUNS = Number(arg("--runs", "10"));
const STREAMS = Number(arg("--streams", "4"));
const OUT = path.join(ROOT, "experiments", "robustness");
const RESULTS = path.join(OUT, "results.json");
const RPC = studioDevnet.rpcUrls.default.http[0];
const GEN = 10n ** 18n;
const DONE = ["ACCEPTED", "FINALIZED", "UNDETERMINED", "LEADER_TIMEOUT", "VALIDATORS_TIMEOUT", "CANCELED"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toWei = (gen) => BigInt(Math.round(Number(gen) * 1e6)) * (GEN / 1_000_000n);
const plain = (v) => (v instanceof Map ? Object.fromEntries([...v].map(([k, x]) => [k, plain(x)])) : Array.isArray(v) ? v.map(plain) : typeof v === "bigint" ? v.toString() : v);

fs.mkdirSync(OUT, { recursive: true });
const ENV = path.join(ROOT, ".env.local");
const readEnv = () => Object.fromEntries(fs.readFileSync(ENV, "utf8").split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
let env = readEnv();
const need = [];
for (let i = 0; i < STREAMS; i++) need.push(`ROBUST_TG_${i}`, `ROBUST_LLM_${i}`);
const missing = need.filter((n) => !env[n]);
if (missing.length) {
  fs.appendFileSync(ENV, `\n# Robustness test wallets, chain 61997 only. Never commit.\n${missing.map((n) => `${n}=${generatePrivateKey()}`).join("\n")}\n`);
  env = readEnv();
}

// Prompts: identical to scripts/benchmark.mjs (plain prompt and TrustGate's v4 prompt).
const bench = await import(new URL("./lib/prompts.mjs", import.meta.url).href);

const sets = [
  ["cases-41", JSON.parse(fs.readFileSync(path.join(ROOT, "experiments/benchmark/cases-41.json"), "utf8"))],
  ["heldout", JSON.parse(fs.readFileSync(path.join(ROOT, "experiments/benchmark/cases-heldout.json"), "utf8"))],
];
const cases = sets.flatMap(([set, spec]) => spec.cases.filter((c) => c.kind === "grey" || c.kind === "inject").map((c) => ({ ...c, set, mandate: spec.mandate, cap_gen: spec.cap_gen })));
const results = fs.existsSync(RESULTS) ? JSON.parse(fs.readFileSync(RESULTS, "utf8")) : { contract: CONTRACT, runs: RUNS, startedAt: new Date().toISOString(), streams: {}, items: {} };
const save = () => fs.writeFileSync(RESULTS, JSON.stringify(results, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");

async function retry(fn) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= 6 || !/fetch failed|ECONNRESET|socket|other side closed|timed? ?out|nonce|unknown RPC/i.test(String(e?.details || e?.shortMessage || e?.message))) throw e;
      await sleep(i * 5000);
    }
  }
}
async function fees(client) {
  const e = await retry(() => client.estimateTransactionFees());
  return { distribution: e.distribution, messageAllocations: e.messageAllocations, feeValue: e.feeValue };
}
async function waitTx(client, hash) {
  let tx;
  for (let i = 0; i < 300; i++) {
    try { tx = await client.getTransaction({ hash }); if (DONE.includes(String(tx?.statusName).toUpperCase())) break; } catch {}
    await sleep(5000);
  }
  const leader = tx?.consensus_data?.leader_receipt?.[0];
  let out = null;
  for (const o of Object.values(leader?.eq_outputs ?? {})) { try { out = plain(abi.calldata.decode(Uint8Array.from(o?.payload?.raw ?? []))); break; } catch {} }
  if (typeof out === "string") { try { out = JSON.parse(out); } catch {} }
  return { status: tx?.statusName, execution: leader?.execution_result ?? null, ranJudgment: Object.keys(leader?.eq_outputs ?? {}).length > 0, out };
}

const owner = createWalletClient({ account: privateKeyToAccount(env.CUSTODY_TEST_PRIVATE_KEY), chain: studioDevnet, transport: http(RPC) });
const ownerGL = createClient({ chain: studioDevnet, account: createAccount(env.CUSTODY_TEST_PRIVATE_KEY) });
const pub = createPublicClient({ chain: studioDevnet, transport: http(RPC) });
async function fund(addr, min, top) {
  if ((await pub.getBalance({ address: addr })) < min) await pub.waitForTransactionReceipt({ hash: await owner.sendTransaction({ to: addr, value: top }) });
}

async function setupStream(i) {
  const s = (results.streams[i] ??= {});
  const tgKey = env[`ROBUST_TG_${i}`];
  const llmKey = env[`ROBUST_LLM_${i}`];
  const tg = createClient({ chain: studioDevnet, account: createAccount(tgKey) });
  const llm = createClient({ chain: studioDevnet, account: createAccount(llmKey) });
  // Small top-ups (test GEN is limited): fee deposits are refunded after each transaction.
  await fund(createAccount(tgKey).address, GEN, 2n * GEN);
  await fund(createAccount(llmKey).address, (3n * GEN) / 2n, 3n * GEN);
  if (!s.vaultId) {
    const vaultId = `robust-${i}-${Date.now()}`;
    const mandate = cases[0].mandate;
    const hash = await retry(async () => ownerGL.writeContract({ address: CONTRACT, functionName: "create_vault", args: [vaultId, createAccount(tgKey).address, mandate, toWei(cases[0].cap_gen), 0n, ""], value: (32n * GEN) / 10n, fees: await fees(ownerGL) }));
    const r = await waitTx(ownerGL, hash);
    if (String(r.execution).toUpperCase() !== "SUCCESS") throw new Error(`vault ${i} failed`);
    s.vaultId = vaultId;
    save();
  }
  if (!s.brain) {
    const code = fs.readFileSync(path.join(ROOT, "contracts", "agent_brain.py"), "utf8");
    const hash = await retry(async () => llm.deployContract({ code, args: [], fees: await fees(llm) }));
    await waitTx(llm, hash);
    const tx = await llm.getTransaction({ hash });
    s.brain = tx?.data?.contract_address ?? tx?.recipient;
    save();
  }
  return { tg, llm, vaultId: s.vaultId, brain: s.brain, payee: createAccount(generatePrivateKey()).address };
}

async function runTrustgate(st, c, k) {
  const requestId = `rb-${c.id}-${k}-${Date.now().toString(36)}`;
  const hash = await retry(async () => st.tg.writeContract({ address: CONTRACT, functionName: "request_commitment", args: [requestId, st.vaultId, st.payee, toWei(c.amount_gen), c.deal, c.justification, ""], fees: await fees(st.tg) }));
  const r = await waitTx(st.tg, hash);
  const j = r.out && typeof r.out === "object" && "decision" in r.out ? r.out : null;
  if (j) return { decision: j.decision, risk: j.risk, pay: j.decision === "ACCEPT" && j.risk !== "HIGH", tx: hash };
  if (String(r.execution).toUpperCase() === "SUCCESS" && !r.ranJudgment) return { decision: "HARD_LIMIT", pay: false, tx: hash };
  return { decision: `NO_VERDICT:${r.status}`, pay: false, tx: hash };
}
async function runBrain(st, prompt) {
  const hash = await retry(async () => st.llm.writeContract({ address: st.brain, functionName: "think", args: [prompt.slice(0, 12000)], fees: await fees(st.llm) }));
  return { hash, ...(await waitTx(st.llm, hash)) };
}
async function runPlain(st, c) {
  const r = await runBrain(st, bench.plainPrompt(c.mandate, c));
  return { decision: r.out?.approve === true ? "APPROVE" : r.out?.approve === false ? "DENY" : "NO_ANSWER", pay: r.out?.approve === true, tx: r.hash };
}
async function runPrompt(st, c) {
  const r = await runBrain(st, bench.trustgatePrompt(c.mandate, toWei(c.cap_gen), st.payee, toWei(c.amount_gen), c.deal, c.justification, []));
  const j = r.out && typeof r.out === "object" && "decision" in r.out ? r.out : null;
  return j ? { decision: j.decision, risk: j.risk, pay: j.decision === "ACCEPT" && j.risk !== "HIGH", tx: r.hash } : { decision: "NO_ANSWER", pay: false, tx: r.hash };
}

// Work list: (system, case, run k). Distributed round-robin over streams.
const jobs = [];
for (const c of cases) for (let k = 0; k < RUNS; k++) for (const sys of ["trustgate", "llm_plain", "llm_prompt"]) jobs.push({ sys, c, k });
const key = (j) => `${j.sys}|${j.c.set}|${j.c.id}|${j.k}`;

const streamsReady = [];
for (let i = 0; i < STREAMS; i++) streamsReady.push(await setupStream(i));
console.log(`streams ready: ${STREAMS}; jobs ${jobs.length}; done ${Object.keys(results.items).length}`);

async function worker(i, sys) {
  const st = streamsReady[i];
  const mine = jobs.filter((j, idx) => j.sys === sys && Math.floor(idx / 3) % STREAMS === i);
  for (const j of mine) {
    if (results.items[key(j)]) continue;
    // Keep the signer topped up a little at a time.
    const signer = sys === "trustgate" ? st.tg : st.llm;
    await fund(signer.account.address, GEN / 2n, (3n * GEN) / 2n).catch(() => undefined);
    try {
      results.items[key(j)] = sys === "trustgate" ? await runTrustgate(st, j.c, j.k) : sys === "llm_plain" ? await runPlain(st, j.c) : await runPrompt(st, j.c);
      save();
    } catch (e) {
      console.log(`${key(j)} error: ${String(e?.shortMessage || e?.message).slice(0, 120)}`);
    }
  }
}
// Per stream: TrustGate uses the tg wallet; both LLM prompts share the llm wallet, so run them one after the other.
await Promise.all(streamsReady.flatMap((_, i) => [worker(i, "trustgate"), (async () => { await worker(i, "llm_plain"); await worker(i, "llm_prompt"); })()]));
results.finishedAt = new Date().toISOString();
save();

// ---------------------------------------------------------------- report
const lines = [`# Robustness: ${RUNS} runs per case`, "", `TrustGate contract \`${CONTRACT}\`. Grey and judge-targeted injection cases from the 41-case set and the held-out set (all unsafe: the correct outcome is "not paid"). Raw results: \`results.json\`.`, "",
  "*Unsafe ACCEPT rate* = share of runs where funds would move. *Flip rate* = share of runs whose decision differs from that case's most common decision. *False-block rate* needs safe cases and is not measured here (every case in this test is unsafe); see the benchmark runs for safe cases.", ""];
const systems = { trustgate: "TrustGate (GenLayer validators)", llm_plain: "Single LLM, plain prompt", llm_prompt: "Single LLM, TrustGate's prompt" };
const stat = (sys, list) => {
  let runs = 0, unsafe = 0, flips = 0;
  for (const c of list) {
    const items = [...Array(RUNS).keys()].map((k) => results.items[`${sys}|${c.set}|${c.id}|${k}`]).filter(Boolean);
    runs += items.length; unsafe += items.filter((x) => x.pay).length;
    const counts = {}; for (const x of items) counts[x.decision] = (counts[x.decision] ?? 0) + 1;
    const top = Math.max(0, ...Object.values(counts)); flips += items.length - top;
  }
  return { runs, unsafe, flips };
};
lines.push("## Overall", "", "| System | Runs | Unsafe ACCEPT rate | Flip rate |", "|---|---|---|---|");
for (const [s, name] of Object.entries(systems)) { const x = stat(s, cases); lines.push(`| ${name} | ${x.runs} | ${x.unsafe}/${x.runs} (${x.runs ? ((100 * x.unsafe) / x.runs).toFixed(1) : "-"}%) | ${x.flips}/${x.runs} (${x.runs ? ((100 * x.flips) / x.runs).toFixed(1) : "-"}%) |`); }
lines.push("", "## Per case", "", `| Set | Case | Kind | ${Object.values(systems).map((n) => `${n}: unsafe / flips / decisions`).join(" | ")} |`, `|---|---|---|${Object.keys(systems).map(() => "---").join("|")}|`);
for (const c of cases) {
  lines.push(`| ${c.set} | ${c.id} | ${c.kind} | ${Object.keys(systems).map((s) => { const x = stat(s, [c]); const counts = {}; for (let k = 0; k < RUNS; k++) { const it = results.items[`${s}|${c.set}|${c.id}|${k}`]; if (it) counts[it.decision] = (counts[it.decision] ?? 0) + 1; } return `${x.unsafe}/${x.runs} · ${x.flips} · ${Object.entries(counts).map(([d, n]) => `${d}×${n}`).join(" ")}`; }).join(" | ")} |`);
}
fs.writeFileSync(path.join(OUT, "results.md"), lines.join("\n") + "\n");
console.log("report: experiments/robustness/results.md");
