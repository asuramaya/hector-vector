// Gradient mesh (Epic D.4): an RxC grid of control points, each with a COLOUR and (now) a
// POSITION, blended per-cell — colour bilinearly within a cell, position via the cell's own
// two triangles (see rasterizeMesh below). Dragging a point warps the mesh's colour field
// geometrically, not just its colour — closing the "no draggable geometry" gap this file used
// to defer. SVG still has no native mesh-gradient primitive Chromium's render/export path
// understands (<meshgradient> isn't supported), so this stays a raster: rasterize the warped,
// Gouraud-shaded triangle mesh into an <image>, clipped to the shape's own outline via a real
// <clipPath> in defs (same Epic-0 defs infra Masks (Epic M) established — _mintDefId/_defs(),
// and clipPath is already covered by _gcDefs's orphan sweep). Editing a point's colour OR
// position re-rasterizes; Expand just drops the spec, since the <image> is already final,
// ordinary SVG. Object.assign MIXIN — `this === editor`.
//
// Rasterization approach: per-pixel inverse-bilinear point-location against an arbitrarily
// warped quad is the "textbook-correct" option but is a genuinely fiddly quadratic-root-
// picking problem with real degenerate cases (parallelogram cells, self-intersecting warps).
// Splitting each cell into 2 triangles and Gouraud-shading each with the standard barycentric
// edge-function rasterizer sidesteps all of that — no roots to pick, no degenerate special
// case — at the honest cost of a visible diagonal seam at extreme drags, invisible at normal
// ones and at this grid's own coarse resolution anyway (same tradeoff Envelope's D.3 fix made
// choosing a discrete Coons blend over a true continuous patch).
import { SVG_NS, shapeToAbsPath, nfmt } from "../../hv/index.js";
import { setStatus } from "../../app.js";

