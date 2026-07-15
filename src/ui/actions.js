// What can you do with the current selection, and which of it matters most?
//
// The app already KNEW both of these things — it just never said them out loud. The answers were
// braided into two places that could not see each other:
//   * refreshActionButtons() (app.js) computed a dozen predicates and used them only to grey buttons
//     out. "Union is possible right now" existed for exactly as long as it took to set .disabled.
//   * editor._objectActions() (editor.js) recomputed half the SAME predicates privately, to build the
//     "Actions ▾" menu. Two copies of `fillable`, two of `expandable` — free to drift apart.
//
// This module computes them ONCE and exports the answer, so the toolbars, the Actions menu and the
// suggestion block are all reading the same truth. It is a pure oracle: it reads the editor and
// returns facts. It sets no classes, disables no buttons, touches no DOM.
import { shapeToAbsPath } from "../hv/index.js";

const tag = (n) => (n.tagName || "").toLowerCase();

// One pass, every predicate. Recomputed on every selection change on purpose: a shape MOVED into
// overlap changes `fillable` without changing the id set, so memoising on ids would be wrong.
export function selectionFacts(editor) {
  const has = !!editor.stage;
  const sel = has ? editor.selectedNodes() : [];
  const n = sel.length, hasSel = n > 0;
  const artboard = has && !!editor.artboardSelected;
  const leaves = hasSel ? editor._effectiveLeaves() : [];
  const reads = leaves.length ? leaves : sel;
  const single = n === 1 ? sel[0] : null;

  const fillableN = leaves.filter((s) => shapeToAbsPath(s)).length;
  const isRaster = hasSel && editor._selectionIsRaster();
  const allRaster = hasSel && reads.every((r) => editor.isRaster(r));

  return {
    editor, has, sel, n, hasSel, artboard, reads, single,
    // --- the gate predicates (were app.js:986-1015) ---
    fillable: fillableN >= 2,
    fillableN,
    hasGroup: sel.some((s) => tag(s) === "g"),
    hasClip: !!(editor.clipboard && editor.clipboard.length),
    clipGroup: hasSel && n === 1 && (editor._clipGroupOf(sel[0]) === sel[0] || editor._maskGroupOf(sel[0]) === sel[0]),
    canMakeClip: editor._topSelection(sel).filter((s) => s.hasAttribute && s.hasAttribute("data-hv-id")).length >= 2,
    isRaster,
    allRaster,
    canXform: hasSel || (has && artboard),
    canInvert: (hasSel && !isRaster) || (has && artboard),
    // --- the predicates _objectActions() used to keep to itself (editor.js:2009-2016) ---
    expandable: reads.some((r) => ["rect", "circle", "ellipse", "line", "polygon", "polyline", "text"].includes(tag(r)) || editor._isStroked(r)),
    hasStroke: reads.some((r) => editor._isStroked(r)),
    hasPath: reads.some((r) => shapeToAbsPath(r)),
    isBlend: !!(single && editor.isBlendGroup && editor.isBlendGroup(single)),
    isRepeat: !!(single && editor.isRepeatGroup && editor.isRepeatGroup(single)),
    hasText: reads.some((r) => tag(r) === "text"),
  };
}

// One word for "what am I looking at". Order matters — the first match wins.
export function selectionKind(f) {
  if (!f.has) return "empty";
  if (f.artboard && !f.hasSel) return "artboard";
  if (!f.hasSel) return "none";
  if (f.allRaster) return "raster";
  if (f.n >= 2 && f.reads.some((r) => f.editor.isRaster(r))) return "mixed";
  if (f.clipGroup) return "clipgroup";
  if (f.n === 1 && tag(f.sel[0]) === "g") return "group";
  if (f.n === 1 && tag(f.sel[0]) === "text") return "text";
  if (f.fillable) return "overlap";          // ≥2 path-able leaves: the booleans are live
  if (f.n >= 2) return "shapes";
  return "shape";
}

