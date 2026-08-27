/* Cutoff — client.
   Charts are hand-drawn SVG, sized to their container rather than to a fixed
   viewBox, so the app fills whatever window it is opened in.

   Two rules this file keeps:
   1. Every number comes from the API, which computes it from the committed
      model. Nothing here is hardcoded for a demo.
   2. Numbers are shown as a RANGE by default. The range is the model's own
      measured error at that horizon, read off /api/calibration — not a
      decoration, and not a guess. "exact figures" in the top bar shows the raw
      output instead. */

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const pct = (x) => (x * 100).toFixed(1) + "%";
const pct0 = (x) => Math.round(x * 100) + "%";
const store = {
  get(k, d) { try { const v = localStorage.getItem("cutoff." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("cutoff." + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const CARDS_PER_COURSE = 75;   // only for a subject typed in by hand
const DEFAULT_DENSITY = 6;
const density = () => Math.max(1, Math.min(30, +($("#density")?.value) || DEFAULT_DENSITY));

const SAMPLE_RATINGS = {
  "Chemical Engineering Thermodynamics": 2, "Fluid Mechanics": 1, "Heat Transfer": 3,
  "Mass Transfer": 3, "Chemical Reaction Engineering": 2, "Process Control": 4,
  "Thermal Operations": 3, "Chemical Technology": 4,
};
const DEFAULT_COURSES = [
  { name: "Thermodynamics", rating: 2, n: CARDS_PER_COURSE },
  { name: "Fluid Mechanics", rating: 1, n: CARDS_PER_COURSE },
  { name: "Mass Transfer", rating: 3, n: CARDS_PER_COURSE },
  { name: "Heat Transfer", rating: 3, n: CARDS_PER_COURSE },
  { name: "Reaction Engineering", rating: 2, n: CARDS_PER_COURSE },
  { name: "Process Control", rating: 4, n: CARDS_PER_COURSE },
  { name: "Thermal Operations", rating: 3, n: CARDS_PER_COURSE },
  { name: "Chemical Technology", rating: 4, n: CARDS_PER_COURSE },
];

const SAMPLE_SYLLABUS = `CHE 201 — Chemical Engineering Thermodynamics
Unit 1: Laws and state functions
Zeroth law, first law, closed and open systems; internal energy, enthalpy, heat capacity
Unit 2: Second law
Entropy, Clausius inequality, reversibility, availability, exergy analysis
Unit 3: Phase equilibria
Raoult's law, Henry's law, activity coefficients, fugacity, VLE calculations

CHE 202 — Fluid Mechanics
Unit 1: Fluid statics
Pressure distribution, manometry, buoyancy, forces on submerged surfaces
Unit 2: Flow of fluids
Continuity equation, Navier–Stokes equations, Bernoulli equation, boundary layers
Unit 3: Flow measurement and machinery
Orifice meter, venturi meter, rotameter, pitot tube, centrifugal pumps, NPSH

CHE 203 — Heat Transfer
Conduction, Fourier's law, steady and unsteady conduction, fins
Convection, Nusselt number, forced convection, natural convection
Radiation, Stefan–Boltzmann law, view factors, grey surfaces
Heat exchangers, LMTD method, NTU method, fouling factors

CHE 204 — Mass Transfer
Molecular diffusion, Fick's law, equimolar counter-diffusion
Interphase mass transfer, two-film theory, penetration theory
Absorption, stripping, HTU and NTU, packed column design

CHE 205 — Chemical Reaction Engineering
Rate laws, order of reaction, Arrhenius equation, activation energy
Batch reactor, CSTR, PFR design equations, space time
Non-ideal flow, residence time distribution, dispersion model
Catalysis, adsorption isotherms, effectiveness factor

CHE 206 — Process Control
Process dynamics, first and second order systems, transfer functions
Laplace transforms, block diagrams, closed loop response
PID controllers, tuning rules, stability, Bode and Nyquist criteria

CHE 207 — Thermal Operations
Evaporation, single and multiple effect, boiling point elevation
Distillation, McCabe–Thiele method, reflux ratio, tray efficiency
Drying, humidity charts, drying rate curves

CHE 208 — Chemical Technology
Sulphuric acid manufacture, contact process
Ammonia synthesis, Haber process, catalyst regeneration
Petroleum refining, distillation, cracking, reforming
Polymers, polymerisation routes, industrial safety`;

const GRADE_WORDS = { 1: "gone", 2: "shaky", 3: "solid", 4: "cold" };

const state = {
  courses: structuredClone(DEFAULT_COURSES),
  cards: [], forecast: null, ceiling: null, plan: null, curves: null,
  days: 87, target: 0.9, cap: 40,
  isolate: null,
  exact: store.get("exact", false),
};

/* =====================================================================
   The honesty layer: how wrong is the model at this range?
   Filled from /api/calibration. Until it lands we fall back to the ECE
   published in the README, and every band says which it used.
   ===================================================================== */
const CAL = { ece: 0.025, byHorizon: null, loaded: false };
const HORIZON_MAX_DAYS = [7, 28, 90, Infinity];

function biasAt(days) {
  if (!CAL.byHorizon || !CAL.byHorizon.length) return 0;
  const i = HORIZON_MAX_DAYS.findIndex((d) => days <= d);
  const row = CAL.byHorizon[Math.min(i < 0 ? CAL.byHorizon.length - 1 : i, CAL.byHorizon.length - 1)];
  return row.predicted - row.actual;          // positive = overconfident
}

/** A model output turned into the range we are willing to stand behind. */
function band(p, days = state.days) {
  const bias = biasAt(days), e = CAL.ece;
  const mid = clamp01(p - bias);
  return { raw: p, mid, lo: clamp01(mid - e), hi: clamp01(mid + e), bias, e };
}

const SCALE_WORDS = [
  [0.93, "nearly all of it"], [0.8, "most of it"], [0.65, "more than half"],
  [0.5, "about half"], [0.35, "less than half"], [0.2, "a fraction of it"],
  [0, "almost none of it"],
];
const scaleWord = (p) => SCALE_WORDS.find(([t]) => p >= t)[1];
const inTen = (p) => `about ${Math.round(p * 10)} in 10`;

/** The one function every headline goes through. */
function figure(p, days) {
  const b = band(p, days);
  if (state.exact) return { head: pct(b.raw), sub: `raw model output. Measured bias at this range is ${(b.bias * 100).toFixed(1)} points, so the honest read is ${pct0(b.mid)}.`, b };
  return {
    head: inTen(b.mid),
    sub: `somewhere between <b>${pct0(b.lo)}</b> and <b>${pct0(b.hi)}</b> — that width is the model's own measured error at this range, not a guess.`,
    b,
  };
}

/* =========================== svg + chart engine =========================== */
const NS = "http://www.w3.org/2000/svg";
function el(tag, attrs = {}, parent) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
}
function text(svg, x, y, s, o = {}) {
  const t = el("text", { x, y, fill: o.fill || css("--text-muted"), "font-size": o.size || 11,
    "text-anchor": o.anchor || "start", "font-weight": o.weight || 400, ...(o.attrs || {}) }, svg);
  t.textContent = s;
  return t;
}
const line = (pts) => pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(2) + "," + p[1].toFixed(2)).join(" ");
function hBarPath(x, y, w, h, r) {
  r = Math.min(r, h / 2, Math.max(w, 0.01));
  return `M${x},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} L${x},${y + h} Z`;
}
function barPath(x, y, w, h, r) {
  r = Math.min(r, w / 2, Math.max(h, 0.01));
  return `M${x},${y + h} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h} Z`;
}

/** A vertical fade of one colour, for area fills under a line. */
function fadeUnder(svg, id, colour, top = 0.3) {
  const d = el("defs", {}, svg);
  const g = el("linearGradient", { id, x1: "0%", y1: "0%", x2: "0%", y2: "100%" }, d);
  el("stop", { offset: "0%", "stop-color": colour, "stop-opacity": top }, g);
  el("stop", { offset: "100%", "stop-color": colour, "stop-opacity": 0 }, g);
  return `url(#${id})`;
}
/** 45-degree hatch, for a region that is out of reach rather than merely low. */
function hatch(svg, id, colour) {
  const d = el("defs", {}, svg);
  const p = el("pattern", { id, width: 7, height: 7, patternTransform: "rotate(45)", patternUnits: "userSpaceOnUse" }, d);
  el("line", { x1: 0, y1: 0, x2: 0, y2: 7, stroke: colour, "stroke-width": 1.4, opacity: .30 }, p);
  return `url(#${id})`;
}

/** Draw into a host element, and redraw it whenever the host resizes.
    The viewBox is in real pixels, so 11px text is 11px whatever the window. */
function chart(host, draw) {
  if (!host) return;
  host.classList.remove("loading");
  host._draw = draw;
  if (!host._ro) {
    host._ro = new ResizeObserver(() => paint(host));   // resize only redraws on a real size change
    host._ro.observe(host);
  }
  host._painted = false;                                 // new data always redraws
  paint(host);
}
function paint(host) {
  const w = Math.round(host.clientWidth), h = Math.round(host.clientHeight);
  if (!w || !h || !host._draw) return;
  if (host._w === w && host._h === h && host._painted) return;
  host._w = w; host._h = h; host._painted = true;
  host.textContent = "";
  const svg = el("svg", { viewBox: `0 0 ${w} ${h}`, role: "img", "aria-label": host.dataset.label || "chart" });
  svg.style.fontFamily = css("--font");
  host.appendChild(svg);
  try { host._draw(svg, w, h); } catch (e) { console.error("chart", host.id, e); }
}
const repaint = (host) => { if (host) { host._painted = false; paint(host); } };

/** Let a path draw itself in. Fails OPEN — a path is never left hidden. */
function animate(path) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return path;
  let len = 0;
  try { len = path.getTotalLength(); } catch { return path; }
  if (!len || !Number.isFinite(len)) return path;
  path.style.strokeDasharray = len;
  path.style.strokeDashoffset = len;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    path.style.transition = "stroke-dashoffset .8s cubic-bezier(.22,.61,.36,1)";
    path.style.strokeDashoffset = "0";
  }));
  setTimeout(() => { path.style.strokeDashoffset = "0"; }, 1200);
  return path;
}

/* ============================== failure ==============================
   Two different things can go wrong -- the model can be unreachable, or the
   interface can throw while drawing what came back -- and they need different
   fixes. Saying "could not reach the model" for both sends you debugging the
   network when the bug is three lines of DOM. */
function fail(title, err) {
  console.error(title, err);
  $("#bannerTitle").textContent = title;
  $("#bannerBody").textContent = (err && (err.stack || err.message)) ? String(err.message || err) : String(err);
  $("#banner").classList.add("on");
}
const clearFail = () => $("#banner").classList.remove("on");

/* =============================== tooltip =============================== */
const tip = $("#tip");
function showTip(evt, title, value, rows = []) {
  tip.textContent = "";
  const th = document.createElement("div"); th.className = "th"; th.textContent = title;
  const tv = document.createElement("div"); tv.className = "tv"; tv.textContent = value;
  tip.append(th, tv);
  for (const r of rows) {
    const d = document.createElement("div"); d.className = "tr";
    if (r.colour) { const k = document.createElement("span"); k.className = "k"; k.style.background = r.colour; d.append(k); }
    const nm = document.createElement("span"); nm.textContent = r.label;          // labels are untrusted data
    const v = document.createElement("b"); v.textContent = r.value;
    d.append(nm, v); tip.append(d);
  }
  tip.style.opacity = 1;
  const pad = 14, w = 250;
  let x = evt.clientX + pad, y = evt.clientY - pad;
  if (x + w > innerWidth) x = evt.clientX - w;
  if (y < 10) y = 10;
  if (y + tip.offsetHeight > innerHeight - 8) y = innerHeight - tip.offsetHeight - 8;
  tip.style.left = x + "px"; tip.style.top = y + "px";
}
const hideTip = () => (tip.style.opacity = 0);

/** Recessive hairline grid. */
function grid(svg, box, ticks, fmt) {
  for (const t of ticks) {
    const y = box.y + box.h - (t - box.min) / (box.max - box.min) * box.h;
    el("line", { x1: box.x, x2: box.x + box.w, y1: y, y2: y, stroke: css("--border"), "stroke-width": 1 }, svg);
    text(svg, box.x - 8, y + 4, fmt(t), { anchor: "end" });
  }
}
const axis = (svg, box) => el("line", { x1: box.x, x2: box.x + box.w, y1: box.y + box.h, y2: box.y + box.h,
  stroke: css("--border-strong"), "stroke-width": 1 }, svg);

/* ================================ the gauge ================================
   A warm radial gauge replaces the coffee mug.
   Level    = what you'd hold on exam morning (the calibrated middle).
   Dashes   = the target you asked for.
   Ring     = how much of your window is left before the cutoff.
   Sparkles = you are above target. They stop when you are not.
   Every one of those is labelled in words underneath — the gauge is a picture
   of numbers that are also written down, never the only place they appear. */
