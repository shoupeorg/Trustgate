import "server-only";

import { createAccount, createClient } from "genlayer-js";
import { studioDevnet } from "genlayer-js/chains";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getFeed } from "@/lib/feed-server";
import { buildNegotiations } from "@/lib/negotiation";
import { background, limits, secret, ttl } from "@/lib/server-env";
import { buildLedger, formatGen, GEN, parseGen, termsHash, VAULT_CONTRACT } from "@/lib/vault";

// "Try it" without a wallet, both sides played by server-side demo wallets:
//   1. offer   - the demo SELLER (TRY_SELLER_PRIVATE_KEY) posts the visitor's text as a signed offer
//                to the demo vault (TRY_VAULT_ID on TRY_CONTRACT);
//   2. request - the demo AGENT (TRY_AGENT_PRIVATE_KEY) requests a commitment against that offer;
//                GenLayer validators judge it like any other request;
//   3. accept  - after RENEGOTIATE the visitor may click "seller accepts": the demo seller signs the
//                counterproposal word for word as a new version, then step 2 runs again.
// Both demo wallets are untrusted by design. Their keys are Cloudflare secrets and never reach the browser.
//
// There is no per-visitor or per-network limit. The only safety net is a site-wide cap a normal visitor
// cannot reach (GLOBAL_PER_HOUR negotiations per hour), plus a check that the demo vault and the demo
// wallets can still pay. The demo wallets are refilled from the faucet wallet (V13_FAUCET_PRIVATE_KEY).
// Only the vault owner may top up a vault (contract rule), so the vault refills itself only when the
// owner key is configured (TRY_OWNER_PRIVATE_KEY); otherwise visitors see that the demo is being refilled.

export const dynamic = "force-dynamic";

const RPC = studioDevnet.rpcUrls.default.http[0];
const tryContract = () => (secret("TRY_CONTRACT") ?? process.env.TRY_CONTRACT ?? VAULT_CONTRACT) as `0x${string}`;
const TRY_LIMITS = { minChars: 20, maxChars: 2000, defaultAmount: "0.5" };
const GLOBAL_PER_HOUR = 200;
const VAULT_REFILL_BELOW = BigInt(2) * GEN;
const VAULT_REFILL_AMOUNT = BigInt(10) * GEN;
const WALLET_MIN = GEN / BigInt(2); // gas for a few writes
const WALLET_REFILL = BigInt(3) * GEN;
const REFILLING = "Demo is being refilled, try again in a few minutes";
const NETWORK_BUSY = "Network busy, try again in a minute";
const JUSTIFICATION = "Requested by the TrustGate demo agent for a website visitor's offer. The agent did not check it.";
const QUEUED = ["PENDING", "PROPOSING", "COMMITTING", "REVEALING", "ACTIVATED", "APPEAL_REVEALING", "APPEAL_COMMITTING", "LEADER_REVEALING"];
const chain = { ...studioDevnet, rpcUrls: { default: { http: [RPC] } } } as const;
const pub = () => createPublicClient({ chain, transport: http(RPC) });
const validKey = (k?: string) => Boolean(k && /^0x[0-9a-fA-F]{64}$/.test(k));

function config() {
  const agentKey = secret("TRY_AGENT_PRIVATE_KEY");
  const sellerKey = secret("TRY_SELLER_PRIVATE_KEY");
  const vaultId = secret("TRY_VAULT_ID") ?? process.env.NEXT_PUBLIC_TRY_VAULT_ID;
  if (!validKey(agentKey) || !validKey(sellerKey) || !vaultId) return null;
  return {
    agentKey: agentKey as `0x${string}`, sellerKey: sellerKey as `0x${string}`, vaultId,
    agent: createAccount(agentKey as `0x${string}`).address.toLowerCase(), seller: createAccount(sellerKey as `0x${string}`).address.toLowerCase(),
  };
}
type Cfg = NonNullable<ReturnType<typeof config>>;

