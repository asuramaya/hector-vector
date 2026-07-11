// Action bars that rearrange themselves to show what you can actually DO with what's selected.
// Two overlapping shapes -> the booleans lead. A group -> Ungroup leads. Nothing selected -> the bar
// isn't there at all. Invalid actions are HIDDEN, not greyed: a greyed button is a button you have to
// read, decide about, and dismiss, every single time.
//
// ── The one rule this module lives by ───────────────────────────────────────────────────────────
// It writes exactly two things: `element.style.order` and the `.act-off` class. It NEVER moves a DOM
// node, never calls layout.setHidden(), never writes localStorage.
//
// That isn't fastidiousness, it's forced. layout.js's capture() persists DOM CHILD ORDER, and
// persist() fires on every drag, every hide, every profile save. If this engine reordered the DOM,
// then the next persist() would snapshot whatever happened to be selected at that instant — and the
// user's saved layout would quietly become "whatever I had selected when I last touched a button".
// Flexbox `order` reorders what you SEE with zero DOM mutation, and capture() cannot see it.
//
// Corollary, equally load-bearing: `.layout-hidden` (the user switched it off — persisted, owned by
// layout.js) and `.act-off` (the engine says it's invalid right now — ephemeral, owned here) MUST
// stay separate. If this ever reused setHidden(), it would persist() on every selection change and
// permanently destroy the user's hide set.
import { rankFor } from "./actions.js";
import { isPhone } from "./formfactor.js";

// Only ACTION bars adapt. The tools bar must never: tools are MODES, not actions — Pen is always
// valid, Ellipse is always valid, there is nothing to gate on. It's also the one surface with real
// spatial memory. Reordering it would be reordering a piano. Panel headers keep their grey-out too:
// one gated tile isn't worth the jitter next to a caret and a close button.
const ADAPTIVE_BARS = new Set(["arrange", "actions"]);

// How many actions a bar will show at once on a PHONE. With two overlapping shapes selected, fifteen
// different actions are genuinely valid — ranking puts the right ones first, but fifteen 44px tiles
// still need 700px in a 390px strip, and the tail is a scroll nobody performs. So the bar carries the
// best few and the SUGGESTED block in the sheet carries the complete ranked list, labels and all.
// No cap on desktop: a vertical rail has the room.
const PHONE_BAR_CAP = 7;

let getLayout = () => null, getPref = () => "off";
export function configureAdaptive(deps) { ({ getLayout, getPref } = deps); }

let lastKey = "";
let raf = 0;
let suspended = false;

const modeNow = () => {
  const p = getPref() || "off";
  // The phone is fully adaptive regardless of the desktop preference: there, screen space is genuinely
  // scarce and there is no muscle memory to protect — that bar is days old.
  if (isPhone()) return "full";
  return p;
};

function barsToAdapt(L) {
  return (L.listBars() || []).filter((b) => ADAPTIVE_BARS.has(b.name) && b.el);
}

// Put everything back the way layout.js left it. Called when adaptivity is off, and — crucially —
// while customizing: layout.js's drag hit-test (insertionRef) walks DOM order and compares rects, so
// with `order` set, visual order and DOM order diverge and the insertion point becomes gibberish.
// Clearing it also means a tile the engine hid can always be tapped back on.
export function clearAdaptive() {
  const L = getLayout();
  if (!L) return;
  for (const bar of barsToAdapt(L)) {
    for (const el of bar.el.children) { el.classList.remove("act-off"); el.style.order = ""; }
  }
  lastKey = "";
}

export function suspendAdaptive(on) {
  suspended = !!on;
  if (suspended) clearAdaptive();
  else sync();
}

// The engine. `facts` comes from the shared oracle (src/ui/actions.js) — the same answer the toolbars
// grey-out and the suggestion block are reading, so they can't disagree.
export function sync(facts) {
  if (suspended) return;
  const L = getLayout();
  if (!L || !facts) return;
  if (modeNow() !== "full") { clearAdaptive(); return; }

  const all = rankFor(facts, { isHidden: (k) => L.isHidden(k) }).tiles;
  const rank = new Map(all.map((t, i) => [t.key, i]));

  // Guard the WRITES, not the reads. facts must be recomputed every time (a shape MOVED into overlap
  // changes what's possible without changing the id set), but if the ranked sequence is identical
  // there is nothing to repaint — selecting a second rect when you already had one selected must not
  // make the toolbar flicker.
  const key = [...rank.keys()].join(",") + "|" + L.hiddenKeys().join(",") + "|" + L.pinnedKeys().join(",");
  if (key === lastKey) return;
  lastKey = key;

  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(() => {
    for (const bar of barsToAdapt(L)) {
      const kids = [...bar.el.children];
      // Pinned tiles are ANCHORS: they hold their DOM slot and are always shown. Everything else gets
      // dealt into the slots the anchors didn't claim, best-first.
      const taken = new Set();
      kids.forEach((el, i) => { const k = keyOf(el); if (k && L.isPinned(k)) taken.add(i); });
      const free = kids.map((_, i) => i).filter((i) => !taken.has(i));
      let f = 0;

      const ranked = kids
        .filter((el) => { const k = keyOf(el); return k && !L.isPinned(k) && rank.has(k); })
        .sort((a, b) => rank.get(keyOf(a)) - rank.get(keyOf(b)));

      // The cap is PER BAR, and only where space is actually scarce: the phone's contextual strip,
      // which sits under the canvas and is competing for it. Capping the GLOBAL ranked list instead
      // would silently un-show whatever ranked past the cut in EVERY bar — cut/copy/paste rank low,
      // so they'd vanish from the sheet too and become unreachable on a phone. (They did.)
      const cap = (isPhone() && bar.name === "arrange") ? PHONE_BAR_CAP : Infinity;
      const shown = new Set(ranked.slice(0, cap).map((el) => keyOf(el)));

      for (const el of ranked) el.style.order = String(free[f++] ?? kids.length);

      for (const [i, el] of kids.entries()) {
        const k = keyOf(el);
        if (k && L.isPinned(k)) { el.classList.remove("act-off"); el.style.order = String(i); continue; }
        if (!k) {
          // A divider's grouping meaning is destroyed by reranking, and a stray rule floating between
          // reflowed icons is just noise. They come back verbatim when adaptivity is off.
          el.classList.add("act-off");
          continue;
        }
        const on = shown.has(k);
        el.classList.toggle("act-off", !on);
        if (!on) el.style.order = String(free[f++] ?? kids.length);
      }
    }
    // The scroll-fade hint is driven by a childList MutationObserver, which a class-only change never
    // trips — without this the "there's more, scroll" fade lies. (Same trap layout.js already documents.)
    if (L.refreshOverflow) L.refreshOverflow();
  });
}

// tileKey, but read off the DOM — mirrors layout.js's tileKey() so both name the same button the
// same way. Returns null for separators (which have no key, and are not actions).
function keyOf(el) {
  if (!el.classList || !el.classList.contains("tool-button")) return null;
  if (el.id) return "#" + el.id;
  if (el.dataset.tool) return "tool:" + el.dataset.tool;
  if (el.dataset.vp && el.dataset.action) return "vp:" + el.dataset.action;
  return null;
}
