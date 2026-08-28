// The phone form factor: the ≤620px breakpoint, and the band composition that goes with it.
//
// This lives apart from app.js so that layout.js can DRIVE it. Ordering matters and used to be
// wrong: the composition ran as an IIFE at app.js:379 while the layout engine booted at :1100, so
// on a phone layout.js snapshotted the already-composed DOM as "the authored layout" — losing the
// zoom tiles (they sit in #mobile-top, which was not a registered bar) and filing #act-duplicate
// under `arrange`. Persisting that would have corrupted the user's DESKTOP layout. layout.js now
// takes its authored snapshot first and calls composePhone() itself.
export const PHONE_MQ = "(max-width: 620px)";
// Two breakpoints, deliberately. PHONE_MQ is portrait-only: it decides whether the toolbars are
// recomposed into bands, and a phone in landscape (844px wide) is NOT a phone by that measure — it
// gets side rails instead. But the right dock is a slide-up SHEET on any touch device that isn't a
// desktop, in both orientations — and that's a wider net. Keying the tabs off PHONE_MQ left the sheet
// as a stacked scroller in landscape, where it's 340px tall and the stack hurts MORE, not less.
// Must stay in lockstep with the sheet's media query in style.css.
export const SHEET_MQ = "(max-width: 720px), (pointer: coarse) and (max-width: 1024px)";

// A phone held sideways: width to spare, no height. It is NOT "a phone" by PHONE_MQ (it's 844px wide)
// and it is not a desktop either — it's a third shell, and it needs its own saved-layout profile,
// because tiles live in different bars there. Must stay in lockstep with style.css's landscape block.
export const LAND_MQ = "(pointer: coarse) and (orientation: landscape) and (max-height: 500px)";

const mql = window.matchMedia(PHONE_MQ);
const landMql = window.matchMedia(LAND_MQ);
const sheetMql = window.matchMedia(SHEET_MQ);

export const isPhone = () => mql.matches;             // portrait phone specifically
export const isLandscape = () => landMql.matches;
export const isSheet = () => sheetMql.matches;
// The one question most callers actually mean: "is this a touch shell?" (either orientation).
export const shellMode = () => (landMql.matches ? "landscape" : mql.matches ? "phone" : "desktop");
export const isTouchShell = () => shellMode() !== "desktop";
export function onFormFactorChange(cb) {
  const fire = () => cb(shellMode());
  mql.addEventListener("change", fire);
  landMql.addEventListener("change", fire);
}

// Where each element lived before we first moved it, so it can be put back verbatim.
//
// LAZY on purpose. layout.js applies a saved arrangement BEFORE composing the phone, so a home
// recorded eagerly at module-eval would point at the AUTHORED slot — and the trip back to desktop
// would silently discard whatever the user had saved. Recording on first touch captures the real,
// post-layout parent.
const homes = new Map();
const remember = (el) => { if (el && !homes.has(el)) homes.set(el, { parent: el.parentNode, next: el.nextSibling }); };
// The remembered `next` sibling goes STALE, and it is not an edge case: the composition relocates
// tiles in GROUPS (every boolean leaves .actionbar for the contextual bar together), so by the time
// #act-scale goes home, the #act-rotate it remembered standing in front of has left too. A saved
// layout being re-applied reorders them as well. insertBefore then throws "the node before which the
// new node is to be inserted is not a child of this node" — which used to kill the whole
// form-factor handler MID-FLIGHT, so the apply() that restores the outgoing shell's arrangement
// never ran and every tile stayed in the bars of the shell we were leaving (stranded invisible in
// #mobile-top, with their separators left behind as naked rules). Widening a window past 620px did
// that; only a reload healed it.
//
// So: honour the position when the anchor still stands, and APPEND when it doesn't (insertBefore
// with a null ref appends). Order is not lost by the fallback — layout.js re-applies the saved
// arrangement immediately after composeShell returns, and that is the authority on order anyway.
const goHome = (el) => {
  const h = homes.get(el);
  if (!h || !h.parent) return;
  const ref = h.next && h.next.parentNode === h.parent ? h.next : null;
  h.parent.insertBefore(el, ref);
};

const q = (s) => document.querySelector(s);
const mkSep = () => { const s = document.createElement("span"); s.className = "tool-sep mobile-made"; s.setAttribute("aria-hidden", "true"); return s; };

