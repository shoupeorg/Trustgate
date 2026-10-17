// Live two-sided test of the TrustGate MCP server with real MCP clients over stdio (the protocol desktop
// MCP clients use): one server process plays the SELLER (TRUSTGATE_SELLER_PRIVATE_KEY), another the BUYER's
// agent (TRUSTGATE_AGENT_PRIVATE_KEY). Seller posts an offer → buyer lists and requests it → verdict →
// on RENEGOTIATE the seller reads and accepts the counterproposal → buyer requests v2 → verdict.
//
//   cd mcp && npm run build && node test/negotiation.mjs [--site http://localhost:3100]
//
// Uses the public demo vault from ../experiments/negotiation-demo/state.json (its agent is NEGO_BUYER).
// Seller key: MCP_SELLER_PRIVATE_KEY (created if missing, funded by CUSTODY_TEST_PRIVATE_KEY). Keys are
// passed to the servers through their environment and never printed. Writes ../experiments/mcp-negotiation-test.json.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createAccount, generatePrivateKey } from "genlayer-js";
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const ENV = path.join(ROOT, ".env.local");
const OUT = path.join(ROOT, "experiments", "mcp-negotiation-test.json");
const argv = process.argv.slice(2);
const SITE = argv.includes("--site") ? argv[argv.indexOf("--site") + 1] : "https://trustgatecheck.xyz";
const RPC = "https://studio-dev.genlayer.com/api";
const chain = defineChain({ id: 61997, name: "GenLayer Studio Next", nativeCurrency: { name: "GEN", symbol: "GEN", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readEnv = () => Object.fromEntries(fs.readFileSync(ENV, "utf8").split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));

let env = readEnv();
if (!env.MCP_SELLER_PRIVATE_KEY) {
  fs.appendFileSync(ENV, `\n# MCP negotiation-test seller wallet, chain 61997 only. Never commit.\nMCP_SELLER_PRIVATE_KEY=${generatePrivateKey()}\n`);
  env = readEnv();
}
const demo = JSON.parse(fs.readFileSync(path.join(ROOT, "experiments", fs.existsSync(path.join(ROOT, "experiments", "site-demo.json")) ? "site-demo.json" : "negotiation-demo/state.json"), "utf8"));
const sellerAddr = createAccount(env.MCP_SELLER_PRIVATE_KEY).address;
const pub = createPublicClient({ chain, transport: http(RPC) });
if ((await pub.getBalance({ address: sellerAddr })) < 10n ** 17n * 5n) {
  const w = createWalletClient({ account: privateKeyToAccount(env.CUSTODY_TEST_PRIVATE_KEY), chain, transport: http(RPC) });
  await pub.waitForTransactionReceipt({ hash: await w.sendTransaction({ to: sellerAddr, value: 10n ** 18n }) });
}

const log = { site: SITE, contract: demo.contract, vault: demo.vaultId, seller: sellerAddr, buyer: demo.buyer, startedAt: new Date().toISOString(), calls: [] };
const save = () => fs.writeFileSync(OUT, JSON.stringify(log, null, 2) + "\n");

async function server(name, keyVar, key) {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(HERE, "..", "dist", "index.js")],
    env: { ...process.env, [keyVar]: key, TRUSTGATE_CONTRACT: demo.contract, TRUSTGATE_SITE: SITE },
  });
  const client = new Client({ name: `trustgate-test-${name}`, version: "1.0.0" });
  await client.connect(transport);
  return client;
}
async function call(client, side, name, args) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? "";
  let value = text;
  try { value = JSON.parse(text); } catch {}
  log.calls.push({ at: new Date().toISOString(), side, tool: name, args, isError: Boolean(r.isError), result: value });
  save();
  console.log(`- ${side}: ${name} → ${r.isError ? "ERROR " : ""}${typeof value === "string" ? value.slice(0, 140) : JSON.stringify(value).slice(0, 160)}`);
  return { value, isError: Boolean(r.isError) };
}
async function until(fn, label, tries = 120) {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await sleep(10000);
  }
  throw new Error(`timeout: ${label}`);
}