function renderGauge(level, target, ringFrac, cold) {
  chart($("#gaugeChart"), (svg, W, H) => {
    // Small copies drop their labels rather than stacking four of them on top
    // of each other; the numbers are all in the sentence beside it anyway.
    const compact = Math.min(W, H) < 210;
    const size = Math.min(W, H * 0.92);
    const cx = W / 2, cy = H / 2 + size * 0.04;
    // room for the urgency ring outside the gauge and for the target label
    // outside that -- both were being clipped by the plot's own edge
    const R = size / 2 - 28;

    // gradient definitions
    const defs = el("defs", {}, svg);

    // warm fill gradient for the level arc
    const grad = el("linearGradient", { id: "gaugeGrad", x1: "0%", y1: "100%", x2: "100%", y2: "0%" }, defs);
    if (cold) {
      el("stop", { offset: "0%", "stop-color": "#5b4f47" }, grad);
      el("stop", { offset: "100%", "stop-color": "#7a6b5f" }, grad);
    } else {
      el("stop", { offset: "0%", "stop-color": "#c47131" }, grad);
      el("stop", { offset: "50%", "stop-color": "#dda45e" }, grad);
      el("stop", { offset: "100%", "stop-color": "#e8c9a0" }, grad);
    }

    // glow filter for the level arc
    const glow = el("filter", { id: "gaugeGlow", x: "-30%", y: "-30%", width: "160%", height: "160%" }, defs);
    el("feGaussianBlur", { in: "SourceGraphic", stdDeviation: cold ? "2" : compact ? "2.5" : "5", result: "blur" }, glow);
    const merge = el("feMerge", {}, glow);
    el("feMergeNode", { in: "blur" }, merge);
    el("feMergeNode", { in: "SourceGraphic" }, merge);

    // inner glow for the centre
    const innerGlow = el("radialGradient", { id: "centreGlow", cx: "50%", cy: "50%", r: "50%" }, defs);
    el("stop", { offset: "0%", "stop-color": cold ? "rgba(91,79,71,.12)" : "rgba(196,113,49,.1)" }, innerGlow);
    el("stop", { offset: "100%", "stop-color": "transparent" }, innerGlow);

    const trackW = Math.max(10, R * 0.1);
    const arcR = R - trackW / 2;

    // --- the sweep: 270° arc (from 135° to 405° i.e. bottom-left to bottom-right) ---
    const startAngle = 135;
    const totalSweep = 270;

    const describeArc = (cx, cy, r, startDeg, endDeg) => {
      const s = (startDeg * Math.PI) / 180;
      const e = (endDeg * Math.PI) / 180;
      const sx = cx + r * Math.cos(s), sy = cy + r * Math.sin(s);
      const ex = cx + r * Math.cos(e), ey = cy + r * Math.sin(e);
      const large = endDeg - startDeg > 180 ? 1 : 0;
      return `M${sx},${sy} A${r},${r} 0 ${large} 1 ${ex},${ey}`;
    };

    // centre warm glow disc
    el("circle", { cx, cy, r: arcR - trackW * 0.8, fill: "url(#centreGlow)" }, svg);

    // track (background)
    el("path", { d: describeArc(cx, cy, arcR, startAngle, startAngle + totalSweep),
      fill: "none", stroke: css("--border"), "stroke-width": trackW, "stroke-linecap": "round" }, svg);

    // level fill arc
    const lv = clamp01(level);
    const levelEnd = startAngle + totalSweep * lv;
    if (lv > 0.01) {
      const lvArc = el("path", { d: describeArc(cx, cy, arcR, startAngle, levelEnd),
        fill: "none", stroke: "url(#gaugeGrad)", "stroke-width": trackW, "stroke-linecap": "round",
        filter: "url(#gaugeGlow)" }, svg);
      lvArc.style.transition = "d .6s ease";
    }

    // target tick mark
    const tgtAngle = startAngle + totalSweep * clamp01(target);
    const tgtRad = (tgtAngle * Math.PI) / 180;
    const tInner = arcR - trackW * 0.9;
    const tOuter = arcR + trackW * 0.9;
    el("line", {
      x1: cx + tInner * Math.cos(tgtRad), y1: cy + tInner * Math.sin(tgtRad),
      x2: cx + tOuter * Math.cos(tgtRad), y2: cy + tOuter * Math.sin(tgtRad),
      stroke: css("--crema"), "stroke-width": 2.5, "stroke-linecap": "round", opacity: .9
    }, svg);
    // target label
    const tLabelR = tOuter + 13;
    // keep the label inside the plot: at a high target the tick sits hard right
    // and the word was being cut in half by the edge of the box
    const tLx = Math.max(28, Math.min(W - 28, cx + tLabelR * Math.cos(tgtRad)));
    const tLy = Math.max(12, Math.min(H - 6, cy + tLabelR * Math.sin(tgtRad)));
    if (!compact) text(svg, tLx, tLy + 4, "target", { fill: css("--crema"), size: 10.5, weight: 600, anchor: "middle" });

    // --- outer urgency ring (thinner, behind everything) ---
    const ringR = R + 12;
    const ringCol = cold ? css("--critical") : ringFrac > 0.35 ? css("--good") : ringFrac > 0.12 ? css("--warning") : css("--critical");
    el("path", { d: describeArc(cx, cy, ringR, startAngle, startAngle + totalSweep),
      fill: "none", stroke: css("--border"), "stroke-width": 2.5, "stroke-linecap": "round" }, svg);
    if (ringFrac > 0.005) {
      const ringEnd = startAngle + totalSweep * clamp01(ringFrac);
      const rArc = el("path", { d: describeArc(cx, cy, ringR, startAngle, ringEnd),
        fill: "none", stroke: ringCol, "stroke-width": 2.5, "stroke-linecap": "round" }, svg);
      rArc.style.transition = "d .6s ease";
    }

    // --- centre score text ---
    // The gauge quotes the figure the same way the rest of the app does: a
    // rounded scale unless you asked for exact, so the centre of the gauge can
    // never disagree with the sentence next to it.
    const centre = state.exact ? pct(lv) : Math.round(lv * 10) + " in 10";
    const scoreT = text(svg, cx, cy + 2, centre, {
      fill: cold ? css("--text-muted") : css("--text-primary"),
      size: Math.max(15, R * (state.exact ? 0.3 : 0.27)), weight: 700, anchor: "middle"
    });
    scoreT.setAttribute("font-family", css("--display"));
    scoreT.setAttribute("letter-spacing", "-.03em");

    // "on exam morning" sub-label
    if (!compact) text(svg, cx, cy + Math.max(18, R * 0.2), "on exam morning", {
      fill: css("--text-muted"), size: Math.max(10, R * 0.1), anchor: "middle"
    });

    // --- sparkles when above target ---
    if (!cold && level >= target) {
      const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
      const sparkleCount = 6;
      for (let i = 0; i < sparkleCount; i++) {
        const angle = startAngle + totalSweep * (0.3 + Math.random() * 0.65);
        const rad = (angle * Math.PI) / 180;
        const dist = arcR + trackW * (0.4 + Math.random() * 1.2);
        const sx = cx + dist * Math.cos(rad);
        const sy = cy + dist * Math.sin(rad);
        const sparkle = el("circle", { cx: sx, cy: sy, r: 1.5 + Math.random() * 1.5,
          fill: css("--crema"), opacity: .5 }, svg);
        if (!still) {
          sparkle.style.animation = `sparkle ${2 + Math.random() * 2}s ease-in-out ${Math.random() * 2}s infinite`;
          sparkle.style.transformOrigin = `${sx}px ${sy}px`;
        }
      }
    }

    // --- bottom scale labels ---
    if (!compact) {
      const bottomY = cy + arcR + trackW + 26;
      text(svg, cx - arcR * 0.85, bottomY, "0%", { fill: css("--text-muted"), size: 11, anchor: "start" });
      text(svg, cx + arcR * 0.85, bottomY, "100%", { fill: css("--text-muted"), size: 11, anchor: "end" });
    }
  });
}
// keyframes for the sparkles, injected once
if (!document.getElementById("cupkf")) {
  const s = document.createElement("style"); s.id = "cupkf";
  s.textContent = `
    @keyframes sparkle{0%{opacity:0;transform:scale(.5)}50%{opacity:.7;transform:scale(1.3)}100%{opacity:0;transform:scale(.5)}}
    @keyframes steam{0%{opacity:0;transform:translateY(6px) scaleY(.9)}35%{opacity:.34}100%{opacity:0;transform:translateY(-16px) scaleY(1.15)}}
    @keyframes slosh{from{transform:translateX(0)}to{transform:translateX(-50%)}}
    @keyframes bubble{0%{transform:translateY(0) scale(.7);opacity:0}25%{opacity:.45}100%{transform:translateY(-46px) scale(1);opacity:0}}
    @keyframes splash{0%{transform:translate(0,0) scale(.4);opacity:.85}100%{transform:translate(var(--dx),-16px) scale(1);opacity:0}}
    @keyframes streamin{from{transform:scaleY(0)}to{transform:scaleY(1)}}
    @keyframes streamout{to{opacity:0}}
    @keyframes sway{0%,100%{transform:translateX(-1.5px)}50%{transform:translateX(1.5px)}}
    @keyframes fadein{to{opacity:.34}}
    @keyframes cremaIn{to{opacity:1}}
    @keyframes ripple{0%{transform:scale(.3);opacity:.55}100%{transform:scale(3.4);opacity:0}}
    @keyframes streamlife{0%{opacity:0}6%{opacity:.95}78%{opacity:.95}100%{opacity:0}}
    @keyframes pour{from{transform:translateY(var(--drop))}to{transform:translateY(0)}}`;
  document.head.append(s);
}


/* ============================ the pour ============================
   The cup is the forecast: it fills to what you'd hold on exam morning, the
   dashed line is your target, the arc under the saucer is how much of your
   window is left, and it only steams when you're above target. It pours itself
   on every fresh forecast -- and again if you click it.

   All of the motion is CSS keyframes on top of a scene that is already correct
   when it is drawn, so a browser that refuses to animate shows a full cup
   rather than an empty one. */
