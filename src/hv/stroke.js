// hv core — GEOMETRIC stroker (Epic S). Turn a stroked path `d` into the FILLED
// outline of the band the stroke paints — analytically, no Canvas2D. Pure.
//
// Why not just rasterStroke (hv/raster.js)? That route is path → Canvas2D stroke →
// coverage BITMAP → marching squares. Two quantizations (the bitmap pixel grid + the
// marching grid), it needs a browser canvas (so it can't be unit-tested in Node), and
// a hairline stroke relative to the bbox loses coverage in the bitmap. This route is
// analytic: it builds the stroke band as a UNION of simple convex pieces — one quad
// per flattened segment, a wedge/disc per join, a cap per open end — all wound the
// same handedness, so a NON-ZERO winding test over their edges IS the union (overlaps
// never cancel, the inner hole of a closed stroke stays empty). Marching squares then
// traces that analytic predicate (its edge bisection snaps the boundary to ~7 bits of
// a cell against the TRUE geometry, not a bitmap), and the shared fitcurve core refits
// each loop to minimal cubics — same clean output as the booleans.
//
// Pure + DOM-free → it runs (and is unit-tested) in plain Node, and the per-vertex
// half-width is a parameter, so the variable-width version (Width tool) drops straight
// in by interpolating `hw` along the polyline instead of holding it constant.

import { parsePath } from "./path.js";
import { marchingSquares } from "./contour.js";

const unit = (a, b) => { const x = b.x - a.x, y = b.y - a.y, L = Math.hypot(x, y); return L > 1e-12 ? { x: x / L, y: y / L } : { x: 0, y: 0 }; };
const leftN = (d) => ({ x: -d.y, y: d.x });   // unit normal 90° to the left of `d`

