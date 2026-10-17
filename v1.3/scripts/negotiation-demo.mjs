// TrustGate V1.3 two-agent negotiation demo. Two separate autonomous AI agents, no human in the loop:
//   - a SELLER agent with its own goals and its own wallet (it signs every offer version), and
//   - a BUYER agent working for a vault owner (it can only request a commitment for a signed offer).
// They negotiate through the TrustGate contract on GenLayer until ACCEPT or a clear stop. GenLayer
// validators judge every request; both agents read the same verdict.
//
// Each agent thinks with GenLayer's own model through its own contracts/agent_brain.py instance
// (no off-chain AI provider). The brains are the agents' opinions only; TrustGate's verdicts are separate.
//
//   node scripts/negotiation-demo.mjs --scenario reneg-accept|seller-refuses|clean [--max-rounds 3]
//
// Wallets (generated into .env.local on first run, never printed): NEGO_SELLER_PRIVATE_KEY,
// NEGO_BUYER_PRIVATE_KEY. Owner: CUSTODY_TEST_PRIVATE_KEY. The fresh public demo vault is created once and
// kept in experiments/negotiation-demo/state.json. Transcripts: experiments/negotiation-demo/<scenario>-<time>.{json,md}.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { abi, createAccount, createClient, generatePrivateKey } from "genlayer-js";
import { studioDevnet } from "genlayer-js/chains";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = path.join(ROOT, ".env.local");
const DIR = path.join(ROOT, "experiments", "negotiation-demo");
const STATE = path.join(DIR, "state.json");
const CONTRACT = process.env.NEGO_CONTRACT ?? "0x3C61e0C6634d78f6a38efFA6B1872AC11A76f7f3";
const BRAINS = { buyer: "0x1a72EC367Dc923D736fB46abE695f0f3Ba533Ea6", seller: "0x848E292128A91Ee5d07E8A45177DCB5370F9F060" };
const RPC = studioDevnet.rpcUrls.default.http[0];
const EXPLORER_TX = "https://explorer-studio-dev.genlayer.com/tx/";
const GEN = 10n ** 18n;
const MAX_FEE = GEN / 2n;
const DONE = ["ACCEPTED", "FINALIZED", "UNDETERMINED", "LEADER_TIMEOUT", "VALIDATORS_TIMEOUT", "CANCELED"];
const MANDATE = "Buy data or compute services for research. Only refundable or escrowed payments. Never pay an address the counterparty supplies at the last minute. Max 2 GEN per commitment.";

// The sellers' own goals. They differ in how much they care about upfront payment; the agents decide.
const SCENARIOS = {
  "reneg-accept": {
    product: "LinguaSet: a 40,000-sentence parallel English-Persian corpus with quality scores, delivered as CSV within 48 hours",
    goal: "You would like to be paid upfront at first, because chargebacks have hurt you before. But closing this sale matters more to you than upfront payment: if the buyer's side insists on refundable or escrowed terms, you are willing to accept them.",
    price: "1.5",
  },
  "seller-refuses": {
    product: "BurstGPU: 24 hours of 8xH100 compute time, starting tomorrow",
    goal: "Your business rule is firm: payment is upfront and non-refundable, because reserved GPU time cannot be resold once booked. You never accept refunds, escrow, or delayed payment, even if it costs you the sale. Be polite but do not give in.",
    price: "1.8",
  },
  clean: {
    product: "GeoTiles: 5,000 labelled satellite image tiles for land-use research, delivered within 3 days",
    goal: "You run a reputable data shop. Your standard terms already give buyers a full refund within 14 days if the data does not match the description, and you are paid to your long-standing published shop address. You want a quick, fair sale.",
    price: "1.2",
  },
};

