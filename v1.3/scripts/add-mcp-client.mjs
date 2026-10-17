// Adds the TrustGate MCP server (buyer side) to an MCP client's config file (desktop AI apps, agent
// frameworks: any client that reads the standard "mcpServers" JSON). Quit a desktop client fully first
// (tray icon → Quit): a running app may rewrite its config file and drop the entry.
//
//   node scripts/add-mcp-client.mjs [path/to/mcp-config.json]
//
// Without a path, it uses the default config location of a common desktop MCP client (the fixed file path
// below is the only client-specific name in this file). Uses the demo buyer agent key (NEGO_BUYER_PRIVATE_KEY,
// test GEN only) from .env.local; the key is written only into the local config file and never printed.
// A backup of the config is written first. Then restart the client and ask your agent, for example:
//   "Use trustgate: list the open offers on vault <site-demo vault id> and request the one that fits."

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultCfgPath = path.join(process.env.APPDATA ?? path.join(process.env.HOME ?? "", "Library", "Application Support"), "Claude", "claude_desktop_config.json");
const cfgPath = path.resolve(process.argv[2] ?? defaultCfgPath);
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, ".env.local"), "utf8").split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const demo = JSON.parse(fs.readFileSync(path.join(ROOT, "experiments", "site-demo.json"), "utf8"));
const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, "utf8")) : {};
if (fs.existsSync(cfgPath)) fs.copyFileSync(cfgPath, `${cfgPath}.bak-${Date.now()}`);
cfg.mcpServers = cfg.mcpServers ?? {};
cfg.mcpServers.trustgate = {
  command: process.execPath,
  args: [path.join(ROOT, "mcp", "dist", "index.js")],
  env: { TRUSTGATE_AGENT_PRIVATE_KEY: env.NEGO_BUYER_PRIVATE_KEY, TRUSTGATE_CONTRACT: demo.contract, TRUSTGATE_SITE: "https://trustgatecheck.xyz" },
};
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
console.log(`Added "trustgate" to ${cfgPath}. Vault for the buyer: ${demo.vaultId}. Restart your MCP client now.`);
