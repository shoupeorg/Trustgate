// E2E test of Seller mode (real Chrome via Playwright, injected EIP-6963 test wallet that signs in Node):
// the seller posts an offer from the site → the buyer's agent (NEGO_BUYER_PRIVATE_KEY, in Node) requests it →
// GenLayer verdict → on RENEGOTIATE the seller accepts the counterproposal from the site → the buyer requests
// v2 → verdict. Screenshots of Seller mode and of the Negotiation view.
//
//   npx next start -p 3100
//   node tests/e2e/seller-mode.mjs [--base http://localhost:3100]
//
// The seller key is generated for this run (in memory only) and funded by CUSTODY_TEST_PRIVATE_KEY.
// Uses the public demo vault from experiments/negotiation-demo/state.json. Writes experiments/e2e/seller-mode.json.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createAccount, createClient } from "genlayer-js";
import { studioDevnet } from "genlayer-js/chains";
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.join(ROOT, "experiments", "e2e");
const args = process.argv.slice(2);
const BASE = args.includes("--base") ? args[args.indexOf("--base") + 1] : "http://localhost:3100";
const RPC = "https://studio-dev.genlayer.com/api";
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const chain = defineChain({ id: 61997, name: "GenLayer Studio Next", nativeCurrency: { name: "GEN", symbol: "GEN", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, ".env.local"), "utf8").split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const demo = JSON.parse(fs.readFileSync(path.join(ROOT, "experiments", fs.existsSync(path.join(ROOT, "experiments", "site-demo.json")) ? "site-demo.json" : "negotiation-demo/state.json"), "utf8"));
const CONTRACT = demo.contract;
const sellerAcct = privateKeyToAccount(generatePrivateKey());
const sellerWallet = createWalletClient({ account: sellerAcct, chain, transport: http(RPC) });
const pub = createPublicClient({ chain, transport: http(RPC) });
const buyer = createClient({ chain: studioDevnet, account: createAccount(env.NEGO_BUYER_PRIVATE_KEY) });
const sha = (t) => crypto.createHash("sha256").update(t, "utf8").digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

const TERMS = "PolyCorpus: 20,000 annotated Persian-English sentence pairs for MT research, delivered as JSONL within 2 days. Price 0.8 GEN, paid in full upfront to our shop wallet. All sales final.";
const log = { base: BASE, contract: CONTRACT, vault: demo.vaultId, seller: sellerAcct.address, startedAt: new Date().toISOString(), steps: [] };
const save = () => fs.writeFileSync(path.join(OUT, "seller-mode.json"), JSON.stringify(log, null, 2) + "\n");
async function step(name, fn) {
  const t0 = Date.now();
  process.stdout.write(`- ${name} … `);
  try {
    const detail = (await fn()) ?? null;
    log.steps.push({ name, ok: true, ms: Date.now() - t0, detail });
    console.log("ok", detail ? JSON.stringify(detail).slice(0, 200) : "");
    return detail;
  } catch (e) {
    log.steps.push({ name, ok: false, ms: Date.now() - t0, error: String(e?.message ?? e).slice(0, 500) });
    console.log("FAILED", String(e?.message ?? e).slice(0, 300));
    return null;
  } finally {
    save();
  }
}

const PROVIDER_SCRIPT = (address) => `(() => {
  const state = { chainId: "0x1", added: false };
  const listeners = {};
  const err = (code, message) => Object.assign(new Error(message), { code });
  const provider = {
    isMetaMask: false,
    async request({ method, params }) {
      switch (method) {
        case "eth_requestAccounts": case "eth_accounts": return ["${address}"];
        case "eth_chainId": return state.chainId;
        case "net_version": return String(parseInt(state.chainId, 16));
        case "wallet_switchEthereumChain":
          if (params[0].chainId.toLowerCase() === "0xf22d" && !state.added) throw err(4902, "Unrecognized chain ID");
          state.chainId = params[0].chainId.toLowerCase();
          (listeners.chainChanged || []).forEach((l) => l(state.chainId));
          return null;
        case "wallet_addEthereumChain": state.added = true; return null;
        case "eth_sendTransaction": return await window.__tgSend(JSON.stringify(params[0]));
        default: return JSON.parse(await window.__tgRpc(method, JSON.stringify(params ?? [])));
      }
    },
    on(e, l) { (listeners[e] = listeners[e] || []).push(l); },
    removeListener(e, l) { listeners[e] = (listeners[e] || []).filter((x) => x !== l); },
  };
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info: { uuid: "e2e-seller-wallet", name: "TestWallet", icon: "", rdns: "dev.trustgate.e2e" }, provider }) }));
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
})();`;

async function buyerRequest(offerId, terms) {
  const e = await buyer.estimateTransactionFees();
  const hash = await buyer.writeContract({ address: CONTRACT, functionName: "request_commitment", args: [`e2e-req-${Date.now().toString(36)}`, demo.vaultId, offerId, sha(terms), "Parallel corpus for the MT study."], fees: { distribution: e.distribution, messageAllocations: e.messageAllocations, feeValue: e.feeValue } });
  for (let i = 0; i < 240; i++) {
    const tx = await buyer.getTransaction({ hash }).catch(() => null);
    if (["ACCEPTED", "FINALIZED", "UNDETERMINED", "CANCELED", "LEADER_TIMEOUT", "VALIDATORS_TIMEOUT"].includes(String(tx?.statusName).toUpperCase())) {
      const leader = tx?.consensus_data?.leader_receipt?.[0];
      return { hash, status: tx.statusName, execution: leader?.execution_result, judged: Object.keys(leader?.eq_outputs ?? {}).length > 0 };
    }
    await sleep(5000);
  }
  throw new Error("request did not finish");
}
async function feedEvents() {
  const res = await fetch(`${BASE}/api/vault-feed?contract=${CONTRACT}`, { cache: "no-store" });
  return (await res.json()).events ?? [];
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  await pub.waitForTransactionReceipt({ hash: await createWalletClient({ account: privateKeyToAccount(env.CUSTODY_TEST_PRIVATE_KEY), chain, transport: http(RPC) }).sendTransaction({ to: sellerAcct.address, value: 10n ** 18n }) });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.exposeBinding("__tgSend", async (_src, json) => {
    const tx = JSON.parse(json);
    return sellerWallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : undefined, gas: tx.gas ? BigInt(tx.gas) : undefined });
  });
  await ctx.exposeBinding("__tgRpc", async (_src, method, params) => {
    const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params: JSON.parse(params) }) });
    const body = await res.json();
    if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code });
    return JSON.stringify(body.result ?? null);
  });
  await ctx.addInitScript(PROVIDER_SCRIPT(sellerAcct.address));
  const page = await ctx.newPage();
  page.on("pageerror", (e) => (log.pageErrors = [...(log.pageErrors ?? []), String(e).slice(0, 300)]));
  await page.goto(BASE, { waitUntil: "domcontentloaded" });

  await step("connect as seller and open Seller mode", async () => {
    await page.getByRole("button", { name: /Connect TestWallet/ }).click();
    await page.locator(".status-badge").filter({ hasText: sellerAcct.address.slice(0, 6) }).waitFor({ timeout: 20000 });
    await page.getByRole("tab", { name: "Seller" }).click();
    await page.getByText("Post an offer to a vault").waitFor({ timeout: 10000 });
  });

  let offerId = null;
  await step("post a signed offer from the site (wallet signs post_offer)", async () => {
    await page.getByPlaceholder("vault id").fill(demo.vaultId);
    await page.getByText("Buyer's mandate").waitFor({ timeout: 60000 });
    const form = page.locator("form").filter({ hasText: "Post an offer to a vault" });
    await form.locator("input[inputmode=decimal]").fill("0.8");
    await form.locator("textarea").fill(TERMS);
    await form.getByRole("button", { name: /post offer/i }).click();
    await page.getByRole("button", { name: /Confirm in wallet/ }).click();
    await page.locator(".v13-tx").filter({ hasText: /Consensus reached|Finalized/ }).first().waitFor({ timeout: 300000 });
    offerId = new URL(page.url()).searchParams.get("negotiation");
    if (!offerId) throw new Error("no negotiation id in the URL");
    return { offerId };
  });
  await page.getByRole("tab", { name: "Seller" }).scrollIntoViewIfNeeded();
  await page.locator(".v13-roles").screenshot({ path: path.join(OUT, "seller-mode-posted.png") });

  const v1 = offerId && await step("buyer's agent requests v1 (Node) → GenLayer verdict", async () => buyerRequest(offerId, TERMS));
  let verdict = null;
  await step("Seller mode shows the verdict (and the counterproposal if RENEGOTIATE)", async () => {
    const card = page.locator(".v13-offer").filter({ hasText: offerId });
    for (let i = 0; i < 60; i++) {
      const t = (await card.textContent().catch(() => "")) ?? "";
      if (/waiting for the seller/.test(t)) { verdict = "RENEGOTIATE"; break; }
      if (/rejected by GenLayer|accepted by GenLayer|blocked by the vault/.test(t)) { verdict = t.match(/rejected|accepted|blocked/)[0]; break; }
      await page.waitForTimeout(5000);
    }
    if (!verdict) throw new Error("verdict not shown in Seller mode within 5 minutes");
    await page.locator(".v13-roles").screenshot({ path: path.join(OUT, "seller-mode-counterproposal.png") });
    return { verdict, tx: v1?.hash };
  });

  if (verdict === "RENEGOTIATE") {
    await step("seller accepts the counterproposal from the site (wallet signs v2)", async () => {
      await page.getByRole("button", { name: /Accept: sign exactly this text/ }).click();
      await page.getByRole("button", { name: /Confirm in wallet/ }).click();
      await page.locator(".v13-tx").filter({ hasText: /Consensus reached|Finalized/ }).first().waitFor({ timeout: 300000 });
    });
    await step("buyer's agent requests v2 (Node) → GenLayer verdict", async () => {
      let v2 = null;
      for (let i = 0; i < 30 && !v2; i++) {
        v2 = (await feedEvents()).find((e) => e.method === "accept_counterproposal" && e.args[1] === offerId && ["ACCEPTED", "FINALIZED"].includes(String(e.status).toUpperCase()));
        if (!v2) await sleep(5000);
      }
      if (!v2) throw new Error("v2 not in the feed");
      return buyerRequest(v2.args[0], v2.args[2]);
    });
  } else {
    log.steps.push({ name: "seller accepts the counterproposal", ok: true, skipped: `verdict was ${verdict}` });
    save();
  }
  await step("Negotiation view shows the full timeline", async () => {
    await page.goto(`${BASE}/?negotiation=${offerId}#negotiation`, { waitUntil: "domcontentloaded" });
    const sec = page.locator("#negotiation");
    await sec.locator(".v13-timeline > li").first().waitFor({ timeout: 120000 });
    for (let i = 0; i < 24; i++) {
      if (!(await sec.getByText("JUDGING").count())) break;
      await page.waitForTimeout(5000);
    }
    await page.waitForTimeout(1500);
    await sec.screenshot({ path: path.join(OUT, "negotiation-view-seller.png") });
    return { steps: await sec.locator(".v13-timeline > li").count(), outcome: (await sec.locator(".v13-outcome").textContent())?.trim() };
  });
} finally {
  log.finishedAt = new Date().toISOString();
  save();
  await browser.close();
}
const failed = log.steps.filter((s) => !s.ok);
console.log(`\n${log.steps.length - failed.length}/${log.steps.length} steps passed. Log: experiments/e2e/seller-mode.json`);
process.exitCode = failed.length ? 1 : 0;