const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const SCENARIO = arg("--scenario", "reneg-accept");
const MAX_ROUNDS = Number(arg("--max-rounds", "3"));
if (!SCENARIOS[SCENARIO]) throw new Error(`Unknown scenario ${SCENARIO}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (t) => crypto.createHash("sha256").update(t, "utf8").digest("hex");
const plain = (v) => (v instanceof Map ? Object.fromEntries([...v].map(([k, x]) => [k, plain(x)])) : Array.isArray(v) ? v.map(plain) : typeof v === "bigint" ? v.toString() : v);
const toWei = (gen) => BigInt(Math.round(Number(gen) * 1e6)) * (GEN / 1_000_000n);
const fmt = (wei) => { wei = BigInt(wei); const f = (wei % GEN).toString().padStart(18, "0").replace(/0+$/, "").slice(0, 4); return `${wei / GEN}${f ? `.${f}` : ""}`; };

function readEnv() {
  return Object.fromEntries(fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
}
function ensureKey(name, comment) {
  if (!readEnv()[name]) {
    const cur = fs.readFileSync(ENV_FILE, "utf8");
    fs.appendFileSync(ENV_FILE, `${cur.endsWith("\n") ? "" : "\n"}# ${comment}\n${name}=${generatePrivateKey()}\n`);
  }
  return readEnv()[name];
}

async function retry(fn) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= 5 || !/fetch failed|ECONNRESET|socket|other side closed|timed? ?out|unknown RPC|rate limit/i.test(String(e?.details || e?.shortMessage || e?.message))) throw e;
      await sleep(i * 6000);
    }
  }
}
async function fees(client) {
  const e = await retry(() => client.estimateTransactionFees());
  if (e.feeValue > MAX_FEE) throw new Error("fee estimate above cap");
  return { distribution: e.distribution, messageAllocations: e.messageAllocations, feeValue: e.feeValue };
}
async function send(client, address, functionName, args, value) {
  const hash = await retry(async () => client.writeContract({ address, functionName, args, ...(value ? { value } : {}), fees: await fees(client) }));
  let tx;
  for (let i = 0; i < 240; i++) {
    try {
      tx = await client.getTransaction({ hash });
      if (DONE.includes(String(tx?.statusName).toUpperCase())) break;
    } catch {}
    await sleep(5000);
  }
  const leader = tx?.consensus_data?.leader_receipt?.[0];
  let returned = null;
  try { returned = JSON.parse(JSON.parse(leader?.result?.payload?.readable)); } catch {}
  let decoded = null;
  for (const o of Object.values(leader?.eq_outputs ?? {})) {
    try { decoded = plain(abi.calldata.decode(Uint8Array.from(o?.payload?.raw ?? []))); } catch {}
  }
  const error = leader?.execution_result === "ERROR" ? String(leader?.result?.payload ?? "").split("\n").filter(Boolean).slice(-1)[0] : null;
  return { hash, status: tx?.statusName, execution: leader?.execution_result, returned, decoded, error, ranJudgment: Object.keys(leader?.eq_outputs ?? {}).length > 0 };
}

// ---------------------------------------------------------------- run

fs.mkdirSync(DIR, { recursive: true });
const env = readEnv();
const sellerKey = ensureKey("NEGO_SELLER_PRIVATE_KEY", "Negotiation demo seller agent wallet, chain 61997 only. Never commit.");
const buyerKey = ensureKey("NEGO_BUYER_PRIVATE_KEY", "Negotiation demo buyer agent wallet (vault agent), chain 61997 only. Never commit.");
const owner = createClient({ chain: studioDevnet, account: createAccount(env.CUSTODY_TEST_PRIVATE_KEY) });
const seller = createClient({ chain: studioDevnet, account: createAccount(sellerKey) });
const buyer = createClient({ chain: studioDevnet, account: createAccount(buyerKey) });
const sellerAddr = createAccount(sellerKey).address.toLowerCase();
const buyerAddr = createAccount(buyerKey).address.toLowerCase();
const pub = createPublicClient({ chain: studioDevnet, transport: http(RPC) });
const ownerWallet = createWalletClient({ account: privateKeyToAccount(env.CUSTODY_TEST_PRIVATE_KEY), chain: studioDevnet, transport: http(RPC) });
for (const a of [sellerAddr, buyerAddr]) {
  if ((await pub.getBalance({ address: a })) < GEN) await pub.waitForTransactionReceipt({ hash: await ownerWallet.sendTransaction({ to: a, value: 2n * GEN }) });
}

