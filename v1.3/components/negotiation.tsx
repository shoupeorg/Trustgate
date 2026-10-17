"use client";

import { useState, type ReactNode } from "react";
import { diffWords, type Negotiation, type NegotiationBook, type NegEvent, type Offer, type TimelineStep } from "@/lib/negotiation";
import { EXPLORER_TX, formatGen, isProvisional, isSettled, isStuck, MAX_DEAL, MAX_JUSTIFICATION, parseGen, ZERO, type Vault } from "@/lib/vault";
import { MandateLines } from "@/components/landing/hud";
import { CopyButton, fmtElapsed, Icon, LogoLoader, Short, useTicker } from "@/components/ui/kit";

export const MAX_OPEN_PER_SELLER = 3; // mirrors contracts/trustgate_vault.py
const MAX_REASON = 500; // mirrors contracts/trustgate_vault.py
function Count({ value, max }: { value: number; max: number }) {
  return <span className={`count${value > max ? " over" : ""}`}>{value.toLocaleString("en-US")} / {max.toLocaleString("en-US")}</span>;
}
const finality = (e: NegEvent) => (isSettled(e.status) ? "Final" : isProvisional(e.status) ? "Provisional" : isStuck(e.status) ? "No verdict" : (e.execution ?? "").toUpperCase() === "ERROR" ? "Refused" : "Pending");
const lower = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();
const STATUS_TEXT: Record<string, string> = {
  OPEN: "open · waiting for the buyer's agent to request it",
  JUDGING: "GenLayer validators are judging it",
  AWAITING_SELLER: "waiting for the seller · accept the counterproposal, counter or decline",
  BLOCKED: "blocked by the vault's hard limits · the seller can counter",
  REJECTED: "rejected by GenLayer · the seller can counter or decline",
  ACCEPTED: "accepted by GenLayer · funds credited to the seller",
  SUPERSEDED: "replaced by a newer version",
  DECLINED: "declined by the seller",
  WITHDRAWN: "withdrawn by the buyer",
};

export function negotiationLink(id: string, contract?: string) {
  if (typeof window === "undefined") return "";
  const url = new URL(window.location.origin + window.location.pathname);
  url.searchParams.set("negotiation", id);
  if (contract) url.searchParams.set("contract", contract);
  return url.toString();
}

// ---------------------------------------------------------------- shared pieces

export function Diff({ before, after }: { before: string; after: string }) {
  return (
    <span className="diff">
      {diffWords(before, after).map((p, i) => (p.type === "added" ? <ins key={i}>{p.text}</ins> : p.type === "removed" ? <del key={i}>{p.text}</del> : <span key={i}>{p.text}</span>))}
    </span>
  );
}

const TxLink = ({ e }: { e: NegEvent }) => (
  <span className="rowfoot"><span>{finality(e)}</span><a href={EXPLORER_TX + e.hash} target="_blank" rel="noreferrer">tx {e.hash.slice(0, 8)}… ↗</a></span>
);

// Is a verdict still on its way? A request being judged, or a fresh open offer (Try it requests it at once).
const FRESH_OFFER_MS = 15 * 60 * 1000;
export function verdictPending(n: Negotiation) {
  if (n.status !== "OPEN") return false;
  if (n.timeline.some((s) => s.kind === "request" && s.request.stage === "PENDING")) return true;
  if (n.latest.status === "JUDGING") return true;
  if (n.latest.status !== "OPEN") return false;
  const step = n.timeline.find((s) => s.kind === "offer" && s.offer.offerId === n.latest.offerId);
  const at = step?.event.createdAt ? Date.parse(step.event.createdAt) : NaN;
  return Number.isFinite(at) && Date.now() - at < FRESH_OFFER_MS;
}

