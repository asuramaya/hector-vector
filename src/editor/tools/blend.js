// Blend tool (Epic L). Interpolate N intermediate shapes between two objects — morphing
// geometry, fill, stroke and opacity from one to the other. A blend is a parametric
// `<g data-hv-blend='{a,b,steps,reverse}'>` (the repeat/width-stroke pattern): the spec
// holds both endpoints (baked path `d` + paint) and the step count, and ALL children are
// generated — the two endpoints (crisp, from their own `d`) plus `steps` interpolated paths
// between them. Editing steps/reverse regenerates; Expand bakes to a plain group; the spec
// lives in data-hv-* (stripped on serialize) while the children are real geometry, so a
// saved blend renders and re-imports as a plain group. Object.assign MIXIN — `this===editor`.
import { SVG_NS, shapeToAbsPath, flattenSubpaths, nfmt } from "../../hv/index.js";
import { setStatus } from "../../app.js";

// ---- colour lerp (RGB; #rgb / #rrggbb / rgb()) ----
function parseColor(c) {
  if (!c || c === "none") return null;
  c = c.trim();
  if (c[0] === "#") { let h = c.slice(1); if (h.length === 3) h = h.split("").map((x) => x + x).join(""); if (h.length >= 6) return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; return null; }
  const m = c.match(/rgba?\(([^)]+)\)/); if (m) { const p = m[1].split(",").map((x) => parseFloat(x)); return [p[0], p[1], p[2]]; }
  return null;
}
function lerpColor(ca, cb, t) {
  const a = parseColor(ca), b = parseColor(cb);
  if (!a || !b) return t < 0.5 ? (ca || cb) : (cb || ca);
  const h = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return "#" + h(a[0] + (b[0] - a[0]) * t) + h(a[1] + (b[1] - a[1]) * t) + h(a[2] + (b[2] - a[2]) * t);
}
const lerpNum = (a, b, t, d) => { const x = a == null ? d : +a, y = b == null ? d : +b; return x + (y - x) * t; };