export const MESH_ROWS = 4, MESH_COLS = 4;

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || "#808080");
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [128, 128, 128];
}
function restPtsGrid(bbox, rows, cols) {
  const w = bbox.x1 - bbox.x0, h = bbox.y1 - bbox.y0, pts = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) row.push({ x: bbox.x0 + (cols > 1 ? c / (cols - 1) : 0) * w, y: bbox.y0 + (rows > 1 ? r / (rows - 1) : 0) * h });
    pts.push(row);
  }
  return pts;
}
function ptsBBox(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const row of pts) for (const p of row) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
  return { x0, y0, x1, y1 };
}
// Pick a raster resolution proportional to the image's aspect ratio (a fixed 160px on the
// longer axis — plenty for a smooth blend at normal zoom, small enough to embed as a data URI).
function meshCanvasSize(bbox) {
  const w = Math.max(1, bbox.x1 - bbox.x0), h = Math.max(1, bbox.y1 - bbox.y0), long = 160;
  return { W: w >= h ? long : Math.max(8, Math.round((long * w) / h)), H: h >= w ? long : Math.max(8, Math.round((long * h) / w)) };
}
function edgeFn(ax, ay, bx, by, px, py) { return (px - ax) * (by - ay) - (py - ay) * (bx - ax); }
// Gouraud-shade one triangle (p0/p1/p2 already in canvas-PIXEL space; c0/c1/c2 are [r,g,b])
// into `data` (a W×H ImageData's pixel buffer) via the standard barycentric edge-function
// fill — see the file banner for why this, not inverse-bilinear, is the v1's technique.
function fillTriangle(data, W, H, p0, p1, p2, c0, c1, c2) {
  const minX = Math.max(0, Math.floor(Math.min(p0.x, p1.x, p2.x)));
  const maxX = Math.min(W - 1, Math.ceil(Math.max(p0.x, p1.x, p2.x)));
  const minY = Math.max(0, Math.floor(Math.min(p0.y, p1.y, p2.y)));
  const maxY = Math.min(H - 1, Math.ceil(Math.max(p0.y, p1.y, p2.y)));
  const area = edgeFn(p0.x, p0.y, p1.x, p1.y, p2.x, p2.y);
  if (Math.abs(area) < 1e-9) return;
  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      const cx = px + 0.5, cy = py + 0.5;
      const w0 = edgeFn(p1.x, p1.y, p2.x, p2.y, cx, cy) / area;
      const w1 = edgeFn(p2.x, p2.y, p0.x, p0.y, cx, cy) / area;
      const w2 = edgeFn(p0.x, p0.y, p1.x, p1.y, cx, cy) / area;
      if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
      const idx = (py * W + px) * 4;
      data[idx] = Math.round(w0 * c0[0] + w1 * c1[0] + w2 * c2[0]);
      data[idx + 1] = Math.round(w0 * c0[1] + w1 * c1[1] + w2 * c2[1]);
      data[idx + 2] = Math.round(w0 * c0[2] + w1 * c1[2] + w2 * c2[2]);
      data[idx + 3] = 255;
    }
  }
}
// Rasterize the mesh's warped, coloured grid into a data: URI (PNG) plus the real-space bbox
// it actually covers — the union of the mesh's REST bbox and wherever its points have been
// dragged to (a point dragged outside the original shape stays clipped away by the shape's
// own fixed outline, but the raster itself must still extend there or that part of the blend
// goes missing). Each cell splits into 2 triangles, (00,10,11) then (00,11,01), Gouraud-shaded.
function rasterizeMesh(spec) {
  const { rows, cols, colors, pts, bbox } = spec;
  const pb = ptsBBox(pts);
  const imgBBox = { x0: Math.min(bbox.x0, pb.x0), y0: Math.min(bbox.y0, pb.y0), x1: Math.max(bbox.x1, pb.x1), y1: Math.max(bbox.y1, pb.y1) };
  const { W, H } = meshCanvasSize(imgBBox);
  const iw = imgBBox.x1 - imgBBox.x0 || 1, ih = imgBBox.y1 - imgBBox.y0 || 1;
  const toPx = (p) => ({ x: ((p.x - imgBBox.x0) / iw) * W, y: ((p.y - imgBBox.y0) / ih) * H });
  const rgb = colors.map((row) => row.map(hexToRgb));
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(W, H);
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const p00 = toPx(pts[r][c]), p10 = toPx(pts[r][c + 1]), p01 = toPx(pts[r + 1][c]), p11 = toPx(pts[r + 1][c + 1]);
      const c00 = rgb[r][c], c10 = rgb[r][c + 1], c01 = rgb[r + 1][c], c11 = rgb[r + 1][c + 1];
      fillTriangle(img.data, W, H, p00, p10, p11, c00, c10, c11);
      fillTriangle(img.data, W, H, p00, p11, p01, c00, c11, c01);
    }
  }
  ctx.putImageData(img, 0, 0);
  return { uri: canvas.toDataURL("image/png"), bbox: imgBBox };
}

