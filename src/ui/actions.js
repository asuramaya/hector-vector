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
// label/glyph/why, so the suggestion block asks the same question the button does instead of
// re-deriving it and drifting.
export const ACTIONS = [
  { key: "#act-duplicate", glyph: "⧉⁺", label: "Duplicate",  why: "Make a copy on top",                 valid: (f) => f.hasSel },
  { key: "#layer-delete",  glyph: "✕",  label: "Delete",     why: "Remove it from the canvas",          valid: (f) => f.hasSel },
  { key: "#act-cut",       glyph: "✂",  label: "Cut",        why: "Remove it and hold it on the clipboard", valid: (f) => f.hasSel },
  { key: "#act-copy",      glyph: "⧉",  label: "Copy",       why: "Hold a copy on the clipboard",       valid: (f) => f.hasSel },
  { key: "#act-paste",     glyph: "❏",  label: "Paste",      why: "Drop in what's on the clipboard",    valid: (f) => f.has && f.hasClip },

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
  { key: "#layer-rename",  glyph: "✎",  label: "Rename",     why: "Give it a name in the Layers list",  valid: (f) => f.n === 1 },

  { key: "#layer-front",   glyph: "⤒",  label: "Bring to front", why: "Put it above everything",        valid: (f) => f.hasSel },
  { key: "#layer-forward", glyph: "↑",  label: "Bring forward",  why: "Move it up one",                 valid: (f) => f.hasSel },
  { key: "#layer-backward", glyph: "↓", label: "Send backward",  why: "Move it down one",               valid: (f) => f.hasSel },
  { key: "#layer-back",    glyph: "⤓",  label: "Send to back",   why: "Put it behind everything",       valid: (f) => f.hasSel },

  // Free transform ranks ABOVE the 90° nudges: "make it bigger" and "turn it a bit" are what people
  // actually reach for, and on a phone these two buttons ARE the only way in (no Ctrl+T) and the only
  // way back out (no Esc).
  { key: "#act-scale",     glyph: "⤢",  label: "Scale",        why: "Drag the handles to resize it",    valid: (f) => f.canXform },
  { key: "#act-rotate",    glyph: "⟳",  label: "Rotate",       why: "Drag the corners to turn it",      valid: (f) => f.canXform },
  { key: "#act-rotate-cw", glyph: "↻",  label: "Rotate right", why: "Turn it 90° clockwise",            valid: (f) => f.canXform },
  { key: "#act-rotate-ccw", glyph: "↺", label: "Rotate left",  why: "Turn it 90° anticlockwise",        valid: (f) => f.canXform },
  { key: "#act-flip-h",    glyph: "⇄",  label: "Flip across",  why: "Mirror it left-to-right",          valid: (f) => f.canXform },
  { key: "#act-flip-v",    glyph: "⇅",  label: "Flip over",    why: "Mirror it top-to-bottom",          valid: (f) => f.canXform },

  { key: "#hdr-invert",    glyph: "⊠",  label: "Invert space", why: "Fill the gaps instead of the shapes", valid: (f) => f.canInvert },
  { key: "#layer-cleanup", glyph: "⌫",  label: "Clean up",     why: "Drop empty and stray layers",      valid: (f) => f.has },
  { key: "#layer-merge",   glyph: "≡",  label: "Merge by colour", why: "Combine layers that share a fill", valid: (f) => f.has },
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
    });
  }
  return m;
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
