"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  connectStudioNextWallet,
  discoverWalletProviders,
  walletConnectionErrorMessage,
  type ConnectedWallet,
  type DiscoveredWallet,
} from "@/lib/genlayer";
import { loadAgentKey, type AgentKey } from "@/lib/agent-key";
import {
  balanceOf,
  buildLedger,
  createVaultArgs,
  EXPLORER_ADDRESS,
  EXPLORER_TX,
  formatGen,
  GEN,
  newId,
  prepareAgentWrite,
  prepareWalletWrite,
  acceptCounterArgs,
  counterOfferArgs,
  offerRequestArgs,
  postOfferArgs,
  submitWrite,
  termsHash,
  transferFee,
  VAULT_CONTRACTS,
  ZERO,
  type FeedEvent,
  type Ledger,
  type PreparedWrite,
} from "@/lib/vault";
import { buildNegotiations, type NegotiationBook } from "@/lib/negotiation";
import { TryIt } from "@/components/try-it";
import { JudgingCards, NegotiationTimeline, OfferRequests, SellerMode } from "@/components/negotiation";
import { BenchmarkPane, headlineNumbers } from "@/components/genlayer-value";
import { startLanding } from "@/components/landing/engine";
import { NotJsonError, readJson } from "@/lib/read-json";
import { Icon, Modal, Short, ToastProvider, useToast } from "@/components/ui/kit";
import { AgentPanel, CreateVault, Credits, errorText, FeedPane, McpPane, REPO, TxModal, TxRun, VaultCards, type FeedState, type Live, type Pending } from "@/components/wallet-parts";

const FEED_TIMEOUT = 45000; // a cold server cache may need one full history download
const SNAPSHOT_KEY = "trustgate.v13.feed.";
const SITE: string = VAULT_CONTRACTS[0].address;

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

type Role = "owner" | "agent" | "seller";
type MainTab = "try" | "wallet";
type Where = "header" | "pane";
type Pop = { where: Where; kind: "picker" | "nowallet" | "account" | "looking" } | null;
type Panel = "feed" | "bench" | "mcp" | null;

// ---------------------------------------------------------------- feed (never stuck on "loading")

function useFeed(contract: string | null, every: number) {
  const [state, setState] = useState<FeedState>(() => ({ events: [], fetchedAt: null, source: "", error: null, stale: false, loading: true }));
  const failures = useRef(0);
  const refresh = useCallback(async () => {
    if (!contract) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), FEED_TIMEOUT);
    try {
      const res = await fetch(`/api/vault-feed?contract=${contract}`, { cache: "no-store", signal: controller.signal });
      const body = await readJson<{ events?: FeedEvent[]; error?: string; source?: string; fetchedAt?: string }>(res);
      if (!res.ok || body.error || !Array.isArray(body.events)) throw new Error(body.error ?? `HTTP ${res.status}`);
      const next = { events: body.events, fetchedAt: body.fetchedAt ?? new Date().toISOString(), source: body.source ?? "transaction history", error: null, stale: false, loading: false };
      failures.current = 0;
      setState(next);
      try {
        window.localStorage.setItem(SNAPSHOT_KEY + contract, JSON.stringify(next));
      } catch {}
    } catch (e) {
      const message = controller.signal.aborted ? `no answer from Studio Next within ${FEED_TIMEOUT / 1000} s` : errorText(e);
      // One failed poll with data on screen is not worth a warning; the next poll comes in a few seconds.
      if (++failures.current < 2) {
        setState((s) => (s.events.length ? s : { ...s, loading: true }));
        return;
      }
      setState((s) => {
        if (s.events.length) return { ...s, error: message, stale: true, loading: false };
        try {
          const cached = JSON.parse(window.localStorage.getItem(SNAPSHOT_KEY + contract) ?? "null") as FeedState | null;
          if (cached?.events?.length) return { ...cached, error: message, stale: true, loading: false };
        } catch {}
        return { ...s, error: message, loading: false };
      });
    } finally {
      window.clearTimeout(timer);
    }
  }, [contract]);

  useEffect(() => {
    if (!contract) return;
    const first = window.setTimeout(refresh, 0);
    const t = window.setInterval(refresh, every);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(t);
    };
  }, [refresh, contract, every]);
  return { ...state, refresh };
}

const Corners = () => (
  <>
    <i className="k tl" />
    <i className="k tr" />
    <i className="k bl" />
    <i className="k br" />
  </>
);

// ---------------------------------------------------------------- app

export function VaultApp() {
  return (
    <ToastProvider>
      <Landing />
    </ToastProvider>
  );
}