export const meshMixin = {
  isMeshGroup(n) { return !!(n && n.getAttribute && n.hasAttribute("data-hv-mesh")); },
  _meshSpec(g) { try { return JSON.parse(g.getAttribute("data-hv-mesh")); } catch { return null; } },
  _meshSet(g, spec) { g.setAttribute("data-hv-mesh", JSON.stringify(spec)); },
  _meshGroupOf(n) { if (this.isMeshGroup(n)) return n; const g = n && n.closest && n.closest("[data-hv-mesh]"); return g && this.stage && this.stage.contains(g) ? g : null; },
  _regenMesh(g) {
    const spec = this._meshSpec(g); if (!spec) return;
    const { uri, bbox } = rasterizeMesh(spec);
    [...g.children].forEach((c) => c.remove());
    const img = document.createElementNS(SVG_NS, "image");
    img.setAttribute("data-hv-id", "n" + (++this.idSeq));
    img.setAttribute("href", uri);
    img.setAttribute("x", nfmt(bbox.x0)); img.setAttribute("y", nfmt(bbox.y0));
    img.setAttribute("width", nfmt(bbox.x1 - bbox.x0)); img.setAttribute("height", nfmt(bbox.y1 - bbox.y0));
    img.setAttribute("preserveAspectRatio", "none");
    img.setAttribute("clip-path", `url(#${spec.clipId})`);
    g.appendChild(img);
  },
  // Object > Make gradient mesh: wrap ONE selected filled shape. Seeds every grid point to
  // the shape's current fill colour (a uniform mesh looks identical to a plain fill until you
  // differentiate a point) AND to an evenly-spaced position grid over its bbox — a fresh mesh
  // renders the same as before draggable geometry existed, until you actually drag something.
  makeGradientMesh() {
    if (!this.stage) return;
    const sel = this.selectedNodes();
    if (sel.length !== 1) { setStatus("Select one filled shape to add a gradient mesh.", 3000); return; }
    const n = sel[0];
    const d = shapeToAbsPath(n, n.getCTM());
    if (!d) { setStatus("This shape can't take a gradient mesh.", 3000); return; }
    const fill = n.getAttribute("fill") || "#808080";
    const fillRule = n.getAttribute("fill-rule") || null;
    this.push("Gradient mesh");
    const bbox = this._bboxUnion([n]);
    const clipId = this._mintDefId("hvclip");
    const cp = document.createElementNS(SVG_NS, "clipPath");
    cp.setAttribute("id", clipId); cp.setAttribute("clipPathUnits", "userSpaceOnUse");
    const cpath = document.createElementNS(SVG_NS, "path");
    cpath.setAttribute("d", d); if (fillRule) cpath.setAttribute("fill-rule", fillRule);
    cp.appendChild(cpath);
    this._defs().appendChild(cp);
    const colors = [];
    for (let r = 0; r < MESH_ROWS; r++) { const row = []; for (let c = 0; c < MESH_COLS; c++) row.push(fill); colors.push(row); }
    const pts = restPtsGrid(bbox, MESH_ROWS, MESH_COLS);
    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("data-hv-id", "n" + (++this.idSeq));
    this._meshSet(g, { rows: MESH_ROWS, cols: MESH_COLS, bbox, colors, pts, restPts: pts, clipId });
    n.parentNode.insertBefore(g, n); n.remove();
    this._regenMesh(g);
    this.selection = new Set([g.getAttribute("data-hv-id")]); this.artboardSelected = false;
    this.setTool("mesh");
    this._renderSelection(); this._renderInspector(); this._renderLayers();
    setStatus("Gradient mesh added — drag a point to warp it, or vary its colour in the Mesh panel.", 3200);
  },
  setMeshColor(g, row, col, hex) {
    const spec = this._meshSpec(g); if (!spec || !spec.colors[row] || spec.colors[row][col] == null) return;
    spec.colors[row][col] = hex;
    this._meshSet(g, spec); this._regenMesh(g);
  },
  setMeshPoint(g, row, col, x, y) {
    const spec = this._meshSpec(g); if (!spec || !spec.pts[row] || !spec.pts[row][col]) return;
    spec.pts[row][col] = { x, y };
    this._meshSet(g, spec); this._regenMesh(g);
  },
  resetMeshPoints(g) {
    const spec = this._meshSpec(g); if (!spec) return;
    this.push("Reset mesh points");
    spec.pts = (spec.restPts || restPtsGrid(spec.bbox, spec.rows, spec.cols)).map((row) => row.map((p) => ({ ...p })));
    this._meshSet(g, spec); this._regenMesh(g);
    this._renderSelection(); this._mountMeshHandles();
  },
  expandGradientMesh(g) {
    g = g || this.selectedNodes().map((n) => this._meshGroupOf(n)).find(Boolean);
    if (!this.isMeshGroup(g)) return;
    this.push("Expand gradient mesh");
    g.removeAttribute("data-hv-mesh");
    this._unmountMeshHandles();
    this._renderSelection(); this._renderInspector(); this._renderLayers();
    setStatus("Gradient mesh expanded to a plain clipped image.", 1800);
  },

  // ---- Mesh tool: drag a grid point (nearest-within-threshold, screen-space aware) ----
  // Deliberately mirrors envelope.js's _envDown/_mountEnvelopeHandles almost verbatim — same
  // RxC-draggable-grid interaction idiom, just driving setMeshPoint + a re-rasterize instead
  // of a live-geometry regen.
  _meshDown(e) {
    e.stopPropagation(); e.preventDefault();
    const g = this.selectedNodes().map((n) => this._meshGroupOf(n)).find(Boolean);
    if (!g) { setStatus("Select a gradient mesh (Actions ▾ → Make gradient mesh) to drag its points.", 3000); return; }
    const spec = this._meshSpec(g); if (!spec) return;
    const m = this.stageCTM(); if (!m) return;
    const inv = m.inverse();
    const toUser = (ev) => new DOMPoint(ev.clientX, ev.clientY).matrixTransform(inv);
    const k = Math.hypot(m.a, m.b) || 1;
    const p0 = toUser(e);
    let best = null, bestD = Infinity;
    for (let r = 0; r < spec.rows; r++) for (let c = 0; c < spec.cols; c++) {
      const pt = spec.pts[r][c], d = Math.hypot(pt.x - p0.x, pt.y - p0.y);
      if (d < bestD) { bestD = d; best = { r, c }; }
    }
    if (!best || bestD > 14 / k) return;
    let pushed = false;
    const move = (ev) => {
      const q = toUser(ev);
      if (!pushed) { if (Math.hypot(q.x - p0.x, q.y - p0.y) < 0.5) return; this.push("Gradient mesh"); pushed = true; }
      this.setMeshPoint(g, best.r, best.c, q.x, q.y);
      this._mountMeshHandles();
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); if (pushed) this._renderInspector(); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  },
  _unmountMeshHandles() { const ov = this._overlayEl(); if (ov) ov.querySelectorAll(".hv-meshhandles").forEach((n) => n.remove()); },
  _mountMeshHandles() {
    this._unmountMeshHandles();
    if (this.tool !== "mesh" || !this.stage) return;
    const g = this.selectedNodes().map((n) => this._meshGroupOf(n)).find(Boolean); if (!g) return;
    const spec = this._meshSpec(g); if (!spec) return;
    const ov = this._overlayEl(); if (!ov) return;
    const m = this.stageCTM(); const k = m ? Math.hypot(m.a, m.b) || 1 : 1;
    const layer = document.createElementNS(SVG_NS, "g"); layer.setAttribute("class", "hv-meshhandles");
    const line = (a, b) => { const l = document.createElementNS(SVG_NS, "line"); l.setAttribute("class", "hv-meshgridline"); l.setAttribute("x1", a.x); l.setAttribute("y1", a.y); l.setAttribute("x2", b.x); l.setAttribute("y2", b.y); return l; };
    for (let r = 0; r < spec.rows; r++) for (let c = 0; c < spec.cols; c++) {
      const p = spec.pts[r][c];
      if (c < spec.cols - 1) layer.appendChild(line(p, spec.pts[r][c + 1]));
      if (r < spec.rows - 1) layer.appendChild(line(p, spec.pts[r + 1][c]));
    }
    const rad = 4 / k;
    for (let r = 0; r < spec.rows; r++) for (let c = 0; c < spec.cols; c++) {
      const p = spec.pts[r][c];
      const h = document.createElementNS(SVG_NS, "rect"); h.setAttribute("class", "hv-meshhandle");
      h.setAttribute("x", p.x - rad); h.setAttribute("y", p.y - rad); h.setAttribute("width", 2 * rad); h.setAttribute("height", 2 * rad);
      layer.appendChild(h);
    }
    ov.appendChild(layer);
  },
};