// The tile-backed actions. `key` is layout.js's tileKey, so a bar, the picker and the suggestion
// block can all refer to the same button by the same name.
//
// `why` is AUTHORED. It has to be: a tile's title attribute is a terse restatement plus a keyboard
// shortcut ("Unite — combine shapes"), and _objectActions() carries a bare label. Neither says what
// the thing is FOR. Where a tile changes meaning with context (#act-clip), `dynamic` supplies the
// label/glyph/why, so the suggestion pulse (src/ui/pulse.js) asks the same question the button does
// instead of re-deriving it and drifting.
//
// `noisy: true` marks a gate so broad it goes valid on nearly EVERY selection ("you selected
// something", "a document exists") — pulse.js excludes these, or clicking any one shape would light
// up a dozen buttons at once and "just became possible" would stop meaning anything. The unmarked
// entries are gated on something genuinely narrow (an overlap, a group, a clipboard) — that scarcity
// is exactly what makes their transition worth a glance.
export const ACTIONS = [
  { key: "#act-duplicate", glyph: "⧉⁺", label: "Duplicate",  why: "Make a copy on top",                 valid: (f) => f.hasSel, noisy: true },
  { key: "#layer-delete",  glyph: "✕",  label: "Delete",     why: "Remove it from the canvas",          valid: (f) => f.hasSel, noisy: true },
  { key: "#act-cut",       glyph: "✂",  label: "Cut",        why: "Remove it and hold it on the clipboard", valid: (f) => f.hasSel, noisy: true },
  { key: "#act-copy",      glyph: "⧉",  label: "Copy",       why: "Hold a copy on the clipboard",       valid: (f) => f.hasSel, noisy: true },
  { key: "#act-paste",     glyph: "❏",  label: "Paste",      why: "Drop in what's on the clipboard",    valid: (f) => f.has && f.hasClip, noisy: true },

  { key: "#act-union",     glyph: "∪",  label: "Unite",      why: "Merge the shapes into one",          valid: (f) => f.fillable },
  { key: "#act-subtract",  glyph: "−",  label: "Subtract",   why: "Cut the front shape out of the back", valid: (f) => f.fillable },
  { key: "#act-intersect", glyph: "∩",  label: "Intersect",  why: "Keep only the overlap",              valid: (f) => f.fillable },
  { key: "#act-clip",      glyph: "⛶",  label: "Clipping mask", why: "Use the top object to clip the rest",
    valid: (f) => f.clipGroup || f.canMakeClip,
    dynamic: (f) => (f.clipGroup
      ? { glyph: "↺", label: "Release mask", why: "Let the clipped objects out again" }
      : { glyph: "⛶", label: "Clipping mask", why: "Use the top object to clip the rest" }) },

  { key: "#layer-group",   glyph: "⊞",  label: "Group",      why: "Treat them as one object",           valid: (f) => f.n >= 2 },
  { key: "#layer-ungroup", glyph: "⊟",  label: "Ungroup",    why: "Break it back into its parts",       valid: (f) => f.hasGroup },
  { key: "#layer-rename",  glyph: "✎",  label: "Rename",     why: "Give it a name in the Layers list",  valid: (f) => f.n === 1, noisy: true },

  { key: "#layer-front",   glyph: "⤒",  label: "Bring to front", why: "Put it above everything",        valid: (f) => f.hasSel, noisy: true },
  { key: "#layer-forward", glyph: "↑",  label: "Bring forward",  why: "Move it up one",                 valid: (f) => f.hasSel, noisy: true },
  { key: "#layer-backward", glyph: "↓", label: "Send backward",  why: "Move it down one",               valid: (f) => f.hasSel, noisy: true },
  { key: "#layer-back",    glyph: "⤓",  label: "Send to back",   why: "Put it behind everything",       valid: (f) => f.hasSel, noisy: true },

  // Free transform ranks ABOVE the 90° nudges: "make it bigger" and "turn it a bit" are what people
  // actually reach for, and on a phone these two buttons ARE the only way in (no Ctrl+T) and the only
  // way back out (no Esc).
  { key: "#act-scale",     glyph: "⤢",  label: "Scale",        why: "Drag the handles to resize it",    valid: (f) => f.canXform, noisy: true },
  { key: "#act-rotate",    glyph: "⟳",  label: "Rotate",       why: "Drag the corners to turn it",      valid: (f) => f.canXform, noisy: true },
  { key: "#act-rotate-cw", glyph: "↻",  label: "Rotate right", why: "Turn it 90° clockwise",            valid: (f) => f.canXform, noisy: true },
  { key: "#act-rotate-ccw", glyph: "↺", label: "Rotate left",  why: "Turn it 90° anticlockwise",        valid: (f) => f.canXform, noisy: true },
  { key: "#act-flip-h",    glyph: "⇄",  label: "Flip across",  why: "Mirror it left-to-right",          valid: (f) => f.canXform, noisy: true },
  { key: "#act-flip-v",    glyph: "⇅",  label: "Flip over",    why: "Mirror it top-to-bottom",          valid: (f) => f.canXform, noisy: true },

  { key: "#hdr-invert",    glyph: "⊠",  label: "Invert space", why: "Fill the gaps instead of the shapes", valid: (f) => f.canInvert, noisy: true },
  { key: "#layer-cleanup", glyph: "⌫",  label: "Clean up",     why: "Drop empty and stray layers",      valid: (f) => f.has, noisy: true },
  { key: "#layer-merge",   glyph: "≡",  label: "Merge by colour", why: "Combine layers that share a fill", valid: (f) => f.has, noisy: true },
];
const BY_KEY = new Map(ACTIONS.map((a) => [a.key, a]));

