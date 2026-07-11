// The phone form factor: the ≤620px breakpoint, and the band composition that goes with it.
//
// This lives apart from app.js so that layout.js can DRIVE it. Ordering matters and used to be
// wrong: the composition ran as an IIFE at app.js:379 while the layout engine booted at :1100, so
// on a phone layout.js snapshotted the already-composed DOM as "the authored layout" — losing the
// zoom tiles (they sit in #mobile-top, which was not a registered bar) and filing #act-duplicate
// under `arrange`. Persisting that would have corrupted the user's DESKTOP layout. layout.js now
// takes its authored snapshot first and calls composePhone() itself.
export const PHONE_MQ = "(max-width: 620px)";

const mql = window.matchMedia(PHONE_MQ);
export const isPhone = () => mql.matches;
export function onFormFactorChange(cb) { mql.addEventListener("change", (e) => cb(e.matches)); }

// Where each element lived before we first moved it, so it can be put back verbatim.
//
// LAZY on purpose. layout.js applies a saved arrangement BEFORE composing the phone, so a home
// recorded eagerly at module-eval would point at the AUTHORED slot — and the trip back to desktop
// would silently discard whatever the user had saved. Recording on first touch captures the real,
// post-layout parent.
const homes = new Map();
const remember = (el) => { if (el && !homes.has(el)) homes.set(el, { parent: el.parentNode, next: el.nextSibling }); };
const goHome = (el) => { const h = homes.get(el); if (h && h.parent) h.parent.insertBefore(el, h.next); };

const q = (s) => document.querySelector(s);
const mkSep = () => { const s = document.createElement("span"); s.className = "tool-sep mobile-made"; s.setAttribute("aria-hidden", "true"); return s; };

let composed = false;

// Phone portrait (≤620px). MOVES existing elements rather than rebuilding them, so every id-wired
// handler and every layout.js tileKey survives.
//
// Three bands, by how often you reach for them:
//   TOP    — undo/redo + zoom/fit. Always visible: undo is the most-used control in a touch editor
//            and it used to be TWO taps deep in the Panels sheet.
//   BOTTOM — the tools. Always visible.
//   CONTEXT— arrange + delete + duplicate, shown ONLY when something is selected (the
//            .has-selection class), so it costs zero canvas while you draw. Delete lived in
//            .stage-toolbar, which the phone stylesheet display:none'd outright — it was genuinely
//            UNREACHABLE on a phone.
// The rest (booleans, rotate/flip, rulers/guides) stays one tap away in the Panels sheet.
export function composePhone(on) {
  const sheet = q("#rightdock"), topbar = q("#mobile-top");
  if (!sheet || !topbar || on === composed) return;
  const actionbar = q(".editor-grid > .actionbar") || q("#rightdock > .actionbar");
  const panelFoot = q(".stage-wrap > .panel-foot") || q("#rightdock > .panel-foot");
  const arrange = q(".stage-wrap > .stage-toolbar");

  if (on) {
    // Quick bar, in reach order. Rulers/smart-guides deliberately stay behind in the sheet — they
    // are set-once toggles, not per-stroke controls, and the bar has to fit 390px.
    const quick = [
      q("#undo-button"), q("#redo-button"), null,
      q('[data-action="zoom-out"]'), q('[data-action="fit"]'),
      q('[data-action="actual"]'), q('[data-action="zoom-in"]'), null,
      q("#vp-selectall"),
    ];
    for (const el of quick) { remember(el); topbar.appendChild(el || mkSep()); }
    // Duplicate reads as a selection action, so it joins the contextual bar on a phone. Both it and
    // Delete are pulled to the FRONT of that bar: it overflows ~510px into 390px, and these two are
    // the ones you must never have to hunt for behind a horizontal scroll.
    const ctx = [q("#act-duplicate"), q("#layer-delete")].filter(Boolean);
    // reverse: each insert goes to the head, so the last one inserted ends up first
    if (arrange) for (const el of [...ctx].reverse()) { remember(el); arrange.insertBefore(el, arrange.firstChild); }
    for (const el of [panelFoot, actionbar].filter(Boolean)) {
      remember(el);
      el.classList.add("in-sheet");
      sheet.insertBefore(el, sheet.querySelector(".rail-section"));
    }
  } else {
    topbar.querySelectorAll(".mobile-made").forEach((s) => s.remove());
    // Restore EVERYTHING we ever moved, not a fixed list — a customized phone layout can have moved
    // tiles we never anticipated, and a tile left behind in #mobile-top is display:none on desktop
    // (i.e. it silently vanishes).
    for (const el of homes.keys()) { el.classList.remove("in-sheet"); goHome(el); }
  }
  composed = on;
}

export const isPhoneComposed = () => composed;
// Every element the phone composition has ever relocated (layout.js needs this to guarantee no tile
// is stranded inside a display:none container when the breakpoint is crossed).
export const movedByPhone = () => [...homes.keys()];
