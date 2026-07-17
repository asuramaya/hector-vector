// =========================================================================
// hector-vector editor — the document IS the live stage <svg> (single source
// of truth). Undo/redo via markup snapshots; selection by data-hv-id; tools
// (select / node / pen / shapes), boolean ops, transforms, layers, inspector.
// Built on the hv library; talks to the app shell through a small service set.
// This is the main surface to extend with new tools/ops.
// =========================================================================

import {
  SVG_NS, MAX_HANDLES, SKIP_TAGS, SHAPE_TOOLS,
  nfmt, penPathD, toHexColor, marchingSquares, rasterMask, rasterStroke,
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
import { historyMixin } from "./editor/history.js";
import { layersMixin } from "./editor/panel-layers.js";
import { penMixin } from "./editor/tools/pen.js";
import { curvatureMixin } from "./editor/tools/curvature.js";
import { marqueeMixin } from "./editor/tools/marquee.js";
import { nodeMixin } from "./editor/tools/node.js";
import { transformMixin } from "./editor/tools/transform.js";
import { textMixin } from "./editor/tools/text.js";
import { textStylesMixin } from "./editor/tools/textstyles.js";
import { masksMixin } from "./editor/tools/masks.js";
import { expandMixin } from "./editor/tools/expand.js";
import { widthMixin } from "./editor/tools/width.js";
import { builderMixin } from "./editor/tools/builder.js";
import { blendMixin } from "./editor/tools/blend.js";
import { colorsMixin } from "./editor/tools/colors.js";
import { isolationMixin } from "./editor/tools/isolation.js";
import { symbolsMixin } from "./editor/tools/symbols.js";
import { effectsMixin } from "./editor/tools/effects.js";
import { repeatMixin } from "./editor/tools/repeat.js";
import { artboardsMixin } from "./editor/tools/artboards.js";
import { snap45 } from "./editor/snap.js";
import {
  CAP_GLYPH, JOIN_GLYPH, DASH_GLYPH, ALIGN_ICON, AB_FIT_ICON, BLEND_MODES,
  inspGroup, inspRow, inspBtnRow, selectRow, numPairRow, numHalfRow, numRow, checkRow, ghostBtn,
} from "./editor/ui-rows.js";

// Epic B path-construction tools — each drives its own pointer handler, none take the
// select/shape draw path. (Set lives here, the handlers in editor/tools/builder.js.)
const BUILDER_TOOLS = new Set(["shapebuilder", "scissors", "knife", "eraser"]);

function editorSvgEl() {
  return outputPreviewEl.querySelector("svg.inline-svg");
}

// On real iOS devices, getScreenCTM() disagrees with where the browser actually paints: a touch
// inverted through it and drawn lands ~100px from the finger. Every iOS browser is WebKit (Chrome
// included), which is why "a different browser" never helped. getBoundingClientRect() reports real
// paint geometry and agrees with the touch's own clientX/clientY, so measure the TRUE stage->screen
// affine from three probe points rather than trusting the CTM. Correct by construction, whatever
// the underlying cause — no need to guess at page zoom (that guess has already been wrong once:
// visualViewport read a clean 1.000 on a device that still had the bug).
//
// The probes MUST be renderable. SVG says r=0 disables rendering, and WebKit honours that by
// returning an EMPTY getBoundingClientRect (sitting at the page origin) — so the r=0 circles this
// function used to probe with collapsed all three points onto one spot on iOS and solved to a
// SINGULAR matrix, which every tool then inverted into garbage. That shipped, and made the bug
// worse than it started. Chromium reports a position for r=0 regardless, which is precisely why no
// headless test caught it (verified in Playwright's real WebKit: r=0 -> left=8,top=8; a sized rect
// -> the correct point). Hence: sized rects, measured centre-to-centre, and a singular solve is
// REJECTED rather than trusted — an all-zero matrix is "finite", so a Number.isFinite check alone
// waves it straight through.
function measureStageAffine(stage, raw) {
  const host = stage.querySelector("g.hv-overlay") || stage;   // editor-owned layer, never serialized
  const rawScale = raw ? (Math.hypot(raw.a, raw.b) || 1) : 1;
  const h = 4 / rawScale;   // probe half-size ~4 screen px: always renders, never rounds to nothing
  const probe = (x, y) => {
    const r = document.createElementNS(SVG_NS, "rect");
    r.setAttribute("x", String(x - h)); r.setAttribute("y", String(y - h));
    r.setAttribute("width", String(2 * h)); r.setAttribute("height", String(2 * h));
    r.setAttribute("fill", "none"); r.style.pointerEvents = "none";
    host.appendChild(r);
    const b = r.getBoundingClientRect();
    r.remove();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };   // centre: exact even under rotation
  };
  // Anchor on the viewBox so the probes always land on real canvas at a sane separation, whatever
  // the zoom — never at fixed absolute coordinates that compound with it.
  const vb = stage.viewBox && stage.viewBox.baseVal;
  const ax = vb && vb.width ? vb.x + vb.width / 2 : 0;
  const ay = vb && vb.height ? vb.y + vb.height / 2 : 0;
  const d = vb && vb.width ? vb.width / 4 : 100;
  if (!Number.isFinite(ax) || !Number.isFinite(ay) || !(d > 0)) return null;

  const p0 = probe(ax, ay), p1 = probe(ax + d, ay), p2 = probe(ax, ay + d);
  const a = (p1.x - p0.x) / d, c = (p2.x - p0.x) / d, e = p0.x - a * ax - c * ay;
  const b = (p1.y - p0.y) / d, dd = (p2.y - p0.y) / d, f = p0.y - b * ax - dd * ay;
  if (![a, b, c, dd, e, f].every(Number.isFinite)) return null;
  if (!(Math.abs(a * dd - b * c) > 1e-9)) return null;   // singular -> unusable; fall back to raw
  return new DOMMatrix([a, b, c, dd, e, f]);
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
  _gradMode: false,     // select sub-mode: edit the selected object's gradient via on-canvas handles
  _gradTarget: "fill",  // which paint the gradient handles edit ("fill" | "stroke")
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
    // Cancel any coalescing edit (e.g. the colour panel's debounced commit) BEFORE
    // clearing history — otherwise the next push() in the new document would commit the
    // OLD document's markup as history[0], and undo would replace the doc with the old one.
    this.cancelCoalesce();
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
    this._loadArtboards(svgEl);   // parse <metadata> extras (restores primary geom) — back-compat: none → single artboard
    svgEl.classList.add("hv-pickable");
    if (!svgEl._hvBound) {
      svgEl.addEventListener("pointerdown", (e) => this._onPointerDown(e));
      svgEl.addEventListener("dblclick", (e) => this._onDblClick(e));
      svgEl._hvBound = true;
    }
    this.renderGuides();   // re-create the (data-backed) guides layer on this fresh stage
    if (this.artboards && this.artboards.length) this._reflowCanvas();   // grow the canvas to the union + draw extra-artboard frames
    this._reconcileIsolation();   // re-apply (or drop) isolation dim against this fresh DOM (Epic I)
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
    // <defs> resource ids (hvgrad/hvclip/hvmask/…) share the idSeq space — count them too so a
    // reopened doc never re-mints an id that an existing gradient/clip/filter already uses.
    svg.querySelectorAll("defs [id]").forEach((n) => {
      const m = +(/\d+/.exec(n.getAttribute("id")) || [0])[0];
      if (m > max) max = m;
    });
    this.idSeq = max;
    for (const child of Array.from(svg.children)) {
      const tag = child.tagName.toLowerCase();
      if (SKIP_TAGS.has(tag)) continue;
      if (child.classList.contains("hv-artboard") || child.classList.contains("hv-overlay") || child.classList.contains("hv-guideslayer") || child.classList.contains("hv-ablayer") || child.classList.contains("hv-preview")) continue;
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
      return !SKIP_TAGS.has(t) && !c.classList.contains("hv-artboard") && !c.classList.contains("hv-overlay") && !c.classList.contains("hv-guideslayer") && !c.classList.contains("hv-ablayer");
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
  // Mint a unique real id for a <defs> resource (gradient/clip/mask/filter/pattern). Shares the
  // idSeq counter with node ids ("n{n}") so it's globally unique; the prefix keeps the kind
  // legible in the markup. Real id (NOT data-hv-*) → serialize() preserves it and url(#…) refs
  // round-trip. _ensureStructure counts existing resource ids into idSeq on reopen (no re-mint).
  // The resource HOME is the existing _defs() (the `<defs class="hv-defs">` stroke-align already
  // uses) — one shared store, not a second <defs>.
  _mintDefId(prefix) { return `${prefix || "hvres"}${++this.idSeq}`; },

  // ---------- serialization ----------
  serialize() {
    if (!this.stage) return "";
    const c = this.stage.cloneNode(true);
    c.querySelectorAll("g.hv-overlay, g.hv-guideslayer, g.hv-ablayer, g.hv-preview").forEach((g) => g.remove());
    c.querySelectorAll(".hv-raster-hidden").forEach((n) => { n.classList.remove("hv-raster-hidden"); if (!n.getAttribute("class")) n.removeAttribute("class"); });
    c.querySelectorAll(".hv-iso-keep").forEach((n) => { n.classList.remove("hv-iso-keep"); if (!n.getAttribute("class")) n.removeAttribute("class"); });   // isolation dim is editor-only (Epic I)
    // inline-svg is a query-selector hook (editor.js's own outputPreviewEl.querySelector("svg.inline-svg"))
    // and transparent-board is a CSS hook for the editor's checkerboard-behind-transparency chin — neither
    // means anything outside this app's own stylesheet/DOM queries, so both leaked into every saved/exported
    // file (verified: a plain 2-shape test document round-tripped through Save came back class="inline-svg
    // transparent-board" on the root <svg>). Strip them the same way hv-pickable/hv-iso already are.
    c.classList.remove("hv-pickable", "hv-iso", "inline-svg", "transparent-board");
    if (!c.getAttribute("class")) c.removeAttribute("class");   // don't leave a dangling class=""
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

  // ---------- history (undo/redo + panel) → mixed in from src/editor/history.js ----------

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
    if (this._touchGesture) return;   // two-finger pinch/pan in progress → the viewport owns this touch
    if (this._spacePan) return;   // spacebar held → let the viewport pan the drag (don't select/draw)
    if (e.button !== 0) return;   // right/middle clicks are for the context menu, not draw/select
    if (this.tool === "pen") { this._penDown(e); return; }
    if (this.tool === "curvature") { this._curvDown(e); return; }
    if (this.tool === "text") { this._textDown(e); return; }
    if (this.tool === "width") { this._widthDown(e); return; }
    if (this.tool === "shapebuilder") { this._builderDown(e); return; }
    if (this.tool === "scissors") { this._scissorsDown(e); return; }
    if (this.tool === "knife") { this._knifeDown(e); return; }
    if (this.tool === "eraser") { this._eraserDown(e); return; }
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
      const m = this.stageCTM();
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
    // Clicking a shape inside a group selects/moves the WHOLE group — ascend to the top-level
    // object (a direct child of the artwork root). In isolation the root is the isolated group,
    // so its CHILDREN are individually selectable; otherwise the root is the stage. Reach deeper
    // levels via the layers panel or by isolating (double-click).
    const _root = this._artRoot();
    if (this.isIsolated() && hit && !_root.contains(hit)) hit = null;   // outside the isolation → not selectable
    if (hit && _root.contains(hit)) { let top = hit; while (top.parentNode && top.parentNode !== _root) top = top.parentNode; if (top.nodeType === 1 && top.hasAttribute && top.hasAttribute("data-hv-id")) hit = top; }
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
    const inv = () => this.stageCTM().inverse();
    const start = new DOMPoint(startEvent.clientX, startEvent.clientY).matrixTransform(inv());
    let bases = nodes.map((n) => currentTranslate(n));
    let origs = nodes.map((n) => n.getAttribute("transform"));
    let flats = nodes.map((n) => this._isTranslateOnly(n));   // per node: translate-only stays clean, matrix/rotate composes
    const altDup = startEvent.altKey;        // Alt-drag → drag a duplicate, leave the original
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
        if (cand) {                          // smart-guide snap (skipped while Shift-constraining)
          const m = this.stageCTM(); const k = m ? Math.hypot(m.a, m.b) || 1 : 1;
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
    const inv = () => this.stageCTM().inverse();
    const start = new DOMPoint(startEvent.clientX, startEvent.clientY).matrixTransform(inv());
    this.beginCoalesce();                         // snapshot the document before the shape exists
    this.selection = new Set(); this.artboardSelected = false; this._renderSelection();
    const node = makeShapeNode(tool, start, this.style);
    this._artHome().insertBefore(node, this._artBefore());   // into the isolated group when isolated (Epic I)
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
  // (pen tool extracted -> editor/tools/pen.js, Object.assign penMixin)
  // (curvature tool extracted -> editor/tools/curvature.js, Object.assign curvatureMixin)

  // ---------- tools ----------
  // V (select) and A (node) are the two primary tools; pen/curvature/shapes are the
  // creation sub-tools. Marquee + transform are folded into select (empty-drag
  // rubber-bands; Ctrl+T/Ctrl+R toggle the scale/rotate sub-mode).
  setTool(t) {
    if (t !== "select" && t !== "node" && t !== "pen" && t !== "curvature" && t !== "text" && t !== "width" && !BUILDER_TOOLS.has(t) && !SHAPE_TOOLS.has(t)) return;
    if (this._pen && t !== "pen") this._finishPen(true);   // keep any in-progress path
    if (this._curv && t !== "curvature") this._curvFinish(true);
    if (this._textEdit && t !== "text") this._commitText();   // leaving the text tool finishes the edit in progress
    if (t !== this.tool) { this._xformMode = null; this._gradMode = false; }   // leaving select drops the transform / gradient sub-mode
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
    if (t === "width") this._mountWidthHandles(); else this._unmountWidthHandles();
    if (!BUILDER_TOOLS.has(t)) this._bTrail(null);   // clear any leftover knife/eraser trail
    if (this.stage) this._renderSelection();   // show/hide the transform bbox handles
    this._showHint();
  },
  // The bottom bar shows a contextual hint for the current tool / state.
  //
  // TOUCH GETS ITS OWN SENTENCES, and this is not politeness. Every hint below is written for a
  // desktop: it spends most of its words on Shift, Alt, Ctrl, Esc and Enter. Handed to a phone —
  // which is exactly where the strip matters most, being the only surface there with no hover, no
  // tooltips and no shortcuts — those clauses are not merely useless, they are instructions to press
  // keys that do not exist. So on a coarse pointer we say the same thing in the gestures that ARE
  // there, and say less of it: the strip clamps to two lines at 390px, and a sentence that gets cut
  // off mid-clause teaches nothing.
  _touchHint() {
    const t = this.tool;
    if (t === "select") {
      if (this._xformMode === "scale") return "Scale: drag the corner handles. Tap ⤢ again when you're done.";
      if (this._xformMode === "rotate") return "Rotate: drag the round corner handles. Tap ⟳ again when you're done.";
      if (this.artboardSelected) return "Artboard selected. Set its size in the panel, or tap a shape to select that instead.";
      if (this.selection.size) return `${this.selection.size} selected. Drag to move · hold for more actions · ⤢ resize · ⟳ turn`;
      return "Select: tap a shape to pick it up. Drag empty space to sweep up several. Hold anything for its actions.";
    }
    if (t === "node") return "Points: drag the dots to reshape. Drag the line between two dots to bend it.";
    if (t === "width") return "Width: drag sideways across a stroke to make it swell or pinch.";
    if (t === "shapebuilder") return "Shape Builder: select 2+ overlapping shapes, then paint across them to merge.";
    if (t === "scissors") return "Scissors: tap a path to snip it open.";
    if (t === "knife") return "Knife: drag right across a shape to slice it in two.";
    if (t === "eraser") return `Eraser (${this._eraserR}px): drag over a shape to rub it away.`;
    if (t === "pen") return "Pen: tap to place corners, drag to curve. Tap the first point to close the shape.";
    if (t === "curvature") return "Curvature: tap to place points and they smooth themselves. Tap the first point to close.";
    if (t === "rect") return "Rectangle: drag on the canvas.";
    if (t === "ellipse") return "Ellipse: drag on the canvas.";
    if (t === "line") return "Line: drag on the canvas.";
    return "";
  },
  _hint() {
    if (this._coarse === undefined) {
      this._coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
    }
    if (this._coarse) return this._touchHint();
    const t = this.tool;
    if (t === "select") {
      if (this._xformMode === "scale") return "Scale — drag the box handles · Shift keeps aspect · Alt from centre · Esc to finish";
      if (this._xformMode === "rotate") return "Rotate — drag the corner rotators · Shift = 15° · Esc to finish";
      if (this.artboardSelected) return "Artboard — set size/background in the panel · click a shape to select it";
      // Ctrl+R has meant "rulers" for a long time — this line advertised a shortcut that did the
      // wrong thing, for a mode nothing could enter. Both now have buttons (#act-scale / #act-rotate).
      if (this.selection.size) return `${this.selection.size} selected — drag to move · Alt-drag duplicates · Ctrl+T or ⤢ scale · ⟳ rotate · ⌫ delete`;
      return "Select (V) — click a shape · drag to marquee (Alt = lasso) · Space-drag pans · A edits points";
    }
    if (t === "node") return "Points (A) — drag anchors/handles · Shift multi-selects · Alt converts · drag a segment to reshape · ⌫ deletes";
    if (t === "width") return "Width (W) — drag a stroke ⊥ to swell/pinch it · Alt = one side · Uniform/Release/Expand in Properties";
    if (t === "shapebuilder") return "Shape Builder — paint across 2+ selected overlapping shapes to merge regions · Alt-paint removes them";
    if (t === "scissors") return "Scissors — click a path to cut it (closed → opens · open → splits in two)";
    if (t === "knife") return "Knife — drag across filled shapes to cut them · Alt = straight cut";
    if (t === "eraser") return `Eraser (${this._eraserR}px) — drag over filled shapes to erase · [ / ] resize`;
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
    if (this.tool === "width" && this.stage) this._mountWidthHandles();   // width-stop diamonds stay constant-screen-size
    if (this.tool === "select" && this._xformMode && this.stage) this._renderSelection();   // handles are constant-screen-size
    if (this.tool === "pen" && !this._pen && this.stage) this._renderPenPoints();   // anchor dots stay constant-screen-size
    if (this._pen) { this._redrawPen(); this._renderPenMarks(); }
    if (this._curv) { this._curvRedraw(); this._curvMarks(); }
    if (this._textEdit) this._positionTextOverlay();   // keep the text overlay glued to the canvas as it zooms/pans
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
    // Text carries its placement/scale/rotation as a transform ATTRIBUTE (SVG renders it
    // natively); there's no glyph geometry to bake a matrix into without the font outlines.
    // So leave text transform-carried — baking it would corrupt the node. (To node-edit a
    // glyph, Convert to outlines first — then it's a path and bakes like any other.)
    if (tag === "text") return;
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
    // Baking a scaled transform into geometry would otherwise THIN/THICKEN the stroke
    // (the transform used to scale the stroke too) — so the "render-identical" bake
    // wasn't, and there was no undo step to recover from it. Compensate stroke-width by
    // the matrix's mean (geometric) scale so the rendered width is unchanged, unless the
    // stroke is explicitly non-scaling.
    const sf = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;
    if (Math.abs(sf - 1) > 1e-6 && (el.getAttribute("vector-effect") || "") !== "non-scaling-stroke") {
      const stroke = el.getAttribute("stroke");
      if (stroke && stroke !== "none") {
        const sw = parseFloat(el.getAttribute("stroke-width"));
        el.setAttribute("stroke-width", nfmt((Number.isFinite(sw) ? sw : 1) * sf));
      }
    }
    el.removeAttribute("transform");
    if (isLiveShape(el)) freezeShape(el);   // baking geometry desyncs params → make it a plain path
  },
  // (node tool extracted -> editor/tools/node.js, Object.assign nodeMixin)

  // (transform tool scale/rotate handles extracted -> editor/tools/transform.js, Object.assign transformMixin)

  // (marquee / drag-select tool extracted -> editor/tools/marquee.js, Object.assign marqueeMixin)

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
  applyFill(color) { this.style.fill = color || "none"; this.style.fillPaint = null; this._eachSel((n) => { if (this.isRaster(n)) return; n.setAttribute("fill", color || "none"); }); this._gcDefs(); },
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
  // ---------- gradients (Epic G) ----------
  // Build a <linearGradient>/<radialGradient> from a spec. Geometry is in the SVG default
  // objectBoundingBox space (0..1) so the gradient scales/moves WITH the object and stays portable.
  // spec: { type:"linear"|"radial", stops:[{offset,color,opacity}], x1,y1,x2,y2 | cx,cy,r,fx,fy }.
  _gradientFromSpec(spec, id) {
    const radial = spec.type === "radial";
    const el = document.createElementNS(SVG_NS, radial ? "radialGradient" : "linearGradient");
    el.setAttribute("id", id);
    const num = (v, d) => nfmt(v == null ? d : v);
    if (radial) {
      el.setAttribute("cx", num(spec.cx, 0.5)); el.setAttribute("cy", num(spec.cy, 0.5)); el.setAttribute("r", num(spec.r, 0.5));
      el.setAttribute("fx", num(spec.fx, spec.cx == null ? 0.5 : spec.cx)); el.setAttribute("fy", num(spec.fy, spec.cy == null ? 0.5 : spec.cy));
    } else {
      el.setAttribute("x1", num(spec.x1, 0)); el.setAttribute("y1", num(spec.y1, 0));
      el.setAttribute("x2", num(spec.x2, 1)); el.setAttribute("y2", num(spec.y2, 0));
    }
    const stops = (spec.stops && spec.stops.length) ? spec.stops : [{ offset: 0, color: "#ffffff" }, { offset: 1, color: "#000000" }];
    for (const s of stops) {
      const stop = document.createElementNS(SVG_NS, "stop");
      stop.setAttribute("offset", nfmt(Math.max(0, Math.min(1, s.offset == null ? 0 : s.offset))));
      stop.setAttribute("stop-color", s.color || "#000000");
      if (s.opacity != null && s.opacity < 1) stop.setAttribute("stop-opacity", nfmt(Math.max(0, s.opacity)));
      el.appendChild(stop);
    }
    return el;
  },
  // Write a gradient onto node `n`'s fill/stroke: reuse the node's OWN gradient id if it already
  // has one (live edits stay stable + leave no orphan), else mint a fresh one. Returns the id.
  _writeGradient(n, attr, spec) {
    const m = /url\(#([^)]+)\)/.exec(n.getAttribute(attr) || "");
    let reuse = null;
    if (m) { const g = this.stage.querySelector("#" + CSS.escape(m[1])); if (g && /gradient$/i.test(g.tagName)) reuse = m[1]; }
    const el = this._gradientFromSpec(spec, reuse || this._mintDefId("hvgrad"));
    if (reuse) this.stage.querySelector("#" + CSS.escape(reuse)).replaceWith(el);
    else this._defs().appendChild(el);
    return el.getAttribute("id");
  },
  // Apply a paint to the selection + remember it as last-used. paint:
  //   {kind:"none"} | {kind:"solid", color, opacity?} | {kind:"gradient", spec}.
  // Callers own history (push / beginCoalesce). Gradients mint per-node (independent); orphans GC'd.
  applyPaint(target, paint) {
    const attr = target === "stroke" ? "stroke" : "fill";
    const opAttr = target === "stroke" ? "stroke-opacity" : "fill-opacity";
    const paintKey = target === "stroke" ? "strokePaint" : "fillPaint";
    this._eachSel((n) => {
      if (this.isRaster(n)) return;
      if (!paint || paint.kind === "none") { n.setAttribute(attr, "none"); n.removeAttribute(opAttr); }
      else if (paint.kind === "gradient") { n.setAttribute(attr, "url(#" + this._writeGradient(n, attr, paint.spec) + ")"); n.removeAttribute(opAttr); }
      else { n.setAttribute(attr, paint.color || "#000000"); if (paint.opacity != null && paint.opacity < 1) n.setAttribute(opAttr, nfmt(Math.max(0, paint.opacity))); else n.removeAttribute(opAttr); }
    });
    if (paint && paint.kind === "gradient") {
      // last-used: keep this.style[attr] a sane SOLID fallback (first stop) for makeShapeNode, stash the spec
      const first = paint.spec.stops && paint.spec.stops[0];
      if (first && first.color) this.style[attr] = first.color;
      this.style[paintKey] = paint.spec;
    } else { this.style[attr] = (paint && paint.kind === "solid") ? (paint.color || "none") : "none"; this.style[paintKey] = null; }
    this._gcDefs();
  },
  // Read a node's current fill/stroke back to a paint descriptor (for the colour panel / inspector).
  paintOf(node, target) {
    const attr = target === "stroke" ? "stroke" : "fill";
    const v = (node.getAttribute(attr) || "").trim();
    if (!v || v === "none") return { kind: "none" };
    const m = /url\(#([^)]+)\)/.exec(v);
    if (m) { const g = this.stage && this.stage.querySelector("#" + CSS.escape(m[1])); if (g && /gradient$/i.test(g.tagName)) return { kind: "gradient", spec: this._specFromGradient(g) }; return { kind: "none" }; }
    const op = parseFloat(node.getAttribute(target === "stroke" ? "stroke-opacity" : "fill-opacity"));
    return { kind: "solid", color: v, opacity: isNaN(op) ? 1 : op };
  },
  // Parse a gradient element back to a spec.
  _specFromGradient(g) {
    const radial = /radialGradient$/i.test(g.tagName);
    const stops = [...g.querySelectorAll("stop")].map((s) => ({
      offset: parseFloat(s.getAttribute("offset")) || 0,
      color: s.getAttribute("stop-color") || "#000000",
      opacity: s.hasAttribute("stop-opacity") ? (parseFloat(s.getAttribute("stop-opacity")) || 0) : 1,
    }));
    const f = (a, d) => { const x = parseFloat(g.getAttribute(a)); return isNaN(x) ? d : x; };
    return radial
      ? { type: "radial", stops, cx: f("cx", 0.5), cy: f("cy", 0.5), r: f("r", 0.5), fx: f("fx", 0.5), fy: f("fy", 0.5) }
      : { type: "linear", stops, x1: f("x1", 0), y1: f("y1", 0), x2: f("x2", 1), y2: f("y2", 0) };
  },
  // ---------- on-canvas gradient handles (G.4) ----------
  // The gradient element a node's fill/stroke points at, or null.
  _gradEl(node, target) { const m = /url\(#([^)]+)\)/.exec((node && node.getAttribute(target === "stroke" ? "stroke" : "fill")) || ""); return m ? this.stage.querySelector("#" + CSS.escape(m[1])) : null; },
  // Toggle the on-canvas gradient editor for the selected object. `which` picks fill/stroke;
  // defaults to whichever carries a gradient. A select sub-mode (like scale/rotate), mutually
  // exclusive with the transform handles.
  enterGradientEdit(which) {
    const n = this.selectedNodes()[0];
    if (!n) { this._gradMode = false; this._renderSelection(); return; }
    const tgt = which || (this.paintOf(n, "fill").kind === "gradient" ? "fill" : "stroke");
    if (this.paintOf(n, tgt).kind !== "gradient") return;
    if (this._gradMode && this._gradTarget === tgt) { this._gradMode = false; }
    else { this._gradMode = true; this._gradTarget = tgt; if (this.tool !== "select") this.setTool("select"); this._xformMode = null; }
    this._renderSelection(); this._renderInspector(); if (this._showHint) this._showHint();
  },
  clearGradMode() { if (this._gradMode) { this._gradMode = false; this._renderSelection(); this._renderInspector(); } },
  // Mount drag handles for the selected gradient: start/end (linear) or centre/radius (radial),
  // positioned by mapping the gradient's objectBoundingBox coords (0..1) through the node's
  // geometry bbox into stage space. Self-heals (clears the mode) if the selection isn't a single
  // gradient object. Handle geometry is recomputed each render, so a drag just re-renders.
  _mountGradientHandles() {
    const ov = this._overlayEl(); if (!ov || !this.stage) return;
    const sel = this.selectedNodes(); const n = sel.length === 1 ? sel[0] : null;
    const tgt = this._gradTarget || "fill";
    if (!n || this.paintOf(n, tgt).kind !== "gradient") { this._gradMode = false; return; }
    const grad = this._gradEl(n, tgt); if (!grad) { this._gradMode = false; return; }
    let bb; try { bb = n.getBBox(); } catch { return; }
    if (!(bb.width > 0) || !(bb.height > 0)) return;
    const toStage = this.stage.getScreenCTM().inverse().multiply(n.getScreenCTM());
    const f2s = (fx, fy) => new DOMPoint(bb.x + fx * bb.width, bb.y + fy * bb.height).matrixTransform(toStage);
    const m = this.stageCTM(); const k = m ? Math.hypot(m.a, m.b) || 1 : 1; const r = 5 / k;
    const num = (a, d) => { const v = parseFloat(grad.getAttribute(a)); return isNaN(v) ? d : v; };
    const g = document.createElementNS(SVG_NS, "g"); g.setAttribute("class", "hv-gradedit");
    const dot = (p, which) => { const c = document.createElementNS(SVG_NS, "circle"); c.setAttribute("cx", nfmt(p.x)); c.setAttribute("cy", nfmt(p.y)); c.setAttribute("r", nfmt(r)); c.setAttribute("class", "hv-gradedit-handle"); this._bindGradientHandle(c, n, tgt, which); return c; };
    if (/radialGradient$/i.test(grad.tagName)) {
      const c = f2s(num("cx", 0.5), num("cy", 0.5)), e = f2s(num("cx", 0.5) + num("r", 0.5), num("cy", 0.5));
      const ring = document.createElementNS(SVG_NS, "circle"); ring.setAttribute("cx", nfmt(c.x)); ring.setAttribute("cy", nfmt(c.y)); ring.setAttribute("r", nfmt(Math.hypot(e.x - c.x, e.y - c.y))); ring.setAttribute("class", "hv-gradedit-ring");
      g.append(ring, dot(c, "center"), dot(e, "radius"));
    } else {
      const a = f2s(num("x1", 0), num("y1", 0)), b = f2s(num("x2", 1), num("y2", 0));
      const ln = document.createElementNS(SVG_NS, "line"); ln.setAttribute("x1", nfmt(a.x)); ln.setAttribute("y1", nfmt(a.y)); ln.setAttribute("x2", nfmt(b.x)); ln.setAttribute("y2", nfmt(b.y)); ln.setAttribute("class", "hv-gradedit-line");
      g.append(ln, dot(a, "start"), dot(b, "end"));
    }
    ov.appendChild(g);
  },
  // Drag one gradient handle. Listeners live on `document` so the per-move overlay re-render
  // (which removes the handle element) doesn't abort the drag. Writes objectBoundingBox coords
  // back onto the gradient element live; one undo step via coalesce.
  _bindGradientHandle(el, node, target, which) {
    el.addEventListener("pointerdown", (e) => {
      e.stopPropagation(); e.preventDefault();
      let bb; try { bb = node.getBBox(); } catch { return; }
      const grad = this._gradEl(node, target); if (!grad) return;
      this._handleDragging = true;
      const frac = (ev) => {
        const sp = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(this.stageCTM().inverse());
        const lp = new DOMPoint(sp.x, sp.y).matrixTransform(node.getScreenCTM().inverse().multiply(this.stage.getScreenCTM()));
        return { fx: (lp.x - bb.x) / bb.width, fy: (lp.y - bb.y) / bb.height };
      };
      this.beginCoalesce();
      const move = (ev) => {
        const { fx, fy } = frac(ev);
        if (which === "start") { grad.setAttribute("x1", nfmt(fx)); grad.setAttribute("y1", nfmt(fy)); }
        else if (which === "end") { grad.setAttribute("x2", nfmt(fx)); grad.setAttribute("y2", nfmt(fy)); }
        else if (which === "center") { grad.setAttribute("cx", nfmt(fx)); grad.setAttribute("cy", nfmt(fy)); grad.setAttribute("fx", nfmt(fx)); grad.setAttribute("fy", nfmt(fy)); }
        else if (which === "radius") { const cx = parseFloat(grad.getAttribute("cx")) || 0.5, cy = parseFloat(grad.getAttribute("cy")) || 0.5; grad.setAttribute("r", nfmt(Math.max(0.001, Math.hypot(fx - cx, fy - cy)))); }
        this._renderSelection();
      };
      const up = () => { document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up); this._handleDragging = false; this.commitCoalesce("Gradient geometry"); };
      document.addEventListener("pointermove", move); document.addEventListener("pointerup", up);
    });
  },
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
  // The canonical, lazily-created store for ALL reusable <defs> resources — stroke-align clips
  // today, plus gradients / clipPaths / masks / filters / patterns as those land. One element,
  // marked .hv-defs, kept as the stage's first child. No special-casing needed elsewhere: `defs`
  // is in SKIP_TAGS and carries no data-hv-id, so it's excluded from artwork enumeration, hit-test,
  // layers, and wrapper-flatten; serialize() drops only the overlay/guides/preview chrome + the
  // data-hv-* attrs, so a store of real-id resources round-trips untouched. Mint ids via _mintDefId.
  _defs() {
    let d = this.stage.querySelector("defs.hv-defs");
    if (!d) { d = document.createElementNS(SVG_NS, "defs"); d.setAttribute("class", "hv-defs"); this.stage.insertBefore(d, this.stage.firstChild); }
    return d;
  },
  // Drop store resources nothing references any more (e.g. a gradient/clip/mask/filter whose only
  // user was just deleted), so the store doesn't grow unbounded. Conservative: collects EVERY
  // url(#…)/#href across the live stage — artwork AND other defs, so transitively-used resources
  // (a gradient used by a still-referenced mask) are kept — and removes only UNreferenced resource
  // children. Call it AFTER the history snapshot (push) so undo restores the removed resource.
  _gcDefs() {
    if (!this.stage) return;
    const defs = this.stage.querySelector("defs.hv-defs"); if (!defs || !defs.children.length) return;
    const used = new Set();
    const add = (v) => { if (!v) return; let m; const re = /url\(["']?#([^"')]+)["']?\)|^#(.+)$/g; while ((m = re.exec(v))) used.add(m[1] || m[2]); };
    this.stage.querySelectorAll("*").forEach((n) => {
      if (!n.getAttribute) return;
      for (const a of ["fill", "stroke", "clip-path", "mask", "filter", "href", "xlink:href"]) add(n.getAttribute(a));
      add(n.getAttribute("style"));   // url(#…) can hide in an inline style too
    });
    const RES_TAGS = new Set(["lineargradient", "radialgradient", "pattern", "mask", "filter", "clippath"]);
    for (const c of [...defs.children]) {
      const id = c.getAttribute("id");
      if (id && RES_TAGS.has(c.tagName.toLowerCase()) && !used.has(id)) c.remove();
    }
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
    if (this.artboards && this.artboards.length) this._reflowCanvas();   // re-grow the union so extras aren't clipped by the primary's new size
    this._renderSelection(); measureFit(viewports.output);
  },

  // ---------- Phase 2 object ops (each is one undo step) ----------
  _artworkNodes() { return [...this.stage.children].filter((c) => c.hasAttribute && c.hasAttribute("data-hv-id")); },
  // Clone the current selection into the stage at an optional offset; returns the
  // new ids. Does NOT push history or change selection (callers decide).
  // Group descendants carry their own data-hv-id; cloneNode copies them verbatim, so a
  // cloned/pasted subtree would have DUPLICATE ids — nodeById() (first-match) then resolves
  // to the original's child, so selecting/editing the copy's child hits the original.
  // Assign a fresh id to every descendant. Stroke-aligned nodes are left to
  // _reanchorStrokeAlign (it re-ids AND rebuilds their clip refs), so skip them here.
  _reidSubtree(root) {
    if (!root || !root.querySelectorAll) return;   // querySelectorAll returns descendants only (not root)
    root.querySelectorAll("[data-hv-id]").forEach((n) => {
      if (n.hasAttribute("data-hv-stroke-align")) return;
      n.setAttribute("data-hv-id", "n" + (++this.idSeq));
    });
  },
  // Re-mint REAL `id`s across freshly-cloned roots and rewire intra-clone references to them.
  // data-hv-id is handled by _reidSubtree, but a real `id` (a path hosting a <textPath>, a
  // <clipPath>, a <use> target) would otherwise collide with the original (invalid SVG) and the
  // clone's href/clip-path would resolve to the ORIGINAL element. Batched across all roots so a
  // co-cloned text-on-path + its path rewire to each other rather than back to the originals.
  _reidRealIds(roots) {
    const map = new Map();
    const walk = (fn) => roots.forEach((r) => { if (r.getAttribute) fn(r); if (r.querySelectorAll) r.querySelectorAll("*").forEach(fn); });
    walk((n) => { const old = n.getAttribute("id"); if (old && !map.has(old)) { const fresh = "hvid" + (++this.idSeq); n.setAttribute("id", fresh); map.set(old, fresh); } });
    // EXTERNAL <defs> resources a clone references (gradient/pattern/mask/filter/clipPath that live
    // outside the cloned subtree) are deep-copied into the store ONCE per clone-batch + repointed,
    // so editing the duplicate's paint/effect/clip never mutates the original's. Intra-subtree refs
    // resolve via `map`; stroke-align clips (hvsa-*) are owned by _reanchorStrokeAlign → left alone.
    const RES_TAGS = new Set(["lineargradient", "radialgradient", "pattern", "mask", "filter", "clippath"]);
    const extMap = new Map();
    const resolveRef = (id) => {
      if (!id) return null;
      if (map.has(id)) return map.get(id);             // intra-subtree → already re-id'd above
      if (id.indexOf("hvsa-") === 0) return null;      // stroke-align clip → managed elsewhere
      if (extMap.has(id)) return extMap.get(id);
      const src = this.stage.querySelector("#" + CSS.escape(id));
      if (!src || !RES_TAGS.has(src.tagName.toLowerCase())) return null;   // not a copyable resource
      const copy = src.cloneNode(true);
      const fresh = "hvid" + (++this.idSeq);
      copy.setAttribute("id", fresh);
      copy.querySelectorAll("[data-hv-id]").forEach((d) => d.removeAttribute("data-hv-id"));
      this._defs().appendChild(copy);
      extMap.set(id, fresh);
      return fresh;
    };
    const repointHref = (n, a) => { const v = n.getAttribute(a); if (v && v.charAt(0) === "#") { const t = resolveRef(v.slice(1)); if (t) n.setAttribute(a, "#" + t); } };
    const repointUrl = (n, a) => { const v = n.getAttribute(a); if (!v) return; const m = /url\(["']?#([^"')]+)["']?\)/.exec(v); if (!m) return; const t = resolveRef(m[1]); if (t) n.setAttribute(a, v.replace(m[0], "url(#" + t + ")")); };
    walk((n) => {
      repointHref(n, "href"); repointHref(n, "xlink:href");
      for (const a of ["fill", "stroke", "clip-path", "mask", "filter"]) repointUrl(n, a);
    });
  },
  _cloneSelection(offsetX = 0, offsetY = 0) {
    const ov = this._overlayEl(); const ids = []; const clones = [];
    for (const n of this.selectedNodes()) {
      const c = n.cloneNode(true);
      const id = "n" + (++this.idSeq); c.setAttribute("data-hv-id", id);
      this._reidSubtree(c);           // fresh ids for group descendants (no duplicate-id collisions)
      if (offsetX || offsetY) { const t = currentTranslate(c); setTranslate(c, t.x + offsetX, t.y + offsetY); }
      this._artHome().insertBefore(c, this.isIsolated() ? null : ov);   // Epic I: clones land inside the isolation
      this._reanchorStrokeAlign(c);   // rebuild any stroke-align clip against the clone's new id
      clones.push(c); ids.push(id);
    }
    this._reidRealIds(clones);        // fresh REAL ids (textPath host path, clipPath, use) + rewire refs
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
    const ov = this._overlayEl(); const ids = []; const pasted = [];
    for (const el of els) {
      const id = "n" + (++this.idSeq); el.setAttribute("data-hv-id", id);
      this._reidSubtree(el);           // fresh ids for group descendants (no duplicate-id collisions)
      const t = currentTranslate(el); setTranslate(el, t.x + 12, t.y + 12);
      this._artHome().insertBefore(el, this.isIsolated() ? null : ov);   // Epic I: paste into the isolation
      this._reanchorStrokeAlign(el);   // rebuild any stroke-align clip against the paste's new id
      pasted.push(el); ids.push(id);
    }
    this._reidRealIds(pasted);         // fresh REAL ids (textPath host path, clipPath, use) + rewire refs
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
    this._artHome().insertBefore(g, this.isIsolated() ? null : ov);
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
    this._artHome().insertBefore(img, this.isIsolated() ? null : ov);
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
    const pool = this.isIsolated() ? this._artScope() : this._artworkNodes();   // scope to the isolation (Epic I)
    const ids = pool.filter((n) => n.getAttribute("data-hv-locked") !== "1").map((n) => n.getAttribute("data-hv-id"));
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
      // Text has no geometry to bake a scale into (font-size is one number, glyph shapes
      // live in the font), so it scales via a consolidated transform MATRIX — non-destructive
      // and serialization-safe. (Convert to outlines first to scale the actual glyph paths.)
      if (n.tagName.toLowerCase() === "text") {
        const M = `matrix(${nfmt(sx)} 0 0 ${nfmt(sy)} ${nfmt(ax * (1 - sx))} ${nfmt(ay * (1 - sy))})`;
        const o = n.getAttribute("transform"); n.setAttribute("transform", o ? `${M} ${o}` : M); this._consolidateTransform(n);
        return;
      }
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
    // Like booleanOp: a raw <text> has no fillable geometry, so it would silently contribute
    // nothing to the inverted region. Convert the selected text to outlines first (ids survive),
    // then re-run on the resulting paths.
    if (this.selectedNodes().some((n) => n.tagName.toLowerCase() === "text")) {
      setStatus("Converting text to outlines first…", 0);
      this.convertSelectedTextToOutlines().then((ids) => {
        if (ids && ids.length && !this.selectedNodes().some((n) => n.tagName.toLowerCase() === "text")) this.invertSpace();
      }).catch((e) => setStatus(`Couldn't convert the text to outlines: ${(e && e.message) || e}`, 5000));
      return;
    }
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
    for (const n of nodes) { const d = shapeToAbsPath(n, n.getCTM()); if (d) paths.push({ d, rule: n.getAttribute("fill-rule") }); }
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
    // element's full CTM (to stage user space) so the box is correct for ANY transform
    // (translate / scale / rotate / matrix) AND any ANCESTOR/group transform — getCTM
    // composes the whole chain, where the old own-transform consolidate ignored the group
    // (a grouped leaf's box, boolean bbox, align + size readout were all offset).
    const bb = n.getBBox();
    let m = null;
    try { m = n.getCTM(); } catch { m = null; }
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
      const d = shapeToAbsPath(n, n.getCTM()); if (!d) continue;   // full CTM → true rotated/scaled/grouped geometry
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
    // Guard rail (T18): a raw <text> has no path geometry, so it can't take part in a boolean.
    // Rather than silently drop it, convert the selected text to outlines first (ids are
    // preserved, so the selection survives) and re-run the op on the resulting paths.
    if (this.selectedNodes().some((n) => n.tagName.toLowerCase() === "text")) {
      setStatus("Converting text to outlines first…", 0);
      this.convertSelectedTextToOutlines().then((ids) => {
        // Re-run only if the conversion actually produced paths AND no text remains —
        // otherwise convert already surfaced WHY (server error / needs a web font), so
        // re-running would loop forever and bury that message under "select 2+ shapes".
        if (ids && ids.length && !this.selectedNodes().some((n) => n.tagName.toLowerCase() === "text")) this.booleanOp(op);
      }).catch((e) => setStatus(`Couldn't convert the text to outlines: ${(e && e.message) || e}`, 5000));
      return;
    }
    const nodes = this._fillableSelection();
    if (nodes.length < 2) { setStatus("Select 2 or more filled shapes for a boolean op.", 2800); return; }
    // Order by z (document position), NOT selection/click order: subtract removes the
    // FRONT shapes from the BACK one (nodes[0] = backmost), and union/intersect take the
    // frontmost's style — so the result is stable however the user built the selection.
    nodes.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1);
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
  // The screen<->stage transform, corrected for whatever is making getScreenCTM() disagree with
  // real paint geometry on iOS. Don't try to predict WHEN the correction is needed — always
  // measure. An earlier version only re-measured when visualViewport reported a page pinch-zoom,
  // and a real device then showed visualViewport.scale at exactly 1.000 while getScreenCTM() was
  // still ~100px out, so the correction never even ran. If a measurement can't be trusted,
  // measureStageAffine returns null and we fall back to the raw CTM (today's behaviour) rather
  // than to a broken one.
  //
  // Every touch/pointer coordinate mapping should call this instead of this.stage.getScreenCTM()
  // directly — EXCEPT where a raw stage CTM is composed against another element's raw CTM in the
  // same expression (that cancels the error by construction; correcting only one side would
  // reintroduce it — see editor.js's own node<->stage transforms). Re-measures IMMEDIATELY
  // whenever the raw CTM's own numbers change (our own zoom/pan is cheap to detect and handle size
  // must track it exactly — a time-only throttle here once left node handles the wrong size for up
  // to 120ms after a zoom). When the raw CTM is unchanged, only re-verifies once per throttle
  // window, since that's the case where an outside-the-DOM mechanism could be drifting silently.
  stageCTM() {
    const raw = this.stage && this.stage.getScreenCTM && this.stage.getScreenCTM();
    if (!raw) return raw;
    const now = performance.now();
    const rawKey = `${raw.a},${raw.b},${raw.c},${raw.d},${raw.e},${raw.f}`;
    if (this._ctmCache && this._ctmCache.rawKey === rawKey && (now - this._ctmCache.at) < 120) {
      this._ctmMeasured = this._ctmCache.measured;
      return this._ctmCache.matrix;
    }
    const measured = measureStageAffine(this.stage, raw);
    // Whether the calibration actually RAN, as opposed to quietly falling back to the raw CTM.
    // Falling back is safe (it's exactly today's behaviour) but on iOS it means the ~100px touch
    // offset is back and nothing says so — an inert fix looks identical to a working one. Surfaced
    // so tests and Settings -> Debug can assert the correction is live rather than assume it.
    this._ctmMeasured = !!measured;
    this._ctmCache = { rawKey, at: now, matrix: measured || raw, measured: !!measured };
    return measured || raw;
  },
  _ctmCache: null,
  _ctmMeasured: false,
  _scaleK() { const m = this.stageCTM(); return m ? (Math.hypot(m.a, m.b) || 1) : 1; },
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
        const m = this.stageCTM(); if (!m) return;
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
    this._gcDefs();   // inputs' effects/masks/unused gradients are now orphaned (the result carries only fill) → reclaim
    this.selection = new Set([id]); this.artboardSelected = false;
    this._renderSelection(); this._renderInspector(); this._renderLayers();
    setStatus(msg, 2000);
  },

  // ---------- layers ----------
  nodeName(n) {
    const custom = n.getAttribute("data-hv-name"); if (custom) return custom;
    if (n.tagName.toLowerCase() === "text") { const s = (n.textContent || "").replace(/\s+/g, " ").trim(); return s ? (s.length > 24 ? s.slice(0, 23) + "…" : s) : "Text"; }
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
    const GRAPHIC = new Set(["path", "rect", "circle", "ellipse", "line", "polygon", "polyline", "image", "text", "g", "use"]);   // `use` = symbol instances (Epic Y) — tag reloaded ones
    const walk = (parent) => {
      for (const c of parent.children) {
        if (c === ov || (c.classList && (c.classList.contains("hv-artboard") || c.classList.contains("hv-guideslayer") || c.classList.contains("hv-ablayer") || c.classList.contains("hv-preview")))) continue;
        const tag = c.tagName.toLowerCase();
        if (!GRAPHIC.has(tag)) continue;
        if (!c.hasAttribute("data-hv-id")) c.setAttribute("data-hv-id", "n" + (++this.idSeq));
        if (tag === "g") walk(c);
      }
    };
    walk(this.stage);
  },
  // ---------- layers panel (render + rows) → mixed in from src/editor/panel-layers.js ----------
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
  // Object COMMANDS surfaced via the "Actions ▾" menu button (built in _objectPanel) instead of
  // always-on inspector groups. Context-gated so only applicable verbs appear — mirrors the
  // conditions the inline Expand/Width/Blend/Pattern/Symbol/Transform+ groups used before.
  _objectActions(nodes) {
    if (!nodes || !nodes.length) return [];
    const reads = (() => { const l = this._effectiveLeaves(nodes); return l.length ? l : nodes; })();
    if (reads.every((n) => this.isRaster(n))) return [];
    const tag = (n) => n.tagName.toLowerCase();
    const single = nodes.length === 1 ? nodes[0] : null;
    const expandable = reads.some((n) => isLiveShape(n) || ["rect", "circle", "ellipse", "line", "polygon", "polyline", "text"].includes(tag(n)) || this._isStroked(n));
    const hasStroke = reads.some((n) => { const s = n.getAttribute("stroke"); const w = parseFloat(n.getAttribute("stroke-width")); return s && s !== "none" && w > 0; });
    const hasPath = reads.some((n) => shapeToAbsPath(n));
    const fillable = this._fillableSelection ? this._fillableSelection().length : 0;
    const anyWs = nodes.some((n) => this._wsGroupOf(n));
    const isBlend = single && this.isBlendGroup(single);
    const isRepeat = single && this.isRepeatGroup(single);
    const anyInstance = nodes.some((n) => this.isSymbolInstance(n));
    const items = [];
    if (expandable) items.push({ label: "Expand object", onClick: () => this.expandSelection() });
    if (hasStroke) items.push({ label: "Outline stroke", onClick: () => this.outlineStroke() });
    if (hasPath) items.push({ label: "Offset path…", onClick: () => this._promptOffsetPath() });
    if (fillable >= 2) {
      items.push({ type: "sep" });
      for (const [op, lab] of [["divide", "Divide"], ["trim", "Trim"], ["merge", "Merge"], ["crop", "Crop"], ["minus-back", "Minus Back"]])
        items.push({ label: "Pathfinder: " + lab, onClick: () => this.pathfinder(op) });
    }
    const areaTexts = nodes.length === 2 && nodes.every((n) => this._isAreaText && this._isAreaText(n));
    const singleThreadable = single && this._isAreaText && this._isAreaText(single)
      && (single.getAttribute("data-hv-text-next") || (this._isThreadTarget && this._isThreadTarget(single)));
    const makes = [];
    if (reads.some((n) => this._isStroked(n)) && !anyWs) makes.push({ label: "Vary width", onClick: () => { this.makeWidthStroke(); this.setTool("width"); } });
    if (fillable === 2 && !isBlend) makes.push({ label: "Make blend", onClick: () => this.makeBlend() });
    if (nodes.length >= 2) makes.push({ label: "Pattern fill", onClick: () => this.fillWithPattern() });
    if (!anyInstance) makes.push({ label: "Make symbol", onClick: () => this.makeSymbol() });
    if (areaTexts) makes.push({ label: "Thread text", onClick: () => this.linkTextFrames() });
    if (singleThreadable) makes.push({ label: "Unthread text", onClick: () => this.unlinkTextFrames() });
    if (makes.length) { items.push({ type: "sep" }, ...makes); }
    if (!isRepeat) {
      items.push({ type: "sep" },
        { label: "Reflect — vertical axis", onClick: () => this.reflectSelection("vertical") },
        { label: "Reflect — horizontal axis", onClick: () => this.reflectSelection("horizontal") },
        { label: "Reflect a copy", onClick: () => this.reflectSelection("vertical", { copy: true }) },
        { label: "Shear / skew…", onClick: () => this._promptShear() },
        { label: "Transform again", onClick: () => this.transformAgain() },
        { type: "sep" },
        { label: "Repeat — grid", onClick: () => this.repeat("grid") },
        { label: "Repeat — radial", onClick: () => this.repeat("radial") },
        { label: "Repeat — mirror", onClick: () => this.repeat("mirror") });
    }
    // Collapse leading / trailing / doubled separators.
    const clean = [];
    for (const it of items) { if (it.type === "sep" && (!clean.length || clean[clean.length - 1].type === "sep")) continue; clean.push(it); }
    while (clean.length && clean[clean.length - 1].type === "sep") clean.pop();
    return clean;
  },
  // Open the Actions menu anchored under its button.
  _openObjectActions(anchorEl) {
    const items = this._objectActions(this.selectedNodes());
    if (!items.length || typeof this.showMenu !== "function") return;
    const r = anchorEl.getBoundingClientRect();
    this.showMenu(r.left, r.bottom + 2, items);
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

    // Object COMMANDS (Expand / Outline / Offset / Pathfinder / make-symbol·blend·pattern·width /
    // Reflect / Repeat) live in an Actions menu now, not as always-on inspector groups — that's
    // what kept Properties bloated. The menu is context-gated (only applicable verbs appear).
    if (!isRaster) {
      const acts = this._objectActions(nodes);
      if (acts.length) {
        const ab = document.createElement("button"); ab.type = "button"; ab.className = "insp-actions-btn"; ab.textContent = "Actions ▾";
        ab.title = "Object commands — expand, outline, offset, pathfinder, reflect, repeat, symbol…";
        ab.addEventListener("click", () => this._openObjectActions(ab));
        wrap.appendChild(ab);
      }
    }

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
    // ---- TEXT — font family / size / weight / style / alignment / spacing (T6). Shown
    //  only when every selected node is a <text>; fill/stroke fall through to the shared
    //  paint rows below (text isn't a raster, so it gets the full paint inspector). ----
    if (reads.length && reads.every((n) => n.tagName.toLowerCase() === "text")) {
      wrap.appendChild(inspGroup("Text", this._textPanel(reads, common)));
    }
    // Text on path (T19): a text + a path co-selected → offer to flow the text along the curve.
    if (this._canPutOnPath && this._canPutOnPath(nodes)) {
      const onp = document.createElement("button");
      onp.type = "button"; onp.className = "insp-action"; onp.textContent = "Put text on path";
      onp.title = "Flow the selected text along the selected path";
      onp.addEventListener("click", () => this.putTextOnPath());
      wrap.appendChild(inspGroup("Text on path", [inspRow("Bind", onp)]));
    }
    // Gradient (G.5): a single gradient-filled/stroked object → type/stop summary + an on-canvas
    // "Edit" toggle that mounts the direction handles (the Colour panel edits the stops).
    if (nodes.length === 1 && !isRaster) {
      const fp = this.paintOf(nodes[0], "fill"), sp = this.paintOf(nodes[0], "stroke");
      const which = fp.kind === "gradient" ? "fill" : (sp.kind === "gradient" ? "stroke" : null);
      if (which) {
        const spec = (which === "fill" ? fp : sp).spec;
        const btn = document.createElement("button");
        btn.type = "button"; btn.className = "insp-action" + (this._gradMode ? " active" : "");
        btn.textContent = this._gradMode && this._gradTarget === which ? "Done" : "Edit on canvas";
        btn.title = "Drag the on-canvas handles to set the gradient's direction / extent";
        btn.addEventListener("click", () => this.enterGradientEdit(which));
        const label = `${spec.type === "radial" ? "Radial" : "Linear"} · ${spec.stops.length} stops`;
        wrap.appendChild(inspGroup("Gradient", [inspRow(label, btn)]));
      }
    }
    // Masks (M.4): a single clipped/masked group → Release; ≥2 objects with a vector on top
    //  → offer Make clipping mask / Make opacity mask (the top object becomes the mask).
    if (nodes.length === 1 && (this._clipGroupOf(nodes[0]) === nodes[0] || this._maskGroupOf(nodes[0]) === nodes[0])) {
      const clipped = this._clipGroupOf(nodes[0]) === nodes[0];
      const rel = document.createElement("button");
      rel.type = "button"; rel.className = "insp-action"; rel.textContent = "Release";
      rel.title = "Release the mask — the masking shape returns as a normal object";
      rel.addEventListener("click", () => this.releaseMask());
      wrap.appendChild(inspGroup(clipped ? "Clipping mask" : "Opacity mask", [inspRow(clipped ? "Clips its contents" : "Luminance modulates alpha", rel)]));
    } else if (this._topSelection(nodes).filter((n) => n.hasAttribute && n.hasAttribute("data-hv-id")).length >= 2) {
      const top = this._topSelection(nodes);
      const all = [...this.stage.querySelectorAll("[data-hv-id]")];
      top.sort((a, b) => all.indexOf(a) - all.indexOf(b));
      const front = top[top.length - 1];
      const rows = [];
      const clipBtn = document.createElement("button");
      clipBtn.type = "button"; clipBtn.className = "insp-action"; clipBtn.textContent = "Make clipping mask";
      clipBtn.title = "Clip the lower objects to the top object's shape";
      clipBtn.disabled = this.isRaster(front);
      clipBtn.addEventListener("click", () => this.makeClipMask());
      rows.push(inspRow("Clip", clipBtn));
      const maskBtn = document.createElement("button");
      maskBtn.type = "button"; maskBtn.className = "insp-action"; maskBtn.textContent = "Make opacity mask";
      maskBtn.title = "Use the top object's luminance as an opacity mask for the rest";
      maskBtn.addEventListener("click", () => this.makeOpacityMask());
      rows.push(inspRow("Opacity", maskBtn));
      wrap.appendChild(inspGroup("Mask", rows));
    }
    // Expand & Pathfinder (Epic X): contextual path ops. Outline-stroke when any selected
    //  leaf carries a paintable stroke; Offset-path on any fillable vector; Pathfinder Divide
    //  on a 2+ overlap. (Live actions; the offset amount prompts via the numeric row.)
    if (!isRaster) {
      // Expand / Outline / Offset / Pathfinder moved to the Actions menu (_objectActions).
      // Width (Epic W): a selected width-stroke group gets its uniform-width scrub + Uniform
      //  reset + Release + Expand. ("Vary width" — making one — is in the Actions menu.)
      const wsGroup = nodes.length === 1 ? this._wsGroupOf(nodes[0]) : null;
      if (wsGroup) {
        const spec = this._wsSpec(wsGroup); const wrows = [];
        wrows.push(numRow("Width", Math.round((spec.w || 0) * 100) / 100, 0.25, 1,
          (v) => { this.beginCoalesce(); this.setWidthBase(wsGroup, Math.max(0.25, v)); }, null,
          () => { this.commitCoalesce("Width"); this._renderSelection(); this._mountWidthHandles(); }));
        const uni = document.createElement("button"); uni.type = "button"; uni.className = "insp-action"; uni.textContent = "Uniform";
        uni.title = "Reset to a constant width"; uni.addEventListener("click", () => this.resetWidthUniform(wsGroup));
        const rel = document.createElement("button"); rel.type = "button"; rel.className = "insp-action"; rel.textContent = "Release";
        rel.title = "Back to a normal stroked path"; rel.addEventListener("click", () => this.releaseWidthStroke(wsGroup));
        const exp = document.createElement("button"); exp.type = "button"; exp.className = "insp-action"; exp.textContent = "Expand";
        exp.title = "Bake into plain filled paths"; exp.addEventListener("click", () => this.expandWidthStroke(wsGroup));
        wrows.push(inspRow("", uni)); wrows.push(inspRow("", rel)); wrows.push(inspRow("", exp));
        wrap.appendChild(inspGroup("Width", wrows));
      }   // "Vary width" (make) moved to the Actions menu (_objectActions)
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
    // EFFECTS (Epic E): live drop shadow / blur / glow via an SVG <filter> stack. The detailed
    //  per-effect editor shows for a single object; a multi-selection just gets the add buttons.
    if (!isRaster && nodes.length >= 1) wrap.appendChild(inspGroup("Effects", this._effectsPanel(nodes)));
    // BLEND (Epic L). A selected blend group gets steps + reverse + Expand. ("Make blend" — from
    //  exactly 2 fillable shapes — is in the Actions menu, also Ctrl/Cmd+Alt+B.)
    if (nodes.length === 1 && this.isBlendGroup(nodes[0])) {
      const g = nodes[0], spec = this._blendSpec(g), brows = [];
      brows.push(numRow("Steps", spec.steps || 6, 1, 1,
        (v) => { this.beginCoalesce(); this.setBlendParam(g, "steps", Math.max(1, Math.min(60, Math.round(v)))); }, null,
        () => { this.commitCoalesce("Blend steps"); this._renderInspector(); }));
      brows.push(checkRow("Reverse", !!spec.reverse, (v) => this.setBlendParam(g, "reverse", v)));
      const bx = document.createElement("button"); bx.type = "button"; bx.className = "insp-action"; bx.textContent = "Expand";
      bx.title = "Bake the blend into a plain group"; bx.addEventListener("click", () => this.expandBlend(g));
      brows.push(inspRow("", bx));
      wrap.appendChild(inspGroup("Blend", brows));
    }   // "Make blend" moved to the Actions menu (_objectActions)
    // COLOUR SYSTEMS (Epic C). Pattern fill: a selected pattern-filled object gets tile
    //  scale/rotate; 2+ objects get "Pattern fill" (top = tile). Recolor: a selection with 2+
    //  distinct solid colours gets a swatch remap grid + Hue/Sat/Light shift.
    if (!isRaster) {
      const pat = nodes.length === 1 ? this._patternOf(nodes[0]) : null;
      if (pat) wrap.appendChild(inspGroup("Pattern", this._patternPanel(nodes[0], pat)));
      // "Pattern fill" (make) moved to the Actions menu (_objectActions)
      const colours = this._harvestColors(nodes);
      if (colours.size >= 2) wrap.appendChild(inspGroup("Recolor", this._recolorPanel(colours)));
    }
    // SYMBOLS (Epic Y). A selected instance gets Edit-master + Break-link; other artwork gets
    //  "Make symbol" (a reusable <symbol>/<use> — duplicate an instance to place more).
    if (nodes.length === 1 && this.isSymbolInstance(nodes[0])) {
      const u = nodes[0];
      const ed = document.createElement("button"); ed.type = "button"; ed.className = "insp-action"; ed.textContent = "Edit master";
      ed.title = "Edit the symbol — changes apply to every instance (double-click also works)"; ed.addEventListener("click", () => this.editSymbol(u));
      const bl = document.createElement("button"); bl.type = "button"; bl.className = "insp-action"; bl.textContent = "Break link";
      bl.title = "Make this instance an independent copy"; bl.addEventListener("click", () => this.breakSymbolLink(u));
      wrap.appendChild(inspGroup("Symbol", [inspRow("", ed), inspRow("", bl)]));
    }   // "Make symbol" moved to the Actions menu (_objectActions)
    // TRANSFORMS+ / REPEAT (Epic T). A selected repeat group gets its param editor + Expand;
    //  any selection gets reflect / shear / transform-again + the repeat generators.
    if (nodes.length === 1 && this.isRepeatGroup(nodes[0])) {
      wrap.appendChild(inspGroup("Repeat", this._repeatPanel(nodes[0])));
    }   // Reflect / Shear / Transform-again / Repeat moved to the Actions menu (_objectActions)
    // PROCESS — a single raster gets the pipeline stages (upscale / remove-bg /
    // vectorize) inline. app.js owns the jobs + live trace, so it's injected via a
    // hook; the editor stays vector-pure and just hosts the returned DOM.
    if (isRaster && nodes.length === 1 && typeof this.rasterTools === "function") {
      const tools = this.rasterTools(reads[0]);
      if (tools) wrap.appendChild(tools);
    }
    return wrap;
  },
  // Effects panel (E.3): add-buttons + a live editor per stacked effect (single selection).
  _effectsPanel(nodes) {
    const rows = [];
    rows.push(inspBtnRow("Add", [
      { glyph: "▥", title: "Drop shadow", onClick: () => this.addEffect("shadow") },
      { glyph: "◌", title: "Blur", onClick: () => this.addEffect("blur") },
      { glyph: "✶", title: "Glow", onClick: () => this.addEffect("glow") },
    ]));
    if (nodes.length !== 1) {
      const fxAny = nodes.some((n) => this.effectsOf(n).length);
      if (fxAny) rows.push(inspRow("", Object.assign(document.createElement("span"), { className: "insp-note", textContent: "Select one object to edit its effects." })));
      return rows;
    }
    const n = nodes[0];
    const fx = this.effectsOf(n);
    const FXL = { blur: "Blur", shadow: "Drop shadow", glow: "Glow" };
    const liveNum = (label, val, min, step, key, i) => numRow(label, val, min, step,
      (v) => { this.beginCoalesce(); this.updateEffect(n, i, { [key]: v }); }, null,
      () => { this.commitCoalesce("Effect"); });
    const colorRow = (val, i) => {
      const inp = document.createElement("input"); inp.type = "color"; inp.value = (val || "#000000").slice(0, 7); inp.className = "insp-color";
      inp.addEventListener("input", () => { this.beginCoalesce(); this.updateEffect(n, i, { color: inp.value }); });
      inp.addEventListener("change", () => this.commitCoalesce("Effect colour"));
      return inspRow("Colour", inp);
    };
    fx.forEach((e, i) => {
      const rm = document.createElement("button");
      rm.type = "button"; rm.className = "insp-iconbtn"; rm.textContent = "✕"; rm.title = "Remove effect";
      rm.addEventListener("click", () => this.removeEffect(n, i));
      const head = inspRow(FXL[e.type] || "Effect", rm); head.classList.add("insp-fx-head"); rows.push(head);
      if (e.type === "blur") rows.push(liveNum("Amount", e.amount, 0, 0.5, "amount", i));
      else {
        if (e.type === "shadow") rows.push(numPairRow(
          ["X", e.dx, null, 1, (v) => { this.beginCoalesce(); this.updateEffect(n, i, { dx: v }); }, null, () => this.commitCoalesce("Effect")],
          ["Y", e.dy, null, 1, (v) => { this.beginCoalesce(); this.updateEffect(n, i, { dy: v }); }, null, () => this.commitCoalesce("Effect")]));
        rows.push(liveNum("Blur", e.blur, 0, 0.5, "blur", i));
        rows.push(this._sliderRow("Opacity", e.opacity == null ? 0.5 : e.opacity, (v) => { this.beginCoalesce(); this.updateEffect(n, i, { opacity: v }); }, () => this.commitCoalesce("Effect")));
        rows.push(colorRow(e.color, i));
      }
    });
    return rows;
  },
  // Shear prompt (one-shot; live re-shear would compound). (T.2)
  _promptShear() {
    const raw = (typeof window !== "undefined" && window.prompt) ? window.prompt("Shear angle in degrees (horizontal):", String(this._lastShear || 15)) : null;
    if (raw == null) return;
    const a = parseFloat(raw);
    if (!isFinite(a)) { setStatus("Enter a number of degrees.", 2500); return; }
    this._lastShear = a; this.shearSelection(a, 0);
  },
  // Pattern-fill tile editor (Epic C): scale + rotate the tile via patternTransform.
  _patternPanel(n, pat) {
    const x = this._patternXform(pat);
    return [
      numRow("Scale", Math.round((x.scale || 1) * 100) / 100, 0.05, 0.1,
        (v) => { this.beginCoalesce(); this.setPatternParam(n, "scale", Math.max(0.05, v)); }, null,
        () => { this.commitCoalesce("Pattern scale"); }),
      numRow("Rotate", Math.round(x.rotate || 0), null, 1,
        (v) => { this.beginCoalesce(); this.setPatternParam(n, "rotate", v); }, null,
        () => { this.commitCoalesce("Pattern rotate"); }),
    ];
  },
  // Recolor Artwork (Epic C): a swatch grid (click → remap that exact colour via the picker)
  //  + Hue/Sat/Light shift over every harvested colour (coalesced, absolute from a base snapshot).
  _recolorPanel(colours) {
    const rows = [], grid = document.createElement("div"); grid.className = "insp-recolor-grid";
    for (const [hex, list] of colours) {
      const sw = document.createElement("button"); sw.type = "button"; sw.className = "insp-recolor-sw";
      sw.style.background = hex; sw.title = `${hex} — click to remap (${list.length})`;
      sw.addEventListener("click", () => {
        const targets = this._harvestColors(this.selectedNodes()).get(hex) || []; if (!targets.length) return;
        this._recolorEditViaPanel(hex, targets);
      });
      grid.appendChild(sw);
    }
    rows.push(inspRow("Colours", grid));
    const shift = (label, kind) => numRow(label, 0, null, 1,
      (v) => { this.beginCoalesce(); this.recolorShift(kind === "h" ? v : 0, kind === "s" ? v : 0, kind === "l" ? v : 0); }, null,
      () => { this.commitCoalesce("Recolor"); this._recolorClearBase(); this._renderInspector(); });
    rows.push(shift("Hue", "h")); rows.push(shift("Sat", "s")); rows.push(shift("Light", "l"));
    return rows;
  },
  // Repeat-group param editor (E.3-style live rows). (T.6)
  _repeatPanel(g) {
    const p = this.repeatParamsOf(g);
    const rows = [];
    const num = (label, key, val, min, step) => numRow(label, val, min, step,
      (v) => { this.beginCoalesce(); this.setRepeatParam(g, key, v); }, null,
      () => { this.commitCoalesce("Repeat"); this._renderInspector(); });
    if (p.kind === "grid") {
      rows.push(numPairRow(
        ["Rows", p.rows || 3, 1, 1, (v) => { this.beginCoalesce(); this.setRepeatParam(g, "rows", Math.round(v)); }, null, () => { this.commitCoalesce("Repeat"); this._renderInspector(); }],
        ["Cols", p.cols || 3, 1, 1, (v) => { this.beginCoalesce(); this.setRepeatParam(g, "cols", Math.round(v)); }, null, () => { this.commitCoalesce("Repeat"); this._renderInspector(); }]));
      const ub = this._nodeBBoxUser([...g.children].find((c) => c.getAttribute("data-hv-repeat-unit")));
      rows.push(numPairRow(
        ["DX", p.dx != null ? p.dx : Math.round((ub.x1 - ub.x0) * 1.15), null, 1, (v) => { this.beginCoalesce(); this.setRepeatParam(g, "dx", v); }, null, () => this.commitCoalesce("Repeat")],
        ["DY", p.dy != null ? p.dy : Math.round((ub.y1 - ub.y0) * 1.15), null, 1, (v) => { this.beginCoalesce(); this.setRepeatParam(g, "dy", v); }, null, () => this.commitCoalesce("Repeat")]));
    } else if (p.kind === "radial") {
      rows.push(num("Count", "count", p.count || 6, 2, 1));
      const ub = this._nodeBBoxUser([...g.children].find((c) => c.getAttribute("data-hv-repeat-unit")));
      rows.push(num("Radius", "radius", p.radius != null ? p.radius : Math.round(Math.max(ub.x1 - ub.x0, ub.y1 - ub.y0) * 1.5), 0, 1));
    } else if (p.kind === "mirror") {
      const ub = this._nodeBBoxUser([...g.children].find((c) => c.getAttribute("data-hv-repeat-unit")));
      rows.push(num("Gap", "gap", p.gap != null ? p.gap : Math.round((ub.x1 - ub.x0) * 0.15), null, 1));
    }
    const ex = document.createElement("button");
    ex.type = "button"; ex.className = "insp-action"; ex.textContent = "Expand";
    ex.title = "Bake the repeat into a plain group";
    ex.addEventListener("click", () => this.expandRepeat(g));
    rows.push(inspRow(`${(p.kind || "repeat")}`, ex));
    return rows;
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

    // ARTBOARDS (Epic A): list every artboard with fit / export / rename / delete + Add.
    const abRows = [];
    for (const a of this.allArtboards()) {
      const row = document.createElement("div"); row.className = "insp-row insp-ab-row";
      if (a.primary) { const lab = document.createElement("span"); lab.className = "insp-ab-name"; lab.textContent = a.name; row.appendChild(lab); }
      else {
        const nm = document.createElement("input"); nm.type = "text"; nm.className = "insp-ab-name"; nm.value = a.name;
        nm.addEventListener("change", () => this.renameArtboard(a.index, nm.value));
        row.appendChild(nm);
      }
      const btns = document.createElement("div"); btns.className = "insp-btns";
      const mk = (glyph, title, fn) => { const b = document.createElement("button"); b.type = "button"; b.className = "insp-iconbtn"; b.textContent = glyph; b.title = title; b.addEventListener("click", fn); btns.appendChild(b); };
      mk("⊕", "Fit this artboard in view", () => this.fitToArtboard(a));
      mk("⤓", "Export this artboard as SVG", () => this.exportArtboardSVG(a, a.name));
      if (!a.primary) mk("✕", "Delete artboard", () => this.deleteArtboard(a.index));
      row.appendChild(btns); abRows.push(row);
    }
    const addBtn = document.createElement("button"); addBtn.type = "button"; addBtn.className = "insp-action"; addBtn.textContent = "Add artboard";
    addBtn.addEventListener("click", () => this.addArtboard());
    abRows.push(inspRow("", addBtn));
    wrap.appendChild(inspGroup("Artboards", abRows));
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

// Mix the undo/redo + History-panel methods into the editor (extracted to keep this
// file focused). They run with `this === editor`, so behaviour is identical to inline.
Object.assign(editor, historyMixin, layersMixin, penMixin, curvatureMixin, marqueeMixin, nodeMixin, transformMixin, textMixin, textStylesMixin, masksMixin, expandMixin, widthMixin, builderMixin, blendMixin, colorsMixin, isolationMixin, symbolsMixin, effectsMixin, repeatMixin, artboardsMixin);
// (pointInPoly moved into editor/tools/marquee.js — its only consumer)
// (snap45/snapDelta/snapPoint extracted -> editor/snap.js)

export { editor, ghostBtn };
