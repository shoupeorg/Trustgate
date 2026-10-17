import { createAccount, createClient } from "genlayer-js";
import { studioDevnet } from "genlayer-js/chains";
import { createTransactionKit, type PolicyQuote, type SubmitInput } from "@genlayer/transaction-kit";
import type { BrowserProvider } from "@/lib/genlayer";
import { buildNegotiations, isOfferRequest } from "./negotiation.ts";

// TrustGate V1.3 commitment vault (contracts/trustgate_vault.py) on Studio Next, chain 61997.
// Every deployment is listed in experiments/deployments.json; the published agent runs and the
// first benchmark ran on the previous contract, so both stay browsable.
const configuredVault = process.env.NEXT_PUBLIC_TRUSTGATE_VAULT_ADDRESS;
export const VAULT_CONTRACTS = [
  { address: "0x53E6f0eC998d9BfAd1CA3753252EE94b2cd16BF0", label: "Site contract (current)", note: "Same v6 code as the test contract, kept light so the site feed stays fast: two-sided negotiation, calibrated RENEGOTIATE/REJECT rules, max 3 open offers per seller per vault. The site, Try it and MCP use it." },
  { address: "0x3C61e0C6634d78f6a38efFA6B1872AC11A76f7f3", label: "v6 test and benchmark contract", note: "Same code. On-chain tests (50/50), the three benchmarks, the two-agent demo and the first live Try it ran here. Its history is large (about 130 MB), so this tab loads slowly or may show a stale snapshot." },
  { address: "0xdF2FEeED57870803f2707E02F7F568d39ccA8C05", label: "First negotiation contract (v5 rules)", note: "Same negotiation flow with the v5 judging rules and no offer limit. On-chain tests, the first two-agent runs and the first negotiation held-out run happened here. Read-only history." },
  { address: "0x41B6781fEC91DfFb9747CF2D445677F37c66E43b", label: "Previous public contract (one-sided)", note: "Before negotiation: the agent supplied payee and deal text itself. Hard limits plus trusted contract facts. Read-only history." },
  { address: "0x8f0B3Dd51D4cb2098f20A85B02a2B05f56AF57D7", label: "Benchmark contract (one-sided, v3)", note: "Same code as the previous public one-sided contract 0x41B6. The 41-case v3 runs and the first on-chain tests ran here." },
  { address: "0xcc4A54239cdfaa491d2C6Ba2E755b269c8D71347", label: "Previous contract (E2E tests, 41-case run)", note: "Same limits, without the contract-facts block. Browser E2E tests and the first 41-case benchmark ran here." },
  { address: "0x290c2ef005e3f7683e38c23C1CA69697f60aC053", label: "First V1.3 contract (published results)", note: "Agent runs and the first 20-case benchmark ran here. Read-only history." },
] as const;
export const VAULT_CONTRACT = (configuredVault && /^0x[0-9a-fA-F]{40}$/.test(configuredVault) ? configuredVault : VAULT_CONTRACTS[0].address) as `0x${string}`;

export const MAX_MANDATE = 4000;
export const MAX_DEAL = 6000;
export const MAX_JUSTIFICATION = 1500;
export const MAX_ALLOWLIST = 20;
export const ZERO = BigInt(0);
export const GEN = BigInt("1000000000000000000");
export const EXPLORER_TX = "https://explorer-studio-dev.genlayer.com/tx/";
export const EXPLORER_ADDRESS = "https://explorer-studio-dev.genlayer.com/address/";
const RPC = studioDevnet.rpcUrls.default.http[0];

export type Decision = "ACCEPT" | "RENEGOTIATE" | "REJECT";
export type Risk = "LOW" | "MEDIUM" | "HIGH";

export type Judgment = {
  decision: Decision;
  risk: Risk;
  confidence: string;
  summary: string;
  mandate_violations: Array<{ rule: string; evidence: string; explanation: string }>;
  counterproposal: { deal_text: string; notes: string };
};

// One vault-contract transaction, decoded server-side from the transaction history
// (contract reads were unreliable on Studio Next, so nothing here depends on gen_call).
export type FeedEvent = {
  hash: string;
  method: string;
  from: string;
  status: string;
  execution: string | null;
  createdAt: string | null;
  value: string;
  args: unknown[];
  returned: string | null;
  judgment: Judgment | null;
  ranJudgment: boolean;
  votes: Record<string, number>;
};

export type RequestStage = "PENDING" | "FAILED" | "UNDETERMINED" | "DETERMINISTIC" | "GENLAYER";

