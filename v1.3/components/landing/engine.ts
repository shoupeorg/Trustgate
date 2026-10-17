// Landing scene: particle gate (WebGL, no libraries), HUD panel fly-open, decoding header text,
// header dust on scroll, generated sound. Ported from the approved prototype; numbers and timings
// are kept as they are there. Returns a cleanup function (React may mount twice in development).

type Model = {
  duration: number;
  frames: number;
  static: { pos: string; lum: string; kind: string; n: number };
  groups: Array<{ pos: string; lum: string; kind: number; n: number; mats: string }>;
};
type Logo = { n: number; pos: string; part: string };
type Bufs = Record<"aPos" | "aStart" | "aPhase" | "aDelay" | "aKind" | "aLum" | "aAmp", Float32Array>;
type ParticleSet = { n: number; bufs: Bufs };
type SceneSet = { set: ParticleSet; mats: Float32Array | null; portal?: boolean; logo?: boolean; gl?: Record<string, WebGLBuffer> };
type DustPart = { x: number; y: number; c: string; vx: number; vy: number; w: number; dl: number };
type DustGroup = { el: HTMLElement; p: number; parts: DustPart[] | null; thr: number | null };

export function startLanding(root: HTMLElement): () => void {
  const ac = new AbortController();
  const on = (t: EventTarget, ev: string, fn: EventListener, opts: AddEventListenerOptions = {}) => t.addEventListener(ev, fn, { ...opts, signal: ac.signal });
  let dead = false;
  const timers: number[] = [];
  const intervals: number[] = [];
  const later = (fn: () => void, ms: number) => { const id = window.setTimeout(fn, ms); timers.push(id); return id; };
  const cleanups: Array<() => void> = [];

  const $ = <T extends Element = HTMLElement>(sel: string) => root.querySelector(sel) as T | null;
  const $$ = <T extends Element = HTMLElement>(sel: string) => [...root.querySelectorAll(sel)] as T[];
  const slow = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------- HUD behaviour ----------
  function typeEl(el: HTMLElement & { _tok?: number }, wait: number) {
    const full = el.dataset.full || (el.dataset.full = el.textContent ?? "");
    const tok = (el._tok || 0) + 1;
    el._tok = tok;
    if (slow) { el.textContent = full; return; }
    el.textContent = "";
    el.classList.add("typing");
    let i = 0;
    later(function step() {
      if (el._tok !== tok || dead) return;
      i++;
      el.textContent = full.slice(0, i);
      if (i < full.length) later(step, 24 + Math.random() * 40);
      else later(() => { if (el._tok === tok) el.classList.remove("typing"); }, 700);
    }, wait);
  }
  function typePanel(p: HTMLElement) {
    p.querySelectorAll<HTMLElement>("[data-type]").forEach((el, k) => {
      const row = el.closest<HTMLElement>("[data-i]");
      const d = row ? parseInt(getComputedStyle(row).getPropertyValue("--d")) || 0 : 0;
      typeEl(el, 380 + d * 90 + k * 60);
    });
  }
  // fly-open: corners start at the centre, rows type in
  if ("IntersectionObserver" in window) {
    root.classList.add("armed");
    // A quarter of the panel in view opens it; the console can grow taller than four screens
    // (feed, benchmark), so for tall panels a fifth of the screen filled by it counts too.
    const io = new IntersectionObserver((es) => es.forEach((e) => {
      const t = e.target as HTMLElement;
      const seen = e.isIntersecting && (e.intersectionRatio >= 0.25 || e.intersectionRect.height >= innerHeight * 0.2);
      if (seen) { if (!t.classList.contains("on")) { t.classList.add("on"); typePanel(t); } }
      else if (!e.isIntersecting && e.boundingClientRect.top > 0) t.classList.remove("on");
    }), { threshold: [0.05, 0.1, 0.15, 0.2, 0.25] });
    $$("[data-panel]").forEach((p) => io.observe(p));
    cleanups.push(() => io.disconnect());
  }

  // ---------- header: brand decodes on load, header turns to dust on scroll ----------
  const bname = $("#bname"), bpct = $("#bpct");
  const GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%/<>*";
  const rnd = () => GLYPHS[(Math.random() * GLYPHS.length) | 0];
  // decode text in place: random glyphs that settle left to right; glyphs swap every ~70ms so it stays readable
  function makeDecoder(el: HTMLElement, dur: number, extra?: (k: number) => void) {
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), nodes: Array<{ n: Node; orig: string }> = [];
    let n: Node | null;
    while ((n = tw.nextNode())) if (n.textContent?.trim()) nodes.push({ n, orig: n.textContent });
    const total = nodes.reduce((s, o) => s + o.orig.length, 0);
    let busy = false;
    return function play() {
      if (busy || dead) return;
      busy = true;
      const t0 = performance.now(), D = slow ? 1 : dur;
      let lastSwap = 0;
      (function tick(now: number) {
        if (dead) return;
        const k = Math.min(1, (now - t0) / D);
        if (now - lastSwap > 70 || k >= 1) {
          lastSwap = now;
          let idx = 0;
          nodes.forEach((o) => { let s = ""; for (const ch of o.orig) { const at = 0.2 + 0.75 * idx / total; s += (k >= at || ch === " " || ch === "·") ? ch : rnd(); idx++; } o.n.textContent = s; });
          if (extra) extra(k);
        }
        if (k < 1) requestAnimationFrame(tick); else busy = false;
      })(t0);
    };
  }
  const brandEl = $(".brand");
  const brandDecode = bname ? makeDecoder(bname, 1500, (k) => { if (bpct) bpct.textContent = k < 1 ? String(Math.floor(k * 100)).padStart(3, "0") + "%" : "V1.3"; }) : () => {};
  const decoders: Array<[HTMLElement, () => void]> = [];
  if (brandEl) decoders.push([brandEl, brandDecode]);
  const heroP = $(".hero p");
  if (heroP) decoders.push([heroP, makeDecoder(heroP, 1700)]);
  decoders.forEach(([el, play], i) => {
    later(play, i * 220); // once on load
    on(el, "pointerenter", () => play()); // again whenever the pointer is on it
    // and on its own every few seconds while it is on screen, so the landing never sits still
    if (!slow) intervals.push(window.setInterval(() => {
      const r = el.getBoundingClientRect();
      if (document.hidden || r.bottom < 0 || r.top > innerHeight || getComputedStyle(el).visibility === "hidden") return;
      play();
    }, 5200 + i * 1300));
  });

  const dcv = document.createElement("canvas");
  dcv.setAttribute("aria-hidden", "true");
  dcv.style.cssText = "position:fixed;inset:0;width:100%;height:100%;z-index:6;pointer-events:none";
  root.appendChild(dcv);
  cleanups.push(() => dcv.remove());
  const dctx = dcv.getContext("2d")!;
  const sizeDust = () => { dcv.width = innerWidth; dcv.height = innerHeight; };
  on(window, "resize", sizeDust);
  sizeDust();

  // CSS zoom shrinks the box on screen but computed font sizes stay unzoomed, so scale them ourselves
  function zoomOf(el: Element) {
    const cz = (el as Element & { currentCSSZoom?: number }).currentCSSZoom;
    if (typeof cz === "number") return cz;
    let z = 1;
    for (let e: Element | null = el; e; e = e.parentElement) { const v = parseFloat(getComputedStyle(e).zoom); if (v) z *= v; }
    return z;
  }
  function paint(ctx: CanvasRenderingContext2D, el: Element, ox: number, oy: number) {
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let n: Node | null = el;
    do {
      if (n.nodeType === 1) {
        const cs = getComputedStyle(n as Element);
        if (cs.display === "none" || cs.visibility === "hidden") continue;
        const r = (n as Element).getBoundingClientRect();
        if (cs.backgroundColor && !/rgba\(.*,\s*0\)$/.test(cs.backgroundColor) && cs.backgroundColor !== "transparent") { ctx.fillStyle = cs.backgroundColor; ctx.fillRect(r.left - ox, r.top - oy, r.width, r.height); }
        const bw = (parseFloat(cs.borderTopWidth) || 0) * zoomOf(n as Element);
        if (bw > 0) { ctx.strokeStyle = cs.borderTopColor; ctx.lineWidth = bw; ctx.strokeRect(r.left - ox + bw / 2, r.top - oy + bw / 2, r.width - bw, r.height - bw); }
      } else {
        const txt = n.textContent?.trim();
        if (!txt || !n.parentElement) continue;
        const cs = getComputedStyle(n.parentElement);
        const z = zoomOf(n.parentElement);
        ctx.font = cs.fontWeight + " " + parseFloat(cs.fontSize) * z + "px " + cs.fontFamily;
        try { (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = cs.letterSpacing === "normal" ? "0px" : parseFloat(cs.letterSpacing) * z + "px"; } catch {}
        ctx.fillStyle = cs.color;
        ctx.textBaseline = "alphabetic";
        const rg = document.createRange();
        rg.selectNodeContents(n);
        const rr = rg.getBoundingClientRect();
        ctx.fillText(cs.textTransform === "uppercase" ? txt.toUpperCase() : txt, rr.left - ox, rr.top - oy + rr.height * 0.8);
      }
    } while ((n = tw.nextNode()));
  }
  function sampleEl(el: HTMLElement): DustPart[] {
    const r = el.getBoundingClientRect(), pad = 4;
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.ceil(r.width + pad * 2));
    c.height = Math.max(1, Math.ceil(r.height + pad * 2));
    const x = c.getContext("2d", { willReadFrequently: true })!;
    paint(x, el, r.left - pad, r.top - pad);
    const d = x.getImageData(0, 0, c.width, c.height).data, parts: DustPart[] = [];
    for (let y = 0; y < c.height; y += 2) for (let xx = 0; xx < c.width; xx += 2) {
      const i = (y * c.width + xx) * 4;
      if (d[i + 3] < 60) continue;
      parts.push({ x: r.left - pad + xx, y: r.top - pad + y, c: "rgba(" + d[i] + "," + d[i + 1] + "," + d[i + 2] + ",", vx: 30 + Math.random() * 170, vy: -(15 + Math.random() * 90), w: Math.random() * 6.28, dl: (xx / c.width) * 0.45 + Math.random() * 0.12 });
    }
    return parts;
  }
  // The header buttons change with the wallet state, so the dust groups are re-read now and then.
  let groups: DustGroup[] = [];
  function scanGroups() {
    const els = $$("[data-dust]");
    groups = els.map((el) => groups.find((g) => g.el === el) ?? { el, p: 0, parts: null, thr: el.dataset.dust ? parseFloat(el.dataset.dust) : null });
  }
  scanGroups();
  intervals.push(window.setInterval(scanGroups, 400));
  let dustOn = false, lastT = performance.now();
  function readDust() {
    const onNow = scrollY > innerHeight * 0.3;
    if (onNow !== dustOn) { dustOn = onNow; if (!onNow) later(() => { if (!dustOn) brandDecode(); }, 120); }
  }
  on(window, "scroll", readDust, { passive: true });
  readDust();
  let dustRaf = 0;
  (function dustFrame(now: number) {
    if (dead) return;
    const dt = Math.min(0.25, (now - lastT) / 1000);
    lastT = now;
    dctx.clearRect(0, 0, dcv.width, dcv.height);
    groups.forEach((g) => {
      const target = (g.thr != null ? scrollY > g.thr : dustOn) ? 1 : 0;
      if (g.p === 0 && target === 1) g.parts = sampleEl(g.el);
      g.p = Math.max(0, Math.min(1, g.p + (target ? 1 : -1) * dt / (slow ? 0.2 : 0.75)));
      g.el.style.visibility = g.p > 0 ? "hidden" : "";
      g.el.style.pointerEvents = g.p > 0.5 ? "none" : "";
      if (g.p === 0) { g.parts = null; return; }
      if (!g.parts) return;
      for (const q of g.parts) {
        const lp = Math.max(0, Math.min(1, (g.p - q.dl) / (1 - q.dl)));
        if (lp >= 1) continue;
        const e = lp * lp;
        dctx.fillStyle = q.c + (1 - lp).toFixed(3) + ")";
        dctx.fillRect(q.x + q.vx * e + Math.sin(q.w + lp * 6) * 5 * e, q.y + q.vy * e, 1.6, 1.6);
      }
    });
    dustRaf = requestAnimationFrame(dustFrame);
  })(lastT);
  cleanups.push(() => cancelAnimationFrame(dustRaf));

  // ---------- sound: generated ambient space drone + a layered impact on every camera shake ----------
  // Browsers never let a page play sound before the visitor's first click, tap or key press,
  // so the soundtrack starts on that first interaction (scrolling with a wheel does not count).
  const sndBtn = $<HTMLButtonElement>("#snd");
  let AC: AudioContext | null = null, master: GainNode | null = null, verbBus: ConvolverNode | null = null, muted = false, started = false;
  const bellTimers: number[] = [];
  function reverb(ctx: AudioContext, sec: number) {
    const len = ctx.sampleRate * sec, b = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6); }
    const v = ctx.createConvolver();
    v.buffer = b;
    return v;
  }
  function startAudio() {
    if (started || dead) return;
    started = true;
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    AC = new Ctx();
    const A = AC;
    master = A.createGain();
    master.gain.value = 0;
    const comp = A.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 8; comp.ratio.value = 5; comp.attack.value = 0.003; comp.release.value = 0.25;
    master.connect(comp);
    comp.connect(A.destination);
    const verb = reverb(A, 5), wet = A.createGain();
    wet.gain.value = 0.55;
    verb.connect(wet);
    wet.connect(master);
    verbBus = verb;
    // drone: detuned saws through a slowly breathing low-pass
    const lp = A.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = 520; lp.Q.value = 0.7;
    const lfo = A.createOscillator(), lfoG = A.createGain();
    lfo.frequency.value = 0.05; lfoG.gain.value = 260;
    lfo.connect(lfoG); lfoG.connect(lp.frequency); lfo.start();
    const pad = A.createGain();
    pad.gain.value = 0.15;
    lp.connect(pad); pad.connect(master); pad.connect(verb);
    [55, 82.41, 110, 130.81, 164.81].forEach((f, i) => [-6, 6].forEach((dt) => { const o = A.createOscillator(); o.type = i < 2 ? "sine" : "sawtooth"; o.frequency.value = f; o.detune.value = dt + (Math.random() * 4 - 2); o.connect(lp); o.start(); }));
    // soft wind
    const nb = A.createBuffer(1, A.sampleRate * 4, A.sampleRate), nd = nb.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    const ns = A.createBufferSource();
    ns.buffer = nb; ns.loop = true;
    const bp = A.createBiquadFilter();
    bp.type = "bandpass"; bp.frequency.value = 700; bp.Q.value = 0.6;
    const ng = A.createGain();
    ng.gain.value = 0.035;
    ns.connect(bp); bp.connect(ng); ng.connect(master); ng.connect(verb); ns.start();
    // sparse glassy notes
    const notes = [440, 523.25, 587.33, 659.25, 783.99, 880];
    (function bell() {
      if (!AC || dead) return;
      const t = AC.currentTime, o = AC.createOscillator(), g = AC.createGain();
      o.type = "sine";
      o.frequency.value = notes[(Math.random() * notes.length) | 0] * (Math.random() < 0.3 ? 0.5 : 1);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.08, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 3.5);
      o.connect(g); g.connect(verb); o.start(t); o.stop(t + 3.6);
      bellTimers.push(window.setTimeout(bell, 2500 + Math.random() * 4500));
    })();
    setMute(muted);
  }
  function setMute(m: boolean) {
    muted = m;
    if (sndBtn) {
      sndBtn.setAttribute("aria-pressed", String(!m));
      const b = sndBtn.querySelector("b");
      if (b) b.textContent = m ? "Sound off" : "Sound on";
    }
    if (AC && master) {
      if (AC.state === "suspended") void AC.resume();
      master.gain.cancelScheduledValues(AC.currentTime);
      master.gain.setTargetAtTime(m ? 0 : 1.2, AC.currentTime, 0.6);
    }
  }
  function noiseBuf(sec: number) {
    const b = AC!.createBuffer(1, AC!.sampleRate * sec, AC!.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }
  function boom() {
    if (!AC || !master || muted) return;
    const A = AC, M = master, t = A.currentTime;
    // 1 whoosh: band-passed noise sweeping up into the hit
    const w = A.createBufferSource(); w.buffer = noiseBuf(1.2);
    const wf = A.createBiquadFilter(); wf.type = "bandpass"; wf.Q.value = 1.4;
    wf.frequency.setValueAtTime(300, t); wf.frequency.exponentialRampToValueAtTime(3200, t + 0.28); wf.frequency.exponentialRampToValueAtTime(400, t + 1.1);
    const wg = A.createGain(); wg.gain.setValueAtTime(0.0001, t); wg.gain.exponentialRampToValueAtTime(0.7, t + 0.22); wg.gain.exponentialRampToValueAtTime(0.0001, t + 1.15);
    w.connect(wf); wf.connect(wg); wg.connect(M); w.start(t);
    const h = t + 0.24;
    // 2 sub drop: the body of the impact
    const o = A.createOscillator(), g = A.createGain(); o.type = "sine";
    o.frequency.setValueAtTime(150, h); o.frequency.exponentialRampToValueAtTime(28, h + 0.9);
    g.gain.setValueAtTime(0.0001, h); g.gain.exponentialRampToValueAtTime(1.6, h + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, h + 1.4);
    o.connect(g); g.connect(M); o.start(h); o.stop(h + 1.5);
    // 3 distorted punch on top
    const o2 = A.createOscillator(), sh = A.createWaveShaper(), g2 = A.createGain(); o2.type = "triangle";
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = i / 511.5 - 1; curve[i] = Math.tanh(x * 4); }
    sh.curve = curve;
    o2.frequency.setValueAtTime(90, h); o2.frequency.exponentialRampToValueAtTime(40, h + 0.35);
    g2.gain.setValueAtTime(0.0001, h); g2.gain.exponentialRampToValueAtTime(0.5, h + 0.008); g2.gain.exponentialRampToValueAtTime(0.0001, h + 0.45);
    o2.connect(sh); sh.connect(g2); g2.connect(M); o2.start(h); o2.stop(h + 0.5);
    // 4 laser zap: saw diving through a resonant filter, into the reverb
    const z = A.createOscillator(), zf = A.createBiquadFilter(), zg = A.createGain(); z.type = "sawtooth";
    z.frequency.setValueAtTime(1800, h); z.frequency.exponentialRampToValueAtTime(90, h + 0.6);
    zf.type = "bandpass"; zf.Q.value = 7; zf.frequency.setValueAtTime(2400, h); zf.frequency.exponentialRampToValueAtTime(300, h + 0.6);
    zg.gain.setValueAtTime(0.0001, h); zg.gain.exponentialRampToValueAtTime(0.35, h + 0.01); zg.gain.exponentialRampToValueAtTime(0.0001, h + 0.7);
    z.connect(zf); zf.connect(zg); zg.connect(M); if (verbBus) zg.connect(verbBus); z.start(h); z.stop(h + 0.75);
    // 5 noise crack
    const c = A.createBufferSource(); c.buffer = noiseBuf(0.3);
    const cf = A.createBiquadFilter(); cf.type = "highpass"; cf.frequency.value = 1200;
    const cg = A.createGain(); cg.gain.setValueAtTime(0.5, h); cg.gain.exponentialRampToValueAtTime(0.0001, h + 0.25);
    c.connect(cf); cf.connect(cg); cg.connect(M); if (verbBus) cg.connect(verbBus); c.start(h);
  }
  on(window, "tg-shake", boom);
  let unlockAt = -1e9;
  // the visitor's first gesture unlocks sound; if that gesture is a click on the sound button it must leave sound on
  const firstTouch = () => { startAudio(); if (AC && AC.state === "suspended") void AC.resume(); unlockAt = performance.now(); };
  ["pointerdown", "keydown", "touchend"].forEach((ev) => on(window, ev, firstTouch, { once: true, capture: true }));
  // Start right away only where the browser already allows sound; elsewhere the first gesture starts it.
  const activation = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
  if (!activation || activation.hasBeenActive) { try { startAudio(); } catch {} }
  if (sndBtn) {
    on(sndBtn, "click", (e) => {
      e.stopPropagation();
      const fresh = performance.now() - unlockAt < 800; // the click that just unlocked sound must not switch it off again
      startAudio();
      if (fresh) { setMute(false); return; }
      setMute(!muted);
    });
    setMute(false); // sound is on by default on every visit
  }
  cleanups.push(() => { bellTimers.forEach((t) => window.clearTimeout(t)); if (AC) void AC.close(); AC = null; });

  // ---------- particle scene ----------
  const canvas = $<HTMLCanvasElement>("#scene");
  const gl = canvas?.getContext("webgl", { antialias: false, alpha: false }) ?? null;
  let glRaf = 0;
  if (canvas && gl) {
    Promise.all([
      fetch("/landing/gate-model.json").then((r) => r.json() as Promise<Model>),
      fetch("/landing/gl-logo.json").then((r) => r.json() as Promise<Logo>),
    ]).then(([MODEL, LOGO]) => { if (!dead) glRaf = runScene(canvas, gl, MODEL, LOGO); }).catch(() => {});
  }
  cleanups.push(() => cancelAnimationFrame(glRaf));

  function runScene(canvas: HTMLCanvasElement, gl: WebGLRenderingContext, MODEL: Model, LOGO: Logo): number {
    const reduce = slow;
    // particle budget follows the device (small screens, few cores or little memory), layout follows the live window width
    const nav = navigator as Navigator & { deviceMemory?: number };
    const small = Math.min(screen.width || 9999, screen.height || 9999) < 760 || (nav.hardwareConcurrency || 8) <= 4 || (nav.deviceMemory || 8) <= 4;
    const PR = Math.min(window.devicePixelRatio || 1, small ? 1.5 : 2);
    const R = Math.random;
    const f32 = (b: string) => { const s = atob(b), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return new Float32Array(u.buffer); };
    const u8 = (b: string) => { const s = atob(b), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };
    const scatterPt = () => { const r = 12 + R() * 22, t = R() * 6.283, p = Math.acos(2 * R() - 1); return [r * Math.sin(p) * Math.cos(t), 2.4 + r * Math.cos(p) * 0.6, r * Math.sin(p) * Math.sin(t)]; };

    // kind: 0 metal, 1 portal, 2 portal core, 3 rock, 4 ground dust, 5 star, 6 wisp, 7 spark, 8 GenLayer mark
    function makeSet(pos: Float32Array, lum: Uint8Array | null, kind: number | Uint8Array | number[], n: number, assemble: boolean): ParticleSet {
      const st = new Float32Array(n * 3), ph = new Float32Array(n), dl = new Float32Array(n), kd = new Float32Array(n), lm = new Float32Array(n), am = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const s = assemble ? scatterPt() : [0, 0, 0];
        st[i * 3] = s[0]; st[i * 3 + 1] = s[1]; st[i * 3 + 2] = s[2];
        ph[i] = R() * 6.283;
        const k = typeof kind === "number" ? kind : kind[i];
        kd[i] = k;
        lm[i] = lum ? lum[i] / 255 : R();
        dl[i] = assemble ? 0.15 + R() * 0.55 : -5.0;
        am[i] = k === 1 || k === 2 ? 0.03 + R() * 0.05 : k === 6 ? 0.25 + R() * 0.5 : k === 4 ? 0.01 + R() * 0.03 : 0.008 + R() * 0.022;
      }
      return { n, bufs: { aPos: pos, aStart: st, aPhase: ph, aDelay: dl, aKind: kd, aLum: lm, aAmp: am } };
    }
    const sets: SceneSet[] = [];
    const S = MODEL.static;
    sets.push({ set: makeSet(f32(S.pos), u8(S.lum), u8(S.kind), S.n, true), mats: null });
    MODEL.groups.forEach((g) => sets.push({ set: makeSet(f32(g.pos), u8(g.lum), g.kind, g.n, true), mats: f32(g.mats), portal: g.kind === 1 || g.kind === 2 }));
    // GenLayer mark floating inside the portal
    const logoSet: SceneSet = { set: makeSet(f32(LOGO.pos), u8(LOGO.part), 8, LOGO.n, true), mats: null, logo: true }; // aLum: 1 = centre shape, 0 = side brackets
    for (let i = 0; i < LOGO.n; i++) logoSet.set.bufs.aDelay[i] = 0.75 + Math.random() * 0.35;
    sets.push(logoSet);
    const logoM = new Float32Array(16);
    function logoMatrix(t: number) {
      const ry = Math.sin(t * 0.33) * 0.5, rz = Math.sin(t * 0.47 + 1.0) * 0.14, rx = Math.sin(t * 0.4 + 2.0) * 0.12;
      const cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(rz), sz = Math.sin(rz), cx = Math.cos(rx), sx = Math.sin(rx);
      // R = Ry * Rx * Rz
      const m00 = cy * cz + sy * sx * sz, m01 = -cy * sz + sy * sx * cz, m02 = sy * cx;
      const m10 = cx * sz, m11 = cx * cz, m12 = -sx;
      const m20 = -sy * cz + cy * sx * sz, m21 = sy * sz + cy * sx * cz, m22 = cy * cx;
      logoM.set([m00, m10, m20, 0, m01, m11, m21, 0, m02, m12, m22, 0, 0, 2.41 + Math.sin(t * 0.8) * 0.11, 0.05 + Math.sin(t * 0.6) * 0.08, 1]);
      return logoM;
    }
    // environment: ground dust, stars, sparks, wisps (world space)
    (function () {
      const env: number[] = [], kinds: number[] = [];
      const NG = small ? 50000 : 110000;
      for (let i = 0; i < NG; i++) { env.push(R() * 6.2832, Math.pow(R(), 0.75), R()); kinds.push(4); }
      const NS = small ? 1800 : 3000;
      for (let i = 0; i < NS; i++) { const r = 150 + R() * 80, t = R() * 6.283, p = Math.acos(R() * 0.95); env.push(r * Math.sin(p) * Math.cos(t), r * Math.cos(p) - 15, r * Math.sin(p) * Math.sin(t) - 40); kinds.push(5); }
      for (let i = 0; i < (small ? 900 : 1800); i++) { env.push(R() * 6.2832, R(), R()); kinds.push(7); }
      for (let i = 0; i < (small ? 350 : 600); i++) { const a = R() * 6.283, rr = 3 + R() * 5; env.push(Math.cos(a) * rr, R() * 6.5, Math.sin(a) * rr * 0.7); kinds.push(6); }
      sets.push({ set: makeSet(new Float32Array(env), null, kinds, kinds.length, false), mats: null });
    })();

    const vs = `
    attribute vec3 aPos,aStart;
    attribute float aPhase,aDelay,aKind,aLum,aAmp;
    uniform mat4 uProj,uView,uModel;
    uniform float uTime,uAsm,uPR,uMotion,uSpin,uBoost;
    varying vec3 vColor; varying float vA;
    const vec3 PINK=vec3(0.941,0.0,0.518);
    const vec3 CYAN=vec3(0.212,0.882,0.961);
    void main(){
      float t=clamp((uAsm-aDelay)/0.9,0.0,1.0); t=t*t*(3.0-2.0*t);
      vec3 w=(uModel*vec4(aPos,1.0)).xyz;
      float gr=0.0;
      if(aKind>3.5&&aKind<4.5){
        float span=46.0, r0=aPos.y*span;
        gr=2.6+mod(r0+uTime*uMotion*(0.25+aLum*0.35),span);
        float a=aPos.x+aPos.z*0.02;
        vec2 xz=vec2(cos(a),sin(a))*gr;
        float h=0.16*sin(xz.x*0.55)*sin(xz.y*0.5)+0.07*sin(xz.x*1.7+xz.y*1.3)+0.05*sin(xz.x*3.1-xz.y*2.6);
        float cr=length(fract(xz*0.11)-0.5); h-=0.12*smoothstep(0.32,0.12,cr)-0.05*smoothstep(0.38,0.3,cr);
        w=vec3(xz.x,-0.27+h*smoothstep(2.6,7.0,gr),xz.y);
      }
      float tt=uTime*uMotion;
      if(aKind>0.5&&aKind<2.5){
        vec2 c=w.xy-vec2(0.0,2.41); float r=length(c);
        float ang=-uSpin*(aKind<1.5?1.0:1.8)-(aKind<1.5?0.0:(2.2-r)*0.6);
        float cs=cos(ang),sn=sin(ang); c=vec2(c.x*cs-c.y*sn,c.x*sn+c.y*cs); w.xy=c+vec2(0.0,2.41);
      }
      vec3 p=mix(aStart,w,t);
      p+=vec3(sin(tt*0.55+aPhase),cos(tt*0.47+aPhase*1.7),sin(tt*0.39+aPhase*2.3))*aAmp;
      p+=(1.0-t)*vec3(sin(tt*0.3+aPhase*3.0),cos(tt*0.25+aPhase),0.0)*1.2;
      vec4 mv=uView*vec4(p,1.0); float d=-mv.z;
      float sz; vec3 col;
      if(aKind<0.5){
        float b=0.013+aLum*0.05; col=vec3(b*0.85,b*0.92,b*1.1);
        float rr=length(w.xy-vec2(0.0,2.41));
        col+=PINK*0.02*exp(-abs(rr-2.15)*4.0)*step(abs(w.z),0.6);
        if(fract(aPhase*7.31)<0.02) col=CYAN*0.14;
        sz=0.45+fract(aPhase*3.7)*0.35;
      } else if(aKind<1.5){
        float rr=length(w.xy-vec2(0.0,2.41));
        float edge=smoothstep(1.2,2.1,rr);
        col=PINK*mix(0.05,0.3,edge)*(1.0+0.25*uBoost);
        if(fract(aPhase*5.1)<0.03) col=CYAN*0.35;
        sz=0.55+fract(aPhase*2.3)*0.5;
      } else if(aKind<2.5){
        col=(fract(aPhase*9.7)<0.08)?mix(PINK,CYAN,step(0.5,fract(aPhase*3.3)))*0.8:PINK*0.06;
        sz=0.5+fract(aPhase*2.9)*0.6;
      } else if(aKind<3.5){
        float b=0.008+aLum*0.02; col=vec3(b,b,b*1.08); sz=0.4;
      } else if(aKind<4.5){
        float b=0.06+aLum*0.11; col=vec3(b*0.95,b*0.97,b*1.05);
        float born=smoothstep(2.6,4.2,gr), far=1.0-smoothstep(30.0,48.6,gr);
        float grow=1.0-smoothstep(uTime*9.0-4.0,uTime*9.0+2.0,gr);
        float spill=exp(-length(vec2(w.x*0.7,(w.z-1.5)*0.5))*0.5)*step(-0.5,w.z);
        col=(col*(0.5+0.4*exp(-gr*0.08))+PINK*0.16*spill)*born*far*grow;
        sz=0.4+aLum*0.4;
      } else if(aKind<5.5){
        float b=0.3+aLum*0.7; col=(fract(aPhase*4.1)<0.1)?CYAN*b*0.8:vec3(b*0.8,b*0.85,b);
        col*=0.8+0.2*sin(uTime*1.3+aPhase*5.0); sz=1.4+aLum*1.8;
      } else if(aKind>7.5){
        float sh=(0.85+0.3*fract(aPhase*3.1))*(1.0+0.15*sin(uTime*1.7+aPhase));
        col=aLum>0.5?CYAN*0.042*sh:vec3(0.04,0.042,0.048)*sh;
        sz=0.28+fract(aPhase*2.7)*0.16;
      } else if(aKind>6.5){
        float life=fract(uTime*(0.22+0.35*uBoost)*(0.6+aLum*0.8)+aPhase);
        float a0=aPos.x-uSpin-life*(0.9+aLum*0.6);
        float rad=2.05+life*(0.8+aLum*2.2);
        w=vec3(cos(a0)*rad,2.41+sin(a0)*rad+life*life*0.6,(aPos.y-0.5)*0.4+life*(aPos.z-0.35)*3.0);
        p=w;
        mv=uView*vec4(p,1.0); d=-mv.z;
        col=PINK*0.5*(1.0-life)*smoothstep(0.0,0.08,life)*(0.5+0.8*uBoost)*smoothstep(1.2,2.0,uAsm);
        sz=0.45+aLum*0.5;
      } else {
        col=(aLum<0.7?PINK:CYAN)*0.22; sz=0.5+aLum*0.5;
      }
      gl_PointSize=clamp(sz*uPR*(110.0/max(d,0.3)),1.0,7.0*uPR);
      gl_Position=uProj*mv;
      float fog=exp(-0.02*max(d-6.0,0.0)); if(aKind>4.5&&aKind<5.5) fog=1.0;
      vColor=col*fog; vA=mix(0.25,1.0,t);
    }`;
    const fs = `
    precision mediump float;
    varying vec3 vColor; varying float vA;
    void main(){
      float d=length(gl_PointCoord-0.5);
      float a=smoothstep(0.5,0.05,d); a*=a;
      gl_FragColor=vec4(vColor*2.0*a*vA,1.0);
    }`;
    const sh = (type: number, src: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return 0;
    gl.useProgram(prog);
    const sizes = { aPos: 3, aStart: 3, aPhase: 1, aDelay: 1, aKind: 1, aLum: 1, aAmp: 1 } as const;
    const keys = Object.keys(sizes) as Array<keyof typeof sizes>;
    const locs = {} as Record<keyof typeof sizes, number>;
    keys.forEach((k) => (locs[k] = gl.getAttribLocation(prog, k)));
    sets.forEach((s) => { s.gl = {}; keys.forEach((k) => { const b = gl.createBuffer()!; gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, s.set.bufs[k], gl.STATIC_DRAW); s.gl![k] = b; }); });
    const U: Record<string, WebGLUniformLocation | null> = {};
    ["uProj", "uView", "uModel", "uTime", "uAsm", "uPR", "uMotion", "uSpin", "uBoost"].forEach((n) => (U[n] = gl.getUniformLocation(prog, n)));
    gl.uniform1f(U.uPR, PR);
    gl.uniform1f(U.uMotion, reduce ? 0.25 : 1);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.clearColor(0.012, 0.012, 0.024, 1);
    const I4 = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

    // model animation: frames baked from the GLB
    const FR = MODEL.frames, DUR = MODEL.duration, tmp = new Float32Array(16);
    function matAt(m: Float32Array, time: number) {
      const f = Math.max(0, Math.min(FR - 1, time / DUR * (FR - 1))), i = Math.floor(f), j = Math.min(FR - 1, i + 1), u = f - i;
      for (let k = 0; k < 16; k++) tmp[k] = m[i * 16 + k] * (1 - u) + m[j * 16 + k] * u;
      return tmp;
    }
    // play once (parts lock in, portal opens), then sway the rings back and forth with the portal open
    const LOOP_A = 1.15, LOOP_B = 4.05, START = reduce ? 0 : 2.2;
    function animTime(sec: number) {
      if (reduce) return 2.6;
      const t = sec - START;
      if (t < 0) return 0;
      if (t < LOOP_A) return t;
      const span = LOOP_B - LOOP_A, x = ((t - LOOP_A) / (span * 1.6)) % 2, y = x < 1 ? x : 2 - x;
      return LOOP_A + span * (y * y * (3 - 2 * y));
    }
    function perspective(fov: number, asp: number, n: number, f: number) { const t = 1 / Math.tan(fov / 2), nf = 1 / (n - f); return new Float32Array([t / asp, 0, 0, 0, 0, t, 0, 0, 0, 0, (f + n) * nf, -1, 0, 0, 2 * f * n * nf, 0]); }
    function lookAt(e: number[], c: number[], u: number[]) {
      let z = [e[0] - c[0], e[1] - c[1], e[2] - c[2]];
      let l = Math.hypot(z[0], z[1], z[2]);
      z = z.map((v) => v / l);
      let x = [u[1] * z[2] - u[2] * z[1], u[2] * z[0] - u[0] * z[2], u[0] * z[1] - u[1] * z[0]];
      l = Math.hypot(x[0], x[1], x[2]);
      x = x.map((v) => v / l);
      const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
      const d = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -d(x, e), -d(y, e), -d(z, e), 1]);
    }

    const gateSec = $("#gate")!;
    const dist = $("#dist"), bar = $("#bar"), meter = $(".meter");
    let q = 0, qs = 0, mx = 0, my = 0, smx = 0, smy = 0, asm = reduce ? 2 : 0;
    // which side the current panel sits on: +1 right, -1 left, 0 none (hero)
    const secs = $$("main section");
    let side = 0, sideS = 0, shake = 0, lastSide = 0, activePanel: HTMLElement | null = null, ndcS = 0, atGate = false, spin = 0, boost = 0;
    function readSide() {
      const mid = window.scrollY + window.innerHeight * 0.5;
      let best: HTMLElement | null = null, bd = 1e9;
      secs.forEach((s) => { const c = s.offsetTop + s.offsetHeight * 0.5, d = Math.abs(c - mid); if (d < bd) { bd = d; best = s; } });
      const b = best as HTMLElement | null;
      side = !b || b.classList.contains("hero") ? 0 : b.classList.contains("right") || b.id === "gate" ? 1 : -1;
      atGate = gateSec.getBoundingClientRect().top < innerHeight * 0.55;
      const cur = atGate ? gateSec : b;
      if (atGate) side = 0;
      activePanel = cur && side !== 0 ? cur.querySelector<HTMLElement>("[data-panel]") : null;
      if (side !== lastSide) { if (lastSide !== 0 || side !== 0) { shake = 1; dispatchEvent(new Event("tg-shake")); } lastSide = side; }
    }
    on(window, "scroll", readSide, { passive: true });
    readSide();
    const readScroll = () => { const end = Math.max(1, gateSec.offsetTop); q = Math.min(1, Math.max(0, window.scrollY / end)); };
    on(window, "scroll", readScroll, { passive: true });
    on(window, "pointermove", ((e: PointerEvent) => { mx = e.clientX / window.innerWidth - 0.5; my = e.clientY / window.innerHeight - 0.5; }) as EventListener, { passive: true });
    function resize() {
      const w = window.innerWidth, h = window.innerHeight;
      canvas.width = Math.round(w * PR);
      canvas.height = Math.round(h * PR);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniformMatrix4fv(U.uProj, false, perspective(50 * Math.PI / 180, w / h, 0.05, 500));
      readScroll();
    }
    on(window, "resize", resize);
    resize();

    const t0 = performance.now();
    let last = 0;
    function draw(s: SceneSet, model: Float32Array) {
      gl.uniformMatrix4fv(U.uModel, false, model);
      keys.forEach((k) => { const l = locs[k]; if (l < 0) return; gl.bindBuffer(gl.ARRAY_BUFFER, s.gl![k]); gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, sizes[k], gl.FLOAT, false, 0, 0); });
      gl.drawArrays(gl.POINTS, 0, s.set.n);
    }
    function frame(now: number) {
      if (dead) return;
      const t = (now - t0) / 1000, dt = Math.min(0.05, Math.max(0, t - last));
      last = t;
      if (asm < 2) asm += dt * 0.55;
      qs += (q - qs) * (reduce ? 1 : Math.min(1, dt * 4));
      smx += (mx - smx) * Math.min(1, dt * 2);
      smy += (my - smy) * Math.min(1, dt * 2);
      const e = 1 - Math.pow(1 - qs, 2.2), fade = 1 - e * 0.6;
      const narrow = window.innerWidth < 760, Z0 = narrow ? 24 : 17, Z1 = narrow ? 15 : 13.5, z = Z0 + (Z1 - Z0) * e;
      sideS += (side - sideS) * Math.min(1, dt * (reduce ? 10 : 3.4));
      shake = Math.max(0, shake - dt * 1.8);
      const sk = reduce ? 0 : shake * shake * 0.22, s1 = Math.sin(t * 37.0) * sk, s2 = Math.cos(t * 29.0) * sk, s3 = Math.sin(t * 23.0 + 1.0) * sk * 0.6;
      // put the gate in the middle of the free space opposite the current panel
      let ndcT = 0;
      if (activePanel && !narrow && !atGate) {
        const r = activePanel.getBoundingClientRect(), W = window.innerWidth;
        const cx = side > 0 ? Math.max(0, r.left) * 0.5 : (Math.min(W, r.right) + W) * 0.5;
        ndcT = cx / W * 2 - 1;
      }
      ndcS += (ndcT - ndcS) * Math.min(1, dt * (reduce ? 10 : 3.4));
      const halfW = Math.tan(25 * Math.PI / 180) * z * (window.innerWidth / window.innerHeight);
      const tx = -ndcS * halfW, ty = narrow ? 4.3 - e * 5.0 : 4.3 - e * 1.9;
      const eye = [smx * 2.2 * fade - ndcS * 3.0 + s1, 1.2 + e * (narrow ? 1.6 : 1.3) - smy * 0.8 * fade + s2, z + s3];
      gl.uniformMatrix4fv(U.uView, false, lookAt(eye, [tx + s1 * 0.6, ty + s2 * 0.6, 0], [Math.sin(t * 31.0) * sk * 0.08, 1, 0]));
      boost += ((atGate ? 1 : 0) - boost) * Math.min(1, dt * 1.5);
      spin += dt * (reduce ? 0.05 : 0.22 + boost * 1.1) * Math.min(1, Math.max(0, t - START - 0.4));
      gl.uniform1f(U.uTime, t);
      gl.uniform1f(U.uAsm, asm);
      gl.uniform1f(U.uSpin, spin);
      gl.uniform1f(U.uBoost, boost);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const at = animTime(t);
      // the portal keeps its own opening animation but never spins backwards: after it opens, hold its pose and let uSpin turn it clockwise
      const pt = Math.min(at, t - START < LOOP_A ? at : LOOP_A);
      sets.forEach((s) => draw(s, s.logo ? logoMatrix(reduce ? 0 : t) : s.mats ? matAt(s.mats, s.portal ? pt : at) : I4));
      if (dist) dist.textContent = Math.round(Math.max(0, z - Z1)) + " m";
      if (bar) bar.style.width = (qs * 100).toFixed(1) + "%";
      if (meter) meter.style.opacity = qs > 0.93 ? "0" : "1";
      glRaf = requestAnimationFrame(frame);
    }
    return requestAnimationFrame(frame);
  }

  return () => {
    dead = true;
    ac.abort();
    timers.forEach((t) => window.clearTimeout(t));
    intervals.forEach((t) => window.clearInterval(t));
    cleanups.forEach((f) => f());
    root.classList.remove("armed");
  };
}