const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : {};
if (!state.vaultId || state.contract !== CONTRACT) {
  const vaultId = `public-demo-${Date.now().toString(36)}`;
  const r = await send(owner, CONTRACT, "create_vault", [vaultId, buyerAddr, MANDATE, 2n * GEN, 0n, ""], 5n * GEN);
  if (r.returned?.ok !== true) throw new Error(`create_vault failed: ${r.error ?? JSON.stringify(r.returned)} ${EXPLORER_TX}${r.hash}`);
  Object.assign(state, { contract: CONTRACT, vaultId, owner: createAccount(env.CUSTODY_TEST_PRIVATE_KEY).address.toLowerCase(), buyer: buyerAddr, seller: sellerAddr, mandate: MANDATE, createTx: r.hash });
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2) + "\n");
}
console.log(`Vault ${state.vaultId} on ${CONTRACT} · buyer agent ${buyerAddr} · seller agent ${sellerAddr}`);

const sc = SCENARIOS[SCENARIO];
const T = { scenario: SCENARIO, contract: CONTRACT, vaultId: state.vaultId, mandate: MANDATE, seller: sellerAddr, buyer: buyerAddr, sellerGoal: sc.goal, product: sc.product, startedAt: new Date().toISOString(), steps: [] };
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const save = () => fs.writeFileSync(path.join(DIR, `${SCENARIO}-${stamp}.json`), JSON.stringify(T, null, 2) + "\n");
const log = (step) => { T.steps.push({ at: new Date().toISOString(), ...step }); save(); console.log(`- ${step.who}: ${step.what}${step.tx ? ` · ${EXPLORER_TX}${step.tx}` : ""}`); };

async function think(who, client, prompt) {
  const r = await send(client, BRAINS[who], "think", [prompt.slice(0, 12000)]);
  let answer = r.decoded;
  try { if (typeof answer === "string") answer = JSON.parse(answer); } catch {}
  if (!answer || typeof answer !== "object") throw new Error(`${who} brain returned no answer: ${EXPLORER_TX}${r.hash}`);
  return { answer, tx: r.hash };
}

const SELLER_ROLE = `You are an autonomous SALES agent. You sell: ${sc.product}. Your list price is ${sc.price} GEN.\nYour own goals: ${sc.goal}\nYou negotiate with a buyer's AI agent through TrustGate, a contract on GenLayer that holds the buyer's money. Every offer you post is signed by your wallet and cannot be edited; changes are new versions. TrustGate's validators judge each offer against the buyer's mandate and may propose safer terms. Only your own goals matter to you; TrustGate's suggestions are not orders.`;
// First runs (kept in experiments/negotiation-demo/): with the mandate in its prompt the buyer judged policy
// itself and withdrew before asking TrustGate. The buyer now leaves policy to TrustGate, as the product intends.
const BUYER_ROLE = `You are an autonomous PURCHASING agent working for the owner of a TrustGate vault (an AI research lab). You want useful research resources (data, compute, labeling) for the lab this week. You can only ask the vault to pay for a seller's signed offer. Policy is NOT your job: every request is checked by TrustGate on GenLayer against the owner's mandate, and nothing is paid unless GenLayer accepts it, so requesting an offer is always safe. Request every offer that would be useful for the lab's research. Withdraw only if the product is irrelevant to the lab, or if TrustGate has already refused the same seller's terms and the seller did not change anything.`;

