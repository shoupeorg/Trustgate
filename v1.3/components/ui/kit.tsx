"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

// ---------------------------------------------------------------- ids: short form, copy on click, full id in the tooltip

// 0x addresses and hashes: first 6 … last 4; prefixed ids keep the prefix and 4 more characters (offer-mvb6…3a26).
export function shortId(id: string) {
  if (id.length <= 14) return id;
  if (/^0x/i.test(id)) return `${id.slice(0, 6)}…${id.slice(-4)}`;
  const dash = id.indexOf("-");
  const head = dash > 0 && dash < 12 ? id.slice(0, dash + 5) : id.slice(0, 6);
  return `${head}…${id.slice(-4)}`;
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function Short({ id, className }: { id: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={`sid${className ? ` ${className}` : ""}`}
      title={`${id} · click to copy`}
      onClick={(e) => {
        e.stopPropagation();
        void copyText(id).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1400);
        });
      }}
    >
      {copied ? "Copied ✓" : shortId(id)}
    </button>
  );
}

export function CopyButton({ text, label = "Copy", className = "btn" }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button type="button" className={className} onClick={(e) => { e.stopPropagation(); void copyText(text).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1400); }); }}>
      {copied ? "Copied ✓" : label}
    </button>
  );
}

// ---------------------------------------------------------------- modal: centred HUD, scrolls inside, closes on Esc / outside click