export type VaultRequest = {
  event: FeedEvent;
  requestId: string;
  payee: string;
  amount: bigint;
  dealText: string;
  justification: string;
  parentId: string;
  offerId?: string;
  negotiationId?: string;
  offerVersion?: number;
  stage: RequestStage;
  reasons: string[];
  released: boolean;
};

export type Vault = {
  event: FeedEvent;
  vaultId: string;
  owner: string;
  agent: string;
  mandate: string;
  cap: bigint;
  totalCap: bigint;
  allowlist: string[];
  deposited: bigint;
  funds: bigint;
  released: bigint;
  requests: VaultRequest[];
};

export type Ledger = { vaults: Vault[]; credits: Map<string, bigint>; withdrawals: FeedEvent[] };

export function formatGen(wei: bigint): string {
  const negative = wei < ZERO;
  const abs = negative ? -wei : wei;
  const frac = (abs % GEN).toString().padStart(18, "0").replace(/0+$/, "").slice(0, 4);
  return `${negative ? "-" : ""}${abs / GEN}${frac ? `.${frac}` : ""}`;
}

// Up to 18 decimals; null for anything that is not a plain non-negative number.
export function parseGen(text: string): bigint | null {
  const match = text.trim().match(/^(\d{1,12})(?:\.(\d{0,18}))?$/);
  if (!match) return null;
  return BigInt(match[1]) * GEN + BigInt((match[2] ?? "").padEnd(18, "0") || "0");
}

export function parseAllowlist(text: string): { addresses: string[]; invalid: string[] } {
  const parts = text.split(/[\s,]+/).map((p) => p.trim()).filter(Boolean);
  return {
    addresses: [...new Set(parts.filter((p) => /^0x[0-9a-fA-F]{40}$/.test(p)).map((p) => p.toLowerCase()))],
    invalid: parts.filter((p) => !/^0x[0-9a-fA-F]{40}$/.test(p)),
  };
}

const upper = (s: string) => s.toUpperCase();
export const isDecided = (status: string) => ["ACCEPTED", "FINALIZED"].includes(upper(status));
export const isProvisional = (status: string) => upper(status) === "ACCEPTED";
export const isSettled = (status: string) => upper(status) === "FINALIZED";
export const isStuck = (status: string) => ["UNDETERMINED", "LEADER_TIMEOUT", "VALIDATORS_TIMEOUT", "CANCELED"].includes(upper(status));

const ok = (e: FeedEvent) => isDecided(e.status) && upper(e.execution ?? "") === "SUCCESS";
const str = (v: unknown) => (typeof v === "string" ? v : "");
const big = (v: unknown) => {
  try {
    return BigInt(v as string);
  } catch {
    return ZERO;
  }
};
const returnedOk = (e: FeedEvent) => /"ok":\s*true/.test(e.returned ?? "");

