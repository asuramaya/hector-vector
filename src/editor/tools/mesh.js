// Gradient mesh (Epic D.4, SCOPED v1): an RxC grid of COLOUR control points blended
// bilinearly, cell by cell — the exact same multi-cell interpolation Envelope (D.2) uses
// for POSITION, applied here to colour instead. Deliberately narrowed from Illustrator's
// full mesh tool (which lets you drag mesh points AND vary colour): this ships colour-only
// over a FIXED grid — no draggable geometry — because SVG has no native mesh-gradient
// primitive Chromium's render/export path understands (<meshgradient> isn't supported), so
// there is no way to keep this a "real" vector gradient at all. The honest v1 is a raster:
// rasterize the bilinear colour field into an <image>, clipped to the shape's own outline
// via a real <clipPath> in defs (same Epic-0 defs infra Masks (Epic M) already established
// — _mintDefId/_defs(), and clipPath is already covered by _gcDefs's orphan sweep). Editing
// a point's colour re-rasterizes; Expand just drops the spec, since the <image> is already
// final, ordinary SVG. Object.assign MIXIN — `this === editor`.
import { SVG_NS, shapeToAbsPath, nfmt } from "../../hv/index.js";
import { setStatus } from "../../app.js";

export const MESH_ROWS = 4, MESH_COLS = 4;

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || "#808080");
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [128, 128, 128];
}
// Pick a raster resolution proportional to the shape's aspect ratio (a fixed 160px on the
// longer axis — plenty for a smooth blend at normal zoom, small enough to embed as a data URI).
function meshCanvasSize(bbox) {
  const w = Math.max(1, bbox.x1 - bbox.x0), h = Math.max(1, bbox.y1 - bbox.y0), long = 160;
  return { W: w >= h ? long : Math.max(8, Math.round((long * w) / h)), H: h >= w ? long : Math.max(8, Math.round((long * h) / w)) };
}
// Bilinearly blend the RxC colour grid into a W×H raster, one pixel at a time — same cell-
// selection math as envelope.js's envXY (fc/c0/tu, fr/r0/tv), just interpolating RGB instead
// of position. Returns a data: URI (PNG) ready to drop straight into an <image href>.
function rasterizeMesh(spec, W, H) {
  const { rows, cols, colors } = spec;
  const rgb = colors.map((row) => row.map(hexToRgb));
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(W, H);
  for (let py = 0; py < H; py++) {
    const v = H > 1 ? py / (H - 1) : 0;
    const fr = v * (rows - 1);
    const r0 = Math.max(0, Math.min(rows - 2, Math.floor(fr)));
    const tv = fr - r0;
    for (let px = 0; px < W; px++) {
      const u = W > 1 ? px / (W - 1) : 0;
      const fc = u * (cols - 1);
      const c0 = Math.max(0, Math.min(cols - 2, Math.floor(fc)));
      const tu = fc - c0;
      const p00 = rgb[r0][c0], p01 = rgb[r0][c0 + 1], p10 = rgb[r0 + 1][c0], p11 = rgb[r0 + 1][c0 + 1];
      const idx = (py * W + px) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const top = p00[ch] + (p01[ch] - p00[ch]) * tu, bot = p10[ch] + (p11[ch] - p10[ch]) * tu;
        img.data[idx + ch] = Math.round(top + (bot - top) * tv);
      }
      img.data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL("image/png");
}

export const meshMixin = {
  isMeshGroup(n) { return !!(n && n.getAttribute && n.hasAttribute("data-hv-mesh")); },
  _meshSpec(g) { try { return JSON.parse(g.getAttribute("data-hv-mesh")); } catch { return null; } },
  _meshSet(g, spec) { g.setAttribute("data-hv-mesh", JSON.stringify(spec)); },
  _meshGroupOf(n) { if (this.isMeshGroup(n)) return n; const g = n && n.closest && n.closest("[data-hv-mesh]"); return g && this.stage && this.stage.contains(g) ? g : null; },
  _regenMesh(g) {
    const spec = this._meshSpec(g); if (!spec) return;
    const { W, H } = meshCanvasSize(spec.bbox);
    const uri = rasterizeMesh(spec, W, H);
    [...g.children].forEach((c) => c.remove());
    const img = document.createElementNS(SVG_NS, "image");
    img.setAttribute("data-hv-id", "n" + (++this.idSeq));
    img.setAttribute("href", uri);
    img.setAttribute("x", nfmt(spec.bbox.x0)); img.setAttribute("y", nfmt(spec.bbox.y0));
    img.setAttribute("width", nfmt(spec.bbox.x1 - spec.bbox.x0)); img.setAttribute("height", nfmt(spec.bbox.y1 - spec.bbox.y0));
    img.setAttribute("preserveAspectRatio", "none");
    img.setAttribute("clip-path", `url(#${spec.clipId})`);
    g.appendChild(img);
  },
  // Object > Make gradient mesh: wrap ONE selected filled shape. Seeds every grid point to
  // the shape's current fill colour (a uniform mesh looks identical to a plain fill until
  // you differentiate a point — same "immediately useful, then you vary it" seeding as
  // makeMultiFill's 2-identical-layers start).
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
    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("data-hv-id", "n" + (++this.idSeq));
    this._meshSet(g, { rows: MESH_ROWS, cols: MESH_COLS, bbox, colors, clipId });
    n.parentNode.insertBefore(g, n); n.remove();
    this._regenMesh(g);
    this.selection = new Set([g.getAttribute("data-hv-id")]); this.artboardSelected = false;
    this._renderSelection(); this._renderInspector(); this._renderLayers();
    setStatus("Gradient mesh added — vary each point's colour in the Mesh panel.", 2800);
  },
  setMeshColor(g, row, col, hex) {
    const spec = this._meshSpec(g); if (!spec || !spec.colors[row] || spec.colors[row][col] == null) return;
    spec.colors[row][col] = hex;
    this._meshSet(g, spec); this._regenMesh(g);
  },
  expandGradientMesh(g) {
    g = g || this.selectedNodes().map((n) => this._meshGroupOf(n)).find(Boolean);
    if (!this.isMeshGroup(g)) return;
    this.push("Expand gradient mesh");
    g.removeAttribute("data-hv-mesh");
    this._renderSelection(); this._renderInspector(); this._renderLayers();
    setStatus("Gradient mesh expanded to a plain clipped image.", 1800);
  },
};