let composed = "desktop";   // which shell is currently built: "desktop" | "phone" | "landscape"
// Set by app.js — the sheet's "Customize bars…" entry point. Kept as a seam so this module stays
// free of UI imports (it's imported by layout.js, and a cycle back through the picker would bite).
let onCustomize = null;
export function setCustomizeHandler(fn) { onCustomize = fn; }

// ---------------------------------------------------------------------------
// The Panels sheet is a TAB SURFACE, not a stack.
//
// It shipped as a stacked accordion — up to ten panels in a 480px sheet — so finding one meant
// scrolling the sheet and reading it meant scrolling inside it: two scrollers under one thumb, and
// whatever you wanted was below the fold. The auto-fold heuristic that used to live in docks.js was
// a mitigation, not a fix; a desktop can afford a column of panels because it HAS a column to spare.
// A phone has to pick one. So: a horizontally-scrolling strip of tabs, and the selected panel takes
// the entire sheet.
//
// The panes ARE the sheet's own children — nothing is rebuilt, cloned or re-implemented, so every
// id-wired handler still fires and every layout.js tileKey still resolves. A tab is only a view onto
// a child that was already there.
const TAB_ORDER = ["properties", "color", "layers", "symbols", "history", "view", "library", "processor", "jobs", "info"];
const TAB_NAMES = { view: "View" };

let sheeted = false;
let barEl = null, tabsEl = null, tabSig = "", userTab = null, activeTab = null, watcher = null;

// The reparented bar has no data-section — it's a bar, not a panel. Everything else in the sheet is
// a rail-section and names itself. .actionbar used to be reparented here too (an "actions" tab) —
// now that tools/actions are rails in both touch shells, it never enters the sheet at all.
const paneKey = (el) => (
  el.classList.contains("panel-foot") ? "view"
    : el.dataset.section || null
);
const paneLabel = (el, key) => TAB_NAMES[key] || el.querySelector(".sec-label")?.textContent.trim() || key;
// The tab bar, the resizers and the section separators aren't panes — none of them name themselves.
const panesOf = (sheet) => [...sheet.children].filter((el) => paneKey(el));

// Where you land when you haven't picked a tab yourself. With something selected, the sheet is
// almost always "what can I do with this" → Properties (it hosts the object actions);
// with nothing selected it's "where is my stuff" → Layers.
function defaultTab(keys) {
  const hasSel = document.querySelector("main.app")?.classList.contains("has-selection");
  const wish = hasSel ? ["properties"] : ["layers", "properties"];
  return wish.find((k) => keys.includes(k)) || keys[0] || null;
}

function activate(sheet, key) {
  const panes = panesOf(sheet);
  const target = panes.find((p) => paneKey(p) === key) || panes[0];
  if (!target) return;
  for (const p of panes) p.classList.toggle("sheet-active", p === target);
  // A tab IS the panel, so a collapsed one would open onto an empty sheet. Safe to force: only a
  // header click persists hv-sec-*, and docks.js ignores those clicks while the sheet is tabbed.
  // teardownTabs re-reads the saved fold state on the way back to a desktop rail.
  target.classList.remove("collapsed");
  target.scrollTop = 0;
  activeTab = paneKey(target);
  for (const b of tabsEl.querySelectorAll(".sheet-tab")) {
    const on = b.dataset.tabKey === activeTab;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
    if (on) b.scrollIntoView({ inline: "nearest", block: "nearest" });
  }
}

// Rebuild the strip from what is ACTUALLY in the sheet right now. Panels come and go under us —
// the cloud build has no server panels at all — and a tab pointing at nothing is worse than no tab.
//
// `reset` is the difference between opening the sheet and the sheet changing while you're reading
// it. On open we re-derive the default (the selection may have changed since you last looked). While
// open we hold whatever pane you're on — otherwise selecting a layer FROM the Layers tab would yank
// the sheet over to Properties, out from under your thumb.
export function refreshSheetTabs({ reset = false } = {}) {
  const sheet = q("#rightdock");
  if (!sheeted || !sheet || !tabsEl) return;
  const rank = (el) => { const i = TAB_ORDER.indexOf(paneKey(el)); return i < 0 ? TAB_ORDER.length : i; };
  const panes = panesOf(sheet).sort((a, b) => rank(a) - rank(b));
  const keys = panes.map(paneKey);

  const sig = keys.join(",");
  if (sig !== tabSig) {
    tabSig = sig;
    tabsEl.replaceChildren();
    for (const p of panes) {
      const key = paneKey(p);
      const b = document.createElement("button");
      b.type = "button";
      b.className = "sheet-tab";
      b.dataset.tabKey = key;
      b.setAttribute("role", "tab");
      b.textContent = paneLabel(p, key);
      b.addEventListener("click", () => { userTab = key; activate(sheet, key); });
      tabsEl.appendChild(b);
    }
  }
  const keep = !reset && keys.includes(activeTab) ? activeTab : null;
  activate(sheet, keep || (userTab && keys.includes(userTab) ? userTab : defaultTab(keys)));
}

