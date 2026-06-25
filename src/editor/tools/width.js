// Width tool (Epic W). Variable-width strokes: drag perpendicular to a stroke to swell
// or pinch it at that point (Alt = one-sided/asymmetric). Built on the geometric stroker
// (hv/stroke.js, Epic S), whose per-vertex half-width is a parameter — so a width PROFILE
// renders to the same crisp filled ribbon as a uniform outline. Object.assign MIXIN.
//
// Model — a width-stroke is a parametric `<g data-hv-wstroke='{spec}'>` (like a repeat
// group): the spec holds the SPINE (`d` + base width + paint) and a PROFILE
// [{t,l,r}…] of absolute half-widths along the path (t = arc length 0..1). The group's
// only children are GENERATED: an optional fill `<path>` + the ribbon `<path>` (the
// variable outline). Editing the profile regenerates the ribbon. The spec lives in
// data-hv-wstroke (stripped on serialize) and the ribbon is real geometry, so a saved
// SVG bakes to a plain filled outline — the same honest round-trip area-text uses; in
// session it stays editable, and Release returns it to a normal stroked path.
import { SVG_NS, shapeToAbsPath, strokeOutline, flattenSubpaths } from "../../hv/index.js";
import { setStatus } from "../../app.js";

export const widthMixin = {
  isWidthStroke(n) { return !!(n && n.getAttribute && n.hasAttribute("data-hv-wstroke")); },
  _wsSpec(g) { try { return JSON.parse(g.getAttribute("data-hv-wstroke")); } catch { return null; } },
  _wsSet(g, spec) { g.setAttribute("data-hv-wstroke", JSON.stringify(spec)); },
  _wsGroupOf(n) { if (this.isWidthStroke(n)) return n; const g = n && n.closest && n.closest("[data-hv-wstroke]"); return g && this.stage && this.stage.contains(g) ? g : null; },
  _ctmScale(n) { let m = null; try { m = n.getCTM(); } catch {} return m ? Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1 : 1; },

  // profile → widthAt(t) returning { l, r } half-widths (piecewise-linear between stops).
  _wsWidthAt(spec) {
    const pr = (spec.profile && spec.profile.length ? spec.profile : [{ t: 0, l: spec.w / 2, r: spec.w / 2 }]).slice().sort((a, b) => a.t - b.t);
    return (t) => {
      if (t <= pr[0].t) return { l: pr[0].l, r: pr[0].r };
      for (let i = 1; i < pr.length; i++) {
        if (t <= pr[i].t) { const a = pr[i - 1], b = pr[i], k = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0; return { l: a.l + (b.l - a.l) * k, r: a.r + (b.r - a.r) * k }; }
      }
      const last = pr[pr.length - 1]; return { l: last.l, r: last.r };
    };
  },
  // Rebuild a width-stroke group's generated children from its spec (fill + ribbon).
  _regenWidthStroke(g) {
    const spec = this._wsSpec(g); if (!spec) return;
    [...g.children].forEach((c) => c.remove());
    if (spec.fill && spec.fill !== "none") {
      const f = document.createElementNS(SVG_NS, "path");
      f.setAttribute("data-hv-id", "n" + (++this.idSeq)); f.setAttribute("data-hv-wfill", "1");
      f.setAttribute("d", spec.d); f.setAttribute("fill", spec.fill);
      if (spec.fillRule) f.setAttribute("fill-rule", spec.fillRule);
      if (spec.fillOpacity != null) f.setAttribute("fill-opacity", spec.fillOpacity);
      g.appendChild(f);
    }
    const d = strokeOutline(spec.d, { width: spec.w, cap: spec.cap, join: spec.join, miter: spec.miter, widthAt: this._wsWidthAt(spec) });
    const rb = document.createElementNS(SVG_NS, "path");
    rb.setAttribute("data-hv-id", "n" + (++this.idSeq)); rb.setAttribute("data-hv-wribbon", "1");
    rb.setAttribute("d", d || ""); rb.setAttribute("fill", spec.stroke || "#000000"); rb.setAttribute("fill-rule", "nonzero");
    if (spec.strokeOpacity != null) rb.setAttribute("fill-opacity", spec.strokeOpacity);
    g.appendChild(rb);
    if (spec.opacity != null) g.setAttribute("opacity", spec.opacity); else g.removeAttribute("opacity");
  },
  // Build a width-stroke spec from a stroked node (geometry baked to absolute stage space).
  _wsSpecFromNode(n) {
    const d = shapeToAbsPath(n, n.getCTM()); if (!d) return null;
    const stroke = n.getAttribute("stroke"); const sw = parseFloat(n.getAttribute("stroke-width"));
    if (!stroke || stroke === "none" || !(sw > 0)) return null;
    const w = sw * this._ctmScale(n), hw = w / 2;
    const fill = n.getAttribute("fill");
    return {
      d, w, cap: n.getAttribute("stroke-linecap") || "butt", join: n.getAttribute("stroke-linejoin") || "miter",
      miter: parseFloat(n.getAttribute("stroke-miterlimit")) || 4,
      stroke, strokeOpacity: n.getAttribute("stroke-opacity") != null ? +n.getAttribute("stroke-opacity") : null,
      fill: fill && fill !== "none" ? fill : "none", fillOpacity: n.getAttribute("fill-opacity") != null ? +n.getAttribute("fill-opacity") : null,
      fillRule: n.getAttribute("fill-rule") || null, opacity: n.getAttribute("opacity") != null ? +n.getAttribute("opacity") : null,
      profile: [{ t: 0, l: hw, r: hw }, { t: 1, l: hw, r: hw }],
    };
  },
  // Turn selected stroked paths into width-stroke groups. Returns the new group ids.
  makeWidthStroke(ids) {
    if (!this.stage) return [];
    const nodes = (ids ? ids.map((i) => this.nodeById(i)) : this._effectiveLeaves()).filter((n) => n && !this.isRaster(n) && this._isStroked(n) && shapeToAbsPath(n));
    if (!nodes.length) { setStatus("Select a stroked path to vary its width.", 3000); return []; }
    this.push("Width stroke");
    const made = [];
    for (const n of nodes) {
      const spec = this._wsSpecFromNode(n); if (!spec) continue;
      const g = document.createElementNS(SVG_NS, "g");
      g.setAttribute("data-hv-id", "n" + (++this.idSeq)); this._wsSet(g, spec);
      n.parentNode.insertBefore(g, n.nextSibling); n.remove();
      this._regenWidthStroke(g); made.push(g.getAttribute("data-hv-id"));
    }
    this.selection = new Set(made); this.artboardSelected = false;
    this._renderSelection(); this._renderInspector(); this._renderLayers();
    return made;
  },
  // Release a width-stroke group back to a plain stroked <path> (drops the profile).
  releaseWidthStroke(g) {
    g = g || this.selectedNodes().map((n) => this._wsGroupOf(n)).find(Boolean);
    if (!g) return;
    const spec = this._wsSpec(g); if (!spec) return;
    this.push("Release width stroke");
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("data-hv-id", "n" + (++this.idSeq));
    p.setAttribute("d", spec.d); p.setAttribute("fill", spec.fill || "none");
    p.setAttribute("stroke", spec.stroke); p.setAttribute("stroke-width", spec.w);
    for (const [k, v] of [["stroke-linecap", spec.cap], ["stroke-linejoin", spec.join], ["fill-rule", spec.fillRule], ["fill-opacity", spec.fillOpacity], ["stroke-opacity", spec.strokeOpacity], ["opacity", spec.opacity]]) if (v != null && v !== "") p.setAttribute(k, v);
    g.parentNode.insertBefore(p, g); g.remove();
    this.selection = new Set([p.getAttribute("data-hv-id")]); this.artboardSelected = false;
    this._renderSelection(); this._renderInspector(); this._renderLayers();
    setStatus("Released to a stroked path.", 2000);
  },
  // Expand: bake to plain paths — unwrap the generated fill + ribbon out of the group.
  expandWidthStroke(g) {
    g = g || this.selectedNodes().map((n) => this._wsGroupOf(n)).find(Boolean);
    if (!g) return;
    this.push("Expand width stroke");
    const kept = [];
    for (const c of [...g.children]) {
      c.removeAttribute("data-hv-wribbon"); c.removeAttribute("data-hv-wfill");
      if (!c.getAttribute("data-hv-id")) c.setAttribute("data-hv-id", "n" + (++this.idSeq));
      g.parentNode.insertBefore(c, g); kept.push(c.getAttribute("data-hv-id"));
    }
    g.remove();
    this.selection = new Set(kept); this.artboardSelected = false;
    this._renderSelection(); this._renderInspector(); this._renderLayers();
    setStatus("Expanded width stroke to paths.", 2000);
  },
  // Inspector: set the base/uniform width — scales the whole profile so everything thickens
  // proportionally (keeps any variation), or seeds a uniform profile if there was none.
  setWidthBase(g, w) {
    const spec = this._wsSpec(g); if (!spec || !(w > 0)) return;
    const ratio = spec.w > 0 ? w / spec.w : 1;
    spec.w = w; (spec.profile || []).forEach((s) => { s.l *= ratio; s.r *= ratio; });
    this._wsSet(g, spec); this._regenWidthStroke(g);
  },
  resetWidthUniform(g) {
    const spec = this._wsSpec(g); if (!spec) return;
    this.push("Uniform width"); const hw = spec.w / 2;
    spec.profile = [{ t: 0, l: hw, r: hw }, { t: 1, l: hw, r: hw }];
    this._wsSet(g, spec); this._regenWidthStroke(g);
    this._renderSelection(); this._mountWidthHandles();
  },

  // ---- spine geometry: flatten the spec spine to a polyline with arc-length params ----
  _wsSpine(spec) {
    const subs = flattenSubpaths(spec.d, 0.4); const sub = subs[0]; if (!sub || sub.pts.length < 2) return null;
    const pts = sub.pts.slice(); if (sub.closed) pts.push(pts[0]);
    const ts = []; let tot = 0; const seglen = [];
    for (let i = 1; i < pts.length; i++) { const L = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y); seglen.push(L); tot += L; }
    let acc = 0; ts.push(0); for (let i = 1; i < pts.length; i++) { acc += seglen[i - 1]; ts.push(tot > 0 ? acc / tot : 0); }
    return { pts, ts };
  },
  // Nearest point on the spine to (x,y): { t, dist, side } (side +1 = left of travel).
  _wsNearest(spine, x, y) {
    let best = { dist: Infinity, t: 0, side: 1 };
    for (let i = 1; i < spine.pts.length; i++) {
      const a = spine.pts[i - 1], b = spine.pts[i], dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
      let u = L2 > 0 ? ((x - a.x) * dx + (y - a.y) * dy) / L2 : 0; u = Math.max(0, Math.min(1, u));
      const px = a.x + dx * u, py = a.y + dy * u, dist = Math.hypot(x - px, y - py);
      if (dist < best.dist) { const cross = dx * (y - a.y) - dy * (x - a.x); best = { dist, t: spine.ts[i - 1] + (spine.ts[i] - spine.ts[i - 1]) * u, side: cross >= 0 ? 1 : -1 }; }
    }
    return best;
  },
  // Width-tool pointer-down: grab/insert a profile stop near the pressed point and drag the
  // perpendicular distance to set the half-width there (Alt = only the dragged side). On a
  // plain stroked path it first converts to a width-stroke, so the tool works directly.
  _widthDown(e) {
    e.stopPropagation(); e.preventDefault();
    const m = this.stage.getScreenCTM(); if (!m) return;
    const toUser = (ev) => new DOMPoint(ev.clientX, ev.clientY).matrixTransform(m.inverse());
    let g = e.target.closest && this._wsGroupOf(e.target.closest("[data-hv-id]") || e.target);
    if (!g) {
      const host = e.target.closest && e.target.closest("[data-hv-id]");
      if (host && this._isStroked(host) && !this.isRaster(host)) { const ids = this.makeWidthStroke([host.getAttribute("data-hv-id")]); g = ids.length ? this.nodeById(ids[0]) : null; }
    }
    if (!g) { setStatus("Click a stroked path with the Width tool to vary its width.", 3000); return; }
    if (!this.selection.has(g.getAttribute("data-hv-id"))) { this.selection = new Set([g.getAttribute("data-hv-id")]); this.artboardSelected = false; this._renderSelection(); this._renderInspector(); }
    const spec = this._wsSpec(g); const spine = this._wsSpine(spec); if (!spine) return;
    const sp = toUser(e); const near = this._wsNearest(spine, sp.x, sp.y);
    // grab an existing stop within ~3% of t, else insert one (seeded from the current width there)
    let stop = (spec.profile || []).find((s) => Math.abs(s.t - near.t) < 0.03);
    if (!stop) { const w0 = this._wsWidthAt(spec)(near.t); stop = { t: near.t, l: w0.l, r: w0.r }; spec.profile.push(stop); spec.profile.sort((a, b) => a.t - b.t); }
    let pushed = false;
    const move = (ev) => {
      const q = toUser(ev); const nr = this._wsNearest(spine, q.x, q.y);
      if (!pushed && nr.dist < 0.5 && Math.abs(nr.t - near.t) < 0.01) return;   // tiny → ignore until a real drag
      if (!pushed) { this.push("Width"); pushed = true; }
      const hw = Math.max(0.25, nr.dist);
      if (ev.altKey) { if (near.side > 0) stop.l = hw; else stop.r = hw; } else { stop.l = hw; stop.r = hw; }
      this._wsSet(g, spec); this._regenWidthStroke(g); this._mountWidthHandles();
    };
    const up = () => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      if (pushed) { this._renderInspector(); this._mountWidthHandles(); }
      else { this._mountWidthHandles(); }   // a click with no drag just (re)shows the handles
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  },

  // ---- on-spine width-stop handles (constant screen size), shown while the tool is active ----
  _unmountWidthHandles() { const ov = this._overlayEl(); if (ov) ov.querySelectorAll(".hv-whandles").forEach((g) => g.remove()); },
  _mountWidthHandles() {
    this._unmountWidthHandles();
    if (this.tool !== "width" || !this.stage) return;
    const g = this.selectedNodes().map((n) => this._wsGroupOf(n)).find(Boolean); if (!g) return;
    const spec = this._wsSpec(g); const spine = this._wsSpine(spec); if (!spine) return;
    const ov = this._overlayEl(); if (!ov) return;
    const m = this.stage.getScreenCTM(); const k = m ? Math.hypot(m.a, m.b) || 1 : 1;   // user units per... screen px factor
    const layer = document.createElementNS(SVG_NS, "g"); layer.setAttribute("class", "hv-whandles");
    // point on the spine at parameter t
    const at = (t) => { for (let i = 1; i < spine.ts.length; i++) { if (t <= spine.ts[i]) { const a = spine.pts[i - 1], b = spine.pts[i], d = spine.ts[i] - spine.ts[i - 1], u = d > 0 ? (t - spine.ts[i - 1]) / d : 0; return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u }; } } const L = spine.pts[spine.pts.length - 1]; return { x: L.x, y: L.y }; };
    const r = 4 / k;
    for (const s of (spec.profile || [])) {
      const p = at(s.t);
      const dia = document.createElementNS(SVG_NS, "rect");
      dia.setAttribute("class", "hv-whandle");
      dia.setAttribute("x", p.x - r); dia.setAttribute("y", p.y - r); dia.setAttribute("width", 2 * r); dia.setAttribute("height", 2 * r);
      dia.setAttribute("transform", `rotate(45 ${p.x} ${p.y})`);
      layer.appendChild(dia);
    }
    ov.appendChild(layer);
  },
};