function renderCup(level, target, ringFrac, cold, daysLeft) {
  const host = $("#cupChart");
  if (host && !host._pourWired) {
    host._pourWired = true;
    host.style.cursor = "pointer";
    host.title = "click to pour it again";
    host.addEventListener("click", () => repaint(host));
  }
  chart(host, (svg, W, H) => {
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const cream = css("--crema"), ink = css("--text-secondary");

    /* ---- the glass, seen slightly from above, so every horizontal edge is an
       ellipse and the coffee has a real surface rather than a flat line ---- */
    const cupW = Math.min(W * 0.52, H * 0.34);
    const cupH = cupW * 0.96;
    const coneH = Math.min(44, H * 0.1);
    const gap = Math.min(58, H * 0.14);
    const below = 48;
    const top = Math.max(6, (H - (coneH + gap + cupH + below)) / 2);
    const cx = W / 2;
    const coneW = cupW * 0.62, coneTop = top, coneBot = top + coneH;
    const y0 = coneBot + gap, y1 = y0 + cupH;      // rim centre, base centre
    const rimRx = cupW / 2, rimRy = rimRx * 0.20;
    const botRx = rimRx * 0.82, botRy = botRx * 0.17;
    const halfW = (y) => botRx + (rimRx - botRx) * ((y1 - y) / cupH);
    const ellRy = (y) => botRy + (rimRy - botRy) * ((y1 - y) / cupH);

    const defs = el("defs", {}, svg);
    const grad = (id, stops, attrs = {}) => {
      const g = el("linearGradient", { id, x1: "0%", y1: "0%", x2: "0%", y2: "100%", ...attrs }, defs);
      for (const [o, c, op] of stops) el("stop", { offset: o, "stop-color": c, "stop-opacity": op === undefined ? 1 : op }, g);
      return `url(#${id})`;
    };
    const coffee = cold
      ? grad("cf", [["0%", "#6b5c52"], ["100%", "#3d3630"]])
      : grad("cf", [["0%", "#c9762f"], ["45%", "#a4551f"], ["100%", "#5d2c0e"]]);
    const glass = grad("gl", [["0%", "#ffffff", .10], ["18%", "#ffffff", .03], ["82%", "#ffffff", .02], ["100%", "#ffffff", .09]]);
    const cremaG = el("radialGradient", { id: "cr", cx: "38%", cy: "34%", r: "72%" }, defs);
    el("stop", { offset: "0%", "stop-color": cold ? "#8b7d72" : "#f0d5ad" }, cremaG);
    el("stop", { offset: "70%", "stop-color": cold ? "#6f635a" : "#d9a465" }, cremaG);
    el("stop", { offset: "100%", "stop-color": cold ? "#5b4f47" : "#b7762f" }, cremaG);
    const halo = el("radialGradient", { id: "halo", cx: "50%", cy: "50%", r: "50%" }, defs);
    el("stop", { offset: "0%", "stop-color": cold ? "rgba(91,79,71,.13)" : "rgba(201,118,47,.15)" }, halo);
    el("stop", { offset: "100%", "stop-color": "transparent" }, halo);
    const soft = el("filter", { id: "soft", x: "-60%", y: "-60%", width: "220%", height: "220%" }, defs);
    el("feGaussianBlur", { stdDeviation: 3.4 }, soft);

    // warm light behind the glass
    el("ellipse", { cx, cy: y0 + cupH * 0.55, rx: cupW * 1.15, ry: cupH * 0.78, fill: "url(#halo)" }, svg);

    /* ---- dripper ---- */
    el("path", { d: `M${cx - coneW / 2},${coneTop} L${cx + coneW / 2},${coneTop} L${cx + coneW * 0.08},${coneBot} L${cx - coneW * 0.08},${coneBot} Z`,
      fill: "rgba(255,255,255,.03)", stroke: css("--text-muted"), "stroke-width": 1.6, "stroke-linejoin": "round", opacity: .8 }, svg);
    el("ellipse", { cx, cy: coneTop, rx: coneW / 2, ry: coneW * 0.09, fill: css("--espresso"),
      stroke: ink, "stroke-width": 2 }, svg);

    /* ---- glass body ---- */
    const bodyD = `M${cx - rimRx},${y0}
      C${cx - rimRx},${y0 + cupH * 0.5} ${cx - botRx},${y1 - cupH * 0.3} ${cx - botRx},${y1}
      A${botRx},${botRy} 0 0 0 ${cx + botRx},${y1}
      C${cx + botRx},${y1 - cupH * 0.3} ${cx + rimRx},${y0 + cupH * 0.5} ${cx + rimRx},${y0}
      A${rimRx},${rimRy} 0 0 1 ${cx - rimRx},${y0} Z`;
    el("path", { d: bodyD }, el("clipPath", { id: "cupclip" }, svg));
    el("path", { d: bodyD, fill: glass }, svg);

    /* ---- the coffee ---- */
    const inner = (y1 - 6) - (y0 + rimRy + 2);
    const lv = clamp01(level);
    const surf = (y1 - 6) - inner * lv;
    const sRx = halfW(surf) - 1.5, sRy = ellRy(surf);

    const wet = el("g", { "clip-path": "url(#cupclip)" }, svg);
    // The rise is a keyframe animation running BACKWARDS-filled, so the cup's
    // resting state is full: it animates up from empty if it can, and if the
    // browser runs no animation at all it is simply full. A transition, or a
    // freeze-filled SMIL, fails the other way -- an empty cup forever.
    const lift = el("g", {}, wet);
    if (!still) {
      lift.style.setProperty("--drop", `${inner * lv}px`);
      lift.style.animation = "pour 1.6s cubic-bezier(.22,.85,.3,1) backwards";
    }
    el("rect", { x: cx - rimRx - 4, y: surf, width: cupW + 8, height: y1 - surf + 14, fill: coffee }, lift);
    el("ellipse", { cx, cy: surf, rx: sRx, ry: sRy, fill: coffee }, lift);
    // crema, and the ring of bubbles that always collects against the glass
    const crema = el("g", {}, lift);
    el("ellipse", { cx, cy: surf, rx: sRx * 0.985, ry: sRy * 0.96, fill: "url(#cr)", opacity: cold ? .35 : .92 }, crema);
    el("ellipse", { cx, cy: surf, rx: sRx * 0.985, ry: sRy * 0.96, fill: "none",
      stroke: cold ? "rgba(255,255,255,.06)" : "rgba(255,240,220,.22)", "stroke-width": 1.2 }, crema);
    if (!cold) for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2, rr = 0.68 + (i % 3) * 0.1;
      el("circle", { cx: cx + Math.cos(a) * sRx * rr, cy: surf + Math.sin(a) * sRy * rr,
        r: 0.9 + (i % 3) * 0.5, fill: "#fff", opacity: .16 }, crema);
    }
    if (!still) crema.style.animation = "cremaIn .8s ease 1.15s backwards";
    // the pour's impact: two rings spreading across the surface
    if (!still) for (let i = 0; i < 2; i++) {
      const r = el("ellipse", { cx, cy: surf, rx: sRx * 0.2, ry: sRy * 0.2, fill: "none",
        stroke: cream, "stroke-width": 1.2, opacity: 0 }, lift);
      r.style.transformOrigin = `${cx}px ${surf}px`;
      r.style.animation = `ripple 1.4s ease-out ${0.35 + i * 0.5}s 2`;
    }

    /* ---- the stream ---- */
    if (!still) {
      const stream = el("g", { opacity: 0 }, svg);
      stream.style.animation = "sway 1.5s ease-in-out infinite, streamlife 1.9s linear forwards";
      const wTop = Math.max(4, cupW * 0.05), wBot = wTop * 0.55;
      const sp = el("path", { d: `M${cx - wTop / 2},${coneBot} C${cx - wTop / 2},${coneBot + (surf - coneBot) * .6} ${cx - wBot / 2},${surf - 20} ${cx - wBot / 2},${surf}
                                  L${cx + wBot / 2},${surf} C${cx + wBot / 2},${surf - 20} ${cx + wTop / 2},${coneBot + (surf - coneBot) * .6} ${cx + wTop / 2},${coneBot} Z`,
        fill: coffee }, stream);
      sp.style.transformOrigin = `${cx}px ${coneBot}px`;
      sp.style.animation = "streamin .25s ease-out";
      el("path", { d: `M${cx - wTop * 0.12},${coneBot + 4} L${cx - wBot * 0.12},${surf - 6}`, stroke: cream,
        "stroke-width": 1, opacity: .35, "stroke-linecap": "round" }, stream);
      const splash = el("g", { opacity: 0 }, svg);
      splash.style.animation = "streamlife 1.9s linear forwards";
      for (let i = 0; i < 6; i++) {
        const d = el("circle", { cx, cy: surf - 2, r: 1.4 + (i % 3) * 0.7, fill: cream, opacity: 0 }, splash);
        d.style.setProperty("--dx", `${(i - 2.5) * (cupW * 0.1)}px`);
        d.style.animation = `splash .8s ease-out ${0.3 + i * 0.12}s infinite`;
      }
    }

    /* ---- glass on top of the coffee: rim, highlight, target line ---- */
    const ty = (y1 - 6) - inner * clamp01(target);
    el("ellipse", { cx, cy: ty, rx: halfW(ty) - 1, ry: ellRy(ty), fill: "none", stroke: cream,
      "stroke-width": 1.4, "stroke-dasharray": "4 5", opacity: .75 }, svg);
    text(svg, cx - halfW(ty) - 6, ty + 3, "target", { fill: cream, size: 10.5, weight: 600, anchor: "end" });

    el("path", { d: bodyD, fill: "none", stroke: ink, "stroke-width": 2, "stroke-linejoin": "round" }, svg);
    el("ellipse", { cx, cy: y0, rx: rimRx, ry: rimRy, fill: "none", stroke: ink, "stroke-width": 2 }, svg);
    el("path", { d: `M${cx - rimRx},${y0} A${rimRx},${rimRy} 0 0 1 ${cx + rimRx},${y0}`, fill: "none",
      stroke: cream, "stroke-width": 1.6, opacity: .5 }, svg);          // lit top edge
    el("path", { d: `M${cx - rimRx * 0.78},${y0 + cupH * 0.14} C${cx - rimRx * 0.86},${y0 + cupH * 0.4} ${cx - botRx * 0.8},${y0 + cupH * 0.62} ${cx - botRx * 0.72},${y0 + cupH * 0.8}`,
      fill: "none", stroke: "#fff", "stroke-width": 3, opacity: .1, "stroke-linecap": "round" }, svg);   // specular
    // handle
    el("path", { d: `M${cx + rimRx - 2},${y0 + cupH * 0.24} q${cupW * 0.34},${cupH * 0.04} ${cupW * 0.27},${cupH * 0.28}
                     q-${cupW * 0.015},${cupH * 0.2} -${cupW * 0.29},${cupH * 0.18}`,
      fill: "none", stroke: ink, "stroke-width": 2.4, "stroke-linecap": "round" }, svg);
    // it sits on something
    el("ellipse", { cx, cy: y1 + 7, rx: cupW * 0.62, ry: 7, fill: "#000", opacity: .35, filter: "url(#soft)" }, svg);

    /* ---- steam ---- */
    if (!cold && lv >= target) {
      [-0.26, 0, 0.26].forEach((off, i) => {
        const sx = cx + cupW * off;
        const p = el("path", { d: `M${sx},${y0 - rimRy - 4} q12,-15 0,-28 q-12,-15 0,-26`, fill: "none",
          stroke: cream, "stroke-width": 2.4, "stroke-linecap": "round", opacity: still ? .22 : 0,
          filter: "url(#soft)" }, svg);
        if (!still) { p.style.transformOrigin = `${sx}px ${y0}px`; p.style.animation = `steam 3.${i * 3}s ease-in-out ${1.8 + i * 0.55}s infinite`; }
      });
    }

    /* ---- how much of your window is left ---- */
    const aR = cupW * 0.92, aY = y1 + 20;
    const arc = (frac) => {
      const a0 = Math.PI * 0.12, a1 = Math.PI * 0.88;
      const e = a0 + (a1 - a0) * clamp01(frac);
      return `M${cx - aR * Math.cos(a0)},${aY + aR * Math.sin(a0) * 0.38} A${aR},${aR * 0.38} 0 0 1 ${cx - aR * Math.cos(e)},${aY + aR * Math.sin(e) * 0.38}`;
    };
    const ringCol = cold ? css("--critical") : ringFrac > 0.35 ? css("--good") : ringFrac > 0.12 ? css("--warning") : css("--critical");
    el("path", { d: arc(1), fill: "none", stroke: css("--border"), "stroke-width": 3, "stroke-linecap": "round" }, svg);
    if (ringFrac > 0.01) el("path", { d: arc(ringFrac), fill: "none", stroke: ringCol, "stroke-width": 3, "stroke-linecap": "round" }, svg);
    text(svg, cx, aY + 30, cold ? "your window has closed" : `${daysLeft} days of window left`,
      { fill: ringCol, size: 11.5, weight: 600, anchor: "middle" });
  });
}

/* ============================= the scale bar ============================= */
function renderScale(host, b, target) {
  if (!host) return;
  host.innerHTML = "";
  const track = document.createElement("div"); track.className = "track";
  const bandEl = document.createElement("div"); bandEl.className = "band";
  bandEl.style.left = (b.lo * 100) + "%";
  bandEl.style.width = Math.max(1.5, (b.hi - b.lo) * 100) + "%";
  const tgt = document.createElement("div"); tgt.className = "tgt";
  tgt.style.left = (target * 100) + "%";
  tgt.title = `your target · ${pct0(target)}`;
  track.append(bandEl, tgt);
  const ticks = document.createElement("div"); ticks.className = "ticks";
  ticks.innerHTML = `<span>nothing</span><span>half of it</span><span>all of it</span>`;
  host.append(track, ticks);
}

/* ============================= 1. decay curves ============================= */
/** Zoomed axis floor for the decay chart, in one place so the caption that
    describes the zoom cannot drift away from the chart that applies it. */
function decayFloor(series) {
  const lowest = Math.min(...series.flatMap((s) => s.points.map((p) => p.recall)));
  return Math.max(0, Math.floor((lowest - 0.08) * 10) / 10);
}

