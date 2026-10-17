import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { createPublicClient, createWalletClient, defineChain, formatEther, getAddress, http, isAddress, parseEther, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// TrustGate V1.3 test-GEN faucet (Studio Next, chain 61997). Separate from the V1 faucet.
// Key: V13_FAUCET_PRIVATE_KEY (Cloudflare secret / .env.local), never sent to the browser.
// Limits (kept in the TG_LIMITS KV namespace; in-memory fallback for local dev). There is no limit per
// network, so judges sharing one office or event Wi-Fi are never blocked:
//   - PER_WALLET claims per wallet address in 24 hours (counted from its first claim),
//   - GLOBAL_PER_DAY claims per UTC day for the whole site, a safety budget so the faucet cannot be drained.
// AMOUNT covers Try it (which needs no GEN) plus one full negotiation: create a vault, fund the browser
// agent key, request, and the fees.

export const dynamic = "force-dynamic";

const RPC_URL = "https://studio-dev.genlayer.com/api";
const AMOUNT = parseEther("2");
const WINDOW_SECONDS = 24 * 60 * 60;
const PER_WALLET = 3;
const GLOBAL_PER_DAY = 150;
const chain = defineChain({ id: 61997, name: "GenLayer Studio Next", nativeCurrency: { name: "GEN", symbol: "GEN", decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } });

type Limits = { get(key: string): Promise<string | null>; put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>; delete(key: string): Promise<void> };
const memory = new Map<string, { value: string; until: number }>();
const memoryLimits: Limits = {
  async get(key) {
    const hit = memory.get(key);
    return hit && hit.until > Date.now() ? hit.value : null;
  },
  async put(key, value, opts) {
    memory.set(key, { value, until: Date.now() + (opts?.expirationTtl ?? WINDOW_SECONDS) * 1000 });
  },
  async delete(key) {
    memory.delete(key);
  },
};

function bindings(): { limits: Limits; key?: string } {
  try {
    const env = getCloudflareContext().env as unknown as { TG_LIMITS?: Limits; V13_FAUCET_PRIVATE_KEY?: string };
    return { limits: env.TG_LIMITS ?? memoryLimits, key: env.V13_FAUCET_PRIVATE_KEY ?? process.env.V13_FAUCET_PRIVATE_KEY };
  } catch {
    return { limits: memoryLimits, key: process.env.V13_FAUCET_PRIVATE_KEY };
  }
}

const fail = (error: string, status: number, retryAfter?: number) =>
  Response.json({ ok: false, error, retryAfter: retryAfter ?? null }, { status, headers: { "cache-control": "no-store" } });

function faucetAccount(key?: string) {
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) return null;
  return privateKeyToAccount(key as `0x${string}`);
}

export async function GET() {
  const account = faucetAccount(bindings().key);
  if (!account) return Response.json({ ok: false, configured: false, amount: formatEther(AMOUNT) });
  const pub = createPublicClient({ chain, transport: http(RPC_URL) });
  const balance = await pub.getBalance({ address: account.address }).catch(() => null);
  return Response.json({ ok: true, configured: true, amount: formatEther(AMOUNT), address: account.address, empty: balance !== null && balance < AMOUNT, balance: balance === null ? null : formatEther(balance) }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  const { limits, key } = bindings();
  const account = faucetAccount(key);
  if (!account) return fail("The test GEN faucet is not configured on this deployment.", 503);

  let address: string;
  try {
    address = String(((await request.json()) as { address?: unknown }).address ?? "").trim();
  } catch {
    return fail("Send JSON: {\"address\": \"0x…\"}.", 400);
  }
  if (!isAddress(address) || getAddress(address) === zeroAddress) return fail("Enter a valid wallet address.", 400);
  const recipient = getAddress(address);

  // Per wallet: {n, since} with "since" = the first claim of the current 24 h window.
  const addrKey = `faucet:wallet:${recipient.toLowerCase()}`;
  const globalKey = `faucet:global:${new Date().toISOString().slice(0, 10)}`;
  const nowS = Math.floor(Date.now() / 1000);
  let wallet24 = { n: 0, since: nowS };
  try {
    const saved = JSON.parse((await limits.get(addrKey)) ?? "null") as { n?: number; since?: number } | null;
    if (saved && typeof saved.n === "number" && typeof saved.since === "number" && saved.since + WINDOW_SECONDS > nowS) wallet24 = { n: saved.n, since: saved.since };
  } catch {}
  if (wallet24.n >= PER_WALLET) {
    const retryAfter = Math.max(0, wallet24.since + WINDOW_SECONDS - nowS);
    return fail(`This wallet already claimed ${PER_WALLET} times today, use another wallet or come back tomorrow (in about ${Math.max(1, Math.ceil(retryAfter / 3600))} h). Try it needs no wallet at all.`, 429, retryAfter);
  }
  const globalCount = Number((await limits.get(globalKey)) ?? "0");
  if (globalCount >= GLOBAL_PER_DAY) return fail("The faucet has given out today's test GEN, come back tomorrow (it resets at 00:00 UTC). Try it still works without a wallet.", 429, WINDOW_SECONDS);

  const pub = createPublicClient({ chain, transport: http(RPC_URL) });
  const wallet = createWalletClient({ account, chain, transport: http(RPC_URL) });
  let reserved = false;
  try {
    const balance = await pub.getBalance({ address: account.address });
    if (balance < AMOUNT * BigInt(2)) return fail("The faucet is being refilled, try again in a few minutes. Try it still works without a wallet.", 503);
    // Reserve the claim before sending so parallel requests cannot go over the limits.
    const walletTtl = Math.max(60, wallet24.since + WINDOW_SECONDS - nowS);
    await limits.put(addrKey, JSON.stringify({ n: wallet24.n + 1, since: wallet24.since }), { expirationTtl: walletTtl });
    await limits.put(globalKey, String(globalCount + 1), { expirationTtl: WINDOW_SECONDS + 3600 });
    reserved = true;
    // Studio Next's RPC fails now and then ("RPC Request failed"): up to two more tries before giving up.
    let hash: `0x${string}` | null = null;
    for (let attempt = 0; !hash; attempt++) {
      try {
        hash = await wallet.sendTransaction({ to: recipient, value: AMOUNT });
      } catch (e) {
        if (attempt >= 2 || !/rpc request failed|timeout|timed out|fetch failed|429|50[0234]|nonce/i.test(e instanceof Error ? e.message : String(e))) throw e;
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 60_000, pollingInterval: 2000 }).catch(() => null);
    return Response.json(
      { ok: true, hash, amount: formatEther(AMOUNT), confirmed: receipt?.status === "success", to: recipient },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (reserved) {
      // Nothing was sent: give the claim back.
      if (wallet24.n === 0) await limits.delete(addrKey).catch(() => undefined);
      else await limits.put(addrKey, JSON.stringify(wallet24), { expirationTtl: Math.max(60, wallet24.since + WINDOW_SECONDS - nowS) }).catch(() => undefined);
      await limits.put(globalKey, String(globalCount), { expirationTtl: WINDOW_SECONDS + 3600 }).catch(() => undefined);
    }
    const message = error instanceof Error ? (error as Error & { shortMessage?: string }).shortMessage ?? error.message.split("\n")[0] : "unknown error";
    return fail(`The faucet transfer failed: ${message}. Try again in a minute.`, 502);
  }
}