export function whoseTurn(n: Negotiation): { text: string; tone: "acc" | "ren" | "rej" } {
  if (n.status === "ACCEPTED") return { text: "Deal accepted · funds credited to the seller", tone: "acc" };
  if (n.status === "DECLINED") return { text: "Seller declined · no deal", tone: "rej" };
  if (n.status === "WITHDRAWN") return { text: "Buyer withdrew · no deal", tone: "rej" };
  if (n.timeline.some((s) => s.kind === "request" && s.request.stage === "PENDING") || n.latest.status === "JUDGING") return { text: "GenLayer is judging · nothing to do yet", tone: "ren" };
  if (n.latest.status === "AWAITING_SELLER") return { text: "Waiting for the seller · accept, counter or decline", tone: "ren" };
  if (n.latest.status === "REJECTED") return { text: "Rejected · the seller can counter or decline", tone: "rej" };
  if (n.latest.status === "BLOCKED") return { text: "Blocked by the vault's hard limits · the seller can counter", tone: "rej" };
  return { text: "Waiting for the buyer's agent to request it", tone: "ren" };
}

// ---------------------------------------------------------------- mini timeline (connected dots, current step pulses)

type Node = { cls: string; label: string; small: string; mode: "fill" | "fill now" | "now wait" | "ghost" };
export function miniNodes(n: Negotiation | null): Node[] {
  if (!n) return [
    { cls: "s-post", label: "Offer v1", small: "seller signs", mode: "fill now" },
    { cls: "s-ghost", label: "Verdict", small: "pending", mode: "ghost" },
  ];
  const out: Node[] = [];
  for (const s of n.timeline) {
    if (s.kind === "offer") out.push({ cls: "s-post", label: `Offer v${s.offer.version}`, small: s.offer.origin === "countered" ? "seller countered" : "seller signed", mode: "fill" });
    else if (s.kind === "request") {
      const r = s.request, v = n.offers.find((o) => o.offerId === r.offerId)?.version ?? "?";
      if (r.stage === "PENDING") out.push({ cls: "s-prog", label: `Judging v${v}`, small: "validators", mode: "fill now" });
      else if (r.stage === "GENLAYER" && r.judgment) {
        const d = r.judgment.decision;
        out.push(d === "ACCEPT" ? { cls: "s-acc", label: "Accept", small: `${formatGen(r.amount)} GEN paid`, mode: "fill" } : d === "RENEGOTIATE" ? { cls: "s-ren", label: "Renegotiate", small: "counter sent", mode: "fill" } : { cls: "s-rej", label: "Reject", small: "funds stay locked", mode: "fill" });
      } else if (r.stage === "DETERMINISTIC") out.push({ cls: "s-rej", label: "Blocked", small: "hard limit", mode: "fill" });
      else out.push({ cls: "s-rej", label: "No verdict", small: "nothing moved", mode: "fill" });
    } else out.push({ cls: "s-rej", label: s.kind === "declined" ? "Declined" : "Withdrawn", small: "no deal", mode: "fill" });
  }
  if (n.status === "OPEN") {
    const last = out[out.length - 1];
    if (n.latest.status === "AWAITING_SELLER") out.push({ cls: "s-ren", label: "Seller's turn", small: "accept · counter · decline", mode: "now wait" });
    else if (n.latest.status === "OPEN") {
      if (verdictPending(n)) out.push({ cls: "s-prog", label: `Judging v${n.latest.version}`, small: "agent requests", mode: "fill now" });
      else out.push({ cls: "s-prog", label: "Buyer's turn", small: "agent requests", mode: "now wait" });
    } else if (n.latest.status === "REJECTED" || n.latest.status === "BLOCKED") out.push({ cls: "s-ren", label: "Seller's turn", small: "counter · decline", mode: "now wait" });
    if (last && (last.mode === "fill now" || out[out.length - 1].mode === "fill now")) out.push({ cls: "s-ghost", label: "Verdict", small: "pending", mode: "ghost" });
  }
  return out;
}

export function MiniTimeline({ n }: { n: Negotiation | null }) {
  return (
    <div className="mtl">
      {miniNodes(n).map((x, i) => (
        <div key={i} className={`mn ${x.cls} ${x.mode}`}><i /><b>{x.label}</b><small>{x.small}</small></div>
      ))}
    </div>
  );
}