export function Modal({ open, onClose, title, wide, children, labelledBy }: { open: boolean; onClose: () => void; title: ReactNode; wide?: boolean; children: ReactNode; labelledBy?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    const prev = document.activeElement as HTMLElement | null;
    window.setTimeout(() => ref.current?.querySelector<HTMLElement>("[data-autofocus], button")?.focus(), 30);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  const id = labelledBy ?? "modal-title";
  return (
    <div className="scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className={`hud on modal${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={id}>
        <i className="k tl" /><i className="k tr" /><i className="k bl" /><i className="k br" />
        <h2 id={id} className="mtitle">{title}</h2>
        <div className="rule" />
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- toasts (bottom right, fade by themselves)

type ToastItem = { id: number; title: string; body?: ReactNode; href?: string; error?: boolean };
const ToastCtx = createContext<(t: Omit<ToastItem, "id">) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((t: Omit<ToastItem, "id">) => {
    const id = Date.now() + Math.random();
    setItems((s) => [...s.slice(-3), { ...t, id }]);
    window.setTimeout(() => setItems((s) => s.filter((x) => x.id !== id)), t.error ? 8000 : 5000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="tg tg-layer"><div className="toasts" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast${t.error ? " err" : ""}`} role="status">
            <b>{t.title}</b>
            {t.body && <span>{t.body}</span>}
            {t.href && <a className="tx" href={t.href} target="_blank" rel="noreferrer">View transaction ↗</a>}
            <div className="bar" style={{ animationDuration: t.error ? "8s" : "5s" }} />
          </div>
        ))}
      </div></div>
    </ToastCtx.Provider>
  );
}

// ---------------------------------------------------------------- progress: 4 steps, moving bar, elapsed timer

export const fmtElapsed = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export function useTicker(active: boolean, every = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => setNow(Date.now()), every);
    return () => window.clearInterval(t);
  }, [active, every]);
  return now;
}

export function Steps({ names, at, done }: { names: string[]; at: number; done?: boolean }) {
  return (
    <div className="steps">
      {names.map((n, i) => (
        <div key={n} className={`step${done || i < at ? " done" : i === at ? " now" : ""}`}><i />{n}</div>
      ))}
    </div>
  );
}

export function ProgressCard({ title, meta, names, at, message, started, error, children, className }: {
  title: ReactNode; meta?: ReactNode; names: string[]; at: number; message: ReactNode; started: number; error?: string | null; children?: ReactNode; className?: string;
}) {
  const now = useTicker(!error);
  return (
    <div className={`card ${error ? "c-rej" : "c-prog"}${className ? ` ${className}` : ""}`} aria-live="polite">
      <div className="card-head"><b>{error ? "Stopped" : title}</b>{meta && <span>{meta}</span>}</div>
      <Steps names={names} at={at} />
      {error ? (
        <p className="reason err-text">{error}</p>
      ) : (
        <div className="status"><span className="dot" /><span>{message}</span><span className="elapsed">{fmtElapsed(now - started)}</span></div>
      )}
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- icons

export const Icon = {
  play: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5l11 7-11 7z" /></svg>,
  wallet: <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="18" height="13" rx="1" /><path d="M16 12h2" /></svg>,
  open: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6" /></svg>,
  pulse: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h3l3-7 4 14 3-7h3" /></svg>,
  bars: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 20V10M12 20V4M19 20v-7" /></svg>,
  code: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6l-6 6 6 6M16 6l6 6-6 6" /></svg>,
};

// ---------------------------------------------------------------- GenLayer particle logo loader (2D canvas, points from the scene's own logo data)

type LogoPoint = { x: number; y: number; c: boolean };
let logoPoints: Promise<LogoPoint[]> | null = null;
function loadLogo(): Promise<LogoPoint[]> {
  if (!logoPoints) {
    logoPoints = fetch("/landing/gl-logo.json").then((r) => r.json()).then((L: { n: number; pos: string; part: string }) => {
      const bin = (b: string) => { const s = atob(b), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };
      const pos = new Float32Array(bin(L.pos).buffer), part = bin(L.part);
      const out: LogoPoint[] = [];
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (let i = 0; i < L.n; i++) { x0 = Math.min(x0, pos[i * 3]); x1 = Math.max(x1, pos[i * 3]); y0 = Math.min(y0, pos[i * 3 + 1]); y1 = Math.max(y1, pos[i * 3 + 1]); }
      const cxm = (x0 + x1) / 2, cym = (y0 + y1) / 2, s = 1.56 / Math.max(x1 - x0, y1 - y0, 1e-6);
      const step = Math.max(1, Math.floor(L.n / 1800));
      for (let i = 0; i < L.n; i += step) out.push({ x: (pos[i * 3] - cxm) * s, y: (pos[i * 3 + 1] - cym) * s, c: part[i] > 127 });
      return out;
    }).catch(() => []);
  }
  return logoPoints;
}

export function LogoLoader({ text }: { text: ReactNode }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    const cx = cv?.getContext("2d");
    if (!cv || !cx) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0, dead = false;
    void loadLogo().then((pts) => {
      if (dead) return;
      const parts = pts.map((p) => ({ ...p, sx: (Math.random() * 2 - 1) * 1.6, sy: (Math.random() * 2 - 1) * 1.6, ph: Math.random() * 6.28, d: Math.random() * 0.5 }));
      const t0 = performance.now();
      const draw = (now: number) => {
        if (dead) return;
        const t = (now - t0) / 1000, W = cv.width, S = W * 0.5;
        cx.clearRect(0, 0, W, W);
        cx.globalCompositeOperation = "lighter";
        cx.strokeStyle = "rgba(240,0,132,.55)";
        cx.lineWidth = 3;
        cx.beginPath();
        cx.arc(W / 2, W / 2, W * 0.46, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (reduce ? 1 : (t * 0.25) % 1));
        cx.stroke();
        for (const p of parts) {
          const k = reduce ? 1 : Math.max(0, Math.min(1, (t - p.d) / 1.6)), e = k * k * (3 - 2 * k);
          const x = p.sx + (p.x - p.sx) * e + (reduce ? 0 : Math.sin(t * 1.5 + p.ph) * 0.012);
          const y = p.sy + (p.y - p.sy) * e + (reduce ? 0 : Math.cos(t * 1.3 + p.ph) * 0.012);
          cx.fillStyle = p.c ? "rgba(54,225,245,.55)" : "rgba(220,224,235,.32)";
          cx.fillRect(W / 2 + x * S, W / 2 - y * S, 2, 2);
        }
        cx.globalCompositeOperation = "source-over";
        if (!reduce) raf = requestAnimationFrame(draw);
      };
      raf = requestAnimationFrame(draw);
    });
    return () => { dead = true; cancelAnimationFrame(raf); };
  }, []);
  return (
    <div className="loader">
      <canvas ref={ref} width={440} height={440} aria-hidden="true" />
      <span className="hint">{text}</span>
    </div>
  );
}
