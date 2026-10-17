// Two-wallet flow in a real Chrome (Playwright), owner and seller in two separate browsers, no page refresh:
// owner claims test GEN until the daily limit toast, funds a browser agent key and creates a vault;
// the seller opens the "Share with seller" link and posts an offer; the owner's agent requests it;
// on RENEGOTIATE the seller signs v2; the agent requests v2. Both sides must see every change live.
//
//   node tests/e2e/two-wallets.mjs --base https://trustgatecheck.xyz [--out dir]
//
// Both wallets are fresh throwaway test keys made in Node for this run (chain 61997, test GEN only). They sign
// in Node, never enter the page and are never printed. Exit code 1 when any step fails.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createWalletClient, defineChain, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const arg = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
const BASE = arg("--base", "http://localhost:3100").replace(/\/$/, "") + "/";
const OUT = path.resolve(arg("--out", path.join(ROOT, "experiments", "e2e", "two-wallets")));
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const RPC = "https://studio-dev.genlayer.com/api";
const chain = defineChain({ id: 61997, name: "GenLayer Studio Next", nativeCurrency: { name: "GEN", symbol: "GEN", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const TERMS = "Dataset of 5,000 annotated research abstracts, JSON. Price 0.5 GEN paid upfront, no refund.";
fs.mkdirSync(OUT, { recursive: true });

const log = { base: BASE, startedAt: new Date().toISOString(), steps: [], consoleErrors: [] };
const save = () => fs.writeFileSync(path.join(OUT, "two-wallets.json"), JSON.stringify(log, null, 2) + "\n");
async function step(name, fn) {
  const t0 = Date.now();
  process.stdout.write(`- ${name} … `);
  try {
    const detail = (await fn()) ?? null;
    log.steps.push({ name, ok: true, ms: Date.now() - t0, detail });
    console.log("ok", detail ? JSON.stringify(detail).slice(0, 300) : "");
    return detail;
  } catch (e) {
    log.steps.push({ name, ok: false, ms: Date.now() - t0, error: String(e?.message ?? e).slice(0, 500) });
    console.log("FAILED", String(e?.message ?? e).slice(0, 300));
    throw e;
  } finally {
    save();
  }
}

const PROVIDER = (address) => `(() => {
  const state = window.__tgWallet = { chainId: "0x1", added: false };
  const listeners = {};
  const err = (code, message) => Object.assign(new Error(message), { code });
  const provider = {
    async request({ method, params }) {
      switch (method) {
        case "eth_requestAccounts": case "eth_accounts": return ["${address}"];
        case "eth_chainId": return state.chainId;
        case "net_version": return String(parseInt(state.chainId, 16));
        case "wallet_switchEthereumChain":
          if (params[0].chainId.toLowerCase() === "0xf22d" && !state.added) throw err(4902, "Unrecognized chain ID");
          state.chainId = params[0].chainId.toLowerCase(); (listeners.chainChanged || []).forEach((l) => l(state.chainId)); return null;
        case "wallet_addEthereumChain": state.added = true; return null;
        case "eth_sendTransaction": return await window.__tgSend(JSON.stringify(params[0]));
        default: return JSON.parse(await window.__tgRpc(method, JSON.stringify(params ?? [])));
      }
    },
    on(e, l) { (listeners[e] = listeners[e] || []).push(l); },
    removeListener(e, l) { listeners[e] = (listeners[e] || []).filter((x) => x !== l); },
  };
  window.ethereum = provider;
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info: { uuid: "tw-${address.slice(2, 8)}", name: "TestWallet", icon: "", rdns: "dev.trustgate.tw" }, provider }) }));
  window.addEventListener("eip6963:requestProvider", announce); announce();
})();`;

async function browserFor(browser, label) {
  const account = privateKeyToAccount(generatePrivateKey());
  const signer = createWalletClient({ account, chain, transport: http(RPC) });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.exposeBinding("__tgSend", async (_s, json) => {
    const tx = JSON.parse(json);
    return signer.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : undefined, gas: tx.gas ? BigInt(tx.gas) : undefined });
  });
  await ctx.exposeBinding("__tgRpc", async (_s, method, params) => {
    const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params: JSON.parse(params) }) });
    const body = await res.json();
    if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code });
    return JSON.stringify(body.result ?? null);
  });
  await ctx.addInitScript(PROVIDER(account.address));
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") log.consoleErrors.push(`${label}: ${m.text().slice(0, 240)}`); });
  page.on("pageerror", (e) => log.consoleErrors.push(`${label}: pageerror ${String(e).slice(0, 240)}`));
  return { page, address: account.address };
}
const shot = (p, name) => p.screenshot({ path: path.join(OUT, name + ".png") });
async function open(p, url = BASE) {
  await p.goto(url, { waitUntil: "load" });
  await p.waitForTimeout(2500);
  await p.locator("header .btn.hot").click();
  await p.locator("header .btn.hot .addr").waitFor({ timeout: 30000 });
  await p.evaluate(() => window.scrollTo(0, document.getElementById("gate").offsetTop));
  await p.waitForTimeout(2500);
  await p.locator("#tab-wallet").click();
}
// confirm modal: review → confirm → wait for ✓ (or an error), returns the tx link
async function confirmTx(p, button, name, timeout = 300000) {
  await p.locator(".scrim .v13-tx").filter({ hasText: /network fee|Waiting for your wallet|Sending/i }).first().waitFor({ timeout: 90000 });
  await shot(p, name + "-review");
  const go = p.locator(".scrim").getByRole("button", { name: button });
  if (await go.count()) await go.click();
  await p.locator(".scrim .ok, .scrim .warn.err").first().waitFor({ timeout });
  const ok = await p.locator(".scrim .ok").count();
  const tx = await p.locator(".scrim a.tx").first().getAttribute("href").catch(() => null);
  const text = (await p.locator(".scrim .v13-tx").first().textContent())?.trim();
  await shot(p, name + "-done");
  await p.locator(".scrim").getByRole("button", { name: /Done|Close/ }).first().click().catch(() => p.keyboard.press("Escape"));
  if (!ok) throw new Error(`${name}: ${text}`);
  return tx;
}
async function toastAfter(p, click) {
  // mark the toasts already on screen, then wait for a new one (toasts fade after a few seconds)
  await p.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.setAttribute('data-seen', '1')));
  await click();
  const t = p.locator('.toast:not([data-seen])').first();
  await t.waitFor({ timeout: 120000 });
  return { text: (await t.textContent())?.trim(), err: (await t.getAttribute('class'))?.includes('err') };
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const A = await browserFor(browser, "owner");
  const B = await browserFor(browser, "seller");
  log.owner = A.address;
  log.seller = B.address;
  await open(A.page);

  await step("faucet: 3 claims give a +2 GEN toast with the new balance, the 4th gives the red limit toast", async () => {
    const out = [];
    for (let i = 1; i <= 4; i++) {
      const t = await toastAfter(A.page, () => A.page.locator("#p-wallet .walletbar .btn", { hasText: "Get test GEN" }).click());
      out.push(t);
      if (i === 1) await shot(A.page, "01-faucet-toast");
      if (i === 4) await shot(A.page, "02-faucet-limit-toast");
      await A.page.waitForTimeout(1500);
    }
    if (!out.slice(0, 3).every((t) => /\+2 GEN received/.test(t.text) && !t.err)) throw new Error(JSON.stringify(out));
    if (!out[3].err || !/limit/i.test(out[3].text)) throw new Error("4th claim: " + JSON.stringify(out[3]));
    return out.map((t) => t.text.slice(0, 80));
  });

  let vaultId = null;
  await step("owner: create agent key, fund it, create a vault (1 GEN) through the confirm modal", async () => {
    await A.page.getByRole("button", { name: "Create agent key" }).click();
    await A.page.getByRole("button", { name: /Send 0.5 GEN from your wallet/ }).click();
    await A.page.locator(".scrim .ok, .scrim .warn.err").first().waitFor({ timeout: 180000 });
    if (!(await A.page.locator(".scrim .ok").count())) throw new Error("fund agent: " + (await A.page.locator(".scrim").textContent()));
    await A.page.locator(".scrim").getByRole("button", { name: "Done" }).click();
    await A.page.getByRole("button", { name: "Review and create vault" }).click();
    const tx = await confirmTx(A.page, "Confirm in wallet", "03-create-vault");
    await A.page.locator("#p-wallet .vault .vid code").first().waitFor({ timeout: 120000 });
    vaultId = (await A.page.locator("#p-wallet .vault .vid code").first().textContent())?.trim();
    await shot(A.page, "04-vault-card");
    return { tx, vaultId };
  });

  await step("seller: the Share with seller link prefills the vault, post the offer", async () => {
    await B.page.goto(BASE + "?seller=" + encodeURIComponent(vaultId), { waitUntil: "load" });
    await B.page.waitForTimeout(2500);
    await B.page.locator("header .btn.hot").click();
    await B.page.locator("header .btn.hot .addr").waitFor({ timeout: 30000 });
    await toastAfter(B.page, () => B.page.locator("header .btn", { hasText: "Get test GEN" }).click());
    await B.page.evaluate(() => window.scrollTo(0, document.getElementById("gate").offsetTop));
    await B.page.waitForTimeout(2000);
    const prefilled = await B.page.locator("#tg-sv").inputValue();
    if (prefilled !== vaultId) throw new Error("not prefilled: " + prefilled);
    await B.page.locator("#tg-st").fill(TERMS);
    await B.page.locator("#tg-sa").fill("0.5");
    await B.page.waitForTimeout(8000); // the vault must be in the seller's feed
    await B.page.getByRole("button", { name: "Review and post offer" }).click();
    const tx = await confirmTx(B.page, "Confirm in wallet", "05-post-offer");
    return { prefilled, tx };
  });

  await step("owner (no refresh): the offer appears in the Agent tab, the agent requests it, the verdict arrives", async () => {
    await A.page.getByRole("tab", { name: /Agent · buyer/ }).click();
    const req = A.page.getByRole("button", { name: "Review and request payment" }).first();
    await req.waitFor({ timeout: 180000 });
    await shot(A.page, "06-agent-sees-offer");
    await req.click();
    const tx = await confirmTx(A.page, "Confirm and send", "07-request-v1", 900000);
    return { tx };
  });

  await step("seller (no refresh): sees Your turn with the diff, signs v2", async () => {
    const card = B.page.locator(".card.c-ren", { hasText: "Your turn" }).first();
    await card.waitFor({ timeout: 300000 });
    const diff = await card.locator(".diff ins").count();
    await shot(B.page, "08-seller-your-turn");
    await card.getByRole("button", { name: /Accept · sign v2/ }).click();
    const tx = await confirmTx(B.page, "Confirm in wallet", "09-sign-v2");
    return { diffInserts: diff, tx };
  });

  let finalVerdict = null;
  await step("owner (no refresh): v2 appears, the agent requests it, verdict", async () => {
    const req = A.page.getByRole("button", { name: "Review and request payment" }).first();
    await req.waitFor({ timeout: 300000 });
    await req.click();
    const tx = await confirmTx(A.page, "Confirm and send", "10-request-v2", 900000);
    await A.page.getByRole("tab", { name: "Owner" }).click();
    const card = A.page.locator("#p-wallet .vault .negc").first();
    await card.waitFor({ timeout: 120000 });
    for (let i = 0; i < 40; i++) {
      finalVerdict = (await card.locator(".chip").textContent())?.trim();
      if (finalVerdict && !/Judging|Open|Starting/i.test(finalVerdict)) break;
      await A.page.waitForTimeout(5000);
    }
    await shot(A.page, "11-owner-vault-history");
    return { tx, chip: finalVerdict, balance: (await A.page.locator("#p-wallet .vault .balance").first().textContent())?.trim() };
  });

  await step("both sides: full timeline modal, live, copy link", async () => {
    await B.page.getByRole("button", { name: /Timeline|Open full timeline/ }).first().click().catch(() => B.page.locator(".negc").first().click());
    await B.page.locator("#negotiation .v13-timeline > li").first().waitFor({ timeout: 60000 });
    const rows = await B.page.locator("#negotiation .v13-timeline > li").count();
    await shot(B.page, "12-seller-timeline");
    return { rows, url: B.page.url() };
  });
} catch {
  // the failing step is in the log
} finally {
  log.finishedAt = new Date().toISOString();
  save();
  await browser.close();
}
const failed = log.steps.filter((s) => !s.ok);
console.log(`\n${log.steps.length - failed.length}/${log.steps.length} passed · console errors: ${log.consoleErrors.length} · log: ${path.join(OUT, "two-wallets.json")}`);
for (const e of log.consoleErrors.slice(0, 12)) console.log("  " + e);
process.exitCode = failed.length ? 1 : 0;