// Replays the contract's bookkeeping from the transaction history, in order: vault funds,
// releases, and every address's credit inside the contract (what withdraw can pay out).
export function buildLedger(events: FeedEvent[]): Ledger {
  const vaults = new Map<string, Vault>();
  const credits = new Map<string, bigint>();
  const withdrawals: FeedEvent[] = [];
  const offerEvents: FeedEvent[] = [];
  const credit =(who: string, amount: bigint) => credits.set(who.toLowerCase(), (credits.get(who.toLowerCase()) ?? ZERO) + amount);
  const sorted = [...events].sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
  for (const e of sorted) {
    const from = e.from.toLowerCase();
    if (e.method === "create_vault") {
      const [vaultId, agent, mandate, cap, totalCap, allowlist] = e.args;
      const id = str(vaultId).trim();
      if (!ok(e)) continue;
      if (!returnedOk(e)) {
        credit(from, big(e.value)); // refused create: the deposit is credited back to the sender
        continue;
      }
      if (!id || vaults.has(id)) continue;
      const value = big(e.value);
      vaults.set(id, {
        event: e, vaultId: id, owner: from, agent: str(agent).trim().toLowerCase(), mandate: str(mandate).trim(),
        cap: big(cap), totalCap: big(totalCap ?? "0"), allowlist: parseAllowlist(str(allowlist)).addresses,
        deposited: value, funds: value, released: ZERO, requests: [],
      });
    } else if (e.method === "top_up") {
      if (!ok(e)) continue;
      const v = vaults.get(str(e.args[0]));
      if (v && returnedOk(e)) {
        v.funds += big(e.value);
        v.deposited += big(e.value);
      } else {
        credit(from, big(e.value));
      }
    } else if (e.method === "owner_reclaim") {
      const v = vaults.get(str(e.args[0]));
      if (v && ok(e)) {
        v.funds -= big(e.args[1]);
        credit(v.owner, big(e.args[1]));
      }
    } else if (e.method === "withdraw") {
      if (ok(e)) {
        credit(from, -big(e.args[0]));
        withdrawals.push(e);
      }
    } else if (["post_offer", "counter_offer", "accept_counterproposal"].includes(e.method)) {
      offerEvents.push(e);
    } else if (e.method === "request_commitment") {
      let req: VaultRequest;
      let vaultId: unknown;
      if (isOfferRequest(e)) {
        // Negotiation contract: payee, amount and text come from the seller-signed offer.
        const [requestId, vid, offerId, , justification] = e.args;
        vaultId = vid;
        const offer = buildNegotiations(offerEvents).offers.get(str(offerId).trim());
        if (!offer || (isDecided(e.status) && !ok(e))) continue;
        req = {
          event: e, requestId: str(requestId), payee: offer.seller, amount: offer.amount, dealText: offer.terms,
          justification: str(justification), parentId: "", offerId: offer.offerId, negotiationId: offer.negotiationId, offerVersion: offer.version,
          stage: "PENDING", reasons: [], released: false,
        };
      } else {
        const [requestId, vid, payee, amount, dealText, justification, parentId] = e.args;
        vaultId = vid;
        req = {
          event: e, requestId: str(requestId), payee: str(payee).toLowerCase(), amount: big(amount),
          dealText: str(dealText), justification: str(justification), parentId: str(parentId).trim(),
          stage: "PENDING", reasons: [], released: false,
        };
      }
      const v = vaults.get(str(vaultId));
      if (!v) continue;
      if (isStuck(e.status)) req.stage = "UNDETERMINED";
      else if (isDecided(e.status) && !ok(e)) req.stage = "FAILED";
      else if (ok(e) && e.judgment) {
        req.stage = "GENLAYER";
        req.released = e.judgment.decision === "ACCEPT" && e.judgment.risk !== "HIGH";
      } else if (ok(e) && !e.ranJudgment) {
        req.stage = "DETERMINISTIC";
        if (req.amount <= ZERO) req.reasons.push("amount must be greater than zero");
        else if (req.amount > v.cap) req.reasons.push("amount exceeds the owner's per-commitment cap");
        if (req.amount > ZERO && req.amount > v.funds) req.reasons.push("amount exceeds the funds held in the vault");
        if (v.totalCap > ZERO && req.amount > ZERO && v.released + req.amount > v.totalCap) req.reasons.push("amount would exceed the owner's total spend cap");
        if (v.allowlist.length > 0 && !v.allowlist.includes(req.payee)) req.reasons.push("payee is not on the owner's payee allowlist");
        if (req.payee === v.agent) req.reasons.push("the agent cannot pay itself");
      }
      if (req.released) {
        v.funds -= req.amount;
        v.released += req.amount;
        credit(req.payee, req.amount);
      }
      v.requests.push(req);
    }
  }
  return { vaults: [...vaults.values()].reverse(), credits, withdrawals };
}