function renderDecay(series, days, weakest) {
  const host = $("#decayChart");
  const shown = () => series.filter((s) => !state.isolate || s.concept === state.isolate);

  chart(host, (svg, W, H) => {
    // Zoom the scale to the data: on a 0-100% axis eight subjects collapse into
    // one grey band in the top third. Both ends are labelled so the zoom is
    // visible rather than implied.
    const floor = decayFloor(series);
    const box = { x: 40, y: 14, w: W - 56, h: H - 40, min: floor, max: 1 };
    if (box.w < 60 || box.h < 60) return;
    host.dataset.axisFloor = Math.round(floor * 100);
    grid(svg, box, [floor, (floor + 1) / 2, 1], (t) => Math.round(t * 100) + "%");
    const X = (d) => box.x + (d / days) * box.w;
    const Y = (r) => box.y + box.h - (r - box.min) / (box.max - box.min) * box.h;

    el("line", { x1: X(days), x2: X(days), y1: box.y - 4, y2: box.y + box.h, stroke: css("--critical"), "stroke-width": 2 }, svg);
    text(svg, X(days), box.y - 8, "EXAM", { anchor: "end", fill: css("--critical"), size: 10, weight: 700, attrs: { "letter-spacing": ".08em" } });

    const list = shown();
    const ordered = [...list].sort((a, b) => (a.concept === weakest ? 1 : b.concept === weakest ? -1 : 0));
    const lead = list.find((s2) => s2.concept === (state.isolate || weakest));
    if (lead) {
      const fill = fadeUnder(svg, "decayfill", css("--series-1"), .26);
      el("path", { d: line(lead.points.map((p) => [X(p.day), Y(p.recall)])) +
        ` L${X(days)},${box.y + box.h} L${box.x},${box.y + box.h} Z`, fill, stroke: "none" }, svg);
    }
    for (const s of ordered) {
      const isWeak = s.concept === weakest || state.isolate === s.concept;
      animate(el("path", { d: line(s.points.map((p) => [X(p.day), Y(p.recall)])), fill: "none",
        stroke: isWeak ? css("--series-1") : css("--context"),
        "stroke-width": isWeak ? 2.5 : 1.5, "stroke-linecap": "round", opacity: isWeak ? 1 : .7 }, svg));
    }
    const weak = list.find((s) => s.concept === (state.isolate || weakest));
    if (weak) {
      const last = weak.points[weak.points.length - 1];
      el("circle", { cx: X(last.day), cy: Y(last.recall), r: 9, fill: css("--series-1"), opacity: .18 }, svg);
      el("circle", { cx: X(last.day), cy: Y(last.recall), r: 4.5, fill: css("--series-1"),
        stroke: css("--surface-1"), "stroke-width": 2 }, svg);
      text(svg, X(last.day) - 10, Y(last.recall) - 10, scaleWord(band(last.recall, days).mid) + " left",
        { anchor: "end", fill: css("--series-1"), size: 12, weight: 620 });
    }
    axis(svg, box);
    for (const d of [0, Math.round(days / 2), days])
      text(svg, X(d), box.y + box.h + 18, d === 0 ? "today" : `day ${d}`, { anchor: d === 0 ? "start" : d === days ? "end" : "middle" });

    // crosshair: the reader aims at a day, never at a 2px line
    const cross = el("line", { y1: box.y, y2: box.y + box.h, stroke: css("--border-strong"), "stroke-width": 1, opacity: 0 }, svg);
    const dot = el("circle", { r: 4, fill: css("--series-1"), stroke: css("--surface-1"), "stroke-width": 2, opacity: 0 }, svg);
    const hit = el("rect", { x: box.x, y: box.y, width: box.w, height: box.h, fill: "transparent" }, svg);
    const read = (e) => {
      const r = svg.getBoundingClientRect();
      const day = Math.max(0, Math.min(days, ((e.clientX - r.left) - box.x) / box.w * days));
      cross.setAttribute("x1", X(day)); cross.setAttribute("x2", X(day)); cross.setAttribute("opacity", 1);
      const rows = list.map((s) => {
        const p = s.points.reduce((a, b) => (Math.abs(b.day - day) < Math.abs(a.day - day) ? b : a));
        return { c: s.concept, r: p.recall };
      }).sort((a, b) => a.r - b.r);
      const avg = rows.reduce((a, b) => a + b.r, 0) / rows.length;
      dot.setAttribute("cx", X(day)); dot.setAttribute("cy", Y(avg)); dot.setAttribute("opacity", 1);
      const bb = band(avg, days);
      showTip(e, `day ${Math.round(day)}`, state.exact ? pct(avg) : `${pct0(bb.lo)}–${pct0(bb.hi)} overall`,
        rows.slice(0, 4).map((r) => ({ label: r.c, value: state.exact ? pct(r.r) : pct0(band(r.r, days).mid),
          colour: r.c === weakest ? css("--series-1") : css("--context") })));
      $("#decayRead").innerHTML =
        `<span>day <span class="rv num">${Math.round(day)}</span></span>` +
        `<span>overall <span class="rv num">${state.exact ? pct(avg) : pct0(bb.mid)}</span></span>` +
        `<span>weakest then · <span class="rv">${rows[0].c}</span></span>`;
    };
    hit.addEventListener("pointermove", read);
    hit.addEventListener("pointerdown", read);
    hit.addEventListener("pointerleave", () => {
      cross.setAttribute("opacity", 0); dot.setAttribute("opacity", 0); hideTip();
      $("#decayRead").innerHTML = `<span>hover the chart to read off any day between now and the exam</span>`;
    });
  });

  // legend doubles as the filter
  const leg = $("#decayLegend");
  leg.innerHTML = "";
  for (const s of series) {
    const li = document.createElement("li");
    li.className = "pick" + (state.isolate && state.isolate !== s.concept ? " off" : "");
    const sw = document.createElement("span"); sw.className = "swatch";
    sw.style.background = s.concept === weakest ? css("--series-1") : css("--context");
    const nm = document.createElement("span"); nm.textContent = s.concept;
    li.append(sw, nm);
    li.addEventListener("click", () => {
      state.isolate = state.isolate === s.concept ? null : s.concept;
      renderDecay(series, days, weakest); repaint($("#decayChart"));
    });
    leg.append(li);
  }
  $("#decayRead").innerHTML = `<span>hover the chart to read off any day between now and the exam</span>`;
}

/* ========================== 2. subjects, as ranges ========================== */
function renderConcepts(concepts, days, target) {
  chart($("#conceptChart"), (svg, W, H) => {
    const rows = concepts.length;
    const rowH = Math.max(24, Math.min(44, (H - 30) / rows));
    const labelW = Math.min(150, W * 0.36), barX = labelW + 10, barW = W - labelW - 78;
    if (barW < 40) return;
    concepts.forEach((c, i) => {
      const y = 14 + i * rowH, mid = y + rowH / 2;
      const b = band(c.recall, days);
      const name = c.concept.length > 22 ? c.concept.slice(0, 21) + "…" : c.concept;
      text(svg, labelW, mid + 4, name, { anchor: "end", fill: css("--text-secondary"), size: 12.5 });
      el("rect", { x: barX, y: mid - 7, width: barW, height: 14, rx: 5, fill: "rgba(255,235,212,.06)" }, svg);
      // the bar IS the range: left edge = low end, right edge = high end
      const x1 = barX + b.lo * barW, x2 = barX + b.hi * barW;
      el("path", { d: hBarPath(barX, mid - 7, Math.max(3, x1 - barX), 14, 5), fill: css("--series-1"), opacity: .45 }, svg);
      el("rect", { x: x1, y: mid - 7, width: Math.max(2, x2 - x1), height: 14, fill: css("--series-1") }, svg);
      // the ends of the range, and the target as one line down the whole column
      for (const ex of [x1, x2]) el("line", { x1: ex, x2: ex, y1: mid - 10, y2: mid + 10,
        stroke: css("--crema"), "stroke-width": 1.5, opacity: .55 }, svg);
      if (i === 0) {
        el("line", { x1: barX + target * barW, x2: barX + target * barW, y1: 15, y2: 15 + rows * rowH,
          stroke: css("--crema"), "stroke-width": 1.2, "stroke-dasharray": "3 4", opacity: .5 }, svg);
        text(svg, barX + target * barW + 4, 11, `target ${pct0(target)}`,
          { anchor: "start", fill: css("--crema"), size: 10, weight: 600 });
      }
      text(svg, barX + barW + 8, mid + 4,
        state.exact ? pct(c.recall) : `${pct0(b.lo)}–${pct0(b.hi)}`,
        { fill: css("--text-primary"), size: 12, weight: 600 });

      const hitTarget = el("rect", { x: 0, y, width: W, height: rowH, fill: "transparent" }, svg);
      hitTarget.addEventListener("pointermove", (e) => showTip(e, c.concept,
        state.exact ? pct(c.recall) + " on exam morning" : `${pct0(b.lo)}–${pct0(b.hi)} on exam morning`,
        [{ label: "facts", value: String(c.n_cards) },
         { label: "raw model output", value: pct(c.recall) },
         { label: "vs your target", value: b.mid >= target ? "clears it" : `${Math.round((target - b.mid) * 100)} pts short` }]));
      hitTarget.addEventListener("pointerleave", hideTip);
    });
  });
}

