import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { abi, createClient } from "genlayer-js";
import { studioDevnet } from "genlayer-js/chains";
import type { FeedEvent, Judgment } from "@/lib/vault";
import { slimJson } from "@/lib/slim-json";
import { limits } from "@/lib/server-env";

// Vault feed built from the contract's transaction history (calldata + the leader's nondet
// outputs). Studio Next contract reads (gen_call) were failing for every contract during
// development, while the history stayed available. The raw history is large (contract
// snapshots), so it is slimmed down here before it reaches the browser.

const RPC = studioDevnet.rpcUrls.default.http[0];
const HISTORY_TIMEOUT = 30000;

type RawTx = {
  hash: string;
  from_address: string;
  to_address: string;
  status: string;
  txExecutionResultName?: string;
  value?: string | number;
  created_at?: string;
  data?: { calldata?: string; user_value?: string | number };
  consensus_data?: { votes?: Record<string, string>; leader_receipt?: LeaderReceipt | LeaderReceipt[] };
};
// In raw history, results are base64: one status byte (0 = return) followed by GenLayer calldata.
type LeaderReceipt = { execution_result?: string; result?: string; eq_outputs?: Record<string, string> };

const plain = (v: unknown): unknown =>
  v instanceof Map ? Object.fromEntries([...v].map(([k, x]) => [k, plain(x)]))
    : Array.isArray(v) ? v.map(plain)
      : typeof v === "bigint" ? v.toString()
        : v instanceof Uint8Array ? `0x${Buffer.from(v).toString("hex")}`
          : v && typeof v === "object" && "as_hex" in (v as object) ? String((v as { as_hex: string }).as_hex)
            : v;

function decodeCall(calldata?: string): { method: string; args: unknown[] } {
  if (!calldata) return { method: "", args: [] };
  try {
    const decoded = plain(abi.calldata.decode(Uint8Array.from(Buffer.from(calldata, "base64")))) as Record<string, unknown>;
    return { method: typeof decoded[""] === "string" ? decoded[""] : "", args: Array.isArray(decoded.args) ? decoded.args : [] };
  } catch {
    return { method: "", args: [] };
  }
}

function decodeResult(b64?: string): unknown {
  if (typeof b64 !== "string" || b64 === "") return null;
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length < 2 || bytes[0] !== 0) return null;
  try {
    return plain(abi.calldata.decode(Uint8Array.from(bytes.subarray(1))));
  } catch {
    return null;
  }
}

function decodeJudgment(eq?: LeaderReceipt["eq_outputs"]): Judgment | null {
  for (const out of Object.values(eq ?? {})) {
    const v = decodeResult(out) as Judgment | null;
    if (v && typeof v === "object" && typeof v.decision === "string") return v;
  }
  return null;
}

function decodeReturn(b64?: string): string | null {
  const v = decodeResult(b64);
  return v == null ? null : typeof v === "string" ? v : JSON.stringify(v);
}

async function history(contract: string): Promise<RawTx[]> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HISTORY_TIMEOUT);
    try {
      const response = await fetch(RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "sim_getTransactionsForAddress", params: [contract] }),
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Studio Next RPC returned HTTP ${response.status}`);
      const payload = JSON.parse(slimJson(await response.text())) as { result?: RawTx[]; error?: { message?: string } };
      if (payload.error) throw new Error(payload.error.message || "Studio Next RPC error");
      return payload.result ?? [];
    } catch (e) {
      lastError = controller.signal.aborted ? new Error(`Studio Next did not answer within ${HISTORY_TIMEOUT / 1000} s`) : e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

export async function fetchFeed(contract: string): Promise<FeedEvent[]> {
  return (await history(contract))
    .filter((tx) => tx.to_address?.toLowerCase() === contract.toLowerCase())
    .map((tx) => {
      const { method, args } = decodeCall(tx.data?.calldata);
      const lr = tx.consensus_data?.leader_receipt;
      const leader = Array.isArray(lr) ? lr[0] : lr;
      const votes: Record<string, number> = {};
      for (const vote of Object.values(tx.consensus_data?.votes ?? {})) votes[vote] = (votes[vote] ?? 0) + 1;
      return {
        hash: tx.hash,
        method,
        from: tx.from_address,
        status: tx.status ?? "",
        execution: leader?.execution_result ?? tx.txExecutionResultName ?? null,
        createdAt: tx.created_at ?? null,
        value: String(tx.data?.user_value ?? tx.value ?? "0"),
        args,
        returned: decodeReturn(leader?.result),
        judgment: decodeJudgment(leader?.eq_outputs),
        ranJudgment: Object.keys(leader?.eq_outputs ?? {}).length > 0,
        votes,
      };
    })
    .filter((e) => e.method !== "");
}

// Are direct contract reads (gen_call) working right now? Cached for a minute.
let readProbe: { at: number; ok: boolean; detail: string } | null = null;
export async function probeContractReads(contract: string): Promise<{ ok: boolean; detail: string }> {
  if (readProbe && Date.now() - readProbe.at < 60000) return readProbe;
  try {
    const client = createClient({ chain: studioDevnet });
    await Promise.race([
      client.readContract({ address: contract as `0x${string}`, functionName: "get_vault", args: ["__probe__"] }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timed out after 5 s")), 5000)),
    ]);
    readProbe = { at: Date.now(), ok: true, detail: "working" };
  } catch (e) {
    readProbe = { at: Date.now(), ok: false, detail: (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 120) };
  }
  return readProbe;
}

// ---------------------------------------------------------------- cached feed
// The raw history carries a full contract snapshot per transaction, so it grows fast (14 MB for 55
// transactions). Serve a cached slim feed and refresh it in the background: per-isolate memory first,
// then the Cloudflare Cache API (shared across isolates), then Studio Next.

type Cached = { at: number; events: FeedEvent[] };
const memory = new Map<string, Cached>();
const refreshing = new Map<string, Promise<Cached>>();
const lastEdgeCheck = new Map<string, number>();
// One refresh (a full history download and parse) costs about 200 ms of Worker CPU, far more than the
// plan's per-request budget, and a Worker over budget is stopped together with the requests it serves
// (Cloudflare error 1102). So the feed is refreshed at most every 10 s, isolates first look for a
// newer copy another isolate put in the shared cache, a short marker keeps them from refreshing at the
// same time, and POST handlers never refresh (a demo-wallet write must not share an invocation with it).
const FRESH_MS = 10000;
const EDGE_CHECK_MS = 5000;
const REFRESH_MARK_S = 25;
const cacheKey = (contract: string) => `https://trustgate-feed.cache/${contract.toLowerCase()}`;
const markKey = (contract: string) => `https://trustgate-feed.cache/refreshing/${contract.toLowerCase()}`;

