// Transforms & Repeat (Epic T). The missing transform verbs (reflect / shear / transform-each
// / transform-again) + parametric repeat generators (grid / radial / mirror). Object.assign
// MIXIN — `this === editor`. Transforms compose a matrix + _consolidateTransform (like
// rotateSelectionBy) so text / live-shapes / groups all work and stay serialization-safe.
import { SVG_NS, nfmt } from "../../hv/index.js";
import { setStatus } from "../../app.js";

const TAN = (deg) => Math.tan((deg || 0) * Math.PI / 180);

export const repeatMixin = {
  // Prepend an affine `m` (stage coords) to each node and consolidate. Records it as the
  // last transform for Transform-Again. `copy` reflects/clones first (Illustrator's "Copy").
  _affineSelection(m, label, { copy } = {}) {
    let nodes = this.selectedNodes(); if (!nodes.length) { setStatus("Nothing to transform.", 1500); return; }
    this.push(label);
    if (copy) { const ids = this._cloneSelection(0, 0); this.selection = new Set(ids); nodes = this.selectedNodes(); }
    const M = `matrix(${nfmt(m.a)} ${nfmt(m.b)} ${nfmt(m.c)} ${nfmt(m.d)} ${nfmt(m.e)} ${nfmt(m.f)})`;
    nodes.forEach((n) => { const o = n.getAttribute("transform"); n.setAttribute("transform", o ? `${M} ${o}` : M); this._consolidateTransform(n); });
    this._lastTransform = { m, label };
    this._renderSelection(); this._renderInspector(); this._renderLayers();
  },
  _selCentre() { const bb = this._bboxUnion(this.selectedNodes()); return { cx: (bb.x0 + bb.x1) / 2, cy: (bb.y0 + bb.y1) / 2 }; },
  // Reflect across the selection's horizontal or vertical centre axis (optionally a copy). (T.1)
  reflectSelection(axis, opts = {}) {
    if (!this.selectedNodes().length) { setStatus("Select objects to reflect.", 2000); return; }
    const { cx, cy } = this._selCentre();
    const m = axis === "horizontal"   // mirror across a HORIZONTAL axis → flips Y
      ? { a: 1, b: 0, c: 0, d: -1, e: 0, f: 2 * cy }
      : { a: -1, b: 0, c: 0, d: 1, e: 2 * cx, f: 0 };
    this._affineSelection(m, "Reflect", opts);
    setStatus(`Reflected${opts.copy ? " a copy" : ""} across the ${axis} axis.`, 1800);
  },
  // Shear (skew) by angles about the selection centre. (T.2)
  shearSelection(angleX, angleY) {
    if (!this.selectedNodes().length) { setStatus("Select objects to shear.", 2000); return; }
    const { cx, cy } = this._selCentre();
    const tx = TAN(angleX), ty = TAN(angleY);
    const m = { a: 1, b: ty, c: tx, d: 1, e: -tx * cy, f: -ty * cx };
    this._affineSelection(m, "Shear");
    setStatus(`Sheared ${nfmt(angleX)}° / ${nfmt(angleY)}°.`, 1800);
  },
  // Transform Each (T.4): move / scale / rotate every selected object about its OWN centre.
  transformEach({ dx = 0, dy = 0, sx = 1, sy = 1, deg = 0 } = {}) {
    const nodes = this.selectedNodes(); if (!nodes.length) { setStatus("Select objects.", 1500); return; }
    if (!dx && !dy && sx === 1 && sy === 1 && !deg) return;
    this.push("Transform each");
    for (const n of nodes) {
      const bb = this._nodeBBoxUser(n); const cx = (bb.x0 + bb.x1) / 2, cy = (bb.y0 + bb.y1) / 2;
      const parts = [];
      if (dx || dy) parts.push(`translate(${nfmt(dx)} ${nfmt(dy)})`);
      if (deg) parts.push(`rotate(${nfmt(deg)} ${nfmt(cx)} ${nfmt(cy)})`);
      if (sx !== 1 || sy !== 1) parts.push(`translate(${nfmt(cx)} ${nfmt(cy)}) scale(${nfmt(sx)} ${nfmt(sy)}) translate(${nfmt(-cx)} ${nfmt(-cy)})`);
      const M = parts.join(" "); const o = n.getAttribute("transform");
      n.setAttribute("transform", o ? `${M} ${o}` : M); this._consolidateTransform(n);
    }
    this._lastTransform = { each: { dx, dy, sx, sy, deg } };
    this._renderSelection(); this._renderInspector(); this._renderLayers();
    setStatus(`Transformed ${nodes.length} object${nodes.length > 1 ? "s" : ""} individually.`, 1800);
  },
  // Transform Again (T.5): replay the last reflect/shear/each on the current selection.
  transformAgain() {
    const t = this._lastTransform;
    if (!t) { setStatus("No transform to repeat yet.", 2000); return; }
    if (t.each) { this.transformEach(t.each); return; }
    if (t.m) { this._affineSelection(t.m, (t.label || "Transform") + " again"); return; }
  },

  // ---------- Repeat (T.6): parametric grid / radial / mirror ----------
  // A repeat is a <g data-hv-repeat='{kind,…}'> holding a master <g data-hv-repeat-unit> (the
  // original selection) + generated clones. Editing the count/spacing regenerates from the
  // master; Expand drops the markers → a plain group. data-hv-* is stripped by serialize, but
  // the generated clones are real geometry, so a saved repeat renders (and re-imports as a group).
  repeat(kind, params = {}) {
    const sel = this._topSelection(this.selectedNodes()).filter((n) => n.hasAttribute && n.hasAttribute("data-hv-id"));
    if (!sel.length) { setStatus("Select objects to repeat.", 2500); return; }
    this.push("Repeat " + kind);
    const all = [...this.stage.querySelectorAll("[data-hv-id]")];
    sel.sort((a, b) => all.indexOf(a) - all.indexOf(b));
    const ov = this._overlayEl();
    const front = sel[sel.length - 1], parent = front.parentNode, anchor = front.nextSibling;
    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("data-hv-id", "n" + (++this.idSeq));
    g.setAttribute("data-hv-repeat", JSON.stringify({ kind, ...params }));
    const unit = document.createElementNS(SVG_NS, "g");
    unit.setAttribute("data-hv-id", "n" + (++this.idSeq));
    unit.setAttribute("data-hv-repeat-unit", "1");
    sel.forEach((n) => unit.appendChild(n));
    g.appendChild(unit);
    if (anchor && anchor.parentNode === parent && anchor !== ov) parent.insertBefore(g, anchor);
    else if (parent === this.stage && ov && ov.parentNode === this.stage) this.stage.insertBefore(g, ov);
    else parent.appendChild(g);
    this._regenRepeat(g);
    this.selection = new Set([g.getAttribute("data-hv-id")]); this.artboardSelected = false;
    this._renderSelection(); this._renderInspector(); this._renderLayers();
    setStatus(`Repeated as a ${kind}.`, 1800);
  },
  repeatParamsOf(g) { try { return JSON.parse(g.getAttribute("data-hv-repeat") || "{}"); } catch { return {}; } },
  isRepeatGroup(n) { return !!(n && n.getAttribute && n.getAttribute("data-hv-repeat")); },
  setRepeatParam(g, key, value) {
    const p = this.repeatParamsOf(g); p[key] = value;
    g.setAttribute("data-hv-repeat", JSON.stringify(p));
    this._regenRepeat(g);
    this._renderSelection();
  },
  // The transform string for each copy (index 0 = the master, identity → skipped on clone).
  _repeatTransforms(params, ub) {
    const cx = (ub.x0 + ub.x1) / 2, cy = (ub.y0 + ub.y1) / 2, w = ub.x1 - ub.x0, h = ub.y1 - ub.y0;
    const out = [""];
    if (params.kind === "grid") {
      const rows = Math.max(1, Math.min(50, params.rows || 3)), cols = Math.max(1, Math.min(50, params.cols || 3));
      const dx = params.dx != null ? params.dx : w * 1.15, dy = params.dy != null ? params.dy : h * 1.15;
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { if (!r && !c) continue; out.push(`translate(${nfmt(c * dx)} ${nfmt(r * dy)})`); }
    } else if (params.kind === "radial") {
      const count = Math.max(2, Math.min(120, params.count || 6));
      const radius = params.radius != null ? params.radius : Math.max(w, h) * 1.5;
      const px = cx, py = cy + radius;   // pivot below the unit
      for (let i = 1; i < count; i++) out.push(`rotate(${nfmt(i * 360 / count)} ${nfmt(px)} ${nfmt(py)})`);
    } else if (params.kind === "mirror") {
      const axis = ub.x1 + (params.gap != null ? params.gap : w * 0.15);   // vertical mirror line right of the unit
      out.push(`matrix(-1 0 0 1 ${nfmt(2 * axis)} 0)`);
    }
    return out;
  },
  _regenRepeat(g) {
    const params = this.repeatParamsOf(g);
    const unit = [...g.children].find((c) => c.getAttribute && c.getAttribute("data-hv-repeat-unit"));
    if (!unit) return;
    for (const c of [...g.children]) if (c !== unit) c.remove();
    let ub; try { ub = this._nodeBBoxUser(unit); } catch { ub = { x0: 0, y0: 0, x1: 1, y1: 1 }; }
    const xforms = this._repeatTransforms(params, ub);
    for (let i = 1; i < xforms.length; i++) {
      const c = unit.cloneNode(true);
      c.removeAttribute("data-hv-repeat-unit");
      c.setAttribute("data-hv-id", "n" + (++this.idSeq));
      this._reidSubtree(c);                       // fresh data-hv-ids; resource url() refs stay shared (identical copies)
      if (xforms[i]) c.setAttribute("transform", xforms[i]);
      g.appendChild(c);
    }
  },
  // Expand a repeat to a plain group (drop the parametric markers; clones become real). (ties X)
  expandRepeat(g) {
    if (!this.isRepeatGroup(g)) return;
    this.push("Expand repeat");
    g.removeAttribute("data-hv-repeat");
    const unit = [...g.children].find((c) => c.getAttribute && c.getAttribute("data-hv-repeat-unit"));
    if (unit) unit.removeAttribute("data-hv-repeat-unit");
    this._renderSelection(); this._renderInspector(); this._renderLayers();
    setStatus("Repeat expanded to a group.", 1800);
  },
};
