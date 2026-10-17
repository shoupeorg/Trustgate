// The raw history repeats a full contract snapshot (and validator configs) in every transaction, so it
// grows quadratically (14 MB for 55 transactions). Parsing all of it in the Worker costs memory and CPU
// that the Worker plan does not have (Cloudflare error 1102), so these fields are replaced by null before
// JSON.parse sees them. Nothing in the feed reads them.
// The scan jumps from token to token with one native regex (strings and brackets), so it costs about as
// much as a plain JSON.parse while keeping only the slim result in memory.
export const DROP = new Set(["contract_snapshot", "consensus_history", "validators", "node_config", "genvm_result", "sim_config", "contract_state", "execution_stats", "fees"]);

const TOKEN = /"(?:[^"\\]|\\.)*"|[{}[\]]/g;
const WS = /\s*/y;
const PRIMITIVE = /[^,}\]\s]*/y;

export function slimJson(text: string): string {
  const out: string[] = [];
  let seg = 0; // start of the next piece to copy
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(text); m; m = TOKEN.exec(text)) {
    if (m[0][0] !== '"' || m[0].length > 42) continue;
    // a short string: is it a key we drop?
    WS.lastIndex = TOKEN.lastIndex;
    WS.exec(text);
    if (text[WS.lastIndex] !== ":" || !DROP.has(m[0].slice(1, -1))) continue;
    const colon = WS.lastIndex;
    WS.lastIndex = colon + 1;
    WS.exec(text);
    const start = WS.lastIndex;
    let end: number;
    const c = text[start];
    if (c === "{" || c === "[") {
      let depth = 0;
      TOKEN.lastIndex = start;
      for (let t = TOKEN.exec(text); t; t = TOKEN.exec(text)) {
        const ch = t[0][0];
        if (ch === "{" || ch === "[") depth++;
        else if (ch === "}" || ch === "]") depth--;
        if (depth === 0) break;
      }
      end = TOKEN.lastIndex;
    } else if (c === '"') {
      TOKEN.lastIndex = start;
      TOKEN.exec(text);
      end = TOKEN.lastIndex;
    } else {
      PRIMITIVE.lastIndex = start;
      PRIMITIVE.exec(text);
      end = PRIMITIVE.lastIndex;
    }
    out.push(text.slice(seg, colon + 1), "null");
    seg = end;
    TOKEN.lastIndex = end;
  }
  out.push(text.slice(seg));
  return out.join("");
}

// Collects the response in pieces and slims it at the end.
export function slimHistoryJson() {
  const parts: string[] = [];
  return { push: (chunk: string) => void parts.push(chunk), result: () => slimJson(parts.join("")) };
}
