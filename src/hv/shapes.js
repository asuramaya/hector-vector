// hv core — shape ⇄ path conversion, primitive-shape creation/sizing, and
// draggable-anchor collection for the node tool.

import { SVG_NS } from "./constants.js";
import { nfmt, parsePath, serializeSegs } from "./path.js";
import { currentTranslate } from "./transform.js";

// Convert a shape element to an absolute path `d` (baking in any translate),
// used to build the fill-test outline for booleans / invert-space.
export function shapeToAbsPath(el) {
  const t = currentTranslate(el);
  const off = (x, y) => `${nfmt(x + t.x)} ${nfmt(y + t.y)}`;
  const num = (a) => parseFloat(el.getAttribute(a)) || 0;
  const tag = el.tagName.toLowerCase();
  if (tag === "path") {
    const segs = parsePath(el.getAttribute("d") || "");
    if (t.x || t.y) segs.forEach((s) => {
      if (s.end) { s.end.x += t.x; s.end.y += t.y; }
      if (s.c1) { s.c1.x += t.x; s.c1.y += t.y; }
      if (s.c2) { s.c2.x += t.x; s.c2.y += t.y; }
    });
    return serializeSegs(segs);
  }
  if (tag === "rect") {
    const x = num("x"), y = num("y"), w = num("width"), h = num("height");
    return `M${off(x, y)} L${off(x + w, y)} L${off(x + w, y + h)} L${off(x, y + h)} Z`;
  }
  if (tag === "polygon" || tag === "polyline") {
    const pts = (el.getAttribute("points") || "").trim().split(/[\s,]+/).map(Number);
    if (pts.length < 4) return "";
    let s = `M${off(pts[0], pts[1])}`;
    for (let i = 2; i + 1 < pts.length; i += 2) s += ` L${off(pts[i], pts[i + 1])}`;
    return s + " Z";
  }
  if (tag === "circle") {
    const cx = num("cx"), cy = num("cy"), r = num("r");
    return `M${off(cx - r, cy)} A${nfmt(r)} ${nfmt(r)} 0 1 0 ${off(cx + r, cy)} A${nfmt(r)} ${nfmt(r)} 0 1 0 ${off(cx - r, cy)} Z`;
  }
  if (tag === "ellipse") {
    const cx = num("cx"), cy = num("cy"), rx = num("rx"), ry = num("ry");
    return `M${off(cx - rx, cy)} A${nfmt(rx)} ${nfmt(ry)} 0 1 0 ${off(cx + rx, cy)} A${nfmt(rx)} ${nfmt(ry)} 0 1 0 ${off(cx - rx, cy)} Z`;
  }
  return "";
}

// ---------- primitive shape-tool geometry ----------
export function applyShapeStyle(n, style, isLine) {
  if (isLine) {
    n.setAttribute("fill", "none");
    const col = style.stroke && style.stroke !== "none" ? style.stroke : "#1d1d1f";
    const w = style.strokeWidth > 0 ? style.strokeWidth : 2;
    n.setAttribute("stroke", col); n.setAttribute("stroke-width", nfmt(w));
    n.setAttribute("vector-effect", "non-scaling-stroke");
    n.setAttribute("stroke-linecap", "round");
    return;
  }
  n.setAttribute("fill", style.fill || "#808080");
  if (style.stroke && style.stroke !== "none" && style.strokeWidth > 0) {
    n.setAttribute("stroke", style.stroke); n.setAttribute("stroke-width", nfmt(style.strokeWidth));
    n.setAttribute("vector-effect", "non-scaling-stroke");
    n.setAttribute("stroke-linejoin", "round"); n.setAttribute("stroke-linecap", "round");
  }
}

export function makeShapeNode(tool, p, style) {
  if (tool === "line") {
    const n = document.createElementNS(SVG_NS, "line");
    n.setAttribute("x1", nfmt(p.x)); n.setAttribute("y1", nfmt(p.y));
    n.setAttribute("x2", nfmt(p.x)); n.setAttribute("y2", nfmt(p.y));
    applyShapeStyle(n, style, true);
    return n;
  }
  if (tool === "ellipse") {
    const n = document.createElementNS(SVG_NS, "ellipse");
    n.setAttribute("cx", nfmt(p.x)); n.setAttribute("cy", nfmt(p.y));
    n.setAttribute("rx", 0); n.setAttribute("ry", 0);
    applyShapeStyle(n, style, false);
    return n;
  }
  const n = document.createElementNS(SVG_NS, "rect");
  n.setAttribute("x", nfmt(p.x)); n.setAttribute("y", nfmt(p.y));
  n.setAttribute("width", 0); n.setAttribute("height", 0);
  applyShapeStyle(n, style, false);
  return n;
}

