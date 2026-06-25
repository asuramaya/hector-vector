// Path-construction tools (Epic B): Shape Builder · Scissors · Knife · Eraser. All four
// reuse the proven engine — the raster mask + marching-squares + bézier-refit trace the
// booleans/pathfinder use (so results are minimal cubics), the geometric stroker (Epic S)
// builds the eraser/knife bands, and pen-anchor splitting (hv/shapes.js) does the scissors
// cut. Object.assign MIXIN — `this === editor`.
//
// Each tool is a thin pointer handler (_xDown) that gathers the drag/click and delegates to
// a pure, directly-callable CORE (shapeBuilderPaint / scissorsCut / knifeCut / eraseSweep) —
// so the cores are unit-drivable without simulating pointers.
import { SVG_NS, shapeToAbsPath, rasterMask, marchingSquares, strokeOutline, nfmt,
  pathToAnchors, subOf, splitCubicInsert, penPathD } from "../../hv/index.js";
import { setStatus } from "../../app.js";

export const builderMixin = {
  // client → stage-user point (CTM sampled at drag start; drags are short).
  _bPt(m, ev) { return new DOMPoint(ev.clientX, ev.clientY).matrixTransform(m.inverse()); },
  // Capture a pointer drag into a stage-space polyline; onMove(pts) live, onUp(pts,ev) commits.
  _bDrag(e, onMove, onUp) {
    const m = this.stage.getScreenCTM(); if (!m) return;
    const pts = [this._bPt(m, e)];
    const move = (ev) => { pts.push(this._bPt(m, ev)); onMove(pts, ev); };
    const up = (ev) => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); this._bTrail(null); onUp(pts, ev); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
    onMove(pts, e);
  },
  // A faint live trail in the overlay (knife line / eraser sweep / builder drag).
  _bTrail(pts, kind) {
    const ov = this._overlayEl(); if (!ov) return;
    ov.querySelectorAll(".hv-btrail").forEach((n) => n.remove());
    if (!pts || pts.length < 1) return;
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("class", "hv-btrail hv-btrail-" + (kind || "line"));
    p.setAttribute("d", "M" + pts.map((q) => `${nfmt(q.x)} ${nfmt(q.y)}`).join(" L"));
    ov.appendChild(p);
  },
  _mkPath(d, src, fillOverride, ruleOverride) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("data-hv-id", "n" + (++this.idSeq));
    path.setAttribute("d", d); path.setAttribute("fill-rule", ruleOverride || "nonzero");
    path.setAttribute("fill", fillOverride || (src && src.getAttribute("fill")) || "#000000");
    if (src) for (const a of ["fill-opacity", "stroke", "stroke-width", "stroke-linejoin", "stroke-linecap", "opacity"]) { const v = src.getAttribute(a); if (v) path.setAttribute(a, v); }
    return path;
  },
  _polyD(pts) { return pts.length ? "M" + pts.map((q) => `${nfmt(q.x)} ${nfmt(q.y)}`).join(" L") : ""; },
  _unit(a, b) { const x = b.x - a.x, y = b.y - a.y, L = Math.hypot(x, y); return L > 1e-9 ? { x: x / L, y: y / L } : { x: 1, y: 0 }; },
  _polyBBox(pts, pad) { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); } return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad }; },
  _reselectExisting() { this.selection = new Set([...this.selection].filter((id) => this.nodeById(id))); },
  // Filled artwork the eraser/knife act on: the selection if any, else all filled shapes.
  _eraseTargets() { const sel = this._fillableSelection(); if (sel.length) return sel; return this._artworkNodes().filter((n) => !this.isRaster(n) && shapeToAbsPath(n) && (n.getAttribute("fill") || "none") !== "none"); },

  // ---------------- Shape Builder (B.1) ----------------
  // CORE: paint a list of stage-space sample points across 2+ overlapping selected shapes.
  // A point's "face" is its membership signature (which shapes cover it) — exactly Pathfinder
  // Divide's faces. Merge keeps the painted faces (one path); Alt keeps everything else.
  shapeBuilderPaint(points, alt) {
    const nodes = this._fillableSelection();
    if (nodes.length < 2) { setStatus("Select 2+ overlapping shapes, then paint regions with Shape Builder.", 3500); return; }
    nodes.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1);   // back → front
    const N = nodes.length, bb = this._pad(this._bboxUnion(nodes), 0.02);
    const masks = nodes.map((n) => rasterMask([{ d: shapeToAbsPath(n, n.getCTM()), rule: n.getAttribute("fill-rule") }], bb, 1200));
    const sig = (x, y) => { let s = 0; for (let i = 0; i < N; i++) if (masks[i].inside(x, y)) s |= (1 << i); return s; };
    const touched = new Set();
    for (const p of points) { const s = sig(p.x, p.y); if (s) touched.add(s); }
    if (!touched.size) { setStatus("Paint over the overlapping regions to build a shape.", 3000); return; }
    const pred = alt
      ? (x, y) => { const s = sig(x, y); return s !== 0 && !touched.has(s); }
      : (x, y) => touched.has(sig(x, y));
    const big = Math.max(bb.x1 - bb.x0, bb.y1 - bb.y0), res = Math.max(180, Math.min(420, Math.round(big / 3)));
    const d = marchingSquares(pred, bb, res);
    if (!d) { setStatus(alt ? "That would remove everything." : "Nothing painted.", 2800); return; }
    const src = alt ? nodes[0] : nodes[N - 1];
    this._commitBoolean(nodes, d, "nonzero", src, alt ? "Shape Builder — removed painted regions." : "Shape Builder — merged painted regions.");
  },
  _builderDown(e) {
    e.stopPropagation(); e.preventDefault();
    if (this._fillableSelection().length < 2) { setStatus("Select 2+ overlapping shapes, then paint regions with Shape Builder.", 3500); return; }
    this._bDrag(e, (pts) => this._bTrail(pts, "build"), (pts, ev) => this.shapeBuilderPaint(pts, ev.altKey));
  },

  // ---------------- Scissors (B.2) ----------------
  // CORE: cut the nearest path to (sx,sy) within tolUser. Closed → reopens into one open path;
  // open → splits into two. Curves keep their handles (cuts on the pen-anchor model).
  scissorsCut(sx, sy, tolUser) {
    const h = this._nearestPathHit(sx, sy, tolUser);
    if (!h) { setStatus("Click directly on a path with the Scissors.", 2800); return; }
    const el = h.el, pa = pathToAnchors(el);
    if (!pa.editable) { setStatus("This path has arcs/quadratics — can't scissor it.", 3000); return; }
    const anchors = pa.anchors, subs = pa.subs;
    let cut;
    if (h.mode === "segment") { splitCubicInsert(anchors, subs, h.i, h.t); cut = h.i + 1; }
    else cut = h.k;
    const sb = subOf(anchors, subs, cut);
    const outs = []; let splitTwo = null;
    for (const u of subs) {
      const sa = anchors.slice(u.start, u.start + u.count).map((a) => ({ x: a.x, y: a.y, in: a.in, out: a.out }));
      if (u.start !== sb.start) { outs.push({ pts: sa, closed: u.closed }); continue; }
      const lc = cut - u.start;
      if (u.closed) {
        const rot = sa.slice(lc).concat(sa.slice(0, lc));
        rot[0] = { x: sa[lc].x, y: sa[lc].y, in: null, out: sa[lc].out };          // open start: no incoming handle
        rot.push({ x: sa[lc].x, y: sa[lc].y, in: sa[lc].in, out: null });          // open end: keeps the incoming handle
        outs.push({ pts: rot, closed: false });
      } else {
        const first = sa.slice(0, lc + 1).map((a) => ({ ...a })); first[first.length - 1].out = null;
        const second = sa.slice(lc).map((a) => ({ ...a })); second[0] = { ...second[0], in: null };
        if (subs.length === 1) splitTwo = [first, second];     // a lone open path → two separate objects
        else { outs.push({ pts: first, closed: false }); outs.push({ pts: second, closed: false }); }
      }
    }
    this.push("Scissors");
    const made = [];
    if (splitTwo) {
      for (const half of splitTwo) { const p = this._mkPath(penPathD(half, false), el); el.parentNode.insertBefore(p, el); made.push(p.getAttribute("data-hv-id")); }
      el.remove();
    } else {
      const d = outs.map((o) => penPathD(o.pts, o.closed)).join(" ");
      const p = this._mkPath(d, el); el.parentNode.insertBefore(p, el); el.remove(); made.push(p.getAttribute("data-hv-id"));
    }
    this.selection = new Set(made); this.artboardSelected = false;
    this._renderSelection(); this._renderInspector(); this._renderLayers();
    setStatus(splitTwo ? "Split into two paths." : "Path opened at the cut.", 2000);
  },
  _scissorsDown(e) {
    e.stopPropagation(); e.preventDefault();
    const m = this.stage.getScreenCTM(); if (!m) return;
    const sp = this._bPt(m, e), k = Math.hypot(m.a, m.b) || 1;
    this.scissorsCut(sp.x, sp.y, 8 / k);
  },
  // Nearest path feature (anchor wins over segment) within tol — restricted to data-hv-id paths.
  _nearestPathHit(x, y, tol) {
    const els = [...this.stage.querySelectorAll("path[data-hv-id]")].filter((el) => el.getAttribute("data-hv-locked") !== "1");
    let best = null;
    for (const el of els) {
      const pa = pathToAnchors(el); if (!pa.editable || pa.anchors.length < 2) continue;
      let m = null; try { m = el.getCTM(); } catch {}
      const toL = m ? (px, py) => new DOMPoint(px, py).matrixTransform(m.inverse()) : (px, py) => ({ x: px, y: py });
      const q = toL(x, y);
      for (let ki = 0; ki < pa.anchors.length; ki++) { const a = pa.anchors[ki]; const d = Math.hypot(a.x - q.x, a.y - q.y); if (d <= tol && (!best || best.mode !== "anchor" || d < best.dist)) best = { el, mode: "anchor", k: ki, dist: d }; }
      if (best && best.mode === "anchor") continue;             // an anchor in range already wins for this path
      for (const u of pa.subs) {
        const segCount = u.closed ? u.count : u.count - 1;
        for (let j = 0; j < segCount; j++) {
          const ai = u.start + j, bi = (j + 1 < u.count) ? u.start + j + 1 : u.start, A = pa.anchors[ai], B = pa.anchors[bi];
          const P1 = A.out || A, P2 = B.in || B;
          for (let s = 0; s <= 24; s++) { const t = s / 24, u1 = 1 - t, cx = u1 * u1 * u1 * A.x + 3 * u1 * u1 * t * P1.x + 3 * u1 * t * t * P2.x + t * t * t * B.x, cy = u1 * u1 * u1 * A.y + 3 * u1 * u1 * t * P1.y + 3 * u1 * t * t * P2.y + t * t * t * B.y; const d = Math.hypot(cx - q.x, cy - q.y); if (d <= tol && (!best || d < best.dist)) best = { el, mode: "segment", i: ai, t, dist: d }; }
        }
      }
    }
    return best;
  },

  // ---------------- Eraser (B.4) ----------------
  _eraserR: 14,
  adjustEraser(d) { this._eraserR = Math.max(2, Math.min(200, this._eraserR + d)); setStatus(`Eraser ${this._eraserR}px — drag over filled shapes to erase.`, 1500); },
  // CORE: subtract the band swept by `pts` (round brush radius r) from every crossed filled shape.
  eraseSweep(pts, r) {
    let bandD = this._polyD(pts);
    if (pts.length < 2) bandD = `M${nfmt(pts[0].x - 0.01)} ${nfmt(pts[0].y)} L${nfmt(pts[0].x + 0.01)} ${nfmt(pts[0].y)}`;
    const band = strokeOutline(bandD, { width: 2 * r, cap: "round", join: "round" }); if (!band) return;
    const bb = this._pad(this._polyBBox(pts, r), 0.02);
    const bandMask = rasterMask([{ d: band, rule: "nonzero" }], bb, 1400);
    this.push("Erase");
    let changed = 0;
    for (const n of this._eraseTargets()) {
      const nbb = this._nodeBBoxUser(n);
      if (nbb.x1 < bb.x0 || nbb.x0 > bb.x1 || nbb.y1 < bb.y0 || nbb.y0 > bb.y1) continue;
      const sm = rasterMask([{ d: shapeToAbsPath(n, n.getCTM()), rule: n.getAttribute("fill-rule") }], nbb, 1200);
      const full = this._pad(nbb, 0.04), big = Math.max(full.x1 - full.x0, full.y1 - full.y0);
      const res = Math.max(200, Math.min(700, Math.round(2.6 * big / Math.max(r, 2))));
      const out = marchingSquares((x, y) => sm.inside(x, y) && !bandMask.inside(x, y), full, res);
      if (out === shapeToAbsPath(n)) continue;
      changed++;
      if (!out) { n.remove(); continue; }
      const p = this._mkPath(out, n); n.parentNode.insertBefore(p, n); n.remove();
    }
    if (!changed) { this.undo(); setStatus("Eraser didn't cross a filled shape.", 2500); return; }
    this._reselectExisting(); this._renderSelection(); this._renderInspector(); this._renderLayers();
    setStatus(`Erased through ${changed} shape${changed > 1 ? "s" : ""}.`, 2000);
  },
  _eraserDown(e) { e.stopPropagation(); e.preventDefault(); const r = this._eraserR; this._bDrag(e, (pts) => this._bTrail(pts, "erase"), (pts) => this.eraseSweep(pts, r)); },

  // ---------------- Knife (B.3) ----------------
  // CORE: cut every crossed filled shape along `cut` (a stage-space polyline). The cut's ends
  // are extended far past the artwork so the open path divides the plane into two clean sides;
  // each crossed shape splits into the two sides as separate objects. alt → straight cut.
  knifeCut(cut, alt) {
    if (alt && cut.length >= 2) cut = [cut[0], cut[cut.length - 1]];
    if (cut.length < 2) { setStatus("Drag the Knife across a shape to cut it.", 2500); return; }
    const scene = this.stage.viewBox.baseVal, big = Math.max(scene.width, scene.height) * 4;
    const d0 = this._unit(cut[1], cut[0]), dn = this._unit(cut[cut.length - 2], cut[cut.length - 1]);
    const ext = [{ x: cut[0].x + d0.x * big, y: cut[0].y + d0.y * big }, ...cut, { x: cut[cut.length - 1].x + dn.x * big, y: cut[cut.length - 1].y + dn.y * big }];
    const sideOf = (x, y) => {
      let bd = Infinity, sgn = 1;
      for (let i = 1; i < ext.length; i++) { const a = ext[i - 1], b = ext[i], dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy; let u = L2 > 0 ? ((x - a.x) * dx + (y - a.y) * dy) / L2 : 0; u = Math.max(0, Math.min(1, u)); const px = a.x + dx * u, py = a.y + dy * u, dd = Math.hypot(x - px, y - py); if (dd < bd) { bd = dd; sgn = (dx * (y - a.y) - dy * (x - a.x)) >= 0 ? 1 : -1; } }
      return sgn;
    };
    this.push("Knife");
    let cutN = 0;
    for (const n of this._eraseTargets()) {
      const nbb = this._pad(this._nodeBBoxUser(n), 0.04), big2 = Math.max(nbb.x1 - nbb.x0, nbb.y1 - nbb.y0);
      const sm = rasterMask([{ d: shapeToAbsPath(n, n.getCTM()), rule: n.getAttribute("fill-rule") }], nbb, 1200);
      const res = Math.max(180, Math.min(520, Math.round(big2 / 1.5)));
      const dPos = marchingSquares((x, y) => sm.inside(x, y) && sideOf(x, y) > 0, nbb, res);
      const dNeg = marchingSquares((x, y) => sm.inside(x, y) && sideOf(x, y) < 0, nbb, res);
      if (!dPos || !dNeg) continue;                       // the cut didn't actually divide this shape
      cutN++;
      const a = this._mkPath(dPos, n), b = this._mkPath(dNeg, n);
      n.parentNode.insertBefore(a, n); n.parentNode.insertBefore(b, n); n.remove();
    }
    if (!cutN) { this.undo(); setStatus("Knife didn't cross a shape end-to-end.", 2500); return; }
    this._reselectExisting(); this._renderSelection(); this._renderInspector(); this._renderLayers();
    setStatus(`Cut ${cutN} shape${cutN > 1 ? "s" : ""}.`, 2000);
  },
  _knifeDown(e) { e.stopPropagation(); e.preventDefault(); this._bDrag(e, (pts) => this._bTrail(pts, "knife"), (pts, ev) => this.knifeCut(pts, ev.altKey)); },
};
