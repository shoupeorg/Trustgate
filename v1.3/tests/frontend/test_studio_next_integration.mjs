import assert from "node:assert/strict";
import test from "node:test";

import {
  STUDIO_NEXT_CHAIN_ID,
  finalizedTransactionDecision,
  studioNextTransactionUrl,
} from "../../lib/genlayer.ts";

test("Studio Next uses chain 61997 and the official transaction explorer", () => {
  assert.equal(STUDIO_NEXT_CHAIN_ID, "0xf22d");
  assert.equal(
    studioNextTransactionUrl("0xabc"),
    "https://explorer-studio-dev.genlayer.com/tx/0xabc",
  );
});

test("only finalized accepted successful execution reads the durable report", () => {
  assert.equal(finalizedTransactionDecision({
    trackedPhase: "finalized",
    lifecycleState: "finalized",
    consensusOutcome: "accepted",
    executionResultName: "FINISHED_WITH_RETURN",
  }), "read-final-report");

  assert.equal(finalizedTransactionDecision({
    trackedPhase: "finalized",
    lifecycleState: "finalized",
    consensusOutcome: "undetermined",
    executionResultName: "FINISHED_WITH_RETURN",
  }), "failed");

  assert.equal(finalizedTransactionDecision({
    trackedPhase: "finalized",
    lifecycleState: "finalized",
    consensusOutcome: "accepted",
    executionResultName: "FINISHED_WITH_ERROR",
  }), "failed");
});
