// hv core — translate read/write + affine bake-into-geometry (rotate 90° / flip /
// uniform scale). Baking keeps nodes translate-only (so move + node-edit keep
// working) instead of stacking transform attributes.

import { nfmt, parsePath, serializeSegs } from "./path.js";
import { SKIP_TAGS } from "./constants.js";

export function currentTranslate(n) {
  const m = /translate\(\s*([-\d.]+)[ ,]+([-\d.]+)/.exec(n.getAttribute("transform") || "");
  return m ? { x: parseFloat(m[1]), y: parseFloat(m[2]) } : { x: 0, y: 0 };
}

export function setTranslate(n, x, y) { n.setAttribute("transform", `translate(${nfmt(x)} ${nfmt(y)})`); }

export function applyMat(m, x, y) { return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f }; }

export function matForOp(op, cx, cy) {
  switch (op) {
    case "flipH": return { a: -1, b: 0, c: 0, d: 1, e: 2 * cx, f: 0 };
    case "flipV": return { a: 1, b: 0, c: 0, d: -1, e: 0, f: 2 * cy };
    case "rotateCW": return { a: 0, b: 1, c: -1, d: 0, e: cx + cy, f: cy - cx };
    case "rotateCCW": return { a: 0, b: -1, c: 1, d: 0, e: cx - cy, f: cy + cx };
    default: return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  }
}

// Bake an affine transform (in stage space) into a node, keeping it translate-only.
// Recurses into groups, preserving ancestor translates so nested content lands right.
export function bakeMatrixInto(node, m, atx, aty) {
  const tag = node.tagName.toLowerCase();
  if (SKIP_TAGS.has(tag)) return;
  if (tag === "g") {
    const t = currentTranslate(node);
    for (const child of [...node.children]) bakeMatrixInto(child, m, atx + t.x, aty + t.y);
    return;
  }
  const t = currentTranslate(node);
  const f = (x, y) => { const p = applyMat(m, x + t.x + atx, y + t.y + aty); return { x: p.x - atx, y: p.y - aty }; };
  transformShapeGeometry(node, tag, f, m);
  node.removeAttribute("transform");
}

export function transformShapeGeometry(el, tag, f, m) {
  const num = (a) => parseFloat(el.getAttribute(a)) || 0;
  // Per-axis scale magnitudes. For the 90°-rotate / flip matrices these are 1
  // (no size change); for the uniform fit-scale used by Place they are the fit
  // factor — so radii / image dims scale correctly without regressing transforms.
  const sx = Math.hypot(m.a, m.b), sy = Math.hypot(m.c, m.d);
  if (tag === "rect") {
    const p1 = f(num("x"), num("y")), p2 = f(num("x") + num("width"), num("y") + num("height"));
    el.setAttribute("x", nfmt(Math.min(p1.x, p2.x))); el.setAttribute("y", nfmt(Math.min(p1.y, p2.y)));
    el.setAttribute("width", nfmt(Math.abs(p2.x - p1.x))); el.setAttribute("height", nfmt(Math.abs(p2.y - p1.y)));
  } else if (tag === "circle") {
    const c = f(num("cx"), num("cy")); el.setAttribute("cx", nfmt(c.x)); el.setAttribute("cy", nfmt(c.y));
    el.setAttribute("r", nfmt(num("r") * sx));   // uniform scale keeps it a circle
  } else if (tag === "ellipse") {
    const c = f(num("cx"), num("cy"));
    const rx = Math.abs(m.a) * num("rx") + Math.abs(m.c) * num("ry"), ry = Math.abs(m.b) * num("rx") + Math.abs(m.d) * num("ry");
    el.setAttribute("cx", nfmt(c.x)); el.setAttribute("cy", nfmt(c.y)); el.setAttribute("rx", nfmt(rx)); el.setAttribute("ry", nfmt(ry));
  } else if (tag === "line") {
    const a = f(num("x1"), num("y1")), b = f(num("x2"), num("y2"));
    el.setAttribute("x1", nfmt(a.x)); el.setAttribute("y1", nfmt(a.y)); el.setAttribute("x2", nfmt(b.x)); el.setAttribute("y2", nfmt(b.y));
  } else if (tag === "polygon" || tag === "polyline") {
    const pts = (el.getAttribute("points") || "").trim().split(/[\s,]+/).map(Number);
    const out = [];
    for (let i = 0; i + 1 < pts.length; i += 2) { const p = f(pts[i], pts[i + 1]); out.push(nfmt(p.x), nfmt(p.y)); }
    el.setAttribute("points", out.join(" "));
  } else if (tag === "path") {
    const segs = parsePath(el.getAttribute("d") || "");
    const swap = Math.abs(m.a) < 0.5;            // a 90° rotation swaps the x/y axes
    const det = m.a * m.d - m.b * m.c;           // <0 ⇒ reflection (flip)
    for (const s of segs) {
      if (s.c1) s.c1 = f(s.c1.x, s.c1.y);
      if (s.c2) s.c2 = f(s.c2.x, s.c2.y);
      if (s.end) s.end = f(s.end.x, s.end.y);
      if (s.t === "A") {
        s.rx *= sx; s.ry *= sy;                  // scale arc radii (1× for rotate/flip)
        if (swap) { const r = s.rx; s.rx = s.ry; s.ry = r; s.rot = (s.rot + 90) % 360; }
        if (det < 0) { s.sf = s.sf ? 0 : 1; s.rot = (180 - s.rot + 360) % 360; }
      }
    }
    el.setAttribute("d", serializeSegs(segs));
  } else if (tag === "text" || tag === "image") {
    const p = f(num("x"), num("y")); el.setAttribute("x", nfmt(p.x)); el.setAttribute("y", nfmt(p.y));
    if (tag === "image") { el.setAttribute("width", nfmt(num("width") * sx)); el.setAttribute("height", nfmt(num("height") * sy)); }
  }
}
