// Curvature tool (#31): click to drop auto-smoothed (Catmull-Rom) points, drag to nudge,
// Alt = corner, Shift = 45°, Backspace = undo last point. Object.assign MIXIN — methods run
// with `this === editor`. Only module-level helpers are imported.
import {
  SVG_NS, nfmt, penPathD, catmullRomAnchors, collectAnchors, pathNodes,
} from "../../hv/index.js";
import { setStatus } from "../../app.js";

export const curvatureMixin = {
  // ---------- curvature tool: click to drop auto-smoothed points ----------
  _curvDown(e) {
    if (e.button !== 0) return;
    e.stopPropagation(); e.preventDefault();
    const inv = () => this.stage.getScreenCTM().inverse();
    let pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(inv());
    if (!this._curv) {
      this.beginCoalesce();
      this.selection = new Set(); this.artboardSelected = false; this._renderSelection();
      const node = document.createElementNS(SVG_NS, "path");
      node.setAttribute("fill", "none"); node.setAttribute("stroke", "#1d1d1f"); node.setAttribute("stroke-width", "1.5");
      node.setAttribute("vector-effect", "non-scaling-stroke");
      this.stage.insertBefore(node, this._overlayEl());
      this._curv = { node, pts: [], closed: false };
      this._curvLastClick = null;
      this._curvHoverBound = (ev) => this._curvHover(ev);
      window.addEventListener("pointermove", this._curvHoverBound);
      this._curv.pts.push({ x: pt.x, y: pt.y, corner: !!e.altKey });
      this._curvRedraw(); this._curvMarks();
      return;
    }
    if (this._curv.pts.length >= 2 && this._curvNearFirst(pt)) { this._curv.closed = true; this._curvFinish(true); return; }
    const near = this._curvNearPoint(pt);
    if (near >= 0) {
      // Alt-click toggles smooth⇄corner immediately; a plain press starts a drag-to-move
      // (falling back to the 2-click-within-350ms corner toggle when it doesn't move).
      if (e.altKey) { this._curv.pts[near].corner = !this._curv.pts[near].corner; this._curvRedraw(); this._curvMarks(); this._curvLastClick = null; return; }
      this._curvDragPoint(near, e); return;
    }
    // New point. Shift constrains it to 45° off the previous one; Alt drops a corner.
    if (e.shiftKey && this._curv.pts.length) pt = this._constrain45(this._curv.pts[this._curv.pts.length - 1], pt);
    this._curvLastClick = null;
    this._curv.pts.push({ x: pt.x, y: pt.y, corner: !!e.altKey });
    this._curvRedraw(); this._curvMarks();
  },
  // Drag an existing in-progress point to reposition it; no-move falls through to the
  // double-click corner toggle so a simple click still flips smooth⇄corner.
  _curvDragPoint(i, downEv) {
    if (!this._curv) return;
    const inv = () => this.stage.getScreenCTM().inverse();
    const start = new DOMPoint(downEv.clientX, downEv.clientY).matrixTransform(inv());
    const orig = { x: this._curv.pts[i].x, y: this._curv.pts[i].y };
    const m = this.stage.getScreenCTM(); const k = m ? Math.hypot(m.a, m.b) || 1 : 1;
    let moved = false;
    this._curv._drag = true;   // suspend the hover preview while dragging a point
    const move = (ev) => {
      const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(inv());
      if (!moved && Math.hypot(p.x - start.x, p.y - start.y) * k > 3) moved = true;
      if (!moved) return;
      this._curv.pts[i].x = orig.x + (p.x - start.x);
      this._curv.pts[i].y = orig.y + (p.y - start.y);
      this._curvRedraw(); this._curvMarks();
    };
    const up = (ev) => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      if (this._curv) this._curv._drag = false;
      if (moved) { this._curvLastClick = null; return; }
      const lc = this._curvLastClick;
      if (lc && lc.i === i && (ev.timeStamp - lc.t) < 350) {
        this._curv.pts[i].corner = !this._curv.pts[i].corner; this._curvRedraw(); this._curvMarks(); this._curvLastClick = null;
      } else this._curvLastClick = { t: ev.timeStamp, i };
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  },
  // Snap `to` onto the nearest 45° ray out of `from` (Shift-constrain).
  _constrain45(from, to) {
    const dx = to.x - from.x, dy = to.y - from.y, len = Math.hypot(dx, dy);
    if (!len) return { x: to.x, y: to.y };
    const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    return { x: from.x + Math.cos(ang) * len, y: from.y + Math.sin(ang) * len };
  },
  // Backspace while constructing: drop the last point (or cancel the path if it's the last).
  _curvBack() {
    if (!this._curv) return;
    if (this._curv.pts.length <= 1) { this._curvFinish(false); return; }
    this._curv.pts.pop(); this._curvLastClick = null;
    this._curvRedraw(); this._curvMarks();
  },
  _curvHover(ev) {
    if (!this._curv || this._curv._drag) return;
    let p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(this.stage.getScreenCTM().inverse());
    const closeHover = this._curv.pts.length >= 2 && this._curvNearFirst(p);
    if (!closeHover && ev.shiftKey && this._curv.pts.length) p = this._constrain45(this._curv.pts[this._curv.pts.length - 1], p);
    this._curvRedraw(closeHover ? null : p);
    this._curvMarks(closeHover);
    this._setPenCloseCursor(closeHover);
  },
  _curvNearFirst(pt) {
    const f = this._curv.pts[0]; if (!f) return false;
    const m = this.stage.getScreenCTM(); const k = m ? Math.hypot(m.a, m.b) || 1 : 1;
    return Math.hypot(pt.x - f.x, pt.y - f.y) < 8 / k;
  },
  _curvNearPoint(pt) {
    const m = this.stage.getScreenCTM(); const k = m ? Math.hypot(m.a, m.b) || 1 : 1, tol = 8 / k;
    for (let i = 0; i < this._curv.pts.length; i++) if (Math.hypot(pt.x - this._curv.pts[i].x, pt.y - this._curv.pts[i].y) < tol) return i;
    return -1;
  },
  _curvRedraw(preview) {
    if (!this._curv) return;
    const pts = preview ? this._curv.pts.concat([{ x: preview.x, y: preview.y, corner: false }]) : this._curv.pts;
    const anchors = catmullRomAnchors(pts, this._curv.closed);
    this._curv.node.setAttribute("d", penPathD(anchors, this._curv.closed, null));
  },
  _curvMarks(closeHover) {
    const ov = this._overlayEl(); if (!ov || !this._curv) return;
    ov.querySelectorAll("g.hv-pen").forEach((g) => g.remove());
    const m = this.stage.getScreenCTM(); const k = m ? Math.hypot(m.a, m.b) || 1 : 1, r = 4 / k;
    const g = document.createElementNS(SVG_NS, "g"); g.setAttribute("class", "hv-pen");
    this._curv.pts.forEach((a, i) => {
      const first = i === 0, close = first && closeHover, rr = close ? r * 1.7 : r;
      // smooth = circle, corner = square (Illustrator curvature affordance)
      const el = document.createElementNS(SVG_NS, a.corner ? "rect" : "circle");
      el.setAttribute("class", "hv-pen-anchor" + (first ? " first" : "") + (close ? " close" : ""));
      if (a.corner) { el.setAttribute("x", nfmt(a.x - rr)); el.setAttribute("y", nfmt(a.y - rr)); el.setAttribute("width", nfmt(rr * 2)); el.setAttribute("height", nfmt(rr * 2)); }
      else { el.setAttribute("cx", nfmt(a.x)); el.setAttribute("cy", nfmt(a.y)); el.setAttribute("r", nfmt(rr)); }
      g.appendChild(el);
    });
    ov.appendChild(g);
  },
  _curvFinish(keep) {
    if (!this._curv) return;
    if (this._curvHoverBound) { window.removeEventListener("pointermove", this._curvHoverBound); this._curvHoverBound = null; }
    this._setPenCloseCursor(false);
    const { node, pts, closed } = this._curv;
    const ov = this._overlayEl(); if (ov) ov.querySelectorAll("g.hv-pen").forEach((g) => g.remove());
    this._curv = null;
    if (!keep || pts.length < 2) { node.remove(); this.cancelCoalesce(); return; }
    node.setAttribute("d", penPathD(catmullRomAnchors(pts, closed), closed, null));
    node.setAttribute("fill", closed ? (this.style.fill || "none") : "none");
    if (this.style.stroke && this.style.stroke !== "none" && this.style.strokeWidth > 0) {
      node.setAttribute("stroke", this.style.stroke); node.setAttribute("stroke-width", nfmt(this.style.strokeWidth));
    } else { node.setAttribute("stroke", "#1d1d1f"); node.setAttribute("stroke-width", "2"); }
    node.setAttribute("vector-effect", "non-scaling-stroke");
    node.setAttribute("stroke-linejoin", "round"); node.setAttribute("stroke-linecap", "round");
    const id = "n" + (++this.idSeq); node.setAttribute("data-hv-id", id);
    this.commitCoalesce("Curve");
    this.selection = new Set([id]); this.artboardSelected = false;
    this._renderSelection(); this._renderInspector(); this._renderLayers();
    setStatus(closed ? "Closed curve added." : "Curve added.", 1500);
  },
  deleteSelection() {
    const nodes = this.selectedNodes(); if (!nodes.length) return;
    this.push("Delete");
    nodes.forEach((n) => n.remove());
    this.selection = new Set();
    this._renderSelection(); this._renderInspector();
  },
  _renderSelection() {
    const ov = this._overlayEl(); if (!ov) return;
    this._raiseGuides();   // keep ruler guides above any newly-added artwork (still below the overlay)
    ov.innerHTML = ""; this._xform = null;
    // Node tool shows anchors, not the object's bounding box — drawing the select bbox
    // on top of the handles (esp. degenerate on a thin line) just clutters the edit.
    if (this.tool === "node") { this.mountNodeHandles(); return; }
    const targets = this.artboardSelected
      ? [this.artboardEl()].filter(Boolean)
      : this.selectedNodes();
    const ctm = this.stage.getScreenCTM();
    if (ctm) {
      const inv = ctm.inverse();
      for (const n of targets) {
        let r; try { r = n.getBoundingClientRect(); } catch { continue; }
        if (!r.width && !r.height) continue;
        const a = new DOMPoint(r.left, r.top).matrixTransform(inv);
        const b = new DOMPoint(r.right, r.bottom).matrixTransform(inv);
        const box = document.createElementNS(SVG_NS, "rect");
        box.setAttribute("class", "hv-sel-box");
        box.setAttribute("x", nfmt(Math.min(a.x, b.x))); box.setAttribute("y", nfmt(Math.min(a.y, b.y)));
        box.setAttribute("width", nfmt(Math.abs(b.x - a.x))); box.setAttribute("height", nfmt(Math.abs(b.y - a.y)));
        ov.appendChild(box);
      }
    }
    // Transform is a SELECT sub-mode now (Ctrl+T scale / Ctrl+R rotate), not a tool.
    if (this.tool === "select" && this._xformMode && this.selection.size && !this.artboardSelected) this._mountTransformHandles();
    // Pen tool: show the selected object's anchors so add/remove is obvious (read-only —
    // the actual add/delete is the pen's hover+click affordance).
    if (this.tool === "pen") this._renderPenPoints();
  },
  // Read-only anchor dots for the selected path(s) while the pen tool is active, so it's
  // clear where points sit (and thus where the +/− hover affordance will add/remove them).
  _renderPenPoints() {
    const ov = this._overlayEl(); if (!ov) return;
    ov.querySelectorAll("g.hv-pen-points").forEach((g) => g.remove());
    if (this.tool !== "pen" || this._pen || this._penTempSelect || !this.stage || !this.selection.size) return;
    const m = this.stage.getScreenCTM(); const k = m ? Math.hypot(m.a, m.b) || 1 : 1;
    const r = 3.5 / k;
    const accept = this._nodeFocusAccept();   // restrict to the selected object(s)
    const g = document.createElementNS(SVG_NS, "g"); g.setAttribute("class", "hv-pen-points");
    const dot = (x, y) => { const d = document.createElementNS(SVG_NS, "rect"); d.setAttribute("class", "hv-pen-point"); d.setAttribute("x", nfmt(x - r)); d.setAttribute("y", nfmt(y - r)); d.setAttribute("width", nfmt(r * 2)); d.setAttribute("height", nfmt(r * 2)); g.appendChild(d); };
    for (const nd of pathNodes(this.stage, accept)) dot(nd.x, nd.y);
    for (const a of collectAnchors(this.stage, accept)) dot(a.x, a.y);
    ov.appendChild(g);
  },
};
