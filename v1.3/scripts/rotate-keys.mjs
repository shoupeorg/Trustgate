// Rotates every wallet key in .env.local: generates a new key, moves the old wallet's GEN (minus a fee
// reserve) to the new wallet, and rewrites .env.local. Keys are never printed. Removes GEMINI_API_KEY.
// The old .env.local is kept as .env.local.pre-rotation (gitignored) until the transfers are verified.
//
//   node scripts/rotate-keys.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV = path.join(ROOT, ".env.local");
const OUT = path.join(ROOT, "experiments", "security", "key-rotation.json");
const RPC = "https://studio-dev.genlayer.com/api";
const chain = defineChain({ id: 61997, name: "GenLayer Studio Next", nativeCurrency: { name: "GEN", symbol: "GEN", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
const GEN = 10n ** 18n;
const RESERVE = GEN / 50n; // 0.02 GEN left for the transfer fee
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const text = fs.readFileSync(ENV, "utf8");
fs.writeFileSync(`${ENV}.pre-rotation`, text);
const lines = text.split(/\r?\n/);
const isKey = (name, value) => /^0x[0-9a-fA-F]{64}$/.test(value) && (/PRIVATE_KEY$/.test(name) || /^ROBUST_/.test(name));
const log = { rotatedAt: new Date().toISOString(), wallets: [], removed: [] };

async function retry(fn) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) { if (i >= 6) throw e; await sleep(i * 5000); }
  }
}

const out = [];
for (const line of lines) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && m[1] === "GEMINI_API_KEY") { log.removed.push("GEMINI_API_KEY"); continue; }
  if (!m || !isKey(m[1], m[2].trim())) { out.push(line); continue; }
  const name = m[1];
  const oldAcct = privateKeyToAccount(m[2].trim());
  const newKey = generatePrivateKey();
  const newAcct = privateKeyToAccount(newKey);
  const balance = await retry(() => pub.getBalance({ address: oldAcct.address }));
  const entry = { name, oldAddress: oldAcct.address, newAddress: newAcct.address, oldBalanceGen: Number(balance) / 1e18, movedGen: 0, tx: null };
  if (balance > RESERVE * 2n) {
    const wallet = createWalletClient({ account: oldAcct, chain, transport: http(RPC) });
    const value = balance - RESERVE;
    const hash = await retry(() => wallet.sendTransaction({ to: newAcct.address, value }));
    await retry(() => pub.waitForTransactionReceipt({ hash, timeout: 120000 }));
    entry.movedGen = Number(value) / 1e18;
    entry.tx = hash;
  }
  entry.newBalanceGen = Number(await retry(() => pub.getBalance({ address: newAcct.address }))) / 1e18;
  log.wallets.push(entry);
  out.push(`${name}=${newKey}`);
  console.log(`${name}: ${entry.oldAddress.slice(0, 8)}… → ${entry.newAddress.slice(0, 8)}… moved ${entry.movedGen.toFixed(3)} GEN`);
  fs.writeFileSync(ENV, [...out, ...lines.slice(lines.indexOf(line) + 1)].join("\n")); // progress is saved after each wallet
}
fs.writeFileSync(ENV, out.join("\n"));
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(log, null, 2) + "\n");
console.log(`Rotated ${log.wallets.length} wallets; removed: ${log.removed.join(", ") || "none"}. Public log: experiments/security/key-rotation.json`);
