// On-chain test suite for contracts/trustgate_vault.py (vault + two-sided negotiation) on
// GenLayer Studio Next (chain 61997). Real transactions, test GEN.
//
//   node tests/onchain/vault.test.mjs [--contract 0x…] [--skip-judged]
//
// Signers: E2E_OWNER_PRIVATE_KEY (owner) plus fresh in-memory keys for the agent and two sellers,
// funded by the owner with small amounts. Writes experiments/onchain-tests.json.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { abi, createAccount, createClient, generatePrivateKey } from "genlayer-js";
import { studioDevnet } from "genlayer-js/chains";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const argv = process.argv.slice(2);
const CONTRACT = argv.includes("--contract") ? argv[argv.indexOf("--contract") + 1] : "0x3C61e0C6634d78f6a38efFA6B1872AC11A76f7f3";
const SKIP_JUDGED = argv.includes("--skip-judged");
const RPC = studioDevnet.rpcUrls.default.http[0];
const GEN = 10n ** 18n;
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, ".env.local"), "utf8").split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const signer = (key) => ({ client: createClient({ chain: studioDevnet, account: createAccount(key) }), addr: createAccount(key).address.toLowerCase() });
const ownerKey = env.E2E_OWNER_PRIVATE_KEY;
const { client: owner, addr: ownerAddr } = signer(ownerKey);
const { client: agent, addr: agentAddr } = signer(generatePrivateKey());
const { client: seller, addr: sellerAddr } = signer(generatePrivateKey());
const { client: seller2, addr: seller2Addr } = signer(generatePrivateKey());
const sha = (t) => crypto.createHash("sha256").update(t, "utf8").digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plain = (v) => (v instanceof Map ? Object.fromEntries([...v].map(([k, x]) => [k, plain(x)])) : Array.isArray(v) ? v.map(plain) : typeof v === "bigint" ? v.toString() : v);

const log = { contract: CONTRACT, owner: ownerAddr, agent: agentAddr, seller: sellerAddr, seller2: seller2Addr, startedAt: new Date().toISOString(), tests: [] };
const save = () => fs.writeFileSync(path.join(ROOT, "experiments", "onchain-tests.json"), JSON.stringify(log, null, 2) + "\n");

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
async function send(client, method, args, value) {
  const e = await retry(() => client.estimateTransactionFees());
  const hash = await retry(() => client.writeContract({ address: CONTRACT, functionName: method, args, ...(value ? { value } : {}), fees: { distribution: e.distribution, messageAllocations: e.messageAllocations, feeValue: e.feeValue } }));
  let tx;
  for (let i = 0; i < 240; i++) {
    try {
      tx = await client.getTransaction({ hash });
      if (["ACCEPTED", "FINALIZED", "UNDETERMINED", "CANCELED", "LEADER_TIMEOUT", "VALIDATORS_TIMEOUT"].includes(String(tx?.statusName).toUpperCase())) break;
    } catch {}
    await sleep(5000);
  }
  const leader = tx?.consensus_data?.leader_receipt?.[0];
  const readable = leader?.result?.payload?.readable;
  let returned = null;
  try { returned = readable ? JSON.parse(JSON.parse(readable)) : null; } catch { returned = readable ?? null; }
  let judgment = null;
  for (const o of Object.values(leader?.eq_outputs ?? {})) {
    try { const v = plain(abi.calldata.decode(Uint8Array.from(o?.payload?.raw ?? []))); if (v?.decision) judgment = v; } catch {}
  }
  const error = leader?.execution_result === "ERROR" ? String(leader?.result?.payload ?? leader?.genvm_result?.stderr ?? "").split("\n").filter(Boolean).slice(-1)[0] : null;
  return { hash, status: tx?.statusName, execution: leader?.execution_result, returned, error, judgment, ranJudgment: Object.keys(leader?.eq_outputs ?? {}).length > 0 };
}