export function sizeShape(tool, n, a, b, constrain) {
  let dx = b.x - a.x, dy = b.y - a.y;
  if (tool === "line") {
    let x2 = b.x, y2 = b.y;
    if (constrain) {                 // snap to 0 / 45 / 90°
      const len = Math.hypot(dx, dy);
      const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      x2 = a.x + Math.cos(ang) * len; y2 = a.y + Math.sin(ang) * len;
    }
    n.setAttribute("x2", nfmt(x2)); n.setAttribute("y2", nfmt(y2));
    return;
  }
  if (constrain) { const m = Math.max(Math.abs(dx), Math.abs(dy)); dx = (dx < 0 ? -1 : 1) * m; dy = (dy < 0 ? -1 : 1) * m; }
  const x = Math.min(a.x, a.x + dx), y = Math.min(a.y, a.y + dy), w = Math.abs(dx), h = Math.abs(dy);
  if (tool === "rect") {
    n.setAttribute("x", nfmt(x)); n.setAttribute("y", nfmt(y));
    n.setAttribute("width", nfmt(w)); n.setAttribute("height", nfmt(h));
  } else {
    n.setAttribute("cx", nfmt(x + w / 2)); n.setAttribute("cy", nfmt(y + h / 2));
    n.setAttribute("rx", nfmt(w / 2)); n.setAttribute("ry", nfmt(h / 2));
  }
}

export function shapeMeaningful(tool, n) {
  if (tool === "line") {
    const dx = (+n.getAttribute("x2")) - (+n.getAttribute("x1"));
    const dy = (+n.getAttribute("y2")) - (+n.getAttribute("y1"));
    return Math.hypot(dx, dy) > 0.5;
  }
  if (tool === "rect") return (+n.getAttribute("width")) > 0.5 && (+n.getAttribute("height")) > 0.5;
  return (+n.getAttribute("rx")) > 0.25 && (+n.getAttribute("ry")) > 0.25;
}

// Gather draggable anchors across the SVG's shapes. Each anchor knows its
// current position and how to write a new position back to the element.
const _anchorSkip = (el) => el.closest(".hv-handles") || el.closest(".hv-overlay") || el.classList.contains("hv-artboard");

// Rich anchor model for <path> elements: each on-curve point exposes its incoming
// and outgoing bezier direction handles (the trailing control of the segment that
// ends here, and the leading control of the one that leaves) so the node tool can
// drag curves, not just move points. moveTo drags the anchor and its handles
// rigidly; setIn/setOut move one handle and optionally mirror the other (smooth).
// Closed paths whose final segment returns to the start share that segment as
// anchor-0's incoming handle (and the last anchor's outgoing handle).
export function pathNodes(svg, accept) {
  const out = [];
  svg.querySelectorAll("path").forEach((el) => {
    if (_anchorSkip(el)) return;
    if (accept && !accept(el)) return;   // focus mode: restrict to the in-scope paths
    const segs = parsePath(el.getAttribute("d") || "");
    el._hvSegs = segs;
    const commit = () => el.setAttribute("d", serializeSegs(el._hvSegs));
    const draw = segs.filter((s) => s.end);     // M + drawing segments, in order
    const n = draw.length;
    if (!n) return;
    const closed = segs[segs.length - 1] && segs[segs.length - 1].t === "Z";
    const wrap = closed && n >= 2 &&
      Math.hypot(draw[n - 1].end.x - draw[0].end.x, draw[n - 1].end.y - draw[0].end.y) < 1e-6;
    const count = wrap ? n - 1 : n;             // the wrap segment is anchor-0's incoming, not its own anchor
    const lead = (s) => (s && (s.t === "C" || s.t === "Q")) ? s.c1 : null;
    const trail = (s) => s ? (s.t === "C" ? s.c2 : (s.t === "Q" ? s.c1 : null)) : null;
    for (let k = 0; k < count; k++) {
      const endSeg = draw[k];
      const inSeg = k >= 1 ? draw[k] : (wrap ? draw[n - 1] : null);
      const outSeg = (k + 1 < n) ? draw[k + 1] : null;
      const inH = trail(inSeg), outH = lead(outSeg);   // live control-point refs (or null)
      const a = endSeg.end;
      out.push({
        el, id: el.getAttribute("data-hv-id"), k, x: a.x, y: a.y, inH, outH,
        moveTo(nx, ny) {
          const dx = nx - a.x, dy = ny - a.y;
          a.x = nx; a.y = ny;
          if (k === 0 && wrap) { draw[n - 1].end.x = nx; draw[n - 1].end.y = ny; }
          if (inH) { inH.x += dx; inH.y += dy; }
          if (outH) { outH.x += dx; outH.y += dy; }
          commit();
        },
        setIn(nx, ny, mirror) {
          if (!inH) return;
          inH.x = nx; inH.y = ny;
          if (mirror && outH) { outH.x = 2 * a.x - nx; outH.y = 2 * a.y - ny; }
          commit();
        },
        setOut(nx, ny, mirror) {
          if (!outH) return;
          outH.x = nx; outH.y = ny;
          if (mirror && inH) { inH.x = 2 * a.x - nx; inH.y = 2 * a.y - ny; }
          commit();
        },
      });
    }
  });
  return out;
}

