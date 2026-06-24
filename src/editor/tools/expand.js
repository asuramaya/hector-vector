// Expand & Pathfinder (Epic X). Outline/expand stroke, offset path, and the Pathfinder
// region set — all built on the proven marching-squares + bézier-refit engine (hv/raster.js
// + hv/contour.js) the booleans already use, so results come out as minimal cubics with
// crisp corners, robust for any winding/overlap. Object.assign MIXIN — `this === editor`.
import { SVG_NS, nfmt, shapeToAbsPath, rasterStroke, rasterMask, marchingSquares } from "../../hv/index.js";
import { setStatus } from "../../app.js";

export const expandMixin = {
  // A node's stroke band, traced to a filled outline path `d` (outer + inner loops, wound
  // for nonzero fill). Honours width / cap / join / miter / dashes via Canvas2D's stroker.
  // Resolution adapts to the stroke's thinness so hairlines relative to the bbox survive
  // the marching grid. Returns null when the node has no paintable stroke.
  _strokeOutlinePath(node) {
    const d = shapeToAbsPath(node, node.getCTM()); if (!d) return null;
    const stroke = node.getAttribute("stroke");
    const sw = parseFloat(node.getAttribute("stroke-width"));
    if (!stroke || stroke === "none" || !(sw > 0)) return null;
    let m = null; try { m = node.getCTM(); } catch {}
    const scale = m ? Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1 : 1;   // user units → stage
    const w = sw * scale;
    const dash = (node.getAttribute("stroke-dasharray") || "").split(/[\s,]+/).map(parseFloat).filter((v) => v >= 0);
    const spec = {
      d, w,
      cap: node.getAttribute("stroke-linecap") || "butt",
      join: node.getAttribute("stroke-linejoin") || "miter",
      miter: parseFloat(node.getAttribute("stroke-miterlimit")) || 4,
      dash: dash.length ? dash.map((v) => v * scale) : null,
      dashOffset: (parseFloat(node.getAttribute("stroke-dashoffset")) || 0) * scale,
    };
    const bb = this._nodeBBoxUser(node);
    const big0 = Math.max(bb.x1 - bb.x0, bb.y1 - bb.y0) || 1;
    const pad = w / 2 + big0 * 0.01 + 2;
    const box = { x0: bb.x0 - pad, y0: bb.y0 - pad, x1: bb.x1 + pad, y1: bb.y1 + pad };
    const big = Math.max(box.x1 - box.x0, box.y1 - box.y0);
    // grid cell must be a fraction of the band width or a thin stroke falls between lines
    const res = Math.max(220, Math.min(1500, Math.round(2.6 * big / Math.max(w, 0.5))));
    const px = Math.max(640, Math.min(2400, Math.round(res * 1.4)));
    const mask = rasterStroke(spec, box, px);
    return marchingSquares((x, y) => mask.inside(x, y), box, res);
  },
  // Outline (expand) the stroke of every selected stroked path: the stroke becomes a
  // filled path in the stroke's colour; the original keeps its fill (loses the stroke),
  // or is replaced outright when it had no fill. One undo step. (X.1)
  outlineStroke() {
    if (!this.stage) return;
    const leaves = this._effectiveLeaves().filter((n) => !this.isRaster(n) && shapeToAbsPath(n));
    const strokers = leaves.filter((n) => {
      const s = n.getAttribute("stroke"); const w = parseFloat(n.getAttribute("stroke-width"));
      return s && s !== "none" && w > 0;
    });
    if (!strokers.length) { setStatus("Select a stroked path to outline its stroke.", 3000); return; }
    this.push("Outline stroke");
    const keep = [];
    for (const n of strokers) {
      const d = this._strokeOutlinePath(n);
      const hadFill = n.getAttribute("fill") && n.getAttribute("fill") !== "none";
      if (d) {
        const path = document.createElementNS(SVG_NS, "path");
        const id = "n" + (++this.idSeq); path.setAttribute("data-hv-id", id);
        path.setAttribute("d", d); path.setAttribute("fill-rule", "nonzero");
        path.setAttribute("fill", n.getAttribute("stroke"));
        for (const [a, dst] of [["stroke-opacity", "fill-opacity"], ["opacity", "opacity"]]) {
          const v = n.getAttribute(a); if (v) path.setAttribute(dst, v);
        }
        n.parentNode.insertBefore(path, n.nextSibling);   // just above the source
        keep.push(id);
      }
      // strip the stroke from the original
      for (const a of ["stroke", "stroke-width", "stroke-dasharray", "stroke-dashoffset", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-opacity", "data-hv-stroke-align"]) n.removeAttribute(a);
      if (this._removeStrokeClip) this._removeStrokeClip(n);
      n.style && (n.style.removeProperty("stroke-width"), n.style.removeProperty("paint-order"));
      if (hadFill) keep.push(n.getAttribute("data-hv-id")); else n.remove();
    }
    this.selection = new Set(keep.filter(Boolean)); this.artboardSelected = false;
    this._renderSelection(); this._renderInspector(); this._renderLayers();
    setStatus(`Outlined ${strokers.length} stroke${strokers.length > 1 ? "s" : ""}.`, 2000);
  },

  // ---------- Offset Path (X.5) ----------
  // Grow (+) / shrink (−) a filled outline by `amt` user units, via raster morphology:
  // a disk of radius |amt| dilates (fill ∪ band) or erodes (fill ∧ ¬band) the region,
  // where `band` is the boundary stroked to width 2·|amt| (round) — exactly the points
  // within |amt| of the edge. Round joins, like Illustrator's default-safe offset.
  _offsetOutlinePath(node, amt) {
    const d = shapeToAbsPath(node, node.getCTM()); if (!d || !amt) return null;
    let m = null; try { m = node.getCTM(); } catch {}
    const scale = m ? Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1 : 1;
    const r = Math.abs(amt) * scale;
    const rule = node.getAttribute("fill-rule") === "evenodd" ? "evenodd" : "nonzero";
    const bb = this._nodeBBoxUser(node);
    const big0 = Math.max(bb.x1 - bb.x0, bb.y1 - bb.y0) || 1;
    const pad = r + big0 * 0.01 + 2;
    const box = { x0: bb.x0 - pad, y0: bb.y0 - pad, x1: bb.x1 + pad, y1: bb.y1 + pad };
    const px = 1600;
    const fill = rasterMask([{ d, rule }], box, px);
    const band = rasterStroke({ d, w: 2 * r, cap: "round", join: "round" }, box, px);
    const pred = amt >= 0
      ? (x, y) => fill.inside(x, y) || band.inside(x, y)
      : (x, y) => fill.inside(x, y) && !band.inside(x, y);
    const big = Math.max(box.x1 - box.x0, box.y1 - box.y0);
    const res = Math.max(220, Math.min(1400, Math.round(2.6 * big / Math.max(r, 1))));
    return marchingSquares(pred, box, res);
  },
  // Add an offset copy of each fillable selected path (original kept, Illustrator-style).
  offsetPath(amt) {
    if (!this.stage || !amt) return;
    const leaves = this._effectiveLeaves().filter((n) => !this.isRaster(n) && shapeToAbsPath(n));
    if (!leaves.length) { setStatus("Select a path to offset.", 3000); return; }
    this.push("Offset path");
    const ids = []; let empty = 0;
    for (const n of leaves) {
      const d = this._offsetOutlinePath(n, amt);
      if (!d) { empty++; continue; }
      const path = document.createElementNS(SVG_NS, "path");
      const id = "n" + (++this.idSeq); path.setAttribute("data-hv-id", id);
      path.setAttribute("d", d); path.setAttribute("fill-rule", "nonzero");
      for (const a of ["fill", "fill-opacity", "stroke", "stroke-width", "stroke-linejoin", "stroke-linecap", "opacity"]) { const v = n.getAttribute(a); if (v) path.setAttribute(a, v); }
      n.parentNode.insertBefore(path, n.nextSibling);
      ids.push(id);
    }
    if (!ids.length) { this.undo(); setStatus("Offset is empty — the shrink amount is larger than the shape.", 3500); return; }
    this.selection = new Set(ids); this.artboardSelected = false;
    this._renderSelection(); this._renderInspector(); this._renderLayers();
    setStatus(`Offset ${ids.length} path${ids.length > 1 ? "s" : ""} by ${amt}.` + (empty ? ` (${empty} collapsed)` : ""), 2500);
  },
  _promptOffsetPath() {
    const raw = (typeof window !== "undefined" && window.prompt) ? window.prompt("Offset amount (px — negative shrinks):", String(this._lastOffset || 10)) : null;
    if (raw == null) return;
    const amt = parseFloat(raw);
    if (!isFinite(amt) || amt === 0) { setStatus("Enter a non-zero number.", 2500); return; }
    this._lastOffset = amt;
    this.offsetPath(amt);
  },

  // ---------- Pathfinder Divide (X.3) ----------
  // Split N overlapping fillable shapes into every distinct face: the plane is partitioned
  // by which shapes contain each point. For each non-empty membership signature we trace the
  // region where (inside shape i) === bit i, and colour it with the TOPMOST covering shape —
  // exactly Illustrator's Divide. Faces come out grouped. Capped at 6 inputs (64 signatures).
  pathfinder(op) {
    if (!this.stage) return;
    if (op !== "divide") { setStatus("Unknown pathfinder op.", 2000); return; }
    let nodes = this._fillableSelection();
    if (nodes.length < 2) { setStatus("Select 2 or more overlapping shapes to divide.", 3000); return; }
    if (nodes.length > 6) { setStatus("Divide handles up to 6 shapes at once.", 3000); return; }
    nodes = nodes.slice().sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1);   // back → front
    const bb = this._pad(this._bboxUnion(nodes), 0.02);
    const masks = nodes.map((n) => rasterMask([{ d: shapeToAbsPath(n, n.getCTM()), rule: n.getAttribute("fill-rule") }], bb, 1200));
    const big = Math.max(bb.x1 - bb.x0, bb.y1 - bb.y0);
    const res = Math.max(160, Math.min(360, Math.round(big / 4)));
    const N = nodes.length;
    this.push("Divide");
    const anchor = nodes[0];
    const g = document.createElementNS(SVG_NS, "g");
    const gid = "n" + (++this.idSeq); g.setAttribute("data-hv-id", gid);
    let faces = 0;
    for (let sig = 1; sig < (1 << N); sig++) {
      const pred = (x, y) => { for (let i = 0; i < N; i++) { if (masks[i].inside(x, y) !== !!(sig & (1 << i))) return false; } return true; };
      const d = marchingSquares(pred, bb, res);
      if (!d) continue;
      let top = -1; for (let i = N - 1; i >= 0; i--) { if (sig & (1 << i)) { top = i; break; } }
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("data-hv-id", "n" + (++this.idSeq));
      path.setAttribute("d", d); path.setAttribute("fill-rule", "nonzero");
      const srcFill = nodes[top].getAttribute("fill");
      path.setAttribute("fill", srcFill || "#000000");
      for (const a of ["fill-opacity", "opacity"]) { const v = nodes[top].getAttribute(a); if (v) path.setAttribute(a, v); }
      g.appendChild(path); faces++;
    }
    if (!faces) { this.undo(); setStatus("Nothing to divide — the shapes don't overlap into faces.", 3000); return; }
    (anchor.parentNode || this.stage).insertBefore(g, anchor);
    nodes.forEach((n) => n.remove());
    this.selection = new Set([gid]); this.artboardSelected = false;
    this._renderSelection(); this._renderInspector(); this._renderLayers();
    setStatus(`Divided into ${faces} face${faces > 1 ? "s" : ""}.`, 2500);
  },
};
