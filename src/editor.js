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
  currentTranslate, setTranslate, matForOp, bakeMatrixInto, transformShapeGeometry,
  shapeToAbsPath, makeShapeNode, sizeShape, shapeMeaningful, collectAnchors, pathNodes, pathToAnchors,
  nearestOnPaths, splitCubicInsert, catmullRomAnchors,
  isLiveShape, shapeKind, shapeKindName, shapeBox, rectRadii, regenShape, setShapeParam, setShapeBox, freezeShape, shapeWasEdited,
  pathHasCorner, pathOpenEnds,
} from "./hv/index.js";
import {
  setStatus, api, refreshAll, viewports, measureFit, outputPreviewEl,
  selectedOutput, setManualOutputName, serializeForSave,
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
  _xform: null,         // transform-tool handle state during a scale/rotate drag
  _xformMode: null,     // select sub-mode: null (plain), "scale" (Ctrl+T) or "rotate" (Ctrl+R)
  _lastLayerId: null,   // anchor row for Shift-range select in the layers panel
  _nodeSel: new Set(),  // node tool: selected path-anchor keys ("pathId#k")
  _penTempSelect: false,// pen tool: Ctrl/Cmd held → act as Direct-Select (handles mounted)
  _curv: null,          // in-progress curvature path: { node, pts:[{x,y,corner}], closed }
  smartGuides: true,    // snap moves to other objects' bounds + artboard, with guide lines
  guides: [],           // ruler guides: [{ axis:'v'|'h', pos }] in document coords
  guidesLocked: true,   // default locked: guides render but can't be dragged/deleted (no accidental moves); unlock to edit/add
  guidesHidden: false,  // follows the rulers toggle (Ctrl+R) — rulers + guides hide/show together
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
    if (this._curvHoverBound) { window.removeEventListener("pointermove", this._curvHoverBound); this._curvHoverBound = null; }
    this._pen = null;
    this._curv = null;
    this.selection = new Set();
    this._nodeSel = new Set();
    this.artboardSelected = false;
    this.history = [];
    this.redo = [];
    this._curLabel = "Open";
    this._install(svgEl);
    this._syncBoardBg();
    this._renderSelection();
    this._renderInspector();
    this._renderHistory();
    this._updateButtons();
  },
  // Release the current document before another is mounted (or the app closes) so
  // nothing lingers: drop the (potentially multi-MB) undo/redo snapshots, detach the
  // pen's window listener, cancel any coalescing edit, and empty the overlay. The old
  // stage element itself is GC'd once the viewport innerHTML is replaced.
  dispose() {
    if (this._pen) this._finishPen(false);
    if (this._curv) this._curvFinish(false);
    if (this._penHoverBound) { window.removeEventListener("pointermove", this._penHoverBound); this._penHoverBound = null; }
    if (this._penIdleBound) { window.removeEventListener("pointermove", this._penIdleBound); this._penIdleBound = null; this._penHit = null; }
    this._penTempSelect = false;
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
    this.renderGuides();   // re-create the (data-backed) guides layer on this fresh stage
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
      if (child.classList.contains("hv-artboard") || child.classList.contains("hv-overlay") || child.classList.contains("hv-guideslayer") || child.classList.contains("hv-preview")) continue;
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
      return !SKIP_TAGS.has(t) && !c.classList.contains("hv-artboard") && !c.classList.contains("hv-overlay") && !c.classList.contains("hv-guideslayer");
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
    c.querySelectorAll("g.hv-overlay, g.hv-guideslayer, g.hv-preview").forEach((g) => g.remove());
    c.querySelectorAll(".hv-raster-hidden").forEach((n) => { n.classList.remove("hv-raster-hidden"); if (!n.getAttribute("class")) n.removeAttribute("class"); });
    c.classList.remove("hv-pickable");
    return c.outerHTML;
  },
  serialize() {
    if (!this.stage) return "";
    const c = this.stage.cloneNode(true);
    c.querySelectorAll("g.hv-overlay, g.hv-guideslayer, g.hv-preview").forEach((g) => g.remove());
    c.querySelectorAll(".hv-raster-hidden").forEach((n) => { n.classList.remove("hv-raster-hidden"); if (!n.getAttribute("class")) n.removeAttribute("class"); });
    c.classList.remove("hv-pickable");
    // Strip ALL editor metadata, including parametric live-shape params (data-hv-shape,
    // data-hv-bx, …): the `d` is the rendering truth, so exported SVG stays standard.
    c.querySelectorAll("[data-hv-id], [data-hv-shape]").forEach((n) => {
      for (const a of [...n.attributes]) if (a.name.startsWith("data-hv-")) n.removeAttribute(a.name);
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
  // Each state carries the label of the action that PRODUCED it; the live document's
  // label is `_curLabel`. push()/commitCoalesce stash the pre-action state (with its
  // existing label) and set _curLabel to the new action's name, so the History panel
  // reads as a chronological list: [...history, current, ...redo-reversed].
  push(label) {
    if (!this.stage) return;
    this.commitCoalesce();                 // flush any in-progress live edit first
    this.history.push(this._state());
    this._trimHistory();
    this.redo = [];
    this._curLabel = label || "Edit";
    this._updateButtons(); this._renderHistory();
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
  commitCoalesce(label) {
    if (!this._coalescing) return;
    this.history.push(this._coalesceState);
    this._trimHistory();
    this.redo = []; this._coalescing = false; this._coalesceState = null;
    if (label) this._curLabel = label;
    this._updateButtons(); this._renderHistory();
  },
  cancelCoalesce() { this._coalescing = false; this._coalesceState = null; },
  _state() { return { svg: this._historyMarkup(), sel: [...this.selection], ab: this.artboardSelected, label: this._curLabel || "Edit" }; },
  undo() {
    if (this._pen) this._finishPen(true); if (this._curv) this._curvFinish(true); this.commitCoalesce();
    if (!this.history.length) return;
    this.redo.push(this._state()); const s = this.history.pop(); this._curLabel = s.label; this._restore(s); this._renderHistory();
  },
  redoAction() {
    if (this._pen) this._finishPen(true); if (this._curv) this._curvFinish(true); this.commitCoalesce();
    if (!this.redo.length) return;
    this.history.push(this._state()); const s = this.redo.pop(); this._curLabel = s.label; this._restore(s); this._renderHistory();
  },
  // Jump straight to any step in the History panel (one restore, not N steps).
  jumpTo(i) {
    if (!this.stage) return;
    if (this._pen) this._finishPen(true); if (this._curv) this._curvFinish(true); this.commitCoalesce();
    const all = [...this.history, this._state(), ...this.redo.slice().reverse()];
    if (i < 0 || i >= all.length || i === this.history.length) return;
    const target = all[i];
    this.history = all.slice(0, i);
    this.redo = all.slice(i + 1).reverse();
    this._curLabel = target.label;
    this._restore(target);
    this._renderHistory();
  },
  _renderHistory() {
    const list = document.querySelector("#history-list"); if (!list) return;
    list.innerHTML = "";
    if (!this.stage) return;
    const all = [...this.history, this._state(), ...this.redo.slice().reverse()];
    const cur = this.history.length;
    const hc = document.querySelector("#history-count"); if (hc) hc.textContent = this.history.length ? String(this.history.length) : "";
    all.forEach((s, i) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "history-row" + (i === cur ? " current" : "") + (i > cur ? " future" : "");
      row.textContent = s.label || "Edit";
      row.addEventListener("click", () => this.jumpTo(i));
      list.appendChild(row);
    });
    list.scrollTop = list.scrollHeight;
  },
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
  // Drop any node that's a descendant of another selected node — moving/transforming both
  // a group AND one of its children would translate the child twice. Keeps moves atomic.
  _topSelection(nodes) { return nodes.filter((n) => !nodes.some((o) => o !== n && o.contains(n))); },
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
    if (this.tool === "curvature") { this._curvDown(e); return; }
    if (SHAPE_TOOLS.has(this.tool)) {
      if (e.button !== 0) return;
      e.stopPropagation(); e.preventDefault();   // draw, don't pan
      this._beginDraw(e);
      return;
    }
    if (this.tool === "node") {
      // anchor/handle drags stopPropagation, so reaching here = empty canvas or path
      // body. Over a segment → reshape it; otherwise → marquee-select anchors.
      e.stopPropagation(); e.preventDefault();
      const m = this.stage.getScreenCTM();
      const sp = m ? new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse()) : null;
      const k = m ? Math.hypot(m.a, m.b) || 1 : 1;
      const hit = sp ? nearestOnPaths(this.stage, sp.x, sp.y, 6 / k) : null;
      // Focus mode: in node editing only the selected object's anchors are shown, but
      // clicking on/near another object switches focus to it (its handles then appear),
      // so you can still reach any object's points.
      if (this.selection.size) {
        const overEl = (hit && hit.el) || (e.target && e.target.closest && e.target.closest("[data-hv-id]"));
        if (overEl && overEl.hasAttribute("data-hv-id") && overEl.getAttribute("data-hv-locked") !== "1" && !this.selection.has(overEl.getAttribute("data-hv-id"))) {
          this.selection = new Set([overEl.getAttribute("data-hv-id")]); this.artboardSelected = false; this._nodeSel = new Set();
          this._renderSelection(); this._renderInspector(); this.mountNodeHandles();
          return;
        }
      }
      if (hit && hit.mode === "segment") this._beginSegmentDrag(e, hit.el, hit.i, hit.t);
      else this._beginNodeMarquee(e, e.shiftKey);
      return;
    }
    if (this.tool !== "select") return;
    let hit = e.target.closest && e.target.closest("[data-hv-id]");
    // Clicking a shape inside a group selects/moves the WHOLE group — ascend to the
    // top-level object (the stage's direct child). Reach individual children via the
    // layers panel. (Was selecting the leaf, so dragging a group only moved one child.)
    if (hit && this.stage.contains(hit)) { let top = hit; while (top.parentNode && top.parentNode !== this.stage) top = top.parentNode; if (top.nodeType === 1 && top.hasAttribute && top.hasAttribute("data-hv-id")) hit = top; }
    if (hit && hit.getAttribute("data-hv-locked") === "1") hit = null;   // locked → not selectable
    if (hit && this.stage.contains(hit)) {
      e.stopPropagation();
      const id = hit.getAttribute("data-hv-id");
      if (e.shiftKey) { this.selection.has(id) ? this.selection.delete(id) : this.selection.add(id); }
      else if (!this.selection.has(id)) { this.selection = new Set([id]); }
      this.artboardSelected = false; this._lastLayerId = id;
      this._renderSelection(); this._renderInspector(); this._showHint();
      if (this.selection.size) this._beginMove(e);
    } else {
      // empty space → rubber-band marquee on drag (Alt = lasso); a no-move click
      // selects the artboard / clears. Panning is Space-drag. (Marquee folded into V.)
      e.stopPropagation(); e.preventDefault();
      this._beginMarquee(e, e.altKey);
    }
  },
  _beginMove(startEvent) {
    let nodes = this._topSelection(this.selectedNodes()); if (!nodes.length) return;
    const inv = () => this.stage.getScreenCTM().inverse();
    const start = new DOMPoint(startEvent.clientX, startEvent.clientY).matrixTransform(inv());
    let bases = nodes.map((n) => currentTranslate(n));
    let origs = nodes.map((n) => n.getAttribute("transform"));
    let flats = nodes.map((n) => this._isTranslateOnly(n));   // per node: translate-only stays clean, matrix/rotate composes
    const altDup = startEvent.altKey;        // Alt-drag → drag a duplicate, leave the original
    const snapper = makeAxisSnapper();
    const ref0 = this._bboxUnion(nodes);     // selection bounds at start (for smart-guide refs)
    const cand = this.smartGuides ? this._guideCandidates(nodes) : null;
    let pushed = false, duped = false;
    const move = (ev) => {
      if (!pushed && Math.hypot(ev.clientX - startEvent.clientX, ev.clientY - startEvent.clientY) < 3) return;
      if (!pushed) {
        this.push(altDup ? "Duplicate" : "Move"); pushed = true;
        if (altDup) {                        // clone at the origin, then drag the copies
          const ids = this._cloneSelection(0, 0);
          if (ids.length) { this.selection = new Set(ids); nodes = this._topSelection(this.selectedNodes()); bases = nodes.map((n) => currentTranslate(n)); origs = nodes.map((n) => n.getAttribute("transform")); flats = nodes.map((n) => this._isTranslateOnly(n)); duped = true; }
          this._renderInspector();
        }
      }
      const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(inv());
      let dx = p.x - start.x, dy = p.y - start.y;
      let gx = null, gy = null;
      if (ev.shiftKey) { if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0; }   // lock to the H/V axis
      else {
        snapper.reset();
        if (cand) {                          // smart-guide snap (skipped while Shift-constraining)
          const m = this.stage.getScreenCTM(); const k = m ? Math.hypot(m.a, m.b) || 1 : 1;
          const rx = [ref0.x0, (ref0.x0 + ref0.x1) / 2, ref0.x1], ry = [ref0.y0, (ref0.y0 + ref0.y1) / 2, ref0.y1];
          const s = this._snapMove(rx, ry, dx, dy, cand, 6 / k); dx = s.dx; dy = s.dy; gx = s.gx; gy = s.gy;
        }
      }
      nodes.forEach((n, i) => {
        if (flats[i]) setTranslate(n, bases[i].x + dx, bases[i].y + dy);   // clean translate-only stays node-editable
        else n.setAttribute("transform", origs[i] ? `translate(${nfmt(dx)} ${nfmt(dy)}) ${origs[i]}` : `translate(${nfmt(dx)} ${nfmt(dy)})`);   // preserve scale/rotate
      });
      this._renderSelection();
      if (cand) { if (gx != null || gy != null) this._drawGuides(gx, gy); else this._clearGuides(); }
    };
    const up = () => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      this._clearGuides();
      if (pushed) nodes.forEach((n, i) => { if (!flats[i]) this._consolidateTransform(n); });   // collapse translate·matrix → one matrix (no stacking)
      if (duped) { this._renderLayers(); setStatus(`Duplicated ${this.selection.size} object${this.selection.size > 1 ? "s" : ""}.`, 1500); }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  },
  _isTranslateOnly(n) { const a = (n.getAttribute("transform") || "").trim(); return a === "" || /^translate\([^)]*\)$/.test(a); },
  _consolidateTransform(n) {
    try { const c = n.transform.baseVal.consolidate(); if (c) { const m = c.matrix; n.setAttribute("transform", `matrix(${nfmt(m.a)} ${nfmt(m.b)} ${nfmt(m.c)} ${nfmt(m.d)} ${nfmt(m.e)} ${nfmt(m.f)})`); } } catch {}
  },
  // Move a node by (dx,dy) in parent space, preserving any scale/rotate (used by nudge).
  _translateNode(n, dx, dy) {
    if (this._isTranslateOnly(n)) { const t = currentTranslate(n); setTranslate(n, t.x + dx, t.y + dy); }
    else { const o = n.getAttribute("transform"); n.setAttribute("transform", `translate(${nfmt(dx)} ${nfmt(dy)}) ${o}`); this._consolidateTransform(n); }
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
    const a = { x: start.x, y: start.y };          // shape anchor (mutable so Space can reposition)
    let lastP = { x: start.x, y: start.y };
    const move = (ev) => {
      const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(inv());
      if (this._spacePan) { a.x += p.x - lastP.x; a.y += p.y - lastP.y; }   // Space = move the whole shape
      lastP = { x: p.x, y: p.y };
      sizeShape(tool, node, a, p, ev.shiftKey);
      moved = true;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!moved || !shapeMeaningful(tool, node)) { node.remove(); this.cancelCoalesce(); return; }
      const id = "n" + (++this.idSeq);
      node.setAttribute("data-hv-id", id);
      this.commitCoalesce(tool === "rect" ? "Rectangle" : tool === "ellipse" ? "Ellipse" : tool === "line" ? "Line" : "Shape");
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
    const inv = () => this.stage.getScreenCTM().inverse();
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
      this.stage.insertBefore(node, this._overlayEl());
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
    const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(this.stage.getScreenCTM().inverse());
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
    this.push("Add point");
    splitCubicInsert(pa.anchors, pa.closed, i, t);
    el.setAttribute("d", penPathD(pa.anchors, pa.closed));
    this.selection = new Set([el.getAttribute("data-hv-id")]); this.artboardSelected = false;
    this._renderSelection(); this._renderInspector();
    setStatus("Anchor added.", 1200);
  },
  _deletePenAnchor(el, k) {
    const pa = pathToAnchors(el); if (!pa.editable) return;
    this.push("Delete point");
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

  // ---------- tools ----------
  // V (select) and A (node) are the two primary tools; pen/curvature/shapes are the
  // creation sub-tools. Marquee + transform are folded into select (empty-drag
  // rubber-bands; Ctrl+T/Ctrl+R toggle the scale/rotate sub-mode).
  setTool(t) {
    if (t !== "select" && t !== "node" && t !== "pen" && t !== "curvature" && !SHAPE_TOOLS.has(t)) return;
    if (this._pen && t !== "pen") this._finishPen(true);   // keep any in-progress path
    if (this._curv && t !== "curvature") this._curvFinish(true);
    if (t !== this.tool) this._xformMode = null;           // leaving select drops the transform sub-mode
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
      this._penHit = null; this._renderPenHint(null); this._setPenCursor(null); this.exitPenTempSelect();
    }
    if (t === "node") this.mountNodeHandles(); else this.unmountNodeHandles();
    if (this.stage) this._renderSelection();   // show/hide the transform bbox handles
    this._showHint();
  },
  // The bottom ready-bar shows a contextual hint for the current tool / state.
  _hint() {
    const t = this.tool;
    if (t === "select") {
      if (this._xformMode === "scale") return "Scale — drag the box handles · Shift keeps aspect · Alt from centre · Esc to finish";
      if (this._xformMode === "rotate") return "Rotate — drag the corner rotators · Shift = 15° · Esc to finish";
      if (this.artboardSelected) return "Artboard — set size/background in the panel · click a shape to select it";
      if (this.selection.size) return `${this.selection.size} selected — drag to move · Alt-drag duplicates · Ctrl+T scale · Ctrl+R rotate · ⌫ delete`;
      return "Select (V) — click a shape · drag to marquee (Alt = lasso) · Space-drag pans · A edits points";
    }
    if (t === "node") return "Points (A) — drag anchors/handles · Shift multi-selects · Alt converts · drag a segment to reshape · ⌫ deletes";
    if (t === "pen") return "Pen (P) — click for corners, drag for curves · over a path + adds / − removes · click the first point to close · Enter finishes";
    if (t === "curvature") return "Curvature (C) — click for smooth points · Alt = corner · Shift = 45° · drag a point to move · ⌫ removes the last · click the first to close · Enter finishes";
    if (t === "rect") return "Rectangle (R) — drag on the canvas · Shift = square";
    if (t === "ellipse") return "Ellipse (E) — drag on the canvas · Shift = circle";
    if (t === "line") return "Line (L) — drag on the canvas · Shift = 45°";
    return "";
  },
  _showHint() { const h = this._hint(); if (h) setStatus(h, 0); },
  unmountNodeHandles() { const ov = this._overlayEl(); if (ov) ov.querySelectorAll(".hv-handles").forEach((g) => g.remove()); },
  onViewportChanged() {
    if (this._handleDragging) return;   // a zoom/pan mid-drag must not re-mount and yank the dragged handle
    if (this.tool === "node" && this.stage) this.mountNodeHandles();
    if (this.tool === "select" && this._xformMode && this.stage) this._renderSelection();   // handles are constant-screen-size
    if (this.tool === "pen" && !this._pen && this.stage) this._renderPenPoints();   // anchor dots stay constant-screen-size
    if (this._pen) { this._redrawPen(); this._renderPenMarks(); }
    if (this._curv) { this._curvRedraw(); this._curvMarks(); }
  },
  // Node handles render at the artwork's LOCAL coords (in the overlay, which has no
  // transform), so any translate left by an object move would offset them from the
  // shape ("ghosting"). Bake those translates into geometry first (render-identical)
  // so anchors/handles line up — deltas are translate-invariant, so this is safe.
  _bakeArtTransforms() {
    let baked = false;
    for (const n of this._artworkNodes()) {
      if ((n.getAttribute("transform") || "").trim()) { this._flattenNode(n); baked = true; }
    }
    return baked;
  },
  // Bake a node's FULL transform (translate / scale / rotate / matrix) into its
  // geometry so the node tool edits clean, transform-free coords (handles line up).
  // A rotated rect/circle/ellipse can't stay itself → convert to a <path> first.
  _flattenNode(n) {
    const tag = n.tagName.toLowerCase();
    if (tag === "g") {   // groups: only translate groups bake cleanly (rare non-translate groups left as-is)
      const t = currentTranslate(n);
      if (Math.abs(t.x) > 1e-9 || Math.abs(t.y) > 1e-9) bakeMatrixInto(n, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, 0, 0);
      return;
    }
    let m; try { const c = n.transform.baseVal.consolidate(); m = c && c.matrix; } catch { m = null; }
    if (!m) { n.removeAttribute("transform"); return; }
    let el = n;
    const rotated = Math.abs(m.b) > 1e-9 || Math.abs(m.c) > 1e-9;
    if (rotated && (tag === "rect" || tag === "circle" || tag === "ellipse")) {
      const d = shapeToAbsPath(n);   // local geometry → path (currentTranslate=0 for a matrix node, so purely local)
      if (d) {
        const path = document.createElementNS(SVG_NS, "path");
        for (const at of [...n.attributes]) if (!/^(x|y|width|height|cx|cy|r|rx|ry|d|transform)$/.test(at.name)) path.setAttribute(at.name, at.value);
        path.setAttribute("d", d); path.setAttribute("transform", n.getAttribute("transform"));
        n.replaceWith(path); el = path;
      }
    }
    const f = (x, y) => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f });
    transformShapeGeometry(el, el.tagName.toLowerCase(), f, m);
    el.removeAttribute("transform");
    if (isLiveShape(el)) freezeShape(el);   // baking geometry desyncs params → make it a plain path
  },
  // Node-edit focus: when objects are selected, only THEIR anchors (incl. group
  // children) are shown — keeps a busy doc legible. Nothing selected → show all so you
  // can grab anything. You still switch focus by clicking another object (see _onPointerDown).
  _nodeFocusAccept() {
    if (!this.selection.size) return null;
    const sel = this.selectedNodes();
    return (el) => sel.some((s) => s === el || (s.contains && s.contains(el)));
  },
  // The user-space rectangle currently visible on screen — the clip ancestor's screen
  // box mapped back through the stage CTM (so it tracks zoom + pan). Used to cull node
  // handles to what's actually in view. A ~15% margin keeps just-offscreen anchors
  // grabbable. Returns null if it can't be computed (→ caller falls back to all anchors).
  _visibleUserRect() {
    const ctm = this.stage && this.stage.getScreenCTM(); if (!ctm) return null;
    let inv; try { inv = ctm.inverse(); } catch { return null; }
    let host = this.stage.parentElement, clip = null;
    while (host && host !== document.body) {
      const ov = getComputedStyle(host).overflow;
      if (ov && ov !== "visible") { clip = host; break; }
      host = host.parentElement;
    }
    const box = (clip || this.stage.parentElement || this.stage).getBoundingClientRect();
    if (!box.width || !box.height) return null;
    const corners = [[box.left, box.top], [box.right, box.top], [box.right, box.bottom], [box.left, box.bottom]]
      .map(([x, y]) => new DOMPoint(x, y).matrixTransform(inv));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of corners) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    const mx = (x1 - x0) * 0.15, my = (y1 - y0) * 0.15;
    return { x0: x0 - mx, y0: y0 - my, x1: x1 + mx, y1: y1 + my };
  },
  mountNodeHandles() {
    this.unmountNodeHandles();
    const ov = this._overlayEl(); if (!ov || !this.stage) return;
    // A live shape whose `d` no longer matches its params was hand-edited in the node tool
    // (any edit path: drag / reshape / convert / delete) → freeze it to a plain freeform path.
    this.stage.querySelectorAll("path[data-hv-shape]").forEach((n) => { if (shapeWasEdited(n)) freezeShape(n); });
    this._bakeArtTransforms();                     // normalize translates so handles align with the shapes
    const accept = this._nodeFocusAccept();
    const pnodes = pathNodes(this.stage, accept);  // path anchors carry bezier direction handles
    const anchors = collectAnchors(this.stage, accept);   // rect/ellipse/line/polygon corner points
    const total = pnodes.length + anchors.length;
    if (!total) return;
    // Level-of-detail + viewport culling so a huge traced path (10k+ anchors) is
    // EDITABLE instead of refused: only anchors currently in view are candidates,
    // and when that's still more than the render budget we draw every Nth (stride).
    // Zoom in → fewer anchors in view → stride falls to 1 → every anchor is grabbable
    // in that region. Selected in-view anchors always render so the selection stays
    // live. This bounds the handle count to ~MAX_HANDLES per mount → the DOM (and the
    // browser) never blow up, however dense the path. Pan/zoom re-mounts (onViewportChanged).
    const view = this._visibleUserRect();
    const inView = view ? (p) => p.x >= view.x0 && p.x <= view.x1 && p.y >= view.y0 && p.y <= view.y1 : null;
    const visP = inView ? pnodes.filter(inView) : pnodes;
    const visA = inView ? anchors.filter(inView) : anchors;
    const stride = Math.max(1, Math.ceil((visP.length + visA.length) / MAX_HANDLES));
    const keepP = stride === 1 ? visP : visP.filter((nd, i) => i % stride === 0 || this._nodeSel.has(this._nodeKey(nd)));
    const keepA = stride === 1 ? visA : visA.filter((_a, i) => i % stride === 0);
    const shown = keepP.length + keepA.length;
    this._nodeLOD = shown < total;   // flag: a decimated/partial set of handles is mounted (LOD active)
    if (this._nodeLOD) setStatus(`Editing ${shown} of ${total} anchors — zoom in to reach the rest.`, 3500);
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
    for (const nd of keepP) this._renderPathNode(handleLayer, anchorLayer, nd, r, hr);
    for (const a of keepA) {
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
    this.push("Corner");
    a.in = null; a.out = null;
    nd.el.setAttribute("d", penPathD(anchors, closed));
  },
  _bindAnchorDrag(c, nd, r, refs) {
    c.addEventListener("pointerdown", (e) => {
      e.stopPropagation(); e.preventDefault();
      c.setPointerCapture(e.pointerId); c.classList.add("dragging"); this._handleDragging = true;
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
      const cand = (!alt && this.smartGuides) ? this._guideCandidates([nd.el]) : null;
      let pushed = false, moved = false, conv = null;
      const move = (ev) => {
        if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 3) return;   // ignore click jitter
        moved = true;
        const m = this.stage.getScreenCTM(); if (!m) return;
        const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(m.inverse());
        if (!pushed) { this.push("Move point"); pushed = true; }
        if (alt) {                          // Alt-drag → pull symmetric handles (corner→smooth / re-smooth)
          if (!conv) conv = pathToAnchors(nd.el);
          if (!conv.editable || nd.k >= conv.anchors.length) return;
          const q = ev.shiftKey ? snap45(nd.x, nd.y, p.x, p.y) : p;
          conv.anchors[nd.k].out = { x: q.x, y: q.y };
          conv.anchors[nd.k].in = { x: 2 * nd.x - q.x, y: 2 * nd.y - q.y };
          nd.el.setAttribute("d", penPathD(conv.anchors, conv.closed));
          return;
        }
        let dx = p.x - sp.x, dy = p.y - sp.y, gx = null, gy = null;
        if (ev.shiftKey) { if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0; }   // lock to the H/V axis
        else {
          snapper.reset();
          if (cand) { const k = Math.hypot(m.a, m.b) || 1; const s = this._snapMove([nd.x], [nd.y], dx, dy, cand, 6 / k); dx = s.dx; dy = s.dy; gx = s.gx; gy = s.gy; }
        }
        for (const st of starts) { st.ent.nd.moveTo(st.x + dx, st.y + dy); this._syncNodeEls(st.ent, st.x + dx, st.y + dy); }
        if (cand) { if (gx != null || gy != null) this._drawGuides(gx, gy); else this._clearGuides(); }
      };
      const up = () => {
        try { c.releasePointerCapture(e.pointerId); } catch {}
        c.classList.remove("dragging"); this._handleDragging = false;
        c.removeEventListener("pointermove", move); c.removeEventListener("pointerup", up);
        this._clearGuides();
        if (alt && !moved) this._altClickAnchor(nd);                       // Alt-click (no drag) → smooth→corner
        else if (!alt && e.shiftKey && !moved && wasSel) this._nodeSel.delete(key);   // Shift-click (no drag) → deselect
        this.mountNodeHandles();
        if (moved || alt) this._renderInspector();   // a hand-edited live shape just froze → refresh the panel (Shape → freeform)
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
    this.push("Delete points");
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
      this.push("Close path");
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
    this.push("Join paths");
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
    this.push(type === "smooth" ? "Round" : "Sharpen");
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
      dot.setPointerCapture(e.pointerId); dot.classList.add("dragging"); this._handleDragging = true;
      const smooth = this._nodeIsSmooth(nd);            // mirror the partner only if it started smooth
      let pushed = false;
      const sync = (line, h) => { dot.setAttribute("cx", nfmt(h.x)); dot.setAttribute("cy", nfmt(h.y)); line.setAttribute("x2", nfmt(h.x)); line.setAttribute("y2", nfmt(h.y)); };
      const move = (ev) => {
        const m = this.stage.getScreenCTM(); if (!m) return;
        if (!pushed) { this.push("Reshape"); pushed = true; }
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
        dot.classList.remove("dragging"); this._handleDragging = false;
        dot.removeEventListener("pointermove", move); dot.removeEventListener("pointerup", up);
        this.mountNodeHandles();
        if (pushed) this._renderInspector();   // edited a live shape → it froze → refresh the panel
      };
      dot.addEventListener("pointermove", move);
      dot.addEventListener("pointerup", up);
    });
  },
  _bindNodeHandle(c, a) {
    c.addEventListener("pointerdown", (e) => {
      e.stopPropagation(); e.preventDefault();
      c.setPointerCapture(e.pointerId); c.classList.add("dragging"); this._handleDragging = true;
      let pushed = false;
      const move = (ev) => {
        const m = this.stage.getScreenCTM(); if (!m) return;
        if (!pushed) { this.push("Move point"); pushed = true; }
        const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(m.inverse());
        c.setAttribute("cx", p.x); c.setAttribute("cy", p.y);
        a.set(p.x, p.y);
      };
      const up = () => {
        try { c.releasePointerCapture(e.pointerId); } catch {}
        c.classList.remove("dragging"); this._handleDragging = false;
        c.removeEventListener("pointermove", move); c.removeEventListener("pointerup", up);
        this.mountNodeHandles();
        if (pushed) this._renderInspector();   // edited a live shape → it froze → refresh the panel
      };
      c.addEventListener("pointermove", move);
      c.addEventListener("pointerup", up);
    });
  },

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
    for (const [x, y, ox, oy] of [[bb.x0, bb.y0, -1, -1], [bb.x1, bb.y0, 1, -1], [bb.x1, bb.y1, 1, 1], [bb.x0, bb.y1, -1, 1]]) {
      const z = document.createElementNS(SVG_NS, "circle"); z.setAttribute("class", "hv-xform-rot");
      z.setAttribute("cx", nfmt(x + ox * rotOut)); z.setAttribute("cy", nfmt(y + oy * rotOut)); z.setAttribute("r", nfmt(r * 1.4));
      this._bindRotateHandle(z);
      g.appendChild(z);
    }
    const handles = [];
    // Resize handles only in scale mode — rotate mode is purely the corner rotators.
    for (const s of (mode === "scale" ? specs : [])) {
      const c = document.createElementNS(SVG_NS, "rect"); c.setAttribute("class", "hv-xform-handle hv-xform-" + s.h);
      c.setAttribute("x", nfmt(s.x - r)); c.setAttribute("y", nfmt(s.y - r));
      c.setAttribute("width", nfmt(2 * r)); c.setAttribute("height", nfmt(2 * r));
      this._bindTransformHandle(c, s);
      g.appendChild(c); handles.push({ el: c, s });
    }
    ov.appendChild(g);
    this._xform = { box, handles, r, bb, g };
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
      const ptU = (ev) => new DOMPoint(ev.clientX, ev.clientY).matrixTransform(this.stage.getScreenCTM().inverse());
      const a0 = (() => { const p = ptU(e); return Math.atan2(p.y - cy, p.x - cx); })();
      let pushed = false;
      const move = (ev) => {
        const p = ptU(ev); let deg = (Math.atan2(p.y - cy, p.x - cx) - a0) * 180 / Math.PI;
        if (ev.shiftKey) deg = Math.round(deg / 15) * 15;
        if (!pushed && Math.abs(deg) > 0.4) { this.push("Rotate"); pushed = true; this._showGhostBox(); }
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
    for (const { el, s } of xf.handles) { const q = sp(s.x, s.y); el.setAttribute("x", nfmt(q.x - xf.r)); el.setAttribute("y", nfmt(q.y - xf.r)); }
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
        const m = this.stage.getScreenCTM(); if (!m) return;
        const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(m.inverse());
        const ax = ev.altKey ? cx : spec.ax, ay = ev.altKey ? cy : spec.ay;   // Alt → scale from centre
        const f = this._scaleFactors(spec, p, ev.shiftKey, ax, ay); last = { ...f, ax, ay };
        if (!pushed && (Math.abs(f.sx - 1) > 1e-4 || Math.abs(f.sy - 1) > 1e-4)) { this.push("Scale"); pushed = true; this._showGhostBox(); }
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
          nodes.forEach((n, i) => { setTranslate(n, bases[i].x, bases[i].y); bakeMatrixInto(n, M, 0, 0); });
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
    const n = pa.anchors.length, A = pa.anchors[i], B = pa.anchors[(i + 1) % n];
    const straight = !A.out && !B.in;
    const t = Math.max(0.1, Math.min(0.9, t0));
    const A0 = { x: A.x, y: A.y }, B0 = { x: B.x, y: B.y };
    const P1 = A.out ? { x: A.out.x, y: A.out.y } : { x: A.x, y: A.y };
    const P2 = B.in ? { x: B.in.x, y: B.in.y } : { x: B.x, y: B.y };
    const snapper = makeAxisSnapper();
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
      el.setAttribute("d", penPathD(pa.anchors, pa.closed));
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

  // ---------- property edits — apply* do NOT push; wrap with beginCoalesce/commitCoalesce ----------
  // The leaf graphical elements a style edit should touch: groups expand to their
  // children (recursively), so recolouring a selected group hits its N objects rather
  // than setting an inert fill on the <g>. Non-groups map to themselves.
  _effectiveLeaves(nodes) {
    const out = [];
    const walk = (n) => {
      if (n.tagName.toLowerCase() === "g") { for (const c of n.children) if (c.hasAttribute && c.hasAttribute("data-hv-id")) walk(c); }
      else out.push(n);
    };
    (nodes || this.selectedNodes()).forEach(walk);
    return out;
  },
  _eachSel(fn) { this._effectiveLeaves().forEach(fn); this._renderSelection(); },
  // Paint a small, CACHED thumbnail into a layer-row raster swatch. The href can be a
  // multi-MB baked data: URL; assigning it straight to background-image (every _renderLayers)
  // made the browser hold/decode the full image just to paint a ~20px chip. Instead decode it
  // ONCE into a tiny canvas PNG (~1–2 KB), cache by node id (with an href fingerprint so a
  // re-processed raster regenerates), and reuse that. Cap the cache so it can't grow unbounded.
  _rasterSwatchThumb(n, el, href) {
    const id = n.getAttribute("data-hv-id") || href;
    const fp = href.length + ":" + href.slice(-24);   // cheap identity — avoids retaining the big URL
    const cache = this._rasterThumbCache || (this._rasterThumbCache = new Map());
    const set = (url) => { el.textContent = ""; el.style.backgroundImage = `url("${url}")`; el.style.backgroundSize = "cover"; el.style.backgroundPosition = "center"; };
    const hit = cache.get(id);
    if (hit && hit.fp === fp) { set(hit.thumb); return; }
    el.textContent = "🖼";   // placeholder until the thumbnail is ready
    const img = new Image();
    img.onload = () => {
      try {
        const S = 40;   // ~20px chip at 2× DPR
        const c = document.createElement("canvas"); c.width = c.height = S;
        const ctx = c.getContext("2d");
        const r = Math.max(S / img.naturalWidth, S / img.naturalHeight);   // cover-fit
        const w = img.naturalWidth * r, h = img.naturalHeight * r;
        ctx.drawImage(img, (S - w) / 2, (S - h) / 2, w, h);
        const thumb = c.toDataURL("image/png");
        cache.set(id, { fp, thumb });
        if (cache.size > 128) cache.delete(cache.keys().next().value);   // evict oldest
        if (el.isConnected) set(thumb);
      } catch { /* tainted canvas (cross-origin) — leave the placeholder */ }
    };
    img.src = href;
  },
  // A raster <image> is a first-class canvas object but carries NO fill/stroke/shape —
  // paint operations skip it (writing fill/stroke onto an <image> is inert markup the
  // renderer ignores; we keep the DOM clean). Geometry/opacity/blend still apply. A <use>
  // that references an <image> is rastern too (the editor doesn't mint those today, but the
  // check future-proofs the model so no paint setter can ever write inert attrs onto one).
  isRaster(n) {
    if (!n || !n.tagName) return false;
    const tag = n.tagName.toLowerCase();
    if (tag === "image") return true;
    if (tag === "use" && this.stage) {
      const ref = (n.getAttribute("href") || n.getAttribute("xlink:href") || "").replace(/^#/, "");
      if (!ref) return false;
      const t = this.stage.querySelector("#" + (window.CSS && CSS.escape ? CSS.escape(ref) : ref));
      return !!(t && t.tagName && t.tagName.toLowerCase() === "image");
    }
    return false;
  },
  applyFill(color) { this.style.fill = color || "none"; this._eachSel((n) => { if (this.isRaster(n)) return; n.setAttribute("fill", color || "none"); }); },
  applyStroke(color, width) {
    this.style.stroke = width > 0 ? color : "none"; this.style.strokeWidth = width > 0 ? width : 0;
    this._eachSel((n) => {
      if (this.isRaster(n)) return;
      if (width > 0) {
        n.setAttribute("stroke", color); n.setAttribute("stroke-width", nfmt(width));
        n.setAttribute("vector-effect", "non-scaling-stroke");
        // seed cap/join defaults only if the object doesn't already carry a choice
        if (!n.hasAttribute("stroke-linejoin")) n.setAttribute("stroke-linejoin", "round");
        if (!n.hasAttribute("stroke-linecap")) n.setAttribute("stroke-linecap", "round");
        this._syncStrokeAlign(n);   // keep an inside/outside alignment correct at the new width
      } else {
        n.removeAttribute("data-hv-stroke-align");
        ["stroke", "stroke-width", "vector-effect", "stroke-linejoin", "stroke-linecap",
         "stroke-opacity", "stroke-miterlimit", "stroke-dasharray"].forEach((x) => n.removeAttribute(x));
        this._syncStrokeAlign(n);   // clear the alignment clip/paint-order/inline width
      }
    });
  },
  applyOpacity(v) { this._eachSel((n) => { if (v >= 1) n.removeAttribute("opacity"); else n.setAttribute("opacity", nfmt(v)); }); },
  applyFillOpacity(a) { this._eachSel((n) => { if (this.isRaster(n)) return; if (a == null || a >= 1) n.removeAttribute("fill-opacity"); else n.setAttribute("fill-opacity", nfmt(Math.max(0, a))); }); },
  applyStrokeOpacity(a) { this._eachSel((n) => { if (this.isRaster(n)) return; if (a == null || a >= 1) n.removeAttribute("stroke-opacity"); else n.setAttribute("stroke-opacity", nfmt(Math.max(0, a))); }); },
  // Generic stroke-style setter (cap / join / miterlimit / dasharray); empty value clears.
  setStrokeAttr(attr, value) {
    this._eachSel((n) => { if (this.isRaster(n)) return; if (value === "" || value == null) n.removeAttribute(attr); else n.setAttribute(attr, String(value)); });
  },
  // ---- stroke alignment (SVG has no native stroke-alignment) ----
  // The `stroke-width` ATTRIBUTE stays the user's nominal width (the Width control is
  // untouched). Alignment layers on top: inside = clip the stroke to the shape + render
  // at 2× (inner half = nominal, sits inside the edge); outside = render at 2× with the
  // fill painted OVER the stroke (paint-order) so only the outer half shows. The 2× is an
  // inline `style` so it overrides the attribute without disturbing it. The inside clip
  // uses a live <use> reference, so geometry edits track automatically.
  _defs() {
    let d = this.stage.querySelector("defs.hv-defs");
    if (!d) { d = document.createElementNS(SVG_NS, "defs"); d.setAttribute("class", "hv-defs"); this.stage.insertBefore(d, this.stage.firstChild); }
    return d;
  },
  _ensureStrokeClip(n) {
    const id = n.getAttribute("data-hv-id"); if (!id) return;
    if (n.getAttribute("id") !== id) n.setAttribute("id", id);   // <use> needs a real id
    const cid = "hvsa-" + id;
    if (!this.stage.querySelector("#" + CSS.escape(cid))) {
      const cp = document.createElementNS(SVG_NS, "clipPath");
      cp.setAttribute("id", cid); cp.setAttribute("clipPathUnits", "userSpaceOnUse");
      const use = document.createElementNS(SVG_NS, "use"); use.setAttribute("href", "#" + id);
      cp.appendChild(use); this._defs().appendChild(cp);
    }
    n.setAttribute("clip-path", "url(#" + cid + ")");
  },
  _removeStrokeClip(n) {
    const id = n.getAttribute("data-hv-id"); if (!id) return;
    const cp = this.stage.querySelector("#" + CSS.escape("hvsa-" + id)); if (cp) cp.remove();
  },
  // After a clone/paste, a node that carried inside/outside stroke alignment still points
  // at the SOURCE's clip (a shared `id` + clip-path="url(#hvsa-<sourceId>)") — so it clipped
  // against the original's geometry and duplicated an id. Re-anchor: give aligned nodes a
  // fresh id, drop the stale id/clip/inline style, and rebuild the visual against the new id.
  _reanchorStrokeAlign(root) {
    if (!root || !root.getAttribute) return;
    const fix = (n, reassign) => {
      if (!n.getAttribute("data-hv-stroke-align")) return;
      if (reassign) n.setAttribute("data-hv-id", "n" + (++this.idSeq));   // descendants kept the source id
      n.removeAttribute("id"); n.removeAttribute("clip-path");
      n.style.removeProperty("stroke-width"); n.style.removeProperty("paint-order");
      this._syncStrokeAlign(n);   // rebuild clip/paint-order against the (now-fresh) data-hv-id
    };
    fix(root, false);   // root's data-hv-id was already freshly assigned by the caller
    if (root.querySelectorAll) root.querySelectorAll("[data-hv-stroke-align]").forEach((n) => fix(n, true));
  },
  // Re-apply the visual for a node's current alignment + nominal width (call after any
  // width/align change). Clears everything for center / no-stroke.
  _syncStrokeAlign(n) {
    const mode = n.getAttribute("data-hv-stroke-align");
    const nominal = parseFloat(n.getAttribute("stroke-width")) || 0;
    if (!mode || mode === "center" || nominal <= 0) {
      n.style.removeProperty("stroke-width"); n.style.removeProperty("paint-order");
      n.removeAttribute("clip-path"); this._removeStrokeClip(n);
      return;
    }
    n.style.strokeWidth = nfmt(nominal * 2);
    if (mode === "inside") { n.style.removeProperty("paint-order"); this._ensureStrokeClip(n); }
    else { n.style.paintOrder = "stroke"; n.removeAttribute("clip-path"); this._removeStrokeClip(n); }
  },
  setStrokeAlign(mode) {
    this.push("Stroke align");
    this._eachSel((n) => {
      if (this.isRaster(n)) return;   // rasters have no stroke to align
      if (mode === "center") n.removeAttribute("data-hv-stroke-align");
      else n.setAttribute("data-hv-stroke-align", mode);
      this._syncStrokeAlign(n);
    });
    this._renderInspector();
  },
  applyArtboardBg(color) { const ab = this.artboardEl(); if (ab) ab.setAttribute("fill", color || "none"); this._syncBoardBg(); },
  // The stage <svg> carries a white CSS background so the sheet reads on the checker
  // pasteboard — but that hid transparency. When the artboard fill is none, swap the
  // white for a checker so a transparent artboard actually looks transparent.
  _syncBoardBg() {
    if (!this.stage) return;
    const ab = this.artboardEl();
    const f = ab && ab.getAttribute("fill");
    this.stage.classList.toggle("transparent-board", !f || f === "none");
  },
  applyArtboardSize(w, h) {
    const ab = this.artboardEl(); if (!ab || !this.stage) return;
    this.stage.setAttribute("viewBox", `0 0 ${nfmt(w)} ${nfmt(h)}`);
    this.stage.setAttribute("width", nfmt(w)); this.stage.setAttribute("height", nfmt(h));
    ab.setAttribute("x", 0); ab.setAttribute("y", 0); ab.setAttribute("width", nfmt(w)); ab.setAttribute("height", nfmt(h));
    this._renderSelection(); measureFit(viewports.output);
  },

  // ---------- Phase 2 object ops (each is one undo step) ----------
  _artworkNodes() { return [...this.stage.children].filter((c) => c.hasAttribute && c.hasAttribute("data-hv-id")); },
  // Clone the current selection into the stage at an optional offset; returns the
  // new ids. Does NOT push history or change selection (callers decide).
  _cloneSelection(offsetX = 0, offsetY = 0) {
    const ov = this._overlayEl(); const ids = [];
    for (const n of this.selectedNodes()) {
      const c = n.cloneNode(true);
      const id = "n" + (++this.idSeq); c.setAttribute("data-hv-id", id);
      if (offsetX || offsetY) { const t = currentTranslate(c); setTranslate(c, t.x + offsetX, t.y + offsetY); }
      this.stage.insertBefore(c, ov);
      this._reanchorStrokeAlign(c);   // rebuild any stroke-align clip against the clone's new id
      ids.push(id);
    }
    return ids;
  },
  duplicate() {
    const nodes = this.selectedNodes(); if (!nodes.length) return;
    this.push("Duplicate");
    const ids = this._cloneSelection(12, 12);
    this.selection = new Set(ids); this.artboardSelected = false;
    this._renderSelection(); this._renderInspector(); this._renderLayers();
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
    this.push("Paste");
    const ov = this._overlayEl(); const ids = [];
    for (const el of els) {
      const id = "n" + (++this.idSeq); el.setAttribute("data-hv-id", id);
      const t = currentTranslate(el); setTranslate(el, t.x + 12, t.y + 12);
      this.stage.insertBefore(el, ov);
      this._reanchorStrokeAlign(el);   // rebuild any stroke-align clip against the paste's new id
      ids.push(id);
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
    this.commitCoalesce("Place");
    this.selection = new Set([gid]); this.artboardSelected = false;
    this._renderSelection(); this._renderInspector(); this._renderLayers();
    setStatus(`Placed ${label || "vector"} — ${src.length} object${src.length > 1 ? "s" : ""} (grouped).`, 2800);
    return src.length;
  },
  // Load a raster into the canvas as an <image> node so it coexists with vectors
  // (move/scale/z-order like any object — the scale is baked into width/height so
  // the node stays translate-only, matching placed vectors). Fits + centres on the
  // artboard. `w`/`h` are the image's natural pixel dimensions.
  placeImage(href, label, w, h) {
    if (!this.stage) { setStatus("Open or create a canvas first, then load into it.", 3500); return false; }
    const vbA = this.stage.viewBox.baseVal;
    const sw = w > 0 ? w : ((vbA && vbA.width) || 512);
    const sh = h > 0 ? h : ((vbA && vbA.height) || 512);
    let s = 1, ex = 0, ey = 0;
    if (vbA && vbA.width) {
      s = Math.min(1, 0.95 * Math.min(vbA.width / sw, vbA.height / sh));
      ex = vbA.x + (vbA.width - sw * s) / 2;
      ey = vbA.y + (vbA.height - sh * s) / 2;
    }
    this.beginCoalesce();
    const ov = this._overlayEl();
    const img = document.createElementNS(SVG_NS, "image");
    const id = "n" + (++this.idSeq);
    img.setAttribute("data-hv-id", id);
    if (label) img.setAttribute("data-hv-name", "Image: " + String(label).replace(/\.[^.]+$/, ""));
    img.setAttribute("x", "0"); img.setAttribute("y", "0");
    img.setAttribute("width", String(sw * s)); img.setAttribute("height", String(sh * s));
    img.setAttribute("preserveAspectRatio", "none");
    img.setAttribute("transform", `translate(${ex}, ${ey})`);
    // Plain SVG2 `href` only — emitting `xlink:href` without declaring the xlink
    // namespace on the stage <svg> makes the serialized markup fail to parse
    // ("Namespace prefix xlink for href on image is not defined").
    img.setAttribute("href", href);
    this.stage.insertBefore(img, ov);
    this.commitCoalesce("Load image");
    this.selection = new Set([id]); this.artboardSelected = false;
    this._renderSelection(); this._renderInspector(); this._renderLayers();
    setStatus(`Loaded ${label || "image"} into the canvas.`, 2600);
    return true;
  },

  // ---------- raster → vector (the raster panel's live vectorize) ----------
  // User-space box a placed <image> occupies: x/y + its translate, width × height.
  // (Rotation/skew aren't accounted for — placed/moved rasters are translate-only,
  //  the common case; a rotated raster previews in its axis-aligned box.)
  _rasterBox(node) {
    const x = parseFloat(node.getAttribute("x")) || 0;
    const y = parseFloat(node.getAttribute("y")) || 0;
    const w = parseFloat(node.getAttribute("width")) || 0;
    const h = parseFloat(node.getAttribute("height")) || 0;
    const t = currentTranslate(node);
    return { x: x + t.x, y: y + t.y, w, h };
  },
  // Parse a trace SVG and build a <g> whose contents are mapped into `box`. Shared
  // by the live preview (transient, class hv-preview, no id) and the commit (real
  // artwork node). Returns the <g> or null.
  _svgGroupInBox(text, box, label, { preview } = {}) {
    let root;
    try { root = new DOMParser().parseFromString(text, "image/svg+xml").documentElement; } catch { root = null; }
    if (!root || root.tagName.toLowerCase() !== "svg") return null;
    const SKIP = new Set(["defs", "metadata", "style", "title", "desc", "symbol"]);
    const src = [...root.children].filter((c) => {
      const t = c.tagName.toLowerCase();
      return !SKIP.has(t) && !c.classList.contains("hv-artboard") && !c.classList.contains("hv-overlay");
    });
    if (!src.length) return null;
    const p = (root.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
    let sx = 0, sy = 0, sw = 0, sh = 0;
    if (p.length === 4 && p[2] > 0) { [sx, sy, sw, sh] = p; }
    else { sw = parseFloat(root.getAttribute("width")) || 0; sh = parseFloat(root.getAttribute("height")) || 0; }
    if (!(sw > 0 && sh > 0 && box.w > 0 && box.h > 0)) return null;
    const a = box.w / sw, d = box.h / sh;             // map trace viewBox → the raster's box
    const m = { a, b: 0, c: 0, d, e: box.x - sx * a, f: box.y - sy * d };
    const g = document.createElementNS(SVG_NS, "g");
    if (preview) g.setAttribute("class", "hv-preview");
    else {
      g.setAttribute("data-hv-id", "n" + (++this.idSeq));
      if (label) g.setAttribute("data-hv-name", "Vector: " + String(label).replace(/\.[^.]+$/, ""));
    }
    for (const child of src) {
      const node = document.importNode(child, true);
      node.querySelectorAll?.("[data-hv-id]").forEach((n) => n.removeAttribute("data-hv-id"));
      if (preview) node.querySelectorAll?.("[id]").forEach((n) => n.removeAttribute("id"));
      else { node.setAttribute("data-hv-id", "n" + (++this.idSeq)); }
      bakeMatrixInto(node, m, 0, 0);
      g.appendChild(node);
    }
    return g;
  },
  // Show a transient vector preview over `node`, hiding the raster underneath so the
  // canvas reads as the traced result. Replaces any prior preview. Not in history.
  showRasterPreview(node, svgText) {
    if (!this.stage || !node) return false;
    this.clearRasterPreview(false);
    const g = this._svgGroupInBox(svgText, this._rasterBox(node), null, { preview: true });
    if (!g) { this.clearRasterPreview(true); return false; }
    node.classList.add("hv-raster-hidden");
    this.stage.insertBefore(g, this._overlayEl());
    this._rasterPreviewEl = g; this._rasterPreviewFor = node;
    return true;
  },
  // Drop the preview. restoreRaster=true un-hides the raster (revert); false leaves
  // it hidden (the caller is about to remove it on commit).
  clearRasterPreview(restoreRaster = true) {
    if (this._rasterPreviewEl) { this._rasterPreviewEl.remove(); this._rasterPreviewEl = null; }
    if (restoreRaster && this._rasterPreviewFor) this._rasterPreviewFor.classList.remove("hv-raster-hidden");
    if (restoreRaster) this._rasterPreviewFor = null;
  },
  // Commit: replace the raster with a real vector layer fit to its box, push history.
  commitRasterToVector(node, svgText, label) {
    if (!this.stage || !node) return false;
    const g = this._svgGroupInBox(svgText, this._rasterBox(node), label, { preview: false });
    this.clearRasterPreview(false);
    if (!g) { node.classList.remove("hv-raster-hidden"); return false; }
    const ov = this._overlayEl();
    this.stage.insertBefore(g, ov);
    node.remove();
    const gid = g.getAttribute("data-hv-id");
    this.selection = new Set([gid]); this.artboardSelected = false;
    this.push("Vectorize raster");
    this._renderSelection(); this._renderInspector(); this._renderLayers();
    setStatus("Vectorized — the raster is now an editable vector layer.", 2800);
    return true;
  },

  selectAll() {
    if (!this.stage) return;
    const ids = this._artworkNodes().filter((n) => n.getAttribute("data-hv-locked") !== "1").map((n) => n.getAttribute("data-hv-id"));
    this.selection = new Set(ids); this.artboardSelected = false;
    this._renderSelection(); this._renderInspector(); this._renderLayers();
  },
  nudge(dx, dy) {
    const nodes = this.selectedNodes(); if (!nodes.length) return;
    this.push("Move");
    nodes.forEach((n) => this._translateNode(n, dx, dy));   // preserves scale/rotate
    this._renderSelection();
  },
  reorder(mode) {
    const nodes = this.selectedNodes(); if (!nodes.length || !this.stage) return;
    this.push("Arrange");
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
    this.push(/rotate/i.test(op) ? "Rotate" : "Flip");
    const vb = this.stage.viewBox.baseVal;
    let cx, cy;
    if (whole) { cx = vb.x + vb.width / 2; cy = vb.y + vb.height / 2; }
    else { const bb = this._bboxUnion(nodes); cx = (bb.x0 + bb.x1) / 2; cy = (bb.y0 + bb.y1) / 2; }
    const m = matForOp(op, cx, cy);
    for (const n of nodes) { if (isLiveShape(n)) freezeShape(n); bakeMatrixInto(n, m, 0, 0); }
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
  // ---------- inspector geometry / appearance (Transform · Align · Arrange) ----------
  // Selection bounds in artboard/user space, or null when nothing is selected.
  selectionBBox() { const n = this.selectedNodes(); return n.length ? this._bboxUnion(n) : null; },
  // Move the selection so its bbox top-left lands at (x,y); null leaves that axis.
  setSelectionPos(x, y) {
    const nodes = this.selectedNodes(); if (!nodes.length) return;
    const bb = this._bboxUnion(nodes);
    const dx = x == null ? 0 : x - bb.x0, dy = y == null ? 0 : y - bb.y0;
    if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return;
    if (!this._coalescing) this.push("Move");
    nodes.forEach((n) => this._translateNode(n, dx, dy));
    this._renderSelection(); if (!this._coalescing) this._renderInspector();
  },
  // Resize the selection bbox to w×h, scaling about its top-left. `lock` keeps the
  // aspect ratio off whichever dimension was edited. Translate-only nodes bake into
  // geometry (stay clean for node editing); transformed nodes compose + consolidate.
  setSelectionSize(w, h, lock) {
    const nodes = this.selectedNodes(); if (!nodes.length) return;
    const bb = this._bboxUnion(nodes), cw = bb.x1 - bb.x0, ch = bb.y1 - bb.y0;
    if (cw < 1e-6 || ch < 1e-6) return;
    let sx = w != null ? Math.max(w, 0.01) / cw : 1, sy = h != null ? Math.max(h, 0.01) / ch : 1;
    if (lock) { if (w != null) sy = sx; else if (h != null) sx = sy; }
    if (Math.abs(sx - 1) < 1e-6 && Math.abs(sy - 1) < 1e-6) return;
    if (!this._coalescing) this.push("Resize");
    const ax = bb.x0, ay = bb.y0;
    nodes.forEach((n) => {
      // A live shape resizes by rewriting its bounding-box params (stays parametric) —
      // but only while unrotated; a rotated one is frozen to a path, then baked normally.
      if (isLiveShape(n)) {
        if (this._isTranslateOnly(n)) {
          const t = currentTranslate(n), b = shapeBox(n);   // params are local; map the stage anchor back through the translate
          setShapeBox(n, ax - t.x, ay - t.y, b.w * sx, b.h * sy);
          return;
        }
        freezeShape(n);
      }
      if (this._isTranslateOnly(n)) bakeMatrixInto(n, { a: sx, b: 0, c: 0, d: sy, e: ax * (1 - sx), f: ay * (1 - sy) }, 0, 0);
      else { const M = `matrix(${nfmt(sx)} 0 0 ${nfmt(sy)} ${nfmt(ax * (1 - sx))} ${nfmt(ay * (1 - sy))})`; const o = n.getAttribute("transform"); n.setAttribute("transform", o ? `${M} ${o}` : M); this._consolidateTransform(n); }
    });
    this._renderSelection(); if (!this._coalescing) this._renderInspector();
  },
  // Rotate the selection by `deg` about its bbox centre (composes with any transform).
  // `centre` pins the pivot for live scrubbing — incremental deltas all turn about one
  // fixed point so the shape doesn't drift as its bbox grows/shifts mid-rotation.
  rotateSelectionBy(deg, centre) {
    const nodes = this.selectedNodes(); if (!nodes.length || !deg) return;
    const bb = centre ? null : this._bboxUnion(nodes);
    const cx = centre ? centre.cx : (bb.x0 + bb.x1) / 2, cy = centre ? centre.cy : (bb.y0 + bb.y1) / 2;
    if (!this._coalescing) this.push("Rotate");
    const rot = `rotate(${nfmt(deg)} ${nfmt(cx)} ${nfmt(cy)})`;
    nodes.forEach((n) => { const o = n.getAttribute("transform"); n.setAttribute("transform", o ? `${rot} ${o}` : rot); this._consolidateTransform(n); });
    this._renderSelection(); if (!this._coalescing) this._renderInspector();
  },
  // Absolute rotation of a single selected element from its matrix; null for none/multi.
  selectionAngle() {
    const nodes = this.selectedNodes(); if (nodes.length !== 1) return null;
    try { const c = nodes[0].transform.baseVal.consolidate(); if (!c) return 0; const m = c.matrix; return Math.atan2(m.b, m.a) * 180 / Math.PI; } catch { return 0; }
  },
  // Align each selected object to the artboard edges / centre (a predictable default
  // for icon work — centre-on-canvas, snap-to-edge).
  align(mode) {
    const nodes = this.selectedNodes(); if (!nodes.length || !this.stage) return;
    const vb = this.stage.viewBox.baseVal;
    const R = { x0: vb.x, y0: vb.y, x1: vb.x + vb.width, y1: vb.y + vb.height };
    this.push("Align");
    nodes.forEach((n) => {
      const b = this._nodeBBoxUser(n); let dx = 0, dy = 0;
      if (mode === "left") dx = R.x0 - b.x0;
      else if (mode === "hcenter") dx = (R.x0 + R.x1) / 2 - (b.x0 + b.x1) / 2;
      else if (mode === "right") dx = R.x1 - b.x1;
      else if (mode === "top") dy = R.y0 - b.y0;
      else if (mode === "vmiddle") dy = (R.y0 + R.y1) / 2 - (b.y0 + b.y1) / 2;
      else if (mode === "bottom") dy = R.y1 - b.y1;
      if (Math.abs(dx) > 1e-6 || Math.abs(dy) > 1e-6) this._translateNode(n, dx, dy);
    });
    this._renderSelection(); this._renderInspector();
  },
  // The 6 align-to-artboard buttons as a compact bar for the Properties panel's
  // bottom chin (always reachable, doesn't scroll away). Returns null when there's
  // nothing alignable (no non-artboard selection).
  _alignBar() {
    if (!this.stage || this.artboardSelected || !this.selectedNodes().length) return null;
    const bar = document.createElement("div"); bar.className = "insp-alignbar";
    const mk = (icon, mode, title) => { const b = document.createElement("button"); b.type = "button"; b.className = "insp-iconbtn"; b.title = title; b.innerHTML = icon; b.addEventListener("click", () => this.align(mode)); return b; };
    bar.append(
      mk(ALIGN_ICON.left, "left", "Align left edges"),
      mk(ALIGN_ICON.hcenter, "hcenter", "Centre horizontally"),
      mk(ALIGN_ICON.right, "right", "Align right edges"),
      mk(ALIGN_ICON.top, "top", "Align top edges"),
      mk(ALIGN_ICON.vmiddle, "vmiddle", "Centre vertically"),
      mk(ALIGN_ICON.bottom, "bottom", "Align bottom edges"),
    );
    return bar;
  },
  // mix-blend-mode via inline style (serialises with the element).
  applyBlendMode(mode) {
    this.push("Blend mode");
    this._eachSel((n) => { if (!mode || mode === "normal") n.style.removeProperty("mix-blend-mode"); else n.style.mixBlendMode = mode; });
  },
  // Generic attribute setter across the fillable leaves (fill-rule, etc.) — inert on rasters.
  setAttrAll(attr, value) { this.push(attr); this._eachSel((n) => { if (this.isRaster(n)) return; if (value == null || value === "") n.removeAttribute(attr); else n.setAttribute(attr, String(value)); }); },
  // Rounded-rect corner radius (rx/ry) on selected <rect>s; 0 squares the corners.
  setRectRadius(r) {
    this.push("Corner radius");
    this._eachSel((n) => {
      if (isLiveShape(n) && shapeKind(n) === "rect") setShapeParam(n, "r", Math.max(0, r));
      else if (n.tagName.toLowerCase() === "rect") { if (r > 0) { n.setAttribute("rx", nfmt(r)); n.setAttribute("ry", nfmt(r)); } else { n.removeAttribute("rx"); n.removeAttribute("ry"); } }
    });
  },
  // Set one parametric param on the selected live shape(s) of `kind` and regenerate.
  setShapeParam(key, value, kind) {
    this._eachSel((n) => { if (isLiveShape(n) && (!kind || shapeKind(n) === kind)) setShapeParam(n, key, value); });
    this._renderSelection();
  },
  // Switch the kind of the selected live shape (rect ⇄ poly ⇄ star) in place, seeding
  // sensible defaults; the bounding box is preserved so it morphs in place.
  setShapeKind(kind) {
    this.push("Shape type");
    this._eachSel((n) => {
      if (!isLiveShape(n)) return;
      n.setAttribute("data-hv-shape", kind);
      if (kind === "rect" && !n.hasAttribute("data-hv-r")) n.setAttribute("data-hv-r", "0");
      if (kind === "poly" && !n.hasAttribute("data-hv-sides")) n.setAttribute("data-hv-sides", "5");
      if (kind === "star") { if (!n.hasAttribute("data-hv-points")) n.setAttribute("data-hv-points", "5"); if (!n.hasAttribute("data-hv-inset")) n.setAttribute("data-hv-inset", "0.5"); }
      regenShape(n);
    });
    this._renderSelection(); this._renderInspector(); this._renderLayers();
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
  // Boolean ops work on the selected fillable shapes — flattening selected groups to
  // their leaf children so a grouped selection is usable (was top-level only → "unusable").
  _fillableSelection() { return this._effectiveLeaves().filter((n) => shapeToAbsPath(n)); },
  _nodeBBoxUser(n) {
    // getBBox() is the element's LOCAL geometry bbox; map its corners through the
    // element's full consolidated transform so the box is correct for ANY transform
    // (translate / scale / rotate / matrix), not just a translate. (The old version
    // added only the translate, so imported shapes with a matrix/rotate drew a badly
    // offset transform box — "bounding boxes bug out".)
    const bb = n.getBBox();
    let m = null;
    try { const tr = n.transform && n.transform.baseVal; if (tr && tr.numberOfItems) { const c = tr.consolidate(); m = c && c.matrix; } } catch {}
    if (!m) return { x0: bb.x, y0: bb.y, x1: bb.x + bb.width, y1: bb.y + bb.height };
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of [[bb.x, bb.y], [bb.x + bb.width, bb.y], [bb.x + bb.width, bb.y + bb.height], [bb.x, bb.y + bb.height]]) {
      const px = m.a * x + m.c * y + m.e, py = m.b * x + m.d * y + m.f;
      x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py);
    }
    return { x0, y0, x1, y1 };
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

  // ---------- smart guides: snap moving points/objects to other bounds + artboard ----------
  // Candidate x/y coords to snap to: artboard edges + centre, and the bbox
  // edges/centre of every other object (capped for perf on large docs).
  _guideCandidates(excludeEls) {
    const vb = this.stage.viewBox.baseVal;
    const xs = [vb.x, vb.x + vb.width / 2, vb.x + vb.width];
    const ys = [vb.y, vb.y + vb.height / 2, vb.y + vb.height];
    const ex = new Set(excludeEls || []);
    const nodes = this._artworkNodes().filter((n) => !ex.has(n));
    if (nodes.length <= 400) for (const n of nodes) {
      let bb; try { bb = this._nodeBBoxUser(n); } catch { continue; }
      xs.push(bb.x0, (bb.x0 + bb.x1) / 2, bb.x1); ys.push(bb.y0, (bb.y0 + bb.y1) / 2, bb.y1);
    }
    return { xs, ys };
  },
  // Nudge a move delta so a reference coord lands on the nearest candidate within
  // tol (user units); returns the adjusted delta + the guide coords that were hit.
  _snapMove(refXs0, refYs0, dx, dy, cand, tol) {
    let gx = null, adjX = 0, bx = tol;
    for (const r of refXs0) for (const c of cand.xs) { const g = c - (r + dx); if (Math.abs(g) < bx) { bx = Math.abs(g); adjX = g; gx = c; } }
    let gy = null, adjY = 0, by = tol;
    for (const r of refYs0) for (const c of cand.ys) { const g = c - (r + dy); if (Math.abs(g) < by) { by = Math.abs(g); adjY = g; gy = c; } }
    return { dx: dx + adjX, dy: dy + adjY, gx, gy };
  },
  _drawGuides(gx, gy) {
    const ov = this._overlayEl(); if (!ov) return;
    ov.querySelectorAll(".hv-guide").forEach((g) => g.remove());
    const vb = this.stage.viewBox.baseVal;
    const mk = (x1, y1, x2, y2) => {
      const l = document.createElementNS(SVG_NS, "line"); l.setAttribute("class", "hv-guide");
      l.setAttribute("x1", nfmt(x1)); l.setAttribute("y1", nfmt(y1)); l.setAttribute("x2", nfmt(x2)); l.setAttribute("y2", nfmt(y2));
      ov.appendChild(l);
    };
    if (gx != null) mk(gx, vb.y, gx, vb.y + vb.height);
    if (gy != null) mk(vb.x, gy, vb.x + vb.width, gy);
  },
  _clearGuides() { const ov = this._overlayEl(); if (ov) ov.querySelectorAll(".hv-guide").forEach((g) => g.remove()); },

  // ---------- ruler guides: persistent draggable guide lines (Illustrator-style) ----------
  // Stored as data on the editor (axis 'v' = vertical line at constant x; 'h' = horizontal
  // at constant y) and rendered into a dedicated layer that serialize()/history strip, so
  // guides survive undo / zoom / tool changes without ever polluting the saved document.
  _guidesLayer() {
    if (!this.stage) return null;
    let g = this.stage.querySelector("g.hv-guideslayer");
    if (!g) {
      g = document.createElementNS(SVG_NS, "g");
      g.setAttribute("class", "hv-guideslayer");
      this.stage.insertBefore(g, this._overlayEl() || null);
    }
    return g;
  },
  // Keep the guides layer the LAST child before the overlay, so guides draw above all
  // artwork (newly-drawn shapes insert before the overlay too and would otherwise cover
  // them) but below the selection handles. Cheap; called after renders.
  _raiseGuides() {
    const g = this.stage && this.stage.querySelector("g.hv-guideslayer");
    const ov = this._overlayEl();
    if (g && ov && g.nextSibling !== ov) this.stage.insertBefore(g, ov);
  },
  _scaleK() { const m = this.stage && this.stage.getScreenCTM(); return m ? (Math.hypot(m.a, m.b) || 1) : 1; },
  _applyGuideCoords(el, gd) {
    const vb = this.stage.viewBox.baseVal, vert = gd.axis === "v";
    el.setAttribute("x1", nfmt(vert ? gd.pos : vb.x)); el.setAttribute("y1", nfmt(vert ? vb.y : gd.pos));
    el.setAttribute("x2", nfmt(vert ? gd.pos : vb.x + vb.width)); el.setAttribute("y2", nfmt(vert ? vb.y + vb.height : gd.pos));
  },
  renderGuides() {
    const layer = this._guidesLayer(); if (!layer) return;
    layer.innerHTML = "";
    this._raiseGuides();
    if (this.guidesHidden) return;   // Ctrl+R view toggle
    for (const gd of this.guides) {
      const mk = (cls) => { const ln = document.createElementNS(SVG_NS, "line"); ln.setAttribute("class", cls); this._applyGuideCoords(ln, gd); layer.appendChild(ln); return ln; };
      const vis = mk("hv-guideobj");   // visible 1px non-scaling line (see CSS)
      if (!this.guidesLocked) this._bindGuideDrag(mk("hv-guidehit"), vis, gd);   // wide transparent hit target
    }
  },
  addGuide(axis, pos) { this.guides.push({ axis, pos }); this._persistGuides(); this.renderGuides(); },
  removeGuide(gd) { const i = this.guides.indexOf(gd); if (i >= 0) { this.guides.splice(i, 1); this._persistGuides(); this.renderGuides(); } },
  clearGuides() { this.guides = []; this._persistGuides(); this.renderGuides(); setStatus("Guides cleared.", 1500); },
  toggleGuidesLock() { this.guidesLocked = !this.guidesLocked; this._persistGuides(); this.renderGuides(); setStatus(this.guidesLocked ? "Guides locked (visible, can't move)." : "Guides unlocked — drag to edit / add.", 2000); return this.guidesLocked; },
  _persistGuides() { try { localStorage.setItem("hector-vector:guides", JSON.stringify({ guides: this.guides, locked: this.guidesLocked })); } catch {} },
  loadGuides() { try { const s = JSON.parse(localStorage.getItem("hector-vector:guides") || "null"); if (s && Array.isArray(s.guides)) { this.guides = s.guides; this.guidesLocked = s.locked !== false; } } catch {} },
  // Snap a guide coord to artboard / object edges + centres (unless Shift overrides).
  _snapGuide(axis, v, shift) {
    if (shift || !this.smartGuides || !this.stage) return v;
    const tol = 7 / this._scaleK();
    const cand = this._guideCandidates([]); const arr = axis === "v" ? cand.xs : cand.ys;
    let best = v, bd = tol;
    for (const c of arr) { const d = Math.abs(c - v); if (d < bd) { bd = d; best = c; } }
    return best;
  },
  // Drag an existing guide. Updates the line coords IN PLACE (never re-renders the layer
  // mid-drag — that would destroy the pointer-captured element and strand the drag).
  _bindGuideDrag(hl, vis, gd) {
    hl.style.cursor = gd.axis === "v" ? "ew-resize" : "ns-resize";
    hl.addEventListener("dblclick", (e) => { e.stopPropagation(); this.removeGuide(gd); });
    hl.addEventListener("pointerdown", (e) => {
      if (this.guidesLocked || e.button !== 0) return;
      e.stopPropagation(); e.preventDefault();
      try { hl.setPointerCapture(e.pointerId); } catch {}
      this._handleDragging = true;
      const vert = gd.axis === "v";
      const move = (ev) => {
        const m = this.stage.getScreenCTM(); if (!m) return;
        const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(m.inverse());
        gd.pos = this._snapGuide(gd.axis, vert ? p.x : p.y, ev.shiftKey);
        this._applyGuideCoords(vis, gd); this._applyGuideCoords(hl, gd);   // in place, keeps the capture alive
      };
      const up = (ev) => {
        try { hl.releasePointerCapture(e.pointerId); } catch {}
        this._handleDragging = false;
        hl.removeEventListener("pointermove", move); hl.removeEventListener("pointerup", up);
        if (this._guideOverRuler(ev)) this.removeGuide(gd);   // dragged back onto the ruler → delete
        else this._persistGuides();
      };
      hl.addEventListener("pointermove", move);
      hl.addEventListener("pointerup", up);
    });
  },
  _guideOverRuler(ev) {
    const cont = document.querySelector("#rulers"); if (!cont || cont.hidden) return false;
    const inRect = (sel) => { const el = cont.querySelector(sel); if (!el) return false; const r = el.getBoundingClientRect(); return ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom; };
    return inRect(".ruler-h") || inRect(".ruler-v");
  },
  // Live W/H px tooltip near the cursor while scaling (Photopea-style).
  _showSizeReadout(w, h, clientX, clientY) {
    let el = document.getElementById("xform-readout");
    if (!el) { el = document.createElement("div"); el.id = "xform-readout"; el.className = "xform-readout"; document.body.appendChild(el); }
    el.textContent = h == null ? String(w) : `W: ${Math.round(w)} px   H: ${Math.round(h)} px`;   // h==null → w is a preformatted label (e.g. rotation °)
    el.style.left = (clientX + 16) + "px"; el.style.top = (clientY + 16) + "px"; el.hidden = false;
  },
  _hideSizeReadout() { const el = document.getElementById("xform-readout"); if (el) el.hidden = true; },
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
    this.push("Combine");
    const anchor = nodes[0];   // keep the result where the bottom-most input was
    const path = document.createElementNS(SVG_NS, "path");
    const id = "n" + (++this.idSeq); path.setAttribute("data-hv-id", id);
    path.setAttribute("d", d);
    if (fillRule) path.setAttribute("fill-rule", fillRule);
    path.setAttribute("fill", fillOverride || (src && src.getAttribute("fill")) || "#000000");
    if (src) ["stroke", "stroke-width", "vector-effect", "stroke-linejoin", "stroke-linecap", "opacity"].forEach((a) => { const v = src.getAttribute(a); if (v) path.setAttribute(a, v); });
    (anchor.parentNode || this.stage).insertBefore(path, anchor);   // land beside the inputs (inside their group if grouped)
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
    const order = this._visibleLayerOrder || this._artworkNodes().map((n) => n.getAttribute("data-hv-id")).reverse();   // flattened front-first, like the panel
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
    if (isLiveShape(n)) return shapeKindName(n) || "Path";
    const map = { path: "Path", rect: "Rectangle", circle: "Circle", ellipse: "Ellipse", polygon: "Polygon", polyline: "Polyline", line: "Line", g: "Group", image: "Image", text: "Text" };
    return map[n.tagName.toLowerCase()] || n.tagName.toLowerCase();
  },
  setVisibility(id, visible) {
    const n = this.nodeById(id); if (!n) return;
    this.push(visible ? "Show" : "Hide");
    if (visible) n.removeAttribute("display"); else n.setAttribute("display", "none");
    this._renderLayers(); this._renderSelection();
  },
  toggleLock(id) {
    const n = this.nodeById(id); if (!n) return;
    this.push("Lock");
    if (n.getAttribute("data-hv-locked") === "1") n.removeAttribute("data-hv-locked");
    else { n.setAttribute("data-hv-locked", "1"); this.selection.delete(id); }
    this._renderSelection(); this._renderInspector();
  },
  rename(id, name) {
    const n = this.nodeById(id); if (!n) return;
    this.push("Rename");
    if (name) n.setAttribute("data-hv-name", name); else n.removeAttribute("data-hv-name");
    this._renderLayers();
  },
  reorderTo(srcId, tgtId) {   // simple API: nest into a group target, else land in front of it
    const tgt = this.nodeById(tgtId);
    this._reorderDrop([srcId], tgtId, tgt && tgt.tagName.toLowerCase() === "g" ? "into" : "after");
  },
  // Move one or more layers relative to a target row. pos: "before" | "after" | "into"
  // (into = nest as the group's children). Multi-node drags keep their z-order.
  _reorderDrop(srcIds, tgtId, pos) {
    const tgt = this.nodeById(tgtId); if (!tgt) return;
    let srcs = (srcIds || []).map((id) => this.nodeById(id)).filter((s) => s && s !== tgt && !s.contains(tgt));
    if (!srcs.length) return;
    const all = [...this.stage.querySelectorAll("[data-hv-id]")];
    srcs.sort((a, b) => all.indexOf(a) - all.indexOf(b));
    this.push("Reorder");
    if (pos === "into" && tgt.tagName.toLowerCase() === "g") {
      srcs.forEach((s) => tgt.appendChild(s));            // nest as frontmost children
      this._collapsedGroups && this._collapsedGroups.delete(tgtId);   // reveal where they landed
    } else if (pos === "before") {
      srcs.forEach((s) => tgt.parentNode.insertBefore(s, tgt));
    } else {                                              // after
      [...srcs].reverse().forEach((s) => tgt.parentNode.insertBefore(s, tgt.nextSibling));
    }
    this._renderSelection(); this._renderLayers();
  },
  // Move layers out to the top level (drop on the Artboard chin or empty list space).
  reorderToRoot(srcId) { this._reorderManyToRoot([srcId]); },
  _reorderManyToRoot(srcIds) {
    const ov = this._overlayEl();
    let srcs = (srcIds || []).map((id) => this.nodeById(id)).filter((s) => s && s.parentNode !== this.stage);
    if (!srcs.length) return;
    const all = [...this.stage.querySelectorAll("[data-hv-id]")];
    srcs.sort((a, b) => all.indexOf(a) - all.indexOf(b));
    this.push("Reorder");
    srcs.forEach((s) => { if (ov && ov.parentNode === this.stage) this.stage.insertBefore(s, ov); else this.stage.appendChild(s); });
    this._renderSelection(); this._renderLayers();
  },
  _clearDropMarks() {
    document.querySelectorAll("#layers-list .drop-before, #layers-list .drop-after, #layers-list .drop-into, #layers-foot .drop-into, #layers-list.drop-root")
      .forEach((r) => r.classList.remove("drop-before", "drop-after", "drop-into", "drop-root"));
  },
  group() {
    // Group the selected objects at the frontmost one's parent — so selecting shapes
    // INSIDE a group and hitting Group makes a NESTED group (was top-level only).
    const sel = this._topSelection(this.selectedNodes()).filter((n) => n.hasAttribute && n.hasAttribute("data-hv-id"));
    if (sel.length < 2) { setStatus("Select 2 or more objects to group.", 2500); return; }
    this.push("Group");
    const ov = this._overlayEl();
    const all = [...this.stage.querySelectorAll("[data-hv-id]")];
    sel.sort((a, b) => all.indexOf(a) - all.indexOf(b));   // preserve z-order
    const front = sel[sel.length - 1], parent = front.parentNode, anchor = front.nextSibling;
    const g = document.createElementNS(SVG_NS, "g");
    const id = "n" + (++this.idSeq); g.setAttribute("data-hv-id", id);
    sel.forEach((n) => g.appendChild(n));   // keep child ids so the layers tree can address them
    if (anchor && anchor.parentNode === parent && anchor !== ov) parent.insertBefore(g, anchor);
    else if (parent === this.stage && ov && ov.parentNode === this.stage) this.stage.insertBefore(g, ov);
    else parent.appendChild(g);
    this.selection = new Set([id]); this.artboardSelected = false;
    this._renderSelection(); this._renderInspector(); this._renderLayers();
    setStatus(`Grouped ${sel.length} objects.`, 1500);
  },
  ungroup() {
    const groups = this.selectedNodes().filter((n) => n.tagName.toLowerCase() === "g");
    if (!groups.length) { setStatus("Select a group to ungroup.", 2500); return; }
    this.push("Ungroup");
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
        if (SKIP_TAGS.has(tag) || child.classList.contains("hv-artboard") || child.classList.contains("hv-overlay") || child.classList.contains("hv-guideslayer") || child.classList.contains("hv-preview")) continue;
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
    this.commitCoalesce("Clean up");
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
    this.commitCoalesce("Merge colours");
    this.selection = new Set([...this.selection].filter((id) => this.nodeById(id)));
    this._renderSelection(); this._renderInspector(); this._renderLayers();
    setStatus(`Merged ${mergedAway + into} layers into ${into} by colour.`, 3000);
  },
  // Ensure every graphical artwork element (incl. nested group children) carries a
  // data-hv-id so the layers tree can show + address them. group() no longer strips
  // child ids, but legacy/imported groups may lack them — this backfills, idempotently.
  // serialize() strips data-hv-id, so these never reach saved output.
  _ensureIds() {
    if (!this.stage) return;
    const ov = this._overlayEl();
    const GRAPHIC = new Set(["path", "rect", "circle", "ellipse", "line", "polygon", "polyline", "image", "text", "g"]);
    const walk = (parent) => {
      for (const c of parent.children) {
        if (c === ov || (c.classList && (c.classList.contains("hv-artboard") || c.classList.contains("hv-guideslayer") || c.classList.contains("hv-preview")))) continue;
        const tag = c.tagName.toLowerCase();
        if (!GRAPHIC.has(tag)) continue;
        if (!c.hasAttribute("data-hv-id")) c.setAttribute("data-hv-id", "n" + (++this.idSeq));
        if (tag === "g") walk(c);
      }
    };
    walk(this.stage);
  },
  _renderLayers() {
    const list = document.querySelector("#layers-list");
    if (!list) return;
    list.innerHTML = "";
    if (!this.stage) return;
    this._ensureIds();
    if (!this._collapsedGroups) this._collapsedGroups = new Set();
    this._visibleLayerOrder = [];   // flattened, front-first — drives shift-range selection
    const renderLevel = (parent, depth) => {
      const kids = [...parent.children].filter((c) => c.hasAttribute && c.hasAttribute("data-hv-id"));
      for (const n of kids.reverse()) {                       // top of the list = frontmost
        const id = n.getAttribute("data-hv-id");
        const isGroup = n.tagName.toLowerCase() === "g";
        const collapsed = this._collapsedGroups.has(id);
        this._visibleLayerOrder.push(id);
        list.appendChild(this._buildLayerRow(n, id, depth, isGroup, collapsed));
        if (isGroup && !collapsed) renderLevel(n, depth + 1);  // nested children, indented
      }
    };
    renderLevel(this.stage, 0);
    const lc = document.querySelector("#layers-count");
    if (lc) { const n = this._artworkNodes().length; lc.textContent = n ? String(n) : ""; }
    // Artboard row, pinned to the Layers chin (#layers-foot, below the scrolling list) so
    // it never scrolls away — a reliable click target for the canvas, and a drop target
    // that pulls a layer back out to the top level.
    const foot = document.querySelector("#layers-foot");
    if (foot) foot.innerHTML = "";
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
    // Right-click the Artboard row → same artboard panel as right-clicking the canvas.
    abRow.addEventListener("contextmenu", (e) => {
      e.preventDefault(); e.stopPropagation();
      this.selectArtboard();
      if (this.openContextPanel) this.openContextPanel(e.clientX, e.clientY, "canvas");
    });
    // Drop layer(s) onto the Artboard row → move them out to the top level (out of any group).
    const rootDrop = (e) => {
      e.preventDefault(); this._clearDropMarks();
      const ids = (this._dragLayerIds && this._dragLayerIds.length) ? this._dragLayerIds : (e.dataTransfer.getData("text/plain") || "").split(",").filter(Boolean);
      if (ids.length) this._reorderManyToRoot(ids);
    };
    abRow.addEventListener("dragover", (e) => { e.preventDefault(); this._clearDropMarks(); abRow.classList.add("drop-into"); });
    abRow.addEventListener("dragleave", () => abRow.classList.remove("drop-into"));
    abRow.addEventListener("drop", rootDrop);
    (foot || list).appendChild(abRow);
    // Drop in the empty space of the list (below all rows) → also pull out to the top level.
    if (!list._dropWired) {
      list.addEventListener("dragover", (e) => { if (e.target !== list) return; e.preventDefault(); this._clearDropMarks(); list.classList.add("drop-root"); });
      list.addEventListener("drop", (e) => { if (e.target !== list) return; rootDrop(e); });
      list._dropWired = true;
    }
    // Orient the panel to the selection: scroll the (first) active row into view.
    const act = list.querySelector(".layer-row.active:not(.artboard-row)");
    if (act) act.scrollIntoView({ block: "nearest" });
  },
  _buildLayerRow(n, id, depth, isGroup, collapsed) {
    const row = document.createElement("div");
    row.className = "layer-row" + (this.selection.has(id) ? " active" : "") + (isGroup ? " is-group" : "");
    row.draggable = true; row.dataset.id = id;
    row.style.paddingLeft = (6 + depth * 14) + "px";

    // group expand/collapse twisty (a hidden spacer keeps leaf rows aligned)
    const twist = document.createElement("button");
    twist.type = "button"; twist.className = "layer-twist" + (isGroup ? "" : " leaf");
    if (isGroup) {
      twist.textContent = collapsed ? "▸" : "▾";
      twist.title = collapsed ? "Expand group" : "Collapse group";
      twist.addEventListener("click", (e) => {
        e.stopPropagation();
        if (this._collapsedGroups.has(id)) this._collapsedGroups.delete(id); else this._collapsedGroups.add(id);
        this._renderLayers();
      });
    }

    const eye = document.createElement("button");
    eye.type = "button"; eye.className = "layer-btn";
    const hidden = n.getAttribute("display") === "none";
    eye.textContent = hidden ? "○" : "●"; eye.title = hidden ? "Show" : "Hide";
    eye.addEventListener("click", (e) => { e.stopPropagation(); this.setVisibility(id, hidden); });

    const swatch = document.createElement("span");
    swatch.className = "layer-swatch" + (isGroup ? " group" : "");
    if (isGroup) { swatch.textContent = "▤"; swatch.title = "Group"; }
    else if (this.isRaster(n)) {
      // Rasters have no fill — show a small thumbnail of the image instead of a colour chip.
      const href = n.getAttribute("href") || n.getAttribute("xlink:href") || "";
      swatch.classList.add("raster");
      swatch.title = "Raster image";
      if (href) this._rasterSwatchThumb(n, swatch, href);
      else swatch.textContent = "🖼";
    }
    else {
      const fill = toHexColor(n.getAttribute("fill"));
      if (fill && n.getAttribute("fill") !== "none") { swatch.style.background = fill; swatch.style.backgroundImage = "none"; }
      swatch.title = n.getAttribute("fill") || "no fill";
    }

    const name = document.createElement("span");
    name.className = "layer-name"; name.textContent = this.nodeName(n);
    name.title = "Double-click to rename";

    const lock = document.createElement("button");
    lock.type = "button"; lock.className = "layer-btn";
    const locked = n.getAttribute("data-hv-locked") === "1";
    lock.textContent = locked ? "L" : "·"; lock.title = locked ? "Unlock" : "Lock"; lock.classList.toggle("on", locked);
    lock.addEventListener("click", (e) => { e.stopPropagation(); this.toggleLock(id); });

    row.append(twist, eye, swatch, name, lock);
    row.addEventListener("click", (e) => { if (n.getAttribute("data-hv-locked") === "1") return; this._layerClick(id, e); });
    row.addEventListener("dblclick", (e) => { e.stopPropagation(); this._renameInline(n, name); });
    // Right-click a row → the same object context panel as right-clicking on canvas
    // (one consistent route for right-click actions).
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault(); e.stopPropagation();
      if (n.getAttribute("data-hv-locked") === "1") return;
      if (!this.selection.has(id)) { this.selection = new Set([id]); this.artboardSelected = false; this._renderSelection(); this._renderInspector(); }
      if (this.openContextPanel) this.openContextPanel(e.clientX, e.clientY, "object");
    });
    row.addEventListener("dragstart", (e) => {
      // grab the whole multi-selection together when the dragged row is part of it
      const ids = (this.selection.has(id) && this.selection.size > 1) ? [...this.selection] : [id];
      this._dragLayerIds = ids;
      e.dataTransfer.setData("text/plain", ids.join(",")); e.dataTransfer.effectAllowed = "move";
      ids.forEach((d) => { const r = document.querySelector(`#layers-list .layer-row[data-id="${CSS.escape(d)}"]`); if (r) r.classList.add("dragging"); });
    });
    row.addEventListener("dragend", () => { this._dragLayerIds = null; this._dropPos = null; document.querySelectorAll("#layers-list .layer-row.dragging").forEach((r) => r.classList.remove("dragging")); this._clearDropMarks(); });
    row.addEventListener("dragover", (e) => {
      e.preventDefault(); e.dataTransfer.dropEffect = "move";
      const r = row.getBoundingClientRect(), y = e.clientY - r.top;
      // group rows have 3 zones (before / nest-into / after) — the "crevices" decide
      // whether you're adding INTO the group or BETWEEN rows; leaf rows split in half.
      const pos = isGroup ? (y < r.height * 0.3 ? "before" : y > r.height * 0.7 ? "after" : "into") : (y < r.height / 2 ? "before" : "after");
      this._clearDropMarks();
      row.classList.add(pos === "into" ? "drop-into" : pos === "before" ? "drop-before" : "drop-after");
      this._dropPos = pos;
    });
    row.addEventListener("drop", (e) => {
      e.preventDefault(); e.stopPropagation();
      const ids = (this._dragLayerIds && this._dragLayerIds.length) ? this._dragLayerIds : (e.dataTransfer.getData("text/plain") || "").split(",").filter(Boolean);
      const pos = this._dropPos || "after";
      this._clearDropMarks();
      if (ids.length) this._reorderDrop(ids, id, pos);
    });
    return row;
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
  // Rename from elsewhere (context menu / button): reuse the layers-panel inline editor
  // when that row is on screen, otherwise a floating tag-style editor over the object —
  // never the browser's window.prompt.
  beginRename(id) {
    const n = this.nodeById(id); if (!n) return;
    const span = document.querySelector(`#layers-list .layer-row[data-id="${CSS.escape(id)}"] .layer-name`);
    if (span) { this._renameInline(n, span); return; }
    this._renameFloating(n);
  },
  // A small floating "tag" input anchored over the object's on-screen box. Commits on
  // Enter/blur, cancels on Escape; key events are trapped so editor shortcuts (Delete,
  // tool keys) don't fire while typing.
  _renameFloating(node) {
    const id = node.getAttribute("data-hv-id");
    document.querySelectorAll(".hv-rename-pop").forEach((e) => e.remove());
    let r; try { r = node.getBoundingClientRect(); } catch { r = null; }
    const inp = document.createElement("input");
    inp.type = "text"; inp.className = "hv-rename-pop"; inp.value = this.nodeName(node);
    inp.style.position = "fixed";
    const left = r && r.width ? r.left : (window.innerWidth / 2 - 110);
    const top = r && r.height ? r.top - 6 : (window.innerHeight / 2 - 16);
    inp.style.left = Math.max(8, Math.min(left, window.innerWidth - 228)) + "px";
    inp.style.top = Math.max(8, top) + "px";
    document.body.appendChild(inp); inp.focus(); inp.select();
    let done = false;
    const finish = (commit) => { if (done) return; done = true; if (commit) this.rename(id, inp.value.trim()); inp.remove(); };
    inp.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") finish(true); else if (e.key === "Escape") finish(false); });
    inp.addEventListener("blur", () => finish(true));
  },

  // ---------- inspector ----------
  // The dock no longer hosts an Inspector (object style lives in the right-click
  // panel); this keeps the layers panel + the toolstrip swatches in sync, then
  // early-returns. `onInspect` is the app's hook (refreshes the colour swatches).
  _renderInspector() {
    this._renderLayers();   // keep the layers panel in sync with structure/selection
    if (this.onInspect) this.onInspect();
    const body = document.querySelector("#inspector-body");
    const title = document.querySelector("#inspector-title");
    if (!body) return;
    // Preserve scroll across the rebuild: clicking a button inside the panel
    // (live-preview toggle, stage settings) re-renders the whole inspector, and an
    // innerHTML reset would otherwise snap scrollTop to 0 — the content jumps out
    // from under the cursor. Restoring keeps the pressed control in place.
    const keepScroll = body.scrollTop;
    body.innerHTML = "";
    if (!this.stage) { if (title) title.textContent = "No canvas"; body.innerHTML = `<div class="insp-empty">Import or open a vector.</div>`; return; }
    if (this.artboardSelected) { if (title) title.textContent = "Artboard"; body.appendChild(this._artboardPanel()); body.scrollTop = keepScroll; return; }
    const nodes = this.selectedNodes();
    if (!nodes.length) { if (title) title.textContent = "Nothing selected"; body.innerHTML = `<div class="insp-empty">Click a shape to select it, or click empty canvas for the artboard.</div>`; return; }
    if (title) title.textContent = nodes.length === 1 ? "Object" : `${nodes.length} objects`;
    body.appendChild(this._objectPanel(nodes));
    body.scrollTop = keepScroll;
  },
  // True when the selection is one-or-more raster <image> nodes (and nothing else).
  // Rasters have no fill/stroke/shape, so the inspector + colour panel adapt.
  _selectionIsRaster() {
    const ns = this.selectedNodes();
    return ns.length > 0 && ns.every((n) => this.isRaster(n));
  },
  _objectPanel(nodes) {
    // Read style from the leaf shapes (a selected group carries none of its own), and
    // detect mismatches: `common(read)` returns {value} when every leaf agrees, else
    // {mixed:true, value:<first>} — so a multi-selection with different fills/widths
    // shows an indeterminate "Mixed" state instead of silently showing just the first.
    const reads = (() => { const l = this._effectiveLeaves(nodes); return l.length ? l : nodes; })();
    const first = reads[0];
    const common = (read) => { let v, set = false; for (const n of reads) { const c = read(n); if (!set) { v = c; set = true; } else if (c !== v) return { mixed: true, value: read(first) }; } return { value: v }; };
    const wrap = document.createElement("div");
    const tags = new Set(reads.map((n) => n.tagName.toLowerCase()));
    const isRaster = reads.every((n) => this.isRaster(n));   // no fill/stroke/shape
    const r2 = (v) => Math.round(v * 100) / 100;

    // Fill / stroke COLOUR live in the persistent Colour panel now (summoned from the
    // toolstrip swatches), so the object panel only carries the non-colour style below.

    // ---- TRANSFORM — position / size / rotation / flip (Figma/Illustrator-style). X/Y
    // translate live (non-destructive); W/H scale on commit only so typing an
    // intermediate value never collapses the geometry to a sliver and back. ----
    const bb = this.selectionBBox();
    if (bb) {
      // X/Y on one row, W/H on the next (Figma/Illustrator two-up) — short numeric
      // fields shouldn't eat a whole row of whitespace. All four scrub LIVE: dragging a
      // label resizes/moves the shape in real time, not just on release.
      const posRow = numPairRow(
        ["X", r2(bb.x0), null, 1, (v) => { this.beginCoalesce(); this.setSelectionPos(v, null); }, null, () => this.commitCoalesce("Move")],
        ["Y", r2(bb.y0), null, 1, (v) => { this.beginCoalesce(); this.setSelectionPos(null, v); }, null, () => this.commitCoalesce("Move")]);
      const sizeRow = numPairRow(
        ["W", r2(bb.x1 - bb.x0), 0, 1, (v) => { this.beginCoalesce(); this.setSelectionSize(v, null, false); }, null, () => { this.commitCoalesce("Resize"); this._renderInspector(); }],
        ["H", r2(bb.y1 - bb.y0), 0, 1, (v) => { this.beginCoalesce(); this.setSelectionSize(null, v, false); }, null, () => { this.commitCoalesce("Resize"); this._renderInspector(); }]);
      // Rotation scrubs live too — labelled "R" for congruence with X/Y/W/H. Incremental
      // deltas would drift the bbox centre as the shape turns, so the centre is captured
      // once at scrub start and every step rotates about that fixed point.
      const ang = this.selectionAngle();
      const baseAng = ang == null ? 0 : r2(ang);
      let lastAng = baseAng, rotCentre = null;
      const rotField = ["R", baseAng, null, 1,
        (v) => { if (isNaN(v)) return; if (!rotCentre) { const c = this.selectionBBox(); rotCentre = { cx: (c.x0 + c.x1) / 2, cy: (c.y0 + c.y1) / 2 }; }
          this.beginCoalesce(); this.rotateSelectionBy(v - lastAng, rotCentre); lastAng = v; },
        null, () => { this.commitCoalesce("Rotate"); rotCentre = null; this._renderInspector(); }, ang == null];
      wrap.appendChild(inspGroup("Transform", [posRow, sizeRow, numHalfRow(rotField)]));
    }
    // (Align → the panel's bottom chin via _alignBar(); Flip + z-order Arrange were removed
    //  — both are global on the action bar.)

    // ---- SHAPE (contextual). A single parametric "live shape" gets the full editor
    //  (type, corners/sides/arc). Otherwise: corner radius for rects and fill-rule for
    //  freeform paths. Rows appear only when they apply. (Point control = the node tool.) ----
    const shapeRows = [];
    if (nodes.length === 1 && isLiveShape(nodes[0])) {
      shapeRows.push(...this._shapePanel(nodes[0]));
    } else {
      if (tags.has("rect") || nodes.some((n) => isLiveShape(n) && shapeKind(n) === "rect")) {
        const rxC = common((n) => isLiveShape(n) ? (shapeKind(n) === "rect" ? rectRadii(n)[0] : 0) : (n.tagName.toLowerCase() === "rect" ? (parseFloat(n.getAttribute("rx")) || 0) : 0));
        shapeRows.push(numRow("C", rxC.value || 0, 0, 1, (v) => { this.beginCoalesce(); this.setRectRadius(v); }, null, () => { this.commitCoalesce("Corner radius"); this._renderInspector(); }, !!rxC.mixed));
      }
      // fill-rule only for FREEFORM paths/polygons (a live shape is parametric, not freeform)
      if (reads.some((n) => !isLiveShape(n) && (n.tagName.toLowerCase() === "path" || n.tagName.toLowerCase() === "polygon"))) {
        const frC = common((n) => n.getAttribute("fill-rule") || "nonzero");
        shapeRows.push(this._segRow("Fill rule", frC.mixed ? null : frC.value,
          [["nonzero", "NZ"], ["evenodd", "EO"]], { nonzero: "Non-zero winding", evenodd: "Even-odd" },
          (v) => { this.setAttrAll("fill-rule", v === "nonzero" ? null : v); }));
      }
    }
    if (shapeRows.length) wrap.appendChild(inspGroup("Shape", shapeRows));

    // STROKE — weight, cap, join, miter limit, dashes. The sub-rows APPEAR/DISAPPEAR with
    // context (no greying): Cap only where the stroke has visible ENDS (open paths or a
    // dash/dotted pattern), Join only where the shape has a POINTY corner (an all-curves
    // shape like a circle has none), Miter only for a miter join. Rasters skip it entirely.
    if (!isRaster) {
    const strokeGeom = (n) => {
      const tag = n.tagName.toLowerCase();
      if (tag === "path") { const d = n.getAttribute("d") || ""; return { open: pathOpenEnds(d), corner: pathHasCorner(d) }; }
      if (tag === "line") return { open: true, corner: false };
      if (tag === "polyline") return { open: true, corner: true };
      if (tag === "rect" || tag === "polygon") return { open: false, corner: true };
      return { open: false, corner: false };   // circle / ellipse — all curves
    };
    const hasOpenEnd = reads.some((n) => strokeGeom(n).open);
    const hasCorner = reads.some((n) => strokeGeom(n).corner);
    const strokeC = common((n) => n.getAttribute("stroke"));
    const strokeWC = common((n) => parseFloat(n.getAttribute("stroke-width")) || 0);
    const strokeVal = strokeC.value;
    const strokeHex = toHexColor(strokeVal) || "#000000";
    const strokeW = strokeWC.value || 0;
    const hasStroke = reads.some((n) => { const s = n.getAttribute("stroke"); return s && s !== "none" && (parseFloat(n.getAttribute("stroke-width")) || 0) > 0; });
    this._strokeWidthInput = null;
    const curW = () => Math.max(parseFloat(this._strokeWidthInput && this._strokeWidthInput.value) || strokeW || 1, 0.01);
    const curC = () => toHexColor(first.getAttribute("stroke")) || strokeHex;
    const capC = common((n) => n.getAttribute("stroke-linecap") || "butt");
    const joinC = common((n) => n.getAttribute("stroke-linejoin") || "miter");
    const miterC = common((n) => parseFloat(n.getAttribute("stroke-miterlimit")) || 4);
    const dashC = common((n) => n.getAttribute("stroke-dasharray") || "");
    const join = joinC.value || "miter";

    // Width commits re-render so adding/removing a stroke reveals/hides the rows below.
    const widthRow = numRow("Width", strokeW, 0, 0.5, (v) => { this.beginCoalesce(); this.applyStroke(curC(), v); }, (inp) => { this._strokeWidthInput = inp; }, () => { this.commitCoalesce("Stroke width"); this._renderInspector(); }, !!strokeWC.mixed);
    const strokeRows = [widthRow];
    if (hasStroke) {
      // Alignment — SVG has no stroke-alignment, so In = clip to the shape, Out = fill
      // painted over the stroke; Center is the native default.
      const alignC = common((n) => n.getAttribute("data-hv-stroke-align") || "center");
      strokeRows.push(this._segRow("Align", alignC.mixed ? null : (alignC.value || "center"),
        [["inside", "In"], ["center", "Ctr"], ["outside", "Out"]],
        { inside: "Inside the edge", center: "Centred on the edge", outside: "Outside the edge" },
        (v) => this.setStrokeAlign(v)));
      const dashed = !!(dashC.value && dashC.value !== "none" && /[1-9]/.test(dashC.value));
      // Join: only where the shape has a pointy corner. Changing it re-renders so the
      // Miter row appears only for a miter join.
      if (hasCorner) {
        strokeRows.push(this._segRow("Join", joinC.mixed ? null : join,
          [["miter", JOIN_GLYPH.miter], ["round", JOIN_GLYPH.round], ["bevel", JOIN_GLYPH.bevel]],
          { miter: "Miter", round: "Round", bevel: "Bevel" },
          (v) => { this.push("Stroke join"); this.setStrokeAttr("stroke-linejoin", v); this._renderInspector(); }));
        if (join === "miter" && !joinC.mixed) {
          strokeRows.push(this._numSliderRow("Miter", miterC.value == null ? 4 : miterC.value, 1, 20, 0.5,
            (v) => { this.beginCoalesce(); this.setStrokeAttr("stroke-miterlimit", nfmt(v)); }, () => this.commitCoalesce("Miter limit"), !!miterC.mixed));
        }
      }
      // Dashes commit re-renders so the Cap row (just below) appears once a pattern exists.
      strokeRows.push(this._dashRow("Dashes", dashC.value || "", curW(),
        (arr, dotted) => { this.beginCoalesce(); this.setStrokeAttr("stroke-dasharray", arr); if (dotted) this.setStrokeAttr("stroke-linecap", "round"); },
        () => { this.commitCoalesce("Dashes"); this._renderInspector(); }, !!dashC.mixed));
      // Cap sits UNDER Dashes (it shapes the dash/dot ends) — shown for open ends or a pattern.
      if (hasOpenEnd || dashed) {
        strokeRows.push(this._segRow("Cap", capC.mixed ? null : (capC.value || "butt"),
          [["butt", CAP_GLYPH.butt], ["round", CAP_GLYPH.round], ["square", CAP_GLYPH.square]],
          { butt: "Butt", round: "Round", square: "Projecting" },
          (v) => { this.push("Stroke cap"); this.setStrokeAttr("stroke-linecap", v); }));
      }
    }
    wrap.appendChild(inspGroup("Stroke", strokeRows));
    }   // end !isRaster

    // APPEARANCE — blend mode + object opacity.
    const opC = common((n) => (n.hasAttribute("opacity") ? parseFloat(n.getAttribute("opacity")) : 1));
    const blendC = common((n) => n.style.getPropertyValue("mix-blend-mode") || "normal");
    const blendRow = selectRow("Blend", blendC.mixed ? "normal" : (blendC.value || "normal"), BLEND_MODES, (v) => this.applyBlendMode(v));
    wrap.appendChild(inspGroup("Appearance", [
      blendRow,
      this._sliderRow("Opacity", opC.value == null ? 1 : opC.value, (v) => { this.beginCoalesce(); this.applyOpacity(v); }, () => this.commitCoalesce("Opacity"), !!opC.mixed),
    ]));
    // PROCESS — a single raster gets the pipeline stages (upscale / remove-bg /
    // vectorize) inline. app.js owns the jobs + live trace, so it's injected via a
    // hook; the editor stays vector-pure and just hosts the returned DOM.
    if (isRaster && nodes.length === 1 && typeof this.rasterTools === "function") {
      const tools = this.rasterTools(reads[0]);
      if (tools) wrap.appendChild(tools);
    }
    return wrap;
  },
  // Parametric editor for ONE live shape: a Type switch (rect/poly/star), the kind's
  // params, and Expand-to-path. Param edits coalesce into one undo (begin on live, commit
  // on release) and never push directly.
  _shapePanel(n) {
    const rows = [];
    const kind = shapeKind(n);
    const p = (k, d) => { const v = n.getAttribute("data-hv-" + k); return v == null || v === "" ? d : parseFloat(v); };
    // live param numeric row: scrubs/edits a data-hv-<key> with coalesced undo
    const paramRow = (label, value, min, step, key, pk, commitLabel) =>
      numRow(label, value, min, step,
        (v) => { this.beginCoalesce(); this.setShapeParam(key, v, pk); }, null,
        () => { this.commitCoalesce(commitLabel || label); this._renderInspector(); });
    if (kind === "rect" || kind === "poly" || kind === "star") {
      rows.push(this._segRow("Type", kind,
        [["rect", "Rect"], ["poly", "Poly"], ["star", "Star"]],
        { rect: "Rectangle", poly: "Polygon", star: "Star" }, (v) => this.setShapeKind(v)));
    }
    if (kind === "rect") {
      const radii = rectRadii(n), uniform = radii.every((x) => x === radii[0]);
      rows.push(numRow("C", uniform ? Math.round(radii[0] * 100) / 100 : "", 0, 1,
        (v) => { this.beginCoalesce(); this.setShapeParam("r", Math.max(0, v), "rect"); }, null,
        () => { this.commitCoalesce("Corner radius"); this._renderInspector(); }, !uniform));
      const cf = (lbl, idx) => [lbl, Math.round(radii[idx] * 100) / 100, 0, 1,
        (v) => { this.beginCoalesce(); this.setRectCorner(idx, v); }, null,
        () => { this.commitCoalesce("Corner radius"); this._renderInspector(); }];
      rows.push(numPairRow(cf("TL", 0), cf("TR", 1)));
      rows.push(numPairRow(cf("BL", 3), cf("BR", 2)));
    } else if (kind === "poly") {
      rows.push(paramRow("Sides", Math.round(p("sides", 5)), 3, 1, "sides", "poly"));
      rows.push(paramRow("Corner", p("corner", 0), 0, 1, "corner", "poly", "Corner radius"));
    } else if (kind === "star") {
      rows.push(paramRow("Points", Math.round(p("points", 5)), 3, 1, "points", "star"));
      rows.push(this._numSliderRow("Inset", p("inset", 0.5), 0.05, 0.95, 0.05,
        (v) => { this.beginCoalesce(); this.setShapeParam("inset", v, "star"); }, () => { this.commitCoalesce("Star inset"); this._renderInspector(); }));
      rows.push(paramRow("Corner", p("corner", 0), 0, 1, "corner", "star", "Corner radius"));
    } else if (kind === "ellipse") {
      rows.push(paramRow("Start", Math.round(p("start", 0)), null, 1, "start", "ellipse", "Arc"));
      rows.push(paramRow("End", Math.round(p("end", 0)), null, 1, "end", "ellipse", "Arc"));
      rows.push(this._numSliderRow("Ring", p("inner", 0), 0, 0.95, 0.05,
        (v) => { this.beginCoalesce(); this.setShapeParam("inner", v, "ellipse"); }, () => { this.commitCoalesce("Ring"); this._renderInspector(); }));
    }
    // No "Expand to path" button — it's already a path. Full point control is the node
    // tool (A): grabbing an anchor frees the shape from its params (see pathNodes commit).
    return rows;
  },
  // Set one corner radius (index 0..3 = TL,TR,BR,BL) of a live rect — no push (coalesced).
  setRectCorner(idx, v) {
    this._eachSel((n) => { if (isLiveShape(n) && shapeKind(n) === "rect") { const r = rectRadii(n); r[idx] = Math.max(0, v); setShapeParam(n, "r", r.join(" ")); } });
    this._renderSelection();
  },
  // A colour row: a swatch button (None shows a hatched chip) that opens the
  // unified picker. `apply(hex|null, alpha)` is called live; history is coalesced.
  _paintRow(label, hex, alpha, commitLabel, apply, duoWhich, mixed) {
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "insp-swatch" + (hex == null ? " none" : "") + (mixed ? " mixed" : "");
    if (hex != null) { btn.style.background = hex; btn.style.opacity = String(alpha == null ? 1 : alpha); }
    btn.title = mixed ? "Mixed — click to set all selected" : (hex == null ? "None — click to set a colour" : hex);
    const paintBtn = (h, a) => {
      btn.classList.toggle("none", h == null);
      btn.style.background = h == null ? "" : h;
      btn.style.opacity = h == null ? "1" : String(a == null ? 1 : a);
      btn.title = h == null ? "None — click to set a colour" : h;
    };
    btn.addEventListener("click", () => {
      // The artboard background + fill/stroke all route to the persistent Colour panel
      // (it edits the artboard bg when the artboard is selected, the duo otherwise).
      if (duoWhich === "bg") { if (this._summonColor) this._summonColor(); return; }
      if (duoWhich && this.pickPaint) { this.pickPaint(duoWhich); return; }
      if (!this.pickColor) return;
      this.beginCoalesce();
      this.pickColor({
        title: `${commitLabel} colour`, color: hex == null ? "none" : hex, alpha: alpha == null ? 1 : alpha, allowNone: true,
        onChange: (h, a) => { apply(h, a); paintBtn(h, a); },   // keep the swatch live with the artwork
        onCommit: () => this.commitCoalesce(commitLabel),
        onCancel: () => this.cancelCoalesce(),
      });
    });
    return inspRow(label, btn);
  },
  // A segmented control (cap / join). `glyphs` is [[value, glyph], …]; `titles` maps
  // value→tooltip. A glyph that starts with "<" is treated as inline SVG markup (so
  // cap/join previews are unambiguous instead of look-alike Unicode boxes). Updates
  // its own active button inline — the persistent context panel isn't rebuilt on every
  // edit, so relying on _renderInspector here left the highlight stale ("dead").
  _segRow(label, value, glyphs, titles, onPick) {
    const seg = document.createElement("div"); seg.className = "insp-seg";
    const btns = [];
    for (const [val, glyph] of glyphs) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "insp-seg-btn" + (val === value ? " active" : "");
      if (typeof glyph === "string" && glyph.trim().startsWith("<")) b.innerHTML = glyph; else b.textContent = glyph;
      b.title = (titles && titles[val]) || val;
      b.addEventListener("click", () => { onPick(val); btns.forEach((x) => x.classList.toggle("active", x === b)); });
      btns.push(b); seg.appendChild(b);
    }
    return inspRow(label, seg);
  },
  // Slider + live numeric echo for a bounded value (e.g. miter limit). onLive runs
  // through coalesce while dragging; onCommit fires once on release.
  _numSliderRow(label, value, min, max, step, onLive, onCommit, mixed) {
    const wrap = document.createElement("div"); wrap.className = "insp-slider";
    const range = document.createElement("input"); range.type = "range";
    range.min = String(min); range.max = String(max); range.step = String(step); range.value = String(value);
    const num = document.createElement("span"); num.className = "insp-slider-val" + (mixed ? " mixed" : ""); num.textContent = mixed ? "—" : String(value);
    range.addEventListener("input", () => { num.textContent = range.value; onLive(parseFloat(range.value)); });
    range.addEventListener("change", () => { if (onCommit) onCommit(); });
    wrap.appendChild(range); wrap.appendChild(num);
    return inspRow(label, wrap);
  },
  // Dash editor: Solid / Dashed / Dotted presets (inline-SVG previews) plus Dash and
  // Gap length sliders that compose the stroke-dasharray live. Dotted forces dash→0
  // and a round cap so it renders as round dots. `live(arr, dotted)` applies during a
  // drag (coalesced); `commit()` flushes one history step on release.
  _dashRow(label, value, strokeW, live, commit, mixed) {
    let indet = !!mixed;   // multi-selection disagrees → show no active preset until one is picked
    const w = Math.max(strokeW || 1, 0.5);
    const parts = (value || "").trim().split(/[\s,]+/).map(parseFloat).filter((n) => !isNaN(n));
    let mode = !parts.length ? "solid" : (parts[0] === 0 ? "dotted" : "dashed");
    let dash = parts.length && parts[0] ? parts[0] : Math.round(w * 3);
    let gap = parts.length > 1 ? parts[1] : Math.round(w * 2);
    const max = Math.max(24, Math.round(w * 10));   // generous enough for visible dashes on any shape

    const compose = () => {
      if (mode === "solid") return "";
      if (mode === "dotted") return `${nfmt(0)} ${nfmt(Math.max(gap, 1))}`;
      return `${nfmt(Math.max(dash, 1))} ${nfmt(Math.max(gap, 1))}`;
    };
    const emit = (final) => { live(compose(), mode === "dotted"); if (final && commit) commit(); };

    const wrap = document.createElement("div"); wrap.className = "insp-stroke-style";
    const seg = document.createElement("div"); seg.className = "insp-seg";
    const sliders = document.createElement("div"); sliders.className = "insp-dash-sliders";

    // a labelled range with a live numeric readout (was value-blind — couldn't tell sizes)
    const mkSlider = (lab, get, set, minV) => {
      const row = document.createElement("label"); row.className = "insp-dash-srow";
      const span = document.createElement("span"); span.textContent = lab;
      const r = document.createElement("input"); r.type = "range"; r.min = String(minV); r.max = String(max); r.step = "1"; r.value = String(get());
      const val = document.createElement("span"); val.className = "insp-dash-val"; val.textContent = String(get());
      r.addEventListener("input", () => { set(parseFloat(r.value)); val.textContent = r.value; emit(false); });
      r.addEventListener("change", () => emit(true));
      row.appendChild(span); row.appendChild(r); row.appendChild(val); row._range = r; row._val = val;
      return row;
    };
    const dashSlider = mkSlider("Dash", () => dash, (v) => { dash = v; }, 1);
    const gapSlider = mkSlider("Gap", () => gap, (v) => { gap = v; }, 1);
    sliders.appendChild(dashSlider); sliders.appendChild(gapSlider);

    const syncUI = () => {
      sliders.style.display = mode === "solid" ? "none" : "";
      dashSlider.classList.toggle("insp-disabled", mode === "dotted");
      dashSlider._range.disabled = mode === "dotted";
      [...seg.children].forEach((b) => b.classList.toggle("active", !indet && b.dataset.mode === mode));
    };
    [["solid", "Solid"], ["dashed", "Dashed"], ["dotted", "Dotted"]].forEach(([m, t]) => {
      const b = document.createElement("button"); b.type = "button"; b.className = "insp-seg-btn"; b.dataset.mode = m;
      b.innerHTML = DASH_GLYPH[m]; b.title = t;
      b.addEventListener("click", () => { mode = m; indet = false; syncUI(); emit(true); });
      seg.appendChild(b);
    });

    wrap.appendChild(seg); wrap.appendChild(sliders);
    syncUI();
    return inspRow(label, wrap);
  },
  // Opacity slider 0–100% with a live numeric echo.
  _sliderRow(label, value, onLive, onCommit, mixed) {
    const wrap = document.createElement("div"); wrap.className = "insp-slider";
    const range = document.createElement("input"); range.type = "range"; range.min = "0"; range.max = "100"; range.value = String(Math.round(value * 100));
    const num = document.createElement("span"); num.className = "insp-slider-val" + (mixed ? " mixed" : ""); num.textContent = mixed ? "—" : Math.round(value * 100) + "%";
    range.addEventListener("input", () => { num.textContent = range.value + "%"; onLive(parseInt(range.value, 10) / 100); });
    range.addEventListener("change", () => { if (onCommit) onCommit(); });
    wrap.appendChild(range); wrap.appendChild(num);
    return inspRow(label, wrap);
  },
  _artboardPanel() {
    const ab = this.artboardEl();
    const vb = this.stage.viewBox.baseVal;
    const wrap = document.createElement("div");
    let wInp, hInp, lockAspect = !!this._abLockAspect;
    const liveSize = (which) => {
      this.beginCoalesce();
      let w = parseFloat(wInp.value) || vb.width, h = parseFloat(hInp.value) || vb.height;
      if (lockAspect && vb.width && vb.height) {     // keep the starting ratio
        const r = vb.width / vb.height;
        if (which === "w") { h = Math.max(1, Math.round(w / r)); hInp.value = String(h); }
        else if (which === "h") { w = Math.max(1, Math.round(h * r)); wInp.value = String(w); }
      }
      this.applyArtboardSize(w, h);
    };
    const setSize = (w, h) => { this.push("Artboard size"); if (wInp) wInp.value = String(w); if (hInp) hInp.value = String(h); this.applyArtboardSize(w, h); this._renderInspector(); };
    const fit = () => { const ns = this._artworkNodes(); if (!ns.length) { setStatus("No artwork to fit.", 1500); return; } const b = this._bboxUnion(ns); setSize(Math.max(1, Math.ceil(b.x1)), Math.max(1, Math.ceil(b.y1))); };
    const wRow = numRow("Width", Math.round(vb.width), 1, 1, () => liveSize("w"), (i) => { wInp = i; }, () => this.commitCoalesce("Resize artboard"));
    const hRow = numRow("Height", Math.round(vb.height), 1, 1, () => liveSize("h"), (i) => { hInp = i; }, () => this.commitCoalesce("Resize artboard"));
    const lockRow = checkRow("Lock W:H", lockAspect, (v) => { lockAspect = v; this._abLockAspect = v; });
    const ratio = vb.height ? (vb.width / vb.height) : 1;
    const orientRow = inspBtnRow("Orient", [
      { glyph: "⇄", title: "Swap width and height", onClick: () => setSize(Math.round(vb.height), Math.round(vb.width)) },
      { html: AB_FIT_ICON, title: "Fit artboard to artwork", onClick: fit },
    ]);
    orientRow.querySelector(".insp-btns").insertAdjacentHTML("beforeend", `<span class="insp-ratio">${ratio.toFixed(2)}:1</span>`);
    // common-size presets — compact grid, each captioned with its pixel size
    const pbox = document.createElement("div"); pbox.className = "insp-preset-btns";
    [["512²", 512, 512], ["1024²", 1024, 1024], ["2048²", 2048, 2048], ["16:9", 1920, 1080], ["9:16", 1080, 1920], ["4:3", 1600, 1200]]
      .forEach(([lab, w, h]) => { const b = ghostBtn(lab, () => setSize(w, h)); b.title = `${w} × ${h}`; pbox.appendChild(b); });
    const presetRow = inspRow("Presets", pbox);
    wrap.appendChild(inspGroup("Size", [wRow, hRow, lockRow, orientRow, presetRow]));

    // Background: a live swatch preview (opens the Colour panel) + a Transparent toggle.
    // The Colour panel edits the artboard fill while the artboard is selected.
    const bgFill = ab.getAttribute("fill"), bgNone = !bgFill || bgFill === "none";
    const sw = document.createElement("button"); sw.type = "button"; sw.className = "insp-swatch" + (bgNone ? " none" : "");
    if (!bgNone) sw.style.background = bgFill; sw.title = bgNone ? "Transparent — click to choose a colour" : bgFill;
    sw.addEventListener("click", () => { if (this._summonColor) this._summonColor(); });
    const swatchRow = inspRow("Fill", sw);
    const transRow = checkRow("None", bgNone, (v) => { this.push("Artboard background"); this.applyArtboardBg(v ? null : "#ffffff"); this._renderInspector(); });
    wrap.appendChild(inspGroup("Background", [swatchRow, transRow]));
    return wrap;
  },

  // ---------- save ----------
  async save() {
    if (!this.stage) return;
    if (!selectedOutput) { setStatus("Save needs an imported or opened document for now.", 3500); return; }
    try {
      const svgText = await serializeForSave(); if (!svgText) return;   // self-contained: bake raster hrefs → data URIs (linked fallback if too large)
      const data = await api("/api/save-svg", "POST", { folder: selectedOutput.folder, name: selectedOutput.name, svg: svgText });
      setManualOutputName(data.name);
      this.pinned = false;
      await refreshAll();
      setStatus(data.message || "Saved.", 2500);
    } catch (e) { setStatus(`Save failed: ${e.message}`, 4000); }
  },
};

// ---------- inspector control builders ----------
// Inline-SVG previews for the cap / join / dash segmented controls. currentColor so
// the active (inverted) button still reads. Far clearer than the old look-alike
// Unicode glyphs (▭ ▢ ■ / ⌐ ◜ ◹) that rendered as near-identical tofu boxes.
const CAP_GLYPH = {
  butt: `<svg viewBox="0 0 24 16" width="24" height="13" aria-hidden="true"><line x1="8" y1="8" x2="16" y2="8" stroke="currentColor" stroke-width="8" stroke-linecap="butt"/></svg>`,
  round: `<svg viewBox="0 0 24 16" width="24" height="13" aria-hidden="true"><line x1="8" y1="8" x2="16" y2="8" stroke="currentColor" stroke-width="8" stroke-linecap="round"/></svg>`,
  square: `<svg viewBox="0 0 24 16" width="24" height="13" aria-hidden="true"><line x1="8" y1="8" x2="16" y2="8" stroke="currentColor" stroke-width="8" stroke-linecap="square"/></svg>`,
};
const JOIN_GLYPH = {
  miter: `<svg viewBox="0 0 24 18" width="24" height="14" aria-hidden="true"><path d="M5 16 L12 5 L19 16" fill="none" stroke="currentColor" stroke-width="5" stroke-linejoin="miter"/></svg>`,
  round: `<svg viewBox="0 0 24 18" width="24" height="14" aria-hidden="true"><path d="M5 16 L12 5 L19 16" fill="none" stroke="currentColor" stroke-width="5" stroke-linejoin="round"/></svg>`,
  bevel: `<svg viewBox="0 0 24 18" width="24" height="14" aria-hidden="true"><path d="M5 16 L12 5 L19 16" fill="none" stroke="currentColor" stroke-width="5" stroke-linejoin="bevel"/></svg>`,
};
const DASH_GLYPH = {
  solid: `<svg viewBox="0 0 36 12" width="34" height="11" aria-hidden="true"><line x1="3" y1="6" x2="33" y2="6" stroke="currentColor" stroke-width="2.5"/></svg>`,
  dashed: `<svg viewBox="0 0 36 12" width="34" height="11" aria-hidden="true"><line x1="3" y1="6" x2="33" y2="6" stroke="currentColor" stroke-width="2.5" stroke-dasharray="6 4"/></svg>`,
  dotted: `<svg viewBox="0 0 36 12" width="34" height="11" aria-hidden="true"><line x1="3" y1="6" x2="33" y2="6" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-dasharray="0.1 6"/></svg>`,
};
// Align / arrange / flip glyphs — small inline SVGs (same clarity rationale as the
// cap/join icons: unambiguous, currentColor so the hover/active state still reads).
const ALIGN_ICON = {
  left: `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="1" y="1.5" width="1.4" height="13" fill="currentColor"/><rect x="3.5" y="3.2" width="9.5" height="3" rx="0.5" fill="currentColor"/><rect x="3.5" y="9.8" width="6" height="3" rx="0.5" fill="currentColor"/></svg>`,
  right: `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="13.6" y="1.5" width="1.4" height="13" fill="currentColor"/><rect x="3" y="3.2" width="9.5" height="3" rx="0.5" fill="currentColor"/><rect x="6.5" y="9.8" width="6" height="3" rx="0.5" fill="currentColor"/></svg>`,
  hcenter: `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="7.3" y="1.5" width="1.4" height="13" fill="currentColor"/><rect x="3" y="3.2" width="10" height="3" rx="0.5" fill="currentColor"/><rect x="5" y="9.8" width="6" height="3" rx="0.5" fill="currentColor"/></svg>`,
  top: `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="1.5" y="1" width="13" height="1.4" fill="currentColor"/><rect x="3.2" y="3.5" width="3" height="9.5" rx="0.5" fill="currentColor"/><rect x="9.8" y="3.5" width="3" height="6" rx="0.5" fill="currentColor"/></svg>`,
  bottom: `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="1.5" y="13.6" width="13" height="1.4" fill="currentColor"/><rect x="3.2" y="3" width="3" height="9.5" rx="0.5" fill="currentColor"/><rect x="9.8" y="6.5" width="3" height="6" rx="0.5" fill="currentColor"/></svg>`,
  vmiddle: `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="1.5" y="7.3" width="13" height="1.4" fill="currentColor"/><rect x="3.2" y="3" width="3" height="10" rx="0.5" fill="currentColor"/><rect x="9.8" y="5" width="3" height="6" rx="0.5" fill="currentColor"/></svg>`,
};
const AB_FIT_ICON =`<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="1.5" y="1.5" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.1" stroke-dasharray="2 1.4"/><rect x="5" y="5" width="6" height="6" fill="currentColor"/></svg>`;
const BLEND_MODES = [
  ["normal", "Normal"], ["multiply", "Multiply"], ["screen", "Screen"], ["overlay", "Overlay"],
  ["darken", "Darken"], ["lighten", "Lighten"], ["color-dodge", "Colour dodge"], ["color-burn", "Colour burn"],
  ["hard-light", "Hard light"], ["soft-light", "Soft light"], ["difference", "Difference"], ["exclusion", "Exclusion"],
  ["hue", "Hue"], ["saturation", "Saturation"], ["color", "Colour"], ["luminosity", "Luminosity"],
];
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
// A row of square icon buttons (align / arrange / flip). `btns`: [{html|glyph, title, onClick, active, disabled}].
function inspBtnRow(label, btns) {
  const box = document.createElement("div"); box.className = "insp-btns";
  for (const b of btns) {
    const el = document.createElement("button"); el.type = "button"; el.className = "insp-iconbtn" + (b.active ? " on" : "");
    if (b.html) el.innerHTML = b.html; else el.textContent = b.glyph || "";
    el.title = b.title || ""; if (b.disabled) el.disabled = true;
    el.addEventListener("click", () => b.onClick());
    box.appendChild(el);
  }
  return inspRow(label, box);
}
// A labelled <select> row (blend mode, etc.). `options`: [[value, text], …].
function selectRow(label, value, options, onChange) {
  const sel = document.createElement("select");
  for (const [v, t] of options) { const o = document.createElement("option"); o.value = v; o.textContent = t; if (v === value) o.selected = true; sel.appendChild(o); }
  sel.addEventListener("change", () => onChange(sel.value));
  return inspRow(label, sel);
}
function colorRow(label, value, onLive, onCommit) {
  const inp = document.createElement("input"); inp.type = "color"; inp.value = value || "#000000";
  inp.addEventListener("input", () => onLive(inp.value));
  inp.addEventListener("change", () => { onLive(inp.value); if (onCommit) onCommit(); });
  return inspRow(label, inp);
}
// Drag-to-scrub: the row label becomes an "invisible slider" (ew-resize). Drag right
// to raise / left to lower by `step` per ~4px; coarse Shift = ×10, fine Alt = ÷10. A
// plain click does nothing (so the number field stays normally typeable). The live
// onLive runs through coalesce; onCommit fires once at the end of the drag.
function makeScrub(handle, inp, min, step, onLive, onCommit) {
  if (!handle) return;
  handle.classList.add("scrub");
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const start = parseFloat(inp.value) || 0;
    const base = parseFloat(step) || 1;
    const lo = min != null ? parseFloat(min) : -Infinity;
    let moved = false;
    const move = (ev) => {
      const dx = ev.clientX - startX;
      if (!moved && Math.abs(dx) < 3) return;
      moved = true;
      const unit = ev.shiftKey ? base * 10 : ev.altKey ? base / 10 : base;
      let v = start + Math.round(dx / 4) * unit;
      v = Math.max(lo, Math.round(v * 1e4) / 1e4);
      inp.value = String(v);
      onLive(v);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      if (moved && onCommit) onCommit();
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  });
}
// One label+number field — the shared building block. `field` is a compact label+input
// grid; used full-width by numRow and two-up by numPairRow. `disabled` greys it out and
// drops the scrub (e.g. Corner on a non-rect, kept present to balance the row). Returns
// {field, inp}.
function numField(label, value, min, step, onLive, capture, onCommit, mixed, disabled) {
  const field = document.createElement("div"); field.className = "insp-field" + (disabled ? " is-disabled" : "");
  const s = document.createElement("span"); s.textContent = label;
  const inp = document.createElement("input"); inp.type = "number";
  if (mixed) { inp.value = ""; inp.placeholder = "Mixed"; } else inp.value = String(value);
  if (min != null) inp.min = String(min);
  inp.step = String(step);
  if (disabled) { inp.disabled = true; }
  else {
    inp.addEventListener("input", () => { if (inp.value !== "") onLive(parseFloat(inp.value)); });
    inp.addEventListener("change", () => { if (inp.value !== "") onLive(parseFloat(inp.value)); if (onCommit) onCommit(); });
    makeScrub(s, inp, min, step, onLive, onCommit);
  }
  if (capture) capture(inp);
  field.appendChild(s); field.appendChild(inp);
  return { field, inp };
}
// Two number fields on one row (X|Y, W|H) — reclaims the dead horizontal space a single
// short value left as whitespace. Each arg is a numField argument list.
function numPairRow(a, b) {
  const row = document.createElement("div"); row.className = "insp-row insp-pair";
  row.appendChild(numField(...a).field);
  row.appendChild(numField(...b).field);
  return row;
}
// A lone compact field in the left half of a pair row (right half empty) — for single
// congruent fields like R (rotate) and C (corner) so their input lines up under X / W
// instead of stretching full-width. `spec` is a numField argument list.
function numHalfRow(spec) {
  const row = document.createElement("div"); row.className = "insp-row insp-pair";
  row.appendChild(numField(...spec).field);
  row.appendChild(document.createElement("div"));
  return row;
}
function numRow(label, value, min, step, onLive, capture, onCommit, mixed) {
  const inp = document.createElement("input"); inp.type = "number";
  if (mixed) { inp.value = ""; inp.placeholder = "Mixed"; } else inp.value = String(value);
  if (min != null) inp.min = String(min);
  inp.step = String(step);
  inp.addEventListener("input", () => { if (inp.value !== "") onLive(parseFloat(inp.value)); });
  inp.addEventListener("change", () => { if (inp.value !== "") onLive(parseFloat(inp.value)); if (onCommit) onCommit(); });
  if (capture) capture(inp);
  const row = inspRow(label, inp);
  makeScrub(row.querySelector("span"), inp, min, step, onLive, onCommit);
  return row;
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
