// Transform tool (#31): the scale/rotate sub-mode of Select (Ctrl+T scale, Ctrl+R rotate).
// 8 bounding-box scale handles + a rotate ring; dragging one live-transforms via a temporary
// matrix and bakes the result into geometry on release (nodes stay translate-only). Object.assign
// MIXIN — runs with `this === editor`, reaching the shared geometry helpers that stayed on editor
// (this._nodeBBoxUser / this._bboxUnion / this._pad / this._scaleK / this.selectedNodes /
// this._renderSelection / this.rotateSelectionBy) by identity. The one-shot transform(op) / flip
// ops stay on editor — they're woven into the general selection-manipulation methods.
import { SVG_NS, nfmt, bakeMatrixInto, currentTranslate, setTranslate } from "../../hv/index.js";
import { setStatus } from "../../app.js";

export const transformMixin = {
  // ---------- transform tool: scale the selection via bounding-box handles ----------
  // 8 handles on the selection bbox; dragging one scales (live, via a temporary
  // matrix transform) about the opposite corner/edge, then bakes the scale into
  // geometry on release so nodes stay translate-only. Shift on a corner keeps aspect.
  // Transform is a sub-mode of Select: Ctrl+T = scale handles, Ctrl+R = rotate
  // handles. Pressing the same one again toggles back to the plain selection.
  enterTransform(mode) {
    mode = mode === "rotate" ? "rotate" : "scale";
    if (this.tool !== "select") this.setTool("select");   // switching tools also clears _xformMode
    this._xformMode = this._xformMode === mode ? null : mode;
    this._renderSelection();
    this._showHint();
  },
  // Drop the transform sub-mode (V pressed again, or Esc) → plain selection.
  clearXform() { if (this._xformMode) { this._xformMode = null; this._renderSelection(); this._showHint(); } },
  _mountTransformHandles() {
    this.unmountTransformHandles();
    const ov = this._overlayEl(); if (!ov || !this.stage || this.artboardSelected) return;
    const nodes = this.selectedNodes(); if (!nodes.length) return;
    const bb = this._bboxUnion(nodes);
    if (!(bb.x1 - bb.x0 > 1e-3) || !(bb.y1 - bb.y0 > 1e-3)) return;   // zero-area (a lone line) — nothing to scale
    const m = this.stageCTM(); const k = m ? Math.hypot(m.a, m.b) || 1 : 1;
    // A 9px handle is a mouse target. A finger needs ~44px, but a 44px SQUARE would swallow the shape
    // it's supposed to be resizing — so the handle stays modest and gets an INVISIBLE 44px hit rect
    // sitting on top of it. Big enough to hit, small enough to see past.
    const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
    const r = (coarse ? 8 : 4.5) / k;
    const hr = coarse ? 22 / k : 0;   // half a 44px target
    const midX = (bb.x0 + bb.x1) / 2, midY = (bb.y0 + bb.y1) / 2;
    const specs = [   // x,y = handle position; ax,ay = the anchor (opposite point) it scales away from
      { h: "nw", x: bb.x0, y: bb.y0, ax: bb.x1, ay: bb.y1, sx: 1, sy: 1 },
      { h: "n",  x: midX,  y: bb.y0, ax: midX,  ay: bb.y1, sx: 0, sy: 1 },
      { h: "ne", x: bb.x1, y: bb.y0, ax: bb.x0, ay: bb.y1, sx: 1, sy: 1 },
      { h: "e",  x: bb.x1, y: midY,  ax: bb.x0, ay: midY,  sx: 1, sy: 0 },
      { h: "se", x: bb.x1, y: bb.y1, ax: bb.x0, ay: bb.y0, sx: 1, sy: 1 },
      { h: "s",  x: midX,  y: bb.y1, ax: midX,  ay: bb.y0, sx: 0, sy: 1 },
      { h: "sw", x: bb.x0, y: bb.y1, ax: bb.x1, ay: bb.y0, sx: 1, sy: 1 },
      { h: "w",  x: bb.x0, y: midY,  ax: bb.x1, ay: midY,  sx: 1, sy: 0 },
    ];
    const mode = this._xformMode === "rotate" ? "rotate" : "scale";
    const g = document.createElementNS(SVG_NS, "g"); g.setAttribute("class", "hv-xform hv-xform-" + mode);
    const box = document.createElementNS(SVG_NS, "rect"); box.setAttribute("class", "hv-xform-box");
    box.setAttribute("x", nfmt(bb.x0)); box.setAttribute("y", nfmt(bb.y0));
    box.setAttribute("width", nfmt(bb.x1 - bb.x0)); box.setAttribute("height", nfmt(bb.y1 - bb.y0));
    g.appendChild(box);
    // Rotation handles: visible circles set OUTSIDE each corner (Illustrator-style),
    // so they never sit under a resize handle — the earlier on-corner zones were
    // mostly covered and "didn't work". Always present; emphasized in rotate mode.
    const rotOut = r * 3.2;   // diagonal offset beyond the corner
    // With fat finger targets the rotators and the resize handles would sit on top of each other and
    // you'd get whichever one the browser felt like. On touch each mode shows only its own handles —
    // which is fine now that Rotate is a button of its own, and not a keystroke nobody could press.
    for (const [x, y, ox, oy] of ((coarse && mode !== "rotate") ? [] : [[bb.x0, bb.y0, -1, -1], [bb.x1, bb.y0, 1, -1], [bb.x1, bb.y1, 1, 1], [bb.x0, bb.y1, -1, 1]])) {
      const cx = x + ox * rotOut, cy = y + oy * rotOut;
      const z = document.createElementNS(SVG_NS, "circle"); z.setAttribute("class", "hv-xform-rot");
      z.setAttribute("cx", nfmt(cx)); z.setAttribute("cy", nfmt(cy)); z.setAttribute("r", nfmt(r * 1.4));
      this._bindRotateHandle(z);
      g.appendChild(z);
      if (hr) {   // the invisible thumb-sized target over it
        const zh = document.createElementNS(SVG_NS, "circle"); zh.setAttribute("class", "hv-xform-hit");
        zh.setAttribute("cx", nfmt(cx)); zh.setAttribute("cy", nfmt(cy)); zh.setAttribute("r", nfmt(hr));
        this._bindRotateHandle(zh);
        g.appendChild(zh);
      }
    }
    const handles = [];
    // Resize handles only in scale mode — rotate mode is purely the corner rotators.
    for (const s of (mode === "scale" ? specs : [])) {
      const c = document.createElementNS(SVG_NS, "rect"); c.setAttribute("class", "hv-xform-handle hv-xform-" + s.h);
      c.setAttribute("x", nfmt(s.x - r)); c.setAttribute("y", nfmt(s.y - r));
      c.setAttribute("width", nfmt(2 * r)); c.setAttribute("height", nfmt(2 * r));
      this._bindTransformHandle(c, s);
      g.appendChild(c);
      let hit = null;
      if (hr) {
        hit = document.createElementNS(SVG_NS, "rect"); hit.setAttribute("class", "hv-xform-hit");
        hit.setAttribute("x", nfmt(s.x - hr)); hit.setAttribute("y", nfmt(s.y - hr));
        hit.setAttribute("width", nfmt(2 * hr)); hit.setAttribute("height", nfmt(2 * hr));
        this._bindTransformHandle(hit, s);
        g.appendChild(hit);
      }
      handles.push({ el: c, hit, s });
    }
    ov.appendChild(g);
    this._xform = { box, handles, r, hr, bb, g };
  },
  // Rotate the selection about the bbox centre (corner rotation zones). Shift = 15°
  // snaps. Composes with any existing transform; result is left as a matrix.
  _bindRotateHandle(zone) {
    zone.addEventListener("pointerdown", (e) => {
      e.stopPropagation(); e.preventDefault();
      const nodes = this.selectedNodes(); if (!nodes.length) return;
      try { zone.setPointerCapture(e.pointerId); } catch {}
      this._handleDragging = true;
      const xf = this._xform, cx = (xf.bb.x0 + xf.bb.x1) / 2, cy = (xf.bb.y0 + xf.bb.y1) / 2;
      const origs = nodes.map((n) => n.getAttribute("transform"));
      const ptU = (ev) => new DOMPoint(ev.clientX, ev.clientY).matrixTransform(this.stageCTM().inverse());
      const a0 = (() => { const p = ptU(e); return Math.atan2(p.y - cy, p.x - cx); })();
      let pushed = false;
      const move = (ev) => {
        const p = ptU(ev); let deg = (Math.atan2(p.y - cy, p.x - cx) - a0) * 180 / Math.PI;
        if (ev.shiftKey) deg = Math.round(deg / 15) * 15;
        // Snapshot the CLEAN pre-rotate state before touching the document, and apply
        // nothing below the threshold — otherwise a sub-0.4° jiggle left an un-undoable
        // rotate() on the nodes, and the snapshot captured an already-rotated doc (undo drift).
        if (!pushed) {
          if (Math.abs(deg) <= 0.4) return;
          this.push("Rotate"); pushed = true; this._showGhostBox();
        }
        const rot = `rotate(${nfmt(deg)} ${nfmt(cx)} ${nfmt(cy)})`;
        nodes.forEach((n, i) => n.setAttribute("transform", origs[i] ? `${rot} ${origs[i]}` : rot));
        if (xf.g) xf.g.setAttribute("transform", rot);   // rotate box + handles to match
        this._showSizeReadout(deg.toFixed(1) + "°", null, ev.clientX, ev.clientY);
      };
      const up = () => {
        try { zone.releasePointerCapture(e.pointerId); } catch {}
        this._handleDragging = false; this._hideSizeReadout(); this._clearGhostBox();
        zone.removeEventListener("pointermove", move); zone.removeEventListener("pointerup", up);
        if (!pushed) { this._renderSelection(); return; }
        nodes.forEach((n) => { try { const co = n.transform.baseVal.consolidate(); if (co) { const m = co.matrix; n.setAttribute("transform", `matrix(${nfmt(m.a)} ${nfmt(m.b)} ${nfmt(m.c)} ${nfmt(m.d)} ${nfmt(m.e)} ${nfmt(m.f)})`); } } catch {} });
        this._renderSelection(); this._renderInspector(); this._renderLayers();
        setStatus("Rotated selection.", 1200);
      };
      zone.addEventListener("pointermove", move);
      zone.addEventListener("pointerup", up);
    });
  },
  unmountTransformHandles() {
    const ov = this._overlayEl(); if (ov) ov.querySelectorAll(".hv-xform").forEach((g) => g.remove());
    this._xform = null;
  },
  _scaleFactors(spec, p, shift, ax, ay) {
    let sx = spec.sx ? (p.x - ax) / ((spec.x - ax) || 1e-6) : 1;
    let sy = spec.sy ? (p.y - ay) / ((spec.y - ay) || 1e-6) : 1;
    const MIN = 0.02;
    if (sx < MIN) sx = MIN; if (sy < MIN) sy = MIN;
    if (shift && spec.sx && spec.sy) { const s = Math.max(sx, sy); sx = s; sy = s; }
    return { sx, sy };
  },
  // Before/after: a dashed ghost of the ORIGINAL bounds, drawn behind the live box
  // during a scale so you can see where you started vs where you're dragging to.
  _showGhostBox() {
    const xf = this._xform, ov = this._overlayEl(); if (!xf || !ov) return;
    this._clearGhostBox();
    const g = document.createElementNS(SVG_NS, "rect"); g.setAttribute("class", "hv-xform-ghost");
    g.setAttribute("x", nfmt(xf.bb.x0)); g.setAttribute("y", nfmt(xf.bb.y0));
    g.setAttribute("width", nfmt(xf.bb.x1 - xf.bb.x0)); g.setAttribute("height", nfmt(xf.bb.y1 - xf.bb.y0));
    ov.insertBefore(g, ov.firstChild);
    this._ghostBox = g;
  },
  _clearGhostBox() { if (this._ghostBox) { try { this._ghostBox.remove(); } catch {} this._ghostBox = null; } },
  _updateXformVisual(spec, sx, sy, ax, ay) {
    const xf = this._xform; if (!xf) return;
    const sp = (x, y) => ({ x: ax + (x - ax) * sx, y: ay + (y - ay) * sy });
    const a = sp(xf.bb.x0, xf.bb.y0), b = sp(xf.bb.x1, xf.bb.y1);
    xf.box.setAttribute("x", nfmt(Math.min(a.x, b.x))); xf.box.setAttribute("y", nfmt(Math.min(a.y, b.y)));
    xf.box.setAttribute("width", nfmt(Math.abs(b.x - a.x))); xf.box.setAttribute("height", nfmt(Math.abs(b.y - a.y)));
    for (const { el, hit, s } of xf.handles) {
      const q = sp(s.x, s.y);
      el.setAttribute("x", nfmt(q.x - xf.r)); el.setAttribute("y", nfmt(q.y - xf.r));
      if (hit) { hit.setAttribute("x", nfmt(q.x - xf.hr)); hit.setAttribute("y", nfmt(q.y - xf.hr)); }   // the touch target rides along
    }
  },
  _bindTransformHandle(c, spec) {
    c.addEventListener("pointerdown", (e) => {
      e.stopPropagation(); e.preventDefault();
      const nodes = this.selectedNodes(); if (!nodes.length) return;
      try { c.setPointerCapture(e.pointerId); } catch {}
      c.classList.add("dragging"); this._handleDragging = true;
      // "flat" = every node is translate-only/transform-free → we can bake to a clean
      // translate (keeps node-editing working). If any node already carries a
      // scale/rotate/matrix, we COMPOSE the scale on top of it instead of replacing
      // it (replacing destroyed the rotation — the imported-shape bug) and leave the
      // result as a consolidated matrix.
      const transAttr = (n) => (n.getAttribute("transform") || "").trim();
      const flat = nodes.every((n) => transAttr(n) === "" || /^translate\([^)]*\)$/.test(transAttr(n)));
      const bases = nodes.map((n) => currentTranslate(n));
      const origs = nodes.map((n) => n.getAttribute("transform"));
      const xf = this._xform, cx = (xf.bb.x0 + xf.bb.x1) / 2, cy = (xf.bb.y0 + xf.bb.y1) / 2;   // bbox centre (Alt anchor)
      let pushed = false, last = { sx: 1, sy: 1, ax: spec.ax, ay: spec.ay };
      const apply = (sx, sy, ax, ay) => nodes.forEach((n, i) => {
        if (flat) { const b = bases[i]; n.setAttribute("transform", `matrix(${nfmt(sx)} 0 0 ${nfmt(sy)} ${nfmt(sx * b.x + ax * (1 - sx))} ${nfmt(sy * b.y + ay * (1 - sy))})`); }
        else { const s = `matrix(${nfmt(sx)} 0 0 ${nfmt(sy)} ${nfmt(ax * (1 - sx))} ${nfmt(ay * (1 - sy))})`; n.setAttribute("transform", origs[i] ? `${s} ${origs[i]}` : s); }
      });
      const move = (ev) => {
        const m = this.stageCTM(); if (!m) return;
        const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(m.inverse());
        const ax = ev.altKey ? cx : spec.ax, ay = ev.altKey ? cy : spec.ay;   // Alt → scale from centre
        const f = this._scaleFactors(spec, p, ev.shiftKey, ax, ay); last = { ...f, ax, ay };
        // Snapshot before mutating, and don't apply below the threshold — otherwise a
        // sub-1e-4 jiggle baked a near-identity matrix() into the snapshot, degrading
        // _isTranslateOnly (node-editability) after an undo.
        if (!pushed) {
          if (Math.abs(f.sx - 1) <= 1e-4 && Math.abs(f.sy - 1) <= 1e-4) return;
          this.push("Scale"); pushed = true; this._showGhostBox();
        }
        apply(f.sx, f.sy, ax, ay);
        this._updateXformVisual(spec, f.sx, f.sy, ax, ay);
        this._showSizeReadout((xf.bb.x1 - xf.bb.x0) * Math.abs(f.sx), (xf.bb.y1 - xf.bb.y0) * Math.abs(f.sy), ev.clientX, ev.clientY);
      };
      const up = () => {
        try { c.releasePointerCapture(e.pointerId); } catch {}
        c.classList.remove("dragging"); this._handleDragging = false; this._hideSizeReadout(); this._clearGhostBox();
        c.removeEventListener("pointermove", move); c.removeEventListener("pointerup", up);
        if (!pushed) { nodes.forEach((n, i) => { if (origs[i] == null) n.removeAttribute("transform"); else n.setAttribute("transform", origs[i]); }); this._renderSelection(); return; }
        const { sx, sy, ax, ay } = last;
        if (flat) {
          const M = { a: sx, b: 0, c: 0, d: sy, e: ax * (1 - sx), f: ay * (1 - sy) };
          nodes.forEach((n, i) => {
            // Text can't bake a scale — font-size is a single number and the glyph shapes live in
            // the font — so baking would drop the scale and SNAP the text back to its original
            // size on release. Keep the scale as a matrix transform instead (same as the inspector
            // resize path). Convert to outlines first to scale the actual glyph paths.
            if (n.tagName.toLowerCase() === "text") {
              n.setAttribute("transform", `matrix(${nfmt(sx)} 0 0 ${nfmt(sy)} ${nfmt(sx * bases[i].x + ax * (1 - sx))} ${nfmt(sy * bases[i].y + ay * (1 - sy))})`);
            } else {
              setTranslate(n, bases[i].x, bases[i].y); bakeMatrixInto(n, M, 0, 0);
            }
          });
        } else {   // consolidate the composed scale·original into a single matrix
          nodes.forEach((n) => { try { const co = n.transform.baseVal.consolidate(); if (co) { const mm = co.matrix; n.setAttribute("transform", `matrix(${nfmt(mm.a)} ${nfmt(mm.b)} ${nfmt(mm.c)} ${nfmt(mm.d)} ${nfmt(mm.e)} ${nfmt(mm.f)})`); } } catch {} });
        }
        this._renderSelection(); this._renderInspector(); this._renderLayers();
        setStatus("Scaled selection.", 1200);
      };
      c.addEventListener("pointermove", move);
      c.addEventListener("pointerup", up);
    });
  },
};