// key -> { valid, label, glyph, why }, with the context-dependent ones already resolved.
export function evaluate(f) {
  const m = new Map();
  for (const a of ACTIONS) {
    const d = a.dynamic ? a.dynamic(f) : null;
    m.set(a.key, {
      valid: !!a.valid(f),
      glyph: (d && d.glyph) || a.glyph,
      label: (d && d.label) || a.label,
      why: (d && d.why) || a.why,
      noisy: !!a.noisy,
    });
  }
  return m;
}

// The TOOLS and the VIEW controls were never in this registry — it only ever knew the 27 tile
// ACTIONS. But a newcomer's first question is not "can I unite these two", it is "what on earth is
// that ⌇ for", and the only answer this app has ever had for that is a `title=` tooltip: a surface
// that needs a mouse to hover, on a product whose whole point is that it also runs on a phone. So a
// tool's purpose was literally unreachable on half our platforms.
//
// Same contract as ACTIONS: a name and what the thing is FOR, in a sentence, with NO keyboard
// shortcut in it. The shortcut is a different affordance and it is already printed on the tile.
// [label, why] — the label is what a command palette calls it, and what you'd search for.
export const TOOL_WHY = {
  "tool:select":       ["Select", "Pick things up and move them around"],
  "tool:node":         ["Edit points", "Reshape a path by dragging its points"],
  "tool:pen":          ["Pen", "Draw an exact shape, one point at a time"],
  "tool:curvature":    ["Curvature", "Draw smooth curves without wrestling handles"],
  "tool:rect":         ["Rectangle", "Drag out a rectangle"],
  "tool:ellipse":      ["Ellipse", "Drag out a circle or an oval"],
  "tool:line":         ["Line", "Drag out a straight line"],
  "tool:text":         ["Text", "Place some type and start typing"],
  "tool:width":        ["Width", "Make a stroke thicker in some places than others"],
  "tool:shapebuilder": ["Shape Builder", "Merge overlapping shapes by painting across them"],
  "tool:scissors":     ["Scissors", "Snip a path open at a single point"],
  "tool:knife":        ["Knife", "Slice clean through a shape"],
  "tool:eraser":       ["Eraser", "Rub parts of a shape away"],
};
export const VIEW_WHY = {
  "vp:zoom-out":   ["Zoom out", "See more of the canvas at once"],
  "vp:zoom-in":    ["Zoom in", "Get a closer look"],
  "vp:fit":        ["Fit to view", "Fit the whole canvas on screen"],
  "vp:actual":     ["Actual size", "Back to 100%"],
  "#vp-selectall": ["Select all", "Select everything on the canvas"],
  "#vp-rulers":    ["Rulers", "Show rulers down the edges"],
  "#vp-guides":    ["Smart guides", "Snap to guides while you drag"],
  "#undo-button":  ["Undo", "Take back the last thing you did"],
  "#redo-button":  ["Redo", "Put back what you just undid"],
};

