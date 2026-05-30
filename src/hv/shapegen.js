// hv core — parametric "live shapes". Every shape the tools create is a <path> tagged
// with data-hv-shape + a handful of data-hv-* params; regenShape() rebuilds its `d` from
// those params. Because a shape is born a path, there is never a rect/ellipse -> path
// conversion step: the node tool edits it directly, and hand-editing simply drops the
// metadata (freezeShape) so it becomes a plain freeform path.
//
// All kinds size by a common bounding box (bx,by,bw,bh) so the draw-drag and the W/H
// transform fields drive every kind uniformly; kind-specific params shape the geometry
// inside that box.

import { nfmt } from "./path.js";

const f = (x, y) => `${nfmt(x)} ${nfmt(y)}`;
const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

// ---- corner rounding: trim back `corner` along each edge and round the vertex with a
// quadratic through it. pts is a closed ring of vertices; corner<=0 → plain polygon. ----
function roundedRing(pts, corner) {
  const n = pts.length;
  if (n < 3) return "";
  if (!(corner > 0)) {
    let s = `M${f(pts[0].x, pts[0].y)}`;
    for (let i = 1; i < n; i++) s += ` L${f(pts[i].x, pts[i].y)}`;
    return s + " Z";
  }
  const enter = [], exit = [];
  for (let i = 0; i < n; i++) {
    const cur = pts[i], prev = pts[(i - 1 + n) % n], next = pts[(i + 1) % n];
    const dp = Math.max(dist(cur, prev), 1e-6), dn = Math.max(dist(cur, next), 1e-6);
    enter[i] = lerp(cur, prev, Math.min(corner, dp / 2) / dp);
    exit[i] = lerp(cur, next, Math.min(corner, dn / 2) / dn);
  }
  let s = `M${f(exit[0].x, exit[0].y)}`;
  for (let i = 1; i < n; i++) s += ` L${f(enter[i].x, enter[i].y)} Q${f(pts[i].x, pts[i].y)} ${f(exit[i].x, exit[i].y)}`;
  s += ` L${f(enter[0].x, enter[0].y)} Q${f(pts[0].x, pts[0].y)} ${f(exit[0].x, exit[0].y)} Z`;
  return s;
}

// ---- rounded rectangle with independent corner radii [tl, tr, br, bl] ----
export function roundedRectD(x, y, w, h, radii) {
  const lim = Math.min(Math.abs(w), Math.abs(h)) / 2;
  const r = (radii || [0, 0, 0, 0]).map((v) => Math.max(0, Math.min(v || 0, lim)));
  const [tl, tr, br, bl] = r;
  if (!tl && !tr && !br && !bl) return `M${f(x, y)} L${f(x + w, y)} L${f(x + w, y + h)} L${f(x, y + h)} Z`;
  const A = (rx, ex, ey) => `A${nfmt(rx)} ${nfmt(rx)} 0 0 1 ${f(ex, ey)}`;
  return `M${f(x + tl, y)} L${f(x + w - tr, y)} ${A(tr, x + w, y + tr)}` +
    ` L${f(x + w, y + h - br)} ${A(br, x + w - br, y + h)}` +
    ` L${f(x + bl, y + h)} ${A(bl, x, y + h - bl)}` +
    ` L${f(x, y + tl)} ${A(tl, x + tl, y)} Z`;
}

// regular N-gon inscribed in the bbox ellipse (rx=bw/2, ry=bh/2), first vertex at top,
// rotated by `rot` degrees, corners rounded by `corner`.
export function polygonD(cx, cy, rx, ry, sides, rot, corner) {
  const n = Math.max(3, Math.round(sides || 3));
  const r0 = (-90 + (rot || 0)) * Math.PI / 180, step = 2 * Math.PI / n;
  const pts = [];
  for (let i = 0; i < n; i++) { const a = r0 + i * step; pts.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) }); }
  return roundedRing(pts, corner);
}

// star with `points` tips; inner vertices at `inset` (0..1) of the radius.
export function starD(cx, cy, rx, ry, points, inset, rot, corner) {
  const n = Math.max(3, Math.round(points || 5));
  const k = Math.max(0.05, Math.min(0.95, inset == null ? 0.5 : inset));
  const r0 = (-90 + (rot || 0)) * Math.PI / 180, step = Math.PI / n;
  const pts = [];
  for (let i = 0; i < 2 * n; i++) {
    const a = r0 + i * step, out = i % 2 === 0;
    const sx = out ? rx : rx * k, sy = out ? ry : ry * k;
    pts.push({ x: cx + sx * Math.cos(a), y: cy + sy * Math.sin(a) });
  }
  return roundedRing(pts, corner);
}

const onEll = (cx, cy, rx, ry, deg) => { const a = deg * Math.PI / 180; return { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) }; };

// Cubic-bézier approximation of an elliptical arc from a0..a1 (degrees), split into
// <=90° pieces (kappa = 4/3·tan(Δ/4)). Emits " C … C …" (no leading M). Ellipses are
// built from these so their NODES are smooth bézier anchors with in/out handles —
// identical to pen points, and fully node-editable (vs opaque SVG `A` arc endpoints).
function arcBezier(cx, cy, rx, ry, a0, a1) {
  const s = a0 * Math.PI / 180, e = a1 * Math.PI / 180, sweep = e - s;
  const n = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
  const step = sweep / n;
  let out = "";
  for (let i = 0; i < n; i++) {
    const t0 = s + i * step, t1 = t0 + step, k = (4 / 3) * Math.tan((t1 - t0) / 4);
    const p0x = cx + rx * Math.cos(t0), p0y = cy + ry * Math.sin(t0);
    const p3x = cx + rx * Math.cos(t1), p3y = cy + ry * Math.sin(t1);
    const c1x = p0x - k * rx * Math.sin(t0), c1y = p0y + k * ry * Math.cos(t0);
    const c2x = p3x + k * rx * Math.sin(t1), c2y = p3y - k * ry * Math.cos(t1);
    out += ` C${f(c1x, c1y)} ${f(c2x, c2y)} ${f(p3x, p3y)}`;
  }
  return out;
}

