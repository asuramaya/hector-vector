// Node tool (#31): direct anchor/handle editing — mount the LOD/viewport-culled handle
// set over a path (so a 10k-anchor traced path stays editable, not refused), drag anchors
// and bezier direction handles, marquee-aware anchor selection, alt-toggle smooth/corner,
// insert/delete/join anchors, and per-anchor type changes. The biggest tool. Object.assign
// MIXIN — every method runs with `this === editor`, so it reaches the editor's state
// (this._nodeSel / this._nodeEls / this.stage) and the methods that stayed on editor
// (this.selectedNodes / this.unmountNodeHandles / this._overlayEl / this._bakeArtTransforms /
// this._renderSelection) by identity. Only module-level helpers are imported.
import {
  SVG_NS, MAX_HANDLES, nfmt, penPathD, penAnchorsToD, pathToAnchors, pathNodes, collectAnchors,
  nearestOnPaths, shapeWasEdited, freezeShape, subOf, rebuildSubs,
} from "../../hv/index.js";
import { setStatus } from "../../app.js";
import { snap45 } from "../snap.js";

export const nodeMixin = {
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
    const { anchors, subs, editable } = pathToAnchors(nd.el);
    if (!editable || nd.k >= anchors.length) return;
    const a = anchors[nd.k];
    if (!a.in && !a.out) return;        // already a corner
    this.push("Corner");
    a.in = null; a.out = null;
    nd.el.setAttribute("d", penAnchorsToD(anchors, subs));
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
          nd.el.setAttribute("d", penAnchorsToD(conv.anchors, conv.subs));
          return;
        }
        let dx = p.x - sp.x, dy = p.y - sp.y, gx = null, gy = null;
        if (ev.shiftKey) { if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0; }   // lock to the H/V axis
        else {
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
      // Regroup the survivors by subpath: a compound path keeps its OTHER subpaths intact even
      // when one is gutted (rebuildSubs drops any subpath left with <2 anchors). (#20)
      const rb = rebuildSubs(pa.anchors, pa.subs);
      if (rb.anchors.length < 2) { el.remove(); continue; }
      el.setAttribute("d", penAnchorsToD(rb.anchors, rb.subs));
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
      if (pa.subs.length > 1) { setStatus("Join isn't supported on compound (multi-subpath) paths.", 3200); return false; }
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
    if (paA.subs.length > 1 || paB.subs.length > 1) { setStatus("Join isn't supported on compound (multi-subpath) paths.", 3200); return false; }
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
      for (const k of ks) {
        if (k < 0 || k >= pa.anchors.length) continue;
        const A = pa.anchors[k];
        if (type === "corner") { A.in = null; A.out = null; continue; }
        // prev/next neighbours WITHIN A's subpath (so a smooth never reaches across a
        // subpath boundary on a compound path). (#20)
        const sb = subOf(pa.anchors, pa.subs, k), rel = k - sb.start;
        const P = sb.closed ? pa.anchors[sb.start + (rel - 1 + sb.count) % sb.count] : (rel > 0 ? pa.anchors[k - 1] : null);
        const N = sb.closed ? pa.anchors[sb.start + (rel + 1) % sb.count] : (rel < sb.count - 1 ? pa.anchors[k + 1] : null);
        let dx, dy;
        if (P && N) { dx = N.x - P.x; dy = N.y - P.y; }
        else if (N) { dx = N.x - A.x; dy = N.y - A.y; }
        else if (P) { dx = A.x - P.x; dy = A.y - P.y; }
        else continue;
        const len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
        A.out = N ? { x: A.x + ux * Math.hypot(N.x - A.x, N.y - A.y) * f, y: A.y + uy * Math.hypot(N.x - A.x, N.y - A.y) * f } : null;
        A.in = P ? { x: A.x - ux * Math.hypot(A.x - P.x, A.y - P.y) * f, y: A.y - uy * Math.hypot(A.x - P.x, A.y - P.y) * f } : null;
      }
      el.setAttribute("d", penAnchorsToD(pa.anchors, pa.subs));
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
};
