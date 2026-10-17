#!/usr/bin/env node
// TrustGate V1.3 MCP server, both sides of a deal on GenLayer Studio Next (chain 61997).
//
// Buyer side (the agent of a vault): list offers, request a commitment BY OFFER, read the verdict,
// vault status. The agent never holds funds and cannot change an offer's payee, amount or text.
// Seller side: post an offer, read TrustGate's counterproposal, accept it word for word, counter
// with a new version, or decline. Both sides read the same on-chain verdict.
//
// Slow steps return at once with status "pending" and a tx hash; poll the matching get_* tool.
//
// Environment (read only here, never printed or logged):
//   TRUSTGATE_AGENT_PRIVATE_KEY   buyer tools: the agent wallet registered on the vault (test GEN only)
//   TRUSTGATE_SELLER_PRIVATE_KEY  seller tools: the seller wallet (offers are paid to this wallet)
//   TRUSTGATE_CONTRACT            optional, vault contract (default: the V1.3 negotiation contract)
//   TRUSTGATE_SITE                optional, site used for the decoded history (default: the V1.3 site)

import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAccount, createClient, generatePrivateKey } from "genlayer-js";
import { studioDevnet } from "genlayer-js/chains";
import { z } from "zod";
import { buildNegotiations, type NegEvent, type NegRequest, type Negotiation, type Offer } from "./negotiation.js";

const CONTRACT = (process.env.TRUSTGATE_CONTRACT ?? "0x53E6f0eC998d9BfAd1CA3753252EE94b2cd16BF0") as `0x${string}`;
const SITE = (process.env.TRUSTGATE_SITE ?? "https://trustgatecheck.xyz").replace(/\/$/, "");
const EXPLORER_TX = "https://explorer-studio-dev.genlayer.com/tx/";
const GEN = 10n ** 18n;
const MAX_TERMS = 6000;
const MAX_JUSTIFICATION = 1500;

function wallet(name: string) {
  const raw = process.env[name]?.trim();
  const key = raw && /^0x[0-9a-fA-F]{64}$/.test(raw) ? (raw as `0x${string}`) : null;
  if (!key) return null;
  const account = createAccount(key);
  return { address: account.address.toLowerCase(), client: createClient({ chain: studioDevnet, account }) };
}
const buyer = wallet("TRUSTGATE_AGENT_PRIVATE_KEY");
const seller = wallet("TRUSTGATE_SELLER_PRIVATE_KEY");

// ---------------------------------------------------------------- history → state (mirrors the site)

type Vault = { vaultId: string; owner: string; agent: string; mandate: string; cap: bigint; totalCap: bigint; allowlist: string[]; funds: bigint; released: bigint };

