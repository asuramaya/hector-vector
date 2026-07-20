// Envelope distort (Epic D.2/D.3): a draggable RxC control-point grid bends everything
// inside it — Illustrator's "Envelope Distort > Make with Mesh" and "...with Top Object",
// scoped to a fixed grid size (no add/remove row-or-column UI; a deferred enhancement).
//
// Model — same regen/expand shape as Warp (D.1): `<g data-hv-env='{"rows","cols","bbox",
// "pts","items"}'>`. `bbox` is the REST rectangle (defines the u,v parameterization of any
// point in the wrapped geometry); `pts[row][col]` are the grid's CURRENT (possibly dragged)
// positions, seeded to their rest positions on creation. `items` holds each wrapped shape's
// ORIGINAL absolute path `d` + paint, exactly like Warp. Regen resamples each item's path
// (Warp's own `resample`, copied here — Warp doesn't export it) and maps every sample point
// through a bilinear interpolation over the grid CELL it falls in (a standard free-form-
// deformation lattice, not a single global bilinear — that's what lets a 3x3+ grid bend a
// shape in more than one place at once), then refits to cubics. Editing a point regenerates;
// Expand just drops the spec — the children are already real geometry.
//
// D.3 "with top object": seeds the grid's rest positions to the TOPMOST selected shape's
// ACTUAL SILHOUETTE (not just its bbox) and consumes that shape — the rest of the selection
// gets warped to fit inside it. The runtime deformation (envXY/envPathD below) is already a
// generic bilinear cell-by-cell lattice that has no idea whether its rest grid is a plain
// rectangle or something stranger — so conforming to the silhouette is purely a matter of
// choosing where those 9 grid points START, not a change to how warping works. silhouetteGrid()
// below does that: cast a ray from the shape's centroid through each boundary grid point's
// plain-bbox position (its ANGLE is all that's kept — a stand-in for "which side of the shape
// this grid point belongs to"), take the farthest crossing with the outline, then fill the one
// interior point via a discrete Coons (transfinite) blend of the four now-conformed edges. This
// is exact for star-shaped-from-centroid outlines (circles, blobs, most badge/star shapes) and
// degrades gracefully — falling back to the plain bbox position for any ray that fails to find
// a crossing — rather than failing outright on a stranger (e.g. crescent) shape. Content outside
// the rest silhouette still clamps to the boundary rather than extrapolating, same as before.
//
// A on-canvas "Envelope" tool shows the grid as draggable handles (same idiom as the Width
// tool's on-spine stops) while an envelope group is selected. Object.assign MIXIN.
import { SVG_NS, shapeToAbsPath, flattenSubpaths, nfmt } from "../../hv/index.js";
import { fitLoop, cubicsToPath } from "../../hv/fitcurve.js";
import { setStatus } from "../../app.js";

export const ENV_ROWS = 3, ENV_COLS = 3;   // fixed v1 grid size — see the file banner

