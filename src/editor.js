// =========================================================================
// hector-vector editor — the document IS the live stage <svg> (single source
// of truth). Undo/redo via markup snapshots; selection by data-hv-id; tools
// (select / node / pen / shapes), boolean ops, transforms, layers, inspector.
// Built on the hv library; talks to the app shell through a small service set.
// This is the main surface to extend with new tools/ops.
// =========================================================================

import {
  SVG_NS, MAX_HANDLES, SKIP_TAGS, SHAPE_TOOLS,
  nfmt, penPathD, toHexColor, marchingSquares, rasterMask,
  currentTranslate, setTranslate, matForOp, bakeMatrixInto,
  shapeToAbsPath, makeShapeNode, sizeShape, shapeMeaningful, collectAnchors, pathNodes, pathToAnchors,
  nearestOnPaths, splitCubicInsert,
} from "./hv/index.js";
import {
  setStatus, api, refreshAll, viewports, measureFit, outputPreviewEl,
  selectedOutput, setManualOutputName,
} from "./app.js";

function editorSvgEl() {
  return outputPreviewEl.querySelector("svg.inline-svg");
}

const editor = {
  stage: null,
  selection: new Set(),
  artboardSelected: false,
  tool: "select",
  history: [],
  redo: [],
  idSeq: 0,
  pinned: false,        // true when showing a blank/opened doc (skip library remount)
  _strokeWidthInput: null,
  // last-used appearance — newly drawn shapes inherit it (updated by applyFill/applyStroke)
  style: { fill: "#808080", stroke: "none", strokeWidth: 0 },
  _pen: null,           // in-progress pen path: { node, pts:[{x,y,in,out}], closed, dragging }
  _xform: null,         // transform-tool handle state during a scale drag
  _lastLayerId: null,   // anchor row for Shift-range select in the layers panel
  _nodeSel: new Set(),  // node tool: selected path-anchor keys ("pathId#k")
  clipboard: [],        // in-app clipboard: serialized node markup

  get dirty() { return this.history.length > 0; },

  // ---------- lifecycle ----------
  sync() {
    const el = editorSvgEl();
    if (el === this.stage) return;
    if (!el) { this.stage = null; this._renderInspector(); this._updateButtons(); return; }
    this.adopt(el);
  },
  adopt(svgEl) {
    if (this._penHoverBound) { window.removeEventListener("pointermove", this._penHoverBound); this._penHoverBound = null; }
    this._pen = null;
    this.selection = new Set();
    this._nodeSel = new Set();
    this.artboardSelected = false;
    this.history = [];
    this.redo = [];
    this._install(svgEl);
    this._renderSelection();
    this._renderInspector();
    this._updateButtons();
  },
  // Release the current document before another is mounted (or the app closes) so
  // nothing lingers: drop the (potentially multi-MB) undo/redo snapshots, detach the
  // pen's window listener, cancel any coalescing edit, and empty the overlay. The old
  // stage element itself is GC'd once the viewport innerHTML is replaced.
  dispose() {
    if (this._pen) this._finishPen(false);
    if (this._penHoverBound) { window.removeEventListener("pointermove", this._penHoverBound); this._penHoverBound = null; }
    if (this._penIdleBound) { window.removeEventListener("pointermove", this._penIdleBound); this._penIdleBound = null; this._penHit = null; }
    this.cancelCoalesce();
    const ov = this._overlayEl(); if (ov) ov.innerHTML = "";
    this.selection = new Set();
    this._nodeSel = new Set();
    this.artboardSelected = false;
    this.history = [];
    this.redo = [];
    this._strokeWidthInput = null;
    this._updateButtons();
  },
  _install(svgEl) {
    this.stage = svgEl;
    this._ensureStructure(svgEl);
    svgEl.classList.add("hv-pickable");
    if (!svgEl._hvBound) {
      svgEl.addEventListener("pointerdown", (e) => this._onPointerDown(e));
      svgEl._hvBound = true;
    }
  },
  _ensureStructure(svg) {
    let vb = svg.viewBox && svg.viewBox.baseVal;
    if (!vb || !vb.width) {
      const w = parseFloat(svg.getAttribute("width")) || 100;
      const h = parseFloat(svg.getAttribute("height")) || 100;
      svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
      vb = svg.viewBox.baseVal;
    }
    let ab = svg.querySelector("rect.hv-artboard");
    if (!ab) {
      ab = document.createElementNS(SVG_NS, "rect");
      ab.setAttribute("class", "hv-artboard");
      ab.setAttribute("fill", "none");
      svg.insertBefore(ab, svg.firstChild);
    }
    ab.setAttribute("x", nfmt(vb.x)); ab.setAttribute("y", nfmt(vb.y));
    ab.setAttribute("width", nfmt(vb.width)); ab.setAttribute("height", nfmt(vb.height));
    this._flattenWrapper(svg);    // layered extraction: unwrap a single wrapper <g> on import
    let max = 0;
    svg.querySelectorAll("[data-hv-id]").forEach((n) => {
      const m = +(/\d+/.exec(n.getAttribute("data-hv-id")) || [0])[0];
      if (m > max) max = m;
    });
    this.idSeq = max;
    for (const child of Array.from(svg.children)) {
      const tag = child.tagName.toLowerCase();
      if (SKIP_TAGS.has(tag)) continue;
      if (child.classList.contains("hv-artboard") || child.classList.contains("hv-overlay")) continue;
      if (!child.hasAttribute("data-hv-id")) child.setAttribute("data-hv-id", "n" + (++this.idSeq));
    }
    let ov = svg.querySelector("g.hv-overlay");
    if (!ov) { ov = document.createElementNS(SVG_NS, "g"); ov.setAttribute("class", "hv-overlay"); }
    svg.appendChild(ov);   // keep overlay last
  },
  // If the whole graphic is one un-tagged wrapper <g> (common in exported/traced
  // SVGs), unwrap it so each colour/shape becomes its own editable layer.
  _flattenWrapper(svg) {
    const art = [...svg.children].filter((c) => {
      const t = c.tagName.toLowerCase();
      return !SKIP_TAGS.has(t) && !c.classList.contains("hv-artboard") && !c.classList.contains("hv-overlay");
    });
    if (art.length !== 1) return;
    const g = art[0];
    if (g.tagName.toLowerCase() !== "g" || g.hasAttribute("data-hv-id")) return;
    const kids = [...g.children].filter((k) => !SKIP_TAGS.has(k.tagName.toLowerCase()));
    if (kids.length < 2) return;
    const gt = currentTranslate(g);
    for (const k of [...g.children]) {
      if (gt.x || gt.y) { const kt = currentTranslate(k); setTranslate(k, kt.x + gt.x, kt.y + gt.y); }
      svg.insertBefore(k, g);
    }
    g.remove();
  },
  _overlayEl() { return this.stage && this.stage.querySelector("g.hv-overlay"); },
  artboardEl() { return this.stage && this.stage.querySelector("rect.hv-artboard"); },

  // ---------- serialization ----------
  _historyMarkup() {
    const c = this.stage.cloneNode(true);
    c.querySelectorAll("g.hv-overlay").forEach((g) => g.remove());
    c.classList.remove("hv-pickable");
    return c.outerHTML;
  },
  serialize() {
    if (!this.stage) return "";
    const c = this.stage.cloneNode(true);
    c.querySelectorAll("g.hv-overlay").forEach((g) => g.remove());
    c.classList.remove("hv-pickable");
    c.querySelectorAll("[data-hv-id]").forEach((n) => {
      ["data-hv-id", "data-hv-name", "data-hv-locked"].forEach((a) => n.removeAttribute(a));
    });
    const ab = c.querySelector("rect.hv-artboard");
    if (ab) {
      const f = ab.getAttribute("fill");
      if (!f || f === "none") ab.remove();      // drop the invisible artboard from saved output
      else ab.removeAttribute("class");
    }
    return c.outerHTML;
  },

  // ---------- history ----------
  push() {
    if (!this.stage) return;
    this.commitCoalesce();                 // flush any in-progress live edit first
    this.history.push(this._state());
    this._trimHistory();
    this.redo = [];
    this._updateButtons();
  },
  // Cap undo memory by BYTES, not just count: each snapshot is the full document
  // markup, so a multi-MB traced doc at 100 deep would hold hundreds of MB and the
  // tab would balloon. Keep the newest entries within a budget (fewer undo steps on
  // huge docs is the right trade vs. lingering memory), and never exceed 100.
  _trimHistory() {
    let budget = 64 * 1024 * 1024;         // ~64 MB of snapshots (chars ≈ 2 bytes)
    for (let i = this.history.length - 1; i >= 0; i--) {
      budget -= (this.history[i].svg.length || 0) * 2;
      if (budget < 0) { this.history.splice(0, i + 1); return; }
    }
    if (this.history.length > 100) this.history.splice(0, this.history.length - 100);
  },
  // A run of continuous live edits (dragging a colour picker, typing a number)
  // collapses into ONE undo entry: snapshot once on begin, push it on commit.
  beginCoalesce() { if (!this._coalescing) { this._coalesceState = this._state(); this._coalescing = true; } },
  commitCoalesce() {
    if (!this._coalescing) return;
    this.history.push(this._coalesceState);
    this._trimHistory();
    this.redo = []; this._coalescing = false; this._coalesceState = null;
    this._updateButtons();
  },
  cancelCoalesce() { this._coalescing = false; this._coalesceState = null; },
  _state() { return { svg: this._historyMarkup(), sel: [...this.selection], ab: this.artboardSelected }; },
  undo() { if (this._pen) this._finishPen(true); this.commitCoalesce(); if (!this.history.length) return; this.redo.push(this._state()); this._restore(this.history.pop()); },
  redoAction() { if (this._pen) this._finishPen(true); this.commitCoalesce(); if (!this.redo.length) return; this.history.push(this._state()); this._restore(this.redo.pop()); },
  _restore(state) {
    const host = this.stage.parentElement; if (!host) return;
    const doc = new DOMParser().parseFromString(state.svg, "image/svg+xml");
    const fresh = document.importNode(doc.documentElement, true);
    fresh.classList.add("inline-svg");
    host.replaceChild(fresh, this.stage);
    this._install(fresh);
    this.selection = new Set(state.sel.filter((id) => this.nodeById(id)));
    this.artboardSelected = !!state.ab;
    this._renderSelection();
    this._renderInspector();
    this._updateButtons();
    measureFit(viewports.output);
  },
  _updateButtons() {
    const u = document.querySelector("#undo-button"), r = document.querySelector("#redo-button");
    if (u) u.disabled = !this.history.length;
    if (r) r.disabled = !this.redo.length;
  },

  // ---------- selection ----------
  nodeById(id) { return this.stage && this.stage.querySelector(`[data-hv-id="${CSS.escape(id)}"]`); },
  selectedNodes() { return [...this.selection].map((id) => this.nodeById(id)).filter(Boolean); },
  selectArtboard() {
    if (!this.stage) return;
    this.selection = new Set();
    this.artboardSelected = true;
    this._renderSelection(); this._renderInspector();
  },
  _onPointerDown(e) {
    if (this._spacePan) return;   // spacebar held → let the viewport pan the drag (don't select/draw)
    if (e.button !== 0) return;   // right/middle clicks are for the context menu, not draw/select
    if (this.tool === "pen") { this._penDown(e); return; }
    if (SHAPE_TOOLS.has(this.tool)) {
      if (e.button !== 0) return;
      e.stopPropagation(); e.preventDefault();   // draw, don't pan
      this._beginDraw(e);
      return;
    }
    if (this.tool === "marquee") {
      e.stopPropagation(); e.preventDefault();   // rubber-band select, don't pan
      this._beginMarquee(e, e.altKey);
      return;
    }
    if (this.tool === "node") {
      // anchor/handle drags stopPropagation, so reaching here = a click on empty
      // canvas or path body → drop the anchor selection.
      if (this._nodeSel.size) { this._nodeSel = new Set(); this._refreshNodeSelHighlight(); }
      return;
    }
    if (this.tool !== "select" && this.tool !== "transform") return;
    let hit = e.target.closest && e.target.closest("[data-hv-id]");
    if (hit && hit.getAttribute("data-hv-locked") === "1") hit = null;   // locked → not selectable
    if (hit && this.stage.contains(hit)) {
      e.stopPropagation();
      const id = hit.getAttribute("data-hv-id");
      if (e.shiftKey) { this.selection.has(id) ? this.selection.delete(id) : this.selection.add(id); }
      else if (!this.selection.has(id)) { this.selection = new Set([id]); }
      this.artboardSelected = false; this._lastLayerId = id;
      this._renderSelection(); this._renderInspector();
      if (this.selection.size) this._beginMove(e);
    } else {
      this.selection = new Set();      // empty space → select the artboard, let the frame pan
      this.artboardSelected = true;
      this._renderSelection(); this._renderInspector();
    }
  },
  _beginMove(startEvent) {
    const nodes = this.selectedNodes(); if (!nodes.length) return;
    const inv = () => this.stage.getScreenCTM().inverse();
    const start = new DOMPoint(startEvent.clientX, startEvent.clientY).matrixTransform(inv());
    const bases = nodes.map((n) => currentTranslate(n));
    let pushed = false;
    const move = (ev) => {
      const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(inv());
      const dx = p.x - start.x, dy = p.y - start.y;
      if (!pushed && (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01)) { this.push(); pushed = true; }
      nodes.forEach((n, i) => setTranslate(n, bases[i].x + dx, bases[i].y + dy));
      this._renderSelection();
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  },
  // Shape tools: click-drag on the canvas to create a primitive. The whole gesture
  // is one undo step — beginCoalesce snapshots the pre-draw doc, commitCoalesce
  // commits it once the shape is large enough to keep (a bare click creates nothing).
  _beginDraw(startEvent) {
    const tool = this.tool;
    const inv = () => this.stage.getScreenCTM().inverse();
    const start = new DOMPoint(startEvent.clientX, startEvent.clientY).matrixTransform(inv());
    this.beginCoalesce();                         // snapshot the document before the shape exists
    this.selection = new Set(); this.artboardSelected = false; this._renderSelection();
    const ov = this._overlayEl();
    const node = makeShapeNode(tool, start, this.style);
    this.stage.insertBefore(node, ov);
    let moved = false;
    const move = (ev) => {
      const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(inv());
      sizeShape(tool, node, start, p, ev.shiftKey);
      moved = true;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!moved || !shapeMeaningful(tool, node)) { node.remove(); this.cancelCoalesce(); return; }
      const id = "n" + (++this.idSeq);
      node.setAttribute("data-hv-id", id);
      this.commitCoalesce();                      // one undo entry for the whole draw
      this.selection = new Set([id]); this.artboardSelected = false;
      this._renderSelection(); this._renderInspector(); this._renderLayers();
      setStatus(`Added ${this.nodeName(node).toLowerCase()}.`, 1500);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  },
  // Pen tool: click to drop a corner anchor; click-drag to drop a smooth anchor
  // (the drag sets its bezier handle). Click the first anchor to close; Enter
  // finishes an open path. The whole construction is one undo step.
  _penDown(e) {
    if (e.button !== 0) return;
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
    const inv = () => this.stage.getScreenCTM().inverse();
    let pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(inv());
    if (!this._pen) {
      this._renderPenHint(null); this._setPenCursor(null);
      this.beginCoalesce();                       // snapshot before the path exists
      this.selection = new Set(); this.artboardSelected = false; this._renderSelection();
      const node = document.createElementNS(SVG_NS, "path");
      node.setAttribute("fill", "none");
      node.setAttribute("stroke", "#1d1d1f"); node.setAttribute("stroke-width", "1.5");
      node.setAttribute("vector-effect", "non-scaling-stroke");
      this.stage.insertBefore(node, this._overlayEl());
      this._pen = { node, pts: [], closed: false, dragging: false };
      this._penHoverBound = (ev) => this._penHover(ev);
      window.addEventListener("pointermove", this._penHoverBound);
    } else if (this._pen.pts.length >= 2 && this._penNearFirst(pt)) {
      this._pen.closed = true; this._finishPen(true); return;
    } else if (e.shiftKey && this._pen.pts.length) {
      const prev = this._pen.pts[this._pen.pts.length - 1];   // Shift = 45°-constrained segment
      pt = snapPoint(prev.x, prev.y, pt.x, pt.y);
    }
    const anchor = { x: pt.x, y: pt.y, in: null, out: null };
    this._pen.pts.push(anchor);
    this._pen.dragging = true;
    this._redrawPen(); this._renderPenMarks();
    const move = (ev) => {
      let p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(inv());
      if (ev.shiftKey) p = snap45(anchor.x, anchor.y, p.x, p.y);    // Shift = 45° handle
      anchor.out = { x: p.x, y: p.y };                              // drag → smooth point
      anchor.in = ev.altKey ? null : { x: 2 * anchor.x - p.x, y: 2 * anchor.y - p.y };   // Alt = break (cusp)
      this._redrawPen(); this._renderPenMarks();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (this._pen) this._pen.dragging = false;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  },
  _penHover(ev) {
    if (!this._pen || this._pen.dragging) return;
    const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(this.stage.getScreenCTM().inverse());
    const closeHover = this._pen.pts.length >= 2 && this._penNearFirst(p);
    this._redrawPen(closeHover ? null : { x: p.x, y: p.y });   // snap the rubber-band to the closing anchor
    this._renderPenMarks(closeHover);
    this._setPenCloseCursor(closeHover);
  },
  _setPenCloseCursor(on) { const w = document.querySelector(".stage-wrap"); if (w) w.classList.toggle("pen-close", !!on); },
  // Idle pen hover (no path in progress): detect a nearby editable path point and
  // arm the +/− add/delete affordance for the next click.
  _penIdleHover(ev) {
    if (this.tool !== "pen" || this._pen || !this.stage) return;
    const m = this.stage.getScreenCTM(); if (!m) { this._penHit = null; return; }
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
    const m = this.stage.getScreenCTM(); const k = m ? Math.hypot(m.a, m.b) || 1 : 1;
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
    this.push();
    splitCubicInsert(pa.anchors, pa.closed, i, t);
    el.setAttribute("d", penPathD(pa.anchors, pa.closed));
    this.selection = new Set([el.getAttribute("data-hv-id")]); this.artboardSelected = false;
    this._renderSelection(); this._renderInspector();
    setStatus("Anchor added.", 1200);
  },
  _deletePenAnchor(el, k) {
    const pa = pathToAnchors(el); if (!pa.editable) return;
    this.push();
    pa.anchors.splice(k, 1);
    if (pa.anchors.length < 2) { el.remove(); this.selection = new Set(); }
    else { el.setAttribute("d", penPathD(pa.anchors, pa.closed)); this.selection = new Set([el.getAttribute("data-hv-id")]); }
    this.artboardSelected = false;
    this._renderSelection(); this._renderInspector(); this._renderLayers();
    setStatus("Anchor removed.", 1200);
  },
  // Resume drawing an existing open path from one of its endpoints. Reuse the same
  // element (keeps its id + style); orient so the clicked end is the last pen point.
  _continuePen(el, k) {
    const pa = pathToAnchors(el); if (!pa.editable || pa.closed) return;
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
    const m = this.stage.getScreenCTM(); const k = m ? Math.hypot(m.a, m.b) || 1 : 1;
    return Math.hypot(pt.x - f.x, pt.y - f.y) < 8 / k;
  },
  _renderPenMarks(closeHover) {
    const ov = this._overlayEl(); if (!ov || !this._pen) return;
    ov.querySelectorAll("g.hv-pen").forEach((g) => g.remove());
    const m = this.stage.getScreenCTM(); const k = m ? Math.hypot(m.a, m.b) || 1 : 1;
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
      this.commitCoalesce();
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
    this.commitCoalesce();
    this.selection = new Set([id]); this.artboardSelected = false;
    this._renderSelection(); this._renderInspector(); this._renderLayers();
    setStatus(closed ? "Closed path added." : "Path added.", 1500);
  },
  deleteSelection() {
    const nodes = this.selectedNodes(); if (!nodes.length) return;
    this.push();
    nodes.forEach((n) => n.remove());
    this.selection = new Set();
    this._renderSelection(); this._renderInspector();
  },
  _renderSelection() {
    const ov = this._overlayEl(); if (!ov) return;
    ov.innerHTML = ""; this._xform = null;
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
    if (this.tool === "node") this.mountNodeHandles();
    if (this.tool === "transform") this._mountTransformHandles();
  },

  // ---------- tools ----------
  setTool(t) {
    if (t !== "select" && t !== "node" && t !== "pen" && t !== "transform" && t !== "marquee" && !SHAPE_TOOLS.has(t)) return;
    if (this._pen && t !== "pen") this._finishPen(true);   // keep any in-progress path
    if (t !== "node") this._nodeSel = new Set();           // anchor selection is node-tool-only
    this.tool = t;
    document.querySelectorAll(".tool-button").forEach((b) => b.classList.toggle("active", b.dataset.tool === t));
    const wrap = document.querySelector(".stage-wrap");
    if (wrap) { wrap.setAttribute("data-tool", t); wrap.classList.remove("pen-close"); }
    // pen idle-hover (over existing paths) drives the +/− add/delete-anchor affordance
    if (t === "pen") {
      if (!this._penIdleBound) { this._penIdleBound = (ev) => this._penIdleHover(ev); window.addEventListener("pointermove", this._penIdleBound); }
    } else if (this._penIdleBound) {
      window.removeEventListener("pointermove", this._penIdleBound); this._penIdleBound = null;
      this._penHit = null; this._renderPenHint(null); this._setPenCursor(null);
    }
    if (t === "node") this.mountNodeHandles(); else this.unmountNodeHandles();
    if (this.stage) this._renderSelection();   // show/hide the transform bbox handles
    const msg = {
      select: "Select tool. (A = nodes)",
      node: "Node tool — drag anchors/handles. Shift-click multi-select, Alt converts, Del removes. (V = select)",
      transform: "Transform — drag the box handles to scale. Shift = keep aspect.",
      marquee: "Drag-select — drag a box over objects. Alt = lasso. Shift = add.",
      rect: "Rectangle — drag on the canvas. (V = select)",
      ellipse: "Ellipse — drag on the canvas. Shift = circle.",
      line: "Line — drag on the canvas. Shift = 45°.",
      pen: "Pen — click for corners, drag for curves. Alt-drag = cusp, Shift = 45°. Over a path: + adds a point, over an anchor: − removes it. Enter finishes, click the first point to close.",
    };
    setStatus(msg[t] || "", 2000);
  },
  unmountNodeHandles() { const ov = this._overlayEl(); if (ov) ov.querySelectorAll(".hv-handles").forEach((g) => g.remove()); },
  onViewportChanged() {
    if (this.tool === "node" && this.stage) this.mountNodeHandles();
    if (this.tool === "transform" && this.stage) this._renderSelection();   // handles are constant-screen-size
    if (this._pen) { this._redrawPen(); this._renderPenMarks(); }
  },
  mountNodeHandles() {
    this.unmountNodeHandles();
    const ov = this._overlayEl(); if (!ov || !this.stage) return;
    const pnodes = pathNodes(this.stage);          // path anchors carry bezier direction handles
    const anchors = collectAnchors(this.stage);    // rect/ellipse/line/polygon corner points
    const total = pnodes.length + anchors.length;
    if (!total) return;
    if (total > MAX_HANDLES) { setStatus(`Too many anchors (${total}) to edit. Works best on traced paths.`, 4000); return; }
    // prune stale selection keys (anchors that no longer exist after an edit)
    if (this._nodeSel.size) {
      const live = new Set(pnodes.map((nd) => this._nodeKey(nd)));
      for (const key of [...this._nodeSel]) if (!live.has(key)) this._nodeSel.delete(key);
    }
    // constant ~5px on screen regardless of zoom (CTM.a = screen px per user unit)
    const m = this.stage.getScreenCTM();
    const k = m ? Math.hypot(m.a, m.b) || 1 : 1;
    const r = 5 / k, hr = 3.5 / k;
    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("class", "hv-handles");
    // two layers so every anchor square sits above every direction-handle line/dot
    const handleLayer = document.createElementNS(SVG_NS, "g");
    const anchorLayer = document.createElementNS(SVG_NS, "g");
    this._nodeEls = new Map();      // key → { nd, rect, refs, r } for group move + highlight
    for (const nd of pnodes) this._renderPathNode(handleLayer, anchorLayer, nd, r, hr);
    for (const a of anchors) {
      const c = document.createElementNS(SVG_NS, "circle");
      c.setAttribute("class", "hv-handle");
      c.setAttribute("cx", a.x); c.setAttribute("cy", a.y); c.setAttribute("r", r);
      this._bindNodeHandle(c, a);
      anchorLayer.appendChild(c);
    }
    g.appendChild(handleLayer); g.appendChild(anchorLayer);
    ov.appendChild(g);
  },
  _nodeKey(nd) { return nd.id + "#" + nd.k; },
  _refreshNodeSelHighlight() {
    if (!this._nodeEls) return;
    for (const [key, ent] of this._nodeEls) ent.rect.classList.toggle("selected", this._nodeSel.has(key));
  },
  _nodeIsSmooth(nd) {
    if (!nd.inH || !nd.outH) return false;
    const v1x = nd.inH.x - nd.x, v1y = nd.inH.y - nd.y, v2x = nd.outH.x - nd.x, v2y = nd.outH.y - nd.y;
    const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
    if (l1 < 1e-6 || l2 < 1e-6) return false;
    return (v1x * v2x + v1y * v2y) / (l1 * l2) < -0.985;   // handles ~opposite (within ~10°) → smooth
  },
  _renderPathNode(handleLayer, anchorLayer, nd, r, hr) {
    const refs = { inLine: null, inDot: null, outLine: null, outDot: null };
    const mkHandle = (side, h) => {
      const ln = document.createElementNS(SVG_NS, "line");
      ln.setAttribute("class", "hv-node-handle-line");
      ln.setAttribute("x1", nfmt(nd.x)); ln.setAttribute("y1", nfmt(nd.y));
      ln.setAttribute("x2", nfmt(h.x)); ln.setAttribute("y2", nfmt(h.y));
      handleLayer.appendChild(ln);
      const dot = document.createElementNS(SVG_NS, "circle");
      dot.setAttribute("class", "hv-node-handle");
      dot.setAttribute("cx", nfmt(h.x)); dot.setAttribute("cy", nfmt(h.y)); dot.setAttribute("r", nfmt(hr));
      handleLayer.appendChild(dot);
      if (side === "in") { refs.inLine = ln; refs.inDot = dot; } else { refs.outLine = ln; refs.outDot = dot; }
      this._bindHandleDrag(dot, nd, side, refs);
    };
    // a control coincident with its anchor is a retracted (corner) handle — keep the
    // live ref so moveTo drags it along, but don't draw a dot sitting on the anchor.
    const realH = (h) => h && Math.hypot(h.x - nd.x, h.y - nd.y) > 1e-6;
    if (realH(nd.inH)) mkHandle("in", nd.inH);
    if (realH(nd.outH)) mkHandle("out", nd.outH);
    const key = this._nodeKey(nd);
    const c = document.createElementNS(SVG_NS, "rect");
    c.setAttribute("class", "hv-handle hv-node-anchor" + (this._nodeSel.has(key) ? " selected" : ""));
    c.setAttribute("x", nfmt(nd.x - r)); c.setAttribute("y", nfmt(nd.y - r));
    c.setAttribute("width", nfmt(r * 2)); c.setAttribute("height", nfmt(r * 2));
    this._bindAnchorDrag(c, nd, r, refs);
    this._nodeEls.set(key, { nd, rect: c, refs, r });
    anchorLayer.appendChild(c);
  },
  // keep an anchor square + its direction handles in sync with the anchor at (ax,ay)
  _syncNodeEls(ent, ax, ay) {
    const { rect, refs, r, nd } = ent;
    rect.setAttribute("x", nfmt(ax - r)); rect.setAttribute("y", nfmt(ay - r));
    if (refs.inDot && nd.inH) {
      refs.inDot.setAttribute("cx", nfmt(nd.inH.x)); refs.inDot.setAttribute("cy", nfmt(nd.inH.y));
      refs.inLine.setAttribute("x1", nfmt(ax)); refs.inLine.setAttribute("y1", nfmt(ay));
      refs.inLine.setAttribute("x2", nfmt(nd.inH.x)); refs.inLine.setAttribute("y2", nfmt(nd.inH.y));
    }
    if (refs.outDot && nd.outH) {
      refs.outDot.setAttribute("cx", nfmt(nd.outH.x)); refs.outDot.setAttribute("cy", nfmt(nd.outH.y));
      refs.outLine.setAttribute("x1", nfmt(ax)); refs.outLine.setAttribute("y1", nfmt(ay));
      refs.outLine.setAttribute("x2", nfmt(nd.outH.x)); refs.outLine.setAttribute("y2", nfmt(nd.outH.y));
    }
  },
  // Alt-click a smooth anchor → corner (retract its handles). One undo step.
  _altClickAnchor(nd) {
    const { anchors, closed, editable } = pathToAnchors(nd.el);
    if (!editable || nd.k >= anchors.length) return;
    const a = anchors[nd.k];
    if (!a.in && !a.out) return;        // already a corner
    this.push();
    a.in = null; a.out = null;
    nd.el.setAttribute("d", penPathD(anchors, closed));
  },
  _bindAnchorDrag(c, nd, r, refs) {
    c.addEventListener("pointerdown", (e) => {
      e.stopPropagation(); e.preventDefault();
      c.setPointerCapture(e.pointerId); c.classList.add("dragging");
      const key = this._nodeKey(nd), alt = e.altKey;
      // selection: plain click = this anchor only; Shift = add for the (possible) drag,
      // deferring the deselect-toggle to pointerup so Shift-DRAG constrains the move
      // (rather than toggling the point off and moving nothing).
      const wasSel = this._nodeSel.has(key);
      if (!alt) {
        if (e.shiftKey) { if (!wasSel) this._nodeSel.add(key); }
        else if (!wasSel) { this._nodeSel = new Set([key]); }
        this._refreshNodeSelHighlight();
      }
      const m0 = this.stage.getScreenCTM();
      const sp = m0 ? new DOMPoint(e.clientX, e.clientY).matrixTransform(m0.inverse()) : { x: 0, y: 0 };
      const group = alt ? [] : [...this._nodeSel].map((kk) => this._nodeEls.get(kk)).filter(Boolean);
      const starts = group.map((ent) => ({ ent, x: ent.nd.x, y: ent.nd.y }));
      const snapper = makeAxisSnapper();
      let pushed = false, moved = false, conv = null;
      const move = (ev) => {
        if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 3) return;   // ignore click jitter
        moved = true;
        const m = this.stage.getScreenCTM(); if (!m) return;
        const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(m.inverse());
        if (!pushed) { this.push(); pushed = true; }
        if (alt) {                          // Alt-drag → pull symmetric handles (corner→smooth / re-smooth)
          if (!conv) conv = pathToAnchors(nd.el);
          if (!conv.editable || nd.k >= conv.anchors.length) return;
          const q = ev.shiftKey ? snap45(nd.x, nd.y, p.x, p.y) : p;
          conv.anchors[nd.k].out = { x: q.x, y: q.y };
          conv.anchors[nd.k].in = { x: 2 * nd.x - q.x, y: 2 * nd.y - q.y };
          nd.el.setAttribute("d", penPathD(conv.anchors, conv.closed));
          return;
        }
        let dx = p.x - sp.x, dy = p.y - sp.y;
        if (ev.shiftKey) { const s = snapper.snap(dx, dy); dx = s.x; dy = s.y; }   // sticky 45° move
        else snapper.reset();
        for (const st of starts) { st.ent.nd.moveTo(st.x + dx, st.y + dy); this._syncNodeEls(st.ent, st.x + dx, st.y + dy); }
      };
      const up = () => {
        try { c.releasePointerCapture(e.pointerId); } catch {}
        c.classList.remove("dragging");
        c.removeEventListener("pointermove", move); c.removeEventListener("pointerup", up);
        if (alt && !moved) this._altClickAnchor(nd);                       // Alt-click (no drag) → smooth→corner
        else if (!alt && e.shiftKey && !moved && wasSel) this._nodeSel.delete(key);   // Shift-click (no drag) → deselect
        this.mountNodeHandles();
      };
      c.addEventListener("pointermove", move);
      c.addEventListener("pointerup", up);
    });
  },
  // Delete the currently-selected path anchors, re-stitching each path (one undo step).
  deleteNodeSelection() {
    if (!this._nodeSel || !this._nodeSel.size) return false;
    const byPath = new Map();
    for (const key of this._nodeSel) {
      const i = key.lastIndexOf("#"), id = key.slice(0, i), k = +key.slice(i + 1);
      if (!byPath.has(id)) byPath.set(id, []);
      byPath.get(id).push(k);
    }
    const jobs = [];
    for (const [id, ks] of byPath) {
      const el = this.nodeById(id); if (!el) continue;
      const pa = pathToAnchors(el);
      if (!pa.editable) { setStatus("Path has arcs/quadratics — can't delete its points here.", 3000); continue; }
      jobs.push({ el, ks, pa });
    }
    if (!jobs.length) { this._nodeSel = new Set(); return false; }
    this.push();
    for (const { el, ks, pa } of jobs) {
      ks.sort((a, b) => b - a).forEach((k) => { if (k >= 0 && k < pa.anchors.length) pa.anchors.splice(k, 1); });
      if (pa.anchors.length < 2) { el.remove(); continue; }
      el.setAttribute("d", penPathD(pa.anchors, pa.closed));
    }
    this._nodeSel = new Set();
    this.mountNodeHandles(); this._renderLayers(); this._renderInspector();
    return true;
  },
  // Join two selected open endpoints (node tool): same path → close it; two paths →
  // concatenate into one (orienting each so the joined ends meet). One undo step.
  joinNodes() {
    if (this.tool !== "node" || this._nodeSel.size !== 2) {
      setStatus("Join needs two endpoints selected with the node tool.", 2800); return false;
    }
    const parse = (key) => { const i = key.lastIndexOf("#"); return { id: key.slice(0, i), k: +key.slice(i + 1) }; };
    const [A, B] = [...this._nodeSel].map(parse);
    const rev = (arr) => arr.slice().reverse().map((a) => ({ x: a.x, y: a.y, in: a.out, out: a.in }));
    if (A.id === B.id) {                                   // same path → close it
      const el = this.nodeById(A.id); if (!el) return false;
      const pa = pathToAnchors(el);
      if (!pa.editable) { setStatus("Can't join this path.", 2500); return false; }
      if (pa.closed) { setStatus("Path is already closed.", 2000); return false; }
      const last = pa.anchors.length - 1, ks = [A.k, B.k].sort((a, b) => a - b);
      if (!(ks[0] === 0 && ks[1] === last)) { setStatus("Select an open path's two endpoints to close it.", 3200); return false; }
      this.push();
      el.setAttribute("d", penPathD(pa.anchors, true));
      this.selection = new Set([A.id]); this._nodeSel = new Set();
      this.mountNodeHandles(); this._renderLayers(); this._renderInspector();
      setStatus("Path closed.", 1500); return true;
    }
    const elA = this.nodeById(A.id), elB = this.nodeById(B.id); if (!elA || !elB) return false;
    const paA = pathToAnchors(elA), paB = pathToAnchors(elB);
    if (!paA.editable || !paB.editable || paA.closed || paB.closed) { setStatus("Join needs two open editable paths.", 3200); return false; }
    const endA = A.k === paA.anchors.length - 1, startA = A.k === 0;
    const endB = B.k === paB.anchors.length - 1, startB = B.k === 0;
    if (!(endA || startA) || !(endB || startB)) { setStatus("Select an endpoint on each path.", 3200); return false; }
    const endsAt = endA ? paA.anchors.slice() : rev(paA.anchors);     // list ending at the joined point
    const startsAt = startB ? paB.anchors.slice() : rev(paB.anchors); // list starting at the joined point
    this.push();
    elA.setAttribute("d", penPathD(endsAt.concat(startsAt), false));
    elB.remove();
    this.selection = new Set([A.id]); this._nodeSel = new Set();
    this.mountNodeHandles(); this._renderLayers(); this._renderInspector();
    setStatus("Paths joined.", 1500); return true;
  },
  // Hit-test an anchor under a screen point (for the node-tool right-click menu).
  anchorAt(clientX, clientY) {
    if (this.tool !== "node" || !this.stage) return null;
    const m = this.stage.getScreenCTM(); if (!m) return null;
    const k = Math.hypot(m.a, m.b) || 1;
    const p = new DOMPoint(clientX, clientY).matrixTransform(m.inverse());
    const hit = nearestOnPaths(this.stage, p.x, p.y, 8 / k);
    if (!hit || hit.mode !== "anchor") return null;
    const id = hit.el.getAttribute("data-hv-id");
    return { id, k: hit.k, key: id + "#" + hit.k };
  },
  // Reshape selected anchors: "smooth" pulls auto Catmull-Rom tangent handles
  // (rounds the corner); "corner" retracts the handles (sharpens). One undo step.
  setSelectedAnchorsType(type) {
    if (this.tool !== "node" || !this._nodeSel.size) { setStatus("Select anchor points with the node tool first.", 2800); return false; }
    const byPath = new Map();
    for (const key of this._nodeSel) {
      const i = key.lastIndexOf("#"), id = key.slice(0, i), k = +key.slice(i + 1);
      if (!byPath.has(id)) byPath.set(id, []);
      byPath.get(id).push(k);
    }
    const jobs = [];
    for (const [id, ks] of byPath) {
      const el = this.nodeById(id); if (!el) continue;
      const pa = pathToAnchors(el);
      if (!pa.editable) { setStatus("Can't reshape this path's points.", 2800); continue; }
      jobs.push({ el, ks, pa });
    }
    if (!jobs.length) return false;
    this.push();
    const f = 1 / 3;
    for (const { el, ks, pa } of jobs) {
      const n = pa.anchors.length;
      for (const k of ks) {
        if (k < 0 || k >= n) continue;
        const A = pa.anchors[k];
        if (type === "corner") { A.in = null; A.out = null; continue; }
        const P = pa.closed ? pa.anchors[(k - 1 + n) % n] : (k > 0 ? pa.anchors[k - 1] : null);
        const N = pa.closed ? pa.anchors[(k + 1) % n] : (k < n - 1 ? pa.anchors[k + 1] : null);
        let dx, dy;
        if (P && N) { dx = N.x - P.x; dy = N.y - P.y; }
        else if (N) { dx = N.x - A.x; dy = N.y - A.y; }
        else if (P) { dx = A.x - P.x; dy = A.y - P.y; }
        else continue;
        const len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
        A.out = N ? { x: A.x + ux * Math.hypot(N.x - A.x, N.y - A.y) * f, y: A.y + uy * Math.hypot(N.x - A.x, N.y - A.y) * f } : null;
        A.in = P ? { x: A.x - ux * Math.hypot(A.x - P.x, A.y - P.y) * f, y: A.y - uy * Math.hypot(A.x - P.x, A.y - P.y) * f } : null;
      }
      el.setAttribute("d", penPathD(pa.anchors, pa.closed));
    }
    this.mountNodeHandles(); this._renderInspector();
    setStatus(type === "smooth" ? "Rounded point(s)." : "Sharpened point(s).", 1500);
    return true;
  },
  _bindHandleDrag(dot, nd, side, refs) {
    dot.addEventListener("pointerdown", (e) => {
      e.stopPropagation(); e.preventDefault();
      dot.setPointerCapture(e.pointerId); dot.classList.add("dragging");
      const smooth = this._nodeIsSmooth(nd);            // mirror the partner only if it started smooth
      let pushed = false;
      const sync = (line, h) => { dot.setAttribute("cx", nfmt(h.x)); dot.setAttribute("cy", nfmt(h.y)); line.setAttribute("x2", nfmt(h.x)); line.setAttribute("y2", nfmt(h.y)); };
      const move = (ev) => {
        const m = this.stage.getScreenCTM(); if (!m) return;
        if (!pushed) { this.push(); pushed = true; }
        let p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(m.inverse());
        if (ev.shiftKey) p = snap45(nd.x, nd.y, p.x, p.y);
        const mirror = smooth && !ev.altKey;            // Alt breaks the smooth point into a cusp
        if (side === "in") nd.setIn(p.x, p.y, mirror); else nd.setOut(p.x, p.y, mirror);
        if (side === "in") sync(refs.inLine, nd.inH); else sync(refs.outLine, nd.outH);
        if (mirror) {
          const oppLine = side === "in" ? refs.outLine : refs.inLine;
          const oppDot = side === "in" ? refs.outDot : refs.inDot;
          const oppH = side === "in" ? nd.outH : nd.inH;
          if (oppDot && oppH) { oppDot.setAttribute("cx", nfmt(oppH.x)); oppDot.setAttribute("cy", nfmt(oppH.y)); oppLine.setAttribute("x2", nfmt(oppH.x)); oppLine.setAttribute("y2", nfmt(oppH.y)); }
        }
      };
      const up = () => {
        try { dot.releasePointerCapture(e.pointerId); } catch {}
        dot.classList.remove("dragging");
        dot.removeEventListener("pointermove", move); dot.removeEventListener("pointerup", up);
        this.mountNodeHandles();
      };
      dot.addEventListener("pointermove", move);
      dot.addEventListener("pointerup", up);
    });
  },
  _bindNodeHandle(c, a) {
    c.addEventListener("pointerdown", (e) => {
      e.stopPropagation(); e.preventDefault();
      c.setPointerCapture(e.pointerId); c.classList.add("dragging");
      let pushed = false;
      const move = (ev) => {
        const m = this.stage.getScreenCTM(); if (!m) return;
        if (!pushed) { this.push(); pushed = true; }
        const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(m.inverse());
        c.setAttribute("cx", p.x); c.setAttribute("cy", p.y);
        a.set(p.x, p.y);
      };
      const up = () => {
        try { c.releasePointerCapture(e.pointerId); } catch {}
        c.classList.remove("dragging");
        c.removeEventListener("pointermove", move); c.removeEventListener("pointerup", up);
        this.mountNodeHandles();
      };
      c.addEventListener("pointermove", move);
      c.addEventListener("pointerup", up);
    });
  },

  // ---------- transform tool: scale the selection via bounding-box handles ----------
  // 8 handles on the selection bbox; dragging one scales (live, via a temporary
  // matrix transform) about the opposite corner/edge, then bakes the scale into
  // geometry on release so nodes stay translate-only. Shift on a corner keeps aspect.
  _mountTransformHandles() {
    this.unmountTransformHandles();
    const ov = this._overlayEl(); if (!ov || !this.stage || this.artboardSelected) return;
    const nodes = this.selectedNodes(); if (!nodes.length) return;
    const bb = this._bboxUnion(nodes);
    if (!(bb.x1 - bb.x0 > 1e-3) || !(bb.y1 - bb.y0 > 1e-3)) return;   // zero-area (a lone line) — nothing to scale
    const m = this.stage.getScreenCTM(); const k = m ? Math.hypot(m.a, m.b) || 1 : 1; const r = 4.5 / k;
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
    const g = document.createElementNS(SVG_NS, "g"); g.setAttribute("class", "hv-xform");
    const box = document.createElementNS(SVG_NS, "rect"); box.setAttribute("class", "hv-xform-box");
    box.setAttribute("x", nfmt(bb.x0)); box.setAttribute("y", nfmt(bb.y0));
    box.setAttribute("width", nfmt(bb.x1 - bb.x0)); box.setAttribute("height", nfmt(bb.y1 - bb.y0));
    g.appendChild(box);
    const handles = [];
    for (const s of specs) {
      const c = document.createElementNS(SVG_NS, "rect"); c.setAttribute("class", "hv-xform-handle hv-xform-" + s.h);
      c.setAttribute("x", nfmt(s.x - r)); c.setAttribute("y", nfmt(s.y - r));
      c.setAttribute("width", nfmt(2 * r)); c.setAttribute("height", nfmt(2 * r));
      this._bindTransformHandle(c, s);
      g.appendChild(c); handles.push({ el: c, s });
    }
    ov.appendChild(g);
    this._xform = { box, handles, r, bb };
  },
  unmountTransformHandles() {
    const ov = this._overlayEl(); if (ov) ov.querySelectorAll(".hv-xform").forEach((g) => g.remove());
    this._xform = null;
  },
  _scaleFactors(spec, p, shift) {
    let sx = spec.sx ? (p.x - spec.ax) / ((spec.x - spec.ax) || 1e-6) : 1;
    let sy = spec.sy ? (p.y - spec.ay) / ((spec.y - spec.ay) || 1e-6) : 1;
    const MIN = 0.02;
    if (sx < MIN) sx = MIN; if (sy < MIN) sy = MIN;
    if (shift && spec.sx && spec.sy) { const s = Math.max(sx, sy); sx = s; sy = s; }
    return { sx, sy };
  },
  _updateXformVisual(spec, sx, sy) {
    const xf = this._xform; if (!xf) return;
    const sp = (x, y) => ({ x: spec.ax + (x - spec.ax) * sx, y: spec.ay + (y - spec.ay) * sy });
    const a = sp(xf.bb.x0, xf.bb.y0), b = sp(xf.bb.x1, xf.bb.y1);
    xf.box.setAttribute("x", nfmt(Math.min(a.x, b.x))); xf.box.setAttribute("y", nfmt(Math.min(a.y, b.y)));
    xf.box.setAttribute("width", nfmt(Math.abs(b.x - a.x))); xf.box.setAttribute("height", nfmt(Math.abs(b.y - a.y)));
    for (const { el, s } of xf.handles) { const q = sp(s.x, s.y); el.setAttribute("x", nfmt(q.x - xf.r)); el.setAttribute("y", nfmt(q.y - xf.r)); }
  },
  _bindTransformHandle(c, spec) {
    c.addEventListener("pointerdown", (e) => {
      e.stopPropagation(); e.preventDefault();
      const nodes = this.selectedNodes(); if (!nodes.length) return;
      try { c.setPointerCapture(e.pointerId); } catch {}
      c.classList.add("dragging");
      const bases = nodes.map((n) => currentTranslate(n));
      let pushed = false, last = { sx: 1, sy: 1 };
      const apply = (sx, sy) => nodes.forEach((n, i) => {
        const b = bases[i];
        n.setAttribute("transform", `matrix(${nfmt(sx)} 0 0 ${nfmt(sy)} ${nfmt(sx * b.x + spec.ax * (1 - sx))} ${nfmt(sy * b.y + spec.ay * (1 - sy))})`);
      });
      const move = (ev) => {
        const m = this.stage.getScreenCTM(); if (!m) return;
        const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(m.inverse());
        const f = this._scaleFactors(spec, p, ev.shiftKey); last = f;
        if (!pushed && (Math.abs(f.sx - 1) > 1e-4 || Math.abs(f.sy - 1) > 1e-4)) { this.push(); pushed = true; }
        apply(f.sx, f.sy);
        this._updateXformVisual(spec, f.sx, f.sy);
      };
      const up = () => {
        try { c.releasePointerCapture(e.pointerId); } catch {}
        c.classList.remove("dragging");
        c.removeEventListener("pointermove", move); c.removeEventListener("pointerup", up);
        if (!pushed) { nodes.forEach((n, i) => setTranslate(n, bases[i].x, bases[i].y)); this._renderSelection(); return; }
        const { sx, sy } = last;
        const M = { a: sx, b: 0, c: 0, d: sy, e: spec.ax * (1 - sx), f: spec.ay * (1 - sy) };
        nodes.forEach((n, i) => { setTranslate(n, bases[i].x, bases[i].y); bakeMatrixInto(n, M, 0, 0); });
        this._renderSelection(); this._renderInspector(); this._renderLayers();
        setStatus("Scaled selection.", 1200);
      };
      c.addEventListener("pointermove", move);
      c.addEventListener("pointerup", up);
    });
  },

  // ---------- drag-select tool: rubber-band rectangle, or freehand lasso (Alt) ----------
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

  // ---------- property edits — apply* do NOT push; wrap with beginCoalesce/commitCoalesce ----------
  _eachSel(fn) { this.selectedNodes().forEach(fn); this._renderSelection(); },
  applyFill(color) { this.style.fill = color || "none"; this._eachSel((n) => n.setAttribute("fill", color || "none")); },
  applyStroke(color, width) {
    this.style.stroke = width > 0 ? color : "none"; this.style.strokeWidth = width > 0 ? width : 0;
    this._eachSel((n) => {
      if (width > 0) {
        n.setAttribute("stroke", color); n.setAttribute("stroke-width", nfmt(width));
        n.setAttribute("vector-effect", "non-scaling-stroke");
        n.setAttribute("stroke-linejoin", "round"); n.setAttribute("stroke-linecap", "round");
      } else {
        ["stroke", "stroke-width", "vector-effect", "stroke-linejoin", "stroke-linecap"].forEach((x) => n.removeAttribute(x));
      }
    });
  },
  applyOpacity(v) { this._eachSel((n) => { if (v >= 1) n.removeAttribute("opacity"); else n.setAttribute("opacity", nfmt(v)); }); },
  applyArtboardBg(color) { const ab = this.artboardEl(); if (ab) ab.setAttribute("fill", color || "none"); },
  applyArtboardSize(w, h) {
    const ab = this.artboardEl(); if (!ab || !this.stage) return;
    this.stage.setAttribute("viewBox", `0 0 ${nfmt(w)} ${nfmt(h)}`);
    this.stage.setAttribute("width", nfmt(w)); this.stage.setAttribute("height", nfmt(h));
    ab.setAttribute("x", 0); ab.setAttribute("y", 0); ab.setAttribute("width", nfmt(w)); ab.setAttribute("height", nfmt(h));
    this._renderSelection(); measureFit(viewports.output);
  },

  // ---------- Phase 2 object ops (each is one undo step) ----------
  _artworkNodes() { return [...this.stage.children].filter((c) => c.hasAttribute && c.hasAttribute("data-hv-id")); },
  duplicate() {
    const nodes = this.selectedNodes(); if (!nodes.length) return;
    this.push();
    const ov = this._overlayEl(); const ids = [];
    for (const n of nodes) {
      const c = n.cloneNode(true);
      const id = "n" + (++this.idSeq); c.setAttribute("data-hv-id", id);
      const t = currentTranslate(c); setTranslate(c, t.x + 12, t.y + 12);
      this.stage.insertBefore(c, ov);
      ids.push(id);
    }
    this.selection = new Set(ids); this.artboardSelected = false;
    this._renderSelection(); this._renderInspector();
    setStatus(`Duplicated ${ids.length} object${ids.length > 1 ? "s" : ""}.`, 1500);
  },
  // ---------- clipboard + selection commands (shared by keymap + context menu) ----------
  copy() {
    const nodes = this.selectedNodes(); if (!nodes.length) return false;
    this.clipboard = nodes.map((n) => { const c = n.cloneNode(true); c.removeAttribute("data-hv-id"); return c.outerHTML; });
    setStatus(`Copied ${nodes.length} object${nodes.length > 1 ? "s" : ""}.`, 1200);
    return true;
  },
  cut() { if (this.copy()) this.deleteSelection(); },
  paste() {
    if (!this.clipboard.length || !this.stage) return;
    const els = [];
    for (const markup of this.clipboard) {
      const doc = new DOMParser().parseFromString(`<svg xmlns="${SVG_NS}">${markup}</svg>`, "image/svg+xml");
      const src = doc.documentElement && doc.documentElement.firstElementChild;
      if (src) els.push(document.importNode(src, true));
    }
    if (!els.length) return;
    this.push();
    const ov = this._overlayEl(); const ids = [];
    for (const el of els) {
      const id = "n" + (++this.idSeq); el.setAttribute("data-hv-id", id);
      const t = currentTranslate(el); setTranslate(el, t.x + 12, t.y + 12);
      this.stage.insertBefore(el, ov); ids.push(id);
    }
    this.selection = new Set(ids); this.artboardSelected = false;
    this._renderSelection(); this._renderInspector(); this._renderLayers();
    setStatus(`Pasted ${ids.length} object${ids.length > 1 ? "s" : ""}.`, 1200);
  },
  // Merge another vector's artwork INTO the current canvas (vs Open, which replaces).
  // The incoming art is scaled to fit (never upscaled past native) and centred in
  // this artboard, with the fit baked into geometry so everything stays
  // translate-only, then wrapped in one group → a single movable/ungroupable object.
  placeSvgMarkup(text, label) {
    if (!this.stage) { setStatus("Open or create a canvas first, then place into it.", 3500); return 0; }
    let root;
    try { root = new DOMParser().parseFromString(text, "image/svg+xml").documentElement; } catch { root = null; }
    if (!root || root.tagName.toLowerCase() !== "svg") { setStatus("Couldn't read that vector.", 3000); return 0; }
    const SKIP = new Set(["defs", "metadata", "style", "title", "desc", "symbol"]);
    const src = [...root.children].filter((c) => {
      const t = c.tagName.toLowerCase();
      return !SKIP.has(t) && !c.classList.contains("hv-artboard") && !c.classList.contains("hv-overlay");
    });
    if (!src.length) { setStatus("That vector has no artwork to place.", 3000); return 0; }
    // Source bounds: viewBox, else width/height, else this artboard (no transform).
    const vbA = this.stage.viewBox.baseVal;
    const p = (root.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
    let sx = 0, sy = 0, sw = 0, sh = 0;
    if (p.length === 4 && p[2] > 0) { [sx, sy, sw, sh] = p; }
    else { sw = parseFloat(root.getAttribute("width")) || 0; sh = parseFloat(root.getAttribute("height")) || 0; }
    let s = 1, ex = 0, ey = 0;
    if (sw > 0 && sh > 0 && vbA && vbA.width) {
      s = Math.min(1, 0.95 * Math.min(vbA.width / sw, vbA.height / sh));
      ex = vbA.x + (vbA.width - sw * s) / 2 - sx * s;
      ey = vbA.y + (vbA.height - sh * s) / 2 - sy * s;
    }
    const m = { a: s, b: 0, c: 0, d: s, e: ex, f: ey };
    this.beginCoalesce();
    const ov = this._overlayEl();
    const g = document.createElementNS(SVG_NS, "g");
    const gid = "n" + (++this.idSeq);
    g.setAttribute("data-hv-id", gid);
    if (label) g.setAttribute("data-hv-name", "Placed: " + String(label).replace(/\.[^.]+$/, ""));
    for (const child of src) {
      const node = document.importNode(child, true);
      node.querySelectorAll?.("[data-hv-id]").forEach((d) => d.removeAttribute("data-hv-id"));
      node.setAttribute("data-hv-id", "n" + (++this.idSeq));
      bakeMatrixInto(node, m, 0, 0);     // fit-scale + centre baked in (stays translate-only)
      g.appendChild(node);
    }
    this.stage.insertBefore(g, ov);
    this.commitCoalesce();
    this.selection = new Set([gid]); this.artboardSelected = false;
    this._renderSelection(); this._renderInspector(); this._renderLayers();
    setStatus(`Placed ${label || "vector"} — ${src.length} object${src.length > 1 ? "s" : ""} (grouped).`, 2800);
    return src.length;
  },
  selectAll() {
    if (!this.stage) return;
    const ids = this._artworkNodes().filter((n) => n.getAttribute("data-hv-locked") !== "1").map((n) => n.getAttribute("data-hv-id"));
    this.selection = new Set(ids); this.artboardSelected = false;
    this._renderSelection(); this._renderInspector(); this._renderLayers();
  },
  nudge(dx, dy) {
    const nodes = this.selectedNodes(); if (!nodes.length) return;
    this.push();
    nodes.forEach((n) => { const t = currentTranslate(n); setTranslate(n, t.x + dx, t.y + dy); });
    this._renderSelection();
  },
  reorder(mode) {
    const nodes = this.selectedNodes(); if (!nodes.length || !this.stage) return;
    this.push();
    const ov = this._overlayEl();
    if (mode === "front") { for (const n of nodes) this.stage.insertBefore(n, ov); }
    else if (mode === "back") { const first = this._artworkNodes()[0]; for (const n of nodes.slice().reverse()) this.stage.insertBefore(n, first); }
    else if (mode === "forward") { for (const n of nodes.slice().reverse()) { const nx = n.nextElementSibling; if (nx && nx !== ov && nx.hasAttribute("data-hv-id")) this.stage.insertBefore(nx, n); } }
    else if (mode === "backward") { for (const n of nodes) { const pv = n.previousElementSibling; if (pv && pv.hasAttribute("data-hv-id")) this.stage.insertBefore(n, pv); } }
    this._renderSelection(); this._renderLayers();
  },
  // Rotate 90° / flip — contextual: the selected object(s) around their bbox
  // centre, or the whole artwork around the artboard centre when the artboard is
  // selected (a 90° artboard rotation also swaps W/H and reframes to the origin).
  transform(op) {
    if (!this.stage) return;
    const whole = this.artboardSelected || this.selection.size === 0;
    const nodes = whole ? this._artworkNodes() : this.selectedNodes();
    if (!nodes.length) { setStatus("Nothing to transform.", 1500); return; }
    this.push();
    const vb = this.stage.viewBox.baseVal;
    let cx, cy;
    if (whole) { cx = vb.x + vb.width / 2; cy = vb.y + vb.height / 2; }
    else { const bb = this._bboxUnion(nodes); cx = (bb.x0 + bb.x1) / 2; cy = (bb.y0 + bb.y1) / 2; }
    const m = matForOp(op, cx, cy);
    for (const n of nodes) bakeMatrixInto(n, m, 0, 0);
    if (whole && (op === "rotateCW" || op === "rotateCCW")) {
      const W = vb.width, H = vb.height;                 // content now spans H×W around the centre
      const shiftX = H / 2 - cx, shiftY = W / 2 - cy;    // recentre into a fresh H×W frame at origin
      for (const n of this._artworkNodes()) { const t = currentTranslate(n); setTranslate(n, t.x + shiftX, t.y + shiftY); }
      this.stage.setAttribute("viewBox", `0 0 ${nfmt(H)} ${nfmt(W)}`);
      this.stage.setAttribute("width", nfmt(H)); this.stage.setAttribute("height", nfmt(W));
      const ab = this.artboardEl(); if (ab) { ab.setAttribute("x", 0); ab.setAttribute("y", 0); ab.setAttribute("width", nfmt(H)); ab.setAttribute("height", nfmt(W)); }
      measureFit(viewports.output);
    }
    this._renderSelection(); this._renderInspector(); this._renderLayers();
    const what = whole ? "Artboard" : "Selection";
    const how = { flipH: "flipped horizontally", flipV: "flipped vertically", rotateCW: "rotated 90° CW", rotateCCW: "rotated 90° CCW" }[op] || op;
    setStatus(`${what} ${how}.`, 1800);
  },
  invertSpace() {
    const sel = this._fillableSelection();
    const nodes = sel.length ? sel : this._artworkNodes().filter((n) => shapeToAbsPath(n));
    if (!nodes.length || !this.stage) return;
    const vb = this.stage.viewBox.baseVal;
    const x0 = vb.x, y0 = vb.y, x1 = vb.x + vb.width, y1 = vb.y + vb.height;
    const inArt = (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
    const pad = Math.max(x1 - x0, y1 - y0) * 0.02 + 1;
    const bb = { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
    // negative = inside the artboard but outside the union of shapes (overlaps merge,
    // unlike the old even-odd compound which XOR'd them — that was the Phase-2 caveat).
    // Raster mask, not per-node isPointInFill: invert falls back to every artwork
    // layer, so the vector test (O(nodes) per probe) hung the tab on traced docs.
    const mask = this._rasterMask(nodes, bb, 1536);
    const d = marchingSquares((x, y) => inArt(x, y) && !mask.inside(x, y), bb, 160);
    let color = "#000000";
    for (const n of nodes) { const f = n.getAttribute("fill"); if (f && f !== "none") { color = f; break; } }
    this._commitBoolean(nodes, d, "nonzero", null, "Inverted space — negative bounded by the artboard.", color);
  },
  // Alpha-bitmap union of the nodes' fills over `bbox` (user space) → O(1)
  // inside-test for marching squares. Keeps booleans/invert fast at any node count.
  _rasterMask(nodes, bbox, px) {
    const paths = [];
    for (const n of nodes) { const d = shapeToAbsPath(n); if (d) paths.push({ d, rule: n.getAttribute("fill-rule") }); }
    return rasterMask(paths, bbox, px);
  },

  // ---------- boolean ops (Phase 4) ----------
  // Shapes convertible to a fillable outline (rect/ellipse/circle/poly/path); lines
  // and groups have no area and are skipped.
  _fillableSelection() { return this._artworkNodes().filter((n) => this.selection.has(n.getAttribute("data-hv-id")) && shapeToAbsPath(n)); },
  _nodeBBoxUser(n) {
    const bb = n.getBBox(), t = currentTranslate(n);
    return { x0: bb.x + t.x, y0: bb.y + t.y, x1: bb.x + bb.width + t.x, y1: bb.y + bb.height + t.y };
  },
  // A reusable inside-test built from temp absolute-path clones of the shapes,
  // attached to the stage so SVGGeometryElement.isPointInFill works in stage user space.
  _fillTester(nodes) {
    const layer = document.createElementNS(SVG_NS, "g");
    const tps = [];
    for (const n of nodes) {
      const d = shapeToAbsPath(n); if (!d) continue;
      const p = document.createElementNS(SVG_NS, "path");
      p.setAttribute("d", d);
      p.setAttribute("fill-rule", n.getAttribute("fill-rule") || "nonzero");
      layer.appendChild(p); tps.push(p);
    }
    this.stage.insertBefore(layer, this._overlayEl());   // synchronous use only — removed before any paint
    const pt = this.stage.createSVGPoint();
    return {
      count: tps.length,
      inAny: (x, y) => { pt.x = x; pt.y = y; return tps.some((p) => p.isPointInFill(pt)); },
      inAll: (x, y) => { pt.x = x; pt.y = y; return tps.length > 0 && tps.every((p) => p.isPointInFill(pt)); },
      dispose: () => layer.remove(),
    };
  },
  booleanOp(op) {
    if (!this.stage) return;
    const nodes = this._fillableSelection();
    if (nodes.length < 2) { setStatus("Select 2 or more filled shapes for a boolean op.", 2800); return; }
    let d, msg, src;
    if (op === "union") { d = this._unionPath(nodes); msg = `United ${nodes.length} shapes.`; src = nodes[nodes.length - 1]; }
    else if (op === "intersect") { d = this._intersectPath(nodes); msg = `Intersection of ${nodes.length} shapes.`; src = nodes[nodes.length - 1]; }
    else if (op === "subtract") { d = this._subtractPath(nodes[0], nodes.slice(1)); msg = "Subtracted front shapes from the back one."; src = nodes[0]; }
    else return;
    this._commitBoolean(nodes, d, "nonzero", src, msg);
  },
  _bboxUnion(nodes) {
    return nodes.map((n) => this._nodeBBoxUser(n)).reduce((a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) }));
  },
  _pad(bb, f) { const p = Math.max(bb.x1 - bb.x0, bb.y1 - bb.y0) * f + 1; return { x0: bb.x0 - p, y0: bb.y0 - p, x1: bb.x1 + p, y1: bb.y1 + p }; },
  _unionPath(nodes) {
    const bb = this._pad(this._bboxUnion(nodes), 0.02);
    const mask = this._rasterMask(nodes, bb, 1024);
    return marchingSquares((x, y) => mask.inside(x, y), bb, 140);
  },
  _intersectPath(nodes) {
    const t = this._fillTester(nodes);
    try {
      const bb = nodes.map((n) => this._nodeBBoxUser(n)).reduce((a, b) => ({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) }));
      if (bb.x1 <= bb.x0 || bb.y1 <= bb.y0) return "";
      return marchingSquares((x, y) => t.inAll(x, y), this._pad(bb, 0.02), 130);
    } finally { t.dispose(); }
  },
  _subtractPath(base, others) {
    const bb = this._pad(this._nodeBBoxUser(base), 0.02);
    const mB = this._rasterMask([base], bb, 1024), mO = this._rasterMask(others, bb, 1024);
    return marchingSquares((x, y) => mB.inside(x, y) && !mO.inside(x, y), bb, 140);
  },
  _commitBoolean(nodes, d, fillRule, src, msg, fillOverride) {
    if (!d) { setStatus("Result is empty — nothing changed.", 2800); return; }
    this.push();
    const anchor = nodes[0];   // keep the result where the bottom-most input was
    const path = document.createElementNS(SVG_NS, "path");
    const id = "n" + (++this.idSeq); path.setAttribute("data-hv-id", id);
    path.setAttribute("d", d);
    if (fillRule) path.setAttribute("fill-rule", fillRule);
    path.setAttribute("fill", fillOverride || (src && src.getAttribute("fill")) || "#000000");
    if (src) ["stroke", "stroke-width", "vector-effect", "stroke-linejoin", "stroke-linecap", "opacity"].forEach((a) => { const v = src.getAttribute(a); if (v) path.setAttribute(a, v); });
    this.stage.insertBefore(path, anchor);
    nodes.forEach((n) => n.remove());
    this.selection = new Set([id]); this.artboardSelected = false;
    this._renderSelection(); this._renderInspector(); this._renderLayers();
    setStatus(msg, 2000);
  },

  // ---------- layers ----------
  // Layer-row selection with modifiers (mirrors the canvas + a file manager):
  // plain = single, Cmd/Ctrl = toggle one, Shift = contiguous range from the last
  // anchor (in panel order, which is front-first). Locked rows never join a range.
  _layerClick(id, e) {
    const order = this._artworkNodes().map((n) => n.getAttribute("data-hv-id")).reverse();   // front-first, like the panel
    const additive = e.ctrlKey || e.metaKey;
    if (e.shiftKey && this._lastLayerId && order.includes(this._lastLayerId)) {
      const a = order.indexOf(this._lastLayerId), b = order.indexOf(id);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      if (!additive) this.selection = new Set();
      for (let i = lo; i <= hi; i++) {
        const nn = this.nodeById(order[i]);
        if (nn && nn.getAttribute("data-hv-locked") !== "1") this.selection.add(order[i]);
      }
    } else if (additive) {
      this.selection.has(id) ? this.selection.delete(id) : this.selection.add(id);
      this._lastLayerId = id;
    } else {
      this.selection = new Set([id]);
      this._lastLayerId = id;
    }
    this.artboardSelected = false;
    this._renderSelection(); this._renderInspector();
  },
  nodeName(n) {
    const custom = n.getAttribute("data-hv-name"); if (custom) return custom;
    const map = { path: "Path", rect: "Rectangle", circle: "Circle", ellipse: "Ellipse", polygon: "Polygon", polyline: "Polyline", line: "Line", g: "Group", image: "Image", text: "Text" };
    return map[n.tagName.toLowerCase()] || n.tagName.toLowerCase();
  },
  setVisibility(id, visible) {
    const n = this.nodeById(id); if (!n) return;
    this.push();
    if (visible) n.removeAttribute("display"); else n.setAttribute("display", "none");
    this._renderLayers(); this._renderSelection();
  },
  toggleLock(id) {
    const n = this.nodeById(id); if (!n) return;
    this.push();
    if (n.getAttribute("data-hv-locked") === "1") n.removeAttribute("data-hv-locked");
    else { n.setAttribute("data-hv-locked", "1"); this.selection.delete(id); }
    this._renderSelection(); this._renderInspector();
  },
  rename(id, name) {
    const n = this.nodeById(id); if (!n) return;
    this.push();
    if (name) n.setAttribute("data-hv-name", name); else n.removeAttribute("data-hv-name");
    this._renderLayers();
  },
  reorderTo(srcId, tgtId) {
    const src = this.nodeById(srcId), tgt = this.nodeById(tgtId);
    if (!src || !tgt || src === tgt) return;
    this.push();
    this.stage.insertBefore(src, tgt.nextSibling);   // src lands just in front of tgt
    this._renderSelection(); this._renderLayers();
  },
  group() {
    const ordered = this._artworkNodes().filter((n) => this.selection.has(n.getAttribute("data-hv-id")));
    if (ordered.length < 2) { setStatus("Select 2 or more objects to group.", 2500); return; }
    this.push();
    const ov = this._overlayEl();
    const g = document.createElementNS(SVG_NS, "g");
    const id = "n" + (++this.idSeq); g.setAttribute("data-hv-id", id);
    const anchor = ordered[ordered.length - 1].nextSibling;
    ordered.forEach((n) => { n.removeAttribute("data-hv-id"); g.appendChild(n); });
    this.stage.insertBefore(g, anchor && anchor !== ov ? anchor : ov);
    this.selection = new Set([id]); this.artboardSelected = false;
    this._renderSelection(); this._renderInspector();
    setStatus(`Grouped ${ordered.length} objects.`, 1500);
  },
  ungroup() {
    const groups = this.selectedNodes().filter((n) => n.tagName.toLowerCase() === "g");
    if (!groups.length) { setStatus("Select a group to ungroup.", 2500); return; }
    this.push();
    const ids = [];
    for (const g of groups) {
      const gt = currentTranslate(g);
      for (const k of [...g.children]) {
        if (gt.x || gt.y) { const kt = currentTranslate(k); setTranslate(k, kt.x + gt.x, kt.y + gt.y); }
        const id = "n" + (++this.idSeq); k.setAttribute("data-hv-id", id); ids.push(id);
        this.stage.insertBefore(k, g);
      }
      g.remove();
    }
    this.selection = new Set(ids); this.artboardSelected = false;
    this._renderSelection(); this._renderInspector();
    setStatus("Ungrouped.", 1500);
  },
  // Remove ghost/redundant layers: empty groups, paths/shapes with no drawable
  // area (a tracing speck or stray "M0 0"), and fully unpainted nodes. Recurses
  // into groups and unwraps single-child groups. One undo step; no-op if clean.
  cleanupLayers() {
    if (!this.stage) return;
    this.beginCoalesce();
    let removed = 0, unwrapped = 0;
    // Speck threshold is relative to the canvas — a 0.5px floor is meaningless on a
    // 9000px trace, where noise blobs can be tens of px. ~0.3% of the larger side.
    const vb = this.stage.viewBox.baseVal;
    const speck = Math.max((Math.max(vb?.width || 0, vb?.height || 0) || 1000) * 0.003, 0.5);
    const unpainted = (n) => {
      const fill = n.getAttribute("fill");
      const stroke = n.getAttribute("stroke");
      const sw = parseFloat(n.getAttribute("stroke-width"));
      const noStroke = !stroke || stroke === "none" || !(sw > 0);
      return fill === "none" && noStroke;   // fill defaults to black, so only explicit none counts
    };
    const degenerate = (n) => {
      let bb; try { bb = n.getBBox(); } catch { return true; }
      if (bb.width < speck && bb.height < speck) return true;   // sub-threshold speck / empty path
      return unpainted(n);
    };
    const scrub = (parent) => {
      for (const child of [...parent.children]) {
        const tag = child.tagName.toLowerCase();
        if (SKIP_TAGS.has(tag) || child.classList.contains("hv-artboard") || child.classList.contains("hv-overlay")) continue;
        if (tag === "g") {
          scrub(child);
          const kids = [...child.children].filter((k) => !SKIP_TAGS.has(k.tagName.toLowerCase()));
          if (kids.length === 0) { child.remove(); removed++; }
          else if (kids.length === 1) {           // unwrap pointless single-child group
            const k = kids[0];
            const gt = currentTranslate(child);
            if (gt.x || gt.y) { const kt = currentTranslate(k); setTranslate(k, kt.x + gt.x, kt.y + gt.y); }
            if (!k.hasAttribute("data-hv-id") && child.hasAttribute("data-hv-id")) k.setAttribute("data-hv-id", child.getAttribute("data-hv-id"));
            parent.insertBefore(k, child); child.remove(); unwrapped++;
          }
        } else if (degenerate(child)) { child.remove(); removed++; }
      }
    };
    scrub(this.stage);
    if (!removed && !unwrapped) { this.cancelCoalesce(); setStatus("No ghost layers found.", 2000); return; }
    this.commitCoalesce();
    this.selection = new Set([...this.selection].filter((id) => this.nodeById(id)));
    this._renderSelection(); this._renderInspector(); this._renderLayers();
    const bits = [];
    if (removed) bits.push(`removed ${removed} ghost layer${removed > 1 ? "s" : ""}`);
    if (unwrapped) bits.push(`unwrapped ${unwrapped} group${unwrapped > 1 ? "s" : ""}`);
    setStatus(`Cleaned up — ${bits.join(", ")}.`, 2500);
  },
  // Collapse same-paint sibling <path>s into one compound path. Traces commonly
  // explode a single colour into hundreds of translate-positioned paths, so we
  // bake each path's translate into its geometry first, then concatenate `d`.
  consolidateByColor() {
    if (!this.stage) return;
    const I = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    const paintSig = (n) => ["fill", "stroke", "stroke-width", "opacity", "fill-opacity", "stroke-opacity", "fill-rule"]
      .map((a) => n.getAttribute(a) || "").join("|");
    this.beginCoalesce();
    let mergedAway = 0, into = 0;
    const parents = [this.stage, ...this.stage.querySelectorAll("g")].filter((p) => !p.classList.contains("hv-overlay"));
    for (const parent of parents) {
      if (!parent.isConnected) continue;
      const buckets = new Map();
      for (const child of [...parent.children]) {
        if (child.tagName.toLowerCase() !== "path") continue;
        if (child.classList.contains("hv-artboard") || child.classList.contains("hv-overlay")) continue;
        if (child.getAttribute("data-hv-locked") === "1" || child.getAttribute("display") === "none") continue;
        const k = paintSig(child);
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k).push(child);
      }
      for (const arr of buckets.values()) {
        if (arr.length < 2) continue;
        arr.forEach((p) => bakeMatrixInto(p, I, 0, 0));   // translate → absolute geometry
        const head = arr[0];
        let d = (head.getAttribute("d") || "").trim();
        for (let i = 1; i < arr.length; i++) {
          const dd = (arr[i].getAttribute("d") || "").trim();
          if (dd) d += " " + dd;
          arr[i].remove(); mergedAway++;
        }
        head.setAttribute("d", d);
        into++;
      }
    }
    if (!mergedAway) { this.cancelCoalesce(); setStatus("Nothing to merge — each layer is already a distinct colour.", 3000); return; }
    this.commitCoalesce();
    this.selection = new Set([...this.selection].filter((id) => this.nodeById(id)));
    this._renderSelection(); this._renderInspector(); this._renderLayers();
    setStatus(`Merged ${mergedAway + into} layers into ${into} by colour.`, 3000);
  },
  _renderLayers() {
    const list = document.querySelector("#layers-list");
    if (!list) return;
    list.innerHTML = "";
    if (!this.stage) return;
    const nodes = this._artworkNodes().slice().reverse();   // top of list = frontmost
    for (const n of nodes) {
      const id = n.getAttribute("data-hv-id");
      const row = document.createElement("div");
      row.className = "layer-row" + (this.selection.has(id) ? " active" : "");
      row.draggable = true; row.dataset.id = id;

      const eye = document.createElement("button");
      eye.type = "button"; eye.className = "layer-btn";
      const hidden = n.getAttribute("display") === "none";
      eye.textContent = hidden ? "○" : "●"; eye.title = hidden ? "Show" : "Hide";
      eye.addEventListener("click", (e) => { e.stopPropagation(); this.setVisibility(id, hidden); });

      const swatch = document.createElement("span");
      swatch.className = "layer-swatch";
      const fill = toHexColor(n.getAttribute("fill"));
      if (fill && n.getAttribute("fill") !== "none") { swatch.style.background = fill; swatch.style.backgroundImage = "none"; }
      swatch.title = n.getAttribute("fill") || "no fill";

      const name = document.createElement("span");
      name.className = "layer-name"; name.textContent = this.nodeName(n);
      name.title = "Double-click to rename";
      name.addEventListener("dblclick", (e) => { e.stopPropagation(); this._renameInline(n, name); });

      const lock = document.createElement("button");
      lock.type = "button"; lock.className = "layer-btn";
      const locked = n.getAttribute("data-hv-locked") === "1";
      lock.textContent = locked ? "L" : "·"; lock.title = locked ? "Unlock" : "Lock"; lock.classList.toggle("on", locked);
      lock.addEventListener("click", (e) => { e.stopPropagation(); this.toggleLock(id); });

      row.append(eye, swatch, name, lock);
      row.addEventListener("click", (e) => {
        if (n.getAttribute("data-hv-locked") === "1") return;
        this._layerClick(id, e);
      });
      row.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", id); e.dataTransfer.effectAllowed = "move"; row.classList.add("dragging"); });
      row.addEventListener("dragend", () => row.classList.remove("dragging"));
      row.addEventListener("dragover", (e) => { e.preventDefault(); });
      row.addEventListener("drop", (e) => { e.preventDefault(); const src = e.dataTransfer.getData("text/plain"); if (src && src !== id) this.reorderTo(src, id); });
      list.appendChild(row);
    }
    // Artboard row, pinned at the bottom like a background — a reliable click
    // target for selecting the canvas even when artwork covers every pixel.
    const abRow = document.createElement("div");
    abRow.className = "layer-row artboard-row" + (this.artboardSelected ? " active" : "");
    const abSwatch = document.createElement("span");
    abSwatch.className = "layer-swatch";
    const ab = this.artboardEl();
    const abFill = ab && toHexColor(ab.getAttribute("fill"));
    if (abFill && ab.getAttribute("fill") !== "none") { abSwatch.style.background = abFill; abSwatch.style.backgroundImage = "none"; }
    abSwatch.title = (ab && ab.getAttribute("fill")) || "no background";
    const abName = document.createElement("span");
    abName.className = "layer-name"; abName.textContent = "Artboard";
    abName.title = "The canvas (Shift+O)";
    abRow.append(abSwatch, abName);
    abRow.addEventListener("click", () => this.selectArtboard());
    list.appendChild(abRow);
  },
  _renameInline(node, span) {
    const input = document.createElement("input");
    input.type = "text"; input.className = "layer-rename"; input.value = this.nodeName(node);
    const done = (commit) => {
      if (commit) this.rename(node.getAttribute("data-hv-id"), input.value.trim());
      else this._renderLayers();
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") done(true); if (e.key === "Escape") done(false); });
    input.addEventListener("blur", () => done(true));
    span.replaceWith(input); input.focus(); input.select();
  },
  // Rename from elsewhere (context menu): reuse the layers-panel inline editor when
  // that row is on screen, otherwise fall back to a prompt so it always works.
  beginRename(id) {
    const n = this.nodeById(id); if (!n) return;
    const span = document.querySelector(`#layers-list .layer-row[data-id="${CSS.escape(id)}"] .layer-name`);
    if (span) { this._renameInline(n, span); return; }
    const name = window.prompt("Rename object", this.nodeName(n));
    if (name != null) this.rename(id, name.trim());
  },

  // ---------- inspector ----------
  _renderInspector() {
    this._renderLayers();   // keep the layers panel in sync with structure/selection
    const body = document.querySelector("#inspector-body");
    const title = document.querySelector("#inspector-title");
    if (!body) return;
    body.innerHTML = "";
    if (!this.stage) { if (title) title.textContent = "No canvas"; body.innerHTML = `<div class="insp-empty">Import or open a vector.</div>`; return; }
    if (this.artboardSelected) { if (title) title.textContent = "Artboard"; body.appendChild(this._artboardPanel()); return; }
    const nodes = this.selectedNodes();
    if (!nodes.length) { if (title) title.textContent = "Nothing selected"; body.innerHTML = `<div class="insp-empty">Click a shape to select it, or click empty canvas for the artboard.</div>`; return; }
    if (title) title.textContent = nodes.length === 1 ? "Object" : `${nodes.length} objects`;
    body.appendChild(this._objectPanel(nodes));
  },
  _objectPanel(nodes) {
    const first = nodes[0];
    const wrap = document.createElement("div");
    const commit = () => this.commitCoalesce();
    const fillHex = toHexColor(first.getAttribute("fill")) || "#000000";
    const fillNone = first.getAttribute("fill") === "none";
    wrap.appendChild(inspGroup("Fill", [
      colorRow("Colour", fillHex, (v) => { this.beginCoalesce(); this.applyFill(v); }, commit),
      checkRow("No fill", fillNone, (on) => { this.push(); this.applyFill(on ? null : (toHexColor(first.getAttribute("fill")) || "#000000")); }),
    ]));
    const strokeHex = toHexColor(first.getAttribute("stroke")) || "#000000";
    const strokeW = parseFloat(first.getAttribute("stroke-width")) || 0;
    this._strokeWidthInput = null;
    const curW = () => Math.max(parseFloat(this._strokeWidthInput && this._strokeWidthInput.value) || strokeW || 1, 0.01);
    const curC = () => toHexColor(first.getAttribute("stroke")) || strokeHex;
    wrap.appendChild(inspGroup("Stroke", [
      colorRow("Colour", strokeHex, (v) => { this.beginCoalesce(); this.applyStroke(v, curW()); }, commit),
      numRow("Width", strokeW, 0, 0.5, (v) => { this.beginCoalesce(); this.applyStroke(curC(), v); }, (inp) => { this._strokeWidthInput = inp; }, commit),
    ]));
    const op = first.hasAttribute("opacity") ? parseFloat(first.getAttribute("opacity")) : 1;
    wrap.appendChild(inspGroup("Opacity", [
      numRow("Alpha", op, 0, 0.05, (v) => { this.beginCoalesce(); this.applyOpacity(Math.max(0, Math.min(1, v))); }, null, commit),
    ]));
    // Object actions (duplicate/delete/reorder/booleans/invert) live on the
    // right-click context menu now — the inspector is properties only.
    return wrap;
  },
  _artboardPanel() {
    const ab = this.artboardEl();
    const vb = this.stage.viewBox.baseVal;
    const wrap = document.createElement("div");
    const commit = () => this.commitCoalesce();
    const bgHex = toHexColor(ab.getAttribute("fill")) || "#ffffff";
    const bgNone = !ab.getAttribute("fill") || ab.getAttribute("fill") === "none";
    let wInp, hInp;
    const liveSize = () => { this.beginCoalesce(); this.applyArtboardSize(parseFloat(wInp.value) || vb.width, parseFloat(hInp.value) || vb.height); };
    wrap.appendChild(inspGroup("Size", [
      numRow("Width", Math.round(vb.width), 1, 1, liveSize, (i) => { wInp = i; }, commit),
      numRow("Height", Math.round(vb.height), 1, 1, liveSize, (i) => { hInp = i; }, commit),
    ]));
    wrap.appendChild(inspGroup("Background", [
      colorRow("Colour", bgHex, (v) => { this.beginCoalesce(); this.applyArtboardBg(v); }, commit),
      checkRow("Transparent", bgNone, (on) => { this.push(); this.applyArtboardBg(on ? null : (toHexColor(ab.getAttribute("fill")) || "#ffffff")); }),
    ]));
    return wrap;
  },

  // ---------- save ----------
  async save() {
    if (!this.stage) return;
    if (!selectedOutput) { setStatus("Save needs an imported or opened document for now.", 3500); return; }
    const svgText = this.serialize(); if (!svgText) return;
    try {
      const data = await api("/api/save-svg", "POST", { folder: selectedOutput.folder, name: selectedOutput.name, svg: svgText });
      setManualOutputName(data.name);
      this.pinned = false;
      await refreshAll();
      setStatus(data.message || "Saved.", 2500);
    } catch (e) { setStatus(`Save failed: ${e.message}`, 4000); }
  },
};

// ---------- inspector control builders ----------
function inspGroup(title, rows) {
  const g = document.createElement("div"); g.className = "insp-group";
  const t = document.createElement("div"); t.className = "insp-title"; t.textContent = title; g.appendChild(t);
  rows.forEach((r) => g.appendChild(r));
  return g;
}
function inspRow(label, control) {
  const row = document.createElement("div"); row.className = "insp-row";
  const s = document.createElement("span"); s.textContent = label;
  row.appendChild(s); row.appendChild(control); return row;
}
function colorRow(label, value, onLive, onCommit) {
  const inp = document.createElement("input"); inp.type = "color"; inp.value = value || "#000000";
  inp.addEventListener("input", () => onLive(inp.value));
  inp.addEventListener("change", () => { onLive(inp.value); if (onCommit) onCommit(); });
  return inspRow(label, inp);
}
function numRow(label, value, min, step, onLive, capture, onCommit) {
  const inp = document.createElement("input"); inp.type = "number"; inp.value = String(value);
  if (min != null) inp.min = String(min);
  inp.step = String(step);
  inp.addEventListener("input", () => { if (inp.value !== "") onLive(parseFloat(inp.value)); });
  inp.addEventListener("change", () => { if (inp.value !== "") onLive(parseFloat(inp.value)); if (onCommit) onCommit(); });
  if (capture) capture(inp);
  return inspRow(label, inp);
}
function checkRow(label, checked, onChange) {
  const inp = document.createElement("input"); inp.type = "checkbox"; inp.checked = checked;
  inp.addEventListener("change", () => onChange(inp.checked));
  return inspRow(label, inp);
}

function ghostBtn(label, onClick) {
  const b = document.createElement("button"); b.type = "button"; b.className = "ghost-button"; b.textContent = label;
  b.addEventListener("click", onClick); return b;
}

// Ray-cast point-in-polygon (for lasso selection); pts: [{x,y}].
function pointInPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

// Snap the vector from (ox,oy) to (px,py) onto the nearest 45° spoke, keeping its
// length — for direction handles, where the drag distance IS the handle length.
function snap45(ox, oy, px, py) {
  const dx = px - ox, dy = py - oy, len = Math.hypot(dx, dy);
  if (len < 1e-6) return { x: px, y: py };
  const step = Math.PI / 4, a = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x: ox + Math.cos(a) * len, y: oy + Math.sin(a) * len };
}
// Snap a *movement* vector to the nearest 45° axis by PROJECTION, so a dragged
// point tracks the cursor along the constraint line instead of being flung out to
// the raw diagonal distance. This is the right feel for moving/placing points.
function snapDelta(dx, dy) {
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return { x: 0, y: 0 };
  const step = Math.PI / 4, a = Math.round(Math.atan2(dy, dx) / step) * step;
  const ux = Math.cos(a), uy = Math.sin(a), proj = dx * ux + dy * uy;
  return { x: ux * proj, y: uy * proj };
}
function snapPoint(ox, oy, px, py) { const s = snapDelta(px - ox, py - oy); return { x: ox + s.x, y: oy + s.y }; }
// A *sticky* 45° snapper for continuous dragging: it locks to the first axis and
// only switches once the drag direction is well past the sector boundary (~12°
// hysteresis), so wobble near a boundary doesn't flip the constrained axis. Call
// reset() when Shift is released so re-pressing it re-decides from the current dir.
function makeAxisSnapper() {
  const step = Math.PI / 4;
  let axis = null;
  return {
    reset() { axis = null; },
    snap(dx, dy) {
      if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return { x: 0, y: 0 };
      const raw = Math.atan2(dy, dx);
      const nearest = Math.round(raw / step) * step;
      if (axis === null) axis = nearest;
      else {
        const diff = Math.abs(Math.atan2(Math.sin(raw - axis), Math.cos(raw - axis)));
        if (diff > step / 2 + 0.21) axis = nearest;   // >~34.5° from the locked axis → switch
      }
      const ux = Math.cos(axis), uy = Math.sin(axis), proj = dx * ux + dy * uy;
      return { x: ux * proj, y: uy * proj };
    },
  };
}

export { editor, ghostBtn };