// Even arc-length resample of a polyline to N points (closed → around the loop).
function resample(pts, closed, N) {
  if (pts.length < 2) return Array.from({ length: N }, () => ({ ...(pts[0] || { x: 0, y: 0 }) }));
  const P = closed ? pts.concat([pts[0]]) : pts;
  const seg = []; let tot = 0;
  for (let i = 1; i < P.length; i++) { const L = Math.hypot(P[i].x - P[i - 1].x, P[i].y - P[i - 1].y); seg.push(L); tot += L; }
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
// Rotation offset aligning closed B to A (minimises Σ squared distance) — reduces twist.
function bestRotation(A, B) {
  let best = 0, bestD = Infinity;
  for (let off = 0; off < B.length; off++) { let d = 0; for (let i = 0; i < A.length; i++) { const b = B[(i + off) % B.length]; d += (A[i].x - b.x) ** 2 + (A[i].y - b.y) ** 2; } if (d < bestD) { bestD = d; best = off; } }
  return best;
}

export const blendMixin = {
  isBlendGroup(n) { return !!(n && n.getAttribute && n.hasAttribute("data-hv-blend")); },
  _blendSpec(g) { try { return JSON.parse(g.getAttribute("data-hv-blend")); } catch { return null; } },
  _blendSet(g, spec) { g.setAttribute("data-hv-blend", JSON.stringify(spec)); },
  _blendGroupOf(n) { if (this.isBlendGroup(n)) return n; const g = n && n.closest && n.closest("[data-hv-blend]"); return g && this.stage && this.stage.contains(g) ? g : null; },
  _blendEndpointSpec(n) {
    const d = shapeToAbsPath(n, n.getCTM()); if (!d) return null;
    return {
      d, fill: n.getAttribute("fill") || "#000000", fillRule: n.getAttribute("fill-rule") || null,
      stroke: n.getAttribute("stroke") || null, sw: n.getAttribute("stroke-width") != null ? +n.getAttribute("stroke-width") : null,
      op: n.getAttribute("opacity") != null ? +n.getAttribute("opacity") : null, fillOp: n.getAttribute("fill-opacity") != null ? +n.getAttribute("fill-opacity") : null,
    };
  },
  _blendPath(d, fill, stroke, sw, op, fillOp, rule) {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("data-hv-id", "n" + (++this.idSeq)); p.setAttribute("d", d);
    p.setAttribute("fill", fill); if (rule) p.setAttribute("fill-rule", rule);
    if (stroke && stroke !== "none") { p.setAttribute("stroke", stroke); if (sw != null) p.setAttribute("stroke-width", nfmt(sw)); }
    if (op != null) p.setAttribute("opacity", nfmt(op));
    if (fillOp != null) p.setAttribute("fill-opacity", nfmt(fillOp));
    return p;
  },
  // Rebuild the blend's children: endpoint A, `steps` interpolated paths, endpoint B.
  _regenBlend(g) {
    const spec = this._blendSpec(g); if (!spec) return;
    [...g.children].forEach((c) => c.remove());
    const A = spec.reverse ? spec.b : spec.a, B = spec.reverse ? spec.a : spec.b;
    const steps = Math.max(1, Math.min(60, spec.steps || 6));
    g.appendChild(this._blendPath(A.d, A.fill, A.stroke, A.sw, A.op, A.fillOp, A.fillRule));
    // matched, resampled point sets per subpath pair (min subpath count)
    const sa = flattenSubpaths(A.d, 0.5), sb = flattenSubpaths(B.d, 0.5), m = Math.min(sa.length, sb.length), pairs = [];
    for (let s = 0; s < m; s++) {
      const closed = sa[s].closed && sb[s].closed;
      const N = Math.max(40, Math.min(180, Math.max(sa[s].pts.length, sb[s].pts.length)));
      const pa = resample(sa[s].pts, sa[s].closed, N); let pb = resample(sb[s].pts, sb[s].closed, N);
      if (closed) { const off = bestRotation(pa, pb); pb = pb.map((_, i) => pb[(i + off) % N]); }
      pairs.push({ pa, pb, closed });
    }
    for (let k = 1; k <= steps; k++) {
      const t = k / (steps + 1);
      let d = "";
      for (const pr of pairs) d += "M" + pr.pa.map((p, i) => { const q = pr.pb[i]; return `${nfmt(p.x + (q.x - p.x) * t)} ${nfmt(p.y + (q.y - p.y) * t)}`; }).join(" L") + (pr.closed ? " Z" : "");
      if (!d) continue;
      g.appendChild(this._blendPath(d,
        lerpColor(A.fill, B.fill, t), A.stroke || B.stroke ? lerpColor(A.stroke, B.stroke, t) : null,
        lerpNum(A.sw, B.sw, t, 1), A.op != null || B.op != null ? lerpNum(A.op, B.op, t, 1) : null,
        A.fillOp != null || B.fillOp != null ? lerpNum(A.fillOp, B.fillOp, t, 1) : null, A.fillRule || B.fillRule));
    }
    g.appendChild(this._blendPath(B.d, B.fill, B.stroke, B.sw, B.op, B.fillOp, B.fillRule));
  },
  // Object > Blend > Make: blend the two selected objects.
  makeBlend() {
    if (!this.stage) return;
    const sel = this._fillableSelection();
    if (sel.length !== 2) { setStatus("Select exactly 2 objects to blend.", 3000); return; }
    const all = [...this.stage.querySelectorAll("[data-hv-id]")];
    sel.sort((a, b) => all.indexOf(a) - all.indexOf(b));
    const a = this._blendEndpointSpec(sel[0]), b = this._blendEndpointSpec(sel[1]);
    if (!a || !b) { setStatus("Both objects need a fillable outline to blend.", 3000); return; }
    const ba = this._nodeBBoxUser(sel[0]), bb = this._nodeBBoxUser(sel[1]);
    const dist = Math.hypot((ba.x0 + ba.x1) / 2 - (bb.x0 + bb.x1) / 2, (ba.y0 + ba.y1) / 2 - (bb.y0 + bb.y1) / 2);
    const sz = Math.max(1, (ba.x1 - ba.x0 + ba.y1 - ba.y0 + bb.x1 - bb.x0 + bb.y1 - bb.y0) / 4);
    const steps = Math.max(1, Math.min(30, Math.round(dist / (sz * 0.4)) || 6));
    this.push("Blend");
    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("data-hv-id", "n" + (++this.idSeq));
    this._blendSet(g, { a, b, steps, reverse: false });
    const back = sel[0], parent = back.parentNode, anchor = back.nextSibling, ov = this._overlayEl();
    if (anchor && anchor.parentNode === parent && anchor !== ov) parent.insertBefore(g, anchor); else parent.appendChild(g);
    sel.forEach((n) => n.remove());
    this._regenBlend(g);
    this.selection = new Set([g.getAttribute("data-hv-id")]); this.artboardSelected = false;
    this._renderSelection(); this._renderInspector(); this._renderLayers();
    setStatus(`Blended in ${steps} steps.`, 2000);
  },
  setBlendParam(g, key, value) {
    const spec = this._blendSpec(g); if (!spec) return;
    spec[key] = value; this._blendSet(g, spec); this._regenBlend(g); this._renderSelection();
  },
  expandBlend(g) {
    g = g || this.selectedNodes().map((n) => this._blendGroupOf(n)).find(Boolean);
    if (!this.isBlendGroup(g)) return;
    this.push("Expand blend");
    g.removeAttribute("data-hv-blend");
    this._renderSelection(); this._renderInspector(); this._renderLayers();
    setStatus("Blend expanded to a group.", 1800);
  },
};
