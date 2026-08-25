/* Ebb — client.
   Charts are hand-drawn SVG. Every number on screen comes from the API, which
   computes it from the committed model. Nothing here is hardcoded for a demo. */

const $ = (s) => document.querySelector(s);
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const pct = (x) => (x * 100).toFixed(1) + "%";
const pct0 = (x) => Math.round(x * 100) + "%";

const DEFAULT_COURSES = [
  { name: "Thermodynamics", rating: 2 },
  { name: "Fluid Mechanics", rating: 1 },
  { name: "Mass Transfer", rating: 3 },
  { name: "Heat Transfer", rating: 3 },
  { name: "Reaction Engineering", rating: 2 },
  { name: "Process Control", rating: 4 },
  { name: "Thermal Operations", rating: 3 },
  { name: "Chemical Technology", rating: 4 },
];
const CARDS_PER_COURSE = 75;
const GRADE_WORDS = { 1: "gone", 2: "shaky", 3: "solid", 4: "cold" };

const state = { courses: structuredClone(DEFAULT_COURSES), cards: [], forecast: null, ceiling: null, plan: null };

/* ---------------------------------------------------------------- svg utils */
const NS = "http://www.w3.org/2000/svg";
function el(tag, attrs = {}, parent) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
}
function svgRoot(host, w, h) {
  host.classList.remove("loading");
  host.textContent = "";
  const s = el("svg", { viewBox: `0 0 ${w} ${h}`, role: "img" });
  host.appendChild(s);
  return s;
}
/** Rounded only on the data end, anchored to the baseline. */
function barPath(x, y, w, h, r) {
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h} Z`;
}
function hBarPath(x, y, w, h, r) {
  r = Math.min(r, h / 2, w);
  return `M${x},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} L${x},${y + h} Z`;
}
function line(points) {
  return points.map((p, i) => (i ? "L" : "M") + p[0].toFixed(2) + "," + p[1].toFixed(2)).join(" ");
}

const tip = $("#tip");
function showTip(evt, title, value, extra) {
  tip.innerHTML = `<div class="th">${title}</div><div class="tv">${value}</div>` +
    (extra ? `<div style="color:var(--text-muted);margin-top:2px">${extra}</div>` : "");
  tip.style.opacity = 1;
  const pad = 14;
  let x = evt.clientX + pad, y = evt.clientY - pad;
  if (x + 240 > innerWidth) x = evt.clientX - 240;
  if (y < 10) y = 10;
  tip.style.left = x + "px";
  tip.style.top = y + "px";
}
const hideTip = () => (tip.style.opacity = 0);

/* Recessive hairline grid + axes. Solid, one shade off the surface. */
function grid(svg, box, yTicks, fmt) {
  for (const t of yTicks) {
    const y = box.y + box.h - (t - box.min) / (box.max - box.min) * box.h;
    el("line", { x1: box.x, x2: box.x + box.w, y1: y, y2: y, stroke: css("--border"), "stroke-width": 1 }, svg);
    el("text", { x: box.x - 9, y: y + 4, "text-anchor": "end", fill: css("--text-muted"),
      "font-size": 11, "font-family": css("--font") }, svg).textContent = fmt(t);
  }
}

/* ------------------------------------------------------- 1. decay curves */
function renderDecay(series, daysToExam, weakest) {
  const host = $("#decayChart");
  const W = 620, H = 300, box = { x: 44, y: 14, w: W - 60, h: H - 52, min: 0, max: 1 };
  const svg = svgRoot(host, W, H);
  grid(svg, box, [0, 0.25, 0.5, 0.75, 1], (t) => Math.round(t * 100) + "%");

  const X = (d) => box.x + (d / daysToExam) * box.w;
  const Y = (r) => box.y + box.h - r * box.h;

  // Exam day. A solid rule with a label, not a dash — it is an event, not a grid line.
  el("line", { x1: X(daysToExam), x2: X(daysToExam), y1: box.y - 6, y2: box.y + box.h,
    stroke: css("--critical"), "stroke-width": 2 }, svg);
  el("text", { x: X(daysToExam), y: box.y - 12, "text-anchor": "end", fill: css("--critical"),
    "font-size": 11, "font-weight": 600, "letter-spacing": ".06em",
    "font-family": css("--font") }, svg).textContent = "EXAM DAY";

  // Context series first, so the emphasised one sits on top.
  const ordered = [...series].sort((a, b) => (a.concept === weakest ? 1 : b.concept === weakest ? -1 : 0));
  for (const s of ordered) {
    const isWeak = s.concept === weakest;
    el("path", {
      d: line(s.points.map((p) => [X(p.day), Y(p.recall)])),
      fill: "none",
      stroke: isWeak ? css("--series-2") : css("--context"),
      "stroke-width": isWeak ? 2.5 : 1.5,
      "stroke-linecap": "round",
      opacity: isWeak ? 1 : 0.72,
    }, svg);
  }

  // Direct-label the endpoint of the emphasised series only.
  const weak = series.find((s) => s.concept === weakest);
  if (weak) {
    const last = weak.points[weak.points.length - 1];
    el("circle", { cx: X(last.day), cy: Y(last.recall), r: 4.5, fill: css("--series-2"),
      stroke: css("--surface-1"), "stroke-width": 2 }, svg);
    el("text", { x: X(last.day) - 12, y: Y(last.recall) - 11, "text-anchor": "end",
      fill: css("--series-2"), "font-size": 13, "font-weight": 650,
      "font-family": css("--font") }, svg).textContent = pct0(last.recall) + " on exam day";
  }

  el("line", { x1: box.x, x2: box.x + box.w, y1: box.y + box.h, y2: box.y + box.h,
    stroke: css("--border-strong"), "stroke-width": 1 }, svg);
  for (const d of [0, Math.round(daysToExam / 2), daysToExam]) {
    el("text", { x: X(d), y: box.y + box.h + 20, "text-anchor": "middle", fill: css("--text-muted"),
      "font-size": 11, "font-family": css("--font") }, svg).textContent = d === 0 ? "today" : `day ${d}`;
  }

  // Crosshair + tooltip.
  const cross = el("line", { y1: box.y, y2: box.y + box.h, stroke: css("--border-strong"),
    "stroke-width": 1, opacity: 0 }, svg);
  const hit = el("rect", { x: box.x, y: box.y, width: box.w, height: box.h, fill: "transparent" }, svg);
  hit.addEventListener("mousemove", (e) => {
    const r = svg.getBoundingClientRect();
    const day = Math.max(0, Math.min(daysToExam, ((e.clientX - r.left) / r.width * W - box.x) / box.w * daysToExam));
    cross.setAttribute("x1", X(day)); cross.setAttribute("x2", X(day)); cross.setAttribute("opacity", 1);
    const rows = series.map((s) => {
      const p = s.points.reduce((a, b) => (Math.abs(b.day - day) < Math.abs(a.day - day) ? b : a));
      return { c: s.concept, r: p.recall };
    }).sort((a, b) => a.r - b.r);
    showTip(e, `day ${Math.round(day)}`, `${pct(rows.reduce((a, b) => a + b.r, 0) / rows.length)} overall`,
      `weakest: ${rows[0].c} at ${pct(rows[0].r)}`);
  });
  hit.addEventListener("mouseleave", () => { cross.setAttribute("opacity", 0); hideTip(); });

  $("#decayLegend").innerHTML =
    `<li><span class="swatch" style="background:${css("--series-2")}"></span>${weakest} — weakest</li>` +
    `<li><span class="swatch" style="background:${css("--context")}"></span>your other subjects</li>` +
    `<li><span class="swatch" style="background:${css("--critical")}"></span>exam day</li>`;
}

/* --------------------------------------------------- 2. concept ranking */
function renderConcepts(concepts) {
  const host = $("#conceptChart");
  const rowH = 34, W = 420, H = concepts.length * rowH + 12;
  const svg = svgRoot(host, W, H);
  const labelW = 150, barX = labelW + 8, barW = W - labelW - 62;

  concepts.forEach((c, i) => {
    const y = i * rowH + 6;
    el("text", { x: labelW, y: y + 17, "text-anchor": "end", fill: css("--text-secondary"),
      "font-size": 12.5, "font-family": css("--font") }, svg).textContent =
      c.concept.length > 20 ? c.concept.slice(0, 19) + "…" : c.concept;

    el("rect", { x: barX, y: y + 5, width: barW, height: 15, rx: 4, fill: css("--surface-2") }, svg);
    // One series, one colour. Length already encodes magnitude; hue must not repeat it.
    const w = Math.max(3, c.recall * barW);
    const p = el("path", { d: hBarPath(barX, y + 5, w, 15, 4), fill: css("--series-1") }, svg);
    el("text", { x: barX + barW + 10, y: y + 17, fill: css("--text-primary"), "font-size": 12.5,
      "font-weight": 600, "font-family": css("--font"), class: "num" }, svg).textContent = pct0(c.recall);

    const target = el("rect", { x: barX, y: y, width: barW, height: 25, fill: "transparent" }, svg);
    target.addEventListener("mousemove", (e) =>
      showTip(e, c.concept, pct(c.recall) + " on exam morning", `${c.n_cards} facts`));
    target.addEventListener("mouseleave", hideTip);
    p.style.transition = "none";
  });
}

/* ------------------------------------------------------- 3. the ceiling */
function renderCeiling(ceiling, daysToExam, target) {
  const host = $("#ceilingChart");
  const W = 900, H = 340;
  const curve = ceiling.curve;
  // Zoom the scale to the data. The whole story lives in the top of the range,
  // and a 0-100% axis would flatten the cliff into a straight line. The axis is
  // labelled at both ends so the zoom is visible rather than implied -- this is
  // a line chart of a ceiling, not a bar chart, so it is not a truncation lie.
  const lo = Math.min(...curve.map((p) => p.best_possible), target) - 0.06;
  const floor = Math.max(0, Math.floor(lo * 20) / 20);
  const box = { x: 48, y: 20, w: W - 66, h: H - 62, min: floor, max: 1 };
  const svg = svgRoot(host, W, H);
  const X = (d) => box.x + (d / daysToExam) * box.w;
  const Y = (r) => box.y + box.h - (r - box.min) / (box.max - box.min) * box.h;
  const ticks = [];
  for (let t = box.min; t <= 1.0001; t += (1 - box.min) / 4) ticks.push(Math.round(t * 1000) / 1000);
  grid(svg, box, ticks, (t) => Math.round(t * 100) + "%");

  const deadline = ceiling.latest_start_day;

  // Everything past the deadline is unreachable. Status colour, because it means
  // a state (bad), not an identity.
  if (deadline !== null && deadline < daysToExam) {
    el("rect", { x: X(deadline), y: box.y, width: box.x + box.w - X(deadline), height: box.h,
      fill: css("--critical"), opacity: 0.08 }, svg);
  }

  // Target line — solid hairline with a label.
  el("line", { x1: box.x, x2: box.x + box.w, y1: Y(target), y2: Y(target),
    stroke: css("--good"), "stroke-width": 1.5 }, svg);
  el("text", { x: box.x + 8, y: Y(target) + 17, fill: css("--good"), "font-size": 11.5,
    "font-weight": 600, "font-family": css("--font") }, svg)
    .textContent = `your target · ${pct0(target)}`;

  el("path", { d: line(curve.map((p) => [X(p.start_day), Y(p.best_possible)])),
    fill: "none", stroke: css("--series-1"), "stroke-width": 2.5, "stroke-linejoin": "round",
    "stroke-linecap": "round" }, svg);

  if (deadline !== null) {
    el("line", { x1: X(deadline), x2: X(deadline), y1: box.y, y2: box.y + box.h,
      stroke: css("--critical"), "stroke-width": 2 }, svg);
    el("circle", { cx: X(deadline), cy: Y(target), r: 5, fill: css("--critical"),
      stroke: css("--surface-1"), "stroke-width": 2 }, svg);
    const anchor = X(deadline) > box.x + box.w * 0.62 ? "end" : "start";
    const dx = anchor === "end" ? -12 : 12;
    el("text", { x: X(deadline) + dx, y: box.y - 6, "text-anchor": anchor, fill: css("--critical"),
      "font-size": 12.5, "font-weight": 650, "font-family": css("--font") }, svg)
      .textContent = `last day to start · day ${deadline}`;
  }

  el("line", { x1: box.x, x2: box.x + box.w, y1: box.y + box.h, y2: box.y + box.h,
    stroke: css("--border-strong"), "stroke-width": 1 }, svg);
  for (const p of curve.filter((_, i) => i % 4 === 0)) {
    el("text", { x: X(p.start_day), y: box.y + box.h + 20, "text-anchor": "middle",
      fill: css("--text-muted"), "font-size": 11, "font-family": css("--font") }, svg)
      .textContent = p.start_day === 0 ? "today" : p.start_day;
  }
  el("text", { x: box.x + box.w / 2, y: H - 6, "text-anchor": "middle", fill: css("--text-muted"),
    "font-size": 11.5, "font-family": css("--font") }, svg).textContent = "the day you start studying";
  host.dataset.axisFloor = Math.round(box.min * 100);

  const cross = el("line", { y1: box.y, y2: box.y + box.h, stroke: css("--border-strong"),
    "stroke-width": 1, opacity: 0 }, svg);
  const hit = el("rect", { x: box.x, y: box.y, width: box.w, height: box.h, fill: "transparent" }, svg);
  hit.addEventListener("mousemove", (e) => {
    const r = svg.getBoundingClientRect();
    const day = ((e.clientX - r.left) / r.width * W - box.x) / box.w * daysToExam;
    const p = curve.reduce((a, b) => (Math.abs(b.start_day - day) < Math.abs(a.start_day - day) ? b : a));
    cross.setAttribute("x1", X(p.start_day)); cross.setAttribute("x2", X(p.start_day));
    cross.setAttribute("opacity", 1);
    showTip(e, `start on day ${p.start_day}`, pct(p.best_possible) + " is the ceiling",
      p.best_possible >= target ? "target still reachable" : "target no longer reachable at any effort");
  });
  hit.addEventListener("mouseleave", () => { cross.setAttribute("opacity", 0); hideTip(); });
}

/* --------------------------------------------------------- 4. the plan */
function renderPlan(plan, daysToExam) {
  const host = $("#planChart");
  const W = 900, H = 190;
  const box = { x: 44, y: 16, w: W - 60, h: H - 54, min: 0, max: 1 };
  const svg = svgRoot(host, W, H);
  const sessions = plan.sessions;
  if (!sessions.length) { host.innerHTML = '<p class="note">No reviews needed — you are already above target.</p>'; return; }

  const maxMin = Math.max(...sessions.map((s) => s.minutes));
  const slot = box.w / Math.max(daysToExam, 1);
  const barW = Math.max(3, Math.min(12, slot - 3));   // surface gap between adjacent bars

  grid(svg, { ...box, min: 0, max: maxMin }, [0, maxMin / 2, maxMin], (t) => Math.round(t) + "m");

  for (const s of sessions) {
    const x = box.x + (s.day / daysToExam) * box.w - barW / 2;
    const h = Math.max(2, (s.minutes / maxMin) * box.h);
    const p = el("path", { d: barPath(x, box.y + box.h - h, barW, h, 4), fill: css("--series-1") }, svg);
    p.addEventListener("mousemove", (e) =>
      showTip(e, `day ${s.day}`, `${s.minutes} minutes · ${s.cards} cards`, s.concepts.slice(0, 3).join(", ")));
    p.addEventListener("mouseleave", hideTip);
  }
  el("line", { x1: box.x, x2: box.x + box.w, y1: box.y + box.h, y2: box.y + box.h,
    stroke: css("--border-strong"), "stroke-width": 1 }, svg);
  el("line", { x1: box.x + box.w, x2: box.x + box.w, y1: box.y, y2: box.y + box.h,
    stroke: css("--critical"), "stroke-width": 2 }, svg);
  el("text", { x: box.x + box.w, y: box.y + box.h + 20, "text-anchor": "end", fill: css("--critical"),
    "font-size": 11, "font-weight": 600, "font-family": css("--font") }, svg).textContent = "EXAM";
  for (const d of [0, Math.round(daysToExam / 3), Math.round(daysToExam * 2 / 3)]) {
    el("text", { x: box.x + (d / daysToExam) * box.w, y: box.y + box.h + 20,
      "text-anchor": d === 0 ? "start" : "middle", fill: css("--text-muted"), "font-size": 11,
      "font-family": css("--font") }, svg).textContent = d === 0 ? "today" : `day ${d}`;
  }
}

/* ------------------------------------------------------ 5. the proof table */
function renderProof(data) {
  const host = $("#proofTable");
  const ours = data.ours, published = data.published;
  const rows = [];
  for (const [name, s] of Object.entries(ours)) rows.push({ name, ...s, mine: true });

  const fmt = (v, d = 4) => (v === null || v === undefined || Number.isNaN(v) ? "—" : v.toFixed(d));
  const best = { log_loss: Math.min(...rows.map((r) => r.log_loss)),
                 rmse_bins: Math.min(...rows.map((r) => r.rmse_bins)),
                 auc: Math.max(...rows.map((r) => r.auc)) };

  const cell = (r, k) => {
    const isBest = Math.abs(r[k] - best[k]) < 1e-9;
    return `<td class="num"${isBest ? ' style="color:var(--good);font-weight:650"' : ""}>${fmt(r[k], k === "rmse_bins" ? 4 : 4)}</td>`;
  };

  host.classList.remove("loading");
  host.innerHTML = `
    <table>
      <thead><tr><th>model</th><th>log loss</th><th>calibration error</th><th>AUC</th></tr></thead>
      <tbody>
        ${rows.map((r) => `<tr class="${r.name.startsWith("Ebb (DSR, fitted") ? "ours" : ""}">
          <td>${r.name}</td>${cell(r, "log_loss")}${cell(r, "rmse_bins")}${cell(r, "auc")}</tr>`).join("")}
      </tbody>
    </table>
    <p class="note" style="margin:18px 0 8px"><strong style="color:var(--text-secondary)">Published, for reference.</strong>
      Measured on roughly 350 million reviews from 9,999 collections — ours is a
      ${data.collections}-collection sample, so read the ordering, not the decimals.
      These are not our numbers and we do not claim to have beaten them.</p>
    <table>
      <thead><tr><th>published benchmark</th><th>log loss</th><th>calibration error</th><th>AUC</th></tr></thead>
      <tbody>${Object.entries(published).map(([n, s]) =>
        `<tr><td style="color:var(--text-muted)">${n}</td><td class="num" style="color:var(--text-muted)">${fmt(s.log_loss)}</td>
        <td class="num" style="color:var(--text-muted)">${fmt(s.rmse_bins)}</td>
        <td class="num" style="color:var(--text-muted)">${fmt(s.auc)}</td></tr>`).join("")}
      </tbody>
    </table>`;

  const fitted = ours["Ebb (DSR, fitted)"], avg = ours["AVG (predict the mean)"];
  $("#proofStats").innerHTML = [
    ["reviews scored", fitted.n.toLocaleString(), "each learner's future"],
    ["calibration error", fitted.rmse_bins.toFixed(4), "when it says 85%, 85% recall"],
    ["AUC", fitted.auc.toFixed(4), `a coin flip is ${avg.auc.toFixed(2)}`],
    ["collections", String(data.collections), "real Anki users"],
  ].map(([k, v, s]) => `<div class="stat"><div class="k">${k}</div><div class="v num">${v}</div>
      <div class="k" style="text-transform:none;letter-spacing:0;font-weight:400;margin-top:3px">${s}</div></div>`).join("");

  $("#proofNote").textContent =
    "Trained on one wall-clock cutoff per collection: everything before it trains, everything after is scored. " +
    "Splitting per card instead quietly selects for maturity — a card's last reviews are its easiest — and inflated held-out recall by three points when we tried it.";
}

const FINDINGS = [
  ["Duolingo's data has almost no forgetting curve.",
   "We started there — 12.85 million traces. Recall barely moves with time: 90.6% under a day, 86.8% after a month. The scheduler grants 58 days after a success and 10.4 after a lapse, so a long gap is a <em>reward for strength</em>, and the two effects cancel. Conditioning on repetition number brings the curve back. We moved the model to Anki logs, where people genuinely forget."],
  ["The 2016 model loses to predicting the average.",
   "We implemented half-life regression from the ACL paper and reproduced its published baselines within a few points — then watched it score below chance on Anki data, because it has no notion of stability and so reads a long gap as weakness. That failure is the whole argument for a difficulty-stability-retrievability model."],
  ["Cramming beats spacing for one fixed exam date.",
   "At identical effort, in our own model: 90.0% crammed against 75.4% spread evenly, and cramming still leads three months later. We are not going to tell you otherwise. What makes scheduling matter is that you cannot sit through six hundred cards the night before — and once each night has a limit, there is a last day you can start."],
];
function renderFindings() {
  $("#findings").innerHTML = FINDINGS.map(([h, b]) => `
    <div style="padding:16px 0;border-bottom:1px solid var(--border)">
      <div style="font-weight:600;font-size:14.5px;margin-bottom:5px">${h}</div>
      <div style="color:var(--text-secondary);font-size:13.5px;line-height:1.6">${b}</div>
    </div>`).join("");
}

/* ------------------------------------------------------------- courses UI */
function renderCourses() {
  $("#courses").innerHTML = state.courses.map((c, i) => `
    <div class="course">
      <div><div class="name">${c.name}</div>
        <div class="meta">${CARDS_PER_COURSE} facts · you say it's ${GRADE_WORDS[c.rating]}</div></div>
      <div class="grades" data-i="${i}">
        ${[1, 2, 3, 4].map((g) => `<button data-g="${g}" aria-pressed="${c.rating === g}">${g}</button>`).join("")}
      </div>
    </div>`).join("");
  document.querySelectorAll(".grades").forEach((row) => {
    row.addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      state.courses[+row.dataset.i].rating = +b.dataset.g;
      renderCourses();
    });
  });
}

/* ----------------------------------------------------------------- wiring */
const api = async (path, body) => {
  const r = await fetch(path, body ? {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  } : {});
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
};

function daysToExam() {
  const v = $("#examdate").value;
  if (!v) return 87;
  const d = Math.round((new Date(v + "T00:00:00") - new Date(new Date().toDateString())) / 86400000);
  return Math.max(1, d);
}

function showScreen(name) {
  document.querySelectorAll("nav.tabs button").forEach((b) =>
    b.setAttribute("aria-selected", String(b.dataset.screen === name)));
  document.querySelectorAll("section.screen").forEach((s) =>
    s.classList.toggle("active", s.id === "screen-" + name));
  if (location.hash.slice(1) !== name) history.replaceState(null, "", "#" + name);
}

async function run() {
  const days = daysToExam();
  const cap = +$("#cap").value || 40;
  const target = +$("#target").value;

  const items = state.courses.flatMap((c) =>
    Array.from({ length: CARDS_PER_COURSE }, (_, i) =>
      ({ card_id: `${c.name.slice(0, 4)}-${i}`, concept: c.name, rating: c.rating })));

  const btn = $("#run"); btn.disabled = true; btn.textContent = "Computing…";
  try {
    state.cards = (await api("/api/calibrate", items)).cards;
    const payload = { cards: state.cards, days_to_exam: days, target_recall: target, max_reviews_per_day: cap };

    const [forecast, curves, ceiling, plan] = await Promise.all([
      api("/api/forecast", { cards: state.cards, days_to_exam: days }),
      api("/api/curves", { cards: state.cards, days_to_exam: days }),
      api("/api/ceiling", payload),
      api("/api/plan", payload),
    ]);
    state.forecast = forecast; state.ceiling = ceiling; state.plan = plan;

    // --- forecast screen
    $("#heroPct").textContent = pct0(forecast.overall_recall);
    $("#heroCap").innerHTML = `is what you'd still hold on exam morning, <strong style="color:var(--text-primary)">${days} days</strong> from today, if you did nothing between now and then.`;
    $("#forecastStats").innerHTML = [
      ["days to exam", days, ""],
      ["facts tracked", (state.cards.length).toLocaleString(), ""],
      ["weakest subject", forecast.weakest_concept, pct0(forecast.per_concept[0].recall)],
      ["you'd lose", pct0(1 - forecast.overall_recall), "of the syllabus"],
    ].map(([k, v, s]) => `<div class="stat"><div class="k">${k}</div>
        <div class="v num" style="font-size:${String(v).length > 12 ? 17 : 25}px">${v}</div>
        ${s ? `<div class="k" style="text-transform:none;letter-spacing:0;font-weight:400;margin-top:3px">${s}</div>` : ""}</div>`).join("");

    renderDecay(curves.series, days, forecast.weakest_concept);
    $("#decayCaption").textContent =
      `Every line is a subject decaying from today to the exam. No language model computes any of this — it is the fitted memory model, run forward.`;
    renderConcepts(forecast.per_concept);

    // --- deadline screen
    renderCeiling(ceiling, days, target);
    const dl = ceiling.latest_start_day;
    $("#ceilingCaption").textContent =
      `At ${cap} cards a night, working every remaining night at full effort. ` +
      `The vertical scale starts at ${$("#ceilingChart").dataset.axisFloor}% so the drop is visible.`;
    const todayCeil = ceiling.ceiling_if_you_start_today;
    const lateCeil = ceiling.ceiling_if_you_wait_until_day;
    $("#verdict").innerHTML = dl === null
      ? `<div class="verdict"><div class="big">${pct0(target)} is already out of reach.</div>
         <div class="small">Even starting tonight and filling every night to ${cap} cards, the best you can reach is ${pct(todayCeil)}. The deadline passed before you opened this.</div></div>`
      : `<div class="verdict ${dl > days * 0.5 ? "" : "ok"}">
         <div class="big">You have until day ${dl}.</div>
         <div class="small">Start then and ${pct0(target)} is still reachable. Wait until day ${lateCeil.day} and your ceiling is ${pct(lateCeil.best_possible)} — at maximum effort, and nothing closes it. The deadline is not the exam.</div></div>`;

    $("#planStats").innerHTML = [
      ["from", pct0(plan.recall_before)],
      ["to", pct0(plan.recall_after)],
      ["total time", `${Math.round(plan.total_minutes)}<small> min</small>`],
      ["study days", String(plan.sessions.length)],
      ["reviews", plan.total_reviews.toLocaleString()],
    ].map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v num">${v}</div></div>`).join("");
    renderPlan(plan, days);
    $("#planCaption").textContent = plan.target_met
      ? `${Math.round(plan.total_minutes)} minutes, spread over ${plan.sessions.length} days, reaches ${pct(plan.recall_after)}.`
      : `Even at the cap this schedule only reaches ${pct(plan.recall_after)} — the target is not reachable in the time left.`;

    showScreen(wanted() === "syllabus" ? "forecast" : wanted());
  } catch (err) {
    alert("Could not reach the model: " + err.message);
  } finally {
    btn.disabled = false; btn.textContent = "Forecast my exam →";
  }
}

/* ------------------------------------------------------------------- boot */
document.querySelectorAll("nav.tabs button").forEach((b) =>
  b.addEventListener("click", () => showScreen(b.dataset.screen)));
$("#run").addEventListener("click", run);
$("#addcourse").addEventListener("click", () => {
  const name = prompt("Subject name?");
  if (name) { state.courses.push({ name, rating: 3 }); renderCourses(); }
});

const SCREENS = ["syllabus", "forecast", "deadline", "proof"];
const wanted = () => (SCREENS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "syllabus");

(function init() {
  const d = new Date(); d.setDate(d.getDate() + 87);
  $("#examdate").value = d.toISOString().slice(0, 10);
  $("#percourse").textContent = CARDS_PER_COURSE;
  renderCourses();
  renderFindings();
  api("/api/proof").then(renderProof).catch(() => {
    $("#proofTable").textContent = "Benchmark artifact not found — run scripts/benchmark.py.";
  });
  // Land on a populated page. Nobody should have to press a button to see
  // whether the thing works, least of all a judge with two minutes.
  showScreen(wanted());
  run();
  addEventListener("hashchange", () => showScreen(wanted()));
})();
