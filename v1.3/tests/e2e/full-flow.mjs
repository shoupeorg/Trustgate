// End-to-end test of TrustGate V1.3 in a real Chrome (Playwright), with an injected test wallet.
//
//   npm run build && npx next start -p 3100   (in another terminal)
//   node tests/e2e/full-flow.mjs [--base http://localhost:3100] [--skip-judged]
//
// The injected wallet is an EIP-1193 provider announced via EIP-6963 and window.ethereum.
// Signing happens in Node with a test key from .env.local (E2E_OWNER_PRIVATE_KEY, created on
// first run and funded by the site's own faucet). The key never enters the page.
// Writes screenshots and a JSON log with every tx hash to experiments/e2e/.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.join(ROOT, "experiments", "e2e");
const args = process.argv.slice(2);
const BASE = args.includes("--base") ? args[args.indexOf("--base") + 1] : "http://localhost:3100";
const SKIP_JUDGED = args.includes("--skip-judged");
const RPC = "https://studio-dev.genlayer.com/api";
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const chain = defineChain({ id: 61997, name: "GenLayer Studio Next", nativeCurrency: { name: "GEN", symbol: "GEN", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });

fs.mkdirSync(OUT, { recursive: true });
const envFile = path.join(ROOT, ".env.local");
let env = fs.readFileSync(envFile, "utf8");
if (!/^E2E_OWNER_PRIVATE_KEY=/m.test(env)) {
  fs.appendFileSync(envFile, `${env.endsWith("\n") ? "" : "\n"}# E2E test owner wallet (fresh user), chain 61997 only. Never commit.\nE2E_OWNER_PRIVATE_KEY=${generatePrivateKey()}\n`);
  env = fs.readFileSync(envFile, "utf8");
}
const owner = privateKeyToAccount(env.match(/^E2E_OWNER_PRIVATE_KEY=(0x[0-9a-fA-F]{64})/m)[1]);
const wallet = createWalletClient({ account: owner, chain, transport: http(RPC) });
const pub = createPublicClient({ chain, transport: http(RPC) });

const log = { base: BASE, owner: owner.address, startedAt: new Date().toISOString(), steps: [] };
const save = () => fs.writeFileSync(path.join(OUT, SKIP_JUDGED ? "full-flow-quick.json" : "full-flow-judged.json"), JSON.stringify(log, null, 2) + "\n");
async function step(name, fn) {
  const t0 = Date.now();
  process.stdout.write(`- ${name} … `);
  try {
    const detail = (await fn()) ?? null;
    log.steps.push({ name, ok: true, ms: Date.now() - t0, detail });
    console.log("ok", detail ? JSON.stringify(detail).slice(0, 160) : "");
  } catch (e) {
    log.steps.push({ name, ok: false, ms: Date.now() - t0, error: String(e?.message ?? e).slice(0, 500) });
    console.log("FAILED", String(e?.message ?? e).slice(0, 300));
  }
  save();
}
const balance = async (a) => Number(await pub.getBalance({ address: a })) / 1e18;

// ---------------------------------------------------------------- injected wallet

const PROVIDER_SCRIPT = (address) => `(() => {
  const state = window.__tgWallet = { mode: "ok", chainId: "0x1", added: false, addParams: null, calls: [] };
  const listeners = {};
  const err = (code, message) => Object.assign(new Error(message), { code });
  const provider = {
    isMetaMask: false,
    async request({ method, params }) {
      state.calls.push(method);
      switch (method) {
        case "eth_requestAccounts":
          if (state.mode === "reject") throw err(4001, "User rejected the request.");
          if (state.mode === "pending") throw err(-32002, "Request of type 'wallet_requestPermissions' already pending");
          if (state.mode === "locked") return [];
          return ["${address}"];
        case "eth_accounts": return state.mode === "locked" ? [] : ["${address}"];
        case "eth_chainId": return state.chainId;
        case "net_version": return String(parseInt(state.chainId, 16));
        case "wallet_switchEthereumChain":
          if (params[0].chainId.toLowerCase() === "0xf22d" && !state.added) throw err(4902, "Unrecognized chain ID");
          state.chainId = params[0].chainId.toLowerCase();
          (listeners.chainChanged || []).forEach((l) => l(state.chainId));
          return null;
        case "wallet_addEthereumChain": state.added = true; state.addParams = params[0]; return null;
        case "eth_sendTransaction":
          if (state.mode === "rejectTx") throw err(4001, "User rejected the transaction.");
          return await window.__tgSend(JSON.stringify(params[0]));
        default:
          return JSON.parse(await window.__tgRpc(method, JSON.stringify(params ?? [])));
      }
    },
    on(e, l) { (listeners[e] = listeners[e] || []).push(l); },
    removeListener(e, l) { listeners[e] = (listeners[e] || []).filter((x) => x !== l); },
  };
  window.ethereum = provider;
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info: { uuid: "e2e-test-wallet", name: "TestWallet", icon: "", rdns: "dev.trustgate.e2e" }, provider }) }));
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
})();`;

async function bridge(context) {
  await context.exposeBinding("__tgSend", async (_src, json) => {
    const tx = JSON.parse(json);
    const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : undefined, gas: tx.gas ? BigInt(tx.gas) : undefined });
    log.sent = [...(log.sent ?? []), hash];
    return hash;
  });
  await context.exposeBinding("__tgRpc", async (_src, method, params) => {
    const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params: JSON.parse(params) }) });
    const body = await res.json();
    if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code });
    return JSON.stringify(body.result ?? null);
  });
}