function edgeCache(): Cache | null {
  try {
    return (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default ?? null;
  } catch {
    return null;
  }
}

function waitUntil(p: Promise<unknown>) {
  try {
    getCloudflareContext().ctx.waitUntil(p);
  } catch {
    void p; // local dev: the promise just runs
  }
}

function refresh(contract: string): Promise<Cached> {
  const running = refreshing.get(contract);
  if (running) return running;
  const p = fetchFeed(contract)
    .then(async (events) => {
      const entry = { at: Date.now(), events };
      memory.set(contract, entry);
      const body = JSON.stringify(entry);
      await edgeCache()?.put(cacheKey(contract), new Response(body, { headers: { "content-type": "application/json", "cache-control": "max-age=3600" } })).catch(() => undefined);
      await saveToKv(contract, body);
      return entry;
    })
    .finally(() => refreshing.delete(contract));
  refreshing.set(contract, p);
  return p;
}

// A second shared copy in KV for isolates with neither memory nor an edge-cache copy (a cold data
// centre, or workers.dev where the Cache API does nothing). Without it such an isolate has to refresh
// inside the request, goes over its CPU budget and is stopped, and the next one starts cold again.
// Written at most every 10 minutes per contract to stay far below the KV daily write allowance.
const KV_EVERY_MS = 10 * 60 * 1000;
const kvKey = (contract: string) => `feed:${contract.toLowerCase()}`;
const kvSavedAt = new Map<string, number>();

async function saveToKv(contract: string, body: string) {
  if (Date.now() - (kvSavedAt.get(contract) ?? 0) < KV_EVERY_MS) return;
  kvSavedAt.set(contract, Date.now());
  try {
    const last = Number((await limits().get(`${kvKey(contract)}:at`)) ?? "0");
    if (Date.now() - last < KV_EVERY_MS) return;
    await limits().put(kvKey(contract), body, { expirationTtl: 7 * 24 * 3600 });
    await limits().put(`${kvKey(contract)}:at`, String(Date.now()), { expirationTtl: 7 * 24 * 3600 });
  } catch {}
}

async function fromKv(contract: string): Promise<Cached | null> {
  try {
    const raw = await limits().get(kvKey(contract));
    const hit = raw ? (JSON.parse(raw) as Cached) : null;
    if (hit && Array.isArray(hit.events)) {
      memory.set(contract, hit);
      kvSavedAt.set(contract, Date.now()); // another isolate wrote it just now or earlier; don't rewrite at once
      return hit;
    }
  } catch {}
  return null;
}

async function fromEdge(contract: string): Promise<Cached | null> {
  lastEdgeCheck.set(contract, Date.now());
  const res = await edgeCache()?.match(cacheKey(contract)).catch(() => undefined);
  const hit = res ? ((await res.json().catch(() => null)) as Cached | null) : null;
  const mine = memory.get(contract);
  if (hit && (!mine || hit.at > mine.at)) memory.set(contract, hit);
  return memory.get(contract) ?? null;
}

// Starts a background refresh unless another isolate has just started one.
async function refreshInBackground(contract: string) {
  const cache = edgeCache();
  if (cache) {
    if (await cache.match(markKey(contract)).catch(() => undefined)) return;
    await cache.put(markKey(contract), new Response("1", { headers: { "cache-control": `max-age=${REFRESH_MARK_S}` } })).catch(() => undefined);
  }
  waitUntil(refresh(contract).catch(() => undefined));
}

export async function getFeed(contract: string, opts: { refresh?: boolean } = {}): Promise<Cached & { stale: boolean }> {
  const allowRefresh = opts.refresh !== false;
  let hit = memory.get(contract) ?? null;
  const stale = (c: Cached | null) => !c || Date.now() - c.at >= FRESH_MS;
  if (stale(hit) && Date.now() - (lastEdgeCheck.get(contract) ?? 0) > EDGE_CHECK_MS) hit = await fromEdge(contract);
  if (!hit) hit = await fromKv(contract);
  if (hit && !stale(hit)) return { ...hit, stale: false };
  if (hit) {
    if (allowRefresh) await refreshInBackground(contract);
    return { ...hit, stale: true };
  }
  return { ...(await refresh(contract)), stale: false };
}
