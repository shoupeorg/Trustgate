// Unit tests for the client-side ledger replay (lib/vault.ts buildLedger): the site rebuilds
// vault state from transaction history, so its bookkeeping must match the contract's.
// Run: node --experimental-strip-types --test tests/unit/

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLedger, mandateCapMismatch, parseAllowlist, parseGen } from "../../lib/vault.ts";

const GEN = 10n ** 18n;
const OWNER = "0x1111111111111111111111111111111111111111";
const AGENT = "0x2222222222222222222222222222222222222222";
const PAYEE = "0x3333333333333333333333333333333333333333";
let t = 0;
const ev = (method, args, extra = {}) => ({
  hash: `0x${(++t).toString(16).padStart(64, "0")}`, method, from: OWNER, status: "FINALIZED", execution: "SUCCESS",
  createdAt: `2026-10-14T00:00:${String(t).padStart(2, "0")}Z`, value: "0", args, returned: null, judgment: null, ranJudgment: false, votes: {}, ...extra,
});
const accept = { decision: "ACCEPT", risk: "LOW", confidence: "HIGH", summary: "ok", mandate_violations: [], counterproposal: { deal_text: "", notes: "" } };

test("create, accept, reclaim, withdraw: funds and credits add up", () => {
  const events = [
    ev("create_vault", ["v1", AGENT, "mandate", String(2n * GEN), "0", ""], { value: String(5n * GEN), returned: '{"ok": true}' }),
    ev("request_commitment", ["r1", "v1", PAYEE, String(GEN), "deal", "why", ""], { from: AGENT, judgment: accept, ranJudgment: true }),
    ev("owner_reclaim", ["v1", String(GEN)]),
    ev("withdraw", [String(GEN / 2n)]),
  ];
  const { vaults, credits } = buildLedger(events);
  assert.equal(vaults[0].funds, 3n * GEN);
  assert.equal(vaults[0].released, GEN);
  assert.equal(credits.get(PAYEE), GEN);
  assert.equal(credits.get(OWNER), GEN / 2n);
});

test("refused create_vault credits the deposit back to the sender", () => {
  const { vaults, credits } = buildLedger([ev("create_vault", ["v2", OWNER, "m", "1", "0", ""], { value: String(GEN), returned: '{"ok": false, "reason": "the agent must be a different address from the owner"}' })]);
  assert.equal(vaults.length, 0);
  assert.equal(credits.get(OWNER), GEN);
});

test("deterministic rejection reasons mirror the contract (cap, total cap, allowlist, self-pay)", () => {
  const events = [
    ev("create_vault", ["v3", AGENT, "m", String(GEN), String(GEN), PAYEE], { value: String(5n * GEN), returned: '{"ok": true}' }),
    ev("request_commitment", ["a", "v3", PAYEE, String(GEN), "d", "", ""], { from: AGENT, judgment: accept, ranJudgment: true }),
    ev("request_commitment", ["b", "v3", PAYEE, String(GEN / 2n), "d", "", ""], { from: AGENT }),
    ev("request_commitment", ["c", "v3", AGENT, String(2n * GEN), "d", "", ""], { from: AGENT }),
  ];
  const v = buildLedger(events).vaults[0];
  assert.deepEqual(v.requests[1].reasons, ["amount would exceed the owner's total spend cap"]);
  assert.ok(v.requests[2].reasons.includes("amount exceeds the owner's per-commitment cap"));
  assert.ok(v.requests[2].reasons.includes("payee is not on the owner's payee allowlist"));
  assert.ok(v.requests[2].reasons.includes("the agent cannot pay itself"));
});

test("UNDETERMINED and failed requests move no funds", () => {
  const events = [
    ev("create_vault", ["v4", AGENT, "m", String(GEN), "0", ""], { value: String(GEN), returned: '{"ok": true}' }),
    ev("request_commitment", ["u", "v4", PAYEE, String(GEN), "d", "", ""], { from: AGENT, status: "UNDETERMINED", judgment: accept, ranJudgment: true }),
    ev("request_commitment", ["f", "v4", PAYEE, String(GEN), "d", "", ""], { from: AGENT, execution: "ERROR" }),
  ];
  const v = buildLedger(events).vaults[0];
  assert.equal(v.requests[0].stage, "UNDETERMINED");
  assert.equal(v.requests[1].stage, "FAILED");
  assert.equal(v.funds, GEN);
});

