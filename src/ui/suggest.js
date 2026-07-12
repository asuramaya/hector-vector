// "Here's what you can do with this." The literate half of the contextual engine.
//
// The bars show the top actions as icons — fast, but mute. This block says them out loud: a one-line
// read of what's selected, then the ranked actions with real labels and a reason each. It's the only
// surface that can offer the MENU-only verbs (Expand object, Outline stroke, Pathfinder, Make symbol…)
// — those have no toolbar tiles, so a bar physically cannot show them, and until now they were buried
// behind an "Actions ▾" button that most people never open.
//
// It deliberately looks like the raster auto-plan banner (.proc-auto), because it IS the same idea:
// read the subject, propose what to do about it. That banner has existed for rasters since the
// auto-routing work; vectors simply never got one. This is that gap, closed — and it reuses the
// banner's styling wholesale rather than inventing a second visual language for the same job.
import { rankFor, describeSelection, selectionKind } from "./actions.js";
import { isTouchShell } from "./formfactor.js";

let getLayout = () => null, getPref = () => "off", getEditor = () => null;
export function configureSuggest(deps) { ({ getLayout, getPref, getEditor } = deps); }

const TOP_N = 4;          // on the bar you get icons; here you get the best few, spelled out
let el = null, lastKey = "";

// Phone: first thing in the Panels sheet. Desktop: the top of the Properties panel — the one that's
// literally titled "Object", is already contextual, and already hosts the Actions ▾ button.
function host() {
  if (isTouchShell()) return document.querySelector("#rightdock");
  const body = document.querySelector(".rail-section.properties .fp-body");
  return body || null;
}

function row(item, run) {
  const r = document.createElement("div");
  r.className = "proc-plan-step suggest-row";
  r.dataset.suggestKey = item.key;
  const cap = document.createElement("span");
  cap.className = "proc-plan-cap";
  cap.textContent = (item.glyph ? item.glyph + "  " : "") + item.label;
  const why = document.createElement("span");
  why.className = "proc-plan-why";
  why.textContent = item.why || "";
  const go = document.createElement("button");
  go.type = "button";
  go.className = "proc-plan-add";
  go.textContent = "Do it";
  go.addEventListener("click", (e) => { e.stopPropagation(); run(item); });
  r.append(cap, why, go);
  r.addEventListener("click", () => run(item));
  return r;
}

// Running a suggestion CLICKS THE REAL BUTTON. Not laziness — it reuses the existing wired handler,
// its refreshActionButtons() follow-up and its try/catch → status line for free, and it makes it
// structurally impossible for this block to offer something the toolbar can't actually do.
function run(item) {
  if (item.kind === "verb") { if (item.run) item.run(); return; }
  const btn = document.querySelector(item.key);
  if (btn && !btn.disabled) btn.click();
}

export function render(facts) {
  const L = getLayout(), ed = getEditor();
  if (!facts || !ed) return;
  const on = isTouchShell() || (getPref() || "off") !== "off";
  const parent = host();
  if (!on || !parent) { if (el) { el.remove(); el = null; lastKey = ""; } return; }

  const kind = selectionKind(facts);
  const { tiles, verbs } = rankFor(facts, { isHidden: (k) => (L ? L.isHidden(k) : false) });
  const items = [...tiles, ...verbs];

  // Nothing selected, or an image (which already has its own, better suggester — the auto-plan banner
  // in the Processor panel reads the actual pixels. Don't put a worse second opinion next to it).
  if (!facts.hasSel || kind === "raster" || !items.length) {
    if (el) { el.remove(); el = null; lastKey = ""; }
    return;
  }

  const key = kind + "|" + items.map((i) => i.key).join(",") + "|" + (isTouchShell() ? "p" : "d");
  if (el && el.parentElement === parent && key === lastKey) return;   // nothing changed; don't repaint
  lastKey = key;

  const box = document.createElement("div");
  box.className = "proc-auto suggest" + (isTouchShell() ? " in-sheet" : "");

  const head = document.createElement("div");
  head.className = "proc-auto-head";
  const badge = document.createElement("span");
  badge.className = "proc-auto-badge";
  badge.textContent = "Suggested";
  const sum = document.createElement("span");
  sum.className = "proc-auto-sum";
  sum.textContent = describeSelection(facts);
  head.append(badge, sum);
  box.appendChild(head);

  const top = document.createElement("div");
  top.className = "proc-auto-steps";
  for (const it of items.slice(0, TOP_N)) top.appendChild(row(it, run));
  box.appendChild(top);

  // Everything else you COULD do, one tap away. The bar can never show these (the verbs have no
  // tiles), so without this they stay buried in a menu.
  const rest = items.slice(TOP_N);
  if (rest.length) {
    const more = document.createElement("div");
    more.className = "proc-auto-offered suggest-more";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "suggest-more-lbl";
    const list = document.createElement("div");
    list.className = "proc-auto-steps";
    list.hidden = true;
    const label = () => { toggle.textContent = `${list.hidden ? "▸" : "▾"} Also possible (${rest.length})`; };
    toggle.addEventListener("click", () => { list.hidden = !list.hidden; label(); });
    label();
    for (const it of rest) list.appendChild(row(it, run));
    more.append(toggle, list);
    box.appendChild(more);
  }

  if (el) el.remove();
  el = box;
  parent.insertBefore(el, parent.firstChild);
}

// The phone/desktop homes are different elements, so a form-factor change has to re-home it.
export function rehomeSuggest() { lastKey = ""; }