/* ============================== 3. the ceiling ============================== */
function renderCeiling(ceiling, days, target) {
  const host = $("#ceilingChart");
  const curve = ceiling.curve;
  chart(host, (svg, W, H) => {
    const floor = ceilingFloor(ceiling, target);
    const box = { x: 44, y: 18, w: W - 60, h: H - 46, min: floor, max: 1 };
    if (box.w < 60 || box.h < 60) return;
    const X = (d) => box.x + (d / days) * box.w;
    const Y = (r) => box.y + box.h - (r - box.min) / (box.max - box.min) * box.h;
    const ticks = [];
    for (let t = box.min; t <= 1.0001; t += (1 - box.min) / 3) ticks.push(Math.round(t * 1000) / 1000);
    grid(svg, box, ticks, (t) => Math.round(t * 100) + "%");
    host.dataset.axisFloor = Math.round(box.min * 100);

    const dl = ceiling.latest_start_day;
    if (dl !== null && dl < days) {
      el("rect", { x: X(dl), y: box.y, width: box.x + box.w - X(dl), height: box.h, fill: css("--critical"), opacity: .08 }, svg);
      el("rect", { x: X(dl), y: box.y, width: box.x + box.w - X(dl), height: box.h,
        fill: hatch(svg, "gone", css("--critical")) }, svg);
      text(svg, Math.min(box.x + box.w - 6, (X(dl) + box.x + box.w) / 2 + 62), box.y + box.h - 10,
        "out of reach at any effort", { anchor: "end", fill: css("--critical"), size: 11, weight: 600 });
    }

    el("line", { x1: box.x, x2: box.x + box.w, y1: Y(target), y2: Y(target), stroke: css("--good"), "stroke-width": 1.5 }, svg);
    text(svg, box.x + 8, Y(target) + 15, `your target · ${pct0(target)}`, { fill: css("--good"), size: 11, weight: 600 });

    el("path", { d: line(curve.map((p) => [X(p.start_day), Y(p.best_possible)])) +
      ` L${X(curve[curve.length - 1].start_day)},${box.y + box.h} L${box.x},${box.y + box.h} Z`,
      fill: fadeUnder(svg, "ceilfill", css("--series-1"), .22), stroke: "none" }, svg);
    animate(el("path", { d: line(curve.map((p) => [X(p.start_day), Y(p.best_possible)])), fill: "none",
      stroke: css("--series-1"), "stroke-width": 2.5, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg));

    if (dl !== null) {
      el("line", { x1: X(dl), x2: X(dl), y1: box.y, y2: box.y + box.h, stroke: css("--critical"), "stroke-width": 2 }, svg);
      const anchor = X(dl) > box.x + box.w * 0.6 ? "end" : "start";
      text(svg, X(dl) + (anchor === "end" ? -10 : 10), box.y - 4, `last day to start · day ${dl}`,
        { anchor, fill: css("--critical"), size: 12, weight: 650 });
    }
    axis(svg, box);
    for (const d of [0, Math.round(days / 3), Math.round(days * 2 / 3), days - 1])
      text(svg, X(d), box.y + box.h + 17, d === 0 ? "today" : "day " + d, { anchor: d === 0 ? "start" : "middle" });

    // a marker you can drag straight on the chart, wired to the slider both ways
    const liveDot = el("circle", { r: 7, fill: css("--series-1"), stroke: css("--surface-1"), "stroke-width": 2.5, opacity: 0 }, svg);
    const liveLine = el("line", { y1: box.y, y2: box.y + box.h, stroke: css("--border-strong"), "stroke-width": 1, opacity: 0 }, svg);
    host.moveMarker = (day) => {
      const p = curve.reduce((a, b) => (Math.abs(b.start_day - day) < Math.abs(a.start_day - day) ? b : a));
      liveDot.setAttribute("cx", X(p.start_day)); liveDot.setAttribute("cy", Y(p.best_possible));
      liveDot.setAttribute("opacity", 1);
      liveDot.setAttribute("fill", p.best_possible >= target ? css("--good") : css("--critical"));
      liveLine.setAttribute("x1", X(p.start_day)); liveLine.setAttribute("x2", X(p.start_day));
      liveLine.setAttribute("opacity", 1);
      return p;
    };
    const hit = el("rect", { x: box.x, y: box.y, width: box.w, height: box.h, fill: "transparent", cursor: "ew-resize" }, svg);
    const toDay = (e) => {
      const r = svg.getBoundingClientRect();
      return Math.max(0, Math.min(days - 1, Math.round(((e.clientX - r.left) - box.x) / box.w * days)));
    };
    const drag = (e) => {
      const d = toDay(e);
      const slider = $("#startday");
      slider.value = String(d);
      slider.dispatchEvent(new Event("input"));
      const p = host.moveMarker(d);
      showTip(e, `start on day ${p.start_day}`,
        state.exact ? pct(p.best_possible) + " ceiling" : `tops out ${pct0(band(p.best_possible, days).lo)}–${pct0(band(p.best_possible, days).hi)}`,
        [{ label: p.best_possible >= target ? "target still reachable" : "target gone at any effort", value: "" }]);
    };
    hit.addEventListener("pointermove", (e) => { if (e.buttons) drag(e); else {
      const p = host.moveMarker(toDay(e));
      showTip(e, `start on day ${p.start_day}`,
        state.exact ? pct(p.best_possible) : `${pct0(band(p.best_possible, days).lo)}–${pct0(band(p.best_possible, days).hi)}`,
        [{ label: p.best_possible >= target ? "still reachable" : "no longer reachable", value: "" }]);
    } });
    hit.addEventListener("pointerdown", (e) => { hit.setPointerCapture(e.pointerId); drag(e); });
    hit.addEventListener("pointerleave", hideTip);
    if (host._lastDay != null) host.moveMarker(host._lastDay);
    if (host._afterPaint) host._afterPaint();
  });
}
/** The zoomed axis floor. Computed in one place so the caption cannot drift
    away from the chart it describes. */
function ceilingFloor(ceiling, target) {
  const lo = Math.min(...ceiling.curve.map((p) => p.best_possible), target) - 0.06;
  return Math.max(0, Math.floor(lo * 20) / 20);
}

/* =============================== 4. the plan =============================== */
function renderPlan(plan, days) {
  chart($("#planChart"), (svg, W, H) => {
    const sessions = plan.sessions;
    const box = { x: 40, y: 14, w: W - 54, h: H - 40 };
    if (!sessions.length || box.w < 60) { text(svg, 10, 24, "No reviews needed — you are already above target.", { fill: css("--text-secondary"), size: 13 }); return; }
    const maxMin = Math.max(...sessions.map((s) => s.minutes));
    grid(svg, { ...box, min: 0, max: maxMin }, [0, maxMin / 2, maxMin], (t) => Math.round(t) + "m");
    // Every session lands in a narrow window near the exam. That emptiness is
    // the finding, so label it rather than zooming it away.
    const firstDay = Math.min(...sessions.map((s) => s.day)), lastDay = Math.max(...sessions.map((s) => s.day));
    const wx = box.x + (firstDay / days) * box.w, wr = box.x + (lastDay / days) * box.w;
    el("rect", { x: wx - 6, y: box.y, width: wr - wx + 12, height: box.h, fill: css("--series-1"), opacity: .07, rx: 6 }, svg);
    text(svg, Math.max(box.x + 4, wx - 12), box.y + 14,
      `all ${sessions.length} evenings sit here — day ${firstDay} to ${lastDay}`,
      { anchor: wx - 12 > box.x + 140 ? "end" : "start", fill: css("--text-secondary"), size: 11.5, weight: 600 });
    const planFill = (() => {
      const d = el("defs", {}, svg);
      const g = el("linearGradient", { id: "planbar", x1: "0%", y1: "0%", x2: "0%", y2: "100%" }, d);
      el("stop", { offset: "0%", "stop-color": css("--crema"), "stop-opacity": .95 }, g);
      el("stop", { offset: "100%", "stop-color": css("--series-1"), "stop-opacity": .9 }, g);
      return "url(#planbar)";
    })();
    const slot = box.w / Math.max(days, 1);
    const barW = Math.max(5, Math.min(14, slot - 3));
    for (const s of sessions) {
      const x = box.x + (s.day / days) * box.w - barW / 2;
      const h = Math.max(2, (s.minutes / maxMin) * box.h);
      const p = el("path", { d: barPath(x, box.y + box.h - h, barW, h, 4), fill: planFill }, svg);
      const hit = el("rect", { x: x - 4, y: box.y, width: barW + 8, height: box.h, fill: "transparent" }, svg);
      hit.addEventListener("pointermove", (e) => {
        p.setAttribute("fill", css("--crema"));
        showTip(e, `day ${s.day}`, `${Math.round(s.minutes)} min · ${s.cards} facts`,
          s.concepts.slice(0, 3).map((c) => ({ label: c, value: "" })));
      });
      hit.addEventListener("pointerleave", () => { p.setAttribute("fill", planFill); hideTip(); });
    }
    axis(svg, box);
    el("line", { x1: box.x + box.w, x2: box.x + box.w, y1: box.y, y2: box.y + box.h, stroke: css("--critical"), "stroke-width": 2 }, svg);
    text(svg, box.x + box.w, box.y + box.h + 17, "EXAM", { anchor: "end", fill: css("--critical"), size: 10, weight: 700 });
    for (const d of [0, Math.round(days / 3), Math.round(days * 2 / 3)])
      text(svg, box.x + (d / days) * box.w, box.y + box.h + 17, d === 0 ? "today" : "day " + d, { anchor: d === 0 ? "start" : "middle" });
  });

  // where the effort lands: evenings that touch each subject
  const counts = {};
  for (const s of plan.sessions) for (const c of s.concepts) counts[c] = (counts[c] || 0) + 1;
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  chart($("#planMixChart"), (svg, W, H) => {
    if (!rows.length) return;
    const rowH = Math.max(18, Math.min(30, (H - 10) / rows.length));
    const labelW = Math.min(140, W * 0.42), barX = labelW + 8, barW = W - labelW - 44;
    const max = Math.max(...rows.map((r) => r[1]));
    rows.forEach(([name, n], i) => {
      const mid = 8 + i * rowH + rowH / 2;
      text(svg, labelW, mid + 4, name.length > 20 ? name.slice(0, 19) + "…" : name, { anchor: "end", fill: css("--text-secondary"), size: 12 });
      el("path", { d: hBarPath(barX, mid - 5, Math.max(3, (n / max) * barW), 10, 4), fill: css("--series-1"), opacity: .9 }, svg);
      text(svg, barX + (n / max) * barW + 8, mid + 4, String(n), { fill: css("--text-primary"), size: 11.5, weight: 600 });
    });
  });
}

/* ============================ 5. the frontier ============================ */
function renderFrontier(data) {
  const host = $("#frontierChart");
  const pts = data.points;
  chart(host, (svg, W, H) => {
    const xs = pts.map((p) => p.recall_second), ys = pts.map((p) => p.recall_first);
    const pad = 0.03;
    const xmin = Math.min(...xs) - pad, xmax = Math.max(...xs) + pad;
    const ymin = Math.min(...ys) - pad, ymax = Math.max(...ys) + pad;
    const box = { x: 52, y: 16, w: W - 68, h: H - 62 };
    if (box.w < 60 || box.h < 60) return;
    const X = (v) => box.x + (v - xmin) / (xmax - xmin) * box.w;
    const Y = (v) => box.y + box.h - (v - ymin) / (ymax - ymin) * box.h;
    for (let i = 0; i <= 3; i++) {
      const v = ymin + (ymax - ymin) * i / 3;
      el("line", { x1: box.x, x2: box.x + box.w, y1: Y(v), y2: Y(v), stroke: css("--border"), "stroke-width": 1 }, svg);
      text(svg, box.x - 8, Y(v) + 4, Math.round(v * 100) + "%", { anchor: "end" });
      const h = xmin + (xmax - xmin) * i / 3;
      text(svg, X(h), box.y + box.h + 18, Math.round(h * 100) + "%", { anchor: i === 0 ? "start" : "middle" });
    }
    // the axis titles wear the same colours as the two cells in the trade panel
    text(svg, box.x + box.w / 2, H - 6, "what you hold at END-SEMS →", { anchor: "middle", fill: css("--series-2"), size: 11.5, weight: 600 });
    text(svg, -(box.y + box.h / 2), 13, "what you hold at MID-SEMS →",
      { anchor: "middle", fill: css("--series-1"), size: 11.5, weight: 600, attrs: { transform: "rotate(-90)" } });

    const live = pts.filter((p) => !p.dominated).sort((a, b) => a.recall_second - b.recall_second);
    animate(el("path", { d: line(live.map((p) => [X(p.recall_second), Y(p.recall_first)])), fill: "none",
      stroke: css("--series-1"), "stroke-width": 2, "stroke-linejoin": "round" }, svg));
    for (const p of pts) {
      el("circle", { cx: X(p.recall_second), cy: Y(p.recall_first), r: p.dominated ? 4 : 6,
        fill: p.dominated ? css("--context") : css("--series-1"), stroke: css("--surface-1"), "stroke-width": 2 }, svg);
      const hit = el("circle", { cx: X(p.recall_second), cy: Y(p.recall_first), r: 14, fill: "transparent" }, svg);
      hit.addEventListener("pointermove", (e) => showTip(e,
        `${Math.round(p.weight * 100)}% of your effort on mid-sems`,
        `${pct0(p.recall_first)} then ${pct0(p.recall_second)}`,
        [{ label: "reviews before mid-sems", value: String(p.reviews_before_first) },
         { label: "after", value: String(p.reviews_after_first) },
         ...(p.dominated ? [{ label: "dominated — never pick this", value: "" }] : [])]));
      hit.addEventListener("pointerleave", hideTip);
      hit.addEventListener("pointerdown", () => {
        const s = $("#tradeoff"); s.value = String(Math.round(p.weight * 100)); s.dispatchEvent(new Event("input"));
      });
    }
    const liveDot = el("circle", { r: 10, fill: "none", stroke: css("--crema"), "stroke-width": 2.5, opacity: 0 }, svg);
    host.moveMarker = (weight) => {
      const p = pts.reduce((a, b) => (Math.abs(b.weight - weight) < Math.abs(a.weight - weight) ? b : a));
      liveDot.setAttribute("cx", X(p.recall_second)); liveDot.setAttribute("cy", Y(p.recall_first));
      liveDot.setAttribute("opacity", 1);
      return p;
    };
    if (host._lastWeight != null) host.moveMarker(host._lastWeight);
  });
  return pts;
}

/* ========================== 6. the reliability curve ========================== */
function renderCalibration(data) {
  CAL.ece = data.ece; CAL.byHorizon = data.by_horizon; CAL.loaded = true;
  chart($("#calChart"), (svg, W, H) => {
    const box = { x: 46, y: 16, w: W - 62, h: H - 54 };
    if (box.w < 60 || box.h < 60) return;
    const lo = 0.25;
    const X = (v) => box.x + (v - lo) / (1 - lo) * box.w;
    const Y = (v) => box.y + box.h - (v - lo) / (1 - lo) * box.h;
    for (let v = 0.25; v <= 1.001; v += 0.25) {
      el("line", { x1: box.x, x2: box.x + box.w, y1: Y(v), y2: Y(v), stroke: css("--border"), "stroke-width": 1 }, svg);
      text(svg, box.x - 8, Y(v) + 4, Math.round(v * 100) + "%", { anchor: "end" });
      text(svg, X(v), box.y + box.h + 17, Math.round(v * 100) + "%", { anchor: "middle" });
    }
    el("line", { x1: X(lo), y1: Y(lo), x2: X(1), y2: Y(1), stroke: css("--good"), "stroke-width": 1.5 }, svg);
    text(svg, X(0.94), Y(0.99), "perfectly honest", { anchor: "end", fill: css("--good"), size: 11, weight: 600 });
    animate(el("path", { d: line(data.curve.map((b) => [X(b.predicted), Y(b.actual)])), fill: "none",
      stroke: css("--series-1"), "stroke-width": 2.5, "stroke-linejoin": "round" }, svg));
    for (const b of data.curve) {
      const r = Math.min(3 + Math.sqrt(b.n) / 90, 9);
      el("circle", { cx: X(b.predicted), cy: Y(b.actual), r, fill: css("--series-1"), stroke: css("--surface-1"), "stroke-width": 2 }, svg);
      const hit = el("circle", { cx: X(b.predicted), cy: Y(b.actual), r: 14, fill: "transparent" }, svg);
      hit.addEventListener("pointermove", (e) => showTip(e, `Cutoff said ${pct(b.predicted)}`,
        `${pct(b.actual)} actually recalled`, [{ label: "reviews in this bin", value: b.n.toLocaleString() }]));
      hit.addEventListener("pointerleave", hideTip);
    }
    text(svg, box.x + box.w / 2, H - 4, "what Cutoff predicted", { anchor: "middle", fill: css("--text-secondary"), size: 11.5 });
    text(svg, -(box.y + box.h / 2), 12, "what actually happened",
      { anchor: "middle", fill: css("--text-secondary"), size: 11.5, attrs: { transform: "rotate(-90)" } });
  });

  $("#calCaption").textContent = `${data.reviews.toLocaleString()} held-out reviews. Dot size is how many fall in that bin.`;
  const last = data.by_horizon[data.by_horizon.length - 1];
  $("#horizonTable").innerHTML = `<table><thead><tr><th>how far ahead</th><th>predicted</th><th>actual</th><th>gap</th></tr></thead><tbody>
    ${data.by_horizon.map((h) => `<tr><td>${h.label}</td><td class="num">${pct(h.predicted)}</td>
      <td class="num">${pct(h.actual)}</td><td class="num" style="color:var(--warning)">+${((h.predicted - h.actual) * 100).toFixed(1)}</td></tr>`).join("")}
    </tbody></table>`;
  $("#calNote").innerHTML = `Expected calibration error <strong style="color:var(--text-primary)">${data.ece.toFixed(4)}</strong>.
    Every gap is positive, so Cutoff is consistently a little <em>over</em>confident. Three months out it is off by
    ${((last.predicted - last.actual) * 100).toFixed(1)} points — and forecasting months ahead is the entire premise, which is why
    every figure in this app is shown as a range that wide, shifted down by the bias measured here.`;
  if (state.forecast) renderAll();     // bands were provisional until this landed
}

/* ============================ 7. the proof table ============================ */
function renderProof(data) {
  const host = $("#proofTable");
  const PLAIN = [
    [/unfitted/i, "Cutoff, before it learned anything", "baseline"],
    [/DSR|fitted/i, "Cutoff, after learning from real data", "fitted"],
    [/HLR/i, "A well-known 2016 model, built by us", "hlr"],
    [/AVG|mean/i, "Just guessing the average every time", "avg"],
  ];
  const label = (name) => PLAIN.find(([re]) => re.test(name)) || [null, name, "other"];
  const rows = Object.entries(data.ours).map(([name, s]) => {
    const [, plain, kind] = label(name);
    return { name: plain, kind, ...s };
  });
  const fmt = (v, d = 4) => (v === null || v === undefined || Number.isNaN(v) ? "—" : v.toFixed(d));
  const best = { log_loss: Math.min(...rows.map((r) => r.log_loss)), rmse_bins: Math.min(...rows.map((r) => r.rmse_bins)), auc: Math.max(...rows.map((r) => r.auc)) };
  const cell = (r, k) => `<td class="num"${Math.abs(r[k] - best[k]) < 1e-9 ? ' style="color:var(--good);font-weight:650"' : ""}>${fmt(r[k])}</td>`;

  host.classList.remove("loading");
  host.innerHTML = `<table><thead><tr><th>what we tested</th>
      <th>how wrong it is<br><span class="tech">log loss · lower is better</span></th>
      <th>how honest it is<br><span class="tech">calibration · lower is better</span></th>
      <th>can it tell them apart?<br><span class="tech">AUC · 0.50 is a coin flip</span></th></tr></thead>
    <tbody>${rows.map((r) => `<tr class="${r.kind === "fitted" ? "ours" : ""}"><td>${r.name}</td>${cell(r, "log_loss")}${cell(r, "rmse_bins")}${cell(r, "auc")}</tr>`).join("")}</tbody></table>
    <p class="note"><strong style="color:var(--text-secondary)">Published, for reference.</strong> Measured on roughly 350 million
      reviews from 9,999 collections — ours is a ${data.collections}-collection sample, so read the ordering, not the decimals.
      These are not our numbers and we do not claim to have beaten them.</p>
    <table><thead><tr><th>published results, for context</th><th class="tech">log loss</th><th class="tech">calibration</th><th class="tech">AUC</th></tr></thead>
      <tbody>${Object.entries(data.published).map(([n, s]) => `<tr><td style="color:var(--text-muted)">${n}</td>
        <td class="num" style="color:var(--text-muted)">${fmt(s.log_loss)}</td><td class="num" style="color:var(--text-muted)">${fmt(s.rmse_bins)}</td>
        <td class="num" style="color:var(--text-muted)">${fmt(s.auc)}</td></tr>`).join("")}</tbody></table>`;

  const fitted = rows.find((r) => r.kind === "fitted") || rows[0];
  $("#proofStats").innerHTML = [
    ["answers tested on", fitted.n.toLocaleString(), "none of which it had seen"],
    ["real people", String(data.collections), "their actual study records"],
    ["how honest", fitted.rmse_bins.toFixed(3), "say 85%, and about 85% happen"],
    ["beats guessing by", `${((fitted.auc - 0.5) * 200).toFixed(0)}%`, "remembered vs forgotten"],
  ].map(([k, v, s]) => `<div class="stat"><div class="k">${k}</div><div class="v num">${v}</div><div class="s">${s}</div></div>`).join("");

  $("#proofNote").innerHTML = "<strong>Why this is a fair test.</strong> For each person we picked a date, let Cutoff learn " +
    "only from before it, and scored it only on after. It never saw a single answer it was asked to predict. We first tried " +
    "splitting each flashcard separately — that quietly made the test easier, because a card's last few reviews are its easiest " +
    "ones, and it flattered the score by three points. So we threw that version out.";
}

const FINDINGS = [
  ["Duolingo's data has almost no forgetting curve.",
   "We started there — 12.85 million traces. Recall barely moves with time: 90.6% under a day, 86.8% after a month. The scheduler grants 58 days after a success and 10.4 after a lapse, so a long gap is a <em>reward for strength</em>, and the two effects cancel. Conditioning on repetition number brings the curve back. We moved the model to Anki logs, where people genuinely forget."],
  ["The 2016 model loses to predicting the average.",
   "We implemented half-life regression from the ACL paper and reproduced its published baselines within a few points — then watched it score below chance on Anki data, because it has no notion of stability and so reads a long gap as weakness. That failure is the whole argument for a difficulty–stability–retrievability model."],
  ["Cramming beats spacing for one fixed exam date.",
   "At identical effort, in our own model: 90.0% crammed against 75.4% spread evenly, and cramming still leads three months later. We are not going to tell you otherwise. What makes scheduling matter is that you cannot sit through six hundred cards the night before — and once each night has a limit, there is a last day you can start."],
];
function renderFindings() {
  $("#findings").innerHTML = FINDINGS.map(([h, b]) => `
    <div style="padding:14px 0;border-bottom:1px solid var(--border)">
      <div style="font-weight:620;font-size:14px;margin-bottom:5px">${h}</div>
      <div style="color:var(--text-secondary);font-size:13px;line-height:1.6">${b}</div></div>`).join("");
}

/* ============================== the explainer ============================== */
function renderExplainCurve() {
  chart($("#explainCurve"), (svg, W, H) => {
    const box = { x: 42, y: 14, w: W - 56, h: H - 40, min: 0.4, max: 1 };
    if (box.w < 60 || box.h < 50) return;
    grid(svg, box, [0.4, 0.7, 1], (t) => Math.round(t * 100) + "%");
    const DAYS = 60;
    const X = (d) => box.x + (d / DAYS) * box.w;
    const Y = (r) => box.y + box.h - (r - box.min) / (box.max - box.min) * box.h;
    const decay = (t, S) => Math.pow(1 + (Math.pow(0.9, -1 / 0.5) - 1) * t / S, -0.5);
    for (const [S, colour, lab] of [[4, css("--series-1"), "barely learned"], [45, css("--series-2"), "properly stuck"]]) {
      animate(el("path", { d: line(Array.from({ length: 60 }, (_, i) => [X(i), Y(decay(i, S))])), fill: "none",
        stroke: colour, "stroke-width": 2.5, "stroke-linecap": "round" }, svg));
      text(svg, X(DAYS) - 4, Y(decay(DAYS - 1, S)) - 9, lab, { anchor: "end", fill: colour, size: 12, weight: 620 });
    }
    axis(svg, box);
    for (const d of [0, 30, 59]) text(svg, X(d), box.y + box.h + 17, d === 0 ? "today" : `${d + 1} days later`,
      { anchor: d === 0 ? "start" : d === 59 ? "end" : "middle" });
  });
}

/* ================================ courses ================================ */
function renderCourses() {
  const total = state.courses.reduce((n, c) => n + (c.n || CARDS_PER_COURSE), 0);
  $("#percourse").textContent = total.toLocaleString();
  $("#courses").innerHTML = state.courses.map((c, i) => `
    <div class="course">
      <div><div class="name">${c.name}</div>
        <div class="meta">${c.topics ? `${c.topics} topics · ${c.n} facts` : `${c.n} facts`} · you say it's ${GRADE_WORDS[c.rating]}</div></div>
      <div class="grades" data-i="${i}">${[1, 2, 3, 4].map((g) => `<button data-g="${g}" aria-pressed="${c.rating === g}">${g}</button>`).join("")}</div>
    </div>`).join("");
  $$(".grades").forEach((row) => row.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    state.courses[+row.dataset.i].rating = +b.dataset.g;
    renderCourses();
  }));
}

