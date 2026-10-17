import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";

// Server-side bindings for the TrustGate V1.3 Worker: KV for rate limits and secrets.
// On Cloudflare they come from wrangler.jsonc / `wrangler secret`; under `next dev` / `next start`
// secrets come from .env.local and limits fall back to process memory.

export type Limits = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
};

const memory = new Map<string, { value: string; until: number }>();
const memoryLimits: Limits = {
  async get(key) {
    const hit = memory.get(key);
    return hit && hit.until > Date.now() ? hit.value : null;
  },
  async put(key, value, opts) {
    memory.set(key, { value, until: Date.now() + (opts?.expirationTtl ?? 3600) * 1000 });
  },
  async delete(key) {
    memory.delete(key);
  },
};

type Env = { TG_LIMITS?: Limits } & Record<string, unknown>;

function cfEnv(): Env | null {
  try {
    return getCloudflareContext().env as unknown as Env;
  } catch {
    return null;
  }
}

export function limits(): Limits {
  return cfEnv()?.TG_LIMITS ?? memoryLimits;
}

export function secret(name: string): string | undefined {
  const v = cfEnv()?.[name];
  return typeof v === "string" ? v : process.env[name];
}

export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

// Cloudflare KV needs a TTL of at least 60 seconds.
export const ttl = (seconds: number) => Math.max(60, Math.ceil(seconds));

// Lets work finish after the response is sent (Cloudflare waitUntil); under next dev / next start it just runs.
export function background(p: Promise<unknown>) {
  const safe = p.catch(() => undefined);
  try {
    getCloudflareContext().ctx.waitUntil(safe);
  } catch {
    void safe;
  }
}