const seller = await server("seller", "TRUSTGATE_SELLER_PRIVATE_KEY", env.MCP_SELLER_PRIVATE_KEY);
const buyer = await server("buyer", "TRUSTGATE_AGENT_PRIVATE_KEY", env.NEGO_BUYER_PRIVATE_KEY);
try {
  log.sellerTools = (await seller.listTools()).tools.map((t) => t.name);
  save();
  const terms = "TagWorks - 3,000 named-entity labels on Persian news sentences for NLP research, delivered within 4 days. Price 0.6 GEN, 100% upfront before work starts, non-refundable.";
  const posted = await call(seller, "seller", "trustgate_post_offer", { vault_id: demo.vaultId, amount_gen: "0.6", terms });
  if (posted.isError) throw new Error(`post_offer failed: ${posted.value}`);
  const negId = posted.value.negotiation_id;
  await until(async () => (await call(seller, "seller", "trustgate_get_negotiation", { negotiation_id: negId })).value.latest_status === "OPEN", "offer listed");
  const offers = await call(buyer, "buyer", "trustgate_list_offers", { vault_id: demo.vaultId });
  const mine = offers.value.find((o) => o.negotiation_id === negId);
  if (!mine) throw new Error("offer not listed for the buyer");
  const req = await call(buyer, "buyer", "trustgate_request_commitment", { vault_id: demo.vaultId, offer_id: mine.offer_id, justification: "NER labels for the Persian NLP study." });
  if (req.isError) throw new Error(`request failed: ${req.value}`);
  const v1 = await until(async () => { const v = (await call(buyer, "buyer", "trustgate_get_verdict", { request_id: req.value.request_id })).value; return v.status !== "pending" && v.verdict !== "PENDING" ? v : null; }, "verdict v1");
  log.v1 = { verdict: v1.verdict, tx: v1.tx };
  if (v1.verdict === "RENEGOTIATE") {
    const cp = await until(async () => { const v = (await call(seller, "seller", "trustgate_get_counterproposal", { negotiation_id: negId })).value; return v.counterproposal ? v : null; }, "counterproposal");
    await call(seller, "seller", "trustgate_accept_counterproposal", { negotiation_id: negId });
    const v2offer = await until(async () => { const o = (await call(buyer, "buyer", "trustgate_list_offers", { vault_id: demo.vaultId })).value.find((x) => x.negotiation_id === negId && x.version === 2); return o ?? null; }, "v2 listed");
    if (v2offer.terms !== cp.counterproposal) throw new Error("v2 text differs from the counterproposal");
    const req2 = await call(buyer, "buyer", "trustgate_request_commitment", { vault_id: demo.vaultId, offer_id: v2offer.offer_id, justification: "Revised terms signed by the seller." });
    const v2 = await until(async () => { const v = (await call(buyer, "buyer", "trustgate_get_verdict", { request_id: req2.value.request_id })).value; return v.status !== "pending" && v.verdict !== "PENDING" ? v : null; }, "verdict v2");
    log.v2 = { verdict: v2.verdict, tx: v2.tx };
  }
  log.final = (await call(seller, "seller", "trustgate_get_negotiation", { negotiation_id: negId })).value;
  // A seller-only tool with the wrong key must refuse without sending anything.
  await call(buyer, "buyer", "trustgate_decline", { negotiation_id: negId, reason: "not my offer" });
  log.ok = true;
} catch (e) {
  log.ok = false;
  log.error = String(e?.message ?? e);
  console.log("FAILED", log.error);
} finally {
  log.finishedAt = new Date().toISOString();
  save();
  await seller.close();
  await buyer.close();
}
process.exitCode = log.ok ? 0 : 1;