/* ================================= wiring ================================= */
const api = async (path, body) => {
  const r = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
};

function daysToExam() {
  const v = $("#examdate").value;
  if (!v) return 87;
  const d = Math.round((new Date(v + "T00:00:00") - new Date(new Date().toDateString())) / 86400000);
  return Math.max(1, d);
}

/* --------------------------------- router --------------------------------- */
const SCREENS = {
  home:       ["Today", "Where you actually stand, in one cup."],
  syllabus:   ["My syllabus", "What you're studying, and how well you know it. Everything else is computed from this."],
  forecast:   ["What I'll forget", "Your syllabus, projected to the morning of the exam."],
  deadline:   ["My cutoff", "The last day you can start and still get there."],
  plan:       ["The plan", "The smallest schedule that reaches your target."],
  twoexams:   ["Two exams", "Mid-sems and end-sems, competing for the same nights."],
  focus:      ["Focus", "One session at a time. The cup fills while you work."],
  howitworks: ["How it works", "Three ideas, and no maths."],
  proof:      ["Can I trust it?", "Half a million real answers it had never seen."],
};
function showScreen(name) {
  if (!SCREENS[name]) name = "home";
  $$(".navbtn[data-screen]").forEach((b) => b.setAttribute("aria-current", String(b.dataset.screen === name)));
  $$("section.screen").forEach((s) => s.classList.toggle("active", s.id === "screen-" + name));
  $("#pageTitle").textContent = SCREENS[name][0];
  $("#pageSub").textContent = SCREENS[name][1];
  $("#scroller").scrollTop = 0;
  if (location.hash.slice(1) !== name) history.replaceState(null, "", "#" + name);
  // charts built while their pane was hidden measured 0x0 and drew nothing;
  // now that the pane is laid out, give them their size
  const wake = () => $$("#screen-" + name + " .plot").forEach(repaint);
  requestAnimationFrame(wake);
  setTimeout(wake, 80);
  if (name === "twoexams" && !frontierPoints && state.cards.length) runFrontier();
}
const wanted = () => (SCREENS[location.hash.slice(1)] ? location.hash.slice(1) : "home");

/* ---------------------------------- rail ----------------------------------
   On a narrow screen the rail is an overlay, so it starts closed and closes
   again on the way to wherever you tapped. The desktop preference is not
   overwritten by what happens on a phone. */
const narrow = () => matchMedia("(max-width: 860px)").matches;
function setRail(collapsed, persist = true) {
  $("#rail").classList.toggle("collapsed", collapsed);
  $("#railToggle").querySelector(".txt").textContent = collapsed ? "Show menu" : "Hide menu";
  $("#railToggle").title = (collapsed ? "Show" : "Hide") + " the menu  ( [ )";
  if (persist && !narrow()) store.set("rail", collapsed);
  setTimeout(() => $$(".screen.active .plot").forEach(repaint), 300);
}

