import { test } from "node:test";
import assert from "node:assert/strict";
import { DROP, slimHistoryJson } from "../../lib/slim-json.ts";

// Reference: full parse, then every dropped key (at any depth) set to null.
function reference(json) {
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, DROP.has(k) ? null : walk(x)]));
    return v;
  };
  return walk(JSON.parse(json));
}
function slim(json, chunkSizes) {
  const s = slimHistoryJson();
  let i = 0, k = 0;
  while (i < json.length) {
    const n = chunkSizes[k++ % chunkSizes.length];
    s.push(json.slice(i, i + n));
    i += n;
  }
  return JSON.parse(s.result());
}

const tx = (n) => ({
  hash: `0x${n}`,
  status: "FINALIZED",
  data: { calldata: "AAEC", user_value: 0 },
  contract_snapshot: { states: { accepted: { a: "x".repeat(50), "quote\"inside": ["}", "]", "{", "\\"] } } },
  consensus_history: [{ a: 1 }, "str with } and \" quote"],
  fees: 12345,
  sim_config: "plain string value",
  note: 'keeps "contract_snapshot": as text inside a string',
  consensus_data: {
    votes: { a: "agree", b: "agree" },
    validators: [{ node_config: { x: [1, 2, { y: null }] } }],
    leader_receipt: [{ execution_result: "SUCCESS", result: "AAA=", eq_outputs: { 0: "AQ==" }, genvm_result: true, contract_state: {}, execution_stats: { t: 1.5 } }],
  },
  contract_state: null,
  value: "0",
});

test("slim history: same result as full parse with heavy fields nulled, for any chunking", () => {
  const json = JSON.stringify({ jsonrpc: "2.0", id: 1, result: [tx(1), tx(2), tx(3)] }, null, 1);
  const want = reference(json);
  for (const sizes of [[json.length], [1], [2, 3, 5], [7, 1, 13], [64], [997]]) assert.deepEqual(slim(json, sizes), want, `chunks ${sizes}`);
  const out = JSON.stringify(slim(json, [3]));
  assert.ok(!out.includes("xxxxxxxxxx"), "snapshot content removed");
  assert.ok(out.includes('keeps \\"contract_snapshot\\": as text inside a string'), "string content untouched");
});

test("slim history: error payloads and empty results pass through", () => {
  for (const json of ['{"jsonrpc":"2.0","id":1,"error":{"message":"boom"}}', '{"result":[]}', '{"result":[{"fees":true,"contract_snapshot":"s"}]}']) {
    assert.deepEqual(slim(json, [4]), reference(json));
  }
});
