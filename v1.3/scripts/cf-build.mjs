// Safe Cloudflare build: OpenNext copies .env* files into the Worker bundle (.open-next/cloudflare/next-env.mjs),
// which would ship the local test keys to Cloudflare. This hides .env.local during the build (the Worker reads
// its keys from Cloudflare secrets at runtime), restores it afterwards, and then fails if any private key from
// .env.local appears anywhere in the build output.
//
//   node scripts/cf-build.mjs            build + scan
//   node scripts/cf-build.mjs --deploy   build + scan + deploy

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV = path.join(ROOT, ".env.local");
const HIDDEN = path.join(ROOT, ".env.local.hidden-during-build");
const run = (cmd, args) => spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", shell: true }).status;


fs.renameSync(ENV, HIDDEN);
let status;
try {
  status = run("npx", ["opennextjs-cloudflare", "build"]);
} finally {
  fs.renameSync(HIDDEN, ENV);
}
if (status !== 0) process.exit(status ?? 1);

// Permanent guard: the same checker as the pre-commit hook (known secrets + API-key patterns).
const scan = spawnSync("node", ["scripts/check-secrets.mjs", "--dir", ".open-next"], { cwd: ROOT, stdio: "inherit" });
if (scan.status !== 0) {
  console.log("Build output contains secrets: not deploying.");
  process.exit(1);
}
if (process.argv.includes("--deploy")) process.exit(run("npx", ["opennextjs-cloudflare", "deploy"]) ?? 1);
