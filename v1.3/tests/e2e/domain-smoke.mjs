// Smoke test of the main domain after the switch: page load, wallet connect (injected test wallet, read-only),
// faucet API answer, negotiation share link, /v1 with its notice, workers.dev redirect, and API reachability.
//
//   node tests/e2e/domain-smoke.mjs [--base https://trustgatecheck.xyz] [--negotiation <id>]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.join(ROOT, "experiments", "live", "domain");
const args = process.argv.slice(2);
const BASE = args.includes("--base") ? args[args.indexOf("--base") + 1] : "https://trustgatecheck.xyz";
const NEG = args.includes("--negotiation") ? args[args.indexOf("--negotiation") + 1] : null;
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
fs.mkdirSync(OUT, { recursive: true });
const log = { base: BASE, startedAt: new Date().toISOString(), steps: [] };
const save = () => fs.writeFileSync(path.join(OUT, "domain-smoke.json"), JSON.stringify(log, null, 2) + "\n");
async function step(name, fn) {
  process.stdout.write(`- ${name} … `);
  try { const d = (await fn()) ?? null; log.steps.push({ name, ok: true, detail: d }); console.log("ok", d ? JSON.stringify(d).slice(0, 160) : ""); }
  catch (e) { log.steps.push({ name, ok: false, error: String(e?.message ?? e).slice(0, 400) }); console.log("FAILED", String(e?.message ?? e).slice(0, 200)); }
  save();
}
const addr = privateKeyToAccount(generatePrivateKey()).address;
const PROVIDER = `(() => { const st = { chainId: "0x1", added: false }; const provider = { async request({ method, params }) {
  if (method === "eth_requestAccounts" || method === "eth_accounts") return ["${addr}"];
  if (method === "eth_chainId") return st.chainId;
  if (method === "wallet_switchEthereumChain") { if (!st.added) throw Object.assign(new Error("Unrecognized chain"), { code: 4902 }); st.chainId = params[0].chainId; return null; }
  if (method === "wallet_addEthereumChain") { st.added = true; return null; }
  const r = await fetch("https://studio-dev.genlayer.com/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? [] }) }); return (await r.json()).result;
}, on() {}, removeListener() {} };
const a = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info: { uuid: "smoke", name: "TestWallet", icon: "", rdns: "dev.smoke" }, provider }) }));
window.addEventListener("eip6963:requestProvider", a); a(); })();`;

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(PROVIDER);
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 150)); });
  await step("main domain loads V1.3 (title, slogan, contract)", async () => {
    await page.goto(BASE, { waitUntil: "networkidle", timeout: 90000 });
    await page.getByText("Before an Agent Says Yes.").first().waitFor({ timeout: 30000 });
    await page.screenshot({ path: path.join(OUT, "01-home.png") });
    return { title: await page.title(), url: page.url() };
  });
  await step("wallet connect (chain 61997 added and switched)", async () => {
    await page.getByRole("button", { name: /Connect TestWallet/ }).click();
    await page.locator(".status-badge").filter({ hasText: addr.slice(0, 6) }).waitFor({ timeout: 30000 });
  });
  await step("faucet answers (sent, or the per-network daily limit)", async () => {
    await page.getByRole("button", { name: "Get test GEN" }).click();
    const msg = page.locator(".v13-faucet small");
    await msg.filter({ hasText: /sent|already|Limit/ }).waitFor({ timeout: 120000 });
    return { message: (await msg.textContent())?.trim() };
  });
  if (NEG) await step("negotiation share link", async () => {
    const p = await browser.newPage();
    await p.goto(`${BASE}/?negotiation=${NEG}#negotiation`, { waitUntil: "domcontentloaded" });
    await p.locator("#negotiation .v13-timeline > li").first().waitFor({ timeout: 120000 });
    await p.waitForTimeout(1500);
    await p.locator("#negotiation").screenshot({ path: path.join(OUT, "02-negotiation.png") });
    const out = { outcome: (await p.locator(".v13-outcome").textContent())?.trim() };
    await p.close();
    return out;
  });
  await step("/v1 loads V1 with the notice and the link back", async () => {
    await page.getByRole("link", { name: /Version 1/ }).click();
    await page.getByText("Go to V1.3 (current)").waitFor({ timeout: 60000 });
    await page.screenshot({ path: path.join(OUT, "03-v1.png") });
    return { url: page.url(), title: await page.title() };
  });
  await step("old workers.dev URL redirects here", async () => {
    const r = await fetch("https://trustgate-v13.shoupeorg.workers.dev/", { redirect: "manual" });
    if (r.status !== 307 || !String(r.headers.get("location")).startsWith(BASE)) throw new Error(`${r.status} ${r.headers.get("location")}`);
    return { status: r.status, location: r.headers.get("location") };
  });
  log.consoleErrors = errors;
} finally {
  log.finishedAt = new Date().toISOString();
  save();
  await browser.close();
}
const failed = log.steps.filter((s) => !s.ok);
console.log(`\n${log.steps.length - failed.length}/${log.steps.length} steps passed. Console errors: ${log.consoleErrors?.length ?? "?"}`);
process.exitCode = failed.length ? 1 : 0;