const str = (v: unknown) => (typeof v === "string" ? v : "");
const big = (v: unknown) => { try { return BigInt(v as string); } catch { return 0n; } };
const up = (s: string | null | undefined) => String(s ?? "").toUpperCase();
const ok = (e: NegEvent) => ["ACCEPTED", "FINALIZED"].includes(up(e.status)) && up(e.execution) === "SUCCESS";
const fmt = (wei: bigint) => { const f = (wei % GEN).toString().padStart(18, "0").replace(/0+$/, "").slice(0, 6); return `${wei / GEN}${f ? `.${f}` : ""}`; };
const toWei = (gen: string) => { const m = gen.trim().match(/^(\d{1,12})(?:\.(\d{0,18}))?$/); return m ? BigInt(m[1]) * GEN + BigInt((m[2] ?? "").padEnd(18, "0") || "0") : null; };
const sha256 = (t: string) => crypto.createHash("sha256").update(t, "utf8").digest("hex");
const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${generatePrivateKey().slice(2, 8)}`;
const finality = (status: string) => (up(status) === "FINALIZED" ? "final" : up(status) === "ACCEPTED" ? "provisional" : ["UNDETERMINED", "LEADER_TIMEOUT", "VALIDATORS_TIMEOUT", "CANCELED"].includes(up(status)) ? "no verdict" : "pending");

async function feed(): Promise<NegEvent[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const res = await fetch(`${SITE}/api/vault-feed?contract=${CONTRACT}`, { signal: controller.signal });
    const body = (await res.json()) as { events?: NegEvent[]; error?: string };
    if (!res.ok || !Array.isArray(body.events)) throw new Error(body.error ?? `HTTP ${res.status}`);
    return body.events;
  } catch (e) {
    throw new Error(`Network problem: could not load the contract history from ${SITE} (${e instanceof Error ? e.message : e}). Try again in a minute.`);
  } finally {
    clearTimeout(timer);
  }
}

async function state() {
  const events = await feed();
  const vaults = new Map<string, Vault>();
  for (const e of [...events].sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""))) {
    if (e.method === "create_vault" && ok(e) && /"ok":\s*true/.test(e.returned ?? "")) {
      const [id, agent, mandate, cap, totalCap, allow] = e.args;
      if (!vaults.has(str(id))) vaults.set(str(id), { vaultId: str(id), owner: e.from.toLowerCase(), agent: str(agent).toLowerCase(), mandate: str(mandate), cap: big(cap), totalCap: big(totalCap ?? "0"), allowlist: str(allow).split(/[\s,]+/).filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a)).map((a) => a.toLowerCase()), funds: big(e.value), released: 0n });
    } else if (e.method === "top_up" && ok(e) && /"ok":\s*true/.test(e.returned ?? "")) {
      const v = vaults.get(str(e.args[0]));
      if (v) v.funds += big(e.value);
    } else if (e.method === "owner_reclaim" && ok(e)) {
      const v = vaults.get(str(e.args[0]));
      if (v) v.funds -= big(e.args[1]);
    }
  }
  const book = buildNegotiations(events);
  for (const r of book.requests.values()) {
    const v = vaults.get(r.vaultId);
    if (v && r.released) { v.funds -= r.amount; v.released += r.amount; }
  }
  return { vaults, book };
}

function verdictOf(r: NegRequest) {
  const f = finality(r.event.status);
  const verdict = f === "pending" ? "PENDING" : f === "no verdict" ? "NO_VERDICT" : r.stage === "DETERMINISTIC" ? "REJECT_HARD_LIMIT" : r.judgment?.decision ?? "UNKNOWN";
  return {
    request_id: r.requestId, offer_id: r.offerId, vault_id: r.vaultId, payee: r.payee, amount_gen: fmt(r.amount),
    status: f, verdict, risk: r.judgment?.risk ?? null,
    summary: r.judgment?.summary ?? (verdict === "REJECT_HARD_LIMIT" ? "Blocked by the owner's enforced hard limits before any validator judgment." : null),
    mandate_violations: r.judgment?.mandate_violations ?? [],
    counterproposal: r.judgment?.decision === "RENEGOTIATE" ? r.judgment.counterproposal : null,
    funds_moved: r.released ? "credited to the seller inside the vault (wallet payouts do not arrive on Studio Next yet)" : "none",
    tx: r.event.hash, explorer: EXPLORER_TX + r.event.hash,
  };
}

function offerView(o: Offer) {
  return { offer_id: o.offerId, negotiation_id: o.negotiationId, vault_id: o.vaultId, version: o.version, origin: o.origin, seller: o.seller, payee: o.seller, amount_gen: fmt(o.amount), status: o.status, terms: o.terms, terms_hash: o.termsHash, previous_offer_id: o.previousOfferId || null, signed_in: EXPLORER_TX + o.event.hash };
}

function negotiationView(n: Negotiation) {
  return {
    negotiation_id: n.negotiationId, vault_id: n.vaultId, seller: n.seller, status: n.status, latest_offer_id: n.latest.offerId, latest_status: n.latest.status,
    link: `${SITE}/?negotiation=${encodeURIComponent(n.negotiationId)}`,
    timeline: n.timeline.map((s) =>
      s.kind === "offer" ? { step: s.offer.origin === "posted" ? "offer posted" : s.offer.origin === "countered" ? "seller countered" : "seller signed TrustGate's counterproposal", version: s.offer.version, offer_id: s.offer.offerId, signed_by: s.offer.seller, amount_gen: fmt(s.offer.amount), terms: s.offer.terms, status: finality(s.event.status), tx: s.event.hash }
        : s.kind === "request" ? { step: "GenLayer verdict", ...verdictOf(s.request) }
          : { step: s.kind === "declined" ? "seller declined" : "buyer withdrew", by: s.by, reason: s.reason, status: finality(s.event.status), tx: s.event.hash }),
  };
}

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (message: string) => ({ content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true });
const errMsg = (e: unknown) => (e instanceof Error ? ((e as Error & { shortMessage?: string }).shortMessage ?? e.message).split("\n")[0] : String(e));

async function write(w: NonNullable<typeof buyer>, method: string, args: unknown[]) {
  const e = await w.client.estimateTransactionFees();
  return w.client.writeContract({ address: CONTRACT, functionName: method, args: args as never, fees: { distribution: e.distribution, messageAllocations: e.messageAllocations, feeValue: e.feeValue } });
}
const pending = (hash: string, extra: Record<string, unknown>, next: string) => text({ status: "pending", ...extra, tx: hash, explorer: EXPLORER_TX + hash, next });

async function negotiationOf(id: string) {
  const { vaults, book } = await state();
  const n = book.negotiations.get(id) ?? (book.offers.get(id) ? book.negotiations.get(book.offers.get(id)!.negotiationId) : undefined);
  return { vaults, book, n };
}

const server = new McpServer({ name: "trustgate", version: "1.3.1" });

// ---------------------------------------------------------------- buyer tools

server.registerTool("trustgate_list_offers", {
  title: "List offers made to a vault",
  description: "Buyer side. Offers sellers posted (and signed) for a vault, latest version of each negotiation. Use an OPEN offer's offer_id with trustgate_request_commitment.",
  inputSchema: { vault_id: z.string().min(1).max(128), only_open: z.boolean().optional().describe("Only offers that can be requested now (default true)") },
}, async ({ vault_id, only_open }) => {
  try {
    const { book } = await state();
    const list = [...book.negotiations.values()].filter((n) => n.vaultId === vault_id).map((n) => n.latest).filter((o) => only_open === false || o.status === "OPEN");
    return text(list.reverse().map(offerView));
  } catch (e) { return fail(errMsg(e)); }
});

server.registerTool("trustgate_request_commitment", {
  title: "Request a commitment against a seller's offer",
  description: "Buyer side. Ask the vault to pay for a seller-signed offer. Payee, amount and terms come from the offer; you add only your justification. Returns at once (pending); judging takes a few minutes, follow it with trustgate_get_verdict.",
  inputSchema: { vault_id: z.string().min(1).max(128), offer_id: z.string().min(1).max(128), justification: z.string().max(MAX_JUSTIFICATION).describe("Why the vault should pay (untrusted; judged as a claim)") },
}, async ({ vault_id, offer_id, justification }) => {
  if (!buyer) return fail("TRUSTGATE_AGENT_PRIVATE_KEY is not set (or not a 0x-prefixed 64-hex key) in this MCP server's environment.");
  try {
    const { vaults, book } = await state();
    const v = vaults.get(vault_id);
    const o = book.offers.get(offer_id);
    if (!v) return fail(`Vault "${vault_id}" was not found on contract ${CONTRACT}.`);
    if (v.agent !== buyer.address) return fail(`This key (${buyer.address}) is not the registered agent of vault "${vault_id}". Nothing was sent.`);
    if (!o) return fail(`Offer "${offer_id}" was not found (it may still be pending; try again in a minute).`);
    if (o.vaultId !== vault_id) return fail(`Offer "${offer_id}" was made to vault "${o.vaultId}", not "${vault_id}". Nothing was sent.`);
    if (o.status !== "OPEN") return fail(`Offer "${offer_id}" is ${o.status}; only the latest OPEN version can be requested. Nothing was sent.`);
    const requestId = newId("mcp");
    const hash = await write(buyer, "request_commitment", [requestId, vault_id, offer_id, sha256(o.terms), justification]);
    return pending(hash, { request_id: requestId, offer_id, payee: o.seller, amount_gen: fmt(o.amount) }, "Call trustgate_get_verdict with this request_id in about a minute.");
  } catch (e) { return fail(`Submitting failed: ${errMsg(e)}. Check the agent wallet has test GEN for fees.`); }
});

server.registerTool("trustgate_get_verdict", {
  title: "Get the verdict for a request",
  description: "Both sides. pending, provisional (validators agreed, not final yet) or final, with the verdict (ACCEPT, RENEGOTIATE, REJECT, REJECT_HARD_LIMIT), reasons and any counterproposal.",
  inputSchema: { request_id: z.string().min(1).max(128) },
}, async ({ request_id }) => {
  try {
    const { book } = await state();
    const r = book.requests.get(request_id);
    return r ? text(verdictOf(r)) : text({ request_id, status: "pending", note: "Not in the history yet (or refused by the contract). Try again in a minute." });
  } catch (e) { return fail(errMsg(e)); }
});

server.registerTool("trustgate_vault_status", {
  title: "Vault status",
  description: "Buyer side. Mandate, enforced limits, funds, and its negotiations.",
  inputSchema: { vault_id: z.string().min(1).max(128) },
}, async ({ vault_id }) => {
  try {
    const { vaults, book } = await state();
    const v = vaults.get(vault_id);
    if (!v) return fail(`Vault "${vault_id}" was not found on contract ${CONTRACT}.`);
    const negs = [...book.negotiations.values()].filter((n) => n.vaultId === vault_id);
    return text({
      vault_id, contract: CONTRACT, owner: v.owner, agent: v.agent, you_are_the_agent: v.agent === buyer?.address,
      mandate: v.mandate, hard_cap_gen: fmt(v.cap), total_cap_gen: v.totalCap > 0n ? fmt(v.totalCap) : null, payee_allowlist: v.allowlist,
      holds_gen: fmt(v.funds), credited_to_sellers_gen: fmt(v.released),
      negotiations: negs.map((n) => ({ negotiation_id: n.negotiationId, status: n.status, latest_offer_id: n.latest.offerId, latest_status: n.latest.status })),
    });
  } catch (e) { return fail(errMsg(e)); }
});

// ---------------------------------------------------------------- seller tools

server.registerTool("trustgate_post_offer", {
  title: "Post an offer to a vault",
  description: "Seller side. Post a signed offer from your wallet: you are the payee. The exact text and its hash are stored; to change it later, post a new version (trustgate_counter_offer). Returns at once (pending).",
  inputSchema: { vault_id: z.string().min(1).max(128), amount_gen: z.string().describe("Price in GEN, e.g. \"0.5\""), terms: z.string().min(1).max(MAX_TERMS).describe("Full terms of the deal") },
}, async ({ vault_id, amount_gen, terms }) => {
  if (!seller) return fail("TRUSTGATE_SELLER_PRIVATE_KEY is not set (or not a 0x-prefixed 64-hex key) in this MCP server's environment.");
  const amount = toWei(amount_gen);
  if (amount === null || amount <= 0n) return fail(`amount_gen must be a positive number of GEN (got "${amount_gen}").`);
  try {
    const { vaults, book } = await state();
    if (!vaults.has(vault_id)) return fail(`Vault "${vault_id}" was not found on contract ${CONTRACT}.`);
    const open = [...book.negotiations.values()].filter((n) => n.vaultId === vault_id && n.seller === seller.address && n.status === "OPEN").length;
    if (open >= 3) return fail(`You already have ${open} open negotiations with this vault (the contract allows 3 per seller). Decline one first. Nothing was sent.`);
    const offerId = newId("offer");
    const hash = await write(seller, "post_offer", [offerId, vault_id, amount, terms]);
    return pending(hash, { offer_id: offerId, negotiation_id: offerId, payee: seller.address, terms_hash: sha256(terms) }, "The buyer's agent can now request it. Follow with trustgate_get_negotiation.");
  } catch (e) { return fail(`Submitting failed: ${errMsg(e)}. Check the seller wallet has test GEN for fees.`); }
});

server.registerTool("trustgate_get_negotiation", {
  title: "Get a negotiation",
  description: "Both sides. Full timeline: every offer version and who signed it, every GenLayer verdict, counterproposals, and the outcome.",
  inputSchema: { negotiation_id: z.string().min(1).max(128).describe("Negotiation id (the first offer's id) or any offer id in it") },
}, async ({ negotiation_id }) => {
  try {
    const { n } = await negotiationOf(negotiation_id);
    return n ? text(negotiationView(n)) : text({ negotiation_id, status: "pending", note: "Not in the history yet. Try again in a minute." });
  } catch (e) { return fail(errMsg(e)); }
});

server.registerTool("trustgate_get_counterproposal", {
  title: "Get TrustGate's counterproposal",
  description: "Seller side. After a RENEGOTIATE verdict: the safer terms GenLayer proposed, which you may accept word for word, counter, or decline.",
  inputSchema: { negotiation_id: z.string().min(1).max(128) },
}, async ({ negotiation_id }) => {
  try {
    const { n } = await negotiationOf(negotiation_id);
    if (!n) return fail(`Negotiation "${negotiation_id}" was not found.`);
    const o = n.latest;
    if (o.status !== "AWAITING_SELLER" || !o.counterproposal) return text({ negotiation_id: n.negotiationId, latest_offer_id: o.offerId, latest_status: o.status, counterproposal: null });
    return text({ negotiation_id: n.negotiationId, offer_id: o.offerId, your_terms: o.terms, counterproposal: o.counterproposal.dealText, notes: o.counterproposal.notes, from_request: o.counterproposal.requestId, choices: ["trustgate_accept_counterproposal", "trustgate_counter_offer", "trustgate_decline"] });
  } catch (e) { return fail(errMsg(e)); }
});

async function sellerLatest(negotiation_id: string) {
  if (!seller) throw new Error("TRUSTGATE_SELLER_PRIVATE_KEY is not set (or not a 0x-prefixed 64-hex key) in this MCP server's environment.");
  const { n } = await negotiationOf(negotiation_id);
  if (!n) throw new Error(`Negotiation "${negotiation_id}" was not found.`);
  if (n.seller !== seller.address) throw new Error(`This key (${seller.address}) is not the seller of this negotiation. Nothing was sent.`);
  if (n.status !== "OPEN") throw new Error(`Negotiation is closed (${n.status}). Nothing was sent.`);
  return n;
}

server.registerTool("trustgate_accept_counterproposal", {
  title: "Accept TrustGate's counterproposal",
  description: "Seller side. Signs the counterproposal text word for word as your new offer version (same price). The buyer's agent can then request it. Returns at once (pending).",
  inputSchema: { negotiation_id: z.string().min(1).max(128) },
}, async ({ negotiation_id }) => {
  try {
    const n = await sellerLatest(negotiation_id);
    const o = n.latest;
    if (o.status !== "AWAITING_SELLER" || !o.counterproposal) return fail(`The latest offer is ${o.status}; there is no counterproposal to accept. Nothing was sent.`);
    const newOfferId = newId("offer");
    const hash = await write(seller!, "accept_counterproposal", [newOfferId, o.offerId, o.counterproposal.dealText]);
    return pending(hash, { offer_id: newOfferId, version: o.version + 1, terms_hash: sha256(o.counterproposal.dealText) }, "Follow with trustgate_get_negotiation.");
  } catch (e) { return fail(errMsg(e)); }
});

server.registerTool("trustgate_counter_offer", {
  title: "Counter with your own new version",
  description: "Seller side. Post a new version with your own terms and price; it replaces the latest version. Returns at once (pending).",
  inputSchema: { negotiation_id: z.string().min(1).max(128), amount_gen: z.string(), terms: z.string().min(1).max(MAX_TERMS) },
}, async ({ negotiation_id, amount_gen, terms }) => {
  const amount = toWei(amount_gen);
  if (amount === null || amount <= 0n) return fail(`amount_gen must be a positive number of GEN (got "${amount_gen}").`);
  try {
    const n = await sellerLatest(negotiation_id);
    if (n.latest.status === "JUDGING") return fail("GenLayer is judging the latest version right now; wait for the verdict.");
    const newOfferId = newId("offer");
    const hash = await write(seller!, "counter_offer", [newOfferId, n.latest.offerId, amount, terms]);
    return pending(hash, { offer_id: newOfferId, version: n.latest.version + 1, terms_hash: sha256(terms) }, "Follow with trustgate_get_negotiation.");
  } catch (e) { return fail(errMsg(e)); }
});

server.registerTool("trustgate_decline", {
  title: "Decline and close the negotiation",
  description: "Seller side. Closes the negotiation; no funds move. Returns at once (pending).",
  inputSchema: { negotiation_id: z.string().min(1).max(128), reason: z.string().max(500) },
}, async ({ negotiation_id, reason }) => {
  try {
    const n = await sellerLatest(negotiation_id);
    const hash = await write(seller!, "decline", [n.latest.offerId, reason]);
    return pending(hash, { negotiation_id: n.negotiationId }, "Follow with trustgate_get_negotiation.");
  } catch (e) { return fail(errMsg(e)); }
});

await server.connect(new StdioServerTransport());