// THE WORDS A NEWCOMER ACTUALLY REACHES FOR, which are almost never the words on the button.
//
// This is the half of a command palette that decides whether it works, and it is the half that is
// easy to skip. Search only the name and the description and you serve only the people who already
// know the vocabulary: nobody types "subtract", they type "hole". Nobody types "scale", they type
// "bigger". A palette without this list feels broken in a way that looks like a search bug and is
// really a content gap — which is exactly how it first behaved: "hole" matched *Fit to view*, on the
// "w-hole canvas", and missed Subtract entirely.
//
// Keyed by tile key, or (for the menu-only verbs, which have no tile) by label prefix.
const FIND = {
  "#act-union":      "merge combine join weld fuse one",
  "#act-subtract":   "hole punch knockout cutout notch remove minus",
  "#act-intersect":  "overlap common shared inside",
  "#act-clip":       "crop frame hide mask window trim",
  "#act-duplicate":  "copy clone repeat another",
  "#layer-delete":   "remove erase bin trash get rid",
  "#act-cut":        "move clipboard",
  "#act-copy":       "clipboard",
  "#act-paste":      "clipboard",
  "#act-scale":      "bigger smaller resize size grow shrink stretch",
  "#act-rotate":     "turn angle spin tilt",
  "#act-rotate-cw":  "turn right quarter",
  "#act-rotate-ccw": "turn left quarter",
  "#act-flip-h":     "mirror reflect reverse sideways",
  "#act-flip-v":     "mirror reflect reverse upside down",
  "#layer-group":    "combine together lock",
  "#layer-ungroup":  "split apart separate break",
  "#layer-front":    "top above stack order raise",
  "#layer-back":     "bottom behind stack order lower",
  "#layer-forward":  "up above raise stack order",
  "#layer-backward": "down behind lower stack order",
  "#layer-rename":   "name title",
  "#hdr-invert":     "negative inside out background",
  "#layer-merge":    "combine same colour color flatten",
  "#layer-cleanup":  "tidy empty stray remove junk",
  "tool:select":     "move arrow pointer pick drag",
  "tool:node":       "anchor handle vertex direct bezier reshape",
  "tool:pen":        "draw path bezier vector outline",
  "tool:curvature":  "draw curve smooth round bend",
  "tool:rect":       "square box block",
  "tool:ellipse":    "circle oval round dot",
  "tool:line":       "stroke straight rule",
  "tool:text":       "type font write letters words label title",
  "tool:width":      "thick thin taper swell weight",
  "tool:shapebuilder": "merge combine paint join",
  "tool:scissors":   "snip open split break path",
  "tool:knife":      "slice cut split divide",
  "tool:eraser":     "rub remove delete",
  "vp:zoom-in":      "magnify closer bigger in",
  "vp:zoom-out":     "smaller further away out",
  "vp:fit":          "zoom fit whole all see everything",
  "vp:actual":       "100 percent real one to one",
  "#vp-selectall":   "everything all",
  "#vp-rulers":      "measure guides edges",
  "#vp-guides":      "snap align smart",
  "#undo-button":    "back mistake revert oops",
  "#redo-button":    "forward again",
};
// The menu-only verbs have no tile and so no key — match them by the same label prefix VERB_WHY uses.
const VERB_FIND = [
  ["Expand object", "convert paths outline flatten editable"],
  ["Outline stroke", "convert stroke to shape thicken"],
  ["Offset path", "grow shrink inset outset bigger smaller"],
  ["Pathfinder: Divide", "split cut regions pieces"],
  ["Pathfinder: Trim", "remove hidden underneath"],
  ["Pathfinder: Merge", "combine same colour color"],
  ["Pathfinder: Crop", "keep inside clip"],
  ["Pathfinder: Minus Back", "hole subtract knockout"],
  ["Vary width", "thick thin taper swell"],
  ["Make blend", "morph between transition tween"],
  ["Pattern fill", "tile repeat texture wallpaper"],
  ["Make symbol", "reuse instance component library"],
  ["Reflect", "mirror flip"],
  ["Shear", "slant skew italic"],
  ["Transform again", "repeat last"],
  ["Repeat", "grid radial mirror array duplicate many"],
];
const verbFind = (label) => (VERB_FIND.find(([p]) => label.startsWith(p)) || [null, ""])[1];
export const findWords = (key, label) => FIND[key] || (label ? verbFind(label) : "") || "";

