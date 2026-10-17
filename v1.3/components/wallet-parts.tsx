"use client";

import { useState } from "react";
import type { ConnectedWallet } from "@/lib/genlayer";
import { createAgentKey, forgetAgentKey, importAgentKey, type AgentKey } from "@/lib/agent-key";
import {
  EXPLORER_ADDRESS,
  EXPLORER_TX,
  formatGen,
  GEN,
  isProvisional,
  isSettled,
  mandateCapMismatch,
  MAX_ALLOWLIST,
  MAX_MANDATE,
  newId,
  parseAllowlist,
  parseGen,
  VAULT_CONTRACTS,
  ZERO,
  type FeedEvent,
  type Ledger,
  type PreparedWrite,
  type Progress,
  type Vault,
  type VaultRequest,
} from "@/lib/vault";
import type { NegotiationBook } from "@/lib/negotiation";
import { NegCard } from "@/components/negotiation";
import { MandateLines } from "@/components/landing/hud";
import { CopyButton, fmtElapsed, Modal, Short, Steps, useTicker } from "@/components/ui/kit";

export const MANDATE_TEMPLATES = [
  { name: "Research purchases", text: "Buy data or compute services for research. Only refundable or escrowed payments. Never pay an address the counterparty supplies at the last minute." },
  { name: "SaaS subscriptions", text: "Subscribe to software tools the team already uses. Monthly plans only, cancellable at any time, no annual prepayment. Never grant admin or billing access to the provider." },
  { name: "Freelance tasks", text: "Pay freelancers for clearly scoped tasks with a written deliverable. Payment only after delivery is verified, or into escrow released on delivery. No open-ended retainers." },
];
export const AGENT_FUNDING = GEN / BigInt(2); // 0.5 GEN covers about 10 judged requests in fees
const MIN_DEPOSIT = GEN / BigInt(10);
const MAX_DEPOSIT = BigInt(1000) * GEN;
export const REPO = "https://github.com/shoupeorg/TrustGate-V1.3";
const isAddress = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a.trim());
export const errorText = (e: unknown) => (e instanceof Error ? (e as Error & { shortMessage?: string }).shortMessage ?? e.message : String(e)).split("\n")[0];
const cap = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();

// ---------------------------------------------------------------- transaction: review → wallet → sending → queued → final

export type Pending = { label: string; done: string; prepared: PreparedWrite; after?: (hash: string) => void; judged?: boolean; open?: string };
export type Live = { label: string; done: string; started: number; progress?: Progress; error?: string; judged?: boolean; open?: string };

const phaseAt = (p?: Progress["phase"]) => (!p || p === "signing" ? 0 : p === "submitted" ? 1 : p === "pending" || p === "processing" ? 2 : 4);
const PHASE_TEXT: Record<Progress["phase"], string> = {
  signing: "Waiting for your wallet…",
  submitted: "Sending · waiting for the network to pick it up…",
  pending: "Queued on Studio Next…",
  processing: "GenLayer validators are executing it…",
  decided: "Consensus reached · finalizing…",
  finalized: "Finalized",
  failed: "No verdict",
};

export function TxModal({ open, pending, live, onConfirm, onCancel, onClose, onOpen }: { open: boolean; pending: Pending | null; live: Live | null; onConfirm: () => void; onCancel: () => void; onClose: () => void; onOpen: (id: string) => void }) {
  const title = pending?.label ?? live?.label ?? "Transaction";
  return (
    <Modal open={open && Boolean(pending || live)} onClose={pending ? onCancel : onClose} title={title} labelledBy="tx-title">
      {pending ? <TxReview p={pending} onConfirm={onConfirm} onCancel={onCancel} /> : live ? <TxRun live={live} onClose={onClose} onOpen={onOpen} /> : null}
    </Modal>
  );
}