const chipOf = (n: Negotiation | null): { cls: string; text: string } => {
  if (!n) return { cls: "prog", text: "Starting" };
  if (n.status === "ACCEPTED") return { cls: "acc", text: "Accept" };
  if (n.status !== "OPEN") return { cls: "rej", text: lower(n.status) };
  const s = n.latest.status;
  if (s === "AWAITING_SELLER") return { cls: "ren", text: "Renegotiate" };
  if (s === "REJECTED" || s === "BLOCKED") return { cls: "rej", text: s === "BLOCKED" ? "Blocked" : "Reject" };
  return { cls: "prog", text: verdictPending(n) ? "Judging" : "Open" };
};

// A negotiation as a card with its live mini timeline; the whole card opens the full timeline.
export function NegCard({ n, id, meta, onOpen }: { n: Negotiation | null; id: string; meta: ReactNode; onOpen: (id: string) => void }) {
  const chip = chipOf(n);
  const live = !n || n.status === "OPEN";
  return (
    <div className="negc" role="button" tabIndex={0} onClick={() => onOpen(id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(id); } }} aria-label={`Open the timeline of ${id}`}>
      <div className="negc-head"><Short id={id} /><span className="meta">{meta}</span><span className={`chip ${chip.cls}`}>{chip.text}</span></div>
      <MiniTimeline n={n} />
      <div className="negc-foot">
        {live ? <span className="live"><i />Live · updates by itself</span> : <span className="final">Final · on chain</span>}
        <span className="openbtn">Open full timeline {Icon.open}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- full timeline (modal content)

function Row({ s, n, prev }: { s: TimelineStep; n: Negotiation; prev?: Offer }) {
  if (s.kind === "offer") {
    const o = s.offer;
    const title = o.origin === "posted" ? `Offer v${o.version} posted` : o.origin === "countered" ? `Seller countered · v${o.version}` : `Seller signed v${o.version}`;
    return (
      <li className="card c-post">
        <div className="card-head"><b>{title}</b><span>signed by seller <Short id={o.seller} /> · {formatGen(o.amount)} GEN</span></div>
        {prev ? <p className="reason"><Diff before={prev.terms} after={o.terms} /></p> : <p className="reason">{o.terms}</p>}
        {o.origin === "accepted_counterproposal" && <p className="note2">Exact counterproposal text · it can never be edited · a change is a new version</p>}
        <TxLink e={s.event} />
      </li>
    );
  }
  if (s.kind === "request") {
    const r = s.request, j = r.judgment;
    const offer = n.offers.find((o) => o.offerId === r.offerId);
    const v = offer?.version ?? "?";
    if (r.stage === "PENDING") return <PendingRow e={s.event} v={v} />;
    if (r.stage === "GENLAYER" && j) {
      const cls = j.decision === "ACCEPT" ? "c-acc" : j.decision === "RENEGOTIATE" ? "c-ren" : "c-rej";
      const head = j.decision === "ACCEPT" ? `✓ Accept · GenLayer on v${v}` : j.decision === "RENEGOTIATE" ? `Renegotiate · GenLayer on v${v}` : `✕ Reject · GenLayer on v${v}`;
      const votes = Object.entries((s.event as NegEvent & { votes?: Record<string, number> }).votes ?? {}).map(([k, c]) => `${c} ${k}`).join(" · ");
      return (
        <li className={`card ${cls}`}>
          <div className="card-head"><b className="v13-verdict">{head}</b><span>{lower(j.risk)} risk · {r.released ? `${formatGen(r.amount)} GEN credited to the seller` : "no funds moved"}</span></div>
          <p className="reason">{j.summary}</p>
          {j.mandate_violations.length > 0 && <ul className="violations">{j.mandate_violations.map((x, i) => <li key={i}><b>{x.rule}</b><span>{x.evidence}</span><small>{x.explanation}</small></li>)}</ul>}
          {j.decision === "RENEGOTIATE" && j.counterproposal.deal_text && (
            <div className="cp"><small>Counterproposal · sent to the seller</small>{offer ? <Diff before={offer.terms} after={j.counterproposal.deal_text} /> : j.counterproposal.deal_text}{j.counterproposal.notes && <span>{j.counterproposal.notes}</span>}</div>
          )}
          {r.justification && <p className="note2">Buyer&apos;s agent says (untrusted): {r.justification}</p>}
          {votes && <p className="note2">Validators: {votes}</p>}
          <TxLink e={s.event} />
        </li>
      );
    }
    return (
      <li className="card c-rej">
        <div className="card-head"><b>{r.stage === "DETERMINISTIC" ? `Blocked · hard limits on v${v}` : `No verdict on v${v}`}</b><span>no funds moved</span></div>
        <p className="reason">{r.stage === "DETERMINISTIC" ? "Blocked by the vault's enforced hard limits before any judgment · for example over the cap, the total cap, the allowlist or the funds" : "Validators did not reach a verdict · requesting again starts a new judgment"}</p>
        <TxLink e={s.event} />
      </li>
    );
  }
  return (
    <li className="card c-rej">
      <div className="card-head"><b>{s.kind === "declined" ? "Seller declined" : "Buyer withdrew"}</b><span><Short id={s.by} /></span></div>
      {s.reason && <p className="reason">Reason: {s.reason}</p>}
      <p className="note2">Negotiation closed · no funds moved</p>
      <TxLink e={s.event} />
    </li>
  );
}

function PendingRow({ e, v }: { e: NegEvent; v: number | string }) {
  const now = useTicker(true);
  const at = e.createdAt ? Date.parse(e.createdAt) : now;
  return (
    <li className="card c-prog">
      <div className="card-head"><b>Judging v{v}</b><span>GenLayer validators</span></div>
      <div className="status"><span className="dot" /><span>Validators are judging this exact text against the mandate · usually 2-5 minutes</span><span className="elapsed">{fmtElapsed(now - at)}</span></div>
      <TxLink e={e} />
    </li>
  );
}

export function NegotiationTimeline({ n, id, contract, fetchedAt, loading, onClose }: { n: Negotiation | null; id: string; contract?: string; fetchedAt: string | null; loading: boolean; onClose: () => void }) {
  const now = useTicker(true);
  const ago = fetchedAt ? Math.max(0, Math.round((now - Date.parse(fetchedAt)) / 1000)) : null;
  const turn = n ? whoseTurn(n) : { text: loading ? "Loading the contract history…" : "Waiting for the first step to reach the chain", tone: "ren" as const };
  const live = !n || n.status === "OPEN";
  const waiting = !n || verdictPending(n);
  return (
    <div className="negview">
      <div className="idboxes">
        <div className="idbox"><small>Negotiation</small><Short id={id} /></div>
        <div className="idbox"><small>Vault</small>{n ? <Short id={n.vaultId} /> : <span>…</span>}</div>
        <div className="idbox"><small>Seller</small>{n ? <Short id={n.seller} /> : <span>…</span>}</div>
        <div className="idbox"><small>Versions</small><span>{n ? n.offers.length : "…"}</span></div>
      </div>
      <div className={`livebar t-${turn.tone}`}>
        <span className="whose">{turn.text}</span>
        <span className="live">{live ? <><i />Live · updated {ago === null ? "…" : `${ago}s`} ago</> : "Final · on chain"}</span>
      </div>
      {n && (
        <ol className="tl v13-timeline">
          {n.timeline.map((s, i) => {
            const prev = s.kind === "offer" && s.offer.previousOfferId ? n.offers.find((o) => o.offerId === s.offer.previousOfferId) : undefined;
            return <Row key={s.event.hash + i} s={s} n={n} prev={prev} />;
          })}
        </ol>
      )}
      {waiting && <LogoLoader text={n ? "Waiting for the final verdict…" : "Waiting for the first step to reach the chain…"} />}
      <div className="next">
        <CopyButton className="btn hot" text={negotiationLink(id, contract)} label="Copy shareable link" />
        <button className="btn" type="button" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- buyer's agent: request by offer

export function OfferRequests({ vault, book, disabled, onRequest, onOpen }: { vault: Vault; book: NegotiationBook; disabled: boolean; onRequest: (o: Offer, justification: string) => void; onOpen: (id: string) => void }) {
  const [just, setJust] = useState<Record<string, string>>({});
  const open = [...book.negotiations.values()].filter((n) => n.vaultId === vault.vaultId && n.status === "OPEN" && n.latest.status === "OPEN" && !verdictPendingRequest(n)).map((n) => n.latest).reverse();
  return (
    <div className="box">
      <h3>Request a payment</h3>
      <p className="note2">Sellers post signed offers to vault <Short id={vault.vaultId} /> · pick one · the payee, the amount and the text come from the seller&apos;s signed offer and cannot be changed here · enforced: max {formatGen(vault.cap)} GEN per payment · the vault holds {formatGen(vault.funds)} GEN</p>
      {open.length === 0 && <div className="empty">No open offers for this vault right now · share the vault id with a seller, or post one yourself from another account in the Seller tab</div>}
      {open.map((o) => {
        const j = just[o.offerId] ?? "";
        return (
          <div key={o.offerId} className="card c-post">
            <div className="card-head"><b>Offer v{o.version} · {formatGen(o.amount)} GEN</b><span><Short id={o.offerId} /> · seller <Short id={o.seller} /></span></div>
            <p className="reason">{o.terms}</p>
            {o.amount > vault.cap && <p className="warn err">Above the vault&apos;s max per payment · the contract will block it</p>}
            <div className="field"><label htmlFor={`j-${o.offerId}`}>Justification · untrusted · shown to the validators</label><Count value={j.length} max={MAX_JUSTIFICATION} /></div>
            <textarea id={`j-${o.offerId}`} rows={2} value={j} placeholder="Why this purchase fits the mandate" onChange={(e) => setJust({ ...just, [o.offerId]: e.target.value })} />
            {j.length > MAX_JUSTIFICATION && <p className="warn err">The justification is {j.length - MAX_JUSTIFICATION} characters too long · nothing is cut · shorten it to request</p>}
            <div className="next">
              <button className="btn hot" type="button" disabled={disabled || j.length > MAX_JUSTIFICATION} onClick={() => onRequest(o, j)}>Review and request payment</button>
              <button className="btn" type="button" onClick={() => onOpen(o.negotiationId)}>Timeline</button>
            </div>
          </div>
        );
      })}
      <p className="note2">Hard limits are checked instantly · GenLayer validators then judge the offer · a few minutes</p>
    </div>
  );
}
const verdictPendingRequest = (n: Negotiation) => n.timeline.some((s) => s.kind === "request" && s.request.stage === "PENDING" && s.request.offerId === n.latest.offerId);

// Requests of this vault that GenLayer is still judging, as live progress cards.
export function JudgingCards({ vault, book, onOpen }: { vault: Vault; book: NegotiationBook; onOpen: (id: string) => void }) {
  const now = useTicker(true);
  const pending = [...book.negotiations.values()].filter((n) => n.vaultId === vault.vaultId).flatMap((n) => n.timeline.filter((s) => s.kind === "request" && s.request.stage === "PENDING").map((s) => ({ n, s: s as Extract<TimelineStep, { kind: "request" }> })));
  if (!pending.length) return null;
  return (
    <>
      {pending.map(({ n, s }) => {
        const at = s.event.createdAt ? Date.parse(s.event.createdAt) : now;
        const v = n.offers.find((o) => o.offerId === s.request.offerId)?.version ?? "?";
        return (
          <div key={s.event.hash} className="card c-prog">
            <div className="card-head"><b>In progress · v{v}</b><span><Short id={n.negotiationId} /> · {formatGen(s.request.amount)} GEN → <Short id={s.request.payee} /></span></div>
            <div className="steps"><div className="step done"><i />Sent</div><div className="step done"><i />Queued</div><div className="step now"><i />Validators judging</div><div className="step"><i />Verdict</div></div>
            <div className="status"><span className="dot" /><span>GenLayer validators are judging this request · usually 2-5 minutes</span><span className="elapsed">{fmtElapsed(now - at)}</span></div>
            <div className="next"><button className="btn pulse" type="button" onClick={() => onOpen(n.negotiationId)}>Open live timeline</button></div>
          </div>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------- seller mode

export function SellerMode({ me, vaults, book, disabled, prefillVault, onPost, onAccept, onCounter, onDecline, onOpen }: {
  me: string | null; vaults: Vault[]; book: NegotiationBook; disabled: boolean; prefillVault?: string;
  onPost: (vaultId: string, amount: bigint, terms: string) => void;
  onAccept: (o: Offer) => void;
  onCounter: (o: Offer, amount: bigint, terms: string) => void;
  onDecline: (o: Offer, reason: string) => void;
  onOpen: (id: string) => void;
}) {
  const [vaultId, setVaultId] = useState(prefillVault ?? "");
  const [amount, setAmount] = useState("0.5");
  const [terms, setTerms] = useState("");
  const amountWei = parseGen(amount);
  const target = vaults.find((v) => v.vaultId === vaultId.trim());
  const mine = me ? [...book.negotiations.values()].filter((n) => n.seller === me).reverse() : [];
  const openHere = target ? mine.filter((n) => n.vaultId === target.vaultId && n.status === "OPEN").length : 0;
  const errors = [
    !me && "Connect a wallet to act as the seller",
    !target && "Pick a vault or paste its id",
    target && me && target.agent === me && "This wallet is the vault's agent · the vault would block paying itself · use another account",
    (amountWei === null || amountWei <= ZERO) && "Price must be a positive GEN amount",
    terms.trim() === "" && "Write the full terms",
    terms.length > MAX_DEAL && `Terms are ${terms.length - MAX_DEAL} characters too long`,
    openHere >= MAX_OPEN_PER_SELLER && `You already have ${MAX_OPEN_PER_SELLER} open negotiations with this vault · close (decline) one first`,
  ].filter(Boolean) as string[];

  return (
    <div className="formgrid">
      <form className="box" onSubmit={(e) => { e.preventDefault(); if (!errors.length && amountWei && target) onPost(target.vaultId, amountWei, terms); }}>
        <h3>Post an offer</h3>
        <p className="note2">In real use the seller is usually another agent via MCP · this tab lets you play that side by hand · you sign with your wallet and you are always the payee</p>
        <div className="field"><label htmlFor="tg-sv">Vault id</label>{prefillVault && <span className="count">prefilled from a shared link</span>}</div>
        <input id="tg-sv" list="v13-vault-ids" value={vaultId} onChange={(e) => setVaultId(e.target.value)} placeholder="vault-…" spellCheck={false} />
        <datalist id="v13-vault-ids">{vaults.map((v) => <option key={v.vaultId} value={v.vaultId}>{v.mandate.slice(0, 60)}</option>)}</datalist>
        {target && <div className="mandate"><small>Buyer&apos;s mandate · what GenLayer judges against · max {formatGen(target.cap)} GEN per payment</small><MandateLines text={target.mandate} /></div>}
        <div className="field"><label htmlFor="tg-st">Terms · the exact text is stored and hashed</label><Count value={terms.length} max={MAX_DEAL} /></div>
        <textarea id="tg-st" rows={3} value={terms} onChange={(e) => setTerms(e.target.value)} placeholder="What you deliver · price · payment and refund terms" />
        <label htmlFor="tg-sa">Amount · GEN</label>
        <input id="tg-sa" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0.5" />
        <p className="note2">An offer can never be edited · a change is a new signed version · your signature proves you control the payee wallet, not who you are · at most {MAX_OPEN_PER_SELLER} open negotiations per seller per vault{target ? ` · you have ${openHere} open here` : ""}</p>
        {errors.length > 0 && <p className="warn err" role="status">{errors[0]}</p>}
        <button className="btn hot" disabled={disabled || errors.length > 0}>Review and post offer</button>
      </form>
      <div className="box">
        <h3>Your offers</h3>
        {!me && <div className="empty">Connect a wallet to see offers you signed</div>}
        {me && mine.length === 0 && <div className="empty">No offers signed by <Short id={me} /> on this contract yet</div>}
        {mine.map((n) => <SellerNegotiation key={n.negotiationId} n={n} disabled={disabled} onAccept={onAccept} onCounter={onCounter} onDecline={onDecline} onOpen={onOpen} />)}
      </div>
    </div>
  );
}

function SellerNegotiation({ n, disabled, onAccept, onCounter, onDecline, onOpen }: { n: Negotiation; disabled: boolean; onAccept: (o: Offer) => void; onCounter: (o: Offer, amount: bigint, terms: string) => void; onDecline: (o: Offer, reason: string) => void; onOpen: (id: string) => void }) {
  const o = n.latest;
  const [mode, setMode] = useState<"none" | "counter" | "decline">("none");
  const [amount, setAmount] = useState(formatGen(o.amount));
  const [terms, setTerms] = useState(o.counterproposal?.dealText ?? o.terms);
  const [reason, setReason] = useState("");
  const canChange = n.status === "OPEN" && o.status !== "JUDGING";
  const amountWei = parseGen(amount);
  const yourTurn = o.status === "AWAITING_SELLER" && o.counterproposal;
  return (
    <div className="sellerneg">
      {yourTurn ? (
        <div className="card c-ren">
          <div className="card-head"><b>Your turn · counterproposal</b><span><Short id={o.offerId} /> · v{o.version}</span></div>
          <p className="reason">GenLayer wants these terms before the buyer&apos;s vault can pay</p>
          <div className="cp"><small>Changes from your v{o.version}</small><Diff before={o.terms} after={o.counterproposal!.dealText} />{o.counterproposal!.notes && <span>{o.counterproposal!.notes}</span>}</div>
          <div className="next">
            <button className="btn amber" type="button" disabled={disabled} onClick={() => onAccept(o)}>Accept · sign v{o.version + 1}</button>
            <button className="btn" type="button" aria-pressed={mode === "counter"} onClick={() => setMode(mode === "counter" ? "none" : "counter")}>Counter</button>
            <button className="btn" type="button" aria-pressed={mode === "decline"} onClick={() => setMode(mode === "decline" ? "none" : "decline")}>Decline</button>
            <button className="link" type="button" onClick={() => onOpen(n.negotiationId)}>Timeline</button>
          </div>
        </div>
      ) : (
        <NegCard n={n} id={n.negotiationId} meta={<>{formatGen(o.amount)} GEN · vault <Short id={n.vaultId} /> · {n.status === "OPEN" ? STATUS_TEXT[o.status] ?? o.status : `closed · ${n.status.toLowerCase()}`}</>} onOpen={onOpen} />
      )}
      {!yourTurn && canChange && (
        <div className="next">
          <button className="btn" type="button" aria-pressed={mode === "counter"} onClick={() => setMode(mode === "counter" ? "none" : "counter")}>Counter</button>
          <button className="btn" type="button" aria-pressed={mode === "decline"} onClick={() => setMode(mode === "decline" ? "none" : "decline")}>Decline</button>
        </div>
      )}
      {canChange && mode === "counter" && (
        <div className="inline-form">
          <label htmlFor={`ca-${o.offerId}`}>Price · GEN</label>
          <input id={`ca-${o.offerId}`} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
          <div className="field"><label htmlFor={`ct-${o.offerId}`}>New terms</label><Count value={terms.length} max={MAX_DEAL} /></div>
          <textarea id={`ct-${o.offerId}`} rows={4} value={terms} onChange={(e) => setTerms(e.target.value)} />
          {terms.length > MAX_DEAL && <p className="warn err">The terms are {terms.length - MAX_DEAL} characters too long · nothing is cut · shorten them to sign</p>}
          <button className="btn hot" type="button" disabled={disabled || !amountWei || amountWei <= ZERO || terms.trim() === "" || terms.length > MAX_DEAL} onClick={() => amountWei && onCounter(o, amountWei, terms)}>Review and sign v{o.version + 1}</button>
        </div>
      )}
      {canChange && mode === "decline" && (
        <div className="inline-form">
          <div className="field"><label htmlFor={`cr-${o.offerId}`}>Reason · optional · public</label><Count value={reason.length} max={MAX_REASON} /></div>
          <input id={`cr-${o.offerId}`} value={reason} onChange={(e) => setReason(e.target.value)} />
          {reason.length > MAX_REASON && <p className="warn err">The reason is {reason.length - MAX_REASON} characters too long · nothing is cut · shorten it to decline</p>}
          <button className="btn hot" type="button" disabled={disabled || reason.length > MAX_REASON} onClick={() => onDecline(o, reason)}>Review and decline</button>
        </div>
      )}
    </div>
  );
}
