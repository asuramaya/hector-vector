// Multiple artboards (Epic A). ADDITIVE + low-risk: the single-artboard path is untouched
// (no extras → viewBox == primary, exactly as before). Extra named artboards expand the canvas
// viewBox to the union so nothing clips; the primary artboard ("Artboard 1") keeps its own
// geometry. Frames render in a chrome layer g.hv-ablayer (stripped on serialize/export like the
// guides layer), and the artboard rects persist in a <metadata id="hv-artboards"> JSON element
// (SKIP_TAGS → survives serialize, invisible to export). Back-compat: a doc with no metadata is
// one artboard = the viewBox. Object.assign MIXIN — `this === editor`.
import { SVG_NS, nfmt } from "../../hv/index.js";
import { setStatus, viewports, measureFit, frameRect } from "../../app.js";

export const artboardsMixin = {
  _primaryRect() {
    const ab = this.artboardEl(); const vb = this.stage.viewBox.baseVal;
    if (!ab) return { x: vb.x, y: vb.y, w: vb.width, h: vb.height };
    return { x: parseFloat(ab.getAttribute("x")) || 0, y: parseFloat(ab.getAttribute("y")) || 0, w: parseFloat(ab.getAttribute("width")) || vb.width, h: parseFloat(ab.getAttribute("height")) || vb.height };
  },
  // primary ("Artboard 1") + the extras, each with its rect + index (extras only) for the panel.
  allArtboards() {
    const list = [{ name: "Artboard 1", ...this._primaryRect(), primary: true }];
    (this.artboards || []).forEach((a, i) => list.push({ ...a, index: i }));
    return list;
  },
  // The frontmost (highest-index — last added, drawn last) EXTRA artboard whose rect contains
  // (x,y) in user space, or -1. Used by the select tool's blank-click dispatch (K.3) — the
  // primary artboard has no index of its own here, so a click outside every extra's bounds
  // falls through to the existing "select the artboard" (primary) behaviour, unchanged.
  _artboardAt(x, y) {
    if (!this.artboards) return -1;
    for (let i = this.artboards.length - 1; i >= 0; i--) {
      const a = this.artboards[i];
      if (x >= a.x && x <= a.x + a.w && y >= a.y && y <= a.y + a.h) return i;
    }
    return -1;
  },
  _loadArtboards(svg) {
    this.artboards = [];
    this._abSel = null;   // indices are about to be rebuilt from scratch — any old selection is stale
    const meta = svg.querySelector("metadata#hv-artboards");
    if (!meta) return;   // back-compat: single artboard
    try {
      const data = JSON.parse(meta.textContent || "{}");
      if (data.primary) {   // restore the primary's own geometry (serialize had grown the viewBox to the union)
        const ab = svg.querySelector("rect.hv-artboard");
        if (ab) { ab.setAttribute("x", nfmt(data.primary.x)); ab.setAttribute("y", nfmt(data.primary.y)); ab.setAttribute("width", nfmt(data.primary.w)); ab.setAttribute("height", nfmt(data.primary.h)); }
      }
      this.artboards = Array.isArray(data.extras) ? data.extras : [];
    } catch {}
  },
  _syncArtboardMeta() {
    let meta = this.stage.querySelector("metadata#hv-artboards");
    if (!this.artboards || !this.artboards.length) { if (meta) meta.remove(); return; }
    if (!meta) { meta = document.createElementNS(SVG_NS, "metadata"); meta.setAttribute("id", "hv-artboards"); this.stage.insertBefore(meta, this.stage.firstChild); }
    meta.textContent = JSON.stringify({ primary: this._primaryRect(), extras: this.artboards });
  },
  _abLayer() {
    let g = this.stage.querySelector("g.hv-ablayer");
    if (!g) { g = document.createElementNS(SVG_NS, "g"); g.setAttribute("class", "hv-ablayer"); this.stage.insertBefore(g, this._overlayEl() || null); }
    return g;
  },
  _renderArtboards() {
    if (!this.stage) return;
    const existing = this.stage.querySelector("g.hv-ablayer");
    if (!this.artboards || !this.artboards.length) { if (existing) existing.remove(); return; }
    const g = this._abLayer(); g.innerHTML = "";
    this.stage.insertBefore(g, this._overlayEl() || null);   // keep above artwork, below the overlay
    this.artboards.forEach((a, i) => {
      const sel = this.artboardSelected && this._abSel === i;
      const r = document.createElementNS(SVG_NS, "rect"); r.setAttribute("class", "hv-abframe" + (sel ? " selected" : ""));
      r.setAttribute("x", nfmt(a.x)); r.setAttribute("y", nfmt(a.y)); r.setAttribute("width", nfmt(a.w)); r.setAttribute("height", nfmt(a.h));
      g.appendChild(r);
      const t = document.createElementNS(SVG_NS, "text"); t.setAttribute("class", "hv-ablabel");
      t.setAttribute("x", nfmt(a.x)); t.setAttribute("y", nfmt(a.y - 4)); t.textContent = a.name || "Artboard";
      g.appendChild(t);
    });
  },
  // Grow the canvas viewBox to the union of every artboard, redraw frames, persist, refit.
  _reflowCanvas() {
    if (!this.stage) return;
    const pr = this._primaryRect();
    let x0 = pr.x, y0 = pr.y, x1 = pr.x + pr.w, y1 = pr.y + pr.h;
    for (const a of (this.artboards || [])) { x0 = Math.min(x0, a.x); y0 = Math.min(y0, a.y); x1 = Math.max(x1, a.x + a.w); y1 = Math.max(y1, a.y + a.h); }
    const W = x1 - x0, H = y1 - y0;
    this.stage.setAttribute("viewBox", `${nfmt(x0)} ${nfmt(y0)} ${nfmt(W)} ${nfmt(H)}`);
    this.stage.setAttribute("width", nfmt(W)); this.stage.setAttribute("height", nfmt(H));
    this._renderArtboards();
    this._syncArtboardMeta();
    try { measureFit(viewports.output); } catch {}
  },
  addArtboard(opts = {}) {
    if (!this.stage) return;
    this.artboards = this.artboards || [];
    this.push("Add artboard");
    const pr = this._primaryRect();
    const all = [pr, ...this.artboards];
    const maxX = Math.max(...all.map((a) => a.x + a.w));
    const w = opts.w || pr.w, h = opts.h || pr.h, gap = pr.w * 0.08;
    this.artboards.push({ name: opts.name || `Artboard ${this.artboards.length + 2}`, x: maxX + gap, y: pr.y, w, h });
    this._reflowCanvas(); this._renderInspector();
    setStatus(`Added artboard (${this.artboards.length + 1} total).`, 1800);
    return this.artboards.length - 1;
  },
  // On-canvas artboard tool (Epic K.3): drag to create a new artboard at exactly that
  // position and size — the panel's "Add artboard" button can only auto-place a
  // default-sized one beside the rest. Mirrors the shape tools' click-vs-drag contract
  // (_beginDraw in editor.js, text.js's _textDown): a bare click makes nothing, same as
  // dragging out a rectangle; only a real drag commits. A live dashed preview rect lives
  // in the overlay layer while dragging, same idea as the text tool's box-preview.
  // Moving/resizing an EXISTING artboard on-canvas is _mountArtboardHandles/_bindArtboardMove/
  // _bindArtboardResize below — this handler only covers the CREATE-by-drag gesture.
  _artboardDown(e) {
    if (e.button !== 0 || !this.stage) return;
    e.stopPropagation(); e.preventDefault();
    const inv = () => this.stageCTM().inverse();
    const start = new DOMPoint(e.clientX, e.clientY).matrixTransform(inv());
    const ov = this._overlayEl();
    let box = null;
    const move = (ev) => {
      const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(inv());
      const x = Math.min(start.x, p.x), y = Math.min(start.y, p.y);
      const w = Math.abs(p.x - start.x), h = Math.abs(p.y - start.y);
      if (!box && (w > 3 || h > 3) && ov) { box = document.createElementNS(SVG_NS, "rect"); box.setAttribute("class", "hv-artboard-preview"); box.setAttribute("fill", "none"); ov.appendChild(box); }
      if (box) { box.setAttribute("x", nfmt(x)); box.setAttribute("y", nfmt(y)); box.setAttribute("width", nfmt(w)); box.setAttribute("height", nfmt(h)); }
    };
    const up = (ev) => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      if (box) box.remove();
      const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(inv());
      const x = Math.min(start.x, p.x), y = Math.min(start.y, p.y);
      const w = Math.abs(p.x - start.x), h = Math.abs(p.y - start.y);
      if (w < 8 || h < 8) return;   // a bare click/tiny drag makes nothing
      const idx = this.addArtboard({ w, h });   // pushes its own undo step
      this.artboards[idx].x = x; this.artboards[idx].y = y;   // place it exactly as drawn
      this._reflowCanvas();
      this.selection = new Set(); this.artboardSelected = true; this._abSel = idx;
      this._renderSelection(); this._renderInspector();
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  },
  renameArtboard(i, name) { if (!this.artboards || !this.artboards[i]) return; this.push("Rename artboard"); this.artboards[i].name = name || `Artboard ${i + 2}`; this._reflowCanvas(); },
  resizeArtboard(i, w, h) { if (!this.artboards || !this.artboards[i]) return; if (!this._coalescing) this.push("Resize artboard"); if (w > 0) this.artboards[i].w = w; if (h > 0) this.artboards[i].h = h; this._reflowCanvas(); },
  moveArtboard(i, x, y) { if (!this.artboards || !this.artboards[i]) return; if (!this._coalescing) this.push("Move artboard"); if (x != null) this.artboards[i].x = x; if (y != null) this.artboards[i].y = y; this._reflowCanvas(); },
  deleteArtboard(i) {
    if (!this.artboards || !this.artboards[i]) return;
    this.push("Delete artboard"); this.artboards.splice(i, 1);
    if (this._abSel === i) { this._abSel = null; this.artboardSelected = false; }
    else if (this._abSel != null && this._abSel > i) this._abSel--;   // later indices shift down
    this._reflowCanvas(); this._renderInspector();
    setStatus("Artboard removed.", 1500);
  },
  // On-canvas move/resize handles for an EXISTING extra artboard (Epic K.3 — deliberately
  // scoped to extras only; the primary artboard keeps its existing panel-only Width/Height
  // fields, since moving/resizing IT would shift the whole document's coordinate origin, a
  // much bigger change nothing here asks for). Mirrors transform.js's _mountTransformHandles
  // (8 corner/edge handles) but drives resizeArtboard/moveArtboard directly instead of baking
  // a matrix — an artboard is just {x,y,w,h} metadata, not a graphical node.
  _mountArtboardHandles() {
    this.unmountArtboardHandles();
    const ov = this._overlayEl(); if (!ov || !this.stage || this._abSel == null) return;
    const i = this._abSel, a = this.artboards && this.artboards[i]; if (!a) return;
    const m = this.stageCTM(); const k = m ? Math.hypot(m.a, m.b) || 1 : 1;
    const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
    const r = (coarse ? 8 : 4.5) / k;
    const g = document.createElementNS(SVG_NS, "g"); g.setAttribute("class", "hv-ab-xform");
    // A wide invisible stroke along the frame's own perimeter — drag it to MOVE. The interior
    // stays click-through to real artwork (fill:none); only the border itself is a move target,
    // so marquee-selecting objects inside an artboard is completely unaffected by this.
    const moveHit = document.createElementNS(SVG_NS, "rect"); moveHit.setAttribute("class", "hv-ab-movehit");
    moveHit.style.strokeWidth = nfmt((coarse ? 22 : 14) / k);
    this._bindArtboardMove(moveHit, i);
    g.appendChild(moveHit);
    const HS = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
    const SX = { nw: -1, n: 0, ne: 1, e: 1, se: 1, s: 0, sw: -1, w: -1 };
    const SY = { nw: -1, n: -1, ne: -1, e: 0, se: 1, s: 1, sw: 1, w: 0 };
    const handles = {};
    for (const h of HS) {
      const c = document.createElementNS(SVG_NS, "rect"); c.setAttribute("class", "hv-ab-handle hv-ab-" + h);
      this._bindArtboardResize(c, i, { sx: SX[h], sy: SY[h] });
      g.appendChild(c);
      handles[h] = c;
    }
    ov.appendChild(g);
    this._abHandles = { g, moveHit, handles, r };
    this._layoutArtboardHandles(a);
  },
  // Reposition the LIVE handle elements to match an artboard rect, without touching their
  // event bindings/pointer capture — a full remount mid-drag would orphan the very element
  // the drag is happening on (the same trap transform.js's _updateXformVisual avoids).
  _layoutArtboardHandles(a) {
    const xf = this._abHandles; if (!xf) return;
    xf.moveHit.setAttribute("x", nfmt(a.x)); xf.moveHit.setAttribute("y", nfmt(a.y));
    xf.moveHit.setAttribute("width", nfmt(a.w)); xf.moveHit.setAttribute("height", nfmt(a.h));
    const midX = a.x + a.w / 2, midY = a.y + a.h / 2, r = xf.r;
    const pos = {
      nw: [a.x, a.y], n: [midX, a.y], ne: [a.x + a.w, a.y], e: [a.x + a.w, midY],
      se: [a.x + a.w, a.y + a.h], s: [midX, a.y + a.h], sw: [a.x, a.y + a.h], w: [a.x, midY],
    };
    for (const h in pos) {
      const [x, y] = pos[h], c = xf.handles[h];
      c.setAttribute("x", nfmt(x - r)); c.setAttribute("y", nfmt(y - r));
      c.setAttribute("width", nfmt(2 * r)); c.setAttribute("height", nfmt(2 * r));
    }
  },
  unmountArtboardHandles() {
    const ov = this._overlayEl(); if (ov) ov.querySelectorAll(".hv-ab-xform").forEach((g) => g.remove());
    this._abHandles = null;
  },
  _bindArtboardMove(hit, i) {
    hit.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !this.artboards || !this.artboards[i]) return;
      e.stopPropagation(); e.preventDefault();
      try { hit.setPointerCapture(e.pointerId); } catch {}
      const a0 = this.artboards[i];
      const inv = () => this.stageCTM().inverse();
      const start = new DOMPoint(e.clientX, e.clientY).matrixTransform(inv());
      const ox = a0.x, oy = a0.y;
      this._handleDragging = true;
      let pushed = false;
      const move = (ev) => {
        const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(inv());
        if (!pushed) { this.beginCoalesce(); pushed = true; }
        this.moveArtboard(i, ox + (p.x - start.x), oy + (p.y - start.y));
        this._layoutArtboardHandles(this.artboards[i]);
      };
      const up = () => {
        try { hit.releasePointerCapture(e.pointerId); } catch {}
        this._handleDragging = false;
        hit.removeEventListener("pointermove", move); hit.removeEventListener("pointerup", up);
        if (pushed) { this.commitCoalesce("Move artboard"); this._renderInspector(); setStatus("Moved artboard.", 1200); }
      };
      hit.addEventListener("pointermove", move);
      hit.addEventListener("pointerup", up);
    });
  },
  _bindArtboardResize(c, i, spec) {
    c.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !this.artboards || !this.artboards[i]) return;
      e.stopPropagation(); e.preventDefault();
      try { c.setPointerCapture(e.pointerId); } catch {}
      const a0 = { ...this.artboards[i] };
      const inv = () => this.stageCTM().inverse();
      const MIN = 8;
      this._handleDragging = true;
      let pushed = false;
      const move = (ev) => {
        const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(inv());
        if (!pushed) { this.beginCoalesce(); pushed = true; }
        let x = a0.x, y = a0.y, w = a0.w, h = a0.h;
        if (spec.sx < 0) { const right = a0.x + a0.w; x = Math.min(p.x, right - MIN); w = right - x; }
        else if (spec.sx > 0) { w = Math.max(MIN, p.x - a0.x); }
        if (spec.sy < 0) { const bot = a0.y + a0.h; y = Math.min(p.y, bot - MIN); h = bot - y; }
        else if (spec.sy > 0) { h = Math.max(MIN, p.y - a0.y); }
        this.moveArtboard(i, x, y);
        this.resizeArtboard(i, w, h);
        this._layoutArtboardHandles(this.artboards[i]);
      };
      const up = () => {
        try { c.releasePointerCapture(e.pointerId); } catch {}
        this._handleDragging = false;
        c.removeEventListener("pointermove", move); c.removeEventListener("pointerup", up);
        if (pushed) { this.commitCoalesce("Resize artboard"); this._renderInspector(); setStatus("Resized artboard.", 1200); }
      };
      c.addEventListener("pointermove", move);
      c.addEventListener("pointerup", up);
    });
  },
  fitToArtboard(rect) { if (rect) try { frameRect(viewports.output, rect.x, rect.y, rect.w, rect.h); } catch {} },
  // Crop the current document to one artboard's region (its own viewBox, not the union canvas
  // every OTHER artboard also occupies). Shared by the SVG download below and PNG-per-artboard
  // (app.js wires editor._exportArtboardPNG through this — the client-side rasterizer lives in
  // ui/export.js, a layer above editor.js, so it can't be called from here without a cycle).
  _croppedArtboardSVG(rect) {
    if (!rect) return null;
    let svg = this.serialize();
    try {
      const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
      const root = doc.documentElement;
      root.setAttribute("viewBox", `${nfmt(rect.x)} ${nfmt(rect.y)} ${nfmt(rect.w)} ${nfmt(rect.h)}`);
      root.setAttribute("width", nfmt(rect.w)); root.setAttribute("height", nfmt(rect.h));
      svg = new XMLSerializer().serializeToString(root);
    } catch {}
    return svg;
  },
  // Export one artboard's region as a cropped SVG (downloads).
  exportArtboardSVG(rect, name) {
    if (!rect) return;
    const svg = this._croppedArtboardSVG(rect);
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = `${(name || "artboard").replace(/\s+/g, "-")}.svg`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    setStatus(`Exported ${name || "artboard"} as SVG.`, 2000);
  },
  // PNG-per-artboard (Epic K.4): a UI-layer hook, like _summonColor — app.js wires it to the
  // SAME client-side canvas rasteriser the main Export PNG modal uses (no cairosvg, no second
  // renderer), fed by _croppedArtboardSVG above. Lives one layer up (ui/export.js) so it can't
  // be reached from here without a cycle back through editor.js.
};