// ---------------------------------------------------------------- chain reads (plain RPC)

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }) });
  if (!res.ok) throw new Error(`Studio Next RPC returned HTTP ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message || "Studio Next RPC error");
  return body.result as T;
}

export async function balanceOf(address: string): Promise<bigint> {
  return BigInt(await rpc<string>("eth_getBalance", [address, "latest"]));
}

// Fee for a plain GEN transfer (owner -> agent key).
export async function transferFee(from: string, to: string, value: bigint): Promise<bigint> {
  const [gas, price] = await Promise.all([
    rpc<string>("eth_estimateGas", [{ from, to, value: `0x${value.toString(16)}` }]).catch(() => "0x5208"),
    rpc<string>("eth_gasPrice", []),
  ]);
  return BigInt(gas) * BigInt(price);
}

// ---------------------------------------------------------------- writes: browser wallet

function kit(provider: BrowserProvider, account: `0x${string}`) {
  return createTransactionKit({ chain: studioDevnet, provider, account });
}

export type Progress = { phase: "signing" | "submitted" | "pending" | "processing" | "decided" | "finalized" | "failed"; statusName?: string; hash?: string; error?: string };

export type PreparedWrite =
  | { via: "wallet"; method: string; fee: bigint; value: bigint; quote: PolicyQuote; tx: SubmitInput; account: `0x${string}`; provider: BrowserProvider }
  | { via: "agentKey"; method: string; fee: bigint; value: bigint; args: unknown[]; privateKey: `0x${string}`; fees: unknown };

export async function prepareWalletWrite(provider: BrowserProvider, account: `0x${string}`, contract: `0x${string}`, method: string, args: unknown[], value = ZERO): Promise<PreparedWrite> {
  // Re-check the network right before every wallet signature (the wallet may have been switched to another network).
  await (await import("@/lib/genlayer")).ensureStudioNextNetwork(provider);
  const tx: SubmitInput = { kind: "write", address: contract, method, args };
  const quote = await kit(provider, account).estimate({ preset: "standard", userValue: value }, tx);
  if (quote.verification.status === "mismatch") throw new Error("The Studio Next fee policy changed. Estimate again before confirming.");
  return { via: "wallet", method, fee: quote.feeValue, value, quote, tx, account, provider };
}

// ---------------------------------------------------------------- writes: browser agent key

export async function prepareAgentWrite(privateKey: `0x${string}`, method: string, args: unknown[]): Promise<PreparedWrite> {
  const client = createClient({ chain: studioDevnet, account: createAccount(privateKey) });
  const e = await client.estimateTransactionFees();
  return { via: "agentKey", method, fee: e.feeValue, value: ZERO, args, privateKey, fees: { distribution: e.distribution, messageAllocations: e.messageAllocations, feeValue: e.feeValue } };
}

const DONE = ["ACCEPTED", "FINALIZED", "UNDETERMINED", "LEADER_TIMEOUT", "VALIDATORS_TIMEOUT", "CANCELED"];

// Submits, then reports progress until FINALIZED (or a stuck state). Never throws after submission.
export async function submitWrite(contract: `0x${string}`, p: PreparedWrite, onUpdate: (s: Progress) => void): Promise<string> {
  onUpdate({ phase: "signing" });
  let hash: string;
  let client: ReturnType<typeof createClient>;
  if (p.via === "wallet") {
    const k = kit(p.provider, p.account);
    const submitted = await k.submit(p.quote, p.tx);
    hash = submitted.genlayerTxId;
    client = createClient({ chain: studioDevnet });
  } else {
    client = createClient({ chain: studioDevnet, account: createAccount(p.privateKey) });
    hash = await client.writeContract({ address: contract, functionName: p.method, args: p.args as never, fees: p.fees as never });
  }
  onUpdate({ phase: "submitted", hash });
  void (async () => {
    let decidedSent = false;
    for (let i = 0; i < 360; i++) {
      try {
        const tx = await client.getTransaction({ hash: hash as never });
        const name = String(tx?.statusName ?? "").toUpperCase();
        if (name === "FINALIZED") return onUpdate({ phase: "finalized", statusName: name, hash });
        if (name === "ACCEPTED" && !decidedSent) {
          decidedSent = true;
          onUpdate({ phase: "decided", statusName: name, hash });
        } else if (DONE.includes(name) && name !== "ACCEPTED") {
          return onUpdate({ phase: "failed", statusName: name, hash, error: `Network status ${name}: validators did not reach a verdict. No funds moved.` });
        } else if (!decidedSent && name) {
          onUpdate({ phase: name === "PENDING" ? "pending" : "processing", statusName: name, hash });
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 5000));
    }
  })();
  return hash;
}

// ---------------------------------------------------------------- calldata

export const createVaultArgs = (vaultId: string, agent: string, mandate: string, cap: bigint, totalCap: bigint, allowlist: string[]) =>
  [vaultId, agent, mandate, cap, totalCap, allowlist.join(",")];
export const requestArgs = (requestId: string, vaultId: string, payee: string, amount: bigint, deal: string, justification: string, parentId: string) =>
  [requestId, vaultId, payee, amount, deal, justification, parentId];
export const offerRequestArgs = (requestId: string, vaultId: string, offerId: string, termsHash: string, justification: string) =>
  [requestId, vaultId, offerId, termsHash, justification];
export const postOfferArgs = (offerId: string, vaultId: string, amount: bigint, terms: string) => [offerId, vaultId, amount, terms];
export const counterOfferArgs = (newOfferId: string, previousOfferId: string, amount: bigint, terms: string) => [newOfferId, previousOfferId, amount, terms];
export const acceptCounterArgs = (newOfferId: string, previousOfferId: string, terms: string) => [newOfferId, previousOfferId, terms];

// sha256 of the exact terms text, as the contract computes it (hex).
export async function termsHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;

// Numbers followed by GEN in the mandate text that differ from the enforced cap.
export function mandateCapMismatch(mandate: string, cap: bigint | null): string | null {
  if (cap === null) return null;
  const mentioned = [...mandate.matchAll(/(\d+(?:\.\d+)?)\s*GEN\b/gi)].map((m) => m[1]);
  const different = mentioned.filter((n) => parseGen(n) !== cap);
  return different.length ? different[0] : null;
}