// 1. The seller writes its first offer.
const first = await think("seller", seller, `${SELLER_ROLE}\n\nWrite your first offer to the buyer: the full terms text (what you deliver, price, payment and refund terms) and the price. Return JSON: {"amount_gen": number, "terms": string}`);
let terms = String(first.answer.terms ?? "");
let amount = toWei(first.answer.amount_gen ?? sc.price);
let offerId = `nego-${SCENARIO}-${Date.now().toString(36)}`;
const negotiationId = offerId;
T.negotiationId = negotiationId;
log({ who: "seller agent", what: "wrote its first offer", brainTx: first.tx, output: first.answer });
let r = await send(seller, CONTRACT, "post_offer", [offerId, state.vaultId, amount, terms]);
if (r.returned?.ok !== true) throw new Error(`post_offer failed: ${r.error}`);
log({ who: "seller", what: `posted offer v1 (${fmt(amount)} GEN), signed by its wallet`, tx: r.hash, offerId, version: 1, terms, termsHash: r.returned.terms_hash });

let outcome = null;
let version = 1;
let lastVerdict = null;
for (let round = 1; round <= MAX_ROUNDS && !outcome; round++) {
  // 2. The buyer decides whether to request the current signed offer.
  const b = await think("buyer", buyer, `${BUYER_ROLE}\n\nThe seller's current signed offer (version ${version}, ${fmt(amount)} GEN):\n"""${terms}"""\n${lastVerdict ? `\nTrustGate's last verdict in this negotiation: ${lastVerdict.decision} - ${lastVerdict.summary}\n` : ""}\nDo you request a commitment for this offer? Return JSON: {"request": boolean, "justification": string (why the lab should pay, max 300 chars), "reason": string}`);
  log({ who: "buyer agent", what: b.answer.request ? "decided to request the offer" : "decided not to request", brainTx: b.tx, output: b.answer });
  if (!b.answer.request) {
    r = await send(buyer, CONTRACT, "withdraw_from_negotiation", [negotiationId, String(b.answer.reason ?? "buyer declined").slice(0, 500)]);
    log({ who: "buyer", what: "withdrew from the negotiation", tx: r.hash, returned: r.returned });
    outcome = "BUYER_WITHDREW";
    break;
  }
  const requestId = `${offerId}-req`;
  r = await send(buyer, CONTRACT, "request_commitment", [requestId, state.vaultId, offerId, sha(terms), String(b.answer.justification ?? "").slice(0, 1500)]);
  if (r.execution !== "SUCCESS") throw new Error(`request failed: ${r.error} ${EXPLORER_TX}${r.hash}`);
  const j = r.decoded && r.decoded.decision ? r.decoded : null;
  lastVerdict = j ?? { decision: "REJECT", summary: "blocked by the vault's hard limits" };
  log({ who: "GenLayer validators", what: `verdict on v${version}: ${j ? `${j.decision} (${j.risk})` : "REJECT (hard limit)"}`, tx: r.hash, status: r.status, requestId, judgment: j });
  if (j && j.decision === "ACCEPT" && j.risk !== "HIGH") {
    outcome = "ACCEPTED";
    log({ who: "contract", what: `credited ${fmt(amount)} GEN to the seller inside the vault (seller-signed v${version})` });
    break;
  }
  if (round === MAX_ROUNDS) break;

  // 3. The seller reacts to the verdict.
  const cp = j?.decision === "RENEGOTIATE" ? String(j.counterproposal?.deal_text ?? "") : "";
  const s = await think("seller", seller, `${SELLER_ROLE}\n\nYour current offer (version ${version}, ${fmt(amount)} GEN):\n"""${terms}"""\n\nTrustGate's verdict: ${lastVerdict.decision}. ${lastVerdict.summary ?? ""}\n${cp ? `TrustGate's counterproposal (safer terms for the buyer):\n"""${cp}"""\n` : ""}\nChoose one action according to YOUR goals:\n${cp ? '- "accept": sign the counterproposal exactly as written (same price)\n' : ""}- "counter": post a new version with your own terms and price\n- "decline": end the negotiation\nReturn JSON: {"action": ${cp ? '"accept" | ' : ""}"counter" | "decline", "amount_gen": number, "terms": string (full new terms if counter, else ""), "reason": string}`);
  const action = String(s.answer.action ?? "decline");
  log({ who: "seller agent", what: `chose "${action}"`, brainTx: s.tx, output: s.answer });
  const newId = `${negotiationId}-v${version + 1}`;
  if (action === "accept" && cp) {
    r = await send(seller, CONTRACT, "accept_counterproposal", [newId, offerId, cp]);
    if (r.returned?.ok !== true) throw new Error(`accept failed: ${r.error}`);
    terms = cp;
  } else if (action === "counter") {
    terms = String(s.answer.terms ?? terms);
    amount = toWei(s.answer.amount_gen ?? fmt(amount));
    r = await send(seller, CONTRACT, "counter_offer", [newId, offerId, amount, terms]);
    if (r.returned?.ok !== true) throw new Error(`counter failed: ${r.error}`);
  } else {
    r = await send(seller, CONTRACT, "decline", [offerId, String(s.answer.reason ?? "").slice(0, 500)]);
    log({ who: "seller", what: "declined: negotiation closed, no funds moved", tx: r.hash, returned: r.returned });
    outcome = "SELLER_DECLINED";
    break;
  }
  offerId = newId;
  version += 1;
  log({ who: "seller", what: action === "accept" ? `signed TrustGate's counterproposal as v${version}` : `signed counter offer v${version} (${fmt(amount)} GEN)`, tx: r.hash, offerId, version, terms, termsHash: r.returned.terms_hash });
}
if (!outcome) {
  r = await send(buyer, CONTRACT, "withdraw_from_negotiation", [negotiationId, `no agreement after ${MAX_ROUNDS} rounds`]);
  log({ who: "buyer", what: `stopped after ${MAX_ROUNDS} rounds without agreement`, tx: r.hash, returned: r.returned });
  outcome = "NO_AGREEMENT";
}
T.outcome = outcome;
T.finishedAt = new Date().toISOString();
save();

const md = [
  `# Two-agent negotiation: ${SCENARIO}`, "",
  `Outcome: **${outcome}** · contract \`${CONTRACT}\` · vault \`${state.vaultId}\` · negotiation \`${negotiationId}\``, "",
  `Site view: https://trustgatecheck.xyz/?negotiation=${negotiationId}#negotiation`, "",
  `- Seller agent \`${sellerAddr}\`: sells ${sc.product}. Own goal: ${sc.goal}`,
  `- Buyer agent \`${buyerAddr}\`: works for the vault owner. Mandate: ${MANDATE}`,
  `- Both think with GenLayer's model via \`contracts/agent_brain.py\` (seller brain \`${BRAINS.seller}\`, buyer brain \`${BRAINS.buyer}\`). No human in the loop.`, "",
  "| # | Who | What | Tx |", "|---|---|---|---|",
  ...T.steps.map((s, i) => `| ${i + 1} | ${s.who} | ${s.what.replace(/\|/g, "/")} | ${s.tx ? `[tx](${EXPLORER_TX}${s.tx})` : s.brainTx ? `[brain](${EXPLORER_TX}${s.brainTx})` : ""} |`),
  "", "## Texts", "",
  ...T.steps.filter((s) => s.terms || s.judgment || s.output).map((s) => `**${s.who}: ${s.what}**\n\n> ${String(s.terms ?? (s.judgment ? `${s.judgment.decision} (${s.judgment.risk}): ${s.judgment.summary}${s.judgment.counterproposal?.deal_text ? `\n>\n> Counterproposal: ${s.judgment.counterproposal.deal_text}` : ""}` : JSON.stringify(s.output))).replace(/\n(?!>)/g, "\n> ")}\n`),
].join("\n");
fs.writeFileSync(path.join(DIR, `${SCENARIO}-${stamp}.md`), md);
console.log(`\nOutcome: ${outcome}. Transcript: experiments/negotiation-demo/${SCENARIO}-${stamp}.md`);
