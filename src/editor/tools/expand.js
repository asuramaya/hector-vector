// Expand & Pathfinder (Epic X). Outline/expand stroke, offset path, and the Pathfinder
// region set — all built on the proven marching-squares + bézier-refit engine (hv/raster.js
// + hv/contour.js) the booleans already use, so results come out as minimal cubics with
// crisp corners, robust for any winding/overlap. Object.assign MIXIN — `this === editor`.
import { SVG_NS, nfmt, shapeToAbsPath, strokeOutline, rasterStroke, rasterMask, marchingSquares, isLiveShape, freezeShape } from "../../hv/index.js";
import { setStatus } from "../../app.js";

export const expandMixin = {
  // A node's stroke band, traced to a filled outline path `d` (outer + inner loops, wound
  // for nonzero fill). Honours width / cap / join / miter / dashes. The GEOMETRIC stroker
  // (hv/stroke.js, Epic S) builds the band analytically — exact joins/caps, no bitmap
  // quantization, so hairlines relative to the bbox survive — and the raster stroker
  // (hv/raster.js) stays as a fallback for any pathological case the analytic path misses.
  // Returns null when the node has no paintable stroke.
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
      d, width: w, w,
      cap: node.getAttribute("stroke-linecap") || "butt",
      join: node.getAttribute("stroke-linejoin") || "miter",
      miter: parseFloat(node.getAttribute("stroke-miterlimit")) || 4,
      dash: dash.length ? dash.map((v) => v * scale) : null,
      dashOffset: (parseFloat(node.getAttribute("stroke-dashoffset")) || 0) * scale,
    };
    let out = "";
    try { out = strokeOutline(d, spec); } catch { out = ""; }   // analytic (Epic S)
    if (out) return out;
    // fallback: raster the band into a coverage bitmap and trace it (no analytic result)
    const bb = this._nodeBBoxUser(node);
    const big0 = Math.max(bb.x1 - bb.x0, bb.y1 - bb.y0) || 1;
    const pad = w / 2 + big0 * 0.01 + 2;
    const box = { x0: bb.x0 - pad, y0: bb.y0 - pad, x1: bb.x1 + pad, y1: bb.y1 + pad };
    const big = Math.max(box.x1 - box.x0, box.y1 - box.y0);
    const res = Math.max(220, Math.min(1500, Math.round(2.6 * big / Math.max(w, 0.5))));
    const px = Math.max(640, Math.min(2400, Math.round(res * 1.4)));
    const mask = rasterStroke(spec, box, px);
    return marchingSquares((x, y) => mask.inside(x, y), box, res);
  },
  // Outline a single node's stroke in place (no history/selection): insert a filled outline
  // path above it, strip the stroke from the original (removing it if it had no fill). Returns
  // the ids that should now be selected for this node. Shared by outlineStroke + expandSelection.
  _expandStrokeOf(n) {
    const d = this._strokeOutlinePath(n);
    if (!d) return [n.getAttribute("data-hv-id")];   // couldn't trace (degenerate) → leave the node untouched, never drop it
    const ids = [];
    const path = document.createElementNS(SVG_NS, "path");
    const id = "n" + (++this.idSeq); path.setAttribute("data-hv-id", id);
    path.setAttribute("d", d); path.setAttribute("fill-rule", "nonzero");
    path.setAttribute("fill", n.getAttribute("stroke"));
    for (const [a, dst] of [["stroke-opacity", "fill-opacity"], ["opacity", "opacity"]]) { const v = n.getAttribute(a); if (v) path.setAttribute(dst, v); }
    n.parentNode.insertBefore(path, n.nextSibling);
    ids.push(id);
    const hadFill = n.getAttribute("fill") && n.getAttribute("fill") !== "none";
    for (const a of ["stroke", "stroke-width", "stroke-dasharray", "stroke-dashoffset", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-opacity", "data-hv-stroke-align"]) n.removeAttribute(a);
    if (this._removeStrokeClip) this._removeStrokeClip(n);
    if (n.style) { n.style.removeProperty("stroke-width"); n.style.removeProperty("paint-order"); }
    if (hadFill) ids.push(n.getAttribute("data-hv-id")); else n.remove();
    return ids;
  },
  _isStroked(n) { const s = n.getAttribute("stroke"); const w = parseFloat(n.getAttribute("stroke-width")); return !!(s && s !== "none" && w > 0); },
  // Outline (expand) the stroke of every selected stroked path. One undo step. (X.1)
  outlineStroke() {
    if (!this.stage) return;
    const strokers = this._effectiveLeaves().filter((n) => !this.isRaster(n) && shapeToAbsPath(n) && this._isStroked(n));
    if (!strokers.length) { setStatus("Select a stroked path to outline its stroke.", 3000); return; }
    this.push("Outline stroke");
    const keep = [];
    for (const n of strokers) keep.push(...this._expandStrokeOf(n));
    this.selection = new Set(keep.filter(Boolean)); this.artboardSelected = false;
    this._renderSelection(); this._renderInspector(); this._renderLayers();
    setStatus(`Outlined ${strokers.length} stroke${strokers.length > 1 ? "s" : ""}.`, 2000);
  },
  // Convert a primitive (rect/ellipse/line/…) to a plain editable <path>, preserving its
  // own transform + paint. Live shapes are frozen; <path>s pass through. Returns the node.
  _primitiveToPath(n) {
    const tag = n.tagName.toLowerCase();
    if (tag === "path") return n;
    const d = shapeToAbsPath(n); if (!d) return n;   // local geometry (transform kept on the node)
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    const skip = new Set(["d", "x", "y", "width", "height", "cx", "cy", "r", "rx", "ry", "points", "x1", "y1", "x2", "y2", "data-hv-shape"]);
    for (const a of n.attributes) { if (!skip.has(a.name)) path.setAttribute(a.name, a.value); }
    n.parentNode.insertBefore(path, n); n.remove();
    return path;
  },
  // Expand (X.2): bake the selection into plain paths — live shapes & primitives → <path>,
  // text → outlines (async), and any stroke → a filled outline. One undo step (text reenters).
  expandSelection() {
    if (!this.stage) return;
    if (this.selectedNodes().some((n) => n.tagName.toLowerCase() === "text")) {
      setStatus("Converting text to outlines first…", 0);
      this.convertSelectedTextToOutlines().then((ids) => {
        if (!this.selectedNodes().some((n) => n.tagName.toLowerCase() === "text")) this.expandSelection();
      }).catch((e) => setStatus(`Couldn't convert the text: ${(e && e.message) || e}`, 5000));
      return;
    }
    const leaves = this._effectiveLeaves().filter((n) => !this.isRaster(n));
    if (!leaves.length) { setStatus("Select objects to expand.", 3000); return; }
    this.push("Expand");
    const keep = [];
    for (let n of leaves) {
      if (isLiveShape(n)) freezeShape(n);            // parametric → plain path data
      n = this._primitiveToPath(n);                  // rect/ellipse/… → <path>
      if (this._isStroked(n)) keep.push(...this._expandStrokeOf(n));
      else keep.push(n.getAttribute("data-hv-id"));
    }
    this.selection = new Set(keep.filter(Boolean)); this.artboardSelected = false;
    this._renderSelection(); this._renderInspector(); this._renderLayers();
    setStatus(`Expanded ${leaves.length} object${leaves.length > 1 ? "s" : ""}.`, 2000);
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

  // ---------- Pathfinder (X.3 / X.4) ----------
  // Region ops over N≤6 overlapping fillable shapes, all on the raster engine:
  //   divide     → every membership face, coloured by the topmost covering shape (grouped)
  //   trim       → each shape minus the shapes IN FRONT of it; colours kept, nothing merged
  //   merge      → trim, then unite touching SAME-colour pieces (front diff-colour wins)
  //   crop       → keep only what's inside the FRONT shape; the front shape is consumed
  //   minus-back → the front shape minus everything behind it (single path)
  // Each builds a region predicate per output and traces it to crisp cubics.
  pathfinder(op) {
    if (!this.stage) return;
    const ops = { divide: "Divide", trim: "Trim", merge: "Merge", crop: "Crop", "minus-back": "Minus Back", outline: "Outline" };
    if (!ops[op]) { setStatus("Unknown pathfinder op.", 2000); return; }
    let nodes = this._fillableSelection();
    if (nodes.length < 2) { setStatus("Select 2 or more overlapping shapes.", 3000); return; }
    if (nodes.length > 6) { setStatus("Pathfinder handles up to 6 shapes at once.", 3000); return; }
    nodes = nodes.slice().sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1);   // back → front
    const N = nodes.length;
    const bb = this._pad(this._bboxUnion(nodes), 0.02);
    const masks = nodes.map((n) => rasterMask([{ d: shapeToAbsPath(n, n.getCTM()), rule: n.getAttribute("fill-rule") }], bb, 1200));
    const big = Math.max(bb.x1 - bb.x0, bb.y1 - bb.y0);
    const res = Math.max(170, Math.min(380, Math.round(big / 3.5)));
    const inAbove = (i, x, y) => { for (let j = i + 1; j < N; j++) if (masks[j].inside(x, y)) return true; return false; };
    const fillOf = (n) => n.getAttribute("fill") || "#000000";
    // Outline (K.5): the same face decomposition as Divide, but each face traces as an
    // unfilled STROKE instead of a filled region — Illustrator's Pathfinder Outline. Faces
    // are traced independently (no shared-edge dedup in this engine), so two adjacent faces
    // each draw their common boundary once — harmless (the same line drawn twice looks
    // identical to once) but not a true single-stroke edge graph; noted, not solved here.
    const outlineMode = op === "outline";
    const mkPath = (d, src) => {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("data-hv-id", "n" + (++this.idSeq));
      path.setAttribute("d", d);
      if (outlineMode) {
        path.setAttribute("fill", "none");
        path.setAttribute("stroke", fillOf(src));
        path.setAttribute("stroke-width", "1");
      } else {
        path.setAttribute("fill-rule", "nonzero");
        path.setAttribute("fill", fillOf(src));
        for (const a of ["fill-opacity", "opacity"]) { const v = src.getAttribute(a); if (v) path.setAttribute(a, v); }
      }
      return path;
    };
    // Build the list of output regions: { pred, src }.
    const outs = [];
    if (op === "divide" || op === "outline") {
      for (let sig = 1; sig < (1 << N); sig++) {
        let top = -1; for (let i = N - 1; i >= 0; i--) if (sig & (1 << i)) { top = i; break; }
        outs.push({ pred: (x, y) => { for (let i = 0; i < N; i++) if (masks[i].inside(x, y) !== !!(sig & (1 << i))) return false; return true; }, src: nodes[top] });
      }
    } else if (op === "trim") {
      for (let i = 0; i < N; i++) outs.push({ pred: (x, y) => masks[i].inside(x, y) && !inAbove(i, x, y), src: nodes[i] });
    } else if (op === "crop") {
      const top = N - 1;
      for (let i = 0; i < top; i++) outs.push({ pred: (x, y) => masks[i].inside(x, y) && masks[top].inside(x, y) && !((() => { for (let j = i + 1; j < top; j++) if (masks[j].inside(x, y)) return true; return false; })()), src: nodes[i] });
    } else if (op === "minus-back") {
      const f = N - 1;
      outs.push({ pred: (x, y) => masks[f].inside(x, y) && !((() => { for (let j = 0; j < f; j++) if (masks[j].inside(x, y)) return true; return false; })()), src: nodes[f] });
    } else if (op === "merge") {
      // group shapes by fill; a colour's region is the union of its shapes minus any
      // DIFFERENT-colour shape sitting in front (same-colour fronts merge, so don't trim).
      const colours = []; const seen = new Map();
      nodes.forEach((n) => { const c = fillOf(n); if (!seen.has(c)) { seen.set(c, colours.length); colours.push({ c, idx: [] }); } colours[seen.get(c)].idx.push(nodes.indexOf(n)); });
      for (const grp of colours) {
        outs.push({ pred: (x, y) => { for (const i of grp.idx) { if (masks[i].inside(x, y)) { let blocked = false; for (let j = i + 1; j < N; j++) { if (fillOf(nodes[j]) !== grp.c && masks[j].inside(x, y)) { blocked = true; break; } } if (!blocked) return true; } } return false; }, src: nodes[grp.idx[grp.idx.length - 1]] });
      }
    }
    this.push(ops[op]);
    const anchor = nodes[0];
    const single = op === "minus-back";
    const g = single ? null : document.createElementNS(SVG_NS, "g");
    if (g) { g.setAttribute("data-hv-id", "n" + (++this.idSeq)); }
    const made = [];
    for (const o of outs) {
      const d = marchingSquares(o.pred, bb, res);
      if (!d) continue;
      const path = mkPath(d, o.src);
      (g || document.createDocumentFragment()).appendChild(path);
      made.push(path);
    }
    if (!made.length) { this.undo(); setStatus("Nothing produced — the shapes don't overlap that way.", 3000); return; }
    if (single) { made.forEach((p) => (anchor.parentNode || this.stage).insertBefore(p, anchor)); }
    else { (anchor.parentNode || this.stage).insertBefore(g, anchor); }
    nodes.forEach((n) => n.remove());
    const ids = single ? made.map((p) => p.getAttribute("data-hv-id")) : [g.getAttribute("data-hv-id")];
    this.selection = new Set(ids); this.artboardSelected = false;
    this._renderSelection(); this._renderInspector(); this._renderLayers();
    setStatus(`${ops[op]} → ${made.length} path${made.length > 1 ? "s" : ""}.`, 2500);
  },
};