// Evenly resample a polyline to N points (identical to warp.js's copy — not shared/exported
// since neither tool file depends on the other; see that file for why this exists at all).
function resample(pts, closed, N) {
  if (pts.length < 2) return pts.slice();
  const P = closed ? pts.concat([pts[0]]) : pts;
  const seg = []; let tot = 0;
  for (let i = 1; i < P.length; i++) { const L = Math.hypot(P[i].x - P[i - 1].x, P[i].y - P[i - 1].y); seg.push(L); tot += L; }
  if (tot < 1e-9) return pts.slice();
  const out = [], div = closed ? N : N - 1;
  for (let k = 0; k < N; k++) {
    const target = (k / div) * tot;
    let acc = 0, i = 0;
    while (i < seg.length && acc + seg[i] < target) { acc += seg[i]; i++; }
    if (i >= seg.length) { out.push({ x: P[P.length - 1].x, y: P[P.length - 1].y }); continue; }
    const u = seg[i] > 0 ? (target - acc) / seg[i] : 0;
    out.push({ x: P[i].x + (P[i + 1].x - P[i].x) * u, y: P[i].y + (P[i + 1].y - P[i].y) * u });
  }
  return out;
}
// Map (x,y) through the grid: find which cell (x,y) falls in (by its bbox-relative u,v,
// clamped to the grid's own extent) and bilinearly blend that cell's 4 CURRENT corners.
function envXY(x, y, bbox, pts, rows, cols) {
  const w = (bbox.x1 - bbox.x0) || 1, h = (bbox.y1 - bbox.y0) || 1;
  let u = (x - bbox.x0) / w, v = (y - bbox.y0) / h;
  u = Math.max(0, Math.min(1, u)); v = Math.max(0, Math.min(1, v));
  const fc = u * (cols - 1), fr = v * (rows - 1);
  const c0 = Math.max(0, Math.min(cols - 2, Math.floor(fc)));
  const r0 = Math.max(0, Math.min(rows - 2, Math.floor(fr)));
  const tu = fc - c0, tv = fr - r0;
  const p00 = pts[r0][c0], p01 = pts[r0][c0 + 1], p10 = pts[r0 + 1][c0], p11 = pts[r0 + 1][c0 + 1];
  const topX = p00.x + (p01.x - p00.x) * tu, topY = p00.y + (p01.y - p00.y) * tu;
  const botX = p10.x + (p11.x - p10.x) * tu, botY = p10.y + (p11.y - p10.y) * tu;
  return [topX + (botX - topX) * tv, topY + (botY - topY) * tv];
}
function envPathD(d, spec) {
  const subs = flattenSubpaths(d, 0.4);
  const parts = [];
  for (const s of subs) {
    if (s.pts.length < 2) continue;
    const dense = resample(s.pts, s.closed, Math.max(80, Math.min(200, s.pts.length * 8)));
    const mapped = dense.map((p) => envXY(p.x, p.y, spec.bbox, spec.pts, spec.rows, spec.cols));
    if (s.closed) {
      const segs = fitLoop(mapped, 0.6);
      if (segs.length) parts.push(cubicsToPath(segs));
    } else {
      parts.push("M" + mapped.map((p) => nfmt(p[0]) + " " + nfmt(p[1])).join(" L"));
    }
  }
  return parts.join(" ");
}
function restGrid(bbox, rows, cols) {
  const w = bbox.x1 - bbox.x0, h = bbox.y1 - bbox.y0, pts = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) row.push({ x: bbox.x0 + (cols > 1 ? c / (cols - 1) : 0) * w, y: bbox.y0 + (rows > 1 ? r / (rows - 1) : 0) * h });
    pts.push(row);
  }
  return pts;
}
// Shoelace centroid — winding-direction-invariant (both the numerator and the area flip
// sign together for a CW vs CCW loop, so the quotient doesn't).
function polyCentroid(poly) {
  let cx = 0, cy = 0, area = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const cross = a.x * b.y - b.x * a.y;
    area += cross; cx += (a.x + b.x) * cross; cy += (a.y + b.y) * cross;
  }
  area *= 0.5;
  if (Math.abs(area) < 1e-9) {
    let sx = 0, sy = 0; for (const p of poly) { sx += p.x; sy += p.y; }
    return { x: sx / poly.length, y: sy / poly.length };
  }
  return { x: cx / (6 * area), y: cy / (6 * area) };
}
// Cast a ray from `origin` at `angle` against closed polygon `poly`; return the FARTHEST
// crossing (the outermost one, for the rare case a ray crosses more than once on a
// concave outline) or null if the ray never meets the boundary at all.
function rayHit(origin, angle, poly) {
  const Dx = Math.cos(angle), Dy = Math.sin(angle);
  let best = null, bestT = -Infinity;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const A = poly[i], B = poly[(i + 1) % n];
    const Ex = B.x - A.x, Ey = B.y - A.y;
    const denom = Dx * Ey - Dy * Ex;
    if (Math.abs(denom) < 1e-9) continue;
    const ax = A.x - origin.x, ay = A.y - origin.y;
    const t = (ax * Ey - ay * Ex) / denom;
    const s = (ax * Dy - ay * Dx) / denom;
    if (t >= 0 && s >= -1e-6 && s <= 1 + 1e-6 && t > bestT) { bestT = t; best = { x: origin.x + Dx * t, y: origin.y + Dy * t }; }
  }
  return best;
}
// D.3: a grid whose OUTER ring conforms to `d`'s actual silhouette (see the file banner for
// the approach) instead of sitting on `bbox`'s plain rectangle. Returns null (caller falls
// back to restGrid) if `d` has no usable closed subpath — an open path, or a degenerate one.
function silhouetteGrid(d, bbox, rows, cols) {
  const subs = flattenSubpaths(d, 0.4).filter((s) => s.closed && s.pts.length >= 3);
  if (!subs.length) return null;
  // biggest loop by area — the outer boundary of a compound path (e.g. a letterform with
  // counters); ignoring holes here is the same simplification the plain bbox already made.
  let poly = subs[0].pts, bestArea = 0;
  for (const s of subs) {
    let a = 0; for (let i = 0; i < s.pts.length; i++) { const p = s.pts[i], q = s.pts[(i + 1) % s.pts.length]; a += p.x * q.y - q.x * p.y; }
    a = Math.abs(a);
    if (a > bestArea) { bestArea = a; poly = s.pts; }
  }
  const centroid = polyCentroid(poly);
  const base = restGrid(bbox, rows, cols);
  const pts = base.map((row) => row.map((p) => ({ ...p })));
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (r !== 0 && r !== rows - 1 && c !== 0 && c !== cols - 1) continue;   // interior: filled in below
    const rp = base[r][c];
    const ang = Math.atan2(rp.y - centroid.y, rp.x - centroid.x);
    const hit = rayHit(centroid, ang, poly);
    if (hit) pts[r][c] = hit;
  }
  // Interior points: discrete Coons (transfinite) blend of the four now-conformed edges —
  // the same formula a real coons-patch fit reduces to once the boundary itself is fixed.
  const c00 = pts[0][0], c10 = pts[0][cols - 1], c01 = pts[rows - 1][0], c11 = pts[rows - 1][cols - 1];
  for (let r = 1; r < rows - 1; r++) for (let c = 1; c < cols - 1; c++) {
    const u = cols > 1 ? c / (cols - 1) : 0, v = rows > 1 ? r / (rows - 1) : 0;
    const top = pts[0][c], bot = pts[rows - 1][c], left = pts[r][0], right = pts[r][cols - 1];
    const bx = (1 - v) * top.x + v * bot.x + (1 - u) * left.x + u * right.x
      - ((1 - u) * (1 - v) * c00.x + u * (1 - v) * c10.x + (1 - u) * v * c01.x + u * v * c11.x);
    const by = (1 - v) * top.y + v * bot.y + (1 - u) * left.y + u * right.y
      - ((1 - u) * (1 - v) * c00.y + u * (1 - v) * c10.y + (1 - u) * v * c01.y + u * v * c11.y);
    pts[r][c] = { x: bx, y: by };
  }
  return pts;
}

