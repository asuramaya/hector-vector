// Marquee / drag-select tool (#31): rubber-band rectangle + freehand lasso (Alt) on the
// select tool, the node-tool anchor marquee, and segment-drag reshape. Object.assign MIXIN —
// methods run with `this === editor`, reaching editor state + the methods that stayed there
// (this._nodeBBoxUser / this._artworkNodes / this.mountNodeHandles / this._nodeFocusAccept) via
// `this`. Only module-level helpers are imported.
import { SVG_NS, nfmt, penPathD, penAnchorsToD, pathToAnchors, pathNodes, subOf } from "../../hv/index.js";
import { setStatus } from "../../app.js";

// Ray-cast point-in-polygon for lasso hit-testing; pts: [{x,y}]. Local to this tool —
// it's the only consumer (was a module helper in editor.js).
function pointInPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

export const marqueeMixin = {
  // ---------- drag-select tool: rubber-band rectangle, or freehand lasso (Alt) ----------
  // Node tool: drag a path segment to reshape it. A curved segment bends (adjust
  // its two bounding control handles so the point at parameter t tracks the cursor,
  // endpoints fixed — minimal-norm solution); a straight segment translates (both
  // endpoints move). One undo step.
  _beginSegmentDrag(startEvent, el, i, t0) {
    const pa = pathToAnchors(el);
    if (!pa.editable) { this._beginNodeMarquee(startEvent, startEvent.shiftKey); return; }
    const inv = () => this.stage.getScreenCTM().inverse();
    const start = new DOMPoint(startEvent.clientX, startEvent.clientY).matrixTransform(inv());
    const sb = subOf(pa.anchors, pa.subs, i);   // wrap to the NEXT anchor within i's subpath (#20)
    const A = pa.anchors[i], B = pa.anchors[(i + 1 < sb.end) ? i + 1 : (sb.closed ? sb.start : i)];
    const straight = !A.out && !B.in;
    const t = Math.max(0.1, Math.min(0.9, t0));
    const A0 = { x: A.x, y: A.y }, B0 = { x: B.x, y: B.y };
    const P1 = A.out ? { x: A.out.x, y: A.out.y } : { x: A.x, y: A.y };
    const P2 = B.in ? { x: B.in.x, y: B.in.y } : { x: B.x, y: B.y };
    let pushed = false, moved = false;
    const move = (ev) => {
      if (!moved && Math.hypot(ev.clientX - startEvent.clientX, ev.clientY - startEvent.clientY) < 3) return;
      moved = true;
      if (!pushed) { this.push("Reshape"); pushed = true; }
      const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(inv());
      let dx = p.x - start.x, dy = p.y - start.y;
      if (ev.shiftKey) { if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0; }   // lock to the H/V axis
      if (straight) { A.x = A0.x + dx; A.y = A0.y + dy; B.x = B0.x + dx; B.y = B0.y + dy; }
      else {
        const u = 1 - t, a = 3 * u * u * t, b = 3 * u * t * t, denom = a * a + b * b || 1;
        A.out = { x: P1.x + dx * a / denom, y: P1.y + dy * a / denom };
        B.in = { x: P2.x + dx * b / denom, y: P2.y + dy * b / denom };
      }
      el.setAttribute("d", penAnchorsToD(pa.anchors, pa.subs));
    };
    const up = () => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      this.mountNodeHandles();
      if (pushed) this._renderInspector();   // reshaped a live shape → it froze → refresh the panel
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  },
  // Node tool: rubber-band box over the canvas selects all enclosed path anchors
  // (Shift adds to the current anchor selection). A plain click clears.
  _beginNodeMarquee(startEvent, additive) {
    const ov = this._overlayEl(); if (!ov) return;
    const inv = () => this.stage.getScreenCTM().inverse();
    const start = new DOMPoint(startEvent.clientX, startEvent.clientY).matrixTransform(inv());
    const base = additive ? new Set(this._nodeSel) : new Set();
    const box = document.createElementNS(SVG_NS, "rect"); box.setAttribute("class", "hv-marquee");
    ov.appendChild(box);
    let moved = false;
    const move = (ev) => {
      if (!moved && Math.hypot(ev.clientX - startEvent.clientX, ev.clientY - startEvent.clientY) < 3) return;
      moved = true;
      const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(inv());
      const x0 = Math.min(start.x, p.x), y0 = Math.min(start.y, p.y), x1 = Math.max(start.x, p.x), y1 = Math.max(start.y, p.y);
      box.setAttribute("x", nfmt(x0)); box.setAttribute("y", nfmt(y0)); box.setAttribute("width", nfmt(x1 - x0)); box.setAttribute("height", nfmt(y1 - y0));
      const sel = new Set(base);
      for (const nd of pathNodes(this.stage, this._nodeFocusAccept())) if (nd.x >= x0 && nd.x <= x1 && nd.y >= y0 && nd.y <= y1) sel.add(this._nodeKey(nd));
      this._nodeSel = sel; this._refreshNodeSelHighlight();
    };
    const up = () => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      box.remove();
      if (!moved && !additive) this._nodeSel = new Set();   // plain click on empty → clear
      this.mountNodeHandles();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  },
  _beginMarquee(startEvent, lasso) {
    if (!this.stage) return;
    const ov = this._overlayEl(); if (!ov) return;
    const inv = () => this.stage.getScreenCTM().inverse();
    const start = new DOMPoint(startEvent.clientX, startEvent.clientY).matrixTransform(inv());
    const additive = startEvent.shiftKey;
    const pts = [{ x: start.x, y: start.y }];
    let moved = false;
    const shape = document.createElementNS(SVG_NS, lasso ? "polygon" : "rect");
    shape.setAttribute("class", "hv-marquee");
    ov.appendChild(shape);
    const drawRect = (p) => {
      shape.setAttribute("x", nfmt(Math.min(start.x, p.x))); shape.setAttribute("y", nfmt(Math.min(start.y, p.y)));
      shape.setAttribute("width", nfmt(Math.abs(p.x - start.x))); shape.setAttribute("height", nfmt(Math.abs(p.y - start.y)));
    };
    const move = (ev) => {
      const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(inv());
      if (Math.abs(p.x - start.x) > 1 || Math.abs(p.y - start.y) > 1) moved = true;
      if (lasso) { pts.push({ x: p.x, y: p.y }); shape.setAttribute("points", pts.map((q) => nfmt(q.x) + "," + nfmt(q.y)).join(" ")); }
      else drawRect(p);
    };
    const up = (ev) => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      shape.remove();
      if (!moved) {   // a plain click — fall back to single-pick / clear, like the select tool
        let hit = startEvent.target.closest && startEvent.target.closest("[data-hv-id]");
        if (hit && hit.getAttribute("data-hv-locked") === "1") hit = null;
        if (hit && this.stage.contains(hit)) {
          const id = hit.getAttribute("data-hv-id");
          if (additive) { this.selection.has(id) ? this.selection.delete(id) : this.selection.add(id); }
          else this.selection = new Set([id]);
          this.artboardSelected = false;
        } else if (!additive) { this.selection = new Set(); this.artboardSelected = true; }
        this._renderSelection(); this._renderInspector();
        return;
      }
      const end = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(inv());
      const hits = lasso ? this._nodesInLasso(pts) : this._nodesInRect(start, end);
      const ids = new Set(additive ? this.selection : []);
      hits.forEach((id) => ids.add(id));
      this.selection = ids; this.artboardSelected = false;
      this._renderSelection(); this._renderInspector();
      setStatus(`Selected ${this.selection.size} object${this.selection.size === 1 ? "" : "s"}.`, 1200);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  },
  _selectableNodes() {
    return this._artworkNodes().filter((n) => n.getAttribute("data-hv-locked") !== "1" && n.getAttribute("display") !== "none");
  },
  _nodesInRect(a, b) {
    const r = { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
    const out = [];
    for (const n of this._selectableNodes()) {
      let bb; try { bb = this._nodeBBoxUser(n); } catch { continue; }
      if (!(bb.x1 < r.x0 || bb.x0 > r.x1 || bb.y1 < r.y0 || bb.y0 > r.y1)) out.push(n.getAttribute("data-hv-id"));   // bbox touches marquee
    }
    return out;
  },
  _nodesInLasso(pts) {
    const out = [];
    for (const n of this._selectableNodes()) {
      let bb; try { bb = this._nodeBBoxUser(n); } catch { continue; }
      if (pointInPoly((bb.x0 + bb.x1) / 2, (bb.y0 + bb.y1) / 2, pts)) out.push(n.getAttribute("data-hv-id"));   // bbox centre inside lasso
    }
    return out;
  },
};