// Flatten a <path> to an editable pen-anchor list ({x,y,in,out} with absolute
// handle coords, mirroring pathNodes' in/out extraction) plus whether it's closed.
// Lossless round-trip through penPathD for M/L/C paths — `editable` is false when
// the path carries arcs/quadratics (rebuilding would drop them), so callers can
// refuse structural edits (delete/convert) on those.
export function pathToAnchors(el) {
  const s = parsePath(el.getAttribute("d") || "");
  const draw = s.filter((x) => x.end);
  const n = draw.length;
  if (!n) return { anchors: [], closed: false, editable: false };
  const editable = !s.some((x) => x.t === "A" || x.t === "Q");
  const closed = s[s.length - 1] && s[s.length - 1].t === "Z";
  const wrap = closed && n >= 2 &&
    Math.hypot(draw[n - 1].end.x - draw[0].end.x, draw[n - 1].end.y - draw[0].end.y) < 1e-6;
  const count = wrap ? n - 1 : n;
  const lead = (seg) => (seg && seg.t === "C") ? seg.c1 : null;
  const trail = (seg) => (seg && seg.t === "C") ? seg.c2 : null;
  const anchors = [];
  for (let k = 0; k < count; k++) {
    const inSeg = k >= 1 ? draw[k] : (wrap ? draw[n - 1] : null);
    const outSeg = (k + 1 < n) ? draw[k + 1] : null;
    const ih = trail(inSeg), oh = lead(outSeg);
    anchors.push({
      x: draw[k].end.x, y: draw[k].end.y,
      in: ih ? { x: ih.x, y: ih.y } : null,
      out: oh ? { x: oh.x, y: oh.y } : null,
    });
  }
  return { anchors, closed: !!closed, editable };
}

function _cubicAt(p0, p1, p2, p3, t) {
  const u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}

// Nearest editable-path feature to (x,y) within `tol` (user units). Returns the
// closest anchor when one is in range (delete target), else the closest point on a
// segment (insert target with its segment index `i` + parameter `t`), or null.
// `maxPaths` caps how many paths we scan so heavy traced docs don't churn per move.
export function nearestOnPaths(svg, x, y, tol, maxPaths = 300) {
  const paths = svg.querySelectorAll("path");
  if (paths.length > maxPaths) return null;
  let bestA = null, bestS = null;
  paths.forEach((el) => {
    if (_anchorSkip(el)) return;
    const { anchors, closed, editable } = pathToAnchors(el);
    if (!editable || anchors.length < 2) return;
    for (let k = 0; k < anchors.length; k++) {
      const d = Math.hypot(anchors[k].x - x, anchors[k].y - y);
      if (d <= tol && (!bestA || d < bestA.dist)) bestA = { el, mode: "anchor", k, x: anchors[k].x, y: anchors[k].y, dist: d, closed, count: anchors.length };
    }
    const segCount = closed ? anchors.length : anchors.length - 1;
    for (let i = 0; i < segCount; i++) {
      const A = anchors[i], B = anchors[(i + 1) % anchors.length];
      const P1 = A.out || A, P2 = B.in || B;
      const N = 24;
      for (let s = 0; s <= N; s++) {
        const t = s / N, pt = _cubicAt(A, P1, P2, B, t);
        const d = Math.hypot(pt.x - x, pt.y - y);
        if (d <= tol && (!bestS || d < bestS.dist)) bestS = { el, mode: "segment", i, t, x: pt.x, y: pt.y, dist: d };
      }
    }
  });
  return bestA || bestS;     // an anchor in range wins (delete), else a segment (insert)
}

// Insert an anchor into a pen-anchor list on segment i at parameter t (de Casteljau
// split: a straight segment yields a corner, a cubic yields a smooth point and the
// neighbours keep their adjusted handles). Mutates `anchors` in place.
export function splitCubicInsert(anchors, closed, i, t) {
  const n = anchors.length, A = anchors[i], B = anchors[(i + 1) % n];
  if (!A.out && !B.in) {     // straight segment → corner midpoint, halves stay lines
    anchors.splice(i + 1, 0, { x: A.x + (B.x - A.x) * t, y: A.y + (B.y - A.y) * t, in: null, out: null });
    return;
  }
  const P1 = A.out || A, P2 = B.in || B, L = (p, q) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
  const p01 = L(A, P1), p12 = L(P1, P2), p23 = L(P2, B);
  const p012 = L(p01, p12), p123 = L(p12, p23), M = L(p012, p123);
  A.out = { x: p01.x, y: p01.y };
  B.in = { x: p23.x, y: p23.y };
  anchors.splice(i + 1, 0, { x: M.x, y: M.y, in: { x: p012.x, y: p012.y }, out: { x: p123.x, y: p123.y } });
}

