// Unified colour picker (Illustrator-style) — extracted from app.js (#28).
// One modal for fill, stroke, artboard background and the toolstrip swatches.
// SV field + hue slider + alpha slider, with hex / RGB / HSB / A inputs and a
// new-vs-previous preview. Live-applies through onChange; OK commits, Cancel
// (or backdrop / Esc) reverts to the colour it opened with.
//   opts: { color, alpha=1, allowNone=false, title, onChange(hex|null, alpha), onCommit(hex|null, alpha) }
import * as hv from "../hv/index.js";

// Shell helpers this module can't own — injected once at boot via configureColorPicker.
let floatingInput, showContextMenu;
export function configureColorPicker(deps) {
  ({ floatingInput, showContextMenu } = deps);
}

const CP_BASE_SWATCHES = ["#000000", "#ffffff", "#808080", "#e23b3b", "#f6a623", "#f8e71c", "#38b24a", "#2f7fe0", "#7d4fd0", "#e0529c"];
const CP_PIPETTE_SVG = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M10.5 1.8a1.7 1.7 0 0 1 2.4 2.4l-1.2 1.2 1 1-1.1 1.1-1-1-5 5L3 13l-1.8.6.6-1.8.5-1.6 5-5-1-1L7.4 4.2l1 1 1.1-1.1z" fill="currentColor"/></svg>`;
const CP_SWATCH_KEY = "hector-vector:swatches";
const CP_RECENT_KEY = "hector-vector:swatches-recent";
// Saved swatches can carry a name and a folder (group) now; legacy entries are plain hex
// strings, so loadSwatches normalises all of them to { c, name?, group? }. saveSwatches
// keeps the raw array — a folder is just a `group` string shared by its members, there is
// no separate folder registry.
function loadSwatches() { try { const a = JSON.parse(localStorage.getItem(CP_SWATCH_KEY)); return Array.isArray(a) ? a.map((x) => (typeof x === "string" ? { c: x } : x)).filter((x) => x && typeof x.c === "string") : []; } catch (_) { return []; } }
function saveSwatches(arr) { try { localStorage.setItem(CP_SWATCH_KEY, JSON.stringify(arr.slice(0, 24))); } catch (_) {} }
function loadRecent() { try { const a = JSON.parse(localStorage.getItem(CP_RECENT_KEY)); return Array.isArray(a) ? a.filter((c) => typeof c === "string") : []; } catch (_) { return []; } }
function pushRecent(hex) { try { const u = loadRecent().filter((x) => x.toLowerCase() !== hex.toLowerCase()); u.unshift(hex); localStorage.setItem(CP_RECENT_KEY, JSON.stringify(u.slice(0, 12))); } catch (_) {} }
// Live binding: app.js reads this to suppress global X/D/'/' shortcuts while a
// floating picker is open. Only ever written inside this module.
export let activeColorPicker = null;
export function openColorPicker(opts) {
  if (activeColorPicker) activeColorPicker.cancel();
  const clamp01 = (n) => Math.max(0, Math.min(1, n));
  const startHex = hv.toHexColor(opts.color) || (opts.allowNone && (!opts.color || opts.color === "none") ? null : "#000000");
  const startAlpha = opts.alpha == null ? 1 : clamp01(opts.alpha);
  // working state in HSV (+ a) so dragging the field doesn't drift the hue at S/V=0
  const seed = hv.hexToRgb(startHex || "#000000") || { r: 0, g: 0, b: 0 };
  // Duo (Illustrator primary/secondary): when opened from the toolstrip swatches the
  // picker edits BOTH fill + stroke — the side shows the two targets, click or press X
  // to switch which one the field edits, Shift+X swaps them. Single-target callers
  // (artboard bg, etc.) omit `duo` and get a solo live preview.
  const duo = opts.duo || null;
  const mkState = (color, alpha) => {
    const hex0 = hv.toHexColor(color) || (color === "none" || color == null ? null : "#000000");
    const s = hv.hexToRgb(hex0 || "#000000") || { r: 0, g: 0, b: 0 };
    return Object.assign({ a: alpha == null ? 1 : clamp01(alpha), none: hex0 === null }, hv.rgbToHsv(s.r, s.g, s.b));
  };
  const targets = duo ? { fill: mkState(duo.fill.color, duo.fill.alpha), stroke: mkState(duo.stroke.color, duo.stroke.alpha) } : null;
  const orig = duo ? { fill: { color: duo.fill.color, alpha: duo.fill.alpha }, stroke: { color: duo.stroke.color, alpha: duo.stroke.alpha } } : null;
  let active = duo ? (duo.active === "stroke" ? "stroke" : "fill") : null;
  const st = duo ? Object.assign({}, targets[active]) : Object.assign({ a: startAlpha, none: startHex === null }, hv.rgbToHsv(seed.r, seed.g, seed.b));

  const back = document.createElement("div"); back.className = "cp-backdrop";
  const win = document.createElement("div"); win.className = "cp-window";
  back.appendChild(win);
  win.innerHTML = `
    <div class="cp-head"><span>${opts.title || "Colour"}</span></div>
    <div class="cp-body">
      <div class="cp-field" tabindex="-1"><div class="cp-field-sat"></div><div class="cp-field-val"></div><div class="cp-field-thumb"></div></div>
      <div class="cp-hue"><div class="cp-hue-thumb"></div></div>
      <div class="cp-side"></div>
    </div>
    <div class="cp-alpha"><div class="cp-alpha-track"></div><div class="cp-alpha-thumb"></div></div>
    <div class="cp-models">
      <div class="cp-tabs" role="tablist">
        <button type="button" class="cp-tab" data-m="rgb">RGB</button>
        <button type="button" class="cp-tab" data-m="hsl">HSL</button>
        <button type="button" class="cp-tab" data-m="hsb">HSB</button>
      </div>
      <div class="cp-fields">
        <label class="cp-inp cp-hex">#<input data-k="hex" maxlength="7" /></label>
        <div class="cp-triple"></div>
        <label class="cp-inp cp-alpha-num">A<input data-k="a" type="number" min="0" max="100" /></label>
      </div>
    </div>
    <div class="cp-globals" hidden></div>
    <div class="cp-swatches"></div>
    <div class="cp-actions">
      ${opts.allowNone ? `<button type="button" class="ghost-button cp-none">None</button>` : ""}
      <span class="cp-spacer"></span>
      ${opts.host ? "" : `<button type="button" class="ghost-button cp-cancel">Cancel</button><button type="button" class="ghost-button cp-ok">OK</button>`}
    </div>
    <div class="cp-recent cp-chin" hidden><div class="cp-recent-row"></div></div>`;
  // Embedded (host) mode = a live, persistent panel editor (no backdrop / OK / Cancel);
  // otherwise the classic transactional floating picker.
  const host = opts.host || null;
  if (host) { win.classList.add("cp-embedded"); host.innerHTML = ""; host.appendChild(win); }
  else document.body.appendChild(back);

  const $ = (s) => win.querySelector(s);
  const field = $(".cp-field"), fieldSat = $(".cp-field-sat"), fieldThumb = $(".cp-field-thumb");
  const hue = $(".cp-hue"), hueThumb = $(".cp-hue-thumb");
  const alphaEl = $(".cp-alpha"), alphaTrack = $(".cp-alpha-track"), alphaThumb = $(".cp-alpha-thumb");
  const side = $(".cp-side");
  const curHex = () => { const c = hv.hsvToRgb(st.h, st.s, st.v); return hv.rgbToHex(c.r, c.g, c.b); };
  const stHexOf = (t) => { const c = hv.hsvToRgb(t.h, t.s, t.v); return hv.rgbToHex(c.r, c.g, c.b); };
  const checker = "repeating-conic-gradient(#bbb 0% 25%, #fff 0% 50%) 50% / 12px 12px";

  // Colour-model tabs (RGB / HSL / HSB): the hex + alpha fields are persistent; the
  // middle triple is rebuilt per model. The working colour stays in HSV, so each model
  // just reads/writes that. The active model is remembered across pickers.
  const CP_MODEL_KEY = "hector-vector:cp-model";
  const MODELS = {
    rgb: { fields: [["r", "R", 255], ["g", "G", 255], ["b", "B", 255]],
      read: () => { const c = hv.hsvToRgb(st.h, st.s, st.v); return { r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b) }; },
      write: (v) => Object.assign(st, hv.rgbToHsv(v.r, v.g, v.b)) },
    hsl: { fields: [["h", "H", 360], ["s", "S", 100], ["l", "L", 100]],
      read: () => { const c = hv.hsvToRgb(st.h, st.s, st.v), x = hv.rgbToHsl(c.r, c.g, c.b); return { h: Math.round(x.h), s: Math.round(x.s), l: Math.round(x.l) }; },
      write: (v) => { const c = hv.hslToRgb(v.h, v.s, v.l); Object.assign(st, hv.rgbToHsv(c.r, c.g, c.b)); } },
    hsb: { fields: [["h", "H", 360], ["s", "S", 100], ["v", "B", 100]],
      read: () => ({ h: Math.round(st.h), s: Math.round(st.s), v: Math.round(st.v) }),
      write: (v) => { st.h = v.h; st.s = v.s; st.v = v.v; } },
  };
  let model = "rgb"; try { const m = localStorage.getItem(CP_MODEL_KEY); if (m && MODELS[m]) model = m; } catch {}
  const hexInput = $('.cp-fields input[data-k="hex"]'), aInput = $('.cp-fields input[data-k="a"]');
  const tripleBox = $(".cp-triple");
  let triple = {};   // current model's data-k → input element
  // Drag the field's letter label to scrub its value (an "invisible slider"); click the
  // input itself to type. Hex is never scrubbed.
  function bindScrubLabel(lab, input) {
    if (!lab || !input || input.dataset.k === "hex") return;
    lab.addEventListener("pointerdown", (e) => {
      if (e.target === input || e.button !== 0) return;
      e.preventDefault(); lab.setPointerCapture(e.pointerId);
      const sx = e.clientX, start = parseFloat(input.value) || 0; let moved = false;
      const mv = (ev) => { const dx = ev.clientX - sx; if (!moved && Math.abs(dx) < 3) return; moved = true;
        input.value = String(start + Math.round(dx / 4)); input.dispatchEvent(new Event("input", { bubbles: true })); };
      const up = () => { lab.removeEventListener("pointermove", mv); lab.removeEventListener("pointerup", up); };
      lab.addEventListener("pointermove", mv); lab.addEventListener("pointerup", up);
    });
  }
  function onTriple() {
    const m = MODELS[model], v = {};
    for (const [k, , max] of m.fields) v[k] = Math.max(0, Math.min(max, parseFloat(triple[k].value) || 0));
    m.write(v); changed();
  }
  function buildTriple() {
    tripleBox.innerHTML = ""; triple = {};
    for (const [k, lab, max] of MODELS[model].fields) {
      const l = document.createElement("label"); l.className = "cp-inp";
      const inp = document.createElement("input"); inp.type = "number"; inp.min = "0"; inp.max = String(max); inp.dataset.k = k;
      l.append(document.createTextNode(lab), inp); tripleBox.appendChild(l); triple[k] = inp;
      inp.addEventListener("input", onTriple); bindScrubLabel(l, inp);
    }
    win.querySelectorAll(".cp-tab").forEach((t) => t.classList.toggle("active", t.dataset.m === model));
  }
  function paintFields() {
    hexInput.value = curHex().slice(1);
    aInput.value = Math.round(st.a * 100);
    const vals = MODELS[model].read();
    for (const [k] of MODELS[model].fields) if (triple[k]) triple[k].value = vals[k];
  }
  function paint() {
    const hex = curHex();
    const hueHex = (() => { const c = hv.hsvToRgb(st.h, 100, 100); return hv.rgbToHex(c.r, c.g, c.b); })();
    fieldSat.parentElement.style.background = hueHex;
    fieldThumb.style.left = st.s + "%"; fieldThumb.style.top = (100 - st.v) + "%";
    fieldThumb.style.background = hex;
    hueThumb.style.top = (st.h / 360 * 100) + "%";
    alphaTrack.style.background = `linear-gradient(to right, transparent, ${hex}), ${checker}`;
    alphaThumb.style.left = (st.a * 100) + "%";
    paintFields();
    win.classList.toggle("cp-is-none", st.none);
  }
  // --- fill/stroke side (duo) or a solo live preview (single) ---
  const chipBg = (none, hex, a) => {
    if (none) return checker;
    const rgb = hv.hexToRgb(hex);
    return a < 1 ? `linear-gradient(rgba(${rgb.r},${rgb.g},${rgb.b},${a}),rgba(${rgb.r},${rgb.g},${rgb.b},${a})), ${checker}` : hex;
  };
  let sideEls = null;
  function buildSide() {
    side.innerHTML = ""; side.classList.toggle("duo", !!duo);
    if (duo) {
      const mk = (which, label) => {
        const b = document.createElement("button"); b.type = "button"; b.className = "cp-target"; b.dataset.which = which;
        b.title = `${label} — click or press X to edit${which === "fill" ? " · Shift+X swaps" : ""}`;
        const lab = document.createElement("span"); lab.className = "cp-target-lab"; lab.textContent = label; b.appendChild(lab);
        b.addEventListener("click", () => switchTo(which));
        return b;
      };
      const f = mk("fill", "Fill"), s = mk("stroke", "Stroke");
      side.append(f, s); sideEls = { fill: f, stroke: s };
    } else {
      const solo = document.createElement("div"); solo.className = "cp-target solo"; side.appendChild(solo); sideEls = { solo };
    }
  }
  function paintSide() {
    if (!sideEls) return;
    if (duo) {
      sideEls.fill.style.background = chipBg(targets.fill.none, stHexOf(targets.fill), targets.fill.a);
      sideEls.stroke.style.background = chipBg(targets.stroke.none, stHexOf(targets.stroke), targets.stroke.a);
      sideEls.fill.classList.toggle("active", active === "fill");
      sideEls.stroke.classList.toggle("active", active === "stroke");
    } else {
      sideEls.solo.style.background = chipBg(st.none, curHex(), st.a);
    }
  }
  function emit() {
    // Gradient mode (objects only): the field edits the ACTIVE stop; apply the whole spec.
    if (gradCap && duo && mode[active] !== "solid" && !st.none) {
      saveStop();
      targets[active] = { a: st.a, none: false, h: st.h, s: st.s, v: st.v };   // keep the side chip plausible
      duo.applyGradient(active, specOfGrad(grad[active]));
      paintSide(); renderStrip();
      if (typeof recordRecent === "function") recordRecent();
      return;
    }
    const hex = st.none ? null : curHex();
    if (duo) { targets[active] = { a: st.a, none: st.none, h: st.h, s: st.s, v: st.v }; duo.apply(active, hex, st.a); }
    else if (opts.onChange) opts.onChange(hex, st.a);
    paintSide();
    if (typeof recordRecent === "function") recordRecent();   // settle the colour into recents (debounced)
  }
  function changed() { st.none = false; paint(); emit(); }
  // Apply a target's current paint (solid or gradient) — used by swap so both stay in sync.
  function applyTarget(which) {
    if (gradCap && mode[which] !== "solid" && grad[which]) duo.applyGradient(which, specOfGrad(grad[which]));
    else duo.apply(which, targets[which].none ? null : stHexOf(targets[which]), targets[which].a);
  }
  // Switch which target the field edits — pure focus change, no colour applied (so it
  // never reads as an undo). Save the live edit back into the outgoing target first.
  function switchTo(which) {
    if (!duo || which === active) return;
    if (gradCap && mode[active] !== "solid") saveStop();
    targets[active] = { a: st.a, none: st.none, h: st.h, s: st.s, v: st.v };
    active = which;
    if (gradCap && mode[which] !== "solid" && grad[which]) loadStop(); else Object.assign(st, targets[which]);
    if (gradCap) syncGradUI();
    paint(); paintSide();
  }
  function swapTargets() {
    if (!duo) return;
    if (gradCap && mode[active] !== "solid") saveStop();
    targets[active] = { a: st.a, none: st.none, h: st.h, s: st.s, v: st.v };
    const tf = targets.fill; targets.fill = targets.stroke; targets.stroke = tf;
    if (gradCap) { const mf = mode.fill; mode.fill = mode.stroke; mode.stroke = mf; const gf = grad.fill; grad.fill = grad.stroke; grad.stroke = gf; }
    if (gradCap && mode[active] !== "solid" && grad[active]) loadStop(); else Object.assign(st, targets[active]);
    applyTarget("fill"); applyTarget("stroke");
    if (gradCap) syncGradUI();
    paint(); paintSide();
  }
  buildSide();

  // ---------- gradient editor (Epic G) — active only when the caller wired duo.applyGradient
  // (the object Colour panel). Per target: `mode` ∈ solid|linear|radial and `grad` holds the
  // stops in HSV+a so the existing SV/hue/alpha field edits the ACTIVE stop. Geometry (x1y1x2y2 /
  // cxcyr) is preserved across stop edits so the direction set by the on-canvas handles survives.
  const gradCap = !!(duo && duo.applyGradient);
  const toHsvA = (color, alpha) => { const c = hv.hexToRgb(color || "#000000") || { r: 0, g: 0, b: 0 }; return Object.assign({ a: alpha == null ? 1 : clamp01(alpha) }, hv.rgbToHsv(c.r, c.g, c.b)); };
  const mode = { fill: "solid", stroke: "solid" };
  const grad = { fill: null, stroke: null };
  const defGeom = (type) => (type === "radial" ? { cx: 0.5, cy: 0.5, r: 0.5 } : { x1: 0, y1: 0, x2: 1, y2: 0 });
  const geomOf = (spec) => (spec.type === "radial" ? { cx: spec.cx, cy: spec.cy, r: spec.r, fx: spec.fx, fy: spec.fy } : { x1: spec.x1, y1: spec.y1, x2: spec.x2, y2: spec.y2 });
  const gradFromPaint = (p) => ({ type: p.spec.type === "radial" ? "radial" : "linear", active: 0, geom: geomOf(p.spec), stops: p.spec.stops.map((s) => Object.assign({ offset: s.offset }, toHsvA(s.color, s.opacity))) });
  const specOfGrad = (g) => { const stops = g.stops.slice().sort((a, b) => a.offset - b.offset).map((s) => { const c = hv.hsvToRgb(s.h, s.s, s.v); return { offset: s.offset, color: hv.rgbToHex(c.r, c.g, c.b), opacity: s.a }; }); return Object.assign({ type: g.type, stops }, g.geom || defGeom(g.type)); };
  const ensureGrad = (which, type) => {
    if (grad[which]) { grad[which].type = type; if (!grad[which].geom) grad[which].geom = defGeom(type); }
    else grad[which] = { type, active: 0, geom: defGeom(type), stops: [Object.assign({ offset: 0 }, toHsvA(st.none ? "#ffffff" : curHex(), st.none ? 1 : st.a)), Object.assign({ offset: 1 }, toHsvA("#000000", 1))] };
  };
  const loadStop = () => { const g = grad[active]; if (!g) return; const s = g.stops[g.active]; st.h = s.h; st.s = s.s; st.v = s.v; st.a = s.a; st.none = false; };
  const saveStop = () => { const g = grad[active]; if (!g) return; const s = g.stops[g.active]; if (s) { s.h = st.h; s.s = st.s; s.v = st.v; s.a = st.a; } };
  const sampleStop = (g, off) => { let best = g.stops[0], bd = Infinity; for (const s of g.stops) { const d = Math.abs(s.offset - off); if (d < bd) { bd = d; best = s; } } return { h: best.h, s: best.s, v: best.v, a: best.a }; };
  let gradStrip = null; const gradTypeBtns = {};
  if (gradCap) {
    const box = document.createElement("div"); box.className = "cp-gradient";
    const tabs = document.createElement("div"); tabs.className = "cp-paint-types";
    [["none", "None"], ["solid", "Solid"], ["linear", "Linear"], ["radial", "Radial"]].forEach(([k, label]) => {
      const b = document.createElement("button"); b.type = "button"; b.className = "cp-ptype"; b.dataset.t = k; b.textContent = label;
      b.addEventListener("click", () => setPaintType(k)); tabs.appendChild(b); gradTypeBtns[k] = b;
    });
    gradStrip = document.createElement("div"); gradStrip.className = "cp-grad-strip";
    box.append(tabs, gradStrip);
    const models = win.querySelector(".cp-models"); models.parentNode.insertBefore(box, models);
    gradStrip.addEventListener("pointerdown", (e) => {
      const g = grad[active]; if (!g) return;
      const r = gradStrip.getBoundingClientRect();
      const stopEl = e.target.closest(".cp-grad-stop");
      if (stopEl) {
        const i = +stopEl.dataset.i; g.active = i; loadStop(); paint(); renderStrip();
        try { gradStrip.setPointerCapture(e.pointerId); } catch {}
        const mv = (ev) => { g.stops[i].offset = clamp01((ev.clientX - r.left) / r.width); renderStrip(); emit(); };
        const up = () => { gradStrip.removeEventListener("pointermove", mv); gradStrip.removeEventListener("pointerup", up); };
        gradStrip.addEventListener("pointermove", mv); gradStrip.addEventListener("pointerup", up);
      } else {
        const off = clamp01((e.clientX - r.left) / r.width);
        g.stops.push(Object.assign({ offset: off }, sampleStop(g, off))); g.active = g.stops.length - 1;
        loadStop(); paint(); renderStrip(); emit();
      }
    });
    gradStrip.addEventListener("dblclick", (e) => { const el = e.target.closest(".cp-grad-stop"); if (el) removeStop(+el.dataset.i); });
  }
  function setPaintType(k) {
    if (!gradCap) return;
    if (k === "none") { mode[active] = "solid"; st.none = true; paint(); emit(); syncGradUI(); return; }
    if (k === "solid") { if (mode[active] !== "solid") saveStop(); mode[active] = "solid"; st.none = false; paint(); emit(); syncGradUI(); return; }
    mode[active] = k; ensureGrad(active, k); loadStop(); paint(); renderStrip(); emit(); syncGradUI();
  }
  function removeStop(i) { const g = grad[active]; if (!g || g.stops.length <= 2) return; g.stops.splice(i, 1); g.active = Math.max(0, Math.min(g.active, g.stops.length - 1)); loadStop(); paint(); renderStrip(); emit(); }
  function renderStrip() {
    if (!gradStrip) return; const g = grad[active]; if (!g) return;
    const css = g.stops.slice().sort((a, b) => a.offset - b.offset).map((s) => { const c = hv.hsvToRgb(s.h, s.s, s.v); return `${hv.rgbToHex(c.r, c.g, c.b)} ${Math.round(s.offset * 100)}%`; }).join(", ");
    gradStrip.style.background = `linear-gradient(to right, ${css}), ${checker}`;
    gradStrip.querySelectorAll(".cp-grad-stop").forEach((n) => n.remove());
    g.stops.forEach((s, i) => { const h = document.createElement("div"); h.className = "cp-grad-stop" + (i === g.active ? " active" : ""); h.style.left = (s.offset * 100) + "%"; const c = hv.hsvToRgb(s.h, s.s, s.v); h.style.background = hv.rgbToHex(c.r, c.g, c.b); h.dataset.i = i; h.title = "Drag to move · double-click to remove"; gradStrip.appendChild(h); });
  }
  function syncGradUI() {
    if (!gradCap) return;
    const activeType = st.none ? "none" : mode[active];
    for (const k in gradTypeBtns) gradTypeBtns[k].classList.toggle("active", k === activeType);
    const isGrad = mode[active] !== "solid" && !st.none;
    if (gradStrip) gradStrip.style.display = isGrad ? "" : "none";
    if (isGrad) renderStrip();
  }
  if (gradCap) {
    for (const w of ["fill", "stroke"]) { const p = duo[w] && duo[w].paint; if (p && p.kind === "gradient") { mode[w] = p.spec.type === "radial" ? "radial" : "linear"; grad[w] = gradFromPaint(p); } }
    if (mode[active] !== "solid" && grad[active]) loadStop();
    syncGradUI();
  }

  // --- drag helpers ---
  function bindDrag(el, onMove) {
    el.addEventListener("pointerdown", (e) => {
      e.preventDefault(); el.setPointerCapture(e.pointerId);
      const r = el.getBoundingClientRect();
      const go = (ev) => onMove(ev.clientX - r.left, ev.clientY - r.top, r.width, r.height);
      go(e);
      const mv = (ev) => go(ev);
      const up = () => { el.removeEventListener("pointermove", mv); el.removeEventListener("pointerup", up); };
      el.addEventListener("pointermove", mv); el.addEventListener("pointerup", up);
    });
  }
  bindDrag(field, (x, y, w, h) => { st.s = clamp01(x / w) * 100; st.v = (1 - clamp01(y / h)) * 100; changed(); });
  bindDrag(hue, (x, y, w, h) => { st.h = clamp01(y / h) * 360; changed(); });
  bindDrag(alphaEl, (x, y, w) => { st.a = clamp01(x / w); paint(); emit(); });

  // --- hex + alpha inputs, model tabs (the per-model triple is wired in buildTriple) ---
  const setFromRgb = (r, g, b) => { Object.assign(st, hv.rgbToHsv(r, g, b)); };
  hexInput.addEventListener("input", () => { const rgb = hv.hexToRgb(hexInput.value); if (rgb) { setFromRgb(rgb.r, rgb.g, rgb.b); changed(); } });
  aInput.addEventListener("input", () => { st.a = clamp01((+aInput.value || 0) / 100); paint(); emit(); });
  bindScrubLabel(aInput.closest(".cp-inp"), aInput);
  win.querySelectorAll(".cp-tab").forEach((t) => t.addEventListener("click", () => {
    model = t.dataset.m; try { localStorage.setItem(CP_MODEL_KEY, model); } catch {}
    buildTriple(); paintFields();
  }));
  buildTriple();

  // --- eyedropper + swatches row. Eyedropper (native EyeDropper API) is the first,
  // clearly-bordered item so it's unmistakable; it samples the screen into the active
  // target. Then the fixed base palette + a persistent user palette (localStorage):
  // click applies, "+" saves the current colour, right-click removes a saved one.
  const sw = $(".cp-swatches");
  const recentWrap = $(".cp-recent"), recentRow = $(".cp-recent-row");
  const applyHex = (c) => { const rgb = hv.hexToRgb(c); if (rgb) { setFromRgb(rgb.r, rgb.g, rgb.b); changed(); } };
  const mkSw = (c, name) => { const b = document.createElement("button"); b.type = "button"; b.className = "cp-sw"; b.style.background = c; b.title = name ? `${name} (${c})` : c; b.addEventListener("click", () => applyHex(c)); return b; };
  // Recently-used colours (auto-tracked, separate from the saved palette).
  function renderRecent() {
    const rec = loadRecent(); recentWrap.hidden = rec.length === 0; recentRow.innerHTML = "";
    rec.forEach((c) => recentRow.appendChild(mkSw(c)));
  }
  // Set a swatch's group by hex (re-reads storage so callers never hold a stale array).
  const setSwatchGroup = (hex, group) => { const arr = loadSwatches(); const m = arr.find((x) => x.c === hex); if (m) { if (group) m.group = group; else delete m.group; saveSwatches(arr); renderSwatches(); } };
  // Eyedropper + base palette + saved (nameable, foldable) swatches. Right-click a saved
  // swatch for Rename / move-to-folder / Remove; a folder header's right-click renames or
  // ungroups (a folder is just a `group` string shared by its members, not its own storage
  // record — renaming/ungrouping is rewriting that string, no separate registry to keep in sync).
  const renderSwatches = () => {
    sw.innerHTML = "";
    if (window.EyeDropper) {
      const eye = document.createElement("button");
      eye.type = "button"; eye.className = "cp-sw cp-eyedrop"; eye.innerHTML = CP_PIPETTE_SVG;
      eye.title = "Eyedropper — pick a colour from the screen"; eye.setAttribute("aria-label", "Eyedropper");
      eye.addEventListener("click", async () => {
        try { const res = await new window.EyeDropper().open(); const rgb = hv.hexToRgb(res.sRGBHex); if (rgb) { setFromRgb(rgb.r, rgb.g, rgb.b); changed(); } }
        catch (_) { /* user pressed Esc — ignore */ }
      });
      sw.appendChild(eye);
    }
    CP_BASE_SWATCHES.forEach((c) => sw.appendChild(mkSw(c)));
    const all = loadSwatches();
    const groups = []; for (const it of all) if (it.group && !groups.includes(it.group)) groups.push(it.group);
    const mkSaved = (it) => {
      const b = mkSw(it.c, it.name);
      b.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        const items = [
          { label: "Rename…", onClick: () => floatingInput({ title: "Swatch name", value: it.name || "", onCommit: (n) => { const arr = loadSwatches(); const m = arr.find((x) => x.c === it.c); if (m) { m.name = n || undefined; saveSwatches(arr); renderSwatches(); } } }) },
          { type: "sep" },
        ];
        groups.filter((g) => g !== it.group).forEach((g) => items.push({ label: `Move to “${g}”`, onClick: () => setSwatchGroup(it.c, g) }));
        items.push({ label: "New folder…", onClick: () => floatingInput({ title: "New folder name", onCommit: (n) => setSwatchGroup(it.c, n) }) });
        if (it.group) items.push({ label: "Remove from folder", onClick: () => setSwatchGroup(it.c, null) });
        items.push({ type: "sep" }, { label: "Remove", onClick: () => { saveSwatches(loadSwatches().filter((x) => x.c !== it.c)); renderSwatches(); } });
        showContextMenu(e.clientX, e.clientY, items);
      });
      return b;
    };
    all.filter((it) => !it.group).forEach((it) => sw.appendChild(mkSaved(it)));
    const add = document.createElement("button"); add.type = "button"; add.className = "cp-sw cp-sw-add"; add.textContent = "+"; add.title = "Save current colour";
    add.addEventListener("click", () => { const hex = curHex(); const u = loadSwatches().filter((x) => x.c.toLowerCase() !== hex.toLowerCase()); u.unshift({ c: hex }); saveSwatches(u); renderSwatches(); });
    sw.appendChild(add);
    groups.forEach((gname) => {
      const grp = document.createElement("div"); grp.className = "cp-swgroup";
      const head = document.createElement("div"); head.className = "cp-swgroup-head cp-strip-lab"; head.textContent = gname; head.title = "Right-click to rename or ungroup this folder";
      head.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, [
          { label: "Rename folder…", onClick: () => floatingInput({ title: "Folder name", value: gname, onCommit: (n) => { const arr = loadSwatches(); arr.forEach((x) => { if (x.group === gname) x.group = n; }); saveSwatches(arr); renderSwatches(); } }) },
          { label: "Remove folder (keeps swatches)", onClick: () => { const arr = loadSwatches(); arr.forEach((x) => { if (x.group === gname) delete x.group; }); saveSwatches(arr); renderSwatches(); } },
        ]);
      });
      const row = document.createElement("div"); row.className = "cp-swgroup-row";
      all.filter((it) => it.group === gname).forEach((it) => row.appendChild(mkSaved(it)));
      grp.append(head, row);
      sw.appendChild(grp);
    });
  };
  // Global colours (Epic C.1): a shared, DOCUMENT-scoped palette — unlike the swatches above,
  // which are a personal, cross-document localStorage palette. Only present when the caller
  // wires opts.globals (the main fill/stroke duo panel does; artboard-bg/recolor pickers don't).
  const globalsWrap = $(".cp-globals");
  // Applying a global mutates the DOCUMENT (editor.applyGlobalColor sets fill/stroke to a
  // url(#…) reference), which the picker's own hsv `st`/`targets` model can't represent — so
  // this syncs the PREVIEW to the resolved hex without going through changed()/emit(), which
  // would re-apply st as a literal colour and stomp the link right back off.
  const syncAppliedGlobal = (hex) => {
    const rgb = hv.hexToRgb(hex); if (!rgb) return;
    setFromRgb(rgb.r, rgb.g, rgb.b); st.none = false;
    if (duo) targets[active] = { a: st.a, none: false, h: st.h, s: st.s, v: st.v };
    paint(); paintSide();
  };
  const renderGlobals = () => {
    if (!opts.globals) { globalsWrap.hidden = true; return; }
    const list = opts.globals.list();
    globalsWrap.hidden = false;
    globalsWrap.innerHTML = "";
    const label = document.createElement("div"); label.className = "cp-globals-lab"; label.textContent = "Global colours";
    globalsWrap.appendChild(label);
    const row = document.createElement("div"); row.className = "cp-globals-row";
    const activeId = opts.globals.activeId ? opts.globals.activeId() : null;
    list.forEach((g) => {
      const b = document.createElement("button"); b.type = "button"; b.className = "cp-sw cp-global";
      b.style.background = g.hex; b.title = g.name ? `${g.name} (${g.hex})` : g.hex;
      b.classList.toggle("on", g.id === activeId);
      b.addEventListener("click", () => { opts.globals.apply(g.id); syncAppliedGlobal(g.hex); renderGlobals(); });
      b.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, [
          { label: "Edit colour…", onClick: () => opts.globals.edit(g.id) },   // replaces the whole panel (edit mode) — no local refresh needed
          { label: "Rename…", onClick: () => floatingInput({ title: "Global colour name", value: g.name || "", onCommit: (n) => { opts.globals.rename(g.id, n); renderGlobals(); } }) },
          { label: "Delete", onClick: () => { opts.globals.remove(g.id); renderGlobals(); } },
        ]);
      });
      row.appendChild(b);
    });
    const add = document.createElement("button"); add.type = "button"; add.className = "cp-sw cp-sw-add"; add.textContent = "+"; add.title = "Make the current colour a global";
    add.addEventListener("click", () => {
      floatingInput({ title: "New global colour", value: "", onCommit: (name) => { opts.globals.makeNew(curHex(), name); renderGlobals(); } });
    });
    row.appendChild(add);
    globalsWrap.appendChild(row);
  };
  renderSwatches(); renderRecent(); renderGlobals();
  // Record a settled colour into recents (debounced so live dragging doesn't spam it).
  let recentT = null;
  const recordRecent = () => { clearTimeout(recentT); recentT = setTimeout(() => { if (!st.none) { pushRecent(curHex()); renderRecent(); } }, 700); };

  // --- actions ---
  const close = () => { if (host) { win.remove(); } else { back.remove(); activeColorPicker = null; } document.removeEventListener("keydown", onKey, true); };
  const ok = () => { if (opts.onCommit) opts.onCommit(st.none ? null : curHex(), st.a); close(); };
  const cancel = () => {
    if (duo) { duo.apply("fill", hv.toHexColor(orig.fill.color) || null, orig.fill.alpha); duo.apply("stroke", hv.toHexColor(orig.stroke.color) || null, orig.stroke.alpha); }
    else if (opts.onChange) opts.onChange(startHex, startAlpha);
    if (opts.onCancel) opts.onCancel(); close();
  };
  if ($(".cp-ok")) $(".cp-ok").addEventListener("click", ok);
  if ($(".cp-cancel")) $(".cp-cancel").addEventListener("click", cancel);
  if (opts.allowNone && $(".cp-none")) $(".cp-none").addEventListener("click", () => { if (gradCap) { setPaintType("none"); } else { st.none = true; paint(); emit(); } });
  if (!host) {
    back.addEventListener("pointerdown", (e) => { if (e.target === back) cancel(); });
    // Movable picker: drag it by the header (the backdrop no longer dims the canvas).
    const head = $(".cp-head"); if (head) {
      head.style.cursor = "move"; head.style.touchAction = "none";
      head.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        const r = win.getBoundingClientRect();
        win.style.position = "fixed"; win.style.margin = "0"; win.style.left = r.left + "px"; win.style.top = r.top + "px";
        const ox = e.clientX - r.left, oy = e.clientY - r.top;
        try { head.setPointerCapture(e.pointerId); } catch {}
        const mv = (ev) => { win.style.left = Math.max(2, Math.min(ev.clientX - ox, window.innerWidth - 60)) + "px"; win.style.top = Math.max(2, Math.min(ev.clientY - oy, window.innerHeight - 30)) + "px"; };
        const up = () => { head.removeEventListener("pointermove", mv); head.removeEventListener("pointerup", up); };
        head.addEventListener("pointermove", mv); head.addEventListener("pointerup", up);
      });
    }
  }
  const onKey = (e) => {
    // Panel mode: only claim X/Shift+X (duo target toggle/swap) — even when a field is
    // focused — and let everything else through (no Esc/Enter commit in a panel).
    if (host) { if (duo && (e.key === "x" || e.key === "X")) { e.preventDefault(); e.stopPropagation(); if (e.shiftKey) swapTargets(); else switchTo(active === "fill" ? "stroke" : "fill"); } return; }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancel(); }
    else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); ok(); }
    // X toggles fill/stroke, Shift+X swaps — intercepted even while a field is focused
    // (x isn't a meaningful hex/number char, so it's safe to claim it for the toggle).
    else if (duo && (e.key === "x" || e.key === "X")) {
      e.preventDefault(); e.stopPropagation();
      if (e.shiftKey) swapTargets(); else switchTo(active === "fill" ? "stroke" : "fill");
    }
  };
  document.addEventListener("keydown", onKey, true);
  if (!host) activeColorPicker = { cancel };

  paint(); paintSide();
  if (!host) setTimeout(() => hexInput.focus(), 0);
  return { destroy: close, switchTo, swapTargets };   // controller (host/panel mode uses this)
}
