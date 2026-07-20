// Multiple fills (Epic K.1, SCOPED): an ORDERED stack of fill layers on ONE shape, each with
// its own colour + opacity — Illustrator's Appearance panel, deliberately narrowed to fills
// only for a first slice (no strokes, no per-layer blend mode, no per-layer effects — those
// stay a future slab, same "ship a solid v1, document the rest" pattern this backlog's other
// oversized items used: D.1-not-D.2-4, threading-not-styles-first, PDF-not-EPS).
//
// Same "regen/expand" shape as blend/warp/repeat/width/threaded-text: a
// <g data-hv-fills='{"d","fillRule","layers":[{fill,opacity},...]}'> holds the ORIGINAL
// absolute geometry + the ordered layer list; _regenFills(g) rebuilds one <path> child per
// layer (DOM order = paint order = list order — index 0 paints first/bottom, the last index
// paints last/top); expandMultiFill just drops the attribute, since the children are already
// real, independently-editable paths. data-hv-fills survives save/reopen via editor.js's
// PERSIST_ATTRS/_captureLiveBlob mechanism, same as every sibling of this pattern.
// Object.assign MIXIN — `this === editor`.
import { SVG_NS, shapeToAbsPath } from "../../hv/index.js";
import { setStatus } from "../../app.js";

export const multiFillMixin = {
  isMultiFillGroup(n) { return !!(n && n.tagName && n.tagName.toLowerCase() === "g" && n.hasAttribute("data-hv-fills")); },
  _fillsSpec(g) { try { return JSON.parse(g.getAttribute("data-hv-fills")); } catch { return null; } },
  _fillsSet(g, spec) { g.setAttribute("data-hv-fills", JSON.stringify(spec)); },
  _fillLayers(g) { const spec = this._fillsSpec(g); return spec ? spec.layers : null; },
  // Rebuild the stack's children from its spec — one <path> per layer, same shared geometry.
  _regenFills(g) {
    const spec = this._fillsSpec(g); if (!spec) return;
    [...g.children].forEach((c) => c.remove());
    for (const layer of spec.layers) {
      const p = document.createElementNS(SVG_NS, "path");
      p.setAttribute("data-hv-id", "n" + (++this.idSeq));
      p.setAttribute("d", spec.d);
      if (spec.fillRule) p.setAttribute("fill-rule", spec.fillRule);
      p.setAttribute("fill", layer.fill);
      if (layer.opacity != null && layer.opacity < 1) p.setAttribute("fill-opacity", String(layer.opacity));
      g.appendChild(p);
    }
  },
  // Object > Add fill: wrap the one selected shape's geometry into a 2-layer stack (its
  // current fill, duplicated) — immediately useful, since a 1-layer "stack" looks identical
  // to a plain shape until you differentiate a second layer.
  makeMultiFill() {
    if (!this.stage) return;
    const sel = this.selectedNodes();
    if (sel.length !== 1) { setStatus("Select one filled shape to start a fill stack.", 3000); return; }
    const n = sel[0];
    const d = shapeToAbsPath(n, n.getCTM());
    if (!d) { setStatus("This shape can't take a fill stack.", 3000); return; }
    const fill = n.getAttribute("fill") || "#000000";
    const opAttr = n.getAttribute("fill-opacity"); const opacity = opAttr != null ? parseFloat(opAttr) : 1;
    const fillRule = n.getAttribute("fill-rule") || null;
    this.push("Add fill");
    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("data-hv-id", "n" + (++this.idSeq));
    this._fillsSet(g, { d, fillRule, layers: [{ fill, opacity }, { fill, opacity }] });
    n.parentNode.insertBefore(g, n); n.remove();
    this._regenFills(g);
    this.selection = new Set([g.getAttribute("data-hv-id")]); this.artboardSelected = false;
    this._renderSelection(); this._renderInspector(); this._renderLayers();
    setStatus("Fill stack started — 2 layers, edit each independently.", 2600);
  },
  addFillLayer(g) {
    const spec = this._fillsSpec(g); if (!spec) return;
    this.push("Add fill layer");
    const top = spec.layers[spec.layers.length - 1];
    spec.layers.push({ fill: top.fill, opacity: top.opacity });
    this._fillsSet(g, spec); this._regenFills(g);
    this._renderSelection(); this._renderInspector();
  },
  // Never drops below 1 layer — removing the last one would leave an empty, invisible group.
  removeFillLayer(g, i) {
    const spec = this._fillsSpec(g); if (!spec || spec.layers.length <= 1 || !spec.layers[i]) return;
    this.push("Remove fill layer");
    spec.layers.splice(i, 1);
    this._fillsSet(g, spec); this._regenFills(g);
    this._renderSelection(); this._renderInspector();
  },
  setFillLayer(g, i, patch) {
    const spec = this._fillsSpec(g); if (!spec || !spec.layers[i]) return;
    spec.layers[i] = { ...spec.layers[i], ...patch };
    this._fillsSet(g, spec); this._regenFills(g);
    this._renderSelection();
  },
  moveFillLayer(g, i, dir) {
    const spec = this._fillsSpec(g); if (!spec) return;
    const j = i + dir; if (j < 0 || j >= spec.layers.length) return;
    this.push("Reorder fill layer");
    const tmp = spec.layers[i]; spec.layers[i] = spec.layers[j]; spec.layers[j] = tmp;
    this._fillsSet(g, spec); this._regenFills(g);
    this._renderSelection(); this._renderInspector();
  },
  expandMultiFill(g) {
    g = g || this.selectedNodes().find((n) => this.isMultiFillGroup(n));
    if (!this.isMultiFillGroup(g)) return;
    this.push("Expand fill stack");
    g.removeAttribute("data-hv-fills");
    this._renderSelection(); this._renderInspector(); this._renderLayers();
    setStatus("Fill stack expanded to plain paths.", 1800);
  },
};
