// Smoke test: start the built MCP server, list tools, read two known verdicts through the feed path.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ids = process.argv.slice(2);
const t = new StdioClientTransport({ command: process.execPath, args: [path.join(HERE, "..", "dist", "index.js")], env: { ...process.env, TRUSTGATE_CONTRACT: "0x41B6781fEC91DfFb9747CF2D445677F37c66E43b" }, stderr: "pipe" });
const c = new Client({ name: "smoke", version: "1" });
await c.connect(t);
console.log("tools:", (await c.listTools()).tools.map((x) => x.name).join(", "));
for (const id of ids) {
  const r = await c.callTool({ name: "trustgate_get_verdict", arguments: { request_id: id } });
  if (r.isError) { console.log(id, "ERROR:", r.content[0].text); continue; }
  const j = JSON.parse(r.content[0].text);
  console.log(id, j.status, j.verdict, j.risk, "amount", j.amount_gen, "funds_moved:", j.funds_moved.slice(0, 40));
}
const noKey = await c.callTool({ name: "trustgate_request_payment", arguments: { vault_id: "x", payee: "0x0000000000000000000000000000000000000001", amount_gen: "1", deal_text: "d", justification: "j" } });
console.log("without key:", noKey.content[0].text);
await c.close();