// ---- flatten a path `d` to polylines: [{ pts:[{x,y}…], closed }] ----
function midpt(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
function distToLine(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy);
  if (L < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs((dx * (a.y - p.y) - (a.x - p.x) * dy) / L);
}
function flattenCubic(p0, p1, p2, p3, tol, out, depth = 0) {
  if (depth > 18 || distToLine(p1, p0, p3) + distToLine(p2, p0, p3) <= tol) { out.push(p3); return; }
  const ab = midpt(p0, p1), bc = midpt(p1, p2), cd = midpt(p2, p3);
  const abc = midpt(ab, bc), bcd = midpt(bc, cd), abcd = midpt(abc, bcd);
  flattenCubic(p0, ab, abc, abcd, tol, out, depth + 1);
  flattenCubic(abcd, bcd, cd, p3, tol, out, depth + 1);
}
function flattenQuad(p0, p1, p2, tol, out, depth = 0) {
  if (depth > 18 || distToLine(p1, p0, p2) <= tol) { out.push(p2); return; }
  const ab = midpt(p0, p1), bc = midpt(p1, p2), abc = midpt(ab, bc);
  flattenQuad(p0, ab, abc, tol, out, depth + 1);
  flattenQuad(abc, bc, p2, tol, out, depth + 1);
}
// Endpoint-arc (SVG A) → sampled points via centre parameterisation.
function flattenArc(cur, s, tol, out) {
  let { rx, ry, rot, laf, sf, end } = s;
  rx = Math.abs(rx); ry = Math.abs(ry);
  if (rx < 1e-9 || ry < 1e-9) { out.push({ x: end.x, y: end.y }); return; }
  const phi = (rot * Math.PI) / 180, cosP = Math.cos(phi), sinP = Math.sin(phi);
  const dx = (cur.x - end.x) / 2, dy = (cur.y - end.y) / 2;
  const x1 = cosP * dx + sinP * dy, y1 = -sinP * dx + cosP * dy;
  let rxs = rx * rx, rys = ry * ry; const x1s = x1 * x1, y1s = y1 * y1;
  const lam = x1s / rxs + y1s / rys; if (lam > 1) { const k = Math.sqrt(lam); rx *= k; ry *= k; rxs = rx * rx; rys = ry * ry; }
  let co = Math.sqrt(Math.max(0, (rxs * rys - rxs * y1s - rys * x1s) / (rxs * y1s + rys * x1s)));
  if (laf === sf) co = -co;
  const cxp = (co * rx * y1) / ry, cyp = (-co * ry * x1) / rx;
  const cx = cosP * cxp - sinP * cyp + (cur.x + end.x) / 2, cy = sinP * cxp + cosP * cyp + (cur.y + end.y) / 2;
  const ang = (ux, uy, vx, vy) => { const d = (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy)); let a = Math.acos(Math.min(1, Math.max(-1, d))); if (ux * vy - uy * vx < 0) a = -a; return a; };
  const th0 = ang(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry);
  let dth = ang((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry);
  if (!sf && dth > 0) dth -= 2 * Math.PI; else if (sf && dth < 0) dth += 2 * Math.PI;
  const steps = Math.max(2, Math.ceil(Math.abs(dth) / Math.acos(Math.max(0, 1 - tol / Math.max(rx, ry)))));
  for (let i = 1; i <= steps; i++) {
    const th = th0 + (dth * i) / steps, ct = Math.cos(th), st = Math.sin(th);
    out.push({ x: cosP * rx * ct - sinP * ry * st + cx, y: sinP * rx * ct + cosP * ry * st + cy });
  }
}
export function flattenSubpaths(d, tol = 0.25) {
  const segs = parsePath(d);
  const subs = []; let cur = null, pts = null, start = null;
  const flush = (closed) => { if (pts && pts.length) subs.push({ pts, closed }); pts = null; };
  for (const s of segs) {
    if (s.t === "M") { flush(false); pts = [{ x: s.end.x, y: s.end.y }]; cur = { x: s.end.x, y: s.end.y }; start = { ...cur }; }
    else if (!pts) continue;
    else if (s.t === "L") { pts.push({ x: s.end.x, y: s.end.y }); cur = { x: s.end.x, y: s.end.y }; }
    else if (s.t === "C") { flattenCubic(cur, s.c1, s.c2, s.end, tol, pts); cur = { x: s.end.x, y: s.end.y }; }
    else if (s.t === "Q") { flattenQuad(cur, s.c1, s.end, tol, pts); cur = { x: s.end.x, y: s.end.y }; }
    else if (s.t === "A") { flattenArc(cur, s, tol, pts); cur = { x: s.end.x, y: s.end.y }; }
    else if (s.t === "Z") { flush(true); cur = start ? { ...start } : cur; }
  }
  flush(false);
  return subs;
}

// ---- stroke geometry: emit the band as a union of same-handed convex polygons ----
function pushPoly(out, pts) {
  if (pts.length < 3) return;
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p.x * q.y - q.x * p.y; }
  if (Math.abs(a) < 1e-9) return;
  out.push(a < 0 ? pts.slice().reverse() : pts);   // force one handedness so the nonzero union never cancels
}
function addDisc(c, r, out) {
  const K = 24, pts = [];
  for (let i = 0; i < K; i++) { const a = (i / K) * 2 * Math.PI; pts.push({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) }); }
  pushPoly(out, pts);
}
function lineX(P, dP, Q, dQ) {
  const den = dP.x * dQ.y - dP.y * dQ.x; if (Math.abs(den) < 1e-9) return null;
  const a = ((Q.x - P.x) * dQ.y - (Q.y - P.y) * dQ.x) / den;
  return { x: P.x + a * dP.x, y: P.y + a * dP.y };
}
// Join at vertex V. `hw` is { l, r } half-widths at V (left/right of the travel
// direction) — equal for a uniform stroke, unequal for a variable/asymmetric one.
function addJoin(V, Pp, Pn, hw, join, miterLimit, out) {
  const inDir = unit(Pp, V), outDir = unit(V, Pn);
  const turn = inDir.x * outDir.y - inDir.y * outDir.x;
  if (Math.abs(turn) < 1e-7) return;                 // collinear → quads already meet flush
  if (join === "round") { addDisc(V, Math.max(hw.l, hw.r), out); return; }   // disc ⊆ stroke; covers the convex gap
  const s = turn > 0 ? -1 : 1;                        // sign putting the wedge on the CONVEX (gap) side
  const sw = s > 0 ? hw.l : hw.r;                     // +leftN is the left side → use hw.l
  const lin = leftN(inDir), lou = leftN(outDir);
  const Pin = { x: V.x + s * sw * lin.x, y: V.y + s * sw * lin.y };
  const Pout = { x: V.x + s * sw * lou.x, y: V.y + s * sw * lou.y };
  if (join === "miter") {
    const apex = lineX(Pin, inDir, Pout, outDir);
    if (apex && Math.hypot(apex.x - V.x, apex.y - V.y) / Math.max(sw, 1e-6) <= miterLimit) { pushPoly(out, [V, Pin, apex, Pout]); return; }
  }
  pushPoly(out, [V, Pin, Pout]);                      // bevel (also the miter-limit fallback)
}
function addCap(E, outDir, hw, cap, out) {
  if (cap === "butt") return;
  const l = leftN(outDir), R = Math.max(hw.l, hw.r);
  const c1 = { x: E.x + hw.l * l.x, y: E.y + hw.l * l.y }, c2 = { x: E.x - hw.r * l.x, y: E.y - hw.r * l.y };
  if (cap === "square") { pushPoly(out, [c1, { x: c1.x + R * outDir.x, y: c1.y + R * outDir.y }, { x: c2.x + R * outDir.x, y: c2.y + R * outDir.y }, c2]); return; }
  if (cap === "round") {
    const K = 10, a0 = Math.atan2(l.y, l.x), pts = [c1];
    for (let k = 1; k < K; k++) { const a = a0 - (k * Math.PI) / K; pts.push({ x: E.x + R * Math.cos(a), y: E.y + R * Math.sin(a) }); }   // sweep through +outDir
    pts.push(c2); pushPoly(out, pts);
  }
}
// Emit every band piece for one CLEAN polyline (dedup + close handled by the caller).
// `hwAt(i)` → { l, r } half-widths at point i — a constant for Epic S, a profile sample
// for the Width tool (Epic W). Quads are trapezoids so width may differ per endpoint.
function strokePieces(P, closed, hwAt, cap, join, miterLimit, out) {
  const n = P.length;
  if (n < 2) { if (n === 1 && cap === "round") { const h = hwAt(0); addDisc(P[0], Math.max(h.l, h.r), out); } return; }
  const segCount = closed ? n : n - 1;
  for (let i = 0; i < segCount; i++) {
    const A = P[i], B = P[(i + 1) % n], d = unit(A, B);
    if (!d.x && !d.y) continue;
    const a = hwAt(i), b = hwAt((i + 1) % n), nx = -d.y, ny = d.x;
    pushPoly(out, [
      { x: A.x + nx * a.l, y: A.y + ny * a.l }, { x: B.x + nx * b.l, y: B.y + ny * b.l },   // left side (+leftN)
      { x: B.x - nx * b.r, y: B.y - ny * b.r }, { x: A.x - nx * a.r, y: A.y - ny * a.r },   // right side (−leftN)
    ]);
  }
  const jStart = closed ? 0 : 1, jEnd = closed ? n : n - 1;
  for (let i = jStart; i < jEnd; i++) addJoin(P[i % n], P[(i - 1 + n) % n], P[(i + 1) % n], hwAt(i % n), join, miterLimit, out);
  if (!closed) {
    addCap(P[0], unit(P[1], P[0]), flipLR(hwAt(0)), cap, out);              // start: outward back off the path (L/R swap)
    addCap(P[n - 1], unit(P[n - 2], P[n - 1]), hwAt(n - 1), cap, out);
  }
}
const flipLR = (h) => ({ l: h.r, r: h.l });   // the start cap faces the opposite way, so its left/right swap
// Dedup a flattened polyline + drop the closing-duplicate vertex of a closed loop.
function cleanPolyline(pts, closed) {
  const P = [];
  for (const p of pts) { const q = P[P.length - 1]; if (!q || Math.hypot(p.x - q.x, p.y - q.y) > 1e-7) P.push(p); }
  if (closed && P.length > 1 && Math.hypot(P[0].x - P[P.length - 1].x, P[0].y - P[P.length - 1].y) <= 1e-7) P.pop();
  return P;
}