// One question — "what is this tile FOR?" — and one answer, whatever kind of tile it is: a tool, a
// view control, or an action. `f` (selection facts) is optional and only matters for the handful of
// actions whose meaning changes with the selection (#act-clip becomes Release mask). This is the
// lookup the teaching strip reads on hover and on press-and-hold, and it is the same registry a
// command palette (and, later, an agent) would enumerate.
export function whyFor(key, f) {
  const a = BY_KEY.get(key);
  if (a) {
    const d = a.dynamic && f ? a.dynamic(f) : null;
    return { label: (d && d.label) || a.label, why: (d && d.why) || a.why };
  }
  const pair = TOOL_WHY[key] || VIEW_WHY[key];
  return pair ? { label: pair[0], why: pair[1] } : null;
}

// Every tile this app has, named and explained, in one list. The palette enumerates THIS — not a
// hand-kept menu that would drift the moment someone adds a tool — so a command that exists but has
// never been given a sentence shows up as a gap you can see, rather than a hole nobody notices.
export function everyTile(f) {
  const out = [];
  for (const el of document.querySelectorAll(".tool-button")) {
    if (el.classList.contains("panel-x")) continue;
    const key = el.id ? "#" + el.id
      : el.dataset.tool ? "tool:" + el.dataset.tool
        : (el.dataset.vp && el.dataset.action) ? "vp:" + el.dataset.action : null;
    if (!key) continue;
    const info = whyFor(key, f);
    if (!info || !info.label) continue;   // an unnamed tile has nothing to say; don't fake it
    out.push({ key, label: info.label, why: info.why, find: findWords(key), el, available: !el.disabled });
  }
  return out;
}

// Why a VERB (from editor._objectActions) is worth doing. Keyed by its label — matched by prefix so
// "Pathfinder: Trim" and "Reflect — vertical axis" both land. A verb with no entry still renders,
// reason-less, rather than vanishing: a new verb added to editor.js must never silently disappear.
const VERB_WHY = [
  ["Expand object", "Turn it into plain editable paths"],
  ["Outline stroke", "Turn the stroke itself into a shape"],
  ["Offset path", "Grow or shrink the outline"],
  ["Pathfinder: Divide", "Cut it into every separate region"],
  ["Pathfinder: Trim", "Remove the hidden parts underneath"],
  ["Pathfinder: Merge", "Join touching areas of the same colour"],
  ["Pathfinder: Crop", "Keep only what the top shape covers"],
  ["Pathfinder: Minus Back", "Cut the back shape out of the front"],
  ["Vary width", "Make the stroke swell and taper"],
  ["Make blend", "Morph one shape into the other"],
  ["Pattern fill", "Tile it as a repeating fill"],
  ["Make symbol", "Reuse it — edit once, update everywhere"],
  ["Reflect", "Mirror it"],
  ["Shear", "Slant it"],
  ["Transform again", "Repeat the last transform"],
  ["Repeat", "Duplicate it in a pattern"],
];
const verbWhy = (label) => (VERB_WHY.find(([p]) => label.startsWith(p)) || [null, ""])[1];