function Landing() {
  const rootRef = useRef<HTMLDivElement>(null);
  const toast = useToast();
  const [wallets, setWallets] = useState<DiscoveredWallet[] | null>(null);
  const [wallet, setWallet] = useState<ConnectedWallet | null>(null);
  const [walletBalance, setWalletBalance] = useState<bigint | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [pop, setPop] = useState<Pop>(null);
  const [faucetBusy, setFaucetBusy] = useState(false);
  const [faucetQueued, setFaucetQueued] = useState(false);
  const [agentKey, setAgentKey] = useState<AgentKey | null>(null);
  const [agentBalance, setAgentBalance] = useState<bigint | null>(null);
  const [tab, setTab] = useState<MainTab>("try");
  const [role, setRole] = useState<Role>("owner");
  const [sellerVault, setSellerVault] = useState<string | undefined>(undefined);
  const [panel, setPanel] = useState<Panel>(null);
  const [browseContract, setBrowseContract] = useState<string>(SITE);
  const [browseVault, setBrowseVault] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [live, setLive] = useState<Live | null>(null);
  const [txOpen, setTxOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [openNeg, setOpenNeg] = useState<string | null>(null);
  const [negContract, setNegContract] = useState<string>(SITE);
  const [tryRunning, setTryRunning] = useState(false);
  // The site contract is polled all the time, faster while a negotiation is open, so both sides see changes.
  const feed = useFeed(SITE, openNeg ? 4000 : 8000);
  const other = (panel === "feed" && browseContract !== SITE ? browseContract : null) ?? (openNeg && negContract !== SITE ? negContract : null);
  const otherFeed = useFeed(other, openNeg ? 4000 : 8000);

  // Scene, HUD panels, header dust and sound.
  useEffect(() => {
    if (!rootRef.current) return;
    if ("scrollRestoration" in history) history.scrollRestoration = "manual";
    if (window.location.hash) history.replaceState(null, "", window.location.pathname + window.location.search);
    window.scrollTo(0, 0);
    const onShow = () => window.scrollTo(0, 0);
    window.addEventListener("pageshow", onShow);
    const stop = startLanding(rootRef.current);
    return () => {
      stop();
      window.removeEventListener("pageshow", onShow);
    };
  }, []);

  useEffect(() => {
    const stop = discoverWalletProviders((found) => setWallets(found));
    const fallback = window.setTimeout(() => setWallets((w) => w ?? []), 1200);
    const restore = window.setTimeout(() => {
      setAgentKey(loadAgentKey());
      // Shareable links: ?negotiation=…[&contract=…] and ?seller=<vault id>
      const q = new URLSearchParams(window.location.search);
      const c = VAULT_CONTRACTS.find((x) => x.address.toLowerCase() === (q.get("contract") ?? "").toLowerCase());
      if (c) setNegContract(c.address);
      if (q.get("negotiation")) setOpenNeg(q.get("negotiation"));
      if (q.get("seller")) {
        setSellerVault(q.get("seller")!);
        setTab("wallet");
        setRole("seller");
      }
    }, 0);
    return () => {
      stop();
      window.clearTimeout(fallback);
      window.clearTimeout(restore);
    };
  }, []);

  // The header turns to dust on scroll; its popover goes with it.
  useEffect(() => {
    const onScroll = () => {
      if (window.scrollY > window.innerHeight * 0.3) setPop((p) => (p?.where === "header" ? null : p));
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const refreshBalances = useCallback(async () => {
    if (wallet) setWalletBalance(await balanceOf(wallet.address).catch(() => null));
    if (agentKey) setAgentBalance(await balanceOf(agentKey.address).catch(() => null));
  }, [wallet, agentKey]);

  useEffect(() => {
    const first = window.setTimeout(refreshBalances, 0);
    const t = window.setInterval(refreshBalances, 15000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(t);
    };
  }, [refreshBalances]);

  // Follow account / network changes made inside the wallet.
  useEffect(() => {
    const p = wallet?.provider;
    if (!p?.on) return;
    const onAccounts = (...args: unknown[]) => {
      const accounts = args[0] as string[] | undefined;
      if (!accounts?.length) {
        setWallet(null);
        setWalletError("The wallet was locked or disconnected · click Connect wallet to continue");
      } else if (accounts[0].toLowerCase() !== wallet?.address.toLowerCase()) {
        setWallet(null);
        setWalletError("You switched accounts in the wallet · click Connect wallet again to use the new account");
      }
    };
    const onChain = (...args: unknown[]) => {
      if (String(args[0]).toLowerCase() !== "0xf22d") setWalletError("Your wallet switched away from GenLayer Studio Next (61997) · click Connect wallet to switch back before signing");
    };
    p.on("accountsChanged", onAccounts);
    p.on("chainChanged", onChain);
    return () => {
      p.removeListener?.("accountsChanged", onAccounts);
      p.removeListener?.("chainChanged", onChain);
    };
  }, [wallet]);

  const ledger: Ledger = useMemo(() => buildLedger(feed.events), [feed.events]);
  const book: NegotiationBook = useMemo(() => buildNegotiations(feed.events), [feed.events]);
  const otherLedger: Ledger = useMemo(() => buildLedger(otherFeed.events), [otherFeed.events]);
  const otherBook: NegotiationBook = useMemo(() => buildNegotiations(otherFeed.events), [otherFeed.events]);
  const negBook = negContract === SITE ? book : otherBook;
  const negFeed = negContract === SITE ? feed : otherFeed;
  const negotiation = openNeg ? negBook.negotiations.get(openNeg) ?? null : null;

  const showNegotiation = (id: string, contract = SITE) => {
    setNegContract(contract);
    setOpenNeg(id);
    const url = new URL(window.location.href);
    url.searchParams.set("negotiation", id);
    if (contract !== SITE) url.searchParams.set("contract", contract);
    else url.searchParams.delete("contract");
    window.history.replaceState(null, "", url.pathname + url.search);
  };
  const closeNegotiation = () => {
    setOpenNeg(null);
    window.history.replaceState(null, "", window.location.pathname);
  };
  const me = wallet?.address.toLowerCase() ?? null;
  const agentAddr = agentKey?.address.toLowerCase() ?? null;

  async function connect(w: DiscoveredWallet) {
    setWalletError(null);
    setConnecting(w.name);
    try {
      const connected = await connectStudioNextWallet(w.provider);
      setWallet(connected);
      setPop(null);
    } catch (e) {
      const msg = walletConnectionErrorMessage(e);
      setWalletError(/valid account/i.test(msg) ? "The wallet returned no account · unlock it (open the extension and enter your password), then click Connect wallet again" : msg);
      setFaucetQueued(false);
    } finally {
      setConnecting(null);
    }
  }

  function openConnect(where: Where) {
    setWalletError(null);
    if (wallet) return setPop(pop?.kind === "account" && pop.where === where ? null : { where, kind: "account" });
    if (wallets === null) return setPop({ where, kind: "looking" });
    if (wallets.length === 0) return setPop(pop?.kind === "nowallet" && pop.where === where ? null : { where, kind: "nowallet" });
    if (wallets.length === 1) {
      setPop({ where, kind: "picker" });
      return void connect(wallets[0]);
    }
    setPop(pop?.kind === "picker" && pop.where === where ? null : { where, kind: "picker" });
  }

  const claim = useCallback(async (address: string) => {
    setFaucetBusy(true);
    const before = await balanceOf(address).catch(() => null);
    try {
      const res = await fetch("/api/test-gen", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address }) });
      const body = await readJson<{ ok: boolean; error?: string; amount?: string; hash?: string; confirmed?: boolean }>(res);
      if (!body.ok) {
        const limit = res.status === 429;
        toast({ title: limit ? "Daily limit reached" : "No test GEN sent", body: limit ? `${body.error ?? ""} · each wallet can claim 3 times a day` : body.error ?? "Faucet error", error: true });
        return;
      }
      // the transfer can take a few seconds to show up in the balance: wait for it to go up
      let after: bigint | null = null;
      for (let i = 0; i < 15; i++) {
        after = await balanceOf(address).catch(() => null);
        if (after !== null && (before === null || after > before)) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (after !== null) setWalletBalance(after);
      toast({ title: `✓ +${body.amount} GEN received`, body: after !== null && (before === null || after > before) ? `New balance ${formatGen(after)} GEN` : "The new balance shows in a moment", href: body.hash ? EXPLORER_TX + body.hash : undefined });
      window.setTimeout(() => void refreshBalances(), 6000);
    } catch (e) {
      toast({ title: "No test GEN sent", body: e instanceof NotJsonError ? e.message : `Faucet unreachable: ${errorText(e)}`, error: true });
    } finally {
      setFaucetBusy(false);
    }
  }, [refreshBalances, toast]);

  function getTestGen(where: Where) {
    if (wallet) return void claim(wallet.address);
    // No wallet yet: connect first, then claim for the connected address.
    setFaucetQueued(true);
    toast({ title: "Connect a wallet first", body: "Test GEN is sent to the connected address" });
    openConnect(where);
  }
  useEffect(() => {
    if (!wallet || !faucetQueued) return;
    const t = window.setTimeout(() => {
      setFaucetQueued(false);
      void claim(wallet.address);
    }, 0);
    return () => window.clearTimeout(t);
  }, [wallet, faucetQueued, claim]);

  async function review(label: string, done: string, prepare: () => Promise<PreparedWrite>, opts: { after?: (hash: string) => void; judged?: boolean; open?: string } = {}) {
    const { after, judged = false, open } = opts;
    setBusy(true);
    setLive(null);
    try {
      setPending({ label, done, prepared: await prepare(), after, judged, open });
      setTxOpen(true);
    } catch (e) {
      setLive({ label, done, started: Date.now(), error: `Could not estimate the fee: ${errorText(e)}` });
      setTxOpen(true);
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!pending) return;
    const { label, done, prepared, after, judged, open } = pending;
    let toasted = false;
    setPending(null);
    setBusy(true);
    const started = Date.now();
    setLive({ label, done, started, judged, open, progress: { phase: "signing" } });
    try {
      const hash = await submitWrite(SITE as `0x${string}`, prepared, (progress) => {
        setLive((l) => (l && l.started === started ? { ...l, progress, error: progress.phase === "failed" ? progress.error ?? "No verdict" : undefined } : l));
        if (progress.phase === "decided" || progress.phase === "finalized" || progress.phase === "failed") {
          void feed.refresh();
          void refreshBalances();
        }
        if (!toasted && (progress.phase === "decided" || progress.phase === "finalized")) {
          toasted = true;
          toast({ title: `✓ ${done}`, href: progress.hash ? EXPLORER_TX + progress.hash : undefined });
        }
      });
      after?.(hash);
    } catch (e) {
      const msg = walletConnectionErrorMessage(e);
      setLive({ label, done, started, open, error: /rejected|denied|4001/i.test(msg) ? "You rejected the transaction in the wallet · nothing was sent" : msg.replace(/^Wallet connection failed: /, "") });
    } finally {
      setBusy(false);
    }
  }

  // Plain GEN transfer from the owner's wallet to the browser agent key, for request fees.
  async function fundAgent(amount: bigint) {
    if (!wallet || !agentKey) return;
    const started = Date.now();
    const label = `Send ${formatGen(amount)} GEN to your agent key`;
    const done = `${formatGen(amount)} GEN on your agent key`;
    try {
      const fee = await transferFee(wallet.address, agentKey.address, amount);
      setPending(null);
      setTxOpen(true);
      setLive({ label: `${label} · network fee ${fee < GEN / BigInt(10000) ? "under 0.0001" : `about ${formatGen(fee)}`} GEN`, done, started, progress: { phase: "signing" } });
      const hash = (await wallet.provider.request({
        method: "eth_sendTransaction",
        params: [{ from: wallet.address, to: agentKey.address, value: `0x${amount.toString(16)}` }],
      } as never)) as string;
      setLive((l) => (l ? { ...l, progress: { phase: "submitted", hash } } : l));
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        if (i === 0) setLive((l) => (l ? { ...l, progress: { phase: "pending", hash } } : l));
        const bal = await balanceOf(agentKey.address).catch(() => null);
        if (bal !== null && bal >= amount) {
          setAgentBalance(bal);
          setLive((l) => (l ? { ...l, progress: { phase: "finalized", statusName: "CONFIRMED", hash } } : l));
          void refreshBalances();
          return;
        }
      }
      setLive((l) => (l ? { ...l, error: "Sent, but the agent balance has not updated yet · check the transaction link" } : l));
    } catch (e) {
      const msg = walletConnectionErrorMessage(e);
      setTxOpen(true);
      setLive({ label, done, started, error: /rejected|denied|4001/i.test(msg) ? "You rejected the transfer in the wallet · nothing was sent" : msg.replace(/^Wallet connection failed: /, "") });
    }
  }

  const ownerVaults = me ? ledger.vaults.filter((v) => v.owner === me) : [];
  const agentSigner = agentKey ? { kind: "key" as const, address: agentAddr! } : me ? { kind: "wallet" as const, address: me } : null;
  const agentVaults = agentSigner ? ledger.vaults.filter((v) => v.agent === agentSigner.address) : [];
  const agentVault = agentVaults.find((v) => v.vaultId === selected) ?? agentVaults[agentVaults.length - 1] ?? null;
  const nums = headlineNumbers();
  const txRunning = Boolean(live && !live.error && !["decided", "finalized"].includes(live.progress?.phase ?? ""));
  const sellerTurns = me ? [...book.negotiations.values()].filter((n) => n.seller === me && n.status === "OPEN" && n.latest.status === "AWAITING_SELLER").length : 0;
  const agentOpen = agentVault ? [...book.negotiations.values()].filter((n) => n.vaultId === agentVault.vaultId && n.status === "OPEN" && n.latest.status === "OPEN").length : 0;
  const walletBadge = (txRunning ? 1 : 0) + sellerTurns + agentOpen;
  const write = (method: string, args: unknown[], value?: bigint) => () => prepareWalletWrite(wallet!.provider, wallet!.address, SITE as `0x${string}`, method, args, value);

  const walletLabel = wallet ? <><span className="addr">{short(wallet.address)}</span> · {walletBalance === null ? "…" : `${formatGen(walletBalance)} GEN`}</> : connecting ? "Approve in wallet…" : "Connect wallet";
  const popFor = (where: Where) => (
    <WalletPop
      pop={pop?.where === where ? pop : null}
      error={walletError}
      wallets={wallets}
      wallet={wallet}
      connecting={connecting}
      onConnect={connect}
      onDisconnect={() => {
        setWallet(null);
        setWalletBalance(null);
        setPop(null);
      }}
      onClose={() => {
        setPop(null);
        setWalletError(null);
      }}
      onTryIt={() => {
        setPop(null);
        setTab("try");
        document.getElementById("gate")?.scrollIntoView({ behavior: "smooth" });
      }}
    />
  );

  return (
    <div className="tg" ref={rootRef}>
      <canvas id="scene" aria-hidden="true" />

      <header>
        <a className="brand" href="#top" aria-label="TrustGate V1.3" data-dust="">
          <span><b><span id="bname">TRUSTGATE</span> <em id="bpct">V1.3</em></b><small>Commitment vault · GenLayer Studio Next</small></span>
        </a>
        <nav>
          <a className="btn hide-s" href="/v1" data-dust="">Version 1</a>
          <button className="btn hide-s" type="button" data-dust="" onClick={() => getTestGen("header")} disabled={faucetBusy}>{faucetBusy ? "Sending…" : "Get test GEN"}</button>
          <button className="btn hot" type="button" data-dust="" onClick={() => openConnect("header")} aria-expanded={pop?.where === "header"}>{walletLabel}</button>
        </nav>
      </header>
      <div className="tg-pop-wrap">{popFor("header")}</div>

      <button className="snd" id="snd" type="button" aria-pressed="true"><span className="eq"><i /><i /><i /><i /></span><b>Sound on</b></button>
      <div className="meter" aria-hidden="true">Distance to gate<strong id="dist">16 m</strong><div className="bar"><i id="bar" /></div></div>

      <main id="top">
        <section className="hero">
          <div className="mouse" aria-hidden="true" data-dust="24"><i /></div>
          <div className="inner">
            <div className="tag">TrustGate V1.3</div>
            <h1>Before an Agent <span>Says Yes</span></h1>
            <p>V1 told your agent whether it <em>should</em> say yes · V1.3 makes sure it <em>can&apos;t</em> say yes without passing through the gate</p>
          </div>
        </section>

        <section>
          <div className="hud" data-panel="">
            <Corners />
            <h2 data-i="" data-type="" style={{ "--d": 0 } as React.CSSProperties}>How it works</h2>
            <div className="rule" data-i="" style={{ "--d": 1 } as React.CSSProperties} />
            <Row d={2} k="Vault" v="your funds on GenLayer" type />
            <Row d={3} k="Mandate" v="plain words" />
            <div className="rule" data-i="" style={{ "--d": 4 } as React.CSSProperties} />
            <Row d={5} k="Seller" v="signs the exact offer" />
            <Row d={6} k="Agent" v="can only request" c="p" type />
            <Row d={7} k="Hard cap" v="checked instantly" />
            <Row d={8} k="Judge" v="GenLayer validators" />
            <div className="rule" data-i="" style={{ "--d": 9 } as React.CSSProperties} />
            <div className="verdicts" data-i="" style={{ "--d": 10 } as React.CSSProperties}><span className="v a">Accept · seller credited</span><span className="v r">Renegotiate · safer terms</span><span className="v x">Reject · money stays locked</span></div>
          </div>
        </section>

        <section className="right">
          <div className="hud" data-panel="">
            <Corners />
            <h2 data-i="" data-type="" style={{ "--d": 0 } as React.CSSProperties}>Unsafe payments</h2>
            <div className="rule" data-i="" style={{ "--d": 1 } as React.CSSProperties} />
            <div className="big" data-i="" style={{ "--d": 2 } as React.CSSProperties}><div className="a"><strong>{nums.rulesUnsafe}</strong><small>Normal contract</small></div><div className="b"><strong>{nums.tgUnsafe}</strong><small>TrustGate</small></div></div>
            <div className="rule" data-i="" style={{ "--d": 3 } as React.CSSProperties} />
            <Row d={4} k="Test set" v={`${nums.scored} held-out`} />
            <Row d={5} k="Grey cases" v={`${nums.greyRules} → ${nums.greyTg}`} />
            <Row d={6} k="Injections" v={`${nums.injRules} → ${nums.injTg}`} />
            <Row d={7} k="Safe blocked" v={String(nums.tgFalse)} />
            <div className="note" data-i="" data-type="" style={{ "--d": 8 } as React.CSSProperties}>Written before any fix · never used for tuning</div>
          </div>
        </section>

        <section>
          <div className="hud" data-panel="">
            <Corners />
            <h2 data-i="" data-type="" style={{ "--d": 0 } as React.CSSProperties}>Why GenLayer</h2>
            <div className="rule" data-i="" style={{ "--d": 1 } as React.CSSProperties} />
            <Row d={2} k="Normal contract" v="can't read the deal" c="g" />
            <Row d={3} k="AI on a server" v="someone controls it" c="g" />
            <div className="rule" data-i="" style={{ "--d": 4 } as React.CSSProperties} />
            <Row d={5} k="GenLayer" v="holds money" />
            <Row d={6} k="" v="reads the deal" />
            <Row d={7} k="" v="nobody controls it" c="p" type />
            <div className="note" data-i="" style={{ "--d": 8 } as React.CSSProperties}>TrustGate has no AI of its own · the judge is GenLayer</div>
          </div>
        </section>

        <section className="right">
          <div className="hud" data-panel="">
            <Corners />
            <h2 data-i="" data-type="" style={{ "--d": 0 } as React.CSSProperties}>Two agents · one verdict</h2>
            <div className="rule" data-i="" style={{ "--d": 1 } as React.CSSProperties} />
            <Row d={2} k="Buyer agent" v="requests by offer id" />
            <Row d={3} k="Seller" v="signs every version" />
            <Row d={4} k="Renegotiate" v="terms go to seller" />
            <div className="rule" data-i="" style={{ "--d": 5 } as React.CSSProperties} />
            <Row d={6} k="Money moves" v="signed + accepted only" c="p" type />
            <div className="note" data-i="" style={{ "--d": 7 } as React.CSSProperties}>Neither side can change the terms alone</div>
          </div>
        </section>

        <section>
          <div className="hud" data-panel="">
            <Corners />
            <h2 data-i="" data-type="" style={{ "--d": 0 } as React.CSSProperties}>Limits</h2>
            <div className="rule" data-i="" style={{ "--d": 1 } as React.CSSProperties} />
            <Row d={2} k="Verdict time" v="a few minutes" />
            <Row d={3} k="Wrong accept" v="bounded by cap" />
            <Row d={4} k="Payout" v="inside the vault" />
            <Row d={5} k="Signature" v="wallet not identity" type />
            <Row d={6} k="Network" v="Studio Next · test GEN" />
          </div>
        </section>

        <section id="gate">
          <div className="gatecol">
            <div className="hud console" data-panel="">
              <Corners />
              <h2 data-i="" data-type="" style={{ "--d": 0 } as React.CSSProperties}>Send a deal through it</h2>
              <div className="rule" data-i="" style={{ "--d": 1 } as React.CSSProperties} />
              <div className="tabs main" role="tablist" aria-label="Console" data-i="" style={{ "--d": 2 } as React.CSSProperties}>
                <button className="tab" role="tab" id="tab-try" aria-controls="p-try" aria-selected={tab === "try"} onClick={() => setTab("try")}>{Icon.play}Try it · no wallet{tryRunning && <span className="badge" aria-label="running">1</span>}</button>
                <button className="tab" role="tab" id="tab-wallet" aria-controls="p-wallet" aria-selected={tab === "wallet"} onClick={() => setTab("wallet")}>{Icon.wallet}Your wallet{walletBadge > 0 && <span className="badge" aria-label={`${walletBadge} to look at`}>{walletBadge}</span>}</button>
              </div>

              <div className="panes" data-i="" style={{ "--d": 3 } as React.CSSProperties}>
                {/* TRY IT */}
                <div className="pane" role="tabpanel" id="p-try" aria-labelledby="tab-try" hidden={tab !== "try"}>
                  <TryIt book={book} onOpenNegotiation={(id) => showNegotiation(id)} onRunning={setTryRunning} />
                </div>

                {/* YOUR WALLET */}
                <div className="pane" role="tabpanel" id="p-wallet" aria-labelledby="tab-wallet" hidden={tab !== "wallet"}>
                  <div className="walletbar">
                    <span className="wstat">{wallet ? <>Connected <Short id={wallet.address} /> · {walletBalance === null ? "…" : `${formatGen(walletBalance)} GEN`} · Studio Next 61997</> : "No wallet connected · MetaMask or Rabby · the Studio Next network (chain 61997) is added automatically"} · Get test GEN gives 2 GEN, up to 3 times per wallet per day</span>
                    <span className="three">
                      <button className="btn" type="button" onClick={() => getTestGen("pane")} disabled={faucetBusy}>{faucetBusy ? "Sending…" : "Get test GEN"}</button>
                      <button className="btn hot" type="button" onClick={() => openConnect("pane")} aria-expanded={pop?.where === "pane"}>{wallet ? "Wallet" : walletLabel}</button>
                    </span>
                  </div>
                  {popFor("pane")}
                  {walletError && !(pop?.where === "pane") && <p className="warn err" role="alert">{walletError}</p>}

                  <div className="flow" aria-label="How a payment flows">
                    <div>Buyer&apos;s agent<small>asks to pay</small></div><i>→</i>
                    <div>Seller<small>signed offer</small></div><i>→</i>
                    <div className="g">GenLayer<small>judges vs mandate</small></div><i>→</i>
                    <div>Owner&apos;s vault<small>pays only on accept</small></div>
                  </div>

                  <div className="tabs sub" role="tablist" aria-label="Role">
                    {([["owner", "Owner", 0], ["agent", "Agent · buyer", agentOpen], ["seller", "Seller", sellerTurns]] as const).map(([id, label, n]) => (
                      <button key={id} className="tab" role="tab" aria-selected={role === id} onClick={() => setRole(id)}>{label}{n > 0 && <span className="badge">{n}</span>}</button>
                    ))}
                  </div>

                  {live && !txOpen && <TxRun live={live} compact onClose={txRunning ? () => setTxOpen(true) : () => setLive(null)} onOpen={(id) => showNegotiation(id)} />}

                  {role === "seller" ? (
                    <SellerMode
                      me={me}
                      vaults={ledger.vaults}
                      book={book}
                      disabled={busy || !wallet}
                      prefillVault={sellerVault}
                      onOpen={(id) => showNegotiation(id)}
                      onPost={(vaultId, amount, terms) => {
                        const offerId = newId("offer");
                        review("Post offer", `Offer ${short(offerId)} posted to the vault`, write("post_offer", postOfferArgs(offerId, vaultId, amount, terms)), { open: offerId });
                      }}
                      onAccept={(o) => review(`Sign the counterproposal as v${o.version + 1}`, `v${o.version + 1} signed · the buyer's agent can request it now`, write("accept_counterproposal", acceptCounterArgs(newId("offer"), o.offerId, o.counterproposal!.dealText)), { open: o.negotiationId })}
                      onCounter={(o, amount, terms) => review(`Sign counter offer v${o.version + 1}`, `Counter offer v${o.version + 1} signed`, write("counter_offer", counterOfferArgs(newId("offer"), o.offerId, amount, terms)), { open: o.negotiationId })}
                      onDecline={(o, reason) => review("Decline the negotiation", "Negotiation declined · no funds moved", write("decline", [o.offerId, reason]), { open: o.negotiationId })}
                    />
                  ) : role === "owner" ? (
                    <div className="formgrid">
                      <CreateVault
                        wallet={wallet}
                        balance={walletBalance}
                        agentKey={agentKey}
                        agentBalance={agentBalance}
                        disabled={busy}
                        onAgentKey={setAgentKey}
                        onFundAgent={fundAgent}
                        onSubmit={(id, agent, mandate, cap, totalCap, allowlist, deposit) =>
                          review("Create vault", `Vault ${id} created · it holds ${formatGen(deposit)} GEN`, write("create_vault", createVaultArgs(id, agent, mandate, cap, totalCap, allowlist), deposit), { after: () => setSelected(id) })}
                      />
                      <div className="stack">
                        <VaultCards
                          vaults={ownerVaults}
                          wallet={wallet}
                          book={book}
                          disabled={busy}
                          onOpen={(id) => showNegotiation(id)}
                          onTopUp={(v, amount) => review(`Deposit into ${short(v.vaultId)}`, `${formatGen(amount)} GEN added to the vault`, write("top_up", [v.vaultId], amount))}
                          onReclaim={(v, amount) => review(`Take ${formatGen(amount)} GEN back from ${short(v.vaultId)}`, `${formatGen(amount)} GEN moved to your credit inside the contract`, write("owner_reclaim", [v.vaultId, amount]))}
                        />
                        <Credits ledger={ledger} events={feed.events} wallet={wallet} agentKey={agentKey} disabled={busy} onWithdraw={(who, amount) => review(`Withdraw ${formatGen(amount)} GEN`, `Withdraw sent for ${formatGen(amount)} GEN`, () => (who === "key" ? prepareAgentWrite(agentKey!.privateKey, "withdraw", [amount]) : prepareWalletWrite(wallet!.provider, wallet!.address, SITE as `0x${string}`, "withdraw", [amount])))} />
                      </div>
                    </div>
                  ) : (
                    <div className="formgrid">
                      <div className="stack">
                        <AgentPanel agentKey={agentKey} agentBalance={agentBalance} wallet={wallet} vaults={agentVaults} vault={agentVault} onSelect={setSelected} />
                        {agentVault && <JudgingCards vault={agentVault} book={book} onOpen={(id) => showNegotiation(id)} />}
                        {agentVault && agentSigner && (
                          <OfferRequests
                            vault={agentVault}
                            book={book}
                            disabled={busy || (agentSigner.kind === "key" && (agentBalance ?? ZERO) === ZERO)}
                            onOpen={(id) => showNegotiation(id)}
                            onRequest={(offer, justification) =>
                              review(`Request payment for offer v${offer.version}`, "Verdict reached · see the timeline", async () => {
                                const args = offerRequestArgs(newId("req"), agentVault.vaultId, offer.offerId, await termsHash(offer.terms), justification);
                                return agentSigner.kind === "key" ? prepareAgentWrite(agentKey!.privateKey, "request_commitment", args) : prepareWalletWrite(wallet!.provider, wallet!.address, SITE as `0x${string}`, "request_commitment", args);
                              }, { judged: true, open: offer.negotiationId })}
                          />
                        )}
                      </div>
                      <Credits ledger={ledger} events={feed.events} wallet={wallet} agentKey={agentKey} disabled={busy} onWithdraw={(who, amount) => review(`Withdraw ${formatGen(amount)} GEN`, `Withdraw sent for ${formatGen(amount)} GEN`, () => (who === "key" ? prepareAgentWrite(agentKey!.privateKey, "withdraw", [amount]) : prepareWalletWrite(wallet!.provider, wallet!.address, SITE as `0x${string}`, "withdraw", [amount])))} />
                    </div>
                  )}
                </div>
              </div>
              <p className="note2 foot"><a href="/v1">Version 1 · the deal inspector</a> · <a href={REPO} target="_blank" rel="noreferrer">Source code</a> · <a href={REPO + "/blob/main/experiments/PAYOUT_INVESTIGATION.md"} target="_blank" rel="noreferrer">Payout investigation</a> · contract reads failed on Studio Next during development, so this page rebuilds vault state from the transaction history</p>
            </div>

            <div className="launch" aria-label="More">
              <button className="ltile" type="button" onClick={() => setPanel("feed")}>{Icon.pulse}<span><b>Live feed</b><small><i className="ld" />Every verdict on the contract · live</small></span><em>Open ↗</em></button>
              <button className="ltile" type="button" onClick={() => setPanel("bench")}>{Icon.bars}<span><b>Benchmark</b><small>Unsafe payments {nums.rulesUnsafe} → {nums.tgUnsafe}</small></span><em>Open ↗</em></button>
              <button className="ltile" type="button" onClick={() => setPanel("mcp")}>{Icon.code}<span><b>MCP for agents</b><small>Plug any agent into TrustGate</small></span><em>Open ↗</em></button>
            </div>
          </div>
        </section>
      </main>

      <Modal open={panel === "feed"} onClose={() => setPanel(null)} title="Live feed" wide labelledBy="m-feed">
        <FeedPane
          feed={browseContract === SITE ? feed : otherFeed}
          ledger={browseContract === SITE ? ledger : otherLedger}
          book={browseContract === SITE ? book : otherBook}
          contract={browseContract}
          selected={browseVault}
          onContract={(c) => { setBrowseContract(c); setBrowseVault(null); }}
          onSelect={setBrowseVault}
          onOpen={(id) => { setPanel(null); showNegotiation(id, browseContract); }}
          onRetry={() => void (browseContract === SITE ? feed : otherFeed).refresh()}
        />
        <div className="next"><button className="btn" type="button" onClick={() => setPanel(null)}>Close</button></div>
      </Modal>
      <Modal open={panel === "bench"} onClose={() => setPanel(null)} title="Benchmark" wide labelledBy="m-bench">
        <div className="bstats">
          <div><b>{nums.rulesUnsafe} → {nums.tgUnsafe}</b><span>Unsafe payments · normal contract vs TrustGate</span></div>
          <div><b>{nums.scored}</b><span>Held-out test cases</span></div>
          <div><b>{nums.greyRules} → {nums.greyTg}</b><span>Grey cases caught</span></div>
          <div><b>{nums.injRules} → {nums.injTg}</b><span>Injections caught</span></div>
        </div>
        <BenchmarkPane />
        <div className="next"><button className="btn" type="button" onClick={() => setPanel(null)}>Close</button></div>
      </Modal>
      <Modal open={panel === "mcp"} onClose={() => setPanel(null)} title="MCP for agents" wide labelledBy="m-mcp">
        <McpPane />
        <div className="next"><button className="btn" type="button" onClick={() => setPanel(null)}>Close</button></div>
      </Modal>
      <Modal open={Boolean(openNeg)} onClose={closeNegotiation} title="One negotiation · both sides · one verdict" wide labelledBy="neg-title">
        <div id="negotiation">
          {openNeg && <NegotiationTimeline n={negotiation} id={openNeg} contract={negContract !== SITE ? negContract : undefined} fetchedAt={negFeed.fetchedAt} loading={negFeed.loading} onClose={closeNegotiation} />}
        </div>
      </Modal>
      <TxModal open={txOpen} pending={pending} live={live} onOpen={(id) => { setTxOpen(false); showNegotiation(id); }} onConfirm={confirm} onCancel={() => { setPending(null); setTxOpen(false); }} onClose={() => { setTxOpen(false); if (live && !txRunning) setLive(null); }} />
    </div>
  );
}

function Row({ d, k, v, c, type }: { d: number; k: string; v: string; c?: "p" | "g" | "y"; type?: boolean }) {
  return (
    <div className="row" data-i="" style={{ "--d": d } as React.CSSProperties}>
      <b>{k}</b>
      <span className={c} data-type={type ? "" : undefined}>{v}</span>
    </div>
  );
}

// ---------------------------------------------------------------- wallet

function WalletPop({ pop, error, wallets, wallet, connecting, onConnect, onDisconnect, onClose, onTryIt }: {
  pop: Pop; error: string | null; wallets: DiscoveredWallet[] | null; wallet: ConnectedWallet | null; connecting: string | null;
  onConnect: (w: DiscoveredWallet) => void; onDisconnect: () => void; onClose: () => void; onTryIt: () => void;
}) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!connecting) return;
    const t = window.setTimeout(() => setSlow(true), 12000);
    return () => {
      window.clearTimeout(t);
      setSlow(false);
    };
  }, [connecting]);
  if (!pop) return null;
  return (
    <div className="tg-pop" role="status">
      {pop.kind === "looking" && <p className="note2">Looking for browser wallets…</p>}
      {pop.kind === "nowallet" && (
        <p className="note2"><b>No browser wallet found</b> · install <a href="https://metamask.io/download/" target="_blank" rel="noreferrer">MetaMask</a> or <a href="https://rabby.io/" target="_blank" rel="noreferrer">Rabby</a> · reload this page · then click Connect wallet · the GenLayer Studio Next network (chain 61997) is added automatically · no wallet? <button className="link" type="button" onClick={onTryIt}>Use Try it</button></p>
      )}
      {pop.kind === "picker" && !wallet && wallets && (
        <div className="three">
          {wallets.slice(0, 3).map((w) => (
            <button key={w.id} className="btn" type="button" onClick={() => onConnect(w)} disabled={Boolean(connecting)}>
              {connecting === w.name ? "Approve in wallet…" : `Connect ${w.name}`}<small>Studio Next · 61997</small>
            </button>
          ))}
        </div>
      )}
      {pop.kind === "picker" && connecting && slow && <p className="note2">No popup? Click the {connecting} icon in your browser toolbar · it may be waiting for you to unlock it or approve the network</p>}
      {pop.kind === "account" && wallet && (
        <div className="three">
          <a className="btn" href={EXPLORER_ADDRESS + wallet.address} target="_blank" rel="noreferrer">{short(wallet.address)} ↗</a>
          <button className="btn" type="button" onClick={onDisconnect}>Disconnect</button>
        </div>
      )}
      {error && <p className="warn err" role="alert">{error}</p>}
      <button className="link close" type="button" onClick={onClose} aria-label="Close">Close</button>
    </div>
  );
}
