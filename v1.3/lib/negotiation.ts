// Two-sided negotiation state, replayed from the vault contract's transaction history exactly the
// way contracts/trustgate_vault.py stores it (contract reads are unreliable on Studio Next).
// Self-contained on purpose: the MCP server copies this file at build time (mcp/scripts/sync.mjs).

export type NegJudgment = {
  decision: string;
  risk: string;
  confidence?: string;
  summary: string;
  mandate_violations: Array<{ rule: string; evidence: string; explanation: string }>;
  counterproposal: { deal_text: string; notes: string };
};

export type NegEvent = {
  hash: string;
  method: string;
  from: string;
  status: string;
  execution: string | null;
  createdAt: string | null;
  value: string;
  args: unknown[];
  returned: string | null;
  judgment: NegJudgment | null;
  ranJudgment: boolean;
};

export type OfferStatus = "OPEN" | "JUDGING" | "AWAITING_SELLER" | "BLOCKED" | "REJECTED" | "ACCEPTED" | "SUPERSEDED" | "DECLINED" | "WITHDRAWN";
export type NegotiationStatus = "OPEN" | "ACCEPTED" | "DECLINED" | "WITHDRAWN";

export type Counterproposal = { requestId: string; dealText: string; notes: string };

export type Offer = {
  offerId: string;
  negotiationId: string;
  vaultId: string;
  seller: string;
  amount: bigint;
  terms: string;
  termsHash: string;
  version: number;
  previousOfferId: string;
  origin: "posted" | "countered" | "accepted_counterproposal";
  status: OfferStatus;
  counterproposal: Counterproposal | null;
  requestIds: string[];
  event: NegEvent;
};

export type NegRequest = {
  requestId: string;
  vaultId: string;
  offerId: string;
  termsHash: string;
  justification: string;
  payee: string;
  amount: bigint;
  dealText: string;
  stage: "PENDING" | "FAILED" | "UNDETERMINED" | "DETERMINISTIC" | "GENLAYER";
  released: boolean;
  judgment: NegJudgment | null;
  event: NegEvent;
};

export type TimelineStep =
  | { kind: "offer"; offer: Offer; event: NegEvent }
  | { kind: "request"; request: NegRequest; event: NegEvent }
  | { kind: "declined" | "withdrawn"; by: string; reason: string; event: NegEvent };

export type Negotiation = {
  negotiationId: string;
  vaultId: string;
  seller: string;
  status: NegotiationStatus;
  offers: Offer[];
  latest: Offer;
  timeline: TimelineStep[];
};

export type NegotiationBook = {
  negotiations: Map<string, Negotiation>;
  offers: Map<string, Offer>;
  requests: Map<string, NegRequest>;
};