// Curvature tool: turn a list of {x,y,corner} points into pen anchors with
// auto-computed Catmull-Rom tangent handles (smooth points), corner points keeping
// null handles. Feed the result to penPathD. Open paths get one-sided end tangents.
export function catmullRomAnchors(pts, closed) {
  const n = pts.length;
  const out = pts.map((p) => ({ x: p.x, y: p.y, in: null, out: null }));
  if (n < 2) return out;
  const f = 1 / 3;
  for (let i = 0; i < n; i++) {
    if (pts[i].corner) continue;
    const prev = closed ? pts[(i - 1 + n) % n] : (i > 0 ? pts[i - 1] : null);
    const next = closed ? pts[(i + 1) % n] : (i < n - 1 ? pts[i + 1] : null);
    if (!prev && !next) continue;
    let dx, dy;
    if (prev && next) { dx = next.x - prev.x; dy = next.y - prev.y; }
    else if (next) { dx = next.x - pts[i].x; dy = next.y - pts[i].y; }
    else { dx = pts[i].x - prev.x; dy = pts[i].y - prev.y; }
    const len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
    if (next) { const d = Math.hypot(next.x - pts[i].x, next.y - pts[i].y); out[i].out = { x: pts[i].x + ux * d * f, y: pts[i].y + uy * d * f }; }
    if (prev) { const d = Math.hypot(pts[i].x - prev.x, pts[i].y - prev.y); out[i].in = { x: pts[i].x - ux * d * f, y: pts[i].y - uy * d * f }; }
  }
  return out;
}

export function collectAnchors(svg, accept) {
  const out = [];
  const skip = (el) => _anchorSkip(el) || (accept && !accept(el));
  svg.querySelectorAll("rect").forEach((el) => {
    if (skip(el)) return;
    const get = () => ({ x: +el.getAttribute("x") || 0, y: +el.getAttribute("y") || 0, w: +el.getAttribute("width") || 0, h: +el.getAttribute("height") || 0 });
    const corner = (xMin, yMin) => {
      const r = get();
      return {
        x: xMin ? r.x : r.x + r.w, y: yMin ? r.y : r.y + r.h,
        set: (nx, ny) => {
          const c = get();
          const ox = xMin ? c.x + c.w : c.x, oy = yMin ? c.y + c.h : c.y;
          const x0 = Math.min(nx, ox), x1 = Math.max(nx, ox), y0 = Math.min(ny, oy), y1 = Math.max(ny, oy);
          el.setAttribute("x", nfmt(x0)); el.setAttribute("y", nfmt(y0));
          el.setAttribute("width", nfmt(x1 - x0)); el.setAttribute("height", nfmt(y1 - y0));
        },
      };
    };
    out.push(corner(true, true), corner(false, true), corner(true, false), corner(false, false));
  });
  svg.querySelectorAll("polygon, polyline").forEach((el) => {
    if (skip(el)) return;
    const pts = (el.getAttribute("points") || "").trim().split(/[\s,]+/).map(Number).filter((v) => !Number.isNaN(v));
    el._hvPts = pts;
    for (let k = 0; k + 1 < pts.length; k += 2) {
      const idx = k;
      out.push({ x: pts[idx], y: pts[idx + 1], set: (nx, ny) => { el._hvPts[idx] = nx; el._hvPts[idx + 1] = ny; el.setAttribute("points", el._hvPts.map(nfmt).join(" ")); } });
    }
  });
  svg.querySelectorAll("circle, ellipse").forEach((el) => {
    if (skip(el)) return;
    out.push({ x: +el.getAttribute("cx") || 0, y: +el.getAttribute("cy") || 0, set: (nx, ny) => { el.setAttribute("cx", nfmt(nx)); el.setAttribute("cy", nfmt(ny)); } });
  });
  svg.querySelectorAll("line").forEach((el) => {
    if (skip(el)) return;
    out.push({ x: +el.getAttribute("x1") || 0, y: +el.getAttribute("y1") || 0, set: (nx, ny) => { el.setAttribute("x1", nfmt(nx)); el.setAttribute("y1", nfmt(ny)); } });
    out.push({ x: +el.getAttribute("x2") || 0, y: +el.getAttribute("y2") || 0, set: (nx, ny) => { el.setAttribute("x2", nfmt(nx)); el.setAttribute("y2", nfmt(ny)); } });
  });
  return out;
}
