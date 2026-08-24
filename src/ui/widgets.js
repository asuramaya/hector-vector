// Shared form/DOM primitives — extracted from app.js (#28). These are the little
// builders every panel and modal reaches for (label rows, selects, number inputs,
// range sliders, section headers). The settings-bound variants (makeSelect/makeRange/
// makeNumber) read+write the live settings object, so app.js injects it once via
// configureWidgets; the rest are pure DOM factories.
let settings, persistSettings;
export function configureWidgets(deps) {
  ({ settings, persistSettings } = deps);
}

export function fieldRow(label, control, hint) {
  const row = document.createElement("label");
  row.className = "form-row";
  const span = document.createElement("span");
  span.className = "form-label";
  span.textContent = label;
  row.appendChild(span);
  row.appendChild(control);
  if (hint) {
    const h = document.createElement("span");
    h.className = "form-hint";
    h.textContent = hint;
    row.appendChild(h);
  }
  return row;
}

// A settings row's full explanation, one click away instead of sitting on the page as a
// permanent paragraph. Only one popover is ever open at a time (a second click elsewhere
// closes the first) — this is a click-to-reveal panel, not a `title=` hover tooltip, which
// needs a mouse and so is unreachable on a phone (see actions.js's TOOL_WHY comment).
let openPopover = null, openPopoverOwner = null;
function closeInfoPopover() {
  if (openPopover) openPopover.remove();
  openPopover = null; openPopoverOwner = null;
}
document.addEventListener("click", (e) => {
  if (openPopover && e.target !== openPopoverOwner && !openPopover.contains(e.target)) closeInfoPopover();
}, true);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeInfoPopover(); });

export function infoButton(text) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "info-btn";
  btn.textContent = "ⓘ";
  btn.setAttribute("aria-label", "More information");
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const wasMine = openPopoverOwner === btn;
    closeInfoPopover();
    if (wasMine) return;   // second click on the same button just closes it
    const pop = document.createElement("div");
    pop.className = "info-popover";
    pop.textContent = text;
    document.body.appendChild(pop);
    const r = btn.getBoundingClientRect();
    pop.style.top = (r.bottom + 6) + "px";
    // Anchor right-edge-flush when there isn't room to grow rightward from the button.
    const maxLeft = window.innerWidth - pop.offsetWidth - 8;
    pop.style.left = Math.max(8, Math.min(r.left, maxLeft)) + "px";
    openPopover = pop; openPopoverOwner = btn;
  });
  return btn;
}

// fieldRow, but the explanation lives behind an "i" button next to the label instead of as
// an always-visible paragraph. `shortHint`, if given, is a one-line status that stays
// inline (e.g. "Off." / "On — active.") — the kind of thing worth seeing at a glance; the
// full explanation of what the setting DOES only shows up once someone asks for it.
export function fieldRowInfo(label, control, info, shortHint) {
  const row = document.createElement("label");
  row.className = "form-row";
  const span = document.createElement("span");
  span.className = "form-label form-label-info";
  span.textContent = label;
  span.appendChild(infoButton(info));
  row.appendChild(span);
  row.appendChild(control);
  if (shortHint) {
    const h = document.createElement("span");
    h.className = "form-hint";
    h.textContent = shortHint;
    row.appendChild(h);
  }
  return row;
}

export function makeSelect(key, options) {
  const sel = document.createElement("select");
  for (const [value, label] of options) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    if (String(settings[key]) === String(value)) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener("change", () => { settings[key] = sel.value; persistSettings(); });
  return sel;
}

export function makeSelectRaw(value, options, onChange) {
  const sel = document.createElement("select");
  for (const [val, label] of options) {
    const o = document.createElement("option");
    o.value = val;
    o.textContent = label;
    if (String(value) === String(val)) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener("change", () => onChange(sel.value));
  return sel;
}

export function makeNumberRaw(value, onChange) {
  const input = document.createElement("input");
  input.type = "number";
  input.className = "form-input";
  input.min = "1";
  input.max = "16384";
  input.value = String(value || "");
  input.addEventListener("input", () => onChange(parseInt(input.value, 10) || 0));
  return input;
}

export function makeRange(key, min, max, step) {
  const wrap = document.createElement("div");
  wrap.className = "form-range";
  const input = document.createElement("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(settings[key]);
  const out = document.createElement("output");
  out.textContent = input.value;
  input.addEventListener("input", () => {
    out.textContent = input.value;
    settings[key] = input.value;
    persistSettings();
  });
  wrap.appendChild(input);
  wrap.appendChild(out);
  return wrap;
}

export function makeNumber(key, { min, max, step = 1, placeholder = "" } = {}) {
  const input = document.createElement("input");
  input.type = "number";
  input.className = "form-input";
  if (min !== undefined) input.min = String(min);
  if (max !== undefined) input.max = String(max);
  input.step = String(step);
  input.placeholder = placeholder;
  input.value = String(settings[key] ?? "");
  input.addEventListener("input", () => {
    settings[key] = input.value;
    persistSettings();
  });
  return input;
}

export function sectionTitle(text) {
  const h = document.createElement("div");
  h.className = "form-section";
  h.textContent = text;
  return h;
}

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