// POST handlers pass refresh = false: a feed refresh must not run in the same invocation as a demo-wallet write.
async function demoState(cfg: Cfg, refresh = true) {
  const { events } = await getFeed(tryContract(), { refresh });
  const vault = buildLedger(events).vaults.find((v) => v.vaultId === cfg.vaultId) ?? null;
  const queued = events.filter((e) => e.method === "request_commitment" && QUEUED.includes(e.status.toUpperCase())).length;
  return { vault, queued, events };
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const errText = (e: unknown) => (e instanceof Error ? ((e as Error & { shortMessage?: string }).shortMessage ?? e.message).split("\n")[0] : "unknown error");
const newId = (p: string) => `${p}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;
// RPC trouble (timeouts, overload, dropped connections) is worth one more try; contract refusals are not.
const transient = (e: unknown) => /timeout|timed out|fetch failed|network|ECONN|socket|429|50[0234]|overload|rate limit|too many requests|unknown rpc error/i.test(errText(e));

async function write(key: `0x${string}`, method: string, args: unknown[], value?: bigint) {
  const client = createClient({ chain: studioDevnet, account: createAccount(key) });
  for (let attempt = 0; ; attempt++) {
    try {
      const e = await client.estimateTransactionFees();
      return await client.writeContract({ address: tryContract(), functionName: method, args: args as never, value, fees: { distribution: e.distribution, messageAllocations: e.messageAllocations, feeValue: e.feeValue } });
    } catch (e) {
      if (attempt >= 1 || !transient(e)) throw e;
      console.error(`try: ${method} failed once, retrying: ${errText(e)}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function waitDecided(key: `0x${string}`, hash: string) {
  const client = createClient({ chain: studioDevnet, account: createAccount(key) });
  for (let i = 0; i < 24; i++) {
    const tx = await client.getTransaction({ hash: hash as never }).catch(() => null);
    if (["ACCEPTED", "FINALIZED"].includes(String(tx?.statusName).toUpperCase())) return;
    await new Promise((r) => setTimeout(r, 2500));
  }
}

// KV is a convenience here: when it fails, Try it carries on instead of answering with an error page.
const kv = {
  async get(key: string) { try { return await limits().get(key); } catch { return null; } },
  async put(key: string, value: string, seconds: number) { try { await limits().put(key, value, { expirationTtl: ttl(seconds) }); } catch {} },
  async del(key: string) { try { await limits().delete(key); } catch {} },
};

// One submission at a time per demo wallet (its nonce); other visitors retry a few seconds later.
async function withLock<T>(name: string, fn: () => Promise<T>): Promise<T | Response> {
  if (await kv.get(`try:lock:${name}`)) return json({ ok: false, busy: true, error: "Another visitor is submitting right now · retrying…" }, 429);
  await kv.put(`try:lock:${name}`, String(Date.now()), 60);
  try {
    return await fn();
  } finally {
    await kv.del(`try:lock:${name}`);
  }
}

// Site-wide safety net, far above what visitors produce.
async function globalCap() {
  const key = `try:global:${Math.floor(Date.now() / 3600000)}`;
  const used = Number((await kv.get(key)) ?? "0");
  return { blocked: used >= GLOBAL_PER_HOUR, bump: () => kv.put(key, String(used + 1), 7200) };
}

// ---------------------------------------------------------------- refills

// Sends test GEN from the faucet wallet to a demo wallet that is running low. Returns false when it cannot.
async function ensureGas(address: string): Promise<boolean> {
  const client = pub();
  const balance = await client.getBalance({ address: address as `0x${string}` }).catch(() => null);
  if (balance === null || balance >= WALLET_MIN) return true; // unknown balance: let the write itself decide
  const faucetKey = secret("V13_FAUCET_PRIVATE_KEY");
  if (!validKey(faucetKey)) return false;
  try {
    const wallet = createWalletClient({ account: privateKeyToAccount(faucetKey as `0x${string}`), chain, transport: http(RPC) });
    const hash = await wallet.sendTransaction({ to: address as `0x${string}`, value: WALLET_REFILL });
    await client.waitForTransactionReceipt({ hash, timeout: 20000 }).catch(() => undefined);
    return ((await client.getBalance({ address: address as `0x${string}` }).catch(() => BigInt(0))) >= WALLET_MIN);
  } catch (e) {
    console.error(`try: refilling a demo wallet failed: ${errText(e)}`);
    return false;
  }
}

// Tops the demo vault up from its owner wallet (funded by the faucet if needed), at most every 10 minutes.
async function refillVault(cfg: Cfg) {
  const ownerKey = secret("TRY_OWNER_PRIVATE_KEY");
  if (!validKey(ownerKey) || (await kv.get("try:refill"))) return;
  await kv.put("try:refill", String(Date.now()), 600);
  try {
    const owner = privateKeyToAccount(ownerKey as `0x${string}`).address;
    const client = pub();
    const balance = await client.getBalance({ address: owner }).catch(() => BigInt(0));
    if (balance < VAULT_REFILL_AMOUNT + GEN) {
      const faucetKey = secret("V13_FAUCET_PRIVATE_KEY");
      if (!validKey(faucetKey)) return;
      const wallet = createWalletClient({ account: privateKeyToAccount(faucetKey as `0x${string}`), chain, transport: http(RPC) });
      const hash = await wallet.sendTransaction({ to: owner, value: VAULT_REFILL_AMOUNT + GEN });
      await client.waitForTransactionReceipt({ hash, timeout: 30000 });
    }
    await write(ownerKey as `0x${string}`, "top_up", [cfg.vaultId], VAULT_REFILL_AMOUNT);
  } catch (e) {
    console.error(`try: demo vault top-up failed: ${errText(e)}`);
  }
}

export async function GET() {
  const cfg = config();
  if (!cfg) return json({ ok: false, configured: false });
  try {
    const { vault, queued } = await demoState(cfg);
    if (vault && vault.funds < VAULT_REFILL_BELOW) background(refillVault(cfg));
    return json({
      ok: true, configured: true, contract: tryContract(), vaultId: cfg.vaultId, agent: cfg.agent, seller: cfg.seller,
      mandate: vault?.mandate ?? null, cap: vault ? formatGen(vault.cap) : null, funds: vault ? formatGen(vault.funds) : null,
      empty: !vault || vault.funds < GEN / BigInt(10), queued, limits: TRY_LIMITS,
    });
  } catch (e) {
    console.error(`try: GET failed: ${errText(e)}`);
    return json({ ok: false, configured: true, busy: true, error: NETWORK_BUSY }, 502);
  }
}

export async function POST(request: Request) {
  const cfg = config();
  if (!cfg) return json({ ok: false, error: "Try it is not configured on this deployment" }, 503);
  let body: { action?: unknown; offer?: unknown; offerId?: unknown; terms?: unknown; counterproposal?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, error: "Send JSON" }, 400);
  }
  const action = String(body.action ?? "offer");
  const failed = (step: string, e: unknown) => {
    console.error(`try: ${step} failed: ${errText(e)}`);
    return transient(e) ? json({ ok: false, network: true, error: NETWORK_BUSY }, 503) : json({ ok: false, error: `Submitting to GenLayer failed: ${errText(e)} · try again in a minute` }, 502);
  };

  if (action === "offer") {
    const offer = String(body.offer ?? "");
    if (offer.trim().length < TRY_LIMITS.minChars) return json({ ok: false, error: `Write at least ${TRY_LIMITS.minChars} characters` }, 400);
    if (offer.length > TRY_LIMITS.maxChars) return json({ ok: false, error: `Offers are limited to ${TRY_LIMITS.maxChars} characters (yours has ${offer.length}) · nothing was cut` }, 400);
    const cap = await globalCap();
    if (cap.blocked) return json({ ok: false, error: "The demo is very busy right now, try again in a few minutes" }, 503);
    return withLock("seller", async () => {
      try {
        const { vault, queued, events } = await demoState(cfg, false);
        if (!vault) return json({ ok: false, error: "The demo vault was not found on the contract" }, 503);
        const mentioned = offer.match(/(\d+(?:\.\d+)?)\s*GEN\b/i)?.[1];
        const parsed = mentioned ? parseGen(mentioned) : null;
        const amount = parsed && parsed > BigInt(0) ? parsed : parseGen(TRY_LIMITS.defaultAmount)!;
        if (vault.funds < VAULT_REFILL_BELOW) background(refillVault(cfg));
        if (vault.funds < GEN / BigInt(10) || (amount <= vault.cap && amount > vault.funds)) return json({ ok: false, empty: true, error: REFILLING }, 503);
        if (!(await ensureGas(cfg.seller)) || !(await ensureGas(cfg.agent))) return json({ ok: false, empty: true, error: REFILLING }, 503);
        // The contract allows 3 open negotiations per seller per vault. The demo seller closes its oldest
        // open one (not being judged) before posting, and waits until that is recorded.
        const mine = [...buildNegotiations(events).negotiations.values()].filter((n) => n.seller === cfg.seller && n.vaultId === cfg.vaultId && n.status === "OPEN");
        if (mine.length >= 3) {
          const oldest = mine.find((n) => n.latest.status !== "JUDGING");
          if (!oldest) return json({ ok: false, busy: true, error: "The demo seller's negotiations are all being judged · retrying…" }, 429);
          const closing = await write(cfg.sellerKey, "decline", [oldest.latest.offerId, "Try it: making room for a new visitor"]);
          await waitDecided(cfg.sellerKey, closing);
        }
        const offerId = newId("try");
        const hash = await write(cfg.sellerKey, "post_offer", [offerId, cfg.vaultId, amount, offer]);
        await cap.bump();
        return json({ ok: true, step: "offer", hash, offerId, amount: formatGen(amount), seller: cfg.seller, queuedAhead: queued, contract: tryContract() });
      } catch (e) {
        return failed("offer", e);
      }
    });
  }

  const offerId = String(body.offerId ?? "").trim();
  if (!offerId || offerId.length > 128) return json({ ok: false, error: "Missing offerId" }, 400);

  if (action === "request") {
    const terms = String(body.terms ?? "");
    return withLock("agent", async () => {
      try {
        if (!(await ensureGas(cfg.agent))) return json({ ok: false, empty: true, error: REFILLING }, 503);
        const requestId = newId("try-req");
        const hash = await write(cfg.agentKey, "request_commitment", [requestId, cfg.vaultId, offerId, await termsHash(terms), JUSTIFICATION]);
        return json({ ok: true, step: "request", hash, requestId });
      } catch (e) {
        return failed("request", e);
      }
    });
  }

  if (action === "accept") {
    const cp = String(body.counterproposal ?? "");
    return withLock("seller", async () => {
      try {
        // Only the demo seller's own offers, and only once per negotiation.
        const { events } = await demoState(cfg, false);
        const offer = buildNegotiations(events).offers.get(offerId);
        if (offer && offer.seller !== cfg.seller) return json({ ok: false, error: "That offer was not posted by the demo seller" }, 403);
        if (offer && offer.version > 1) return json({ ok: false, error: "The demo seller accepts one counterproposal per negotiation" }, 400);
        if (!(await ensureGas(cfg.seller))) return json({ ok: false, empty: true, error: REFILLING }, 503);
        const newOfferId = newId("try");
        const hash = await write(cfg.sellerKey, "accept_counterproposal", [newOfferId, offerId, cp]);
        return json({ ok: true, step: "accept", hash, offerId: newOfferId });
      } catch (e) {
        return failed("accept", e);
      }
    });
  }
  return json({ ok: false, error: "Unknown action" }, 400);
}
