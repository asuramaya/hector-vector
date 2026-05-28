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
export function collectAnchors(svg) {
  const out = [];
  const skip = (el) => el.closest(".hv-handles") || el.closest(".hv-overlay") || el.classList.contains("hv-artboard");
  svg.querySelectorAll("path").forEach((el) => {
    if (skip(el)) return;
    const segs = parsePath(el.getAttribute("d") || "");
    el._hvSegs = segs;
    segs.forEach((s) => {
      if (!s.end) return;
      out.push({ x: s.end.x, y: s.end.y, set: (nx, ny) => { s.end.x = nx; s.end.y = ny; el.setAttribute("d", serializeSegs(el._hvSegs)); } });
    });
  });
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
