// Landing smoke test in a real Chrome (Playwright). Covers every API answering JSON, every console tab,
// wallet connect (an injected EIP-6963 test wallet), the faucet with a fresh wallet, a real vault creation,
// a negotiation share link, mobile, reduced motion, /v1, and Try it end to end:
// "Upfront · no refund" → RENEGOTIATE → Seller accepts → ACCEPT → shareable timeline.
//
//   node tests/e2e/landing-smoke.mjs --base https://trustgatecheck.xyz [--out dir] [--skip-try]
//
// The wallet is a fresh throwaway test key made in Node for each run (--wallet e2e uses E2E_OWNER_PRIVATE_KEY
// from .env.local); it signs in Node, never enters the page and is never printed. Chain 61997 test GEN only.
// Try it runs one real negotiation (a few minutes); the vault step creates one real vault (0.5 GEN). Exit code 1 when any step fails.

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
const OUT = path.resolve(arg("--out", path.join(ROOT, "experiments", "e2e", "landing-smoke")));
const SKIP_TRY = args.includes("--skip-try");
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";

fs.mkdirSync(OUT, { recursive: true });
const RPC = "https://studio-dev.genlayer.com/api";
// A fresh throwaway test wallet per run (never printed or saved), so the faucet and vault creation run as
// a new visitor would. --wallet e2e uses E2E_OWNER_PRIVATE_KEY from .env.local instead.
const chain = defineChain({ id: 61997, name: "GenLayer Studio Next", nativeCurrency: { name: "GEN", symbol: "GEN", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const ownerKey = arg("--wallet", "fresh") === "e2e" ? fs.readFileSync(path.join(ROOT, ".env.local"), "utf8").match(/^E2E_OWNER_PRIVATE_KEY=(0x[0-9a-fA-F]{64})/m)[1] : generatePrivateKey();
const owner = privateKeyToAccount(ownerKey);
const signer = createWalletClient({ account: owner, chain, transport: http(RPC) });

const log = { base: BASE, startedAt: new Date().toISOString(), steps: [], consoleErrors: [] };
const save = () => fs.writeFileSync(path.join(OUT, "smoke.json"), JSON.stringify(log, null, 2) + "\n");
async function step(name, fn) {
  const t0 = Date.now();
  process.stdout.write(`- ${name} … `);
  try {
    const detail = (await fn()) ?? null;
    log.steps.push({ name, ok: true, ms: Date.now() - t0, detail });
    console.log("ok", detail ? JSON.stringify(detail).slice(0, 220) : "");
  } catch (e) {
    log.steps.push({ name, ok: false, ms: Date.now() - t0, error: String(e?.message ?? e).slice(0, 400) });
    console.log("FAILED", String(e?.message ?? e).slice(0, 300));
  }
  save();
}
const PROVIDER = (address) => `(() => {
  const state = window.__tgWallet = { chainId: "0x1", added: false, calls: [] };
  const listeners = {};
  const err = (code, message) => Object.assign(new Error(message), { code });
  const provider = {
    async request({ method, params }) {
      state.calls.push(method);
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
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info: { uuid: "smoke-wallet", name: "TestWallet", icon: "", rdns: "dev.trustgate.smoke" }, provider }) }));
  window.addEventListener("eip6963:requestProvider", announce); announce();
})();`;
async function bridge(ctx) {
  await ctx.exposeBinding("__tgSend", async (_s, json) => {
    const tx = JSON.parse(json);
    const hash = await signer.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : undefined, gas: tx.gas ? BigInt(tx.gas) : undefined });
    log.sent = [...(log.sent ?? []), hash];
    return hash;
  });
  await ctx.exposeBinding("__tgRpc", async (_s, method, params) => {
    const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params: JSON.parse(params) }) });
    const body = await res.json();
    if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code });
    return JSON.stringify(body.result ?? null);
  });
}
// Every site API answer the page receives must be JSON (an HTML error page broke Try it once).
log.nonJson = [];
const watch = (page, label) => {
  page.on("response", (r) => {
    if (!r.url().startsWith(BASE + "api/")) return;
    const type = r.headers()["content-type"] ?? "";
    if (!type.includes("json")) log.nonJson.push(`${label}: ${r.request().method()} ${r.url()} → ${r.status()} ${type}`);
  });
  page.on("console", (m) => { if (m.type() === "error") log.consoleErrors.push(`${label}: ${m.text().slice(0, 240)}`); });
  page.on("pageerror", (e) => log.consoleErrors.push(`${label}: pageerror ${String(e).slice(0, 240)}`));
};
const gotoGate = async (page) => { await page.evaluate(() => window.scrollTo(0, document.getElementById("gate").offsetTop)); await page.waitForTimeout(2500); };
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name + ".png") });

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--ignore-gpu-blocklist"] });
try {
  // ---------- APIs answer JSON (each contract's feed, Try it config, faucet)
  await step("site APIs answer JSON", async () => {
    const contracts = ["0x53E6f0eC998d9BfAd1CA3753252EE94b2cd16BF0", "0xdF2FEeED57870803f2707E02F7F568d39ccA8C05", "0x41B6781fEC91DfFb9747CF2D445677F37c66E43b"];
    const urls = ["api/try", "api/test-gen", ...contracts.map((c) => `api/vault-feed?contract=${c}`)];
    const rows = [];
    for (const u of urls) {
      const res = await fetch(BASE + u, { cache: "no-store" });
      const text = await res.text();
      let ok = true;
      try { JSON.parse(text); } catch { ok = false; }
      rows.push(`${u.split("?")[0]}${u.includes("?") ? "@" + u.slice(-6) : ""} ${res.status}${ok ? "" : " NOT JSON: " + text.slice(0, 80)}`);
      if (!ok) throw new Error(rows.join(" | "));
    }
    return rows;
  });

  // ---------- no wallet
  await step("no wallet: Connect wallet shows the install guide", async () => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage(); watch(page, "nowallet");
    await page.goto(BASE, { waitUntil: "load" });
    await page.waitForTimeout(2500);
    await page.locator("header .btn.hot").click();
    await page.getByText("No browser wallet found").first().waitFor({ timeout: 10000 });
    await shot(page, "01-no-wallet");
    await page.locator("header .btn", { hasText: "Get test GEN" }).click();
    await page.locator(".toast", { hasText: "Connect a wallet first" }).first().waitFor({ timeout: 5000 });
    await ctx.close();
  });

  // ---------- main desktop run with the injected test wallet
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await bridge(ctx);
  await ctx.addInitScript(PROVIDER(owner.address));
  const page = await ctx.newPage(); watch(page, "desktop");

  await step("opens at the top, header decodes, gate scene draws", async () => {
    await page.goto(BASE + "#gate", { waitUntil: "load" });
    await page.waitForTimeout(9000);
    const r = await page.evaluate(() => ({ y: scrollY, hash: location.hash, brand: document.getElementById("bname").textContent, pct: document.getElementById("bpct").textContent, armed: document.querySelector(".tg").classList.contains("armed"), canvas: document.getElementById("scene").width }));
    await shot(page, "02-hero");
    if (r.y !== 0 || r.hash) throw new Error("did not open at the top: " + JSON.stringify(r));
    if (r.brand !== "TRUSTGATE" || r.pct !== "V1.3" || !r.armed) throw new Error(JSON.stringify(r));
    return r;
  });

  await step("sound button: first click keeps sound on, second click mutes, third unmutes", async () => {
    const b = page.locator("#snd");
    await b.click(); const a1 = await b.getAttribute("aria-pressed");
    await page.waitForTimeout(1000);
    await b.click(); const a2 = await b.getAttribute("aria-pressed");
    await b.click(); const a3 = await b.getAttribute("aria-pressed");
    if (a1 !== "true" || a2 !== "false" || a3 !== "true") throw new Error([a1, a2, a3].join(","));
    return { first: a1, second: a2, third: a3 };
  });

  await step("header dissolves on scroll and comes back at the top", async () => {
    await page.evaluate(() => window.scrollTo(0, 60)); await page.waitForTimeout(1200);
    const mouse = await page.evaluate(() => document.querySelector(".mouse").style.visibility);
    await page.evaluate(() => window.scrollTo(0, innerHeight)); await page.waitForTimeout(1500);
    const gone = await page.evaluate(() => [...document.querySelectorAll("header [data-dust]")].map((e) => e.style.visibility));
    await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(1500);
    const back = await page.evaluate(() => [...document.querySelectorAll("header [data-dust]")].map((e) => e.style.visibility));
    if (mouse !== "hidden" || gone.some((v) => v !== "hidden") || back.some((v) => v === "hidden")) throw new Error(JSON.stringify({ mouse, gone, back }));
    return { mouse, gone: gone.length, back };
  });

  await step("connect wallet (EIP-6963, adds and switches to chain 61997)", async () => {
    await page.locator("header .btn.hot").click();
    await page.locator("header .btn.hot", { hasText: owner.address.slice(0, 6) }).waitFor({ timeout: 30000 });
    await page.waitForTimeout(3000);
    const w = await page.evaluate(() => ({ chainId: window.__tgWallet.chainId, added: window.__tgWallet.added, label: document.querySelector("header .btn.hot").textContent }));
    await shot(page, "03-connected");
    if (w.chainId !== "0xf22d") throw new Error(JSON.stringify(w));
    return w;
  });

  await step("Get test GEN (faucet toast with the new balance)", async () => {
    await page.locator("header .btn", { hasText: "Get test GEN" }).click();
    const t = page.locator(".toast").filter({ hasText: /GEN received|limit|No test GEN/i }).first();
    await t.waitFor({ timeout: 120000 });
    await shot(page, "04-faucet-toast");
    const text = (await t.textContent())?.trim();
    const tx = await t.locator("a.tx").getAttribute("href").catch(() => null);
    const fresh = arg("--wallet", "fresh") === "fresh";
    // A fresh wallet always gets test GEN unless the whole site used up today's budget; then the refusal is
    // the expected answer and the wallet gets 1 GEN from the local E2E wallet for the vault step.
    if (fresh && /come back tomorrow|resets at 00:00 UTC/i.test(text ?? "")) {
      const e2e = privateKeyToAccount(fs.readFileSync(path.join(ROOT, ".env.local"), "utf8").match(/^E2E_OWNER_PRIVATE_KEY=(0x[0-9a-fA-F]{64})/m)[1]);
      const hash = await createWalletClient({ account: e2e, chain, transport: http(RPC) }).sendTransaction({ to: owner.address, value: 10n ** 18n });
      await page.locator("header .btn.hot").filter({ hasText: /[1-9][0-9.]* GEN/ }).waitFor({ timeout: 90000 });
      return { toast: text, faucet: "refused: site-wide daily budget used up", fundedFromE2E: hash };
    }
    if (fresh && !/GEN received/.test(text ?? "")) throw new Error("fresh wallet got: " + text);
    await page.locator("header .btn.hot").filter({ hasText: /[1-9][0-9.]* GEN/ }).waitFor({ timeout: 90000 });
    return { toast: text, tx, header: (await page.locator("header .btn.hot").textContent())?.trim() };
  });

  await gotoGate(page);
  await step("console: Try it tab default, presets and counter", async () => {
    await page.locator("#try-it .v13-mandate").waitFor({ timeout: 45000 });
    await page.locator(".preset", { hasText: /Escrow controlled by the seller/ }).click();
    const count = await page.locator("#try-it .count").first().textContent();
    await shot(page, "05-try-it");
    return { count };
  });

  await step("Your wallet · Owner: agent key, confirm modal, create a vault (0.5 GEN), vault card", async () => {
    await page.locator("#tab-wallet").click();
    await page.waitForTimeout(1500);
    const create = page.getByRole("button", { name: "Create agent key" });
    if (await create.count()) await create.click();
    await page.getByText("back up or remove this key").first().waitFor({ timeout: 5000 });
    await page.locator("#tg-dep").fill("0.5");
    await page.waitForTimeout(500);
    const btn = page.getByRole("button", { name: "Review and create vault" });
    await shot(page, "06-owner");
    if (await btn.isDisabled()) throw new Error("create vault blocked: " + (await page.locator("#p-wallet .box .warn.err").first().textContent().catch(() => "?")));
    await btn.click();
    const modal = page.locator(".scrim .v13-tx");
    await modal.filter({ hasText: /network fee/i }).waitFor({ timeout: 60000 });
    await shot(page, "07-confirm-modal");
    await page.locator(".scrim").getByRole("button", { name: "Confirm in wallet" }).click();
    await page.locator(".scrim .ok, .scrim .warn.err").first().waitFor({ timeout: 240000 });
    const status = (await page.locator(".scrim .v13-tx").first().textContent())?.trim();
    const tx = await page.locator(".scrim a.tx").first().getAttribute("href").catch(() => null);
    await shot(page, "07a-confirm-done");
    if (!(await page.locator(".scrim .ok").count())) throw new Error("vault creation: " + status);
    await page.locator(".scrim").getByRole("button", { name: "Done" }).click();
    // the new vault shows up under Your vaults once the feed has it
    await page.locator("#p-wallet .vault .vid code").first().waitFor({ timeout: 120000 });
    const vault = (await page.locator("#p-wallet .vault .vid code").first().textContent())?.trim();
    await shot(page, "07b-vault-card");
    return { tx, vault };
  });

  await step("Your wallet · Agent and Seller tabs", async () => {
    await page.getByRole("tab", { name: /Agent · buyer/ }).click();
    await page.getByText("Act as the agent").waitFor({ timeout: 5000 });
    await shot(page, "08-agent");
    await page.getByRole("tab", { name: /^Seller/ }).click();
    await page.getByText("Post an offer").waitFor({ timeout: 5000 });
    await page.getByText("Your offers").first().waitFor();
    await shot(page, "09-seller");
  });

  await step("MCP tile opens a modal with the real tools (4 buyer, 6 seller)", async () => {
    await page.locator(".ltile", { hasText: "MCP for agents" }).click();
    await page.getByText("Buyer side · 4 tools").waitFor({ timeout: 5000 });
    await page.getByText("Seller side · 6 tools").waitFor({ timeout: 5000 });
    await shot(page, "10-mcp-modal");
    await page.keyboard.press("Escape");
  });

  let negUrl = null;
  await step("Live feed tile: real vaults, negotiation cards, full timeline modal", async () => {
    await page.locator(".ltile", { hasText: "Live feed" }).click();
    await page.locator(".scrim .stats").waitFor({ timeout: 90000 });
    const head = await page.locator(".scrim .feedhead").textContent();
    const vaultTabs = await page.locator('.scrim [aria-label="Vault"] .tab').count();
    await shot(page, "11-feed-modal");
    // The vault created above may be selected and have no negotiations yet: pick a vault that has some.
    const neg = page.locator(".scrim .negc").first();
    for (let i = 0; i < vaultTabs && !(await neg.count()); i++) {
      await page.locator('.scrim [aria-label="Vault"] .tab').nth(i).click();
      await page.waitForTimeout(600);
    }
    await neg.waitFor({ timeout: 30000 });
    await neg.click();
    await page.locator("#negotiation .v13-timeline").waitFor({ timeout: 30000 });
    negUrl = page.url();
    await page.waitForTimeout(800);
    await shot(page, "12-timeline-modal");
    await page.keyboard.press("Escape");
    return { head: head?.trim(), vaultTabs, negUrl };
  });

  await step("Benchmark tile: all tables with per-case links", async () => {
    await page.locator(".ltile", { hasText: "Benchmark" }).click();
    const links = await page.locator(".scrim a", { hasText: "per-case results and transactions" }).count();
    const cells = await page.locator(".scrim td.good, .scrim td.bad").allTextContents();
    await shot(page, "13-benchmark-modal");
    await page.keyboard.press("Escape");
    if (links < 5) throw new Error("links " + links);
    return { links, unsafeCells: cells.join(" ") };
  });
  await ctx.close();

  await step("negotiation share link opens the view, page stays at the top", async () => {
    if (!negUrl) throw new Error("no negotiation url from the feed");
    const c = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await c.newPage(); watch(p, "share");
    await p.goto(negUrl + "#negotiation", { waitUntil: "load" });
    await p.locator("#negotiation .v13-timeline").waitFor({ timeout: 90000 });
    const r = await p.evaluate(() => ({ y: scrollY, search: location.search, steps: document.querySelectorAll("#negotiation .v13-timeline > li").length }));
    await p.waitForTimeout(1500);
    await shot(p, "14-share-link");
    await c.close();
    if (r.y !== 0) throw new Error(JSON.stringify(r));
    return r;
  });

  await step("mobile 390 px: no horizontal scroll, every section", async () => {
    const c = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const p = await c.newPage(); watch(p, "mobile");
    await p.goto(BASE, { waitUntil: "load" });
    await p.waitForTimeout(8000);
    await shot(p, "15-mobile-hero");
    const widths = [];
    const n = await p.evaluate(() => document.querySelectorAll("main section").length);
    for (let i = 0; i < n; i++) {
      await p.evaluate((i) => window.scrollTo(0, document.querySelectorAll("main section")[i].offsetTop), i);
      await p.waitForTimeout(2200);
      widths.push(await p.evaluate(() => document.documentElement.scrollWidth));
      if (i === 2) await shot(p, "16-mobile-panel");
    }
    await shot(p, "17-mobile-console");
    await p.locator("#tab-wallet").click();
    await p.waitForTimeout(800);
    widths.push(await p.evaluate(() => document.documentElement.scrollWidth));
    await shot(p, "18-mobile-wallet");
    for (const t of ["Live feed", "Benchmark", "MCP for agents"]) {
      await p.locator(".ltile", { hasText: t }).click();
      await p.waitForTimeout(t === "Live feed" ? 6000 : 800);
      // the modal scrolls inside itself; the page never scrolls sideways
      const m = await p.evaluate(() => { const el = document.querySelector(".hud.modal"); return el ? [el.scrollWidth, el.clientWidth] : [0, 0]; });
      widths.push(await p.evaluate(() => document.documentElement.scrollWidth));
      if (m[0] > m[1] + 1) widths.push(999);
      if (t === "Live feed") await shot(p, "18b-mobile-feed-modal");
      await p.keyboard.press("Escape");
      await p.waitForTimeout(300);
    }
    await c.close();
    if (widths.some((w) => w > 390)) throw new Error("scrollWidth " + widths.join(","));
    return { widths };
  });

  await step("prefers-reduced-motion: panels open without animation, no errors", async () => {
    const c = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
    const p = await c.newPage(); watch(p, "reduced");
    await p.goto(BASE, { waitUntil: "load" });
    await p.waitForTimeout(4000);
    await p.evaluate(() => window.scrollTo(0, document.querySelectorAll("main section")[1].offsetTop));
    await p.waitForTimeout(1500);
    const h2 = await p.locator("main section:nth-of-type(2) h2").textContent();
    await shot(p, "19-reduced-motion");
    await c.close();
    if (h2 !== "How it works") throw new Error(h2);
    return { h2 };
  });

  await step("/v1 still works", async () => {
    const c = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const p = await c.newPage(); watch(p, "v1");
    const res = await p.goto(BASE.replace(/\/$/, "") + "/v1", { waitUntil: "load" });
    await p.getByText("This is TrustGate Version 1").waitFor({ timeout: 20000 });
    await p.waitForTimeout(2000);
    await shot(p, "20-v1");
    await c.close();
    return { status: res.status() };
  });

  // ---------- Try it end to end: RENEGOTIATE → Seller accepts → ACCEPT → shareable timeline
  if (SKIP_TRY) log.steps.push({ name: "Try it end to end", ok: true, skipped: "--skip-try" });
  else await step('Try it end to end: "Upfront · no refund" → RENEGOTIATE → Seller accepts → ACCEPT → timeline', async () => {
    const c = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await c.newPage(); watch(p, "try-it");
    await p.goto(BASE, { waitUntil: "load" });
    const box = p.locator("#try-it");
    await box.locator(".v13-mandate").waitFor({ timeout: 90000 });
    await box.locator(".preset", { hasText: /Upfront/ }).click();
    await box.getByRole("button", { name: /Start the negotiation/ }).click();
    // Fails fast on any error the page shows in the card (for example an API that answered with an error page).
    async function verdict(round) {
      const card = box.locator('[data-round="' + round + '"][data-verdict]');
      const t0 = Date.now();
      let sawProgress = false;
      while (Date.now() - t0 < 20 * 60000) {
        if (await card.count()) return { verdict: await card.getAttribute("data-verdict"), tx: await card.locator("a.link").getAttribute("href").catch(() => null), sawProgress };
        if (await box.locator(".card.c-prog .steps").count()) sawProgress = true;
        const err = await box.locator(".card .err-text").first().textContent().catch(() => null);
        if (err) throw new Error("Try it shows an error: " + err.trim());
        await p.waitForTimeout(3000);
      }
      throw new Error("no verdict on v" + round + " within 20 minutes");
    }
    // the progress card shows up at once, with its 4 steps and the elapsed timer
    await box.locator(".card.c-prog .steps").waitFor({ timeout: 15000 });
    await shot(p, "21a-try-it-progress");
    const v1 = await verdict(1);
    await shot(p, "21-try-it-v1");
    // my negotiations: the card with the live mini timeline is there
    const mineCards = await box.locator(".mine .negc").count();
    if (v1.verdict !== "RENEGOTIATE") throw new Error("expected RENEGOTIATE on v1, got " + v1.verdict + " (" + v1.tx + ")");
    await box.getByRole("button", { name: /Seller accepts/ }).click();
    const v2 = await verdict(2);
    await box.screenshot({ path: path.join(OUT, "22-try-it-negotiation.png") });
    if (v2.verdict !== "ACCEPT") throw new Error("expected ACCEPT on v2, got " + v2.verdict + " (" + v2.tx + ")");
    await box.locator('[data-round="2"]').getByRole("button", { name: /Open the full negotiation timeline/ }).click();
    await p.locator("#negotiation .v13-timeline").waitFor({ timeout: 120000 });
    // The last step can take a feed refresh to appear; the view says so and keeps polling.
    const waitingShown = await p.getByText("Waiting for the final verdict").count();
    let steps = 0;
    for (let i = 0; i < 40 && steps < 4; i++) {
      steps = await p.locator("#negotiation .v13-timeline > li").count();
      if (steps < 4) await p.waitForTimeout(5000);
    }
    await p.waitForTimeout(1000);
    await shot(p, "23-try-it-timeline");
    const url = p.url();
    await c.close();
    if (steps < 4) throw new Error(`timeline has ${steps} steps`);
    return { v1, v2, url, steps, mineCards, waitingShownWhileIndexing: waitingShown > 0 };
  });

  await step("every site API answer was JSON", async () => {
    if (log.nonJson.length) throw new Error(log.nonJson.slice(0, 5).join(" | "));
    return { checked: "all /api/ responses seen by the pages" };
  });
} finally {
  log.finishedAt = new Date().toISOString();
  save();
  await browser.close();
}
const failed = log.steps.filter((s) => !s.ok);
console.log(`\n${log.steps.length - failed.length}/${log.steps.length} passed · console errors: ${log.consoleErrors.length} · log: ${path.join(OUT, "smoke.json")}`);
for (const e of log.consoleErrors.slice(0, 15)) console.log("  " + e);
process.exitCode = failed.length ? 1 : 0;
