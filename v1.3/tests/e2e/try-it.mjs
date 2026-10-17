// E2E test of the wallet-free two-sided "Try it" (real Chrome via Playwright, no wallet injected):
// demo seller signs the visitor's offer → demo agent requests it → GenLayer verdict → on RENEGOTIATE the
// visitor clicks "Seller accepts" → the demo seller signs v2 → verdict again → negotiation timeline.
//
//   npx next start -p 3100
//   node tests/e2e/try-it.mjs [--base http://localhost:3100] [--preset "Escrow controlled"]
//
// Writes experiments/e2e/try-it.json and screenshots.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.join(ROOT, "experiments", "e2e");
const args = process.argv.slice(2);
const BASE = args.includes("--base") ? args[args.indexOf("--base") + 1] : "http://localhost:3100";
const PRESET = args.includes("--preset") ? args[args.indexOf("--preset") + 1] : "Escrow controlled by the seller";
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
fs.mkdirSync(OUT, { recursive: true });

const log = { base: BASE, preset: PRESET, startedAt: new Date().toISOString(), steps: [] };
const save = () => fs.writeFileSync(path.join(OUT, "try-it.json"), JSON.stringify(log, null, 2) + "\n");
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
const verdictOf = async (li) => (await li.locator(".v13-verdict").textContent())?.trim();

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  page.on("pageerror", (e) => (log.pageErrors = [...(log.pageErrors ?? []), String(e).slice(0, 300)]));
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  const box = page.locator("#try-it");
  const start = box.getByRole("button", { name: /Start the negotiation/ });

  await step("Try it loads the demo vault (mandate, cap, funds)", async () => {
    await box.locator(".v13-mandate").waitFor({ timeout: 45000 });
    return { mandate: (await box.locator(".v13-mandate").textContent())?.slice(0, 160) };
  });
  await step("over-long offer is refused visibly, nothing cut", async () => {
    await box.locator("textarea").fill("x".repeat(2050));
    await box.getByText("characters over the limit").waitFor({ timeout: 5000 });
    if (await start.isEnabled()) throw new Error("start enabled for 2050 chars");
  });

  const first = await step(`example "${PRESET}": demo seller signs v1, demo agent requests it, GenLayer verdict`, async () => {
    await box.getByRole("button", { name: new RegExp(PRESET) }).click();
    await start.click();
    await box.getByText("Demo seller signed offer v1").waitFor({ timeout: 120000 });
    const req = box.locator(".v13-timeline > li").nth(1);
    await req.waitFor({ timeout: 300000 });
    for (let i = 0; i < 180; i++) {
      const v = await verdictOf(req);
      if (v && v !== "JUDGING") return { verdict: v, tx: await req.locator("footer a").getAttribute("href") };
      await page.waitForTimeout(5000);
    }
    throw new Error("no verdict within 15 minutes");
  });
  await page.screenshot({ path: path.join(OUT, "try-it-v1.png"), fullPage: false });

  if (first?.verdict === "RENEGOTIATE") {
    await step("RENEGOTIATE: visitor clicks Seller accepts; demo seller signs v2; verdict on v2", async () => {
      await box.getByRole("button", { name: /Seller accepts/ }).click();
      await box.getByText("Demo seller signed TrustGate's counterproposal as v2").waitFor({ timeout: 180000 });
      const req = box.locator(".v13-timeline > li").nth(3);
      await req.waitFor({ timeout: 300000 });
      for (let i = 0; i < 180; i++) {
        const v = await verdictOf(req);
        if (v && v !== "JUDGING") return { verdict: v, tx: await req.locator("footer a").getAttribute("href") };
        await page.waitForTimeout(5000);
      }
      throw new Error("no verdict on v2 within 15 minutes");
    });
  } else {
    log.steps.push({ name: "seller-accepts round", ok: true, skipped: `first verdict was ${first?.verdict ?? "none"}` });
    save();
  }
  await box.screenshot({ path: path.join(OUT, "try-it-negotiation.png") });

  await step("open the negotiation timeline (shareable link) from Try it", async () => {
    await box.getByRole("button", { name: /Open the full negotiation timeline/ }).click();
    const sec = page.locator("#negotiation");
    await sec.locator(".v13-timeline").waitFor({ timeout: 120000 });
    await page.waitForTimeout(1500);
    await sec.screenshot({ path: path.join(OUT, "negotiation-view.png") });
    return { url: page.url(), steps: await sec.locator(".v13-timeline > li").count() };
  });
} finally {
  log.finishedAt = new Date().toISOString();
  save();
  await browser.close();
}
const failed = log.steps.filter((s) => !s.ok);
console.log(`\n${log.steps.length - failed.length}/${log.steps.length} steps passed. Log: experiments/e2e/try-it.json`);
process.exitCode = failed.length ? 1 : 0;