// ---- dashing: split a polyline into the painted dash runs (each an open polyline) ----
function dashPolyline(pts, closed, dash, offset) {
  const pat = dash.filter((v) => v >= 0); if (!pat.length) return [{ pts, closed }];
  const arr = pat.length % 2 ? pat.concat(pat) : pat;     // odd-length pattern repeats to even
  const total = arr.reduce((a, b) => a + b, 0); if (total <= 0) return [{ pts, closed }];
  const P = closed ? pts.concat([pts[0]]) : pts;
  // walk the offset into the pattern: find starting dash index + remaining length
  let off = ((offset || 0) % total + total) % total, di = 0;
  while (off >= arr[di]) { off -= arr[di]; di = (di + 1) % arr.length; }
  let remain = arr[di] - off, on = di % 2 === 0;
  const runs = []; let curRun = on ? [{ ...P[0] }] : null;
  for (let i = 0; i < P.length - 1; i++) {
    let a = P[i]; const b = P[i + 1];
    let segLen = Math.hypot(b.x - a.x, b.y - a.y);
    while (segLen > 1e-9 && remain < segLen) {
      const t = remain / segLen, cut = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      if (on) { curRun.push(cut); runs.push(curRun); curRun = null; } else { curRun = [cut]; }
      a = cut; segLen -= remain;
      di = (di + 1) % arr.length; remain = arr[di]; on = !on;
    }
    remain -= segLen;
    if (on) (curRun || (curRun = [{ ...a }])).push({ ...b });
  }
  if (on && curRun && curRun.length > 1) runs.push(curRun);
  return runs.map((r) => ({ pts: r, closed: false }));
}

