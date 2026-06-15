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
// Saved swatches can carry a name now; legacy entries are plain hex strings, so
// loadSwatches normalises both to { c, name? }. saveSwatches keeps the raw array.
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
    const hex = st.none ? null : curHex();
    if (duo) { targets[active] = { a: st.a, none: st.none, h: st.h, s: st.s, v: st.v }; duo.apply(active, hex, st.a); }
    else if (opts.onChange) opts.onChange(hex, st.a);
    paintSide();
    if (typeof recordRecent === "function") recordRecent();   // settle the colour into recents (debounced)
  }
  function changed() { st.none = false; paint(); emit(); }
  // Switch which target the field edits — pure focus change, no colour applied (so it
  // never reads as an undo). Save the live edit back into the outgoing target first.
  function switchTo(which) {
    if (!duo || which === active) return;
    targets[active] = { a: st.a, none: st.none, h: st.h, s: st.s, v: st.v };
    active = which; Object.assign(st, targets[which]); paint(); paintSide();
  }
  function swapTargets() {
    if (!duo) return;
    targets[active] = { a: st.a, none: st.none, h: st.h, s: st.s, v: st.v };
    const f = targets.fill; targets.fill = targets.stroke; targets.stroke = f;
    Object.assign(st, targets[active]);
    duo.apply("fill", targets.fill.none ? null : stHexOf(targets.fill), targets.fill.a);
    duo.apply("stroke", targets.stroke.none ? null : stHexOf(targets.stroke), targets.stroke.a);
    paint(); paintSide();
  }
  buildSide();

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
  // Eyedropper + base palette + saved (nameable) swatches. Right-click a saved swatch
  // for Rename / Remove; "+" saves the current colour.
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
    loadSwatches().forEach((it) => {
      const b = mkSw(it.c, it.name);
      b.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, [
          { label: "Rename…", onClick: () => floatingInput({ title: "Swatch name", value: it.name || "", onCommit: (n) => { const arr = loadSwatches(); const m = arr.find((x) => x.c === it.c); if (m) { m.name = n || undefined; saveSwatches(arr); renderSwatches(); } } }) },
          { label: "Remove", onClick: () => { saveSwatches(loadSwatches().filter((x) => x.c !== it.c)); renderSwatches(); } },
        ]);
      });
      sw.appendChild(b);
    });
    const add = document.createElement("button"); add.type = "button"; add.className = "cp-sw cp-sw-add"; add.textContent = "+"; add.title = "Save current colour";
    add.addEventListener("click", () => { const hex = curHex(); const u = loadSwatches().filter((x) => x.c.toLowerCase() !== hex.toLowerCase()); u.unshift({ c: hex }); saveSwatches(u); renderSwatches(); });
    sw.appendChild(add);
  };
  renderSwatches(); renderRecent();
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
  if (opts.allowNone && $(".cp-none")) $(".cp-none").addEventListener("click", () => { st.none = true; paint(); emit(); });
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
