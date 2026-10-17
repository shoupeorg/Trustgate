// Pushes the Try-it settings from .env.local to the trustgate-v13 Worker as Cloudflare secrets.
// Values go to wrangler over stdin and are never printed.
//
//   node scripts/push-secrets.mjs

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, ".env.local"), "utf8").split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
for (const name of ["TRY_AGENT_PRIVATE_KEY", "TRY_SELLER_PRIVATE_KEY", "TRY_VAULT_ID", "TRY_CONTRACT", "V13_FAUCET_PRIVATE_KEY"]) {
  if (!env[name]) throw new Error(`${name} missing in .env.local`);
  const r = spawnSync("npx", ["wrangler", "secret", "put", name], { cwd: ROOT, input: env[name], encoding: "utf8", shell: true });
  console.log(`${name}: ${r.status === 0 ? "set" : `FAILED (${(r.stderr || r.stdout).split("\n").filter(Boolean).slice(-1)[0]})`}`);
}
