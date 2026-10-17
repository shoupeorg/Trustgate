// Secret guard. Fails (exit 1) if a secret appears in the given place:
//   - every value in .env.local whose name contains KEY, SECRET or TOKEN (current wallets, API keys), and
//   - generic patterns: Google API keys (AIza…), sk-… style API keys, and any 0x-prefixed
//     64-hex string written right after a word like "private", "secret" or "key".
//
//   node scripts/check-secrets.mjs --staged        scan the staged git diff (used by the pre-commit hook)
//   node scripts/check-secrets.mjs --dir <path>    scan every file under a folder (used by the Cloudflare build)
//   node scripts/check-secrets.mjs --install-hook  install .git/hooks/pre-commit
//
// Never prints a secret: only the variable name or the pattern name, and the file.

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);

if (argv.includes("--install-hook")) {
  const hook = path.join(ROOT, ".git", "hooks", "pre-commit");
  fs.writeFileSync(hook, "#!/bin/sh\n# Installed by scripts/check-secrets.mjs: blocks commits that contain keys.\nnode scripts/check-secrets.mjs --staged || exit 1\n");
  try { fs.chmodSync(hook, 0o755); } catch {}
  console.log("pre-commit hook installed");
  process.exit(0);
}

const envFile = path.join(ROOT, ".env.local");
const values = fs.existsSync(envFile)
  ? fs.readFileSync(envFile, "utf8").split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()])
    .filter(([k, v]) => /KEY|SECRET|TOKEN/.test(k) && v.length > 20).map(([k, v]) => [k, v.toLowerCase().replace(/^0x/, "")])
  : [];
const PATTERNS = [
  ["Google API key", /AIza[0-9A-Za-z_-]{35}/],
  ["sk- style API key", /\bsk-(?:ant-)?[A-Za-z0-9_-]{32,}/],
  ["private key literal", /(?:private|secret|priv)[_ -]?key["'\s:=]+0x[0-9a-fA-F]{64}/i],
];

function scan(label, text) {
  const hits = [];
  const lower = text.toLowerCase();
  for (const [k, v] of values) if (lower.includes(v)) hits.push(`${k} in ${label}`);
  for (const [name, re] of PATTERNS) if (re.test(text)) hits.push(`${name} pattern in ${label}`);
  return hits;
}

let hits = [];
let scanned = 0;
if (argv.includes("--staged")) {
  const files = execSync("git diff --cached --name-only --diff-filter=ACM", { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
  for (const f of files) {
    if (/^\.env/.test(path.basename(f))) { hits.push(`${f} is an env file and must not be committed`); continue; }
    let blob = "";
    try { blob = execSync(`git show :"${f}"`, { cwd: ROOT, encoding: "latin1", maxBuffer: 256 * 1024 * 1024 }); } catch { continue; }
    scanned++;
    hits.push(...scan(f, blob));
  }
} else if (argv.includes("--dir")) {
  const dir = path.resolve(ROOT, argv[argv.indexOf("--dir") + 1]);
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { scanned++; hits.push(...scan(path.relative(ROOT, p), fs.readFileSync(p, "latin1"))); }
    }
  };
  walk(dir);
} else {
  console.log("usage: --staged | --dir <path> | --install-hook");
  process.exit(2);
}
console.log(`Secret scan: ${scanned} file(s), ${values.length} known secret(s) + ${PATTERNS.length} patterns, ${hits.length} finding(s).`);
for (const h of hits) console.log(`  BLOCKED: ${h}`);
process.exit(hits.length ? 1 : 0);