/* ------------------------------- the render ------------------------------- */
function renderAll() {
  const { forecast, ceiling, plan, curves, days, target, cap } = state;
  if (!forecast) return;
  const dl = ceiling.latest_start_day;
  const gone = dl === null;
  const overall = figure(forecast.overall_recall, days);
  const weakest = forecast.per_concept[0];

  /* --- top bar --- */
  $("#chipDays").innerHTML = `<span class="d" style="background:var(--series-2)"></span>exam in <b>${days} days</b>`;
  $("#chipCutoff").innerHTML = gone
    ? `<span class="d" style="background:var(--critical)"></span><b>cutoff passed</b>`
    : `<span class="d" style="background:${dl > days * 0.4 ? "var(--good)" : dl > days * 0.15 ? "var(--warning)" : "var(--critical)"}"></span>start by <b>day ${dl}</b>`;
  $("#focusDot").style.display = timer.running ? "block" : "none";

  /* --- the cup --- */
  const shown = state.exact ? forecast.overall_recall : overall.b.mid;
  renderCup(shown, target, gone ? 0 : dl / days, gone, gone ? 0 : dl);
  renderGauge(shown, target, gone ? 0 : dl / days, gone);
  $("#cupWords").textContent = state.exact ? pct(forecast.overall_recall) : overall.head;
  $("#cupRange").innerHTML = `of your syllabus — <b>${scaleWord(overall.b.mid)}</b> — on exam morning, if you did nothing between now and then.<br>` + overall.sub;
  renderScale($("#cupScale"), overall.b, target);
  $("#cupStats").innerHTML = [
    ["days you can wait", gone ? "0" : String(dl), gone ? "the window closed" : "before the target goes"],
    ["your target", pct0(target), "on exam morning"],
    ["facts tracked", state.cards.length.toLocaleString(), `across ${forecast.per_concept.length} subjects`],
  ].map(([k, v, s]) => `<div class="stat"><div class="k">${k}</div><div class="v num">${v}</div><div class="s">${s}</div></div>`).join("");

  /* --- verdict, on two screens --- */
  const verdictHTML = gone
    ? `<div class="verdict"><div class="big">${pct0(target)} is already out of reach.</div>
       <div class="small">Even starting tonight and filling every night to ${cap} facts, the best you can reach is
       ${state.exact ? pct(ceiling.ceiling_if_you_start_today) : `about ${pct0(band(ceiling.ceiling_if_you_start_today, days).mid)}`}.
       The deadline passed before you opened this.</div></div>`
    : `<div class="verdict ${dl > days * 0.5 ? "" : "ok"}"><div class="big">You have until day ${dl}.</div>
       <div class="small">Start then and ${pct0(target)} is still reachable. Wait until day
       ${ceiling.ceiling_if_you_wait_until_day.day} and your ceiling is
       ${state.exact ? pct(ceiling.ceiling_if_you_wait_until_day.best_possible) : `about ${pct0(band(ceiling.ceiling_if_you_wait_until_day.best_possible, days).mid)}`}
       — at maximum effort, and nothing closes it. The deadline is not the exam.</div></div>`;
  $("#verdict").innerHTML = verdictHTML;
  $("#verdict2").innerHTML = verdictHTML;

  /* --- what to do tonight --- */
  const first = plan.sessions[0];
  const items = [];
  items.push(gone
    ? ["!", "Lower your target, or accept the ceiling.", `${pct0(target)} can't be reached any more. Flat out from tonight gets you about ${pct0(band(ceiling.ceiling_if_you_start_today, days).mid)}. That's the honest number.`, true]
    : dl <= 3 ? ["!", "Start tonight.", `Your cutoff is day ${dl}. That's basically now.`, true]
    : ["1", `Start by day ${dl}. Not before, not after.`, "Earlier mostly fades before the exam; later runs out of nights. Put it in your calendar today.", false]);
  if (first) items.push(["2", `First session: ${first.cards} facts, about ${Math.round(first.minutes)} minutes.`,
    `Mostly ${first.concepts.slice(0, 2).join(" and ")}. Not a whole evening — one sitting.`, false]);
  items.push(["3", `Fix ${weakest.concept} first.`, `Weakest at ${scaleWord(band(weakest.recall, days).mid)}, so an hour there is worth more than an hour anywhere else.`, false]);
  $("#todo").innerHTML = items.map(([n, t, d, hot]) =>
    `<div class="todo ${hot ? "hot" : ""}"><div class="badge">${n}</div><div><div class="tt">${t}</div><div class="td">${d}</div></div></div>`).join("");

  /* --- subject strip --- */
  $("#subjectCards").innerHTML = forecast.per_concept.map((c) => {
    const b = band(c.recall, days);
    const h = b.mid >= target ? ["var(--good)", "fine"] : b.mid >= target - 0.15 ? ["var(--warning)", "slipping"] : ["var(--critical)", "needs you"];
    const pips = [...Array(5)].map((_, i) => `<i style="background:${i < Math.round(b.mid * 5) ? h[0] : "rgba(255,235,212,.14)"}"></i>`).join("");
    return `<div class="subj" title="${pct(c.recall)} raw · ${pct0(b.lo)}–${pct0(b.hi)} calibrated · ${c.n_cards} facts">
      <div class="nm">${c.concept}</div><div class="pips">${pips}</div>
      <div class="wd">${state.exact ? pct(c.recall) : scaleWord(b.mid)}</div>
      <div class="st" style="color:${h[0]}">${h[1]} · ${state.exact ? "" : pct0(b.lo) + "–" + pct0(b.hi)}</div></div>`;
  }).join("");

  /* --- forecast screen --- */
  $("#heroWords").textContent = state.exact ? pct(forecast.overall_recall) : overall.head;
  $("#heroRange").innerHTML = `of your syllabus, on exam morning, if you did nothing between now and then. ` + overall.sub;
  $("#forecastStats").innerHTML = [
    ["days to exam", String(days), ""],
    ["facts tracked", state.cards.length.toLocaleString(), ""],
    ["weakest", forecast.weakest_concept, state.exact ? pct(weakest.recall) : scaleWord(band(weakest.recall, days).mid)],
    ["you'd lose", state.exact ? pct0(1 - forecast.overall_recall) : `~${Math.round((1 - overall.b.mid) * 10)} in 10`, "of the syllabus"],
  ].map(([k, v, s]) => `<div class="stat"><div class="k">${k}</div><div class="v" style="font-size:${String(v).length > 12 ? 15 : 20}px">${v}</div>${s ? `<div class="s">${s}</div>` : ""}</div>`).join("");
  renderDecay(curves.series, days, forecast.weakest_concept);
  $("#decayCaption").textContent = `Drawn by the memory model we trained, not by a chatbot. The scale starts at ` +
    `${Math.round(decayFloor(curves.series) * 100)}% so the subjects separate instead of stacking in the top third.`;
  renderConcepts(forecast.per_concept, days, target);

  /* --- cutoff screen --- */
  renderCeiling(ceiling, days, target);
  $("#capEcho").textContent = String(cap);
  $("#ceilingCaption").textContent = `Assumes ${cap} facts a night, every night, no days off — the absolute best case. ` +
    `The scale starts at ${Math.round(ceilingFloor(ceiling, target) * 100)}% so the cliff is visible instead of flattened.`;
  $("#ceilStats").innerHTML = [
    ["if you start today", state.exact ? pct(ceiling.ceiling_if_you_start_today) : `~${pct0(band(ceiling.ceiling_if_you_start_today, days).mid)}`, "at maximum effort"],
    [`if you wait to day ${ceiling.ceiling_if_you_wait_until_day.day}`, state.exact ? pct(ceiling.ceiling_if_you_wait_until_day.best_possible) : `~${pct0(band(ceiling.ceiling_if_you_wait_until_day.best_possible, days).mid)}`, "also at maximum effort"],
    ["facts per night", String(cap), "your own number"],
  ].map(([k, v, s]) => `<div class="stat"><div class="k">${k}</div><div class="v num">${v}</div><div class="s">${s}</div></div>`).join("");

  const scrub = $("#startday");
  scrub.max = String(Math.max(1, days - 1));
  const updateScrub = () => {
    const day = +scrub.value;
    const host = $("#ceilingChart");
    host._lastDay = day;
    // read the answer off the data, not off the chart -- the chart may not have
    // been drawn yet (its pane can still be hidden) and the number is still true
    const p = ceiling.curve.reduce((a, b) => (Math.abs(b.start_day - day) < Math.abs(a.start_day - day) ? b : a));
    if (host.moveMarker) host.moveMarker(day);
    $("#scrubDay").textContent = p.start_day === 0 ? "if you start today" : `if you start on day ${p.start_day}`;
    const ok = p.best_possible >= target;
    const bb = band(p.best_possible, days);
    $("#scrubVal").innerHTML = `<span style="color:${ok ? css("--good") : css("--critical")}">` +
      `${state.exact ? pct(p.best_possible) : `${pct0(bb.lo)}–${pct0(bb.hi)}`}${ok ? "" : " — target gone"}</span>`;
  };
  scrub.oninput = updateScrub;
  $("#ceilingChart")._afterPaint = updateScrub;   // the readout waits for the chart to exist
  if (scrub.value === "0" || +scrub.value > days) scrub.value = String(gone ? 0 : dl);
  updateScrub();

  /* --- plan screen --- */
  $("#planStats").innerHTML = [
    ["from", state.exact ? pct0(plan.recall_before) : scaleWord(band(plan.recall_before, days).mid), ""],
    ["to", state.exact ? pct0(plan.recall_after) : scaleWord(band(plan.recall_after, days).mid), ""],
    ["total time", `${Math.round(plan.total_minutes)}<small> min</small>`, ""],
    ["evenings", String(plan.sessions.length), ""],
    ["reviews", plan.total_reviews.toLocaleString(), ""],
    ["target met", plan.target_met ? "yes" : "no", plan.target_met ? "" : "not enough nights"],
  ].map(([k, v, s]) => `<div class="stat"><div class="k">${k}</div><div class="v num">${v}</div>${s ? `<div class="s">${s}</div>` : ""}</div>`).join("");
  renderPlan(plan, days);
  $("#planCaption").textContent = plan.target_met
    ? `${Math.round(plan.total_minutes)} minutes in total, across ${plan.sessions.length} evenings.`
    : `Even flat out this only reaches ${pct0(plan.recall_after)} — there aren't enough nights left for your target.`;
  $("#tonightBox").innerHTML = first
    ? `<div class="readout"><div class="words" style="font-size:34px">${first.cards} facts</div>
       <div class="rangeline">about <b>${Math.round(first.minutes)} minutes</b>, mostly ${first.concepts.slice(0, 2).join(" and ")}.
       It's the session the planner wants from you first, on day ${first.day}.</div></div>`
    : `<p class="sub">Nothing scheduled — you're already above target.</p>`;
  renderFocusTarget();
}

/* --------------------------------- the run --------------------------------- */
async function run({ navigate = false } = {}) {
  const days = daysToExam(), cap = +$("#cap").value || 40, target = +$("#target").value;
  state.days = days; state.cap = cap; state.target = target;

  const items = state.courses.flatMap((c) =>
    Array.from({ length: c.n || CARDS_PER_COURSE }, (_, i) => ({ card_id: `${c.name.slice(0, 4)}-${i}`, concept: c.name, rating: c.rating })));

  const btn = $("#run"); btn.disabled = true; btn.textContent = "Computing…";
  clearFail();
  let result;
  try {
    state.cards = (await api("/api/calibrate", items)).cards;
    const payload = { cards: state.cards, days_to_exam: days, target_recall: target, max_reviews_per_day: cap };
    const [forecast, curves, ceiling, plan] = await Promise.all([
      api("/api/forecast", { cards: state.cards, days_to_exam: days }),
      api("/api/curves", { cards: state.cards, days_to_exam: days }),
      api("/api/ceiling", payload),
      api("/api/plan", payload),
    ]);
    result = { forecast, curves, ceiling, plan };
  } catch (err) {
    btn.disabled = false; btn.textContent = "Forecast my exam →";
    fail("Could not reach the model.", err);
    return;
  }
  try {
    Object.assign(state, { ...result, isolate: null });
    frontierPoints = null;
    renderAll();
    if (navigate) showScreen("home");
    // a deep link to the two-exam screen arrives before the cards exist
    if (location.hash.slice(1) === "twoexams") runFrontier();
    requestAnimationFrame(() => $$(".screen.active .plot").forEach(repaint));
  } catch (err) {
    fail("The model answered, but the interface failed while drawing it.", err);
  } finally {
    btn.disabled = false; btn.textContent = "Forecast my exam →";
  }
}

/* ------------------------------- two exams ------------------------------- */
let frontierPoints = null;
async function runFrontier() {
  if (!state.cards.length) return;
  const first = +$("#exam1").value, second = +$("#exam2").value;
  const budget = Math.round(+$("#budget").value / 0.5);
  if (second <= first) { fail("The second exam has to come after the first.", "Set end-sems to a later day than mid-sems."); return; }
  const btn = $("#runFrontier"); btn.disabled = true; btn.textContent = "Computing…";
  // eight full schedules, simulated night by night -- say so rather than
  // showing an empty card for eight seconds
  const host = $("#frontierChart");
  host._draw = null; host._painted = false; host.classList.add("loading");
  host.textContent = "simulating eight revision plans, night by night…";
  try {
    const data = await api("/api/frontier", {
      cards: state.cards, first_exam_day: first, second_exam_day: second, budget,
      max_reviews_per_day: +$("#cap").value || 40, weights: [0, 0.3, 0.42, 0.48, 0.52, 0.58, 0.7, 1.0],
    });
    frontierPoints = renderFrontier(data);
    $("#frontierCaption").textContent = `Every dot is a real plan using the same ${Math.round(data.minutes)} minutes. ` +
      `Up is better at mid-sems, right is better at end-sems. Grey dots lose at BOTH — never pick one. Click a dot to select it.`;
    const slider = $("#tradeoff");
    const update = () => {
      const w = +slider.value / 100;
      const host = $("#frontierChart");
      host._lastWeight = w;
      const p = host.moveMarker(w);
      $("#tradeGrid").innerHTML = `
        <div class="tradecell"><div class="k">mid-sems · day ${first}</div>
          <div class="v num" style="color:var(--series-1)">${state.exact ? pct(p.recall_first) : pct0(band(p.recall_first, first).mid)}</div>
          <div class="s">${p.reviews_before_first} reviews before it</div></div>
        <div class="tradecell"><div class="k">end-sems · day ${second}</div>
          <div class="v num" style="color:var(--series-2)">${state.exact ? pct(p.recall_second) : pct0(band(p.recall_second, second).mid)}</div>
          <div class="s">${p.reviews_after_first} reviews after</div></div>`;
    };
    slider.oninput = update;
    update();
    const best = data.points.reduce((a, b) => (b.recall_first > a.recall_first ? b : a));
    const worst = data.points.reduce((a, b) => (b.recall_first < a.recall_first ? b : a));
    $("#frontierVerdict").innerHTML = `<div class="verdict">
      <div class="big">${pct0(best.recall_first)} then ${pct0(best.recall_second)} — or ${pct0(worst.recall_first)} then ${pct0(worst.recall_second)}.</div>
      <div class="small">Identical nights. Identical effort. No schedule wins both, so this is a choice you are
        making whether or not you know you are making it.</div></div>`;
  } catch (err) {
    fail("Could not compute the frontier.", err);
  } finally { btn.disabled = false; btn.textContent = "Compute the frontier"; }
}