test("input parsing: GEN amounts, allowlists, cap mismatch warning", () => {
  assert.equal(parseGen("1.5"), 15n * GEN / 10n);
  assert.equal(parseGen("0.000000000000000001"), 1n);
  assert.equal(parseGen("-1"), null);
  assert.equal(parseGen("1e3"), null);
  assert.deepEqual(parseAllowlist(`${PAYEE}, nope\n${PAYEE.toUpperCase().replace("0X", "0x")}`), { addresses: [PAYEE], invalid: ["nope"] });
  assert.equal(mandateCapMismatch("Max 5 GEN per commitment.", 2n * GEN), "5");
  assert.equal(mandateCapMismatch("Max 2 GEN per commitment.", 2n * GEN), null);
});

// ---------------------------------------------------------------- negotiation (two-sided contract)

test("negotiation: RENEGOTIATE -> seller signs counterproposal -> ACCEPT credits only the seller", async () => {
  const { buildNegotiations } = await import("../../lib/negotiation.ts");
  const SELLER = "0x4444444444444444444444444444444444444444";
  const reneg = { decision: "RENEGOTIATE", risk: "MEDIUM", confidence: "HIGH", summary: "fix", mandate_violations: [{ rule: "r", evidence: "e", explanation: "x" }], counterproposal: { deal_text: "refundable terms", notes: "n" } };
  const events = [
    ev("create_vault", ["v", AGENT, "m", GEN, 0n.toString(), ""], { value: (2n * GEN).toString(), returned: '{"ok": true}' }),
    ev("post_offer", ["o1", "v", GEN.toString(), "upfront terms"], { from: SELLER, returned: '{"ok": true, "terms_hash": "h1"}' }),
    ev("request_commitment", ["r1", "v", "o1", "h1", "j"], { from: AGENT, judgment: reneg, ranJudgment: true }),
    ev("accept_counterproposal", ["o2", "o1", "refundable terms"], { from: SELLER, returned: '{"ok": true, "terms_hash": "h2"}' }),
    ev("request_commitment", ["r2", "v", "o2", "h2", "j"], { from: AGENT, judgment: accept, ranJudgment: true }),
  ];
  const book = buildNegotiations(events);
  const n = book.negotiations.get("o1");
  assert.equal(n.status, "ACCEPTED");
  assert.deepEqual(n.offers.map((o) => [o.version, o.status, o.origin]), [[1, "SUPERSEDED", "posted"], [2, "ACCEPTED", "accepted_counterproposal"]]);
  assert.equal(n.offers[1].terms, "refundable terms");
  assert.equal(n.offers[0].counterproposal.dealText, "refundable terms");
  const ledger = buildLedger(events);
  assert.equal(ledger.credits.get(SELLER), GEN);
  assert.equal(ledger.vaults[0].funds, GEN);
});

test("negotiation: refused calls change nothing; decline closes; blocked request has no judgment", async () => {
  const { buildNegotiations } = await import("../../lib/negotiation.ts");
  const SELLER = "0x4444444444444444444444444444444444444444";
  const events = [
    ev("create_vault", ["v", AGENT, "m", GEN, "0", ""], { value: GEN.toString(), returned: '{"ok": true}' }),
    ev("post_offer", ["o1", "v", (5n * GEN).toString(), "big"], { from: SELLER, returned: '{"ok": true, "terms_hash": "h1"}' }),
    ev("request_commitment", ["r1", "v", "o1", "h1", ""], { from: AGENT }),
    ev("counter_offer", ["x", "o1", GEN.toString(), "t"], { from: OWNER, execution: "ERROR" }),
    ev("decline", ["o1", "no"], { from: SELLER, returned: '{"ok": true, "status": "DECLINED"}' }),
  ];
  const n = buildNegotiations(events).negotiations.get("o1");
  assert.equal(n.offers.length, 1);
  assert.equal(n.status, "DECLINED");
  assert.equal(n.timeline.map((s) => s.kind).join(","), "offer,request,declined");
  assert.equal(n.timeline[1].request.stage, "DETERMINISTIC");
  assert.equal(buildLedger(events).vaults[0].funds, GEN);
});