function TxReview({ p, onConfirm, onCancel }: { p: Pending; onConfirm: () => void; onCancel: () => void }) {
  const w = p.prepared;
  return (
    <div className="v13-tx pending">
      <div className="lines">
        {w.value > ZERO && <div><span>{w.method === "create_vault" ? "Deposit into the vault" : w.method === "top_up" ? "Added to the vault" : "Amount"}</span>{formatGen(w.value)} GEN</div>}
        <div><span>Network fee · up to · unused is refunded</span>{formatGen(w.fee)} GEN</div>
        <div><span>{w.via === "agentKey" ? "Total from your agent key · at most" : "Total from your wallet · at most"}</span>{formatGen(w.value + w.fee)} GEN</div>
      </div>
      <p className="signer">{w.via === "agentKey" ? "Signed by your browser agent key · no wallet popup" : "Your wallet will ask you to confirm"}</p>
      <div className="next">
        <button className="btn hot" type="button" data-autofocus="" onClick={onConfirm}>{w.via === "agentKey" ? "Confirm and send" : "Confirm in wallet"}</button>
        <button className="btn" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

export function TxRun({ live, onClose, compact, onOpen }: { live: Live; onClose?: () => void; compact?: boolean; onOpen?: (id: string) => void }) {
  const at = phaseAt(live.progress?.phase);
  const finished = at >= 4 || Boolean(live.error);
  const now = useTicker(!finished);
  const names = live.judged ? ["Wallet", "Sending", "Validators judging", "Verdict"] : ["Wallet", "Sending", "Queued", "Final"];
  const hash = live.progress?.hash;
  return (
    <div className={`v13-tx ${live.error ? "error" : finished ? "done" : "submitted"}${compact ? " card c-prog" : ""}`} aria-live="polite">
      {compact && <div className="card-head"><b>{live.error ? "Stopped" : finished ? "✓ Done" : "In progress"}</b><span>{live.label}</span></div>}
      <Steps names={names} at={Math.min(at, 3)} done={finished && !live.error} />
      {live.error ? (
        <p className="warn err">{live.error}</p>
      ) : finished ? (
        <p className="ok">✓ {live.done}</p>
      ) : (
        <div className="status"><span className="dot" /><span>{live.judged && live.progress?.phase === "processing" ? "GenLayer validators are judging · usually 2-5 minutes" : PHASE_TEXT[live.progress?.phase ?? "signing"]}</span><span className="elapsed">{fmtElapsed(now - live.started)}</span></div>
      )}
      {!finished && at >= 1 && now - live.started > (live.judged ? 10 : 3) * 60000 && (
        <p className="warn">Studio Next is answering slowly or is unavailable right now · nothing is lost · this keeps checking and updates by itself · you can close this and come back</p>
      )}
      {hash && <a className="tx" href={EXPLORER_TX + hash} target="_blank" rel="noreferrer">{hash.slice(0, 10)}…{hash.slice(-6)} ↗</a>}
      <div className="next">
        {live.open && onOpen && !live.error && <button className={`btn${finished ? " pulse" : ""}`} type="button" onClick={() => onOpen(live.open!)}>{live.judged && !finished ? "Open live timeline" : "Open the timeline"}</button>}
        {onClose && <button className={`btn${finished ? " hot" : ""}`} type="button" onClick={onClose}>{finished ? "Done" : compact ? "Show details" : "Hide · keep it running"}</button>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- owner: create a vault in 4 steps

export function CreateVault({ wallet, balance, agentKey, agentBalance, disabled, onAgentKey, onFundAgent, onSubmit }: {
  wallet: ConnectedWallet | null; balance: bigint | null; agentKey: AgentKey | null; agentBalance: bigint | null; disabled: boolean;
  onAgentKey: (k: AgentKey | null) => void; onFundAgent: (amount: bigint) => void;
  onSubmit: (id: string, agent: string, mandate: string, cap: bigint, totalCap: bigint, allowlist: string[], deposit: bigint) => void;
}) {
  const [agentMode, setAgentMode] = useState<"key" | "external">("key");
  const [external, setExternal] = useState("");
  const [mandate, setMandate] = useState(MANDATE_TEMPLATES[0].text);
  const [templateAsk, setTemplateAsk] = useState<number | null>(null);
  const [capText, setCapText] = useState("2");
  const [totalCap, setTotalCap] = useState("");
  const [allowlistText, setAllowlistText] = useState("");
  const [deposit, setDeposit] = useState("1");
  const [keyError, setKeyError] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [importText, setImportText] = useState("");
  const capWei = parseGen(capText);
  const totalWei = totalCap.trim() === "" ? ZERO : parseGen(totalCap);
  const depositWei = parseGen(deposit);
  const allow = parseAllowlist(allowlistText);
  const agent = agentMode === "key" ? agentKey?.address ?? "" : external.trim();
  const capMismatch = mandateCapMismatch(mandate, capWei);
  const template = MANDATE_TEMPLATES.findIndex((t) => t.text === mandate);

  const errors = [
    !wallet && "Connect a wallet first",
    agentMode === "key" && !agentKey && "Create the agent key in step 1, or pick another agent's address",
    agentMode === "external" && !isAddress(external) && "Agent must be a wallet address (0x + 40 hex characters)",
    wallet && agent && agent.toLowerCase() === wallet.address.toLowerCase() && "The agent must be a different address from your wallet (the vault refuses owner = agent)",
    mandate.trim() === "" && "Write a mandate",
    mandate.length > MAX_MANDATE && `Mandate is ${mandate.length - MAX_MANDATE} characters too long`,
    (capWei === null || capWei <= ZERO) && "Max per payment must be a positive GEN amount (up to 18 decimals)",
    totalWei === null && "Total spend cap must be a GEN amount or empty",
    totalWei !== null && totalWei > ZERO && capWei !== null && totalWei < capWei && "Total spend cap is lower than the max per payment",
    allow.invalid.length > 0 && `Not an address: ${allow.invalid[0]}`,
    allow.addresses.length > MAX_ALLOWLIST && `At most ${MAX_ALLOWLIST} allowlisted payees`,
    agent && allow.addresses.includes(agent.toLowerCase()) && "The agent cannot be on the payee allowlist",
    (depositWei === null || depositWei < MIN_DEPOSIT) && `Deposit must be at least ${formatGen(MIN_DEPOSIT)} GEN`,
    depositWei !== null && depositWei > MAX_DEPOSIT && `Deposit is limited to ${formatGen(MAX_DEPOSIT)} GEN on this test site`,
    depositWei !== null && balance !== null && depositWei >= balance && `Your wallet has ${formatGen(balance)} GEN · keep some for fees · use Get test GEN`,
  ].filter(Boolean) as string[];

  function pickTemplate(i: number) {
    if (template >= 0 || mandate.trim() === "") return setMandate(MANDATE_TEMPLATES[i].text);
    setTemplateAsk(i);
  }

  return (
    <form className="box" onSubmit={(e) => { e.preventDefault(); if (!errors.length && capWei && depositWei && totalWei !== null) onSubmit(newId("vault"), agent, mandate.trim(), capWei, totalWei, allow.addresses, depositWei); }}>
      <h3>Create a vault</h3>
      <div className="fstep"><div className="n">1</div><div className="body">
        <h4>Who may request payments</h4>
        <div className="opts">
          <button type="button" className="opt" aria-pressed={agentMode === "key"} onClick={() => setAgentMode("key")}><b>Agent key in this browser</b>Try the agent role yourself</button>
          <button type="button" className="opt" aria-pressed={agentMode === "external"} onClick={() => setAgentMode("external")}><b>Another agent&apos;s address</b>A real agent, for example via MCP</button>
        </div>
        {agentMode === "key" ? (
          agentKey ? (
            <>
              <details className="more">
                <summary>Agent key <Short id={agentKey.address} /> · {agentBalance === null ? "…" : `${formatGen(agentBalance)} GEN`} · back up or remove this key</summary>
                <p className="warn">Test only · the key is stored unencrypted in this browser&apos;s local storage · anyone with access to this browser profile can use it · never put real funds on it</p>
                {showKey ? <code className="secret">{agentKey.privateKey}</code> : <button type="button" className="link" onClick={() => setShowKey(true)}>Show private key for backup</button>}
                <button type="button" className="link" onClick={() => { forgetAgentKey(); onAgentKey(null); setShowKey(false); }}>Remove key from this browser</button>
              </details>
              {(agentBalance ?? ZERO) < GEN / BigInt(5) && (
                <button type="button" className="btn amber" disabled={!wallet || disabled} onClick={() => onFundAgent(AGENT_FUNDING)}>Send {formatGen(AGENT_FUNDING)} GEN from your wallet for its fees</button>
              )}
            </>
          ) : (
            <>
              <p className="warn">This creates a test-only wallet whose key stays in this browser · local storage · unencrypted · back it up if you want to keep it · never use it for real funds</p>
              <div className="next">
                <button type="button" className="btn amber" onClick={() => { try { onAgentKey(createAgentKey()); setKeyError(null); } catch (e) { setKeyError(errorText(e)); } }}>Create agent key</button>
              </div>
              <details className="more">
                <summary>Restore a backed-up agent key</summary>
                <input aria-label="Agent private key" value={importText} onChange={(e) => setImportText(e.target.value)} placeholder="0x… (64 hex characters)" spellCheck={false} autoComplete="off" />
                <button type="button" className="link" onClick={() => { try { onAgentKey(importAgentKey(importText)); setImportText(""); setKeyError(null); } catch (e) { setKeyError(errorText(e)); } }}>Restore</button>
              </details>
              {keyError && <p className="warn err">{keyError}</p>}
            </>
          )
        ) : (
          <input aria-label="Agent wallet address" value={external} onChange={(e) => setExternal(e.target.value)} placeholder="0x…" spellCheck={false} />
        )}
      </div></div>

      <div className="fstep"><div className="n">2</div><div className="body">
        <h4>Mandate · judged by GenLayer</h4>
        <div className="tpl" role="group" aria-label="Mandate templates">{MANDATE_TEMPLATES.map((t, i) => <button type="button" className="btn" key={t.name} aria-pressed={template === i} onClick={() => pickTemplate(i)}>{t.name}</button>)}</div>
        {templateAsk !== null && (
          <p className="note2" role="alert">
            Replace your mandate text with the {MANDATE_TEMPLATES[templateAsk].name} template?{" "}
            <button type="button" className="link" onClick={() => { setMandate(MANDATE_TEMPLATES[templateAsk].text); setTemplateAsk(null); }}>Replace</button>{" · "}
            <button type="button" className="link" onClick={() => setTemplateAsk(null)}>Keep mine</button>
          </p>
        )}
        <div className="field"><label htmlFor="tg-mandate">Mandate text</label><span className={`count${mandate.length > MAX_MANDATE ? " over" : ""}`}>{mandate.length.toLocaleString("en-US")} / {MAX_MANDATE.toLocaleString("en-US")}</span></div>
        <textarea id="tg-mandate" rows={3} value={mandate} onChange={(e) => setMandate(e.target.value)} />
      </div></div>

      <div className="fstep"><div className="n">3</div><div className="body">
        <h4>Limits · enforced instantly</h4>
        <div className="two">
          <div><label htmlFor="tg-cap">Max per payment · GEN</label><input id="tg-cap" value={capText} onChange={(e) => setCapText(e.target.value)} inputMode="decimal" /></div>
          <div><label htmlFor="tg-dep">Deposit now · GEN{balance !== null && <> · wallet {formatGen(balance)}</>}</label><input id="tg-dep" value={deposit} onChange={(e) => setDeposit(e.target.value)} inputMode="decimal" /></div>
        </div>
        {capMismatch && <p className="warn">Your mandate mentions {capMismatch} GEN, but the enforced max per payment is {capText} GEN · only the number is checked deterministically · the text is judged by validators</p>}
        <details className="more">
          <summary>Optional · total cap · payee allowlist</summary>
          <label htmlFor="tg-total">Total spend cap for the vault · GEN · empty = none</label>
          <input id="tg-total" value={totalCap} onChange={(e) => setTotalCap(e.target.value)} inputMode="decimal" placeholder="e.g. 10" />
          <label htmlFor="tg-allow">Payee allowlist · addresses separated by commas or new lines · empty = any payee</label>
          <textarea id="tg-allow" rows={2} value={allowlistText} onChange={(e) => setAllowlistText(e.target.value)} spellCheck={false} />
        </details>
      </div></div>

      <div className="fstep"><div className="n">4</div><div className="body">
        <h4>Create</h4>
        <div className="summary">Agent <b>{agent ? <Short id={agent} /> : "not set"}</b> · {template >= 0 ? MANDATE_TEMPLATES[template].name.toLowerCase() : "your own"} mandate · max <b>{capWei ? formatGen(capWei) : "?"} GEN</b> per payment · {totalWei && totalWei > ZERO ? <><b>{formatGen(totalWei)} GEN</b> in total</> : "no total cap"} · {allow.addresses.length ? `${allow.addresses.length} allowlisted payee(s)` : "any payee"} · deposit <b>{depositWei ? formatGen(depositWei) : "?"} GEN</b></div>
        {errors.length > 0 && <p className="warn err" role="status">{errors[0]}</p>}
        <button className="btn hot" disabled={disabled || errors.length > 0}>Review and create vault</button>
      </div></div>
    </form>
  );
}

// ---------------------------------------------------------------- owner: vault cards with history

export function VaultCards({ vaults, wallet, book, disabled, onTopUp, onReclaim, onOpen }: { vaults: Vault[]; wallet: ConnectedWallet | null; book: NegotiationBook; disabled: boolean; onTopUp: (v: Vault, amount: bigint) => void; onReclaim: (v: Vault, amount: bigint) => void; onOpen: (id: string) => void }) {
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  return (
    <div className="box">
      <h3>Your vaults</h3>
      {!wallet && <div className="empty">Connect a wallet to see the vaults you own · they come from the chain, so they are here on any device</div>}
      {wallet && vaults.length === 0 && <div className="empty">No vault yet · create one on the left</div>}
      {[...vaults].reverse().map((v) => {
        const amount = parseGen(amounts[v.vaultId] ?? "1");
        const paid = v.requests.filter((r) => r.released);
        const byPayee = new Map<string, bigint>();
        for (const r of paid) byPayee.set(r.payee, (byPayee.get(r.payee) ?? ZERO) + r.amount);
        const taken = v.deposited - v.funds - v.released;
        const negs = [...book.negotiations.values()].filter((n) => n.vaultId === v.vaultId).reverse();
        const share = typeof window === "undefined" ? "" : `${window.location.origin}/?seller=${encodeURIComponent(v.vaultId)}`;
        return (
          <div key={v.vaultId} className="vault">
            <div className="vid"><code title={v.vaultId}>{v.vaultId}</code><CopyButton text={v.vaultId} /><CopyButton text={share} label="Share with seller" /></div>
            <p className="note2">Send this vault id to the seller · they need it to post an offer · the link opens the Seller tab with it filled in</p>
            <div className="balance">
              {v.deposited !== v.funds ? <><s>{formatGen(v.deposited)} GEN</s> → <em>{formatGen(v.funds)} GEN</em></> : <em>{formatGen(v.funds)} GEN</em>} in the vault
              {[...byPayee].map(([payee, amt]) => <span key={payee}> · {formatGen(amt)} paid to <Short id={payee} /></span>)}
              {taken > ZERO && <span> · {formatGen(taken)} taken back to your credit</span>}
            </div>
            <p className="note2">Agent <Short id={v.agent} /> · max {formatGen(v.cap)} GEN per payment{v.totalCap > ZERO ? ` · ${formatGen(v.totalCap)} GEN in total` : ""}</p>
            <div className="inline">
              <input aria-label={`Amount for ${v.vaultId}`} value={amounts[v.vaultId] ?? "1"} onChange={(e) => setAmounts({ ...amounts, [v.vaultId]: e.target.value })} inputMode="decimal" />
              <button type="button" className="btn" disabled={disabled || !amount || amount <= ZERO} onClick={() => amount && onTopUp(v, amount)}>Deposit</button>
              <button type="button" className="btn" disabled={disabled || !amount || amount <= ZERO || amount > v.funds} onClick={() => amount && onReclaim(v, amount)}>Take back</button>
            </div>
            <h3 className="sub-h">History of this vault</h3>
            {negs.length === 0 ? <div className="empty">No offers yet · share the vault id with a seller</div> : <div className="mine-list">{negs.map((n) => <NegCard key={n.negotiationId} n={n} id={n.negotiationId} meta={<>{n.latest.terms.slice(0, 60)} · {formatGen(n.latest.amount)} GEN</>} onOpen={onOpen} />)}</div>}
          </div>
        );
      })}
      {wallet && vaults.length > 0 && <p className="note2">Take back moves GEN from the vault to your credit inside the contract · withdraw it under Credit</p>}
    </div>
  );
}

// ---------------------------------------------------------------- credit inside the contract, explained

export function Credits({ ledger, events, wallet, agentKey, disabled, onWithdraw }: { ledger: Ledger; events: FeedEvent[]; wallet: ConnectedWallet | null; agentKey: AgentKey | null; disabled: boolean; onWithdraw: (who: "wallet" | "key", amount: bigint) => void }) {
  const [lookup, setLookup] = useState("");
  const rows: Array<{ who: "wallet" | "key" | "lookup"; label: string; address: string }> = [];
  if (wallet) rows.push({ who: "wallet", label: "Your wallet", address: wallet.address.toLowerCase() });
  if (agentKey) rows.push({ who: "key", label: "Your agent key", address: agentKey.address.toLowerCase() });
  if (isAddress(lookup)) rows.push({ who: "lookup", label: "Looked-up address", address: lookup.trim().toLowerCase() });
  // Where each credit came from: payouts for accepted offers, GEN taken back from own vaults, refunded deposits.
  const sources = (addr: string) => {
    const out: string[] = [];
    for (const v of ledger.vaults) for (const r of v.requests) if (r.released && r.payee === addr) out.push(`${formatGen(r.amount)} GEN paid by vault ${v.vaultId.slice(0, 10)}… for an accepted offer`);
    for (const e of events) if (e.method === "owner_reclaim" && e.from.toLowerCase() === addr && /"ok":\s*true/.test(e.returned ?? "")) out.push(`${formatGen(BigInt(String(e.args[1] ?? "0")))} GEN taken back from vault ${String(e.args[0]).slice(0, 10)}…`);
    const withdrawn = ledger.withdrawals.filter((w) => w.from.toLowerCase() === addr).length;
    if (withdrawn) out.push(`${withdrawn} withdraw call${withdrawn === 1 ? "" : "s"} so far`);
    return out;
  };
  return (
    <div className="box">
      <h3>Credit inside TrustGate</h3>
      <p className="note2">When GenLayer accepts, the vault pays the seller by crediting them inside the vault contract · owners get credit when they take GEN back · withdrawing to a wallet sends a GenLayer transfer that on Studio Next (61997) has not arrived in our tests · <a href={REPO + "/blob/main/experiments/PAYOUT_INVESTIGATION.md"} target="_blank" rel="noreferrer">payout investigation</a></p>
      {rows.map((r) => {
        const credit = ledger.credits.get(r.address) ?? ZERO;
        const src = sources(r.address);
        return (
          <div key={r.who + r.address} className="card c-acc">
            <div className="card-head"><b>{r.label}</b><span><Short id={r.address} /> · {formatGen(credit)} GEN to withdraw</span></div>
            {credit === ZERO && src.length === 0 ? <p className="note2">Nothing credited to this address yet</p> : <ul className="sources">{src.map((s, i) => <li key={i}>{s}</li>)}</ul>}
            {r.who !== "lookup" && credit > ZERO && <div className="next"><button type="button" className="btn" disabled={disabled} onClick={() => onWithdraw(r.who as "wallet" | "key", credit)}>Withdraw {formatGen(credit)} GEN</button></div>}
          </div>
        );
      })}
      <label htmlFor="tg-payee">Check any payee address</label>
      <input id="tg-payee" value={lookup} onChange={(e) => setLookup(e.target.value)} placeholder="0x…" spellCheck={false} />
    </div>
  );
}

// ---------------------------------------------------------------- agent

export function AgentPanel({ agentKey, agentBalance, wallet, vaults, vault, onSelect }: { agentKey: AgentKey | null; agentBalance: bigint | null; wallet: ConnectedWallet | null; vaults: Vault[]; vault: Vault | null; onSelect: (id: string) => void }) {
  return (
    <div className="box">
      <h3>Act as the agent</h3>
      {!agentKey && !wallet ? (
        <div className="empty">Create an agent key in the Owner tab, or connect the agent&apos;s wallet, to submit requests</div>
      ) : (
        <>
          <p className="note2">Signing as {agentKey ? <>your browser agent key <Short id={agentKey.address} /> · {agentBalance === null ? "…" : `${formatGen(agentBalance)} GEN`}</> : <>your connected wallet <Short id={wallet!.address} /></>}{vault && <> · vault <Short id={vault.vaultId} /></>}</p>
          {agentKey && (agentBalance ?? ZERO) === ZERO && <p className="warn">The agent key has no GEN for fees · in the Owner tab click Send {formatGen(AGENT_FUNDING)} GEN from your wallet for its fees</p>}
          {vaults.length === 0 ? (
            <div className="empty">No vault on this contract lists this address as its agent yet · create one in the Owner tab</div>
          ) : vaults.length > 1 ? (
            <>
              <label htmlFor="tg-agent-vault">Vault</label>
              <select id="tg-agent-vault" value={vault?.vaultId} onChange={(e) => onSelect(e.target.value)}>{vaults.map((v) => <option key={v.vaultId} value={v.vaultId}>{v.vaultId} · {formatGen(v.funds)} GEN</option>)}</select>
            </>
          ) : null}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- feed (modal content)

export type FeedState = { events: FeedEvent[]; fetchedAt: string | null; source: string; error: string | null; stale: boolean; loading: boolean };

export function FeedPane({ feed, ledger, book, contract, selected, onContract, onSelect, onOpen, onRetry }: { feed: FeedState; ledger: Ledger; book: NegotiationBook; contract: string; selected: string | null; onContract: (c: string) => void; onSelect: (v: string) => void; onOpen: (id: string) => void; onRetry: () => void }) {
  const current = ledger.vaults.find((v) => v.vaultId === selected) ?? ledger.vaults[ledger.vaults.length - 1] ?? null;
  const time = feed.fetchedAt ? new Date(feed.fetchedAt).toLocaleTimeString() : null;
  const label = (s: string) => s.replace(/\s*\(([^)]*)\)/g, " · $1");
  return (
    <div className="pane">
      <div className="feedhead">
        <span>{feed.loading && !time ? "loading…" : `${ledger.vaults.length} vault${ledger.vaults.length === 1 ? "" : "s"}`}{time && ` · updated ${time}${feed.stale ? " (stale)" : ""}`}{feed.source && ` · ${feed.source}`}</span>
        {feed.error ? <span className="bad">History did not load · retrying</span> : <span className="live"><i />Live · every few seconds</span>}
      </div>
      <div className="tabs sub wrap" role="tablist" aria-label="Contract">
        {VAULT_CONTRACTS.map((c) => <button key={c.address} className="tab" role="tab" aria-selected={contract === c.address} onClick={() => onContract(c.address)} title={c.note}>{label(c.label)}</button>)}
      </div>
      <p className="note2">Contract <a href={EXPLORER_ADDRESS + contract} target="_blank" rel="noreferrer"><Short id={contract} /></a> · {VAULT_CONTRACTS.find((c) => c.address === contract)?.note}</p>
      {feed.error && <p className="warn err" role="status">Studio Next history did not load ({feed.error}) · {feed.stale ? "showing the last good snapshot · " : ""}retrying · <button className="link" type="button" onClick={onRetry}>Retry now</button></p>}
      {ledger.vaults.length > 1 && (
        <div className="tabs sub wrap" role="tablist" aria-label="Vault">
          {[...ledger.vaults].reverse().map((v) => <button key={v.vaultId} className="tab" role="tab" aria-selected={v.vaultId === current?.vaultId} onClick={() => onSelect(v.vaultId)} title={v.vaultId}>{v.vaultId.length > 22 ? `${v.vaultId.slice(0, 12)}…${v.vaultId.slice(-6)}` : v.vaultId}</button>)}
        </div>
      )}
      {current ? <VaultView vault={current} book={book} onOpen={onOpen} /> : feed.loading ? <p className="note2">Loading the contract history from Studio Next…</p> : !feed.error ? <p className="note2">No vaults on this contract yet</p> : null}
    </div>
  );
}

function VaultView({ vault, book, onOpen }: { vault: Vault; book: NegotiationBook; onOpen: (id: string) => void }) {
  const negs = [...book.negotiations.values()].filter((n) => n.vaultId === vault.vaultId).reverse();
  const loose = vault.requests.filter((r) => !r.negotiationId);
  return (
    <div className="vaultview">
      <div className="stats">
        <div><small>Vault</small><b><Short id={vault.vaultId} /></b></div>
        <div><small>Holds</small><b>{formatGen(vault.funds)} GEN</b></div>
        <div><small>Paid to sellers</small><b>{formatGen(vault.released)} GEN</b></div>
        <div><small>Max per payment</small><b>{formatGen(vault.cap)} GEN</b></div>
      </div>
      <div className="mandate"><small>Mandate · judged by validators</small><MandateLines text={vault.mandate} /></div>
      <p className="note2">Owner <Short id={vault.owner} /> · Agent <Short id={vault.agent} />{vault.allowlist.length > 0 && <> · payee allowlist: {vault.allowlist.map((a) => <Short key={a} id={a} />)}</>} · payments are credited inside the vault</p>
      {negs.length > 0 && <div className="mine-list">{negs.map((n) => <NegCard key={n.negotiationId} n={n} id={n.negotiationId} meta={<>{n.latest.terms.slice(0, 60)} · {formatGen(n.latest.amount)} GEN</>} onOpen={onOpen} />)}</div>}
      {[...loose].reverse().map((r) => <RequestCard key={r.event.hash} r={r} />)}
      {negs.length === 0 && loose.length === 0 && <p className="note2">No requests yet</p>}
    </div>
  );
}

// Requests from the earlier one-sided contracts (no negotiation).
function RequestCard({ r }: { r: VaultRequest }) {
  const j = r.event.judgment;
  const verdict = r.stage === "GENLAYER" ? j!.decision : r.stage === "DETERMINISTIC" ? "REJECT" : r.stage === "FAILED" ? "FAILED" : r.stage === "UNDETERMINED" ? "NO VERDICT" : "JUDGING";
  const tone = verdict === "ACCEPT" ? "c-acc" : verdict === "RENEGOTIATE" ? "c-ren" : verdict === "JUDGING" ? "c-prog" : "c-rej";
  const finality = isSettled(r.event.status) ? "Final" : isProvisional(r.event.status) ? "Provisional" : r.event.status.toLowerCase();
  return (
    <article className={`card ${tone}`}>
      <div className="card-head"><b>{verdict}</b><span>{formatGen(r.amount)} GEN → <Short id={r.payee} /> · {finality}</span></div>
      {r.stage === "GENLAYER" && j && <p className="reason"><strong>{cap(j.risk)} risk</strong> · {j.summary}</p>}
      {r.stage === "DETERMINISTIC" && <p className="reason"><strong>Blocked by the enforced hard limits</strong> · {r.reasons.join("; ") || "a deterministic check failed"}</p>}
      <details className="more"><summary>Deal text</summary><p className="deal">{r.dealText}</p></details>
      <p className="note2">{r.released ? `${formatGen(r.amount)} GEN credited to the payee inside the vault` : "Funds stay locked in the vault"} · <a href={EXPLORER_TX + r.event.hash} target="_blank" rel="noreferrer">view transaction</a></p>
    </article>
  );
}

// ---------------------------------------------------------------- MCP (modal content)

export function McpPane() {
  return (
    <div className="pane">
      <p className="lead">The TrustGate MCP server lets any MCP client · desktop AI apps · agent frameworks · act as either side · it never waits for minutes · slow steps return at once as pending and the agent polls</p>
      <div className="two">
        <div className="box"><h3>Buyer side · 4 tools</h3><div className="row"><b>list offers</b></div><div className="row"><b>request commitment</b><span className="g">by offer id</span></div><div className="row"><b>get verdict</b></div><div className="row"><b>vault status</b></div></div>
        <div className="box"><h3>Seller side · 6 tools</h3><div className="row"><b>post offer</b></div><div className="row"><b>get counterproposal</b></div><div className="row"><b>accept counterproposal</b></div><div className="row"><b>counter offer</b></div><div className="row"><b>decline</b></div><div className="row"><b>get negotiation</b></div></div>
      </div>
      <ol className="steps2">
        <li>In the Owner tab create an agent key and a vault · then use Back up or remove this key to copy the agent key · it is a test key · never use a key that holds real funds</li>
        <li>Get the code from <a href={REPO} target="_blank" rel="noreferrer">github.com/shoupeorg/TrustGate-V1.3</a> · then run <code>cd mcp &amp;&amp; npm install &amp;&amp; npm run build</code></li>
        <li>Open the config file of your MCP client · in desktop AI apps it is usually under Settings → Developer → Edit Config · add this and restart the client</li>
      </ol>
      <pre>{`{
  "mcpServers": {
    "trustgate": {
      "command": "node",
      "args": ["C:\\\\path\\\\to\\\\Trustgate\\\\mcp\\\\dist\\\\index.js"],
      "env": {
        "TRUSTGATE_AGENT_PRIVATE_KEY": "0x…test agent key (buyer side)…",
        "TRUSTGATE_SELLER_PRIVATE_KEY": "0x…test seller key (seller side)…",
        "TRUSTGATE_CONTRACT": "${VAULT_CONTRACTS[0].address}"
      }
    }
  }
}`}</pre>
      <p className="note2">Then ask your agent · for example: List the open offers on vault my-vault-id and request the dataset one · or · Post this offer to vault my-vault-id for 0.5 GEN · set only the key for the side you play · keys stay in that config file on your machine · the server never prints or logs them</p>
    </div>
  );
}