/* ================================ the timer ================================
   A focus clock that finishes in cups. Sessions are kept in this browser and
   nowhere else — there is no account, and nothing leaves the page. */
const timer = { minutes: store.get("preset", 25), left: store.get("preset", 25) * 60, running: false, endsAt: 0, tick: null };
const todayKey = () => "cups." + new Date().toISOString().slice(0, 10);

function fmtClock(s) {
  s = Math.max(0, Math.ceil(s));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
let dialSec = null, dialState = "";
function renderDial() {
  const frac = 1 - timer.left / (timer.minutes * 60);
  const sec = Math.ceil(timer.left), st = timer.running ? "run" : "hold";
  // The clock text updates four times a second; the drawing only needs to when
  // the second changes -- and rebuilding it more often restarts its animations.
  const redraw = sec !== dialSec || st !== dialState;
  dialSec = sec; dialState = st;
  if (redraw) chart($("#timerRing"), (svg, W, H) => {
    const cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 12;
    const C = 2 * Math.PI * R;
    el("circle", { cx, cy, r: R, fill: "none", stroke: css("--border"), "stroke-width": 6 }, svg);
    // the dial fills like a cup as the session runs
    const clip = el("clipPath", { id: "dialclip" }, svg);
    el("circle", { cx, cy, r: R - 5 }, clip);
    const g = el("g", { "clip-path": "url(#dialclip)" }, svg);
    const top = cy + R - 2 * R * clamp01(frac);
    // the cup fills as the session runs, wave and all
    const amp = 4, seg = R / 2;
    let w = `M${cx - R * 2},${top}`;
    for (let i = 0; i < 8; i++) w += ` q${seg / 2},${(i % 2 ? 1 : -1) * amp} ${seg},0`;
    w += ` L${cx + R * 2},${cy + R} L${cx - R * 2},${cy + R} Z`;
    const slide = el("g", {}, g);
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches && timer.running)
      slide.style.animation = "slosh 6s linear infinite";
    el("path", { d: w, fill: css("--series-1"), opacity: .17 }, slide);
    el("path", { d: w.replace(`M${cx - R * 2},${top}`, `M${cx - R * 2},${top + 2}`), fill: css("--crema"), opacity: .08 }, slide);
    el("circle", { cx, cy, r: R, fill: "none", stroke: css("--series-1"), "stroke-width": 6, "stroke-linecap": "round",
      transform: `rotate(-90 ${cx} ${cy})`, "stroke-dasharray": `${C * clamp01(frac)} ${C}` }, svg);
  });
  $("#timerClock").textContent = fmtClock(timer.left);
  $("#timerState").textContent = timer.running ? "brewing" : timer.left === timer.minutes * 60 ? "ready to brew" : "paused";
  $("#timerStart").textContent = timer.running ? "Pause" : timer.left === timer.minutes * 60 ? "Start brewing" : "Resume";
  document.title = timer.running ? `${fmtClock(timer.left)} · Cutoff` : "Cutoff — the last day you can still pass";
  const dot = $("#focusDot"); if (dot) dot.style.display = timer.running ? "block" : "none";
}
function renderCups() {
  const cups = store.get(todayKey(), { count: 0, minutes: 0 });
  const glyphs = [...Array(Math.max(cups.count, 1))].map((_, i) => `
    <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="${i < cups.count ? "var(--accent)" : "var(--border-strong)"}"
      stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="opacity:${i < cups.count ? 1 : .35}">
      <path d="M4 9h13v6a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M17 11h1.6a2.4 2.4 0 0 1 0 4.8H17"/></svg>`).join("");
  $("#cupsToday").innerHTML = `<div style="display:flex;gap:8px;flex-wrap:wrap">${glyphs}</div>`;
  $("#focusStats").innerHTML = [
    ["cups today", String(cups.count), cups.count ? "sessions finished" : "none yet"],
    ["minutes focused", String(Math.round(cups.minutes)), "today"],
  ].map(([k, v, s]) => `<div class="stat"><div class="k">${k}</div><div class="v num">${v}</div><div class="s">${s}</div></div>`).join("");
}
function renderFocusTarget() {
  const first = state.plan && state.plan.sessions[0];
  const cups = store.get(todayKey(), { count: 0, minutes: 0 });
  if (!first) { $("#focusTarget").innerHTML = `<p class="sub">Run a forecast and the planner will tell you what tonight is for.</p>`; return; }
  const done = Math.min(1, cups.minutes / Math.max(first.minutes, 1));
  $("#focusTarget").innerHTML = `
    <div class="readout"><div class="words" style="font-size:30px">${Math.round(first.minutes)} minutes</div>
      <div class="rangeline">${first.cards} facts, mostly <b>${first.concepts.slice(0, 2).join(" and ")}</b>.</div>
      <div class="scale"><div class="track"><div class="band" style="left:0;width:${(done * 100).toFixed(1)}%"></div></div>
        <div class="ticks"><span>${Math.round(cups.minutes)} min done today</span><span>${Math.round(first.minutes)} min asked for</span></div></div></div>`;
}
function timerSet(minutes) {
  timer.minutes = minutes; timer.left = minutes * 60; timer.running = false;
  clearInterval(timer.tick); timer.tick = null;
  store.set("preset", minutes);
  $$("#presets button").forEach((b) => b.setAttribute("aria-pressed", String(+b.dataset.min === minutes)));
  renderDial();
}
function timerToggle() {
  if (timer.running) {
    timer.running = false; clearInterval(timer.tick); timer.tick = null; renderDial(); return;
  }
  timer.running = true;
  timer.endsAt = Date.now() + timer.left * 1000;          // wall clock, so a throttled tab stays honest
  timer.tick = setInterval(() => {
    timer.left = (timer.endsAt - Date.now()) / 1000;
    if (timer.left <= 0) {
      timer.left = 0; timer.running = false;
      clearInterval(timer.tick); timer.tick = null;
      const cups = store.get(todayKey(), { count: 0, minutes: 0 });
      cups.count += 1; cups.minutes += timer.minutes;
      store.set(todayKey(), cups);
      renderCups(); renderFocusTarget();
      $("#timerState").textContent = "cup finished";
    }
    renderDial();
  }, 250);
  renderDial();
}

/* ============================ syllabus intake ============================ */
function applyDensity() {
  for (const c of state.courses) if (c.topics) c.n = c.topics * density();
  renderCourses();
}
async function readSyllabus({ seedRatings = false } = {}) {
  const textv = $("#syllabusText").value.trim();
  const note = $("#ingestNote");
  if (!textv) { note.className = "ingest-note bad"; note.textContent = "Paste something first."; return; }
  const btn = $("#readSyllabus"); btn.disabled = true; btn.textContent = "Reading…";
  note.className = "ingest-note"; note.textContent = "";
  try {
    const out = await api("/api/ingest", { text: textv });
    state.courses = out.subjects.map((s) => ({
      name: s.name, rating: seedRatings ? (SAMPLE_RATINGS[s.name] || 3) : 3,
      topics: s.n_items, n: s.n_items * density(), items: s.items,
    }));
    renderCourses();
    const total = out.n_items * density();
    const who = out.source === "gemini" ? "Gemini read it" : "Read by the built-in parser";
    note.innerHTML = `${who}: <strong>${out.n_subjects} subjects</strong>, <strong>${out.n_items.toLocaleString()} topics</strong> — ` +
      `<strong>${total.toLocaleString()} facts</strong> at ${density()} per line. It only split the text up. ` +
      `Every number after this is computed by the memory model.`;
  } catch {
    note.className = "ingest-note bad";
    note.textContent = "Couldn't find any subjects in that. Try pasting the syllabus with its headings.";
  } finally { btn.disabled = false; btn.textContent = "Read my syllabus →"; }
}

/* ================================== boot ================================== */
// the pointer position feeds the hero card's highlight
{
  let queued = false, px = 0, py = 0;
  const glint = document.querySelector(".card.glint");
  if (glint) glint.addEventListener("pointermove", (e) => {
    const r = glint.getBoundingClientRect();
    px = ((e.clientX - r.left) / r.width) * 100; py = ((e.clientY - r.top) / r.height) * 100;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { glint.style.setProperty("--mx", px + "%"); glint.style.setProperty("--my", py + "%"); queued = false; });
  });
}
$("#bannerClose").addEventListener("click", clearFail);
addEventListener("error", (e) => fail("Something in the interface broke.", e.error || e.message));
addEventListener("unhandledrejection", (e) => fail("Something in the interface broke.", e.reason));
// delegation, so a nav button added later still works and a click on the icon
// inside it still counts
$("#rail").addEventListener("click", (e) => {
  const b = e.target.closest(".navbtn[data-screen]");
  if (!b) return;
  showScreen(b.dataset.screen);
  if (narrow()) setRail(true, false);
});
$("#railToggle").addEventListener("click", () => setRail(!$("#rail").classList.contains("collapsed")));
$("#railOpen").addEventListener("click", () => setRail(false, false));
$("#run").addEventListener("click", () => run({ navigate: true }));
$("#runFrontier").addEventListener("click", runFrontier);
$("#readSyllabus").addEventListener("click", () => readSyllabus());
$("#sampleSyllabus").addEventListener("click", () => { $("#syllabusText").value = SAMPLE_SYLLABUS; readSyllabus({ seedRatings: true }); });
$("#density").addEventListener("change", applyDensity);
$("#addcourse").addEventListener("click", () => {
  const name = prompt("Subject name?");
  if (name) { state.courses.push({ name, rating: 3, n: CARDS_PER_COURSE }); renderCourses(); }
});
$("#exactToggle").addEventListener("click", () => {
  state.exact = !state.exact;
  store.set("exact", state.exact);
  $("#exactToggle").setAttribute("aria-pressed", String(state.exact));
  $("#exactToggle").textContent = state.exact ? "showing exact" : "exact figures";
  renderAll();
  $$(".screen.active .plot").forEach(repaint);
});
$$("#presets button").forEach((b) => b.addEventListener("click", () => timerSet(+b.dataset.min)));
$("#timerStart").addEventListener("click", timerToggle);
$("#timerReset").addEventListener("click", () => timerSet(timer.minutes));
$("#brewFromPlan").addEventListener("click", () => {
  const first = state.plan && state.plan.sessions[0];
  if (first) timerSet(Math.max(15, Math.min(60, Math.round(first.minutes / 5) * 5)));
  showScreen("focus");
});
addEventListener("keydown", (e) => {
  if (e.target.matches("input, textarea, select")) return;
  if (e.key === "[") { setRail(!$("#rail").classList.contains("collapsed")); }
  if (e.key === " " && document.querySelector("#screen-focus.active")) { e.preventDefault(); timerToggle(); }
});
addEventListener("hashchange", () => showScreen(wanted()));
addEventListener("resize", () => $$(".screen.active .plot").forEach(repaint));

(function init() {
  const d = new Date(); d.setDate(d.getDate() + 87);
  $("#examdate").value = d.toISOString().slice(0, 10);
  setRail(narrow() ? true : store.get("rail", false), false);
  $("#exactToggle").setAttribute("aria-pressed", String(state.exact));
  $("#exactToggle").textContent = state.exact ? "showing exact" : "exact figures";
  renderCourses();
  renderFindings();
  renderExplainCurve();
  timerSet(timer.minutes);
  renderCups();
  renderFocusTarget();
  api("/api/calibration").then(renderCalibration).catch(() => { $("#calChart").textContent = "Calibration artifact not found — run scripts/calibration.py."; });
  api("/api/proof").then(renderProof).catch(() => { $("#proofTable").textContent = "Benchmark artifact not found — run scripts/benchmark.py."; });
  showScreen(wanted());
  run();      // land on a populated page; nobody should press a button to see whether it works
})();