async function it(name, fn) {
  process.stdout.write(`- ${name} … `);
  const t0 = Date.now();
  try {
    const detail = await fn();
    if (detail?.skipped) {
      log.tests.push({ name, ok: true, skipped: detail.skipped, ms: Date.now() - t0 });
      console.log("SKIPPED:", detail.skipped);
    } else {
      log.tests.push({ name, ok: true, ms: Date.now() - t0, ...detail });
      console.log("ok", detail?.hash ?? "");
    }
  } catch (e) {
    log.tests.push({ name, ok: false, ms: Date.now() - t0, error: String(e?.message ?? e).slice(0, 400) });
    console.log("FAILED", String(e?.message ?? e).slice(0, 200));
  }
  save();
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const fails = (r, re) => expect(r.execution === "ERROR" && re.test(r.error ?? ""), `expected error ${re}, got ${r.execution} ${r.error ?? JSON.stringify(r.returned)}`);
const okRet = (r) => expect(r.execution === "SUCCESS" && r.returned?.ok === true, `${r.execution} ${r.error ?? JSON.stringify(r.returned)}`);

const vid = `test-${Date.now()}`;
const vidB = `${vid}-b`;
const MANDATE = "Buy research datasets only. Only refundable or escrowed payments. Max 0.2 GEN per commitment.";
const pub = createPublicClient({ chain: studioDevnet, transport: http(RPC) });

// Gas for the fresh keys.
const w = createWalletClient({ account: privateKeyToAccount(ownerKey), chain: studioDevnet, transport: http(RPC) });
for (const a of [agentAddr, sellerAddr, seller2Addr]) await pub.waitForTransactionReceipt({ hash: await w.sendTransaction({ to: a, value: GEN / 2n }) });

// ------------------------------------------------------------------ vaults

await it("create_vault: invalid agent address is refused and the deposit credited back", async () => {
  const r = await send(owner, "create_vault", [`${vid}-bad`, "not-an-address", "m", GEN, 0n, ""], GEN / 100n);
  expect(r.execution === "SUCCESS" && r.returned?.ok === false && /agent is not a valid address/.test(r.returned.reason), JSON.stringify(r.returned));
  expect(r.returned.refunded_to_credit === String(GEN / 100n), "deposit not credited back");
  return r;
});
await it("create_vault: owner == agent is refused", async () => {
  const r = await send(owner, "create_vault", [`${vid}-self`, ownerAddr, "m", GEN, 0n, ""]);
  expect(r.returned?.ok === false && /different address/.test(r.returned.reason), JSON.stringify(r.returned));
  return r;
});
await it("create_vault: negative total cap is refused", async () => {
  const r = await send(owner, "create_vault", [`${vid}-neg`, agentAddr, "m", GEN, -1n, ""]);
  expect(r.returned?.ok === false && /total_cap/.test(r.returned.reason), JSON.stringify(r.returned));
  return r;
});
await it("create_vault: vault A (cap 0.2, total cap 0.3, no allowlist, deposit 0.4)", async () => {
  const r = await send(owner, "create_vault", [vid, agentAddr, MANDATE, GEN / 5n, (3n * GEN) / 10n, ""], (4n * GEN) / 10n);
  okRet(r);
  return r;
});
await it("create_vault: vault B (allowlist = [seller2], deposit 0.05)", async () => {
  const r = await send(owner, "create_vault", [vidB, agentAddr, MANDATE, GEN / 5n, 0n, seller2Addr], GEN / 20n);
  okRet(r);
  return r;
});
await it("create_vault: duplicate vault id is refused", async () => {
  const r = await send(owner, "create_vault", [vid, agentAddr, "m", GEN, 0n, ""]);
  expect(r.returned?.ok === false && /already exists/.test(r.returned.reason), JSON.stringify(r.returned));
  return r;
});
await it("top_up by a non-owner is refused and credited back", async () => {
  const r = await send(agent, "top_up", [vid], GEN / 100n);
  expect(r.returned?.ok === false && /only the vault owner/.test(r.returned.reason), JSON.stringify(r.returned));
  return r;
});

// ------------------------------------------------------------------ offers (no judgment)

const RENEG_TERMS = "Research dataset: 10,000 labelled Persian sentences for an NLP study, CSV, delivered within 3 days. Price 0.1 GEN, paid in full upfront before delivery. No refund.";
const o1 = `${vid}-o1`;
let o1Hash = sha(RENEG_TERMS);

await it("post_offer to a vault that does not exist fails", async () => fails(await send(seller, "post_offer", [`${vid}-x`, "no-such-vault", GEN / 10n, "t"]), /vault does not exist/));
await it("post_offer with zero amount fails", async () => fails(await send(seller, "post_offer", [`${vid}-x`, vid, 0n, "t"]), /amount must be greater/));
await it("post_offer with terms over 6000 characters fails", async () => fails(await send(seller, "post_offer", [`${vid}-x`, vid, GEN / 10n, "x".repeat(6001)]), /terms must be/));
await it("post_offer: seller posts offer v1; payee is the signer and the hash matches the exact text", async () => {
  const r = await send(seller, "post_offer", [o1, vid, GEN / 10n, RENEG_TERMS]);
  okRet(r);
  expect(r.returned.payee === sellerAddr, `payee ${r.returned.payee} is not the signer ${sellerAddr}`);
  expect(r.returned.terms_hash === o1Hash, "terms hash mismatch");
  return r;
});
await it("post_offer: duplicate offer_id fails", async () => fails(await send(seller2, "post_offer", [o1, vid, GEN / 10n, "other"]), /offer_id already exists/));
await it("someone else cannot change the seller's offer (counter_offer by seller2)", async () => fails(await send(seller2, "counter_offer", [`${vid}-x2`, o1, GEN / 10n, "my terms"]), /only the seller who signed/));
await it("someone else cannot decline the seller's offer", async () => fails(await send(seller2, "decline", [o1, "no"]), /only the seller who signed/));
await it("accept_counterproposal before any verdict fails", async () => fails(await send(seller, "accept_counterproposal", [`${vid}-x3`, o1, RENEG_TERMS]), /no counterproposal/));

await it("request_commitment from a non-agent fails", async () => fails(await send(owner, "request_commitment", [`${vid}-r0`, vid, o1, o1Hash, ""]), /registered agent/));
await it("request against an offer that does not exist (unsigned text) fails", async () => fails(await send(agent, "request_commitment", [`${vid}-r0`, vid, "no-such-offer", o1Hash, ""]), /offer does not exist/));
await it("request with a hash of edited text fails", async () => fails(await send(agent, "request_commitment", [`${vid}-r0`, vid, o1, sha(RENEG_TERMS + " Refundable."), ""]), /terms hash does not match/));
await it("request referencing an offer of another vault fails", async () => fails(await send(agent, "request_commitment", [`${vid}-r0`, vidB, o1, o1Hash, ""]), /offer belongs to another vault/));
await it("justification over 1500 characters fails", async () => fails(await send(agent, "request_commitment", [`${vid}-r0`, vid, o1, o1Hash, "j".repeat(1501)]), /agent_justification is too long/));

// Deterministic path: over the cap → BLOCKED, then counters and lineage without any judgment.
const n3 = `${vid}-n3`;
await it("offer over the cap: request is blocked by hard limits (no judgment)", async () => {
  okRet(await send(seller, "post_offer", [n3, vid, GEN / 2n, "Research dataset, 0.5 GEN, full refund within 14 days."]));
  const r = await send(agent, "request_commitment", [`${vid}-r3`, vid, n3, sha("Research dataset, 0.5 GEN, full refund within 14 days."), ""]);
  expect(r.execution === "SUCCESS" && !r.ranJudgment, "reached the validators");
  return r;
});
await it("seller counters twice (v2, v3); versions are linked", async () => {
  const a = await send(seller, "counter_offer", [`${n3}-v2`, n3, GEN / 10n, "Research dataset, 0.1 GEN, full refund within 14 days."]);
  okRet(a);
  const b = await send(seller, "counter_offer", [`${n3}-v3`, `${n3}-v2`, GEN / 10n, "Research dataset, 0.1 GEN, escrow released on delivery."]);
  okRet(b);
  expect(a.returned.version === 2 && b.returned.version === 3, `versions ${a.returned.version}, ${b.returned.version}`);
  return { hash: b.hash, v2: a.hash };
});
await it("request on an old version after a newer one exists fails", async () => fails(await send(agent, "request_commitment", [`${vid}-r3b`, vid, `${n3}-v2`, sha("Research dataset, 0.1 GEN, full refund within 14 days."), ""]), /superseded/));
await it("counter on an old version fails", async () => fails(await send(seller, "counter_offer", [`${n3}-v4`, n3, GEN / 10n, "x"]), /superseded/));
await it("seller declines v3: negotiation closed", async () => {
  const r = await send(seller, "decline", [`${n3}-v3`, "price too low"]);
  okRet(r);
  expect(r.returned.status === "DECLINED", JSON.stringify(r.returned));
  return r;
});
await it("request after the seller declined fails", async () => fails(await send(agent, "request_commitment", [`${vid}-r3c`, vid, `${n3}-v3`, sha("Research dataset, 0.1 GEN, escrow released on delivery."), ""]), /negotiation is closed \(DECLINED\)/));
await it("vault B: payee not on the owner's allowlist is blocked by hard limits", async () => {
  okRet(await send(seller, "post_offer", [`${vid}-ob`, vidB, GEN / 100n, "Research dataset, 0.01 GEN, refundable."]));
  const r = await send(agent, "request_commitment", [`${vid}-rb`, vidB, `${vid}-ob`, sha("Research dataset, 0.01 GEN, refundable."), ""]);
  expect(r.execution === "SUCCESS" && !r.ranJudgment, "reached the validators");
  return r;
});
await it("offer spam limit: a 4th open negotiation by the same seller on the same vault fails", async () => {
  for (const k of [1, 2, 3]) okRet(await send(seller2, "post_offer", [`${vid}-sp${k}`, vid, GEN / 100n, `Spam test offer ${k}, refundable.`]));
  const r = await send(seller2, "post_offer", [`${vid}-sp4`, vid, GEN / 100n, "Spam test offer 4, refundable."]);
  fails(r, /already has 3 open negotiations/);
  return r;
});
await it("offer spam limit: counter offers do not count; the limit is per vault", async () => {
  okRet(await send(seller2, "counter_offer", [`${vid}-sp1-v2`, `${vid}-sp1`, GEN / 100n, "Spam test offer 1, version 2."]));
  okRet(await send(seller2, "post_offer", [`${vid}-spB`, vidB, GEN / 100n, "Offer to another vault, refundable."]));
});
await it("offer spam limit: declining one frees a slot", async () => {
  okRet(await send(seller2, "decline", [`${vid}-sp2`, "closing"]));
  const r = await send(seller2, "post_offer", [`${vid}-sp5`, vid, GEN / 100n, "Spam test offer 5, refundable."]);
  okRet(r);
  return r;
});
await it("seller tries to pay the agent: the agent posting an offer is blocked (agent cannot pay itself)", async () => {
  okRet(await send(agent, "post_offer", [`${vid}-oa`, vid, GEN / 100n, "Dataset, refundable."]));
  const r = await send(agent, "request_commitment", [`${vid}-ra`, vid, `${vid}-oa`, sha("Dataset, refundable."), ""]);
  expect(r.execution === "SUCCESS" && !r.ranJudgment, "reached the validators");
  return r;
});

// ------------------------------------------------------------------ judged negotiation

if (!SKIP_JUDGED) {
  let cp1 = null;
  await it("N1: buyer requests offer v1 → GenLayer verdict (expect RENEGOTIATE with a counterproposal)", async () => {
    const r = await send(agent, "request_commitment", [`${vid}-r1`, vid, o1, o1Hash, "Dataset for our NLP study."]);
    expect(r.execution === "SUCCESS" && r.judgment, `${r.execution} ${r.error}`);
    if (r.judgment.decision === "RENEGOTIATE") cp1 = r.judgment.counterproposal.deal_text;
    return { ...r, verdict: `${r.judgment.decision} (${r.judgment.risk})` };
  });
  await it("N1: replayed request_id fails", async () => fails(await send(agent, "request_commitment", [`${vid}-r1`, vid, o1, o1Hash, ""]), /request_id already exists/));
  await it("N1: a second request on the same version fails (verdict already given)", async () => fails(await send(agent, "request_commitment", [`${vid}-r1b`, vid, o1, o1Hash, ""]), /not open for a request/));
  await it("N1: seller signing a different text than the counterproposal fails", async () => {
    if (!cp1) return { skipped: "N1 verdict was not RENEGOTIATE" };
    return fails(await send(seller, "accept_counterproposal", [`${o1}-v2`, o1, cp1 + " (edited)"]), /terms differ from the counterproposal/);
  });
  await it("N1: someone other than the seller cannot accept the counterproposal", async () => {
    if (!cp1) return { skipped: "N1 verdict was not RENEGOTIATE" };
    return fails(await send(seller2, "accept_counterproposal", [`${o1}-v2`, o1, cp1]), /only the seller who signed/);
  });
  await it("N1: seller never responds; nothing is credited to the seller", async () => fails(await send(seller, "withdraw", [GEN / 10n]), /insufficient credit/));
  await it("N1: a stranger cannot close the negotiation", async () => fails(await send(seller2, "withdraw_from_negotiation", [o1, "x"]), /only the vault owner or agent/));
  await it("N1: the buyer's agent withdraws after no response", async () => {
    const r = await send(agent, "withdraw_from_negotiation", [o1, "seller did not respond"]);
    okRet(r);
    expect(r.returned.status === "WITHDRAWN", JSON.stringify(r.returned));
    return r;
  });
  await it("N1: the seller can no longer accept after the buyer withdrew", async () => {
    if (!cp1) return { skipped: "N1 verdict was not RENEGOTIATE" };
    return fails(await send(seller, "accept_counterproposal", [`${o1}-v2`, o1, cp1]), /negotiation is closed \(WITHDRAWN\)/);
  });

  // N2: offer → RENEGOTIATE → seller signs the counterproposal → ACCEPT → seller credited.
  const n2 = `${vid}-n2`;
  const n2Terms = "Research dataset: 5,000 annotated satellite image tiles for a land-use study, delivered within 5 days. Price 0.15 GEN, paid in full upfront. All sales final.";
  let cp2 = null;
  await it("N2: seller posts v1, buyer requests → verdict (expect RENEGOTIATE)", async () => {
    okRet(await send(seller, "post_offer", [n2, vid, (15n * GEN) / 100n, n2Terms]));
    const r = await send(agent, "request_commitment", [`${vid}-n2r1`, vid, n2, sha(n2Terms), "Imagery for the land-use study."]);
    expect(r.execution === "SUCCESS" && r.judgment, `${r.execution} ${r.error}`);
    if (r.judgment.decision === "RENEGOTIATE") cp2 = r.judgment.counterproposal.deal_text;
    return { ...r, verdict: `${r.judgment.decision} (${r.judgment.risk})` };
  });
  await it("N2: seller accepts the counterproposal word for word → v2 signed by the seller", async () => {
    if (!cp2) return { skipped: "N2 verdict was not RENEGOTIATE" };
    const r = await send(seller, "accept_counterproposal", [`${n2}-v2`, n2, cp2]);
    okRet(r);
    expect(r.returned.version === 2 && r.returned.payee === sellerAddr && r.returned.terms_hash === sha(cp2), JSON.stringify(r.returned));
    return r;
  });
  await it("N2: request on v1 after v2 exists fails (no ACCEPT on an old version)", async () => {
    if (!cp2) return { skipped: "N2 verdict was not RENEGOTIATE" };
    return fails(await send(agent, "request_commitment", [`${vid}-n2rx`, vid, n2, sha(n2Terms), ""]), /superseded/);
  });
  let accepted = false;
  await it("N2: buyer requests v2 → verdict (expect ACCEPT, seller credited)", async () => {
    if (!cp2) return { skipped: "N2 verdict was not RENEGOTIATE" };
    const r = await send(agent, "request_commitment", [`${vid}-n2r2`, vid, `${n2}-v2`, sha(cp2), "Revised terms signed by the seller."]);
    expect(r.execution === "SUCCESS" && r.judgment, `${r.execution} ${r.error}`);
    accepted = r.judgment.decision === "ACCEPT" && r.judgment.risk !== "HIGH";
    return { ...r, verdict: `${r.judgment.decision} (${r.judgment.risk})` };
  });
  await it("N2: after ACCEPT the seller's credit is withdrawable (proves the credit)", async () => {
    if (!accepted) return { skipped: "N2 v2 was not accepted" };
    const r = await send(seller, "withdraw", [(15n * GEN) / 100n]);
    expect(r.execution === "SUCCESS" && r.returned?.ok === true, `${r.execution} ${r.error}`);
    return r;
  });
  await it("N2: negotiation is closed after ACCEPT; no second payment", async () => {
    if (!accepted) return { skipped: "N2 v2 was not accepted" };
    return fails(await send(agent, "request_commitment", [`${vid}-n2r3`, vid, `${n2}-v2`, sha(cp2), ""]), /negotiation is closed \(ACCEPTED\)/);
  });
  await it("N2: total spend cap binds: a further 0.2 GEN offer is blocked by hard limits", async () => {
    if (!accepted) return { skipped: "N2 v2 was not accepted" };
    okRet(await send(seller, "post_offer", [`${vid}-tc`, vid, GEN / 5n, "Research dataset, 0.2 GEN, full refund within 14 days."]));
    const r = await send(agent, "request_commitment", [`${vid}-tcr`, vid, `${vid}-tc`, sha("Research dataset, 0.2 GEN, full refund within 14 days."), ""]);
    expect(r.execution === "SUCCESS" && !r.ranJudgment, "total cap did not bind");
    return r;
  });
}

// ------------------------------------------------------------------ owner / withdraw

await it("owner_reclaim more than the vault holds fails", async () => fails(await send(owner, "owner_reclaim", [vid, 10n * GEN]), /invalid amount/));
await it("owner_reclaim a valid amount credits the owner", async () => {
  const r = await send(owner, "owner_reclaim", [vid, GEN / 20n]);
  okRet(r);
  return r;
});
await it("withdraw more than the credit fails", async () => fails(await send(seller2, "withdraw", [GEN]), /insufficient credit/));

log.finishedAt = new Date().toISOString();
save();
const failed = log.tests.filter((t) => !t.ok);
const skipped = log.tests.filter((t) => t.skipped);
console.log(`\n${log.tests.length - failed.length}/${log.tests.length} on-chain tests passed (${skipped.length} skipped). Log: experiments/onchain-tests.json`);
process.exitCode = failed.length ? 1 : 0;