export const envelopeMixin = {
  isEnvelopeGroup(n) { return !!(n && n.getAttribute && n.hasAttribute("data-hv-env")); },
  _envSpec(g) { try { return JSON.parse(g.getAttribute("data-hv-env")); } catch { return null; } },
  _envSet(g, spec) { g.setAttribute("data-hv-env", JSON.stringify(spec)); },
  _envGroupOf(n) { if (this.isEnvelopeGroup(n)) return n; const g = n && n.closest && n.closest("[data-hv-env]"); return g && this.stage && this.stage.contains(g) ? g : null; },
  _envItemFromNode(n) {
    const d = shapeToAbsPath(n, n.getCTM()); if (!d) return null;
    return {
      d, fill: n.getAttribute("fill") || "#000000", fillRule: n.getAttribute("fill-rule") || null,
      stroke: n.getAttribute("stroke") || null, sw: n.getAttribute("stroke-width") != null ? +n.getAttribute("stroke-width") : null,
      op: n.getAttribute("opacity") != null ? +n.getAttribute("opacity") : null, fillOp: n.getAttribute("fill-opacity") != null ? +n.getAttribute("fill-opacity") : null,
    };
  },
  // Rebuild the envelope's children from its spec — same shape as _regenWarp.
  _regenEnvelope(g) {
    const spec = this._envSpec(g); if (!spec) return;
    [...g.children].forEach((c) => c.remove());
    for (const it of spec.items) {
      const d = envPathD(it.d, spec); if (!d) continue;
      const p = document.createElementNS(SVG_NS, "path");
      p.setAttribute("data-hv-id", "n" + (++this.idSeq));
      p.setAttribute("d", d);
      p.setAttribute("fill", it.fill);
      if (it.fillRule) p.setAttribute("fill-rule", it.fillRule);
      if (it.stroke && it.stroke !== "none") { p.setAttribute("stroke", it.stroke); if (it.sw != null) p.setAttribute("stroke-width", nfmt(it.sw)); }
      if (it.op != null) p.setAttribute("opacity", nfmt(it.op));
      if (it.fillOp != null) p.setAttribute("fill-opacity", nfmt(it.fillOp));
      g.appendChild(p);
    }
  },
  _buildEnvelopeGroup(items, bbox, insertAnchor, restPts) {
    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("data-hv-id", "n" + (++this.idSeq));
    const pts = restPts || restGrid(bbox, ENV_ROWS, ENV_COLS);
    // restPts is stored separately from pts (the CURRENT, draggable positions) so "Reset
    // envelope" can put a with-top-object envelope back on its silhouette instead of
    // collapsing it to the plain bbox rectangle — see resetEnvelope().
    this._envSet(g, { rows: ENV_ROWS, cols: ENV_COLS, bbox, pts, restPts: pts, items });
    const parent = insertAnchor.parentNode, ov = this._overlayEl();
    const ref = insertAnchor.nextSibling;
    if (ref && ref.parentNode === parent && ref !== ov) parent.insertBefore(g, ref); else parent.appendChild(g);
    this._regenEnvelope(g);
    return g;
  },
  // Object > Make envelope (D.2): a grid over the selection's own combined bounds.
  makeEnvelope() {
    if (!this.stage) return;
    const sel = this._fillableSelection();
    if (!sel.length) { setStatus("Select one or more filled shapes to add an envelope.", 3000); return; }
    const items = sel.map((n) => this._envItemFromNode(n)).filter(Boolean);
    if (!items.length) { setStatus("None of the selection has a fillable outline to envelope.", 3000); return; }
    const bbox = this._bboxUnion(sel);
    this.push("Envelope");
    const all = [...this.stage.querySelectorAll("[data-hv-id]")];
    sel.sort((a, b) => all.indexOf(a) - all.indexOf(b));
    const anchor = sel[sel.length - 1];
    const g = this._buildEnvelopeGroup(items, bbox, anchor);
    sel.forEach((n) => n.remove());
    this.selection = new Set([g.getAttribute("data-hv-id")]); this.artboardSelected = false;
    this._renderSelection(); this._renderInspector(); this._renderLayers();
    setStatus("Envelope added — pick the Envelope tool and drag the grid points.", 3000);
  },
  // Object > Make envelope with top object (D.3): the topmost selected shape LENDS its
  // bounds as the grid's rest rectangle, then is consumed (removed) — everything else in
  // the selection gets warped to fit inside where it was.
  makeEnvelopeWithTopObject() {
    if (!this.stage) return;
    const sel = this._fillableSelection();
    if (sel.length < 2) { setStatus("Select 2+ shapes — the topmost lends its bounds as the envelope.", 3000); return; }
    const all = [...this.stage.querySelectorAll("[data-hv-id]")];
    sel.sort((a, b) => all.indexOf(a) - all.indexOf(b));
    const top = sel[sel.length - 1];
    const rest = sel.slice(0, -1);
    const items = rest.map((n) => this._envItemFromNode(n)).filter(Boolean);
    if (!items.length) { setStatus("Nothing left to warp once the top object becomes the envelope.", 3000); return; }
    const bbox = this._bboxUnion([top]);
    const topD = shapeToAbsPath(top, top.getCTM());
    const silPts = topD ? silhouetteGrid(topD, bbox, ENV_ROWS, ENV_COLS) : null;
    this.push("Envelope with top object");
    const g = this._buildEnvelopeGroup(items, bbox, top, silPts);
    sel.forEach((n) => n.remove());   // the warped shapes AND the consumed top object
    this.selection = new Set([g.getAttribute("data-hv-id")]); this.artboardSelected = false;
    this._renderSelection(); this._renderInspector(); this._renderLayers();
    setStatus("Envelope seeded from the top object's bounds — drag the grid to refine.", 3200);
  },
  setEnvelopePoint(g, row, col, x, y) {
    const spec = this._envSpec(g); if (!spec || !spec.pts[row] || !spec.pts[row][col]) return;
    spec.pts[row][col] = { x, y };
    this._envSet(g, spec); this._regenEnvelope(g);
  },
  resetEnvelope(g) {
    const spec = this._envSpec(g); if (!spec) return;
    this.push("Reset envelope");
    // restPts (the silhouette, for a with-top-object envelope) if present — falling back to
    // a plain bbox rectangle for a plain make-envelope, or for a document saved before this
    // field existed.
    spec.pts = spec.restPts || restGrid(spec.bbox, spec.rows, spec.cols);
    this._envSet(g, spec); this._regenEnvelope(g);
    this._renderSelection(); this._mountEnvelopeHandles();
  },
  expandEnvelope(g) {
    g = g || this.selectedNodes().map((n) => this._envGroupOf(n)).find(Boolean);
    if (!this.isEnvelopeGroup(g)) return;
    this.push("Expand envelope");
    g.removeAttribute("data-hv-env");
    this._unmountEnvelopeHandles();
    this._renderSelection(); this._renderInspector(); this._renderLayers();
    setStatus("Envelope expanded to a group.", 1800);
  },

  // ---- Envelope tool: drag a grid point (nearest-within-threshold, screen-space aware) ----
  _envDown(e) {
    e.stopPropagation(); e.preventDefault();
    const g = this.selectedNodes().map((n) => this._envGroupOf(n)).find(Boolean);
    if (!g) { setStatus("Select an envelope (Actions ▾ → Make envelope) to drag its grid.", 3000); return; }
    const spec = this._envSpec(g); if (!spec) return;
    const m = this.stageCTM(); if (!m) return;
    const inv = m.inverse();
    const toUser = (ev) => new DOMPoint(ev.clientX, ev.clientY).matrixTransform(inv);
    const k = Math.hypot(m.a, m.b) || 1;
    const p0 = toUser(e);
    let best = null, bestD = Infinity;
    for (let r = 0; r < spec.rows; r++) for (let c = 0; c < spec.cols; c++) {
      const pt = spec.pts[r][c], d = Math.hypot(pt.x - p0.x, pt.y - p0.y);
      if (d < bestD) { bestD = d; best = { r, c }; }
    }
    if (!best || bestD > 14 / k) return;
    let pushed = false;
    const move = (ev) => {
      const q = toUser(ev);
      if (!pushed) { if (Math.hypot(q.x - p0.x, q.y - p0.y) < 0.5) return; this.push("Envelope"); pushed = true; }
      this.setEnvelopePoint(g, best.r, best.c, q.x, q.y);
      this._mountEnvelopeHandles();
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); if (pushed) this._renderInspector(); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  },
  _unmountEnvelopeHandles() { const ov = this._overlayEl(); if (ov) ov.querySelectorAll(".hv-envhandles").forEach((n) => n.remove()); },
  _mountEnvelopeHandles() {
    this._unmountEnvelopeHandles();
    if (this.tool !== "envelope" || !this.stage) return;
    const g = this.selectedNodes().map((n) => this._envGroupOf(n)).find(Boolean); if (!g) return;
    const spec = this._envSpec(g); if (!spec) return;
    const ov = this._overlayEl(); if (!ov) return;
    const m = this.stageCTM(); const k = m ? Math.hypot(m.a, m.b) || 1 : 1;
    const layer = document.createElementNS(SVG_NS, "g"); layer.setAttribute("class", "hv-envhandles");
    const line = (a, b) => { const l = document.createElementNS(SVG_NS, "line"); l.setAttribute("class", "hv-envgridline"); l.setAttribute("x1", a.x); l.setAttribute("y1", a.y); l.setAttribute("x2", b.x); l.setAttribute("y2", b.y); return l; };
    for (let r = 0; r < spec.rows; r++) for (let c = 0; c < spec.cols; c++) {
      const p = spec.pts[r][c];
      if (c < spec.cols - 1) layer.appendChild(line(p, spec.pts[r][c + 1]));
      if (r < spec.rows - 1) layer.appendChild(line(p, spec.pts[r + 1][c]));
    }
    const rad = 4 / k;
    for (let r = 0; r < spec.rows; r++) for (let c = 0; c < spec.cols; c++) {
      const p = spec.pts[r][c];
      const h = document.createElementNS(SVG_NS, "rect"); h.setAttribute("class", "hv-envhandle");
      h.setAttribute("x", p.x - rad); h.setAttribute("y", p.y - rad); h.setAttribute("width", 2 * rad); h.setAttribute("height", 2 * rad);
      layer.appendChild(h);
    }
    ov.appendChild(layer);
  },
};