// Which actions matter most, for each thing you can have selected. Deterministic ordered tables, not
// a fuzzy score — so "why did Unite move?" always has an answer, and a test can assert the sequence.
// Keys not listed for a kind still appear (if valid), just after the ranked ones.
const RANK = {
  empty:     [],
  none:      ["#act-paste", "#layer-cleanup", "#layer-merge"],
  artboard:  ["#hdr-invert", "#act-paste", "#act-rotate-cw", "#act-flip-h"],
  // Scale/Rotate lead wherever ONE thing is selected. On a desktop they're a nicety you could reach
  // with Ctrl+T; on a phone they are the ONLY way to resize or turn an object at all — there is no
  // keyboard, and dragging a shape only ever MOVES it. Below the bar's 7-tile cap they may as well
  // not exist, which is exactly where they were.
  shape:     ["#act-scale", "#act-rotate", "#act-duplicate", "#layer-delete", "#layer-front", "#layer-back", "#act-flip-h", "#act-rotate-cw"],
  // the money case: two shapes that overlap. The booleans ARE the reason you selected both.
  overlap:   ["#act-union", "#act-subtract", "#act-intersect", "#act-clip", "#layer-group", "#act-duplicate"],
  shapes:    ["#layer-group", "#act-scale", "#act-rotate", "#act-duplicate", "#layer-delete", "#layer-front", "#layer-back"],
  group:     ["#layer-ungroup", "#act-scale", "#act-rotate", "#act-duplicate", "#layer-delete", "#layer-front", "#layer-back"],
  clipgroup: ["#act-clip", "#layer-ungroup", "#act-duplicate", "#layer-delete"],
  text:      ["#act-scale", "#act-rotate", "#act-duplicate", "#layer-delete", "#layer-front", "#layer-back"],
  raster:    ["#act-scale", "#act-rotate", "#act-duplicate", "#layer-delete", "#act-rotate-cw", "#act-flip-h", "#act-copy"],
  mixed:     ["#layer-group", "#act-scale", "#act-duplicate", "#layer-delete", "#layer-front", "#layer-back"],
};

// A ranked, VALID-only list of everything you could do right now: tile-backed actions first (they
// have buttons, so a bar can show them), then the verbs from _objectActions (menu-only — they live
// in the suggestion block).
//
// `isHidden` lets the caller exclude what the user switched off. That's not a detail: a tile the user
// hid must never be suggested either, or "hidden" would only mean "hidden from one of the two places
// I can see it".
export function rankFor(f, { isHidden = () => false } = {}) {
  const st = evaluate(f);
  const kind = selectionKind(f);
  const ranked = RANK[kind] || [];
  const tiles = [];
  const push = (key) => {
    if (isHidden(key)) return;
    const s = st.get(key);
    if (!s || !s.valid || tiles.some((t) => t.key === key)) return;
    tiles.push({ kind: "tile", key, glyph: s.glyph, label: s.label, why: s.why });
  };
  for (const key of ranked) push(key);
  for (const a of ACTIONS) push(a.key);   // everything else valid, in registry order

  // Verbs: mixed selections get none — _objectActions() only bails when EVERY node is a raster
  // (editor.js:2006), so a half-raster selection would be offered vector ops that misbehave on the
  // raster half.
  let verbs = [];
  if (kind !== "mixed" && kind !== "raster" && f.hasSel) {
    verbs = (f.editor._objectActions(f.sel) || [])
      .filter((it) => it.label && it.type !== "sep")
      .map((it) => ({ kind: "verb", key: "verb:" + it.label, label: it.label, why: verbWhy(it.label), run: it.onClick }));
  }
  // Text's single most wanted verb is "turn this into paths" — float it.
  if (kind === "text") {
    const i = verbs.findIndex((v) => v.label === "Expand object");
    if (i > 0) verbs.unshift(verbs.splice(i, 1)[0]);
  }
  return { kind, tiles, verbs };
}

// The one-line human read, mirroring describeAnalysis() in the raster auto-plan banner.
export function describeSelection(f) {
  const kind = selectionKind(f);
  const n = f.n;
  switch (kind) {
    case "empty": return "No document open";
    case "none": return "Nothing selected";
    case "artboard": return "The artboard";
    case "raster": return n > 1 ? `${n} images` : "An image";
    case "mixed": return `${n} objects — images and shapes`;
    case "clipgroup": return "A clipping mask";
    case "group": return "A group";
    case "text": return "Text";
    case "overlap": return `${n} overlapping shapes`;
    case "shapes": return `${n} objects`;
    default: return "One shape";
  }
}

export const actionFor = (key) => BY_KEY.get(key) || null;
