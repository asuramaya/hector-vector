// Inspector control builders — extracted from editor.js (#30, ui-rows). Pure DOM
// factories for the Properties/inspector panel rows (groups, labelled inputs, the
// drag-to-scrub number fields, icon button rows, selects) + the inline-SVG glyph
// sets for the cap/join/dash/align segmented controls. No `editor`/`this` deps —
// plain functions, so this is a normal export module (not a mixin). editor.js
// imports these; ghostBtn is re-exported from editor.js for modal/docio/settings.

// ---------- inspector control builders ----------
// Inline-SVG previews for the cap / join / dash segmented controls. currentColor so
// the active (inverted) button still reads. Far clearer than the old look-alike
// Unicode glyphs (▭ ▢ ■ / ⌐ ◜ ◹) that rendered as near-identical tofu boxes.
export const CAP_GLYPH = {
  butt: `<svg viewBox="0 0 24 16" width="24" height="13" aria-hidden="true"><line x1="8" y1="8" x2="16" y2="8" stroke="currentColor" stroke-width="8" stroke-linecap="butt"/></svg>`,
  round: `<svg viewBox="0 0 24 16" width="24" height="13" aria-hidden="true"><line x1="8" y1="8" x2="16" y2="8" stroke="currentColor" stroke-width="8" stroke-linecap="round"/></svg>`,
  square: `<svg viewBox="0 0 24 16" width="24" height="13" aria-hidden="true"><line x1="8" y1="8" x2="16" y2="8" stroke="currentColor" stroke-width="8" stroke-linecap="square"/></svg>`,
};
export const JOIN_GLYPH = {
  miter: `<svg viewBox="0 0 24 18" width="24" height="14" aria-hidden="true"><path d="M5 16 L12 5 L19 16" fill="none" stroke="currentColor" stroke-width="5" stroke-linejoin="miter"/></svg>`,
  round: `<svg viewBox="0 0 24 18" width="24" height="14" aria-hidden="true"><path d="M5 16 L12 5 L19 16" fill="none" stroke="currentColor" stroke-width="5" stroke-linejoin="round"/></svg>`,
  bevel: `<svg viewBox="0 0 24 18" width="24" height="14" aria-hidden="true"><path d="M5 16 L12 5 L19 16" fill="none" stroke="currentColor" stroke-width="5" stroke-linejoin="bevel"/></svg>`,
};
export const DASH_GLYPH = {
  solid: `<svg viewBox="0 0 36 12" width="34" height="11" aria-hidden="true"><line x1="3" y1="6" x2="33" y2="6" stroke="currentColor" stroke-width="2.5"/></svg>`,
  dashed: `<svg viewBox="0 0 36 12" width="34" height="11" aria-hidden="true"><line x1="3" y1="6" x2="33" y2="6" stroke="currentColor" stroke-width="2.5" stroke-dasharray="6 4"/></svg>`,
  dotted: `<svg viewBox="0 0 36 12" width="34" height="11" aria-hidden="true"><line x1="3" y1="6" x2="33" y2="6" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-dasharray="0.1 6"/></svg>`,
};
// Align / arrange / flip glyphs — small inline SVGs (same clarity rationale as the
// cap/join icons: unambiguous, currentColor so the hover/active state still reads).
export const ALIGN_ICON = {
  left: `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="1" y="1.5" width="1.4" height="13" fill="currentColor"/><rect x="3.5" y="3.2" width="9.5" height="3" rx="0.5" fill="currentColor"/><rect x="3.5" y="9.8" width="6" height="3" rx="0.5" fill="currentColor"/></svg>`,
  right: `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="13.6" y="1.5" width="1.4" height="13" fill="currentColor"/><rect x="3" y="3.2" width="9.5" height="3" rx="0.5" fill="currentColor"/><rect x="6.5" y="9.8" width="6" height="3" rx="0.5" fill="currentColor"/></svg>`,
  hcenter: `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="7.3" y="1.5" width="1.4" height="13" fill="currentColor"/><rect x="3" y="3.2" width="10" height="3" rx="0.5" fill="currentColor"/><rect x="5" y="9.8" width="6" height="3" rx="0.5" fill="currentColor"/></svg>`,
  top: `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="1.5" y="1" width="13" height="1.4" fill="currentColor"/><rect x="3.2" y="3.5" width="3" height="9.5" rx="0.5" fill="currentColor"/><rect x="9.8" y="3.5" width="3" height="6" rx="0.5" fill="currentColor"/></svg>`,
  bottom: `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="1.5" y="13.6" width="13" height="1.4" fill="currentColor"/><rect x="3.2" y="3" width="3" height="9.5" rx="0.5" fill="currentColor"/><rect x="9.8" y="6.5" width="3" height="6" rx="0.5" fill="currentColor"/></svg>`,
  vmiddle: `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="1.5" y="7.3" width="13" height="1.4" fill="currentColor"/><rect x="3.2" y="3" width="3" height="10" rx="0.5" fill="currentColor"/><rect x="9.8" y="5" width="3" height="6" rx="0.5" fill="currentColor"/></svg>`,
};
// Distribute glyphs — three bars/blocks with even gaps, one per axis (same style as ALIGN_ICON).
export const DISTRIBUTE_ICON = {
  h: `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="1" y="5" width="2.6" height="6" rx="0.5" fill="currentColor"/><rect x="6.7" y="3.5" width="2.6" height="9" rx="0.5" fill="currentColor"/><rect x="12.4" y="5" width="2.6" height="6" rx="0.5" fill="currentColor"/></svg>`,
  v: `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="5" y="1" width="6" height="2.6" rx="0.5" fill="currentColor"/><rect x="3.5" y="6.7" width="9" height="2.6" rx="0.5" fill="currentColor"/><rect x="5" y="12.4" width="6" height="2.6" rx="0.5" fill="currentColor"/></svg>`,
};
export const AB_FIT_ICON =`<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="1.5" y="1.5" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.1" stroke-dasharray="2 1.4"/><rect x="5" y="5" width="6" height="6" fill="currentColor"/></svg>`;
export const BLEND_MODES = [
  ["normal", "Normal"], ["multiply", "Multiply"], ["screen", "Screen"], ["overlay", "Overlay"],
  ["darken", "Darken"], ["lighten", "Lighten"], ["color-dodge", "Colour dodge"], ["color-burn", "Colour burn"],
  ["hard-light", "Hard light"], ["soft-light", "Soft light"], ["difference", "Difference"], ["exclusion", "Exclusion"],
  ["hue", "Hue"], ["saturation", "Saturation"], ["color", "Colour"], ["luminosity", "Luminosity"],
];
// Collapsible inspector groups: clicking the title folds the group. Open/closed state is keyed
// by title and persisted, so it survives the full panel rebuild on every _renderInspector.
const COLLAPSE_KEY = "hv-insp-collapsed";
const DEFAULT_COLLAPSED = ["Effects", "Recolor", "Pattern", "Width", "Repeat", "Blend", "Symbol", "Mask"];
let _collapsed = null;
function collapsedSet() {
  if (_collapsed) return _collapsed;
  try { const raw = localStorage.getItem(COLLAPSE_KEY); _collapsed = new Set(raw ? JSON.parse(raw) : DEFAULT_COLLAPSED); }
  catch (_) { _collapsed = new Set(DEFAULT_COLLAPSED); }
  return _collapsed;
}
function saveCollapsed() { try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsedSet()])); } catch (_) {} }
export function inspGroup(title, rows, opts = {}) {
  const g = document.createElement("div"); g.className = "insp-group";
  // Keep textContent == title (the caret is a CSS ::before, NOT a child node) so callers/tests
  // that locate a group by `.insp-title.textContent === 'Stroke'` keep working.
  const t = document.createElement("div"); t.className = "insp-title"; t.textContent = title;
  if (opts.collapsible !== false && title) {
    g.dataset.group = title;
    if (collapsedSet().has(title)) g.classList.add("collapsed");
    t.classList.add("is-collapsible");
    t.addEventListener("click", () => {
      const s = collapsedSet(), open = s.has(title);
      if (open) s.delete(title); else s.add(title);
      g.classList.toggle("collapsed", !open);
      saveCollapsed();
    });
  }
  g.appendChild(t);
  rows.forEach((r) => g.appendChild(r));
  return g;
}
export function inspRow(label, control) {
  const row = document.createElement("div"); row.className = "insp-row";
  const s = document.createElement("span"); s.textContent = label;
  row.appendChild(s); row.appendChild(control); return row;
}
// A row of square icon buttons (align / arrange / flip). `btns`: [{html|glyph, title, onClick, active, disabled}].
export function inspBtnRow(label, btns) {
  const box = document.createElement("div"); box.className = "insp-btns";
  for (const b of btns) {
    const el = document.createElement("button"); el.type = "button"; el.className = "insp-iconbtn" + (b.active ? " on" : "");
    if (b.html) el.innerHTML = b.html; else el.textContent = b.glyph || "";
    el.title = b.title || ""; if (b.disabled) el.disabled = true;
    el.addEventListener("click", () => b.onClick());
    box.appendChild(el);
  }
  return inspRow(label, box);
}
// A labelled <select> row (blend mode, etc.). `options`: [[value, text], …].
export function selectRow(label, value, options, onChange) {
  const sel = document.createElement("select");
  for (const [v, t] of options) { const o = document.createElement("option"); o.value = v; o.textContent = t; if (v === value) o.selected = true; sel.appendChild(o); }
  sel.addEventListener("change", () => onChange(sel.value));
  return inspRow(label, sel);
}
// Drag-to-scrub: the row label becomes an "invisible slider" (ew-resize). Drag right
// to raise / left to lower by `step` per ~4px; coarse Shift = ×10, fine Alt = ÷10. A
// plain click does nothing (so the number field stays normally typeable). The live
// onLive runs through coalesce; onCommit fires once at the end of the drag.
export function makeScrub(handle, inp, min, step, onLive, onCommit) {
  if (!handle) return;
  handle.classList.add("scrub");
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const start = parseFloat(inp.value) || 0;
    const base = parseFloat(step) || 1;
    const lo = min != null ? parseFloat(min) : -Infinity;
    let moved = false;
    const move = (ev) => {
      const dx = ev.clientX - startX;
      if (!moved && Math.abs(dx) < 3) return;
      moved = true;
      const unit = ev.shiftKey ? base * 10 : ev.altKey ? base / 10 : base;
      let v = start + Math.round(dx / 4) * unit;
      v = Math.max(lo, Math.round(v * 1e4) / 1e4);
      inp.value = String(v);
      onLive(v);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      if (moved && onCommit) onCommit();
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  });
}
// One label+number field — the shared building block. `field` is a compact label+input
// grid; used full-width by numRow and two-up by numPairRow. `disabled` greys it out and
// drops the scrub (e.g. Corner on a non-rect, kept present to balance the row). Returns
// {field, inp}.
export function numField(label, value, min, step, onLive, capture, onCommit, mixed, disabled) {
  const field = document.createElement("div"); field.className = "insp-field" + (disabled ? " is-disabled" : "");
  const s = document.createElement("span"); s.textContent = label;
  const inp = document.createElement("input"); inp.type = "number";
  if (mixed) { inp.value = ""; inp.placeholder = "Mixed"; } else inp.value = String(value);
  if (min != null) inp.min = String(min);
  inp.step = String(step);
  if (disabled) { inp.disabled = true; }
  else {
    inp.addEventListener("input", () => { if (inp.value !== "") onLive(parseFloat(inp.value)); });
    inp.addEventListener("change", () => { if (inp.value !== "") onLive(parseFloat(inp.value)); if (onCommit) onCommit(); });
    makeScrub(s, inp, min, step, onLive, onCommit);
  }
  if (capture) capture(inp);
  field.appendChild(s); field.appendChild(inp);
  return { field, inp };
}
// Two number fields on one row (X|Y, W|H) — reclaims the dead horizontal space a single
// short value left as whitespace. Each arg is a numField argument list.
export function numPairRow(a, b) {
  const row = document.createElement("div"); row.className = "insp-row insp-pair";
  row.appendChild(numField(...a).field);
  row.appendChild(numField(...b).field);
  return row;
}
// A lone compact field in the left half of a pair row (right half empty) — for single
// congruent fields like R (rotate) and C (corner) so their input lines up under X / W
// instead of stretching full-width. `spec` is a numField argument list.
export function numHalfRow(spec) {
  const row = document.createElement("div"); row.className = "insp-row insp-pair";
  row.appendChild(numField(...spec).field);
  row.appendChild(document.createElement("div"));
  return row;
}
export function numRow(label, value, min, step, onLive, capture, onCommit, mixed) {
  const inp = document.createElement("input"); inp.type = "number";
  if (mixed) { inp.value = ""; inp.placeholder = "Mixed"; } else inp.value = String(value);
  if (min != null) inp.min = String(min);
  inp.step = String(step);
  inp.addEventListener("input", () => { if (inp.value !== "") onLive(parseFloat(inp.value)); });
  inp.addEventListener("change", () => { if (inp.value !== "") onLive(parseFloat(inp.value)); if (onCommit) onCommit(); });
  if (capture) capture(inp);
  const row = inspRow(label, inp);
  makeScrub(row.querySelector("span"), inp, min, step, onLive, onCommit);
  return row;
}
export function checkRow(label, checked, onChange) {
  const inp = document.createElement("input"); inp.type = "checkbox"; inp.checked = checked;
  inp.addEventListener("change", () => onChange(inp.checked));
  return inspRow(label, inp);
}

export function ghostBtn(label, onClick) {
  const b = document.createElement("button"); b.type = "button"; b.className = "ghost-button"; b.textContent = label;
  b.addEventListener("click", onClick); return b;
}
