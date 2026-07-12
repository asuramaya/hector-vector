// Customizable picture-frame layout: drag toolbar tiles between frame bars
// (toolstrip, action bar, viewport controls, panel headers); Default / Save /
// Reset / named profiles. Auto-saves the live arrangement; restores at boot.
//
// Extracted from app.js (#25). This is a pure shell-UI module: it owns no app
// state of its own beyond the layout it manages, and receives everything it
// touches in the host shell (DOM root, the editor, status line, prompt + menu
// helpers) through the factory's `deps` object. The factory returns the control
// object the header Layout dropdown and the E2E suite drive; the caller is
// responsible for publishing it (e.g. on `window.__layout`).
import { isPhone, isSheet, shellMode, onFormFactorChange, composeShell, composeSheet } from "./formfactor.js";
import { createPointerDrag } from "./pointer-drag.js";
import { suspendAdaptive } from "./adaptive.js";

export function createLayoutCustomize({ appEl, editor, setStatus, floatingInput, showRichContextMenu, MENU_ITEMS }) {
  const LAYOUT_KEY = "hector-vector:layout";
  const SEP = "|";
  // each frame bar is a drop zone (swatches now live on the canvas, not the toolstrip).
  const BARS = [
    { name: "tools",       sel: ".toolstrip",         tail: null },
    { name: "arrange",     sel: ".stage-toolbar",     tail: null },
    { name: "actions",     sel: ".actionbar",         tail: null },
    { name: "viewport",    sel: ".viewport-controls", tail: null },
    { name: "quick",       sel: "#mobile-top",        tail: null },   // phone-only; empty (and display:none) on desktop
    { name: "hdr-history", sel: ".rail-section.history .panel-actions", tail: null },
    { name: "hdr-layers",  sel: ".rail-section.layers .panel-actions",  tail: null },
  ];
  const barOf = (b) => b.el || document.querySelector(b.sel);   // bars are sel- OR element-based (panel headers)
  const isTile = (el) => !!(el && el.classList && el.classList.contains("tool-button") && !el.classList.contains("panel-x"));   // the × isn't a movable tile
  const isSep = (el) => !!(el && el.classList && (el.classList.contains("tool-sep") || el.classList.contains("tool-vsep") || el.classList.contains("vp-sep")));
  const tileKey = (b) => b.id ? "#" + b.id : b.dataset.tool ? "tool:" + b.dataset.tool : (b.dataset.vp && b.dataset.action) ? "vp:" + b.dataset.action : "t:" + (b.textContent || "").trim();
  const slotKey = (el) => isSep(el) ? SEP : tileKey(el);
  const tailEl = (cont, bar) => bar.tail ? cont.querySelector(bar.tail) : null;
  // Which way does this bar run? ASK the layout, don't infer it from the class name. The old test
  // was `classList.contains("toolstrip") || …("actionbar")` — true enough on a desktop, where those
  // are vertical rails, but on a PHONE the toolstrip is a horizontal row. The hit-test would then
  // compare the wrong axis and phone reordering would be gibberish. On desktop this is provably the
  // same answer: toolstrip/actionbar are column, every other bar is a row.
  const axisY = (cont) => getComputedStyle(cont).flexDirection.startsWith("column");
  // movable children of a bar (tiles + separators that sit before the pinned tail)
  function movable(bar) {
    const cont = barOf(bar); if (!cont) return [];
    const tail = tailEl(cont, bar), out = [];
    for (const ch of cont.children) { if (tail && ch === tail) break; if (isTile(ch) || isSep(ch)) out.push(ch); }
    return out;
  }
  // Tiles the user has switched OFF. Kept as a reserved key inside the same blob rather than a
  // {v:2, bars, hidden} wrapper, because a bar name can never contain "#": a legacy blob simply has
  // no "#hidden" (-> nothing hidden, zero migration code), and an OLDER build reading a new blob
  // treats "#hidden" as an unknown bar and ignores it — order preserved, tiles visible. That's the
  // right way to degrade.
  const HIDDEN_KEY = "#hidden";
  const hidden = new Set();
  // Tiles the user has ANCHORED. The adaptive engine (src/ui/adaptive.js) reorders and hides action
  // tiles by what's valid for the current selection; a pinned tile is exempt — it always shows, and
  // it never gets reordered. This is the answer to "don't move my buttons around". Same reserved-key
  // trick as #hidden, and it degrades the same way.
  const PINNED_KEY = "#pinned";
  const pinnedSet = new Set();
  const capture = () => {
    const m = {};
    for (const b of BARS) m[b.name] = movable(b).map(slotKey);
    m[HIDDEN_KEY] = [...hidden].sort();
    m[PINNED_KEY] = [...pinnedSet].sort();
    return m;
  };
  // Hiding is a CLASS, never a removal: the node stays in the DOM, so collectTiles() still finds it,
  // its ORDER is still captured (order and visibility stay orthogonal), and every id-wired handler
  // survives. It also means hiding a tool only trims the BAR — the keyboard shortcut keeps working.
  function applyHidden() {
    for (const [key, el] of collectTiles()) {
      el.classList.toggle("layout-hidden", hidden.has(key));
      el.classList.toggle("layout-pinned", pinnedSet.has(key));
    }
    refreshOverflow();
  }
  // The bars' overflow-fade hint is driven by a MutationObserver watching childList only (app.js),
  // so a class-only change would never retrigger it and the "there's more, scroll" fade would lie.
  function refreshOverflow() {
    requestAnimationFrame(() => {
      for (const b of BARS) {
        const c = barOf(b); if (!c) continue;
        c.classList.toggle("is-overflowing-x", c.scrollWidth > c.clientWidth + 1);
      }
    });
  }
  // A fresh divider of the right kind for a bar: a thin rule between vertical-stack
  // bars (toolstrip/actionbar), a vertical rule between horizontal bars; viewport
  // keeps its own .vp-sep style.
  const sepClassFor = (bar) => bar.name === "viewport" ? "vp-sep" : (axisY(barOf(bar)) ? "tool-sep" : "tool-vsep");
  function makeSep(bar) { const s = document.createElement("span"); s.className = sepClassFor(bar); s.setAttribute("aria-hidden", "true"); return s; }

  // Ordering is load-bearing, so the engine owns it end to end:
  //   authored snapshot  ->  compose the phone bands  ->  default snapshot  ->  apply saved layout
  // The phone composition used to run far earlier (an IIFE in app.js), which meant DEFAULT below
  // snapshotted the COMPOSED phone DOM and called it "authored" — losing the zoom tiles entirely
  // (they move into #mobile-top) and filing #act-duplicate under `arrange`. Persist that and the
  // user's DESKTOP layout is corrupted.
  const AUTHORED = capture();   // pristine, pre-composition DOM order
  composeShell(shellMode());
  const DEFAULT = capture();    // the baseline for Reset in the CURRENT form factor
  // ...and only now turn the right dock into a tabbed sheet: its panes are the bars composePhone just
  // moved in, so the strip has to be built after them. (It adds no tiles and registers no bar, so it
  // cannot pollute either capture above — but it costs nothing to sequence it honestly.)
  composeSheet(isSheet());

  // every tile by key, wherever it currently sits (across all registered bars)
  function collectTiles() {
    const m = new Map();
    for (const b of BARS) { const c = barOf(b); if (c) for (const t of c.querySelectorAll(".tool-button")) if (isTile(t)) m.set(tileKey(t), t); }
    return m;
  }
  function applyBar(bar, list, tiles) {
    const cont = barOf(bar); if (!cont) return;
    tiles = tiles || collectTiles();
    const tail = tailEl(cont, bar);
    const pool = [...cont.children].filter(isSep);   // reuse existing separators, create more on demand
    let pi = 0;
    for (const key of (list || [])) {
      const el = key === SEP ? (pool[pi++] || makeSep(bar)) : tiles.get(key);
      if (el) cont.insertBefore(el, tail);   // insertBefore(el, null) appends
    }
    for (; pi < pool.length; pi++) pool[pi].remove();   // drop separators the layout no longer wants
  }
  function apply(layout) {
    if (!layout) return;
    const tiles = collectTiles();
    for (const b of BARS) applyBar(b, layout[b.name], tiles);
    // tiles a saved layout doesn't mention (e.g. added in a newer build) keep their place
    hidden.clear();
    for (const k of (layout[HIDDEN_KEY] || [])) hidden.add(k);
    pinnedSet.clear();
    for (const k of (layout[PINNED_KEY] || [])) pinnedSet.add(k);
    applyHidden();
  }

  // ---- per-form-factor storage ----------------------------------------------------------------
  // A phone and a desktop cannot share one arrangement: the phone MOVES tiles between bars to build
  // its bands, so a capture() taken on a phone describes a completely different DOM. They get their
  // own keys, and keyFor() is the only place a key is ever constructed. Hard invariant: a phone
  // session can never write the desktop key. (Guarded by an e2e check, not just this comment.)
  const PROFILES_KEY = "hector-vector:layout-profiles";
  // THREE shells, three saved arrangements. A phone held sideways used to answer "desktop" here — so
  // the landscape bars (which move tiles into #mobile-top, a container that is display:none on a real
  // desktop) would have been persisted into the DESKTOP key, and those tiles would simply vanish the
  // next time the user opened the app on their laptop. Each shell owns its own blob.
  const mode = () => shellMode();
  const keyFor = (m) => (m === "desktop" ? LAYOUT_KEY : `${LAYOUT_KEY}:${m}`);
  const loadSaved = (m = mode()) => { try { return JSON.parse(localStorage.getItem(keyFor(m)) || "null"); } catch { return null; } };
  // The mode is an ARGUMENT, not something persist() re-reads. When the breakpoint fires, the media
  // query has ALREADY flipped, so a persist() that asked mode() for itself would write the outgoing
  // (phone) arrangement straight into the INCOMING (desktop) key — corrupting the desktop layout and
  // then faithfully restoring the phone bands on top of it. Which is exactly what it did.
  const persist = (m = mode()) => { try { localStorage.setItem(keyFor(m), JSON.stringify(capture())); } catch {} };   // auto-save
  const loadProfiles = () => { try { return JSON.parse(localStorage.getItem(PROFILES_KEY) || "{}") || {}; } catch { return {}; } };
  const saveProfiles = (p) => { try { localStorage.setItem(PROFILES_KEY, JSON.stringify(p)); } catch {} };
  // A profile carries a half per form factor. Legacy profiles are a bare bar-map -> read as desktop.
  const profileHalf = (p, m = mode()) => (p && typeof p === "object" && ("desktop" in p || "phone" in p || "landscape" in p)) ? p[m] : (m === "desktop" ? p : null);

  // Reset baselines, per form factor. DEFAULTS.desktop is the AUTHORED order; DEFAULTS.phone is the
  // composed one, filled in the first time we're on a phone.
  const DEFAULTS = { desktop: AUTHORED, phone: null, landscape: null };
  DEFAULTS[mode()] = DEFAULT;

  // One-time re-default for the phone. composePhone() now puts the booleans + transforms on the
  // contextual bar, but a phone layout saved BEFORE that lists them under `actions`, and apply()
  // would faithfully drag them straight back into the sheet — so an existing phone user would get
  // none of it. Drop the saved blob ONLY if it shows no sign of having been customized (nothing
  // hidden, nothing anchored). If they HAVE customized, their arrangement is their business: it is
  // kept, and Reset (or the picker's move-to) brings the new bar over whenever they want it.
  if (isPhone()) {
    const prev = loadSaved("phone");
    const untouched = prev && !(prev[HIDDEN_KEY] || []).length && !(prev[PINNED_KEY] || []).length;
    if (untouched && !(prev.arrange || []).includes("#act-union")) {
      try { localStorage.removeItem(keyFor("phone")); } catch {}
    }
  }
  apply(loadSaved());   // restore the auto-saved arrangement for THIS form factor

  // ---- crossing the breakpoint -----------------------------------------------------------------
  // renormalize() is the load-bearing step and the reason this isn't just "recompose". A phone
  // layout can have moved a tool INTO #mobile-top; that container is display:none above 620px, so
  // without putting every tile back to the outgoing mode's baseline first, the tile is stranded
  // inside a hidden container on desktop and simply VANISHES. composePhone's homes map can't save
  // it — the tile was never one of the elements composePhone itself moved.
  function renormalize(outgoing) {
    apply(DEFAULTS[outgoing] || AUTHORED);
    hidden.clear();
    pinnedSet.clear();
    applyHidden();   // clears .layout-hidden AND .layout-pinned — both are per form factor
  }
  // Track the shell we are actually IN, because mode() has already flipped by the time the media
  // query fires — asking it for the outgoing mode would write the incoming shell's arrangement into
  // the outgoing shell's key. (Two shells made that a boolean flip; three make it a variable.)
  let curMode = mode();
  onFormFactorChange((now) => {
    const outgoing = curMode;
    curMode = now;
    persist(outgoing);             // save the OUTGOING shell explicitly
    if (editing) setEditing(false);
    renormalize(outgoing);         // <- put every tile back before the bars are re-composed
    composeShell(now);
    if (!DEFAULTS[now]) DEFAULTS[now] = capture();
    apply(loadSaved(now));
    BARS.forEach((b) => wireBar(b, editing));
  });

  // ---- drag tiles between bars (only while customizing) ----
  let editing = false, dragEl = null;
  const layoutMenu = document.querySelector('.menu[data-menu="layout"]');
  const layoutTrigger = layoutMenu && layoutMenu.querySelector(".menu-trigger");
  const barFor = (cont) => BARS.find((b) => barOf(b) === cont);
  function insertionRef(cont, x, y, bar) {
    const tail = tailEl(cont, bar), useY = axisY(cont);
    for (const ch of cont.children) {
      if (tail && ch === tail) break;
      if ((!isTile(ch) && !isSep(ch)) || ch === dragEl) continue;
      const r = ch.getBoundingClientRect();
      if ((useY ? y : x) < (useY ? r.top + r.height / 2 : r.left + r.width / 2)) return ch;
    }
    return tail;   // before the pinned tail, or null => append
  }
  const HDR_TILE_CAP = 8;   // headers scroll on overflow now (tile-scroll), so allow more tiles

  // Which bar is under the pointer. Deliberately a RECT test rather than elementFromPoint: the phone
  // has a scrim and a bottom sheet floating over the frame, and a stray hit through one of those
  // could otherwise steal a tile into a bar you can't even see.
  //
  // On a PHONE, drag is intra-bar reorder ONLY. Cross-bar dragging there is a hostile gesture — the
  // bars sit at opposite ends of a 390px screen and the action bar is inside the sheet, which covers
  // the tool strip when it's open. Cross-bar moves are the picker's job (see layout-picker.js). A
  // finger also strays off a 44px-tall bar constantly, so falling back to the source container keeps
  // the reorder alive instead of stalling.
  function containerAt(x, y, el) {
    const src = el.parentElement;
    if (isPhone()) {
      const bar = barFor(src);
      if (!bar) return null;
      return src;   // stay in the bar you started in, wherever the finger wanders
    }
    for (const b of BARS) {
      const c = barOf(b); if (!c) continue;
      const r = c.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return c;
    }
    return null;   // outside every bar: don't move it (native dragover behaved the same way)
  }

  const drag = createPointerDrag({
    containerAt,
    onStart: (el) => { dragEl = el; },
    // Identical to what the old dragover handler computed — the hit-test and the live reflow below
    // are untouched; only the event source changed.
    onMove: (el, cont, x, y) => {
      const bar = barFor(cont);
      // Cap incoming tiles on panel headers (reordering within a full header is still fine).
      if (bar && bar.name.startsWith("hdr-") && el.parentElement !== cont
          && movable(bar).filter(isTile).length >= HDR_TILE_CAP) { cont.classList.add("no-drop"); return; }
      cont.classList.remove("no-drop");
      const ref = insertionRef(cont, x, y, bar);
      if (ref !== el) cont.insertBefore(el, ref);   // live reflow while dragging
    },
    onDrop: () => {
      document.querySelectorAll(".no-drop").forEach((c) => c.classList.remove("no-drop"));
      dragEl = null;
      persist();   // the DOM already reflects the move → auto-save it
    },
    onCancel: () => {   // Escape: pointer-drag has no native "revert", so we restore and don't persist
      document.querySelectorAll(".no-drop").forEach((c) => c.classList.remove("no-drop"));
      dragEl = null;
    },
    // A tap (no travel) on a tile while customizing toggles it off/on. Hidden tiles stay visible
    // here, ghosted, precisely so they can be tapped back on.
    onTap: (el) => {
      dragEl = null;
      if (!isTile(el)) return;
      const key = tileKey(el);
      const nowHidden = !hidden.has(key);
      if (!setHidden(key, nowHidden)) setStatus("That one's always on.", 1500);
      else setStatus(nowHidden ? "Hidden — tap again to bring it back." : "Shown.", 1500);
    },
  });

  const blockClick = (e) => { e.preventDefault(); e.stopPropagation(); };
  // Both tiles AND dividers are movable while customizing; dividers can also be
  // added/removed via the bar's right-click menu.
  function frameMovables() { const out = []; for (const b of BARS) for (const m of movable(b)) out.push(m); return out; }
  function wireMovable(el, on) {
    if (on) {
      if (isTile(el)) { el.disabled = false; el.addEventListener("click", blockClick, true); }   // disabled buttons must still be movable
      drag.arm(el);
    } else {
      if (isTile(el)) el.removeEventListener("click", blockClick, true);
      drag.disarm(el);
    }
  }
  const sepUnder = (t) => isSep(t) ? t : (t && t.closest ? t.closest(".tool-sep, .tool-vsep, .vp-sep") : null);
  // Right-click any frame bar → the Layout menu (this replaces the old header "Layout ▾"
  // button). It's always available so customization is discoverable from the frame itself;
  // while customizing it also offers add/remove-divider at the click point.
  const onBarContext = (e) => {
    if (e.target.closest && e.target.closest("input, select, textarea, .panel-x, .menu")) return;   // leave real controls their native menu
    e.preventDefault(); e.stopPropagation();
    const cont = e.currentTarget, bar = barFor(cont), onSep = sepUnder(e.target);
    const cx = e.clientX, cy = e.clientY;
    const build = () => {
      const items = MENU_ITEMS.layout();
      if (editing) {
        items.push({ type: "sep" });
        items.push({ label: "Add divider here", onClick: () => {
          const ref = insertionRef(cont, cx, cy, bar);
          const s = makeSep(bar); cont.insertBefore(s, ref === dragEl ? null : ref); wireMovable(s, true); persist();
        } });
        if (onSep) items.push({ label: "Remove divider", onClick: () => { wireMovable(onSep, false); onSep.remove(); persist(); } });
      }
      return items;
    };
    showRichContextMenu(cx, cy, build);
  };
  // The Layout right-click lives on the bar permanently (independent of customize mode).
  function wireBarContext(bar) {
    const cont = barOf(bar); if (!cont || cont._layoutCtxWired) return;
    cont._layoutCtxWired = true; cont.addEventListener("contextmenu", onBarContext);
  }

  // No dragover/drop listeners any more: the pointer-drag helper hit-tests the bars itself (see
  // containerAt), which is what lets a finger drag work at all — touch never fires HTML5 drag events.
  function wireBar(bar, on) {
    const cont = barOf(bar); if (!cont) return;
    for (const m of movable(bar)) wireMovable(m, on);
    if (!on) cont.classList.remove("no-drop");
  }
  // Register a panel header's action area as a customize-layout bar (drop receiver). The
  // panel headers are built dynamically (after this module), so they opt in on creation.
  function registerBar(name, el) {
    if (!el || BARS.some((b) => b.name === name)) return;
    const bar = { name, el, tail: el.querySelector(".panel-x") ? ".panel-x" : null };   // drops land before the × (Dock-to-rail) button
    BARS.push(bar);
    // authored default (for Reset) — record it in EVERY form factor's baseline, so a panel that
    // registers late is resettable whichever mode we happen to be booting in
    for (const d of Object.values(DEFAULTS)) if (d && !(name in d)) d[name] = movable(bar).map(slotKey);
    const saved = loadSaved();
    if (saved && saved[name]) applyBar(bar, saved[name]);   // restore this bar's saved arrangement
    if (editing) wireBar(bar, true);
    wireBarContext(bar);   // Layout right-click is permanent, regardless of customize mode
    el.classList.add("layout-bar");   // CSS hook for the customize drop outline
  }
  BARS.forEach(wireBarContext);   // arm the Layout right-click on the static frame bars at boot
  function setEditing(on) {
    editing = on;
    // Suspend the adaptive engine while customizing. insertionRef() walks DOM order and compares
    // rects; with style.order set, visual order and DOM order diverge and the drag hit-test becomes
    // gibberish. It also means a tile the engine hid can always be tapped back on.
    suspendAdaptive(on);
    appEl.classList.toggle("customizing", on);
    if (layoutTrigger) layoutTrigger.classList.toggle("active", on);
    BARS.forEach((b) => wireBar(b, on));
    if (!on && editor.onInspect) editor.onInspect();   // restore the correct disabled states (onInspect runs refreshActionButtons)
    setStatus(on ? "Customize layout: drag buttons between bars (incl. panel headers) — changes save automatically." : "Ready.", on ? 6000 : 1500);
  }
  // ---- active-profile state (the source of truth for "which profile is selected") ----
  // null = the unnamed working layout ("Default"). The live arrangement can DIVERGE from
  // its baseline (a profile snapshot, or the authored DEFAULT) — that's the "edited" state.
  const ACTIVE_KEY = "hector-vector:layout-active";
  let activeProfile = null;
  try { activeProfile = localStorage.getItem(ACTIVE_KEY) || null; } catch {}
  if (activeProfile && !(activeProfile in loadProfiles())) activeProfile = null;   // pruned/renamed away
  const setActive = (name) => { activeProfile = name || null; try { activeProfile ? localStorage.setItem(ACTIVE_KEY, activeProfile) : localStorage.removeItem(ACTIVE_KEY); } catch {} };
  // Dirty = the live arrangement diverges from its baseline. Compare only the bars the
  // baseline actually records, so a profile saved before a newer panel existed doesn't
  // read as "edited" the instant it's applied (its missing bars simply aren't compared).
  const sameAs = (base) => { if (!base) return false; const now = capture(); return Object.keys(base).every((k) => JSON.stringify(base[k]) === JSON.stringify(now[k])); };
  const baseline = () => (activeProfile ? profileHalf(loadProfiles()[activeProfile]) : DEFAULTS[mode()]);
  const isDirty = () => !sameAs(baseline());

  function reset() { try { localStorage.removeItem(keyFor(mode())); } catch {} apply(DEFAULTS[mode()] || AUTHORED); setActive(null); setStatus("Layout reset to default.", 1500); }
  function applyProfile(name) {
    const half = profileHalf(loadProfiles()[name]);
    if (!half) { setActive(name); setStatus(`"${name}" has no ${mode()} layout saved yet.`, 2200); return; }
    apply(half); persist(); setActive(name); setStatus(`Layout: ${name}.`, 1500);
  }
  // Save/update only THIS form factor's half, so a phone save can never clobber the desktop half
  // (and vice versa). A profile is one thing to the user; it just happens to carry two halves.
  const withHalf = (prev, snap) => {
    const cur = (prev && typeof prev === "object" && ("desktop" in prev || "phone" in prev)) ? prev : { desktop: prev || null, phone: null };
    return { ...cur, [mode()]: snap };
  };
  function saveProfile(name) { const nm = (name || "").trim(); if (!nm) return false; const p = loadProfiles(); p[nm] = withHalf(p[nm], capture()); saveProfiles(p); setActive(nm); return true; }
  function updateActive() { if (!activeProfile) return false; const p = loadProfiles(); if (!(activeProfile in p)) return false; p[activeProfile] = withHalf(p[activeProfile], capture()); saveProfiles(p); setStatus(`Updated profile "${activeProfile}".`, 1600); return true; }
  function deleteProfile(name) { const p = loadProfiles(); if (!(name in p)) return; delete p[name]; saveProfiles(p); if (activeProfile === name) setActive(null); }
  function renameProfile(oldName, newName) { const nm = (newName || "").trim(); if (!nm || nm === oldName) return false; const p = loadProfiles(); if (!(oldName in p) || nm in p) return false; p[nm] = p[oldName]; delete p[oldName]; saveProfiles(p); if (activeProfile === oldName) setActive(nm); return true; }

  // ---- show / hide + programmatic moves (the picker's backend, and the E2E surface) ----
  // Select can NEVER be hidden: switch off every tool and there'd be no way to point at anything.
  // Reset stays reachable from Settings regardless, but stranding the user isn't worth allowing.
  // NB "always on" is a different idea from PINNED below — that one means "the adaptive engine must
  // not touch this tile". Conflating the two would be a mess, so they get different names.
  const ALWAYS_ON = new Set(["tool:select"]);
  function setHidden(key, on) {
    if (on && ALWAYS_ON.has(key)) return false;
    if (on) hidden.add(key); else hidden.delete(key);
    applyHidden(); persist();
    return true;
  }
  // Anchor a tile: the adaptive engine will never reorder it or hide it, whatever is selected.
  // A pin is per form factor, like a hide — the phone and desktop bars are different bars.
  function setPinned(key, on) {
    if (on) pinnedSet.add(key); else pinnedSet.delete(key);
    applyHidden(); persist();
    return true;
  }
  // Move a tile to a bar (optionally at an index). This is how the picker does cross-bar moves —
  // on a phone the bars sit at opposite ends of the screen, so dragging between them is hostile.
  function move(key, barName, index) {
    const bar = BARS.find((b) => b.name === barName), el = collectTiles().get(key);
    const cont = bar && barOf(bar);
    if (!cont || !el) return false;
    const sibs = movable(bar).filter((m) => m !== el);
    const ref = (index == null || index >= sibs.length) ? tailEl(cont, bar) : sibs[index];
    cont.insertBefore(el, ref);
    persist(); refreshOverflow();
    return true;
  }
  // What the picker renders: every bar, and the tiles currently in it (hidden ones included — they
  // must still be listed, or you could never switch one back on).
  const listBars = () => BARS.map((b) => ({
    name: b.name,
    el: barOf(b),
    tiles: movable(b).filter(isTile).map((t) => ({ key: tileKey(t), el: t, hidden: hidden.has(tileKey(t)), pinned: pinnedSet.has(tileKey(t)), alwaysOn: ALWAYS_ON.has(tileKey(t)) })),
  })).filter((b) => b.el);

  // Exposed for the header Layout dropdown (MENU_ITEMS.layout) + E2E.
  const layoutCtl = {
    isEditing: () => editing,
    toggleEdit: () => setEditing(!editing),
    registerBar,
    reset, applyProfile, deleteProfile, renameProfile, save: persist,
    saveProfile, updateActive,
    activeProfile: () => activeProfile,
    isDirty,
    setHidden, setPinned, move, listBars, refreshOverflow,
    isHidden: (key) => hidden.has(key),
    hiddenKeys: () => [...hidden],
    isPinned: (key) => pinnedSet.has(key),
    pinnedKeys: () => [...pinnedSet],
    mode,
    saveProfilePrompt: () => floatingInput({ title: "Save layout as profile", value: activeProfile || "", placeholder: "profile name", onCommit: (nm) => { if (saveProfile(nm)) setStatus(`Saved layout profile "${nm}".`, 1800); } }),
    renamePrompt: (name) => floatingInput({ title: "Rename profile", value: name, onCommit: (n) => { if (!renameProfile(name, n) && n !== name) setStatus(`A profile named "${n}" already exists.`, 2400); } }),
    listProfiles: () => Object.keys(loadProfiles()),
  };
  return layoutCtl;
}