// Open the sheet ON a given panel — the phone answer to revealPanel()'s "un-collapse and scroll to".
// Returns false if that panel isn't in the sheet, so the caller can fall back to the desktop path.
export function showSheetTab(key) {
  const sheet = q("#rightdock");
  if (!sheeted || !sheet || !tabsEl) return false;
  if (!panesOf(sheet).map(paneKey).includes(key)) return false;
  userTab = key;
  activate(sheet, key);
  return true;
}

function buildTabs(sheet) {
  // The bar is two things: a strip that SCROLLS, and a gear that does NOT. Customize is an action,
  // not a tab, and it's the only way to customize on a phone (HTML5 drag never fires from touch) — so
  // it must never scroll out of reach. Keeping it outside the scroller is the only way to say that;
  // sticky-inside just parks it on top of the tabs it's occluding.
  barEl = document.createElement("div");
  barEl.className = "sheet-tabbar";       // NOT .mobile-made — composePhone's cleanup must not eat it
  const bar = barEl;
  tabsEl = document.createElement("nav");
  tabsEl.className = "sheet-tabs";
  tabsEl.setAttribute("role", "tablist");
  tabsEl.setAttribute("aria-label", "Panels");
  const gear = document.createElement("button");
  gear.type = "button";
  gear.className = "sheet-customize";
  gear.title = "Customize bars…";
  gear.setAttribute("aria-label", "Customize bars");
  const mark = document.createElement("img");
  mark.className = "brand-logo";
  mark.src = "/assets/hv_logo.svg";
  mark.alt = "";
  mark.setAttribute("aria-hidden", "true");
  gear.appendChild(mark);
  gear.addEventListener("click", () => { if (onCustomize) onCustomize(); });
  bar.append(tabsEl, gear);
  sheet.insertBefore(bar, sheet.firstChild);
  sheet.classList.add("sheet-tabbed");
  // The dock's vertical splitter has almost certainly already written stack heights onto these
  // (inline `flex: 0 0 180px`), and an inline style beats the sheet's stylesheet — a pane would open
  // clipped to 180px of a 540px sheet. It won't write more (docks.js skips a tabbed sheet); clear
  // what's there.
  sheet.querySelectorAll(":scope > .rail-section").forEach((s) => { s.style.flex = ""; });
  // Watch the sheet's own children rather than trying to find every code path that adds or removes a
  // panel (docks' shelve/float/close, the cloud build's panel purge).
  watcher = new MutationObserver(() => refreshSheetTabs());
  watcher.observe(sheet, { childList: true });
}

function teardownTabs(sheet) {
  watcher?.disconnect();
  watcher = null;
  barEl?.remove();
  barEl = tabsEl = null;
  tabSig = "";
  userTab = activeTab = null;
  sheet.classList.remove("sheet-tabbed");
  sheet.querySelectorAll(".sheet-active").forEach((p) => p.classList.remove("sheet-active"));
  // The strip force-expands whatever it shows; the desktop rail honours the saved fold state.
  window.__docks?.syncCollapse?.();
  window.__docks?.relayout?.();   // and it needs its stack heights back
}

// The sheet exists on any touch device that isn't a desktop — BOTH orientations — so it is tabbed on
// its own breakpoint, not the phone-bands one. Driven by layout.js at boot (the panes have to be in
// their final places first) and by the media query after that.
export function composeSheet(on) {
  const sheet = q("#rightdock");
  if (!sheet || on === sheeted) return;
  sheeted = on;
  if (on) buildTabs(sheet); else teardownTabs(sheet);
}
sheetMql.addEventListener("change", (e) => composeSheet(e.matches));

