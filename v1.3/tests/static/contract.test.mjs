// Static checks on the vault contract source (Node port of tests/static/test_vault_contract.py,
// so `npm test` needs no Python). Run: node --test tests/static/contract.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const src = fs.readFileSync(path.join(ROOT, "contracts", "trustgate_vault.py"), "utf8").replace(/\r\n/g, "\n");
const params = (name) => {
  const m = src.match(new RegExp(`def ${name}\\(([\\s\\S]*?)\\)\\s*->`));
  assert.ok(m, `method ${name} not found`);
  return m[1].split(",").map((p) => p.trim().split(":")[0].trim()).filter(Boolean);
};

test("Depends header is followed by a blank line (GenVM rejects it otherwise: 'runner malformed')", () => {
  assert.match(src, /^# \{ "Depends": "py-genlayer:[a-z0-9]+" \}\n\n/);
});

test("public interface", () => {
  for (const m of ["create_vault", "top_up", "owner_reclaim", "request_commitment", "withdraw", "get_vault", "get_request", "credit_of", "post_offer", "counter_offer", "accept_counterproposal", "decline", "withdraw_from_negotiation", "get_offer", "get_negotiation", "open_negotiations_of"]) params(m);
  assert.deepEqual(params("request_commitment"), ["self", "request_id", "vault_id", "offer_id", "offer_terms_hash", "agent_justification"]);
  assert.deepEqual(params("post_offer"), ["self", "offer_id", "vault_id", "amount", "terms"]);
  assert.deepEqual(params("accept_counterproposal"), ["self", "new_offer_id", "previous_offer_id", "terms"]);
  assert.deepEqual(params("create_vault"), ["self", "vault_id", "agent", "mandate", "per_commitment_cap", "total_cap", "payee_allowlist"]);
});

test("runtime and release invariants", () => {
  assert.ok(src.includes("run_nondet_default") && !src.includes("run_nondet_unsafe"));
  assert.ok(src.includes('judgment["decision"] == "ACCEPT" and judgment["risk"] != "HIGH"'));
  assert.ok(src.includes('(mine["decision"] == "ACCEPT") != (decision == "ACCEPT")'), "validators must agree exactly on release");
  assert.ok(src.includes('sender != vault["agent"]'), "only the registered agent may request");
});

test("deterministic limits and overflow guards", () => {
  assert.ok(src.includes("amount would exceed the owner's total spend cap"));
  assert.ok(src.includes("payee is not on the owner's payee allowlist"));
  assert.ok(src.includes("amount > int(self.credits.get(sender"));
  assert.ok(src.includes("amount > int(funds)"));
  assert.ok(src.includes("Never raise after value arrives"), "payable calls must not strand funds");
});

test("validators get trusted contract facts, separate from untrusted request data", () => {
  assert.ok(src.includes("CONTRACT_FACTS_JSON"));
  assert.ok(src.includes('"payee_on_owner_allowlist": payee_addr in allowlist'));
  assert.ok(src.includes("UNTRUSTED_REQUEST_JSON") && src.includes("UNTRUSTED_LEADER_REPORT_JSON"));
});

test("negotiation: a payee is credited in exactly one place, only after ACCEPT on a seller-signed offer", () => {
  const credits = src.split("self.credits[payee_addr] = ").length - 1;
  assert.equal(credits, 1, "exactly one payee credit");
  assert.equal(src.split("self.credits[").length - 1, 6, "other credits only refund the sender or debit on withdraw");
  assert.ok(src.includes('payee_addr = offer["payee"]') && src.includes('amount = int(offer["amount"])') && src.includes('deal_text = offer["terms"]'), "payee, amount and text come from the offer");
  assert.ok(!params("request_commitment").includes("payee"), "the agent cannot pass a payee");
  assert.ok(src.includes('"payee": sender'), "an offer's payee is always its signer");
  assert.ok(src.includes('if offer_terms_hash.strip().lower() != offer["terms_hash"]'), "the agent commits to the exact text hash");
  assert.ok(src.includes('if neg["latest_offer_id"] != offer["offer_id"]'), "old versions cannot be judged");
  assert.ok(src.includes('if terms != cp["deal_text"]'), "accepting a counterproposal must sign its exact text");
  assert.ok(src.includes('raise gl.vm.UserError("only the seller who signed this offer can change it")'));
});

test("calibrated decisions live in the shared rules; offer spam is limited per seller per vault", () => {
  const rules = src.match(/JUDGING_RULES = """([\s\S]*?)"""/)[1];
  assert.ok(rules.includes("RENEGOTIATE: the purpose fits the mandate") && rules.includes("REJECT: the purpose is outside the mandate"));
  assert.equal(src.split("{JUDGING_RULES}").length - 1, 2, "leader and validators use the same rules");
  assert.ok(src.includes("MAX_OPEN_PER_SELLER = 3"));
  assert.ok(src.includes("if int(self.open_negotiations.get(slot, gl.u256(0))) >= MAX_OPEN_PER_SELLER:"));
  assert.equal(src.split("self._close_slot(neg)").length - 1, 3, "ACCEPTED, DECLINED and WITHDRAWN free the slot");
});
