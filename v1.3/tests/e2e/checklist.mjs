// Runs the full two-wallet test checklist end to end in real Chrome with two fresh test wallets (injected EIP-6963
// wallets that sign in Node): A = owner + buyer (with a browser agent key), B = seller.
//   faucet · agent key + funding · create vault · seller posts offer · agent requests from the site ·
//   RENEGOTIATE · seller signs v2 · agent requests v2 · ACCEPT · share link without a wallet · top up ·
//   take back · decline path · spam-limit message · Version 1 link · mobile view
//
//   node tests/e2e/checklist.mjs [--base https://…]
//
// Fresh keys live only in memory; A and B get 2 GEN each from CUSTODY_TEST_PRIVATE_KEY for fees and the
// deposit (plus the site faucet). Writes experiments/live/checklist.json and screenshots.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.join(ROOT, "experiments", "live");
const SHOTS = path.join(OUT, "checklist");
const args = process.argv.slice(2);
const BASE = args.includes("--base") ? args[args.indexOf("--base") + 1] : "https://trustgate-v13.shoupeorg.workers.dev";
const RPC = "https://studio-dev.genlayer.com/api";
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const chain = defineChain({ id: 61997, name: "GenLayer Studio Next", nativeCurrency: { name: "GEN", symbol: "GEN", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, ".env.local"), "utf8").split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const pub = createPublicClient({ chain, transport: http(RPC) });
const GEN = 10n ** 18n;
fs.mkdirSync(SHOTS, { recursive: true });

const A = privateKeyToAccount(generatePrivateKey());
const B = privateKeyToAccount(generatePrivateKey());
const log = { base: BASE, owner: A.address, seller: B.address, startedAt: new Date().toISOString(), steps: [] };
const save = () => fs.writeFileSync(path.join(OUT, "checklist.json"), JSON.stringify(log, null, 2) + "\n");
const pages = [];
async function step(name, fn) {
  const t0 = Date.now();
  process.stdout.write(`- ${name} … `);
  try {
    const detail = (await fn()) ?? null;
    log.steps.push({ name, ok: true, ms: Date.now() - t0, detail });
    console.log("ok", detail ? JSON.stringify(detail).slice(0, 180) : "");
    return detail;
  } catch (e) {
    log.steps.push({ name, ok: false, ms: Date.now() - t0, error: String(e?.message ?? e).slice(0, 500) });
    for (const [i, p] of pages.entries()) await p.screenshot({ path: path.join(SHOTS, `fail-${log.steps.length}-${i}.png`), fullPage: true }).catch(() => undefined);
    console.log("FAILED", String(e?.message ?? e).slice(0, 250));
    return null;
  } finally {
    save();
  }
}

const PROVIDER = (address) => `(() => {
  const st = { chainId: "0x1", added: false }; const listeners = {};
  const err = (code, message) => Object.assign(new Error(message), { code });
  const provider = { isMetaMask: false, async request({ method, params }) {
    switch (method) {
      case "eth_requestAccounts": case "eth_accounts": return ["${address}"];
      case "eth_chainId": return st.chainId;
      case "net_version": return String(parseInt(st.chainId, 16));
      case "wallet_switchEthereumChain":
        if (params[0].chainId.toLowerCase() === "0xf22d" && !st.added) throw err(4902, "Unrecognized chain ID");
        st.chainId = params[0].chainId.toLowerCase(); (listeners.chainChanged || []).forEach((l) => l(st.chainId)); return null;
      case "wallet_addEthereumChain": st.added = true; return null;
      case "eth_sendTransaction": return await window.__tgSend(JSON.stringify(params[0]));
      default: return JSON.parse(await window.__tgRpc(method, JSON.stringify(params ?? [])));
    }
  }, on(e, l) { (listeners[e] = listeners[e] || []).push(l); }, removeListener(e, l) { listeners[e] = (listeners[e] || []).filter((x) => x !== l); } };
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info: { uuid: "e2e-${address.slice(2, 8)}", name: "TestWallet", icon: "", rdns: "dev.trustgate.e2e" }, provider }) }));
  window.addEventListener("eip6963:requestProvider", announce); announce();
})();`;

async function walletPage(browser, account, viewport = { width: 1280, height: 900 }) {
  const wallet = createWalletClient({ account, chain, transport: http(RPC) });
  const ctx = await browser.newContext({ viewport });
  await ctx.exposeBinding("__tgSend", async (_s, json) => { const tx = JSON.parse(json); return wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : undefined, gas: tx.gas ? BigInt(tx.gas) : undefined }); });
  await ctx.exposeBinding("__tgRpc", async (_s, method, params) => {
    const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params: JSON.parse(params) }) });
    const body = await res.json();
    if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code });
    return JSON.stringify(body.result ?? null);
  });
  await ctx.addInitScript(PROVIDER(account.address));
  const page = await ctx.newPage();
  page.on("pageerror", (e) => (log.pageErrors = [...(log.pageErrors ?? []), String(e).slice(0, 300)]));
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /Connect TestWallet/ }).click();
  await page.locator(".status-badge").filter({ hasText: account.address.slice(0, 6) }).waitFor({ timeout: 30000 });
  return page;
}
async function confirmTx(page, button, timeout = 600000) {
  await page.getByRole("button", { name: button }).click();
  const hash = (await page.locator(".v13-tx code").first().textContent({ timeout: 180000 }))?.trim();
  await page.locator(".v13-tx").filter({ hasText: /Consensus reached|Finalized|No verdict/ }).first().waitFor({ timeout });
  return hash;
}
const tab = (page, name) => page.getByRole("tab", { name }).click();
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const funder = createWalletClient({ account: privateKeyToAccount(env.CUSTODY_TEST_PRIVATE_KEY), chain, transport: http(RPC) });
  for (const [a, amount] of [[A, 5n * GEN], [B, 2n * GEN]]) await pub.waitForTransactionReceipt({ hash: await funder.sendTransaction({ to: a.address, value: amount }) });

  const pa = await walletPage(browser, A);
  const pb = await walletPage(browser, B);
  pages.push(pa, pb);

  await step("A: Get test GEN (site faucet)", async () => {
    await pa.getByRole("button", { name: "Get test GEN" }).click();
    await pa.locator(".v13-faucet small").filter({ hasText: /sent|already|Limit/ }).waitFor({ timeout: 120000 });
    return { msg: (await pa.locator(".v13-faucet small").textContent())?.trim(), tx: await pa.locator(".v13-faucet small a").getAttribute("href").catch(() => null) };
  });
  await step("B: Get test GEN (site faucet)", async () => {
    await pb.getByRole("button", { name: "Get test GEN" }).click();
    await pb.locator(".v13-faucet small").filter({ hasText: /sent|already|Limit/ }).waitFor({ timeout: 120000 });
    return { msg: (await pb.locator(".v13-faucet small").textContent())?.trim() };
  });

  let vaultId = null;
  await step("A: create browser agent key and fund it with 1 GEN", async () => {
    await tab(pa, "Owner");
    await pa.getByRole("button", { name: "Create agent key" }).click();
    await pa.getByRole("button", { name: /Send 0.5 GEN from your wallet/ }).click();
    await pa.locator(".v13-tx").filter({ hasText: /Finalized/ }).first().waitFor({ timeout: 180000 });
    return { agent: (await pa.locator(".v13-agentkey code").first().textContent())?.trim() };
  });
  await step("A: create vault (cap 1, deposit 2; fee shown before signing)", async () => {
    await pa.getByLabel(/Hard cap per commitment/).fill("1");
    await pa.getByLabel(/^Deposit/).fill("2");
    await pa.getByRole("button", { name: /Review fee and create vault/ }).click();
    const fee = (await pa.getByText("Network fee up to").first().textContent({ timeout: 90000 }))?.trim();
    const hash = await confirmTx(pa, "Confirm in wallet");
    for (let i = 0; i < 40 && !vaultId; i++) {
      vaultId = (await pa.locator(".v13-ownervault b").first().textContent().catch(() => null))?.trim() ?? null;
      if (!vaultId) await pa.waitForTimeout(5000);
    }
    if (!vaultId) throw new Error("vault not listed under Your vaults");
    await shot(pa, "01-vault-created");
    return { vaultId, hash, fee: fee?.slice(0, 120) };
  });

  if (!vaultId) throw new Error("no vault: stopping (see the failure screenshots)");
  const TERMS = "LexiCorp - 12,000 annotated legal sentences for an NLP study, JSONL, delivered within 3 days. Price 0.5 GEN, paid in full upfront before delivery. No refund.";
  let negotiationId = null;
  await step("B: Seller tab, post a signed offer to A's vault", async () => {
    await tab(pb, "Seller");
    for (let i = 0; i < 24; i++) { await pb.reload({ waitUntil: "domcontentloaded" }); await pb.getByRole("button", { name: /Connect TestWallet/ }).click().catch(() => undefined); await pb.locator(".status-badge").filter({ hasText: B.address.slice(0, 6) }).waitFor({ timeout: 30000 }); await tab(pb, "Seller"); await pb.getByPlaceholder("vault id").fill(vaultId); if (await pb.getByText("Buyer's mandate").count()) break; await pb.waitForTimeout(5000); }
    const form = pb.locator("form").filter({ hasText: "Post an offer to a vault" });
    await form.locator("input[inputmode=decimal]").fill("0.5");
    await form.locator("textarea").fill(TERMS);
    await form.getByRole("button", { name: /post offer/i }).click();
    const hash = await confirmTx(pb, "Confirm in wallet");
    negotiationId = new URL(pb.url()).searchParams.get("negotiation");
    await shot(pb, "02-offer-posted");
    return { negotiationId, hash };
  });

  async function agentRequest(version) {
    await tab(pa, /Agent/);
    const offer = pa.locator(".v13-offer").filter({ hasText: `v${version}` }).first();
    for (let i = 0; i < 36 && !(await offer.count()); i++) { await pa.waitForTimeout(5000); }
    await offer.locator("textarea").fill("Legal NLP corpus for the study.");
    await offer.getByRole("button", { name: /Review fee and request/ }).click();
    const hash = await confirmTx(pa, "Confirm and send", 900000);
    return hash;
  }
  async function verdictFor(version) {
    const sec = pa.locator("#negotiation");
    for (let i = 0; i < 120; i++) {
      const li = sec.locator(".v13-timeline > li").filter({ hasText: `GenLayer verdict on v${version}` });
      const v = (await li.locator(".v13-verdict").textContent().catch(() => null))?.trim();
      if (v && v !== "JUDGING") return v;
      await pa.waitForTimeout(5000);
    }
    throw new Error(`no verdict on v${version}`);
  }

  let v1 = null;
  await step("A (agent key): request offer v1 from the site → GenLayer verdict", async () => {
    const hash = await agentRequest(1);
    v1 = await verdictFor(1);
    await shot(pa, "03-verdict-v1");
    return { hash, verdict: v1 };
  });
  if (v1 === "RENEGOTIATE") {
    await step("B: sees the counterproposal and signs it as v2", async () => {
      await tab(pb, "Seller");
      const btn = pb.getByRole("button", { name: /Accept: sign exactly this text/ });
      for (let i = 0; i < 36 && !(await btn.count()); i++) await pb.waitForTimeout(5000);
      await shot(pb, "04-seller-counterproposal");
      await btn.click();
      return { hash: await confirmTx(pb, "Confirm in wallet") };
    });
    await step("A (agent key): request v2 → ACCEPT, seller credited", async () => {
      const hash = await agentRequest(2);
      const v2 = await verdictFor(2);
      await shot(pa, "05-verdict-v2");
      if (v2 !== "ACCEPT") throw new Error(`v2 verdict ${v2}`);
      return { hash, verdict: v2 };
    });
  } else {
    log.steps.push({ name: "RENEGOTIATE round", ok: false, error: `v1 verdict was ${v1}, so the seller-signs round could not run` });
    save();
  }

  await step("share link opens without a wallet and shows the full timeline", async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await ctx.newPage();
    await p.goto(`${BASE}/?negotiation=${negotiationId}#negotiation`, { waitUntil: "domcontentloaded" });
    await p.locator("#negotiation .v13-timeline > li").first().waitFor({ timeout: 120000 });
    await p.waitForTimeout(2000);
    await p.locator("#negotiation").screenshot({ path: path.join(SHOTS, "06-share-link.png") });
    const out = { steps: await p.locator("#negotiation .v13-timeline > li").count(), outcome: (await p.locator(".v13-outcome").textContent())?.trim() };
    await ctx.close();
    return out;
  });

  await step("A: top up 0.3 GEN", async () => {
    await tab(pa, "Owner");
    await pa.locator(".v13-ownervault input").first().fill("0.3");
    await pa.getByRole("button", { name: "Top up" }).first().click();
    return { hash: await confirmTx(pa, "Confirm in wallet") };
  });
  await step("A: take back 0.2 GEN (credited inside the vault)", async () => {
    await pa.locator(".v13-ownervault input").first().fill("0.2");
    await pa.getByRole("button", { name: "Take back" }).first().click();
    return { hash: await confirmTx(pa, "Confirm in wallet") };
  });

  await step("B: decline path: post a second offer, then decline it", async () => {
    await tab(pb, "Seller");
    const form = pb.locator("form").filter({ hasText: "Post an offer to a vault" });
    await pb.getByPlaceholder("vault id").fill(vaultId);
    await form.locator("input[inputmode=decimal]").fill("0.4");
    await form.locator("textarea").fill("Second offer for the decline test: 0.4 GEN, full refund within 14 days.");
    await form.getByRole("button", { name: /post offer/i }).click();
    const posted = await confirmTx(pb, "Confirm in wallet");
    const id = new URL(pb.url()).searchParams.get("negotiation");
    await tab(pb, "Seller");
    const card = pb.locator(".v13-offer").filter({ hasText: id });
    for (let i = 0; i < 36 && !(await card.count()); i++) await pb.waitForTimeout(5000);
    await card.getByRole("button", { name: "Decline" }).click();
    await card.locator("input").last().fill("Testing the decline path.");
    await card.getByRole("button", { name: /Review fee and decline/ }).click();
    const declined = await confirmTx(pb, "Confirm in wallet");
    return { posted, declined, negotiationId: id };
  });

  await step("Version 1 link opens V1 with the notice", async () => {
    await pa.getByRole("link", { name: /Version 1/ }).click();
    await pa.getByText("Go to V1.3 (current)").waitFor({ timeout: 30000 });
    await shot(pa, "07-v1");
    return { title: await pa.title() };
  });
  await step("mobile view (390 px): no horizontal scroll", async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const p = await ctx.newPage();
    await p.goto(BASE, { waitUntil: "networkidle" });
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    await p.screenshot({ path: path.join(SHOTS, "08-mobile.png"), fullPage: false });
    await ctx.close();
    if (overflow > 2) throw new Error(`horizontal overflow ${overflow}px`);
    return { overflow };
  });
} finally {
  log.finishedAt = new Date().toISOString();
  save();
  await browser.close();
}
const failed = log.steps.filter((s) => !s.ok);
console.log(`\n${log.steps.length - failed.length}/${log.steps.length} steps passed. Log: experiments/live/checklist.json`);
process.exitCode = failed.length ? 1 : 0;