// Phone portrait (≤620px). MOVES existing elements rather than rebuilding them, so every id-wired
// handler and every layout.js tileKey survives.
//
// Buttons SURROUND the canvas here too, same as landscape below and same as desktop: tools down
// the LEFT and actions down the RIGHT (both real vertical rails now, see style.css), the
// contextual bar across the BOTTOM, right above the status bar — undo/redo/zoom lead in their
// own always-visible strip at the TOP instead. Delete lived in .stage-toolbar, which the phone
// stylesheet used to display:none outright; it's reachable now the same way the rest of the
// contextual bar is. The rest (rulers/guides, library, etc. — set-once or occasional, not
// per-stroke) stays one tap away in the Panels sheet.
//
// Portrait and landscape reach that SAME "surround the canvas" shape by DIFFERENT means, because
// their resource budgets are opposite. Landscape has width to spare and almost no height, so it
// can't afford a whole extra row for the contextual bar — it borrows the top bar's own row instead
// (`on-topbar`, below). Portrait has height to spare, so the contextual bar gets a genuine row of
// its own — but NOT stacked directly under the quick bar at the top (that read as two competing
// toolbars fighting over the same strip the instant something's selected); it anchors at the
// bottom instead, thumb-reachable, right above .status-bar, which otherwise sits there empty.
// Same tiles, same handlers, same oracle; only which wall — and which trick gets it there — differs.
export function composeShell(m) {
  const sheet = q("#rightdock"), topbar = q("#mobile-top");
  if (!sheet || !topbar || m === composed) return;
  // .actionbar itself is never reparented any more (see intoSheet below) — it stays a persistent
  // rail in both touch shells, so this function has no need to look it up.
  const panelFoot = q(".stage-wrap > .panel-foot") || q("#rightdock > .panel-foot") || q("#mobile-top > .panel-foot");
  const arrange = q(".stage-toolbar");
  const on = m !== "desktop";

  // Whatever we were, go back to nothing first: the two touch shells move DIFFERENT things, and
  // composing one on top of the other would strand a tile in a container the new shell hides.
  if (composed && composed !== "desktop") undoCompose(topbar, sheet);

  if (on) {
    // The header row held a logo, a ≣ and (in the cloud build) nothing else — 50px of screen to say
    // the app's own name back to someone already using it. So the LOGO BECOMES THE BUTTON: it moves
    // inside the File trigger, the ≣ glyph hides, and the whole header can go. The mark you already
    // recognise is now the way in, and it costs a tile instead of a row.
    //
    // These ride at the head of the quick bar and are NOT tiles (no .tool-button), so layout.js's
    // movable() skips them — they can't be captured into a saved arrangement, hidden by the picker,
    // or shuffled by applyBar (which only ever appends tiles after them).
    const chrome = document.createElement("div");
    chrome.className = "mobile-chrome mobile-made";
    const trigger = q('.menu[data-menu="file"] .menu-trigger');
    const logo = q(".brand-logo");
    if (trigger && logo) { remember(logo); trigger.classList.add("has-logo"); trigger.insertBefore(logo, trigger.firstChild); }
    for (const el of [q('.menu[data-menu="file"]'), q(".view-swap"), q("#panel-shelf")]) {
      if (el) { remember(el); chrome.appendChild(el); }   // shelf comes along: it's the only way back to a parked panel
    }
    topbar.appendChild(chrome);

    // Quick bar, in reach order. Rulers/smart-guides deliberately stay behind in the sheet — they
    // are set-once toggles, not per-stroke controls, and the bar has to fit 390px.
    const quick = [
      q("#undo-button"), q("#redo-button"), null,
      q('[data-action="zoom-out"]'), q('[data-action="fit"]'),
      q('[data-action="actual"]'), q('[data-action="zoom-in"]'), null,
      q("#vp-selectall"),
    ];
    for (const el of quick) { remember(el); topbar.appendChild(el || mkSep()); }
    // Everything you'd want to do TO a selection goes on the contextual bar, so the booleans are one
    // tap away instead of buried in the sheet. Cut/copy/paste deliberately stay behind: paste is
    // valid with NOTHING selected, so it doesn't belong on a selection-only bar.
    //
    // That's up to 18 tiles in a 390px strip — which is exactly why the adaptive engine
    // (src/ui/adaptive.js) is a PREREQUISITE for this, not a garnish. It hides whatever the current
    // selection can't use and ranks the rest, so the first six are always the right six.
    const ctx = [
      // Scale/Rotate lead: they're the two most basic things you can do to an object, they are the
      // ONLY door to free transform on a phone (no Ctrl+T), and the same tile is the way back out
      // (no Esc). Behind a sheet tab they may as well not exist.
      q("#act-scale"), q("#act-rotate"),
      q("#act-duplicate"), q("#layer-delete"),
      q("#act-union"), q("#act-subtract"), q("#act-intersect"), q("#act-clip"),
      q("#act-rotate-cw"), q("#act-rotate-ccw"), q("#act-flip-h"), q("#act-flip-v"),
    ].filter(Boolean);
    // reverse: each insert goes to the head, so the last one inserted ends up first
    if (arrange) for (const el of [...ctx].reverse()) { remember(el); arrange.insertBefore(el, arrange.firstChild); }

    // Only the zoom-strip leftovers (rulers/guides — set-once toggles, not per-stroke controls) go
    // into the Panels sheet as a tab, in EITHER shell. .actionbar stays OUT of the sheet in both:
    // once the ctx merge below runs, all that's left in it is cut/copy/paste — small enough to live
    // as its own persistent rail (right-hand column), the same way landscape already treats it.
    const intoSheet = [panelFoot];
    for (const el of intoSheet.filter(Boolean)) {
      remember(el);
      el.classList.add("in-sheet");
      sheet.insertBefore(el, sheet.querySelector(".rail-section"));
    }
    if (m === "landscape" && arrange) { remember(arrange); arrange.classList.add("on-topbar"); topbar.appendChild(arrange); }
    // Portrait: the merged contextual bar needs a genuine FULL-WIDTH row of its own — nested inside
    // .stage-wrap (its natural DOM position), it's confined to the middle rail column, which starves
    // it of enough width to keep even 7 capped tiles reachable without scrolling. It can't just join
    // mobilebar's own row the way landscape's does either: mobilebar's quick items already scroll
    // sideways in ONE nowrap row, and forcing THAT row to wrap would break them. So it gets a fresh
    // wrapper row instead — anchored at the BOTTOM of the screen, directly above .status-bar (a
    // sibling of .editor-grid, not inside it), not stacked under the quick bar at the top: a lone
    // top row plus this one read as two competing toolbars fighting for the same 44px strip the
    // instant something's selected, when the thumb-reachable bottom edge — right where the status
    // bar already sits — was sitting empty the whole time (see style.css's grid-row assignments).
    if (m === "phone" && arrange) {
      const ctxRow = document.createElement("div");
      ctxRow.className = "phone-ctxrow mobile-made";
      const statusBar = q(".status-bar");
      (statusBar ? statusBar.parentNode : topbar.parentNode).insertBefore(ctxRow, statusBar || null);
      remember(arrange);
      arrange.classList.add("on-topbar");
      ctxRow.appendChild(arrange);
    }
    // (The sheet's tab strip is composeSheet's job, not this one — it spans both orientations.)
  }
  composed = m;
}

