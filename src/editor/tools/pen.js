// Pen tool (#31): click-to-place anchors, drag for tangents, Illustrator-style add/
// delete/continue on an existing path, Ctrl/Cmd = temporary Direct-Select. Extracted from
// editor.js as an Object.assign MIXIN — every method runs with `this === editor`, so it
// reaches the editor's state (this._pen / this.stage / this.selection) and the methods that
// stayed there (this._renderSelection / this.beginCoalesce / mountNodeHandles via this) by
// identity. Only module-level helpers are imported.
import {
  SVG_NS, nfmt, penPathD, penAnchorsToD, pathToAnchors, splitCubicInsert, nearestOnPaths, rebuildSubs,
} from "../../hv/index.js";
import { setStatus } from "../../app.js";
import { snapPoint, snap45 } from "../snap.js";

export const penMixin = {
  _penDown(e) {
    if (e.button !== 0) return;
    if (this._penTempSelect) return;   // Ctrl/Cmd held → Direct-Select mode owns the canvas (handle drags only)
    e.stopPropagation(); e.preventDefault();
    // Over an existing path with nothing in progress → auto add/delete an anchor
    // (Illustrator's pen behaviour) instead of starting a new path.
    if (!this._pen && this._penHit) {
      const hit = this._penHit; this._penHit = null; this._renderPenHint(null);
      if (hit.mode === "anchor") this._deletePenAnchor(hit.el, hit.k);
      else if (hit.mode === "continue") this._continuePen(hit.el, hit.k);
      else this._insertPenAnchor(hit.el, hit.i, hit.t);
      return;
    }
    const inv = () => this.stageCTM().inverse();
    let pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(inv());
    let anchor;            // the anchor this press adjusts (a new one, or the first when closing)
    let closing = false;
    if (!this._pen) {
      this._renderPenHint(null); this._setPenCursor(null);
      this.beginCoalesce();                       // snapshot before the path exists
      this.selection = new Set(); this.artboardSelected = false; this._renderSelection();
      const node = document.createElementNS(SVG_NS, "path");
      node.setAttribute("fill", "none");
      node.setAttribute("stroke", "#1d1d1f"); node.setAttribute("stroke-width", "1.5");
      node.setAttribute("vector-effect", "non-scaling-stroke");
      this._artHome().insertBefore(node, this._artBefore());   // into the isolation when isolated (Epic I)
      this._pen = { node, pts: [], closed: false, dragging: false };
      this._penHoverBound = (ev) => this._penHover(ev);
      window.addEventListener("pointermove", this._penHoverBound);
      anchor = { x: pt.x, y: pt.y, in: null, out: null };
      this._pen.pts.push(anchor);
    } else if (this._pen.pts.length >= 2 && this._penNearFirst(pt)) {
      // Close on the first anchor — but DON'T finish on press. Like Illustrator,
      // dragging now sets the closing tangent (the first anchor's handles); a plain
      // click (no drag) keeps the existing handles. The path finishes on release.
      this._pen.closed = true; closing = true;
      anchor = this._pen.pts[0];
      pt = { x: anchor.x, y: anchor.y };          // snap the close point exactly onto the first anchor
    } else {
      if (e.shiftKey && this._pen.pts.length) {
        const prev = this._pen.pts[this._pen.pts.length - 1];   // Shift = 45°-constrained segment
        pt = snapPoint(prev.x, prev.y, pt.x, pt.y);
      }
      anchor = { x: pt.x, y: pt.y, in: null, out: null };
      this._pen.pts.push(anchor);
    }
    this._pen.dragging = true;
    this._redrawPen(); this._renderPenMarks();
    let lastP = { x: pt.x, y: pt.y };
    const move = (ev) => {
      const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(inv());
      if (this._spacePan && !closing) {                             // Space = reposition the anchor (handles follow)
        const ddx = p.x - lastP.x, ddy = p.y - lastP.y;
        anchor.x += ddx; anchor.y += ddy;
        if (anchor.out) { anchor.out.x += ddx; anchor.out.y += ddy; }
        if (anchor.in) { anchor.in.x += ddx; anchor.in.y += ddy; }
      } else {
        const q = ev.shiftKey ? snap45(anchor.x, anchor.y, p.x, p.y) : p;   // Shift = 45° handle
        anchor.out = { x: q.x, y: q.y };                            // drag → smooth point
        anchor.in = ev.altKey ? null : { x: 2 * anchor.x - q.x, y: 2 * anchor.y - q.y };   // Alt = break (cusp)
      }
      lastP = { x: p.x, y: p.y };
      this._redrawPen(); this._renderPenMarks();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (this._pen) this._pen.dragging = false;
      if (closing) this._finishPen(true);          // close completes on release, after any tangent drag
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  },
  _penHover(ev) {
    if (!this._pen || this._pen.dragging) return;
    const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(this.stageCTM().inverse());
    const closeHover = this._pen.pts.length >= 2 && this._penNearFirst(p);
    this._redrawPen(closeHover ? null : { x: p.x, y: p.y });   // snap the rubber-band to the closing anchor
    this._renderPenMarks(closeHover);
    this._setPenCloseCursor(closeHover);
  },
  _setPenCloseCursor(on) { const w = document.querySelector(".stage-wrap"); if (w) w.classList.toggle("pen-close", !!on); },
  // Idle pen hover (no path in progress): detect a nearby editable path point and
  // arm the +/− add/delete affordance for the next click.
  // Ctrl/Cmd held in the pen tool → temporarily act as Direct-Select: mount the node
  // handles so anchors/handles are draggable, and suppress pen-down. Released on keyup.
  enterPenTempSelect() {
    if (this.tool !== "pen" || this._pen || this._penTempSelect) return;
    this._penTempSelect = true;
    this._penHit = null; this._renderPenHint(null); this._setPenCursor(null);
    const w = document.querySelector(".stage-wrap"); if (w) w.classList.add("pen-tempsel");
    this.mountNodeHandles();
  },
  exitPenTempSelect() {
    if (!this._penTempSelect) return;
    this._penTempSelect = false;
    const w = document.querySelector(".stage-wrap"); if (w) w.classList.remove("pen-tempsel");
    this.unmountNodeHandles();
  },
  _penIdleHover(ev) {
    if (this.tool !== "pen" || this._pen || this._penTempSelect || !this.stage) return;
    const m = this.stageCTM(); if (!m) { this._penHit = null; return; }
    const k = Math.hypot(m.a, m.b) || 1;
    const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(m.inverse());
    const hit = nearestOnPaths(this.stage, p.x, p.y, 6 / k);
    // an open path's endpoint resumes drawing (continue) rather than deleting
    if (hit && hit.mode === "anchor" && !hit.closed && (hit.k === 0 || hit.k === hit.count - 1)) hit.mode = "continue";
    this._penHit = hit;
    this._renderPenHint(hit);
    this._setPenCursor(hit ? hit.mode : null);
  },
  _setPenCursor(mode) {
    const w = document.querySelector(".stage-wrap"); if (!w) return;
    w.classList.toggle("pen-add", mode === "segment");
    w.classList.toggle("pen-del", mode === "anchor");
    w.classList.toggle("pen-close", mode === "continue");   // reuse the close (pointer) cursor
  },
  _renderPenHint(hit) {
    const ov = this._overlayEl(); if (!ov) return;
    ov.querySelectorAll("g.hv-pen-hint").forEach((g) => g.remove());
    if (!hit) return;
    const m = this.stageCTM(); const k = m ? Math.hypot(m.a, m.b) || 1 : 1;
    const r = 4 / k;
    const g = document.createElementNS(SVG_NS, "g"); g.setAttribute("class", "hv-pen-hint");
    if (hit.mode === "segment") {
      const sq = document.createElementNS(SVG_NS, "rect"); sq.setAttribute("class", "hv-pen-add");
      sq.setAttribute("x", nfmt(hit.x - r)); sq.setAttribute("y", nfmt(hit.y - r));
      sq.setAttribute("width", nfmt(r * 2)); sq.setAttribute("height", nfmt(r * 2));
      g.appendChild(sq);
    } else {
      const ring = document.createElementNS(SVG_NS, "circle");
      ring.setAttribute("class", hit.mode === "continue" ? "hv-pen-cont" : "hv-pen-del");
      ring.setAttribute("cx", nfmt(hit.x)); ring.setAttribute("cy", nfmt(hit.y)); ring.setAttribute("r", nfmt(r * 1.8));
      g.appendChild(ring);
    }
    ov.appendChild(g);
  },
  _insertPenAnchor(el, i, t) {
    const pa = pathToAnchors(el); if (!pa.editable) return;
    this.push("Add point");
    splitCubicInsert(pa.anchors, pa.subs, i, t);   // subpath-aware: new anchor joins segment i's subpath
    el.setAttribute("d", penAnchorsToD(pa.anchors, pa.subs));
    this.selection = new Set([el.getAttribute("data-hv-id")]); this.artboardSelected = false;
    this._renderSelection(); this._renderInspector();
    setStatus("Anchor added.", 1200);
  },
  _deletePenAnchor(el, k) {
    const pa = pathToAnchors(el); if (!pa.editable) return;
    this.push("Delete point");
    pa.anchors.splice(k, 1);
    const rb = rebuildSubs(pa.anchors, pa.subs);   // keep the other subpaths of a compound path
    if (rb.anchors.length < 2) { el.remove(); this.selection = new Set(); }
    else { el.setAttribute("d", penAnchorsToD(rb.anchors, rb.subs)); this.selection = new Set([el.getAttribute("data-hv-id")]); }
    this.artboardSelected = false;
    this._renderSelection(); this._renderInspector(); this._renderLayers();
    setStatus("Anchor removed.", 1200);
  },
  // Resume drawing an existing open path from one of its endpoints. Reuse the same
  // element (keeps its id + style); orient so the clicked end is the last pen point.
  _continuePen(el, k) {
    const pa = pathToAnchors(el); if (!pa.editable || pa.closed) return;
    if (pa.subs.length > 1) return;   // the in-progress pen draft is single-subpath; don't flatten a compound path
    this._renderPenHint(null); this._setPenCursor(null);
    this.beginCoalesce();
    let pts = pa.anchors.map((a) => ({ x: a.x, y: a.y, in: a.in, out: a.out }));
    if (k === 0) pts = pts.reverse().map((a) => ({ x: a.x, y: a.y, in: a.out, out: a.in }));   // flip direction
    this.selection = new Set(); this.artboardSelected = false; this._renderSelection();
    this._pen = { node: el, pts, closed: false, dragging: false, continued: true };
    this._penHoverBound = (ev) => this._penHover(ev);
    window.addEventListener("pointermove", this._penHoverBound);
    this._redrawPen(); this._renderPenMarks();
    setStatus("Continuing path — click to add points, click the first anchor to close, Enter to finish.", 2500);
  },
  _redrawPen(preview) {
    if (!this._pen) return;
    this._pen.node.setAttribute("d", penPathD(this._pen.pts, this._pen.closed, preview));
  },
  _penNearFirst(pt) {
    const f = this._pen.pts[0]; if (!f) return false;
    const m = this.stageCTM(); const k = m ? Math.hypot(m.a, m.b) || 1 : 1;
    return Math.hypot(pt.x - f.x, pt.y - f.y) < 8 / k;
  },
  _renderPenMarks(closeHover) {
    const ov = this._overlayEl(); if (!ov || !this._pen) return;
    ov.querySelectorAll("g.hv-pen").forEach((g) => g.remove());
    const m = this.stageCTM(); const k = m ? Math.hypot(m.a, m.b) || 1 : 1;
    const r = 4 / k, hr = 3 / k;
    const g = document.createElementNS(SVG_NS, "g"); g.setAttribute("class", "hv-pen");
    // bezier direction handles (tangent line + round endpoints). `in` and `out`
    // are independent — a smooth point keeps them mirrored, a cusp does not.
    for (const a of this._pen.pts) {
      for (const h of [a.in, a.out]) {
        if (!h) continue;
        const ln = document.createElementNS(SVG_NS, "line");
        ln.setAttribute("class", "hv-pen-handle-line");
        ln.setAttribute("x1", nfmt(a.x)); ln.setAttribute("y1", nfmt(a.y));
        ln.setAttribute("x2", nfmt(h.x)); ln.setAttribute("y2", nfmt(h.y));
        g.appendChild(ln);
        const dot = document.createElementNS(SVG_NS, "circle");
        dot.setAttribute("class", "hv-pen-handle");
        dot.setAttribute("cx", nfmt(h.x)); dot.setAttribute("cy", nfmt(h.y)); dot.setAttribute("r", nfmt(hr));
        g.appendChild(dot);
      }
    }
    // anchor squares — first is emphasised, and grows into a close target on hover
    this._pen.pts.forEach((a, i) => {
      const first = i === 0, close = first && closeHover;
      const rr = close ? r * 1.7 : r;
      const c = document.createElementNS(SVG_NS, "rect");
      c.setAttribute("class", "hv-pen-anchor" + (first ? " first" : "") + (close ? " close" : ""));
      c.setAttribute("x", nfmt(a.x - rr)); c.setAttribute("y", nfmt(a.y - rr));
      c.setAttribute("width", nfmt(rr * 2)); c.setAttribute("height", nfmt(rr * 2));
      g.appendChild(c);
    });
    ov.appendChild(g);
  },
  _finishPen(keep) {
    if (!this._pen) return;
    if (this._penHoverBound) { window.removeEventListener("pointermove", this._penHoverBound); this._penHoverBound = null; }
    this._setPenCloseCursor(false);
    const { node, pts, closed, continued } = this._pen;
    const ov = this._overlayEl(); if (ov) ov.querySelectorAll("g.hv-pen").forEach((g) => g.remove());
    this._pen = null;
    if (continued) {
      // resumed an existing path — keep its id/style, just re-serialize the geometry
      node.setAttribute("d", penPathD(pts, closed, null));
      this.commitCoalesce(closed ? "Close path" : "Edit path");
      const id = node.getAttribute("data-hv-id");
      this.selection = id ? new Set([id]) : new Set(); this.artboardSelected = false;
      this._renderSelection(); this._renderInspector(); this._renderLayers();
      setStatus(closed ? "Path closed." : "Path updated.", 1500);
      return;
    }
    if (!keep || pts.length < 2) { node.remove(); this.cancelCoalesce(); return; }
    node.setAttribute("d", penPathD(pts, closed, null));
    node.setAttribute("fill", closed ? (this.style.fill || "none") : "none");
    if (this.style.stroke && this.style.stroke !== "none" && this.style.strokeWidth > 0) {
      node.setAttribute("stroke", this.style.stroke); node.setAttribute("stroke-width", nfmt(this.style.strokeWidth));
    } else { node.setAttribute("stroke", "#1d1d1f"); node.setAttribute("stroke-width", "2"); }
    node.setAttribute("vector-effect", "non-scaling-stroke");
    node.setAttribute("stroke-linejoin", "round"); node.setAttribute("stroke-linecap", "round");
    const id = "n" + (++this.idSeq); node.setAttribute("data-hv-id", id);
    this.commitCoalesce("Pen path");
    this.selection = new Set([id]); this.artboardSelected = false;
    this._renderSelection(); this._renderInspector(); this._renderLayers();
    setStatus(closed ? "Closed path added." : "Path added.", 1500);
  },
};