// ---- nonzero-winding field over the band polygons (y-banded edges for speed) ----
function windingField(polys) {
  const edges = []; let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const poly of polys) for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    x0 = Math.min(x0, a.x); y0 = Math.min(y0, a.y); x1 = Math.max(x1, a.x); y1 = Math.max(y1, a.y);
    if (a.y !== b.y) edges.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y });
  }
  if (!edges.length) return null;
  const H = y1 - y0 || 1, nb = Math.max(8, Math.min(512, Math.round(Math.sqrt(edges.length))));
  const bi = (y) => Math.max(0, Math.min(nb - 1, Math.floor(((y - y0) / H) * nb)));
  const bands = Array.from({ length: nb }, () => []);
  for (let k = 0; k < edges.length; k++) { const e = edges[k], lo = bi(Math.min(e.ay, e.by)), hi = bi(Math.max(e.ay, e.by)); for (let b = lo; b <= hi; b++) bands[b].push(k); }
  const inside = (x, y) => {
    const band = bands[bi(y)]; let w = 0;
    for (let m = 0; m < band.length; m++) {
      const e = edges[band[m]];
      if ((e.ay <= y) === (e.by <= y)) continue;            // half-open: doesn't straddle the scanline
      const xc = e.ax + ((y - e.ay) / (e.by - e.ay)) * (e.bx - e.ax);
      if (xc > x) w += e.by > e.ay ? 1 : -1;                // +x ray, signed crossing
    }
    return w !== 0;
  };
  const pad = Math.max(x1 - x0, y1 - y0) * 0.01 + 1;
  return { inside, bbox: { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad } };
}