// Put every last thing back where it was authored. Not a fixed list: a customized layout can have
// moved tiles we never anticipated, and a tile stranded in #mobile-top (display:none on desktop)
// silently VANISHES. .in-sheet/.sheet-active/.on-topbar go too — a bar still wearing a pane class
// back out on the canvas would be display:none'd by that pane's own rule.
function undoCompose(topbar, sheet) {
  q('.menu[data-menu="file"] .menu-trigger')?.classList.remove("has-logo");   // the ≣ comes back
  // Order matters: the homes loop re-parents children OUT of .mobile-chrome/.phone-ctxrow, so empty
  // the wrappers first and let goHome() put each child back itself. One query from a common
  // ancestor, not two separate ones off topbar/sheet — a wrapper can live anywhere in the grid now
  // (phone's .phone-ctxrow sits by .status-bar now — a sibling of .editor-grid ITSELF, one level
  // above topbar, not just a sibling of topbar within it — so the search has to start from .app.editor
  // or it would miss the wrapper and leak it on every phone->desktop crossing).
  const grid = topbar.closest(".app.editor") || topbar.closest(".editor-grid") || topbar.parentNode;
  grid.querySelectorAll(".mobile-made").forEach((s) => s.remove());
  for (const el of homes.keys()) { el.classList.remove("in-sheet", "sheet-active", "on-topbar"); goHome(el); }
}

export const isPhoneComposed = () => composed !== "desktop";
// Every element the phone composition has ever relocated (layout.js needs this to guarantee no tile
// is stranded inside a display:none container when the breakpoint is crossed).
export const movedByPhone = () => [...homes.keys()];
