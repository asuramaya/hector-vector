// hv core — rasterize a set of absolute path `d` strings into an alpha bitmap
// covering `bbox` (user space), giving an O(1) inside-test.
//
// Booleans / invert-space trace the boundary of a region predicate. The exact
// predicate is SVGGeometryElement.isPointInFill, but that is O(nodes × path-
// complexity) PER probe — invert-space falls back to *every* artwork layer, so on
// a traced document with hundreds of paths the marching-squares grid issues tens
// of millions of vector hit-tests and hangs the tab. Filling the union once into
// a canvas turns each probe into a single pixel lookup, independent of node count.

// `paths`: [{ d, rule }]  (rule: "evenodd" | "nonzero", default nonzero)
// `px`: target longest-side resolution (bitmap is finer than the marching grid).
export function rasterMask(paths, bbox, px = 1024) {
  const W = bbox.x1 - bbox.x0, H = bbox.y1 - bbox.y0;
  if (!(W > 0) || !(H > 0)) return { w: 0, h: 0, inside: () => false };
  const big = Math.max(W, H);
  const w = Math.max(1, Math.min(px, Math.round(px * W / big)));
  const h = Math.max(1, Math.min(px, Math.round(px * H / big)));
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  const kx = w / W, ky = h / H;
  ctx.setTransform(kx, 0, 0, ky, -bbox.x0 * kx, -bbox.y0 * ky);   // user space → pixels
  ctx.fillStyle = "#000";
  for (const p of paths) {
    if (!p || !p.d) continue;
    try { ctx.fill(new Path2D(p.d), p.rule === "evenodd" ? "evenodd" : "nonzero"); } catch {}
  }
  const data = ctx.getImageData(0, 0, w, h).data;
  return {
    w, h,
    inside(x, y) {
      const i = Math.floor((x - bbox.x0) * kx), j = Math.floor((y - bbox.y0) * ky);
      if (i < 0 || j < 0 || i >= w || j >= h) return false;
      return data[(j * w + i) * 4 + 3] > 127;   // alpha channel
    },
  };
}

// Rasterize a STROKED path into a coverage bitmap — the band the stroke paints,
// honouring width / cap / join / miter / dashes. Canvas2D's own stroker handles all
// the join/cap/dash geometry, so marching-squares over inside() traces the exact
// outline (outer + inner loops, correctly wound) that Outline-Stroke fills. The bbox
// is square-scaled (kx === ky, as in rasterMask), so the stroke width stays uniform.
// `spec`: { d, w, cap, join, miter, dash:[...] }  — w / dash are in user units.
export function rasterStroke(spec, bbox, px = 1024) {
  const W = bbox.x1 - bbox.x0, H = bbox.y1 - bbox.y0;
  if (!(W > 0) || !(H > 0) || !spec || !spec.d || !(spec.w > 0)) return { w: 0, h: 0, inside: () => false };
  const big = Math.max(W, H);
  const w = Math.max(1, Math.min(px, Math.round(px * W / big)));
  const h = Math.max(1, Math.min(px, Math.round(px * H / big)));
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  const kx = w / W, ky = h / H;
  ctx.setTransform(kx, 0, 0, ky, -bbox.x0 * kx, -bbox.y0 * ky);   // user space → pixels (width scales with it)
  ctx.strokeStyle = "#000";
  ctx.lineWidth = spec.w;
  ctx.lineCap = spec.cap || "butt";
  ctx.lineJoin = spec.join || "miter";
  if (spec.miter > 0) ctx.miterLimit = spec.miter;
  if (spec.dash && spec.dash.length) { try { ctx.setLineDash(spec.dash); if (spec.dashOffset) ctx.lineDashOffset = spec.dashOffset; } catch {} }
  try { ctx.stroke(new Path2D(spec.d)); } catch {}
  const data = ctx.getImageData(0, 0, w, h).data;
  return {
    w, h,
    inside(x, y) {
      const i = Math.floor((x - bbox.x0) * kx), j = Math.floor((y - bbox.y0) * ky);
      if (i < 0 || j < 0 || i >= w || j >= h) return false;
      return data[(j * w + i) * 4 + 3] > 127;
    },
  };
}
