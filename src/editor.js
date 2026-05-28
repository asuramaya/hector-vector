// =========================================================================
// hector-vector editor — the document IS the live stage <svg> (single source
// of truth). Undo/redo via markup snapshots; selection by data-hv-id; tools
// (select / node / pen / shapes), boolean ops, transforms, layers, inspector.
// Built on the hv library; talks to the app shell through a small service set.
// This is the main surface to extend with new tools/ops.
// =========================================================================

import {
  SVG_NS, MAX_HANDLES, SKIP_TAGS, SHAPE_TOOLS,
  nfmt, penPathD, toHexColor, marchingSquares,
  currentTranslate, setTranslate, matForOp, bakeMatrixInto,
  shapeToAbsPath, makeShapeNode, sizeShape, shapeMeaningful, collectAnchors,
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
  _pen: null,           // in-progress pen path: { node, pts:[{x,y,out}], closed, dragging }
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
    this.artboardSelected = false;
    this.history = [];
    this.redo = [];
    this._install(svgEl);
    this._renderSelection();
    this._renderInspector();
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
    if (this.history.length > 100) this.history.shift();
    this.redo = [];
    this._updateButtons();
  },
  // A run of continuous live edits (dragging a colour picker, typing a number)
  // collapses into ONE undo entry: snapshot once on begin, push it on commit.
  beginCoalesce() { if (!this._coalescing) { this._coalesceState = this._state(); this._coalescing = true; } },
  commitCoalesce() {
    if (!this._coalescing) return;
    this.history.push(this._coalesceState);
    if (this.history.length > 100) this.history.shift();
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
    if (this.tool !== "select") return;
    let hit = e.target.closest && e.target.closest("[data-hv-id]");
    if (hit && hit.getAttribute("data-hv-locked") === "1") hit = null;   // locked → not selectable
    if (hit && this.stage.contains(hit)) {
      e.stopPropagation();
      const id = hit.getAttribute("data-hv-id");
      if (e.shiftKey) { this.selection.has(id) ? this.selection.delete(id) : this.selection.add(id); }
      else if (!this.selection.has(id)) { this.selection = new Set([id]); }
      this.artboardSelected = false;
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
    const inv = () => this.stage.getScreenCTM().inverse();
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(inv());
    if (!this._pen) {
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
    }
    const anchor = { x: pt.x, y: pt.y, out: null };
    this._pen.pts.push(anchor);
    this._pen.dragging = true;
    this._redrawPen(); this._renderPenMarks();
    const move = (ev) => {
      const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(inv());
      anchor.out = { x: p.x, y: p.y };            // drag → smooth point
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
    this._redrawPen({ x: p.x, y: p.y });
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
  _renderPenMarks() {
    const ov = this._overlayEl(); if (!ov || !this._pen) return;
    ov.querySelectorAll("g.hv-pen").forEach((g) => g.remove());
    const m = this.stage.getScreenCTM(); const k = m ? Math.hypot(m.a, m.b) || 1 : 1; const r = 4 / k;
    const g = document.createElementNS(SVG_NS, "g"); g.setAttribute("class", "hv-pen");
    this._pen.pts.forEach((a, i) => {
      const c = document.createElementNS(SVG_NS, "rect");
      c.setAttribute("class", "hv-pen-anchor" + (i === 0 ? " first" : ""));
      c.setAttribute("x", nfmt(a.x - r)); c.setAttribute("y", nfmt(a.y - r));
      c.setAttribute("width", nfmt(r * 2)); c.setAttribute("height", nfmt(r * 2));
      g.appendChild(c);
    });
    ov.appendChild(g);
  },
  _finishPen(keep) {
    if (!this._pen) return;
    if (this._penHoverBound) { window.removeEventListener("pointermove", this._penHoverBound); this._penHoverBound = null; }
    const { node, pts, closed } = this._pen;
    const ov = this._overlayEl(); if (ov) ov.querySelectorAll("g.hv-pen").forEach((g) => g.remove());
    this._pen = null;
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
    ov.innerHTML = "";
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
  },

  // ---------- tools ----------
  setTool(t) {
    if (t !== "select" && t !== "node" && t !== "pen" && !SHAPE_TOOLS.has(t)) return;
    if (this._pen && t !== "pen") this._finishPen(true);   // keep any in-progress path
    this.tool = t;
    document.querySelectorAll(".tool-button").forEach((b) => b.classList.toggle("active", b.dataset.tool === t));
    if (t === "node") this.mountNodeHandles(); else this.unmountNodeHandles();
    const msg = {
      select: "Select tool. (A = nodes)",
      node: "Node tool — drag anchors. (V = select)",
      rect: "Rectangle — drag on the canvas. (V = select)",
      ellipse: "Ellipse — drag on the canvas. Shift = circle.",
      line: "Line — drag on the canvas. Shift = 45°.",
      pen: "Pen — click to add points, drag for curves, Enter to finish, click the first point to close.",
    };
    setStatus(msg[t] || "", 2000);
  },
  unmountNodeHandles() { const ov = this._overlayEl(); if (ov) ov.querySelectorAll(".hv-handles").forEach((g) => g.remove()); },
  onViewportChanged() { if (this.tool === "node" && this.stage) this.mountNodeHandles(); if (this._pen) { this._redrawPen(); this._renderPenMarks(); } },
  mountNodeHandles() {
    this.unmountNodeHandles();
    const ov = this._overlayEl(); if (!ov || !this.stage) return;
    const anchors = collectAnchors(this.stage);
    if (!anchors.length) return;
    if (anchors.length > MAX_HANDLES) { setStatus(`Too many anchors (${anchors.length}) to edit. Works best on traced paths.`, 4000); return; }
    // constant ~5px on screen regardless of zoom (CTM.a = screen px per user unit)
    const m = this.stage.getScreenCTM();
    const k = m ? Math.hypot(m.a, m.b) || 1 : 1;
    const r = 5 / k;
    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("class", "hv-handles");
    for (const a of anchors) {
      const c = document.createElementNS(SVG_NS, "circle");
      c.setAttribute("class", "hv-handle");
      c.setAttribute("cx", a.x); c.setAttribute("cy", a.y); c.setAttribute("r", r);
      this._bindNodeHandle(c, a);
      g.appendChild(c);
    }
    ov.appendChild(g);
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
    const t = this._fillTester(nodes);
    let d;
    try {
      const inArt = (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
      const pad = Math.max(x1 - x0, y1 - y0) * 0.02 + 1;
      const bb = { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
      // negative = inside the artboard but outside the union of shapes (overlaps merge,
      // unlike the old even-odd compound which XOR'd them — that was the Phase-2 caveat)
      d = marchingSquares((x, y) => inArt(x, y) && !t.inAny(x, y), bb, 160);
    } finally { t.dispose(); }
    let color = "#000000";
    for (const n of nodes) { const f = n.getAttribute("fill"); if (f && f !== "none") { color = f; break; } }
    this._commitBoolean(nodes, d, "nonzero", null, "Inverted space — negative bounded by the artboard.", color);
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
    const t = this._fillTester(nodes);
    try { return marchingSquares((x, y) => t.inAny(x, y), this._pad(this._bboxUnion(nodes), 0.02), 140); }
    finally { t.dispose(); }
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
    const tB = this._fillTester([base]), tO = this._fillTester(others);
    try { return marchingSquares((x, y) => tB.inAny(x, y) && !tO.inAny(x, y), this._pad(this._nodeBBoxUser(base), 0.02), 140); }
    finally { tB.dispose(); tO.dispose(); }
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
      row.addEventListener("click", () => {
        if (n.getAttribute("data-hv-locked") === "1") return;
        this.selection = new Set([id]); this.artboardSelected = false;
        this._renderSelection(); this._renderInspector();
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
    const act = document.createElement("div"); act.className = "insp-actions";
    act.appendChild(ghostBtn("Duplicate", () => this.duplicate()));
    act.appendChild(ghostBtn("Invert space", () => this.invertSpace()));
    act.appendChild(ghostBtn("Delete", () => this.deleteSelection()));
    wrap.appendChild(act);
    const z = document.createElement("div"); z.className = "insp-actions";
    z.appendChild(ghostBtn("Front", () => this.reorder("front")));
    z.appendChild(ghostBtn("Fwd", () => this.reorder("forward")));
    z.appendChild(ghostBtn("Bwd", () => this.reorder("backward")));
    z.appendChild(ghostBtn("Back", () => this.reorder("back")));
    wrap.appendChild(z);
    if (nodes.filter((n) => shapeToAbsPath(n)).length >= 2) {   // boolean ops need 2+ fillable shapes
      const lbl = document.createElement("div"); lbl.className = "insp-title"; lbl.textContent = "Combine"; wrap.appendChild(lbl);
      const bool = document.createElement("div"); bool.className = "insp-actions";
      bool.appendChild(ghostBtn("Unite", () => this.booleanOp("union")));
      bool.appendChild(ghostBtn("Subtract", () => this.booleanOp("subtract")));
      bool.appendChild(ghostBtn("Intersect", () => this.booleanOp("intersect")));
      wrap.appendChild(bool);
    }
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

export { editor, ghostBtn };