// full ellipse / pie / arc / ring. start..end in degrees (0 = +x, clockwise with y-down);
// a zero span means a full ellipse. inner (0..1) carves a concentric hole / annulus.
export function ellipseD(cx, cy, rx, ry, start, end, inner) {
  const ir = Math.max(0, Math.min(0.95, inner || 0));
  const span = ((((end || 0) - (start || 0)) % 360) + 360) % 360;
  const full = span < 0.001;
  if (full) {
    // start at the top (-90°) so the four anchors land at top / right / bottom / left
    const top = onEll(cx, cy, rx, ry, -90);
    const outer = `M${f(top.x, top.y)}${arcBezier(cx, cy, rx, ry, -90, 270)} Z`;
    if (!ir) return outer;
    const ax = rx * ir, ay = ry * ir, itop = onEll(cx, cy, ax, ay, -90);   // inner reversed → hole
    return outer + ` M${f(itop.x, itop.y)}${arcBezier(cx, cy, ax, ay, 270, -90)} Z`;
  }
  const oS = onEll(cx, cy, rx, ry, start);
  if (!ir) {   // pie wedge from the centre
    return `M${f(cx, cy)} L${f(oS.x, oS.y)}${arcBezier(cx, cy, rx, ry, start, end)} Z`;
  }
  const ax = rx * ir, ay = ry * ir, iE = onEll(cx, cy, ax, ay, end);   // annular sector
  return `M${f(oS.x, oS.y)}${arcBezier(cx, cy, rx, ry, start, end)} L${f(iE.x, iE.y)}${arcBezier(cx, cy, ax, ay, end, start)} Z`;
}

// ---- data model ----------------------------------------------------------------

// numeric data-attr read with a fallback
const dnum = (n, k, d) => { const v = n.getAttribute("data-hv-" + k); return v == null || v === "" ? d : parseFloat(v); };

export function isLiveShape(n) { return n && n.tagName && n.tagName.toLowerCase() === "path" && n.hasAttribute("data-hv-shape"); }
export function shapeKind(n) { return isLiveShape(n) ? n.getAttribute("data-hv-shape") : null; }

// read the bounding box every kind sizes by
export function shapeBox(n) { return { x: dnum(n, "bx", 0), y: dnum(n, "by", 0), w: dnum(n, "bw", 0), h: dnum(n, "bh", 0) }; }

// read a kind's per-corner rect radii as [tl,tr,br,bl] (single value broadcasts)
export function rectRadii(n) {
  const raw = (n.getAttribute("data-hv-r") || "0").trim().split(/[\s,]+/).map(Number);
  if (raw.length === 1) return [raw[0], raw[0], raw[0], raw[0]];
  return [raw[0] || 0, raw[1] || 0, raw[2] || 0, raw[3] || 0];
}

// regenerate `d` from the params; returns the d string (and writes it).
export function regenShape(n) {
  if (!isLiveShape(n)) return n.getAttribute("d") || "";
  const kind = n.getAttribute("data-hv-shape");
  const b = shapeBox(n), cx = b.x + b.w / 2, cy = b.y + b.h / 2, rx = b.w / 2, ry = b.h / 2;
  let d = "";
  if (kind === "rect") d = roundedRectD(b.x, b.y, b.w, b.h, rectRadii(n));
  else if (kind === "poly") d = polygonD(cx, cy, rx, ry, dnum(n, "sides", 5), dnum(n, "rot", 0), dnum(n, "corner", 0));
  else if (kind === "star") d = starD(cx, cy, rx, ry, dnum(n, "points", 5), dnum(n, "inset", 0.5), dnum(n, "rot", 0), dnum(n, "corner", 0));
  else if (kind === "ellipse") d = ellipseD(cx, cy, rx, ry, dnum(n, "start", 0), dnum(n, "end", 0), dnum(n, "inner", 0));
  if (d) n.setAttribute("d", d);
  return d;
}

// set one param (data-hv-<key>) and regenerate
export function setShapeParam(n, key, value) {
  if (value == null) n.removeAttribute("data-hv-" + key);
  else n.setAttribute("data-hv-" + key, typeof value === "number" ? nfmt(value) : String(value));
  return regenShape(n);
}

// write the bounding box (drag-resize / W,H fields) and regenerate
export function setShapeBox(n, x, y, w, h) {
  n.setAttribute("data-hv-bx", nfmt(x)); n.setAttribute("data-hv-by", nfmt(y));
  n.setAttribute("data-hv-bw", nfmt(w)); n.setAttribute("data-hv-bh", nfmt(h));
  return regenShape(n);
}

// freeze a live shape into a plain freeform path (node-edit / boolean / flatten): keep the
// `d`, drop every parametric attr so it stops auto-regenerating.
export function freezeShape(n) {
  if (!n || !n.attributes) return;
  for (const a of [...n.attributes]) if (a.name.startsWith("data-hv-") && a.name !== "data-hv-id") n.removeAttribute(a.name);
}

// pretty name for the layers panel / status
export function shapeKindName(n) {
  return { rect: "Rectangle", poly: "Polygon", star: "Star", ellipse: "Ellipse" }[shapeKind(n)] || null;
}