const up = (s: string | null | undefined) => String(s ?? "").toUpperCase();
const decided = (e: NegEvent) => ["ACCEPTED", "FINALIZED"].includes(up(e.status));
const stuck = (e: NegEvent) => ["UNDETERMINED", "LEADER_TIMEOUT", "VALIDATORS_TIMEOUT", "CANCELED"].includes(up(e.status));
const ok = (e: NegEvent) => decided(e) && up(e.execution) === "SUCCESS";
const str = (v: unknown) => (typeof v === "string" ? v : "");
const big = (v: unknown) => {
  try {
    return BigInt(v as string);
  } catch {
    return BigInt(0);
  }
};
function returned(e: NegEvent): Record<string, unknown> | null {
  try {
    const v = JSON.parse(e.returned ?? "");
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// True for request_commitment calls made against the negotiation contract (5 args, by offer).
export const isOfferRequest = (e: NegEvent) => e.method === "request_commitment" && e.args.length === 5;

export function buildNegotiations(events: NegEvent[]): NegotiationBook {
  const negotiations = new Map<string, Negotiation>();
  const offers = new Map<string, Offer>();
  const requests = new Map<string, NegRequest>();
  const sorted = [...events].sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));

  const addVersion = (prev: Offer, neg: Negotiation, e: NegEvent, id: string, amount: bigint, terms: string, origin: Offer["origin"]) => {
    const r = returned(e);
    const offer: Offer = {
      offerId: id, negotiationId: neg.negotiationId, vaultId: prev.vaultId, seller: e.from.toLowerCase(), amount, terms,
      termsHash: str(r?.terms_hash), version: prev.version + 1, previousOfferId: prev.offerId, origin, status: "OPEN",
      counterproposal: null, requestIds: [], event: e,
    };
    prev.status = "SUPERSEDED";
    offers.set(id, offer);
    neg.offers.push(offer);
    neg.latest = offer;
    neg.timeline.push({ kind: "offer", offer, event: e });
  };

  for (const e of sorted) {
    if (e.method === "post_offer") {
      if (!ok(e) || returned(e)?.ok !== true) continue;
      const [offerId, vaultId, amount, terms] = e.args;
      const id = str(offerId).trim();
      if (!id || offers.has(id)) continue;
      const offer: Offer = {
        offerId: id, negotiationId: id, vaultId: str(vaultId), seller: e.from.toLowerCase(), amount: big(amount), terms: str(terms),
        termsHash: str(returned(e)?.terms_hash), version: 1, previousOfferId: "", origin: "posted", status: "OPEN",
        counterproposal: null, requestIds: [], event: e,
      };
      offers.set(id, offer);
      negotiations.set(id, { negotiationId: id, vaultId: offer.vaultId, seller: offer.seller, status: "OPEN", offers: [offer], latest: offer, timeline: [{ kind: "offer", offer, event: e }] });
    } else if (e.method === "counter_offer" || e.method === "accept_counterproposal") {
      if (!ok(e) || returned(e)?.ok !== true) continue;
      const [newId, prevId, a, b] = e.args;
      const prev = offers.get(str(prevId).trim());
      const neg = prev && negotiations.get(prev.negotiationId);
      if (!prev || !neg) continue;
      if (e.method === "counter_offer") addVersion(prev, neg, e, str(newId).trim(), big(a), str(b), "countered");
      else addVersion(prev, neg, e, str(newId).trim(), prev.amount, str(a), "accepted_counterproposal");
    } else if (e.method === "decline") {
      if (!ok(e) || returned(e)?.ok !== true) continue;
      const offer = offers.get(str(e.args[0]).trim());
      const neg = offer && negotiations.get(offer.negotiationId);
      if (!offer || !neg) continue;
      offer.status = "DECLINED";
      neg.status = "DECLINED";
      neg.timeline.push({ kind: "declined", by: e.from.toLowerCase(), reason: str(e.args[1]), event: e });
    } else if (e.method === "withdraw_from_negotiation") {
      if (!ok(e) || returned(e)?.ok !== true) continue;
      const neg = negotiations.get(str(e.args[0]).trim());
      if (!neg) continue;
      neg.latest.status = "WITHDRAWN";
      neg.status = "WITHDRAWN";
      neg.timeline.push({ kind: "withdrawn", by: e.from.toLowerCase(), reason: str(e.args[1]), event: e });
    } else if (isOfferRequest(e)) {
      const [rid, vid, oid, hash, justification] = e.args;
      const offer = offers.get(str(oid).trim());
      const neg = offer && negotiations.get(offer.negotiationId);
      if (!offer || !neg || offer.vaultId !== str(vid)) continue;
      if (decided(e) && !ok(e)) continue; // refused by the contract: changes nothing
      const req: NegRequest = {
        requestId: str(rid).trim(), vaultId: str(vid), offerId: offer.offerId, termsHash: str(hash), justification: str(justification),
        payee: offer.seller, amount: offer.amount, dealText: offer.terms, stage: "PENDING", released: false, judgment: null, event: e,
      };
      if (stuck(e)) req.stage = "UNDETERMINED";
      else if (ok(e) && e.judgment) {
        req.stage = "GENLAYER";
        req.judgment = e.judgment;
        req.released = e.judgment.decision === "ACCEPT" && e.judgment.risk !== "HIGH";
        if (req.released) {
          offer.status = "ACCEPTED";
          neg.status = "ACCEPTED";
        } else if (e.judgment.decision === "RENEGOTIATE") {
          offer.status = "AWAITING_SELLER";
          offer.counterproposal = { requestId: req.requestId, dealText: String(e.judgment.counterproposal?.deal_text ?? ""), notes: String(e.judgment.counterproposal?.notes ?? "") };
        } else offer.status = "REJECTED";
      } else if (ok(e) && !e.ranJudgment) {
        req.stage = "DETERMINISTIC";
        offer.status = "BLOCKED";
      } else if (!decided(e) && offer.status === "OPEN") offer.status = "JUDGING";
      if (req.stage !== "UNDETERMINED") offer.requestIds.push(req.requestId);
      requests.set(req.requestId, req);
      neg.timeline.push({ kind: "request", request: req, event: e });
    }
  }
  return { negotiations, offers, requests };
}

// Word-level diff between two versions of an offer's terms (small texts, LCS).
export type DiffPart = { type: "same" | "added" | "removed"; text: string };
export function diffWords(before: string, after: string): DiffPart[] {
  const a = before.split(/(\s+)/).filter((t) => t !== "");
  const b = after.split(/(\s+)/).filter((t) => t !== "");
  if (a.length * b.length > 400000) return [{ type: "removed", text: before }, { type: "added", text: after }];
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffPart[] = [];
  const push = (type: DiffPart["type"], text: string) => {
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += text;
    else out.push({ type, text });
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push("same", a[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) push("removed", a[i++]);
    else push("added", b[j++]);
  }
  while (i < a.length) push("removed", a[i++]);
  while (j < b.length) push("added", b[j++]);
  return out;
}