// Subdivide each segment so no edge is longer than `maxSeg` — keeps original vertices
// (corners/joins intact) but adds interior points so a width PROFILE sampled per-vertex
// varies smoothly along otherwise-straight runs (a plain line has only 2 vertices).
function densify(P, closed, maxSeg) {
  const n = P.length, out = [], last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const A = P[i], B = P[(i + 1) % n]; out.push(A);
    const L = Math.hypot(B.x - A.x, B.y - A.y), steps = Math.max(1, Math.ceil(L / maxSeg));
    for (let k = 1; k < steps; k++) out.push({ x: A.x + (B.x - A.x) * (k / steps), y: A.y + (B.y - A.y) * (k / steps) });
  }
  if (!closed) out.push(P[n - 1]);
  return out;
}
// Arc-length parameter t∈[0,1] for each point of a clean polyline (perimeter for closed).
function arcParams(P, closed) {
  const n = P.length, L = new Array(n); L[0] = 0; let tot = 0;
  for (let i = 1; i < n; i++) { tot += Math.hypot(P[i].x - P[i - 1].x, P[i].y - P[i - 1].y); L[i] = tot; }
  if (closed) tot += Math.hypot(P[0].x - P[n - 1].x, P[0].y - P[n - 1].y);
  return L.map((l) => (tot > 0 ? l / tot : 0));
}

// Stroke `d` (absolute, in the same space as `width`) → the filled outline path `d`
// (minimal cubics, nonzero). `opts`: { width, cap, join, miter, dash:[…], dashOffset, res,
//   widthAt }. `widthAt(t)` (t = arc length along each subpath, 0..1) returns either a full
// width number or { l, r } half-widths — the Width tool's variable/asymmetric profile; when
// present, `width` is just the fallback/peak and dashing is ignored (a width-stroke is solid).
// Returns "" when there's nothing to paint. Pure — usable in Node.
export function strokeOutline(d, opts = {}) {
  const width = +opts.width || 0, hw = width / 2;
  const widthAt = typeof opts.widthAt === "function" ? opts.widthAt : null;
  if (!d || (!(hw > 0) && !widthAt)) return "";
  const cap = opts.cap || "butt", join = opts.join || "miter", miter = opts.miter > 0 ? opts.miter : 4;
  const dash = !widthAt && opts.dash && opts.dash.some((v) => v > 0) ? opts.dash : null, dashOffset = opts.dashOffset || 0;
  const norm = (v) => (typeof v === "number" ? { l: v / 2, r: v / 2 } : { l: +v.l || 0, r: +v.r || 0 });
  const peak = widthAt ? Math.max(hw, 0.5) : hw;     // resolution driver (thinnest meaningful feature)
  const tol = Math.max(0.12, peak * 0.04);
  const polys = [];
  for (const sub of flattenSubpaths(d, tol)) {
    if (sub.pts.length < (sub.closed ? 1 : 2)) continue;
    if (dash) {
      for (const run of dashPolyline(sub.pts, sub.closed, dash, dashOffset)) strokePieces(cleanPolyline(run.pts, false), false, () => ({ l: hw, r: hw }), cap, join, miter, polys);
    } else if (widthAt) {
      let P = cleanPolyline(sub.pts, sub.closed);
      let tot = 0; for (let i = 1; i < P.length; i++) tot += Math.hypot(P[i].x - P[i - 1].x, P[i].y - P[i - 1].y);
      P = densify(P, sub.closed, Math.max(0.5, Math.min(8, tot / 160)));   // ~160 samples so the profile reads smoothly
      const ts = arcParams(P, sub.closed);
      strokePieces(P, sub.closed, (i) => norm(widthAt(ts[i])), cap, join, miter, polys);
    } else {
      strokePieces(cleanPolyline(sub.pts, sub.closed), sub.closed, () => ({ l: hw, r: hw }), cap, join, miter, polys);
    }
  }
  const field = windingField(polys); if (!field) return "";
  const bb = field.bbox, big = Math.max(bb.x1 - bb.x0, bb.y1 - bb.y0);
  const res = opts.res || Math.max(240, Math.min(2000, Math.round((2.6 * big) / Math.max(peak, 0.4))));
  return marchingSquares(field.inside, bb, res);
}