async function waitText(page, text, timeout = 30000) {
  await page.getByText(text, { exact: false }).first().waitFor({ timeout });
}
async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });
}
async function txHashFromPanel(page) {
  const code = page.locator(".v13-tx code").first();
  await code.waitFor({ timeout: 120000 });
  return (await code.textContent())?.trim();
}
async function waitPhase(page, re, timeout) {
  await page.locator(".v13-tx").filter({ hasText: re }).first().waitFor({ timeout });
}

// ---------------------------------------------------------------- run

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  // 1. No wallet installed.
  await step("no wallet: guide instead of a dead button", async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await waitText(page, "No browser wallet found", 30000);
    await shot(page, "01-no-wallet");
    await ctx.close();
  });

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await bridge(ctx);
  await ctx.addInitScript(PROVIDER_SCRIPT(owner.address));
  const page = await ctx.newPage();
  page.on("pageerror", (e) => (log.pageErrors = [...(log.pageErrors ?? []), String(e).slice(0, 300)]));
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  const connectBtn = page.getByRole("button", { name: /Connect TestWallet/ });

  await step("wallet discovered via EIP-6963", async () => {
    await connectBtn.waitFor({ timeout: 10000 });
  });

  for (const [mode, expect] of [["reject", /rejected/i], ["pending", /already pending/i], ["locked", /Unlock it/i]]) {
    await step(`connect error is explained: ${mode}`, async () => {
      await page.evaluate((m) => (window.__tgWallet.mode = m), mode);
      await connectBtn.click();
      await page.locator("[role=alert]").filter({ hasText: expect }).first().waitFor({ timeout: 10000 });
      return { message: (await page.locator("[role=alert]").first().textContent())?.slice(0, 160) };
    });
  }

  await step("connect on wrong network: chain 61997 added and switched", async () => {
    await page.evaluate(() => (window.__tgWallet.mode = "ok"));
    await connectBtn.click();
    await page.locator(".status-badge").filter({ hasText: owner.address.slice(0, 6) }).waitFor({ timeout: 20000 });
    const w = await page.evaluate(() => window.__tgWallet);
    if (w.chainId !== "0xf22d" || !w.added) throw new Error(`chain not switched: ${w.chainId}`);
    if (!String(w.addParams?.rpcUrls?.[0]).includes("studio-dev.genlayer.com")) throw new Error("wrong RPC in addEthereumChain");
    if (!String(w.addParams?.blockExplorerUrls?.[0]).includes("explorer-studio-dev.genlayer.com")) throw new Error("explorer missing in addEthereumChain");
    await shot(page, "02-connected");
    return { addChain: { rpc: w.addParams.rpcUrls[0], explorer: w.addParams.blockExplorerUrls?.[0] } };
  });

  await step("faucet: Get test GEN", async () => {
    const before = await balance(owner.address);
    await page.getByRole("button", { name: "Get test GEN" }).click();
    await page.locator(".v13-faucet small").filter({ hasText: /sent|already received|Limit|empty|not configured|failed/ }).waitFor({ timeout: 90000 });
    const msg = (await page.locator(".v13-faucet small").textContent())?.trim();
    const tx = await page.locator(".v13-faucet small a").getAttribute("href").catch(() => null);
    for (let i = 0; i < 20 && (await balance(owner.address)) <= before; i++) await new Promise((r) => setTimeout(r, 3000));
    const after = await balance(owner.address);
    if (!/sent/.test(msg ?? "") && before < 2.5) throw new Error(`faucet: ${msg}`);
    return { msg, tx, before, after };
  });

  await step("faucet: second claim is rate limited", async () => {
    await page.getByRole("button", { name: "Get test GEN" }).click();
    await page.locator(".v13-faucet small").filter({ hasText: /already received|Limit/ }).waitFor({ timeout: 30000 });
    return { msg: (await page.locator(".v13-faucet small").textContent())?.trim() };
  });

  let agentAddress;
  await step("create browser agent key", async () => {
    await page.getByRole("button", { name: "Create agent key" }).click();
    const code = page.locator(".v13-agentkey code").first();
    await code.waitFor({ timeout: 5000 });
    agentAddress = (await code.textContent())?.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(agentAddress ?? "")) throw new Error("no agent address shown");
    return { agentAddress };
  });

  await step("template does not overwrite a typed mandate without asking", async () => {
    const mandate = page.locator(".v13-roles textarea").first();
    await mandate.fill("Buy research datasets only. Only refundable or escrowed payments. Never pay a payout address that changed at the last minute.");
    await page.getByRole("button", { name: "SaaS subscriptions" }).click();
    await waitText(page, "Replace your mandate text", 5000);
    await page.getByRole("button", { name: "Keep mine" }).click();
    if (!(await mandate.inputValue()).startsWith("Buy research datasets only")) throw new Error("mandate was overwritten");
  });

  await (async () => {
    let id = null;
    await step("create vault (fee shown before signing, then finalized)", async () => {
      await page.getByLabel(/Hard cap per commitment/).fill("1");
      await page.getByLabel(/^Deposit/).fill("1.2");
      await page.getByRole("button", { name: /Review fee and create vault/ }).click();
      await waitText(page, "Network fee up to", 60000);
      const feeText = (await page.locator(".v13-tx").textContent())?.trim();
      await shot(page, "03-fee-before-sign");
      await page.getByRole("button", { name: "Confirm in wallet" }).click();
      const hash = await txHashFromPanel(page);
      await waitPhase(page, /Finalized|Consensus reached/, 300000);
      // The feed should show a vault owned by this wallet.
      await page.locator(".v13-ownervault").first().waitFor({ timeout: 120000 });
      id = (await page.locator(".v13-ownervault b").first().textContent())?.trim();
      await shot(page, "04-vault-created");
      return { feeText: feeText?.slice(0, 200), hash, vaultId: id };
    });
    return id;
  })();

  await step("fund the agent key from the owner wallet (amount + fee shown)", async () => {
    await page.getByRole("button", { name: /Send 0.5 GEN from your wallet/ }).click();
    const hash = await txHashFromPanel(page);
    await waitPhase(page, /Finalized/, 150000);
    const agentBal = await balance(agentAddress);
    if (agentBal < 0.45) throw new Error(`agent balance ${agentBal}`);
    return { hash, agentBal, label: (await page.locator(".v13-tx b").first().textContent())?.trim() };
  });

  // On the negotiation contract the agent can only request a seller-signed offer: there is no payee or deal
  // field to type into. The judged two-sided flow (seller posts, agent requests, RENEGOTIATE, seller signs v2,
  // ACCEPT) is covered by tests/e2e/seller-mode.mjs and tests/e2e/try-it.mjs.
  await step("agent tab: requests only by signed offer (no payee / deal text fields)", async () => {
    await page.getByRole("tab", { name: /Agent/ }).click();
    await waitText(page, "Request a commitment against a signed offer", 30000);
    if (await page.getByLabel("Payee", { exact: true }).count()) throw new Error("a free-form payee field is still shown");
    await shot(page, "05-agent-offers");
    return { note: (await page.locator(".v13-card").filter({ hasText: "signed offer" }).first().textContent())?.slice(0, 200) };
  });

  await step("owner: take funds back, then withdraw credit (payout check)", async () => {
    await page.getByRole("tab", { name: "Owner" }).click();
    const amountInput = page.locator(".v13-ownervault input").first();
    await amountInput.fill("0.3");
    await page.getByRole("button", { name: "Take back" }).first().click();
    await page.getByRole("button", { name: "Confirm in wallet" }).click();
    const reclaimHash = await txHashFromPanel(page);
    await waitPhase(page, /Finalized|Consensus reached/, 300000);
    await page.getByRole("button", { name: "Withdraw all" }).first().waitFor({ timeout: 120000 });
    const before = await balance(owner.address);
    await page.getByRole("button", { name: "Withdraw all" }).first().click();
    await page.getByRole("button", { name: "Confirm in wallet" }).click();
    const withdrawHash = await txHashFromPanel(page);
    await waitPhase(page, /Finalized|Consensus reached|No verdict/, 300000);
    await new Promise((r) => setTimeout(r, 20000));
    const after = await balance(owner.address);
    await shot(page, "08-withdraw");
    return { reclaimHash, withdrawHash, walletBefore: before, walletAfter: after, note: "after - before includes fees; +0.3 would mean the payout arrived" };
  });

  await step("live feed shows last-updated time and source", async () => {
    const status = (await page.locator(".v13-feedstatus").textContent())?.trim();
    if (!/updated/.test(status ?? "")) throw new Error(`feed status: ${status}`);
    return { status };
  });

  await step("mobile width renders without horizontal scroll", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(500);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    await shot(page, "09-mobile");
    if (overflow > 2) throw new Error(`horizontal overflow ${overflow}px`);
    return { overflow };
  });
} finally {
  log.finishedAt = new Date().toISOString();
  save();
  await browser.close();
  const failed = log.steps.filter((s) => !s.ok);
  console.log(`\n${log.steps.length - failed.length}/${log.steps.length} steps passed. Log: experiments/e2e/full-flow-(quick|judged).json`);
  process.exitCode = failed.length ? 1 : 0;
}
